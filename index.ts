import { formatContextHealth } from "./context-health.ts";
import { join, resolve } from "node:path";
import { Type, type Usage } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Container, MouseRegion, getKeybindings, matchesKey, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { loadAgents } from "./agents.ts";
import { resolveAgentDirectories } from "./definition-config.ts";
import { bridgeModels, bridgeTools } from "./adapters.ts";
import { parseDelegationRequest, MAX_STEPS } from "./request.ts";
import { loadModelConfig, resolveModel, writeModelConfig } from "./models.ts";
import { Runtime, isTerminal, runId, type Run, type Group, type GroupSnapshot } from "./runtime.ts";
import { formatCost } from "./cost.ts";
import { clean, preview, renderGenericResult, renderGroup, renderRun, type RendererState } from "./ui.ts";
import { type DelegationEntry, type DelegationMode, type DelegationPresentation } from "./presentation.ts";
import { usageForRuns, usageToReport } from "./usage.ts";
import { createWorktree, removeWorktree } from "./worktrees.ts";
import { Notifications, NOTIFICATION_TYPE, type Delivery } from "./notifications.ts";

/** The nesting limit for delegated Sub-agents. */
const MAX_DEPTH = 3;

/** Token and cost readings that fit on one line; empty when the run recorded no usage. */
function usageReading(usage: Usage | undefined): string {
  const tokens = usage?.totalTokens ?? 0;
  const cost = usage?.cost.total ?? 0;
  const readings: string[] = [];
  if (tokens) readings.push(tokens < 1000 ? `${tokens} tok` : tokens < 10000 ? `${(tokens / 1000).toFixed(1)}k tok` : `${Math.round(tokens / 1000)}k tok`);
  if (cost > 0) readings.push(formatCost(cost));
  return readings.join(" / ");
}

/**
 * One compact, model-facing line of run facts: the model and thinking actually used, wall time, and
 * whether the recorded usage is spend from this call or a stored result being retrieved.
 */
export function runMetadata(run: Run, options: { billed?: Usage; retrieved: boolean }): string {
  const seconds = Math.max(0, Math.round((run.elapsedMs ?? 0) / 1000));
  const readings = [`model ${run.model.provider}/${run.model.modelId}`, `thinking ${run.thinking ?? "off"}`, `${seconds}s`];
  const recorded = usageReading(run.usage);
  if (options.retrieved) {
    const reported = usageReading(options.billed);
    readings.push(recorded ? reported
      ? `${recorded} recorded usage (retrieved; ${reported} reported on this branch; no new model work)`
      : `${recorded} recorded usage (retrieved; not newly billed)` : "retrieved; no usage recorded");
  } else {
    const billed = usageReading(options.billed);
    if (billed && recorded !== billed) readings.push(`${billed} billed this call (${recorded} recorded)`);
    else if (billed) readings.push(`${billed} billed this call`);
    else readings.push(recorded ? `${recorded} recorded usage` : "no model usage");
  }
  return readings.join(" · ");
}

function groupSummary(group: GroupSnapshot): string {
  const byId = new Map(group.steps.map(run => [run.id, run]));
  return `Group ${group.id} · ${group.status} · ${group.activity}\n${group.presentation.entries.map((entry, index) => {
    const run = byId.get(entry.runId);
    const state = run?.status ?? (entry.phase === "pending" ? "Pending" : "Not run");
    return `Step ${index + 1}/${group.presentation.entries.length} · ${entry.agent} · ${entry.runId} · ${state}${group.errors?.[entry.runId] ? ` · ${group.errors[entry.runId]}` : ""}`;
  }).join("\n")}`;
}

const nestedDescription = "Delegate one self-contained task to a named Sub-agent, or several with {tasks} or {chain}. Nesting is bounded and the reply names each run ID.";

interface ProgressUpdate {
  content: { type: "text"; text: string }[];
  details: unknown;
}

interface DelegationOutcome {
  content: { type: "text"; text: string }[];
  details: unknown;
  isError: boolean;
  usage: Usage | undefined;
}

interface DelegateOptions {
  depth: number;
  callbackId: string;
  ctx: ExtensionToolContext;
  nested: boolean;
  signal?: AbortSignal;
  onUpdate?: (update: ProgressUpdate) => void;
}

export default async function durableSubagent(pi: ExtensionAPI) {
  const configPath = process.env.PI_SUBAGENT_CONFIG ?? join(getAgentDir(), "durable-subagents.json");
  const directoryResolution = await resolveAgentDirectories({
    configPath,
    defaultDirectory: join(getAgentDir(), "agents"),
    ...(process.env.PI_SUBAGENT_AGENTS !== undefined ? { envValue: process.env.PI_SUBAGENT_AGENTS } : {}),
  });
  const definitions = directoryResolution.directories;
  const directoryErrors = directoryResolution.errors;
  const storage = resolve(process.env.PI_SUBAGENT_STORAGE ?? join(getAgentDir(), "sessions", "durable-subagents"));
  const initial = await loadAgents(definitions);
  const initialConfig = await loadModelConfig(configPath);
  const maxActive = process.env.PI_SUBAGENT_MAX_ACTIVE === undefined ? 8 : Number(process.env.PI_SUBAGENT_MAX_ACTIVE);
  let runtime = new Runtime(storage, { maxActive });
  let ownerLive = true;
  let notifications = new Notifications(storage);
  const deliveredRuns = new Set<string>();
  const inFlight = new Set<string>();
  let notificationWork = Promise.resolve();
  const flushNotifications = async (ctx: ExtensionContext, boundary = false) => {
    if (!ownerLive || (!boundary && !ctx.isIdle())) return;
    for (const item of await notifications.pending(ctx.sessionManager.getSessionId())) {
      if (!ownerLive) continue;
      const entries = ctx.sessionManager.getBranch();
      const retained = entries.some(entry => entry.type === "custom_message" && entry.customType === NOTIFICATION_TYPE && (entry.details as Delivery | undefined)?.eventId === item.eventId);
      if (retained) {
        await notifications.acknowledge(item.eventId);
        inFlight.delete(item.eventId);
        if (item.kind === "succeeded" || item.kind === "failed") {
          deliveredRuns.add(item.executionId);
          updateSticky(await runtime.status(item.runId, ctx.sessionManager.getSessionId()), ctx);
        }
        continue;
      }
      if (inFlight.has(item.eventId)) continue;
      inFlight.add(item.eventId);
      pi.sendMessage({ customType: NOTIFICATION_TYPE, content: item.text, display: true, details: notifications.prepare(item, entries) }, { triggerTurn: false });
      // Idle insertion is synchronous in the installed SDK; its custom-message events
      // reach host subscribers, not extension handlers. A retained entry is the receipt.
      if (ctx.sessionManager.getBranch().some(entry => entry.type === "custom_message" && entry.customType === NOTIFICATION_TYPE && (entry.details as Delivery | undefined)?.eventId === item.eventId)) {
        await notifications.acknowledge(item.eventId);
        inFlight.delete(item.eventId);
        if (item.kind === "succeeded" || item.kind === "failed") {
          deliveredRuns.add(item.executionId);
          updateSticky(await runtime.status(item.runId, ctx.sessionManager.getSessionId()), ctx);
        }
      }
    }
  };
  const stickyRuns = new Map<string, Run>();
  const stickyGroups = new Map<string, GroupSnapshot>();
  const stickyState: RendererState = {};
  let stickyExpanded = false;
  let stickyRedraw: (() => void) | undefined;
  let stickyInstalled = false;
  let stickyDispose: (() => void) | undefined;
  const updateSticky = (run: Run | undefined, ctx: ExtensionContext) => {
    if (!ownerLive) return;
    if (run?.nonblocking) {
      if (run.status === "aborted" || run.status === "interrupted" || deliveredRuns.has(`${run.id}:${run.executionAttempt ?? 0}`)) stickyRuns.delete(run.id);
      else stickyRuns.set(run.id, run);
    }
    if (run?.groupId && stickyGroups.has(run.groupId)) {
      const group = stickyGroups.get(run.groupId)!;
      group.steps = group.steps.map(child => child.id === run.id ? run : child);
      if (group.presentation.entries.every(entry => entry.phase !== "pending") && group.steps.every(child => child.status === "aborted" || (isTerminal(child) && deliveredRuns.has(`${child.id}:${child.executionAttempt ?? 0}`)))) {
        stickyGroups.delete(group.id);
        for (const child of group.steps) stickyRuns.delete(child.id);
      }
    }
    if (ctx.mode !== "tui") return;
    if (!stickyRuns.size && !stickyGroups.size) {
      if (stickyInstalled) ctx.ui.setWidget("durable-subagents", undefined);
      stickyInstalled = false; stickyRedraw = undefined; return;
    }
    if (stickyInstalled) { stickyRedraw?.(); return; }
    stickyInstalled = true;
    ctx.ui.setWidget("durable-subagents", (tui, theme) => {
      const redraw = () => tui.requestRender(); stickyRedraw = redraw;
      const off = ctx.ui.onTerminalInput(data => {
        if (getKeybindings().getKeys("app.tools.expand").length ? getKeybindings().matches(data, "app.tools.expand") : matchesKey(data, "ctrl+o")) { stickyExpanded = !stickyExpanded; stickyState.childExpanded = {}; redraw(); }
        return undefined;
      });
      const timer = setInterval(redraw, 120); timer.unref();
      let component = new Container();
      const dispose = () => { clearInterval(timer); off(); if (stickyRedraw === redraw) stickyRedraw = undefined; };
      stickyDispose = dispose;
      return {
        invalidate() { component.invalidate(); },
        handleMouse(event: TuiMouseEvent) { return component.handleMouse(event); },
        render(width) {
          component = new Container();
          for (const group of stickyGroups.values()) component.addChild(renderGroup(group.presentation, group.steps, stickyExpanded, theme, { active: group.status === "running", state: stickyState, invalidate: redraw }));
          for (const item of stickyRuns.values()) {
            if (item.groupId && stickyGroups.has(item.groupId)) continue;
            const expanded = stickyState.childExpanded?.[item.id] ?? stickyExpanded;
            component.addChild(new MouseRegion(renderRun(item, expanded, theme, { active: true, state: stickyState, invalidate: redraw }), event => {
              if (event.type !== "click" || event.button !== "left") return undefined;
              if (event.y <= 1) { stickyState.childExpanded = { ...stickyState.childExpanded, [item.id]: !expanded }; redraw(); }
              return { handled: true };
            }));
          }
          return component.render(width);
        }, dispose,
      };
    }, { placement: "aboveEditor" });
  };
  const updateStickyGroup = (group: GroupSnapshot, ctx: ExtensionContext) => {
    if (!ownerLive || !group.nonblocking) return;
    const delivered = group.presentation.entries.every(entry => entry.phase !== "pending") && group.steps.every(child => child.status === "aborted" || (isTerminal(child) && deliveredRuns.has(`${child.id}:${child.executionAttempt ?? 0}`)));
    if (group.status === "aborted" || group.status === "interrupted" || delivered) {
      stickyGroups.delete(group.id);
      for (const child of group.steps) stickyRuns.delete(child.id);
    } else stickyGroups.set(group.id, group);
    updateSticky(undefined, ctx);
  };
  const approvedResumes = new Set<string>();
  const interruptedRuns = new Set<string>();
  const pendingStatus = (ctx: ExtensionContext) => {
    if (ctx.mode === "tui") ctx.ui.setStatus("durable-subagents", interruptedRuns.size ? `${interruptedRuns.size} interrupted · /subagents` : undefined);
  };
  const observeRun = (run: Run, ctx: ExtensionContext) => {
    if (run.status === "interrupted") interruptedRuns.add(run.id); else interruptedRuns.delete(run.id);
    pendingStatus(ctx);
    updateSticky(run, ctx);
    if (run.nonblocking && ownerLive) notificationWork = notificationWork.then(async () => {
      await notifications.observe(run);
      await flushNotifications(ctx);
    }).catch(error => { if (ownerLive && ctx.hasUI) ctx.ui.notify(`Sub-agent delivery unavailable: ${String(error)}`, "warning"); });
  };
  // A TUI-only fast clock drives the running icon. It is started and stopped by delegation
  // lifecycle, never from a renderer, so no component owns a timer. One tick redraws every row
  // that registered its native invalidate during the last render.
  const rowRedraws = new Map<string, () => void>();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const activeDelegations = new Set<string>();
  const startHeartbeat = (callbackId: string) => {
    activeDelegations.add(callbackId);
    if (heartbeat) return;
    heartbeat = setInterval(() => { for (const redraw of [...rowRedraws.values()]) { try { redraw(); } catch { /* a stale row must not stop the clock */ } } }, 120);
    heartbeat.unref();
  };
  const stopHeartbeat = (callbackId: string) => {
    rowRedraws.delete(callbackId);
    activeDelegations.delete(callbackId);
    if (!activeDelegations.size && heartbeat) { clearInterval(heartbeat); heartbeat = undefined; }
  };
  pi.registerFlag("subagent-resume", { type: "string", description: "Explicitly approve one interrupted run ID for headless recovery" });

  /**
   * One implementation serves the caller's tool and every nested delegation, so depth, isolation,
   * chaining, and recovery behave the same at every level of a tree.
   */
  async function delegate(args: Record<string, unknown>, options: DelegateOptions): Promise<DelegationOutcome> {
    const { ctx, onUpdate } = options;
    const signal = args.nonblocking === true ? undefined : options.signal;
    const sessionId = ctx.sessionManager.getSessionId();
    const request = parseDelegationRequest(args);
    if (request.kind === "delegate" && request.nonblocking && options.nested) throw new Error("Nonblocking start must be owned by the parent session");
    const seeds: Run[] = [];
    let storedGroup: Group | undefined;
    const notes = new Map<string, string>();
    const retrieved = new Set<string>();
    if (request.kind === "resume") {
      const seed = await runtime.read(request.runId);
      if (seed.sessionId !== sessionId || seed.cwd !== ctx.cwd && !seed.worktree) throw new Error("Run belongs to another Pi session or working directory");
      if (seed.status === "succeeded" || seed.status === "aborted" || (seed.status === "paused" && !request.continuation)) retrieved.add(seed.id);
      storedGroup = seed.groupId ? await runtime.readGroup(seed.groupId) : undefined;
      seeds.push(...(storedGroup?.seeds ?? [seed]));
    } else {
      const loaded = await loadAgents(definitions);
      const { config } = await loadModelConfig(configPath);
      const parent = ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined;
      const now = Date.now();
      for (const [index, step] of request.steps.entries()) {
        const agent = loaded.agents.find((candidate) => candidate.name === step.agent);
        if (!agent) throw new Error(`Unknown/unavailable agent ${step.agent}. Available: ${loaded.agents.map((a) => a.name).join(", ") || "none"}. Searched: ${definitions.join(", ") || "none"}. ${[...directoryErrors, ...loaded.errors.map((e) => `${e.file}: ${e.message}`)].join("; ")}`);
        const resolved = resolveModel({ agentName: agent.name, agentModel: agent.model, parent, model: step.model, pool: step.pool, inherit: step.inherit, config });
        if (!resolved) throw new Error("No model selected");
        const id = request.steps.length === 1 ? runId(sessionId, options.callbackId) : runId(sessionId, `${options.callbackId}:${index}`);
        if (resolved.pool && !resolved.poolResolved) notes.set(id, `\nRole ${resolved.pool} is not configured; used ${resolved.model.provider}/${resolved.model.modelId}.`);
        const named = request.worktree?.branch;
        const branch = named ? (request.steps.length === 1 ? named : `${named}-${index + 1}`) : undefined;
        const label = `${id.slice(0, 10)}${request.steps.length > 1 ? `-${index + 1}` : ""}`;
        const worktree = request.worktree ? await createWorktree(ctx.cwd, { label, ...(branch ? { branch } : {}), ...(request.worktree.base ? { base: request.worktree.base } : {}) }) : undefined;
        seeds.push({ version: 1, id, sessionId, delegationDepth: options.depth, agent, task: step.task, ...(step.handoffRetryPolicy ? { handoffRetryPolicy: step.handoffRetryPolicy } : {}), timeoutMinutes: step.timeoutMinutes !== undefined ? step.timeoutMinutes : agent.timeoutMinutes ?? null,
          cwd: worktree?.path ?? ctx.cwd, model: resolved.model, ...(resolved.pool ? { role: resolved.pool } : {}),
          ...(worktree ? { worktree: { path: worktree.path, branch: worktree.branch } } : {}),
          thinking: agent.thinking ?? ctx.thinkingLevel ?? pi.getThinkingLevel(),
          ...(request.nonblocking ? { nonblocking: true } : {}),
          createdAt: now, updatedAt: now, status: "running", activity: "Starting", unavailable: [] });
      }
    }
    // `single` has no group header; the other modes describe how the requested steps relate. A
    // worktree run is concurrent, a chain hands each answer to the next step, and plain steps run
    // one at a time. None of this is inferred from the tasks alone.
    const mode: DelegationMode = storedGroup?.presentation.mode ?? (request.kind === "resume" || request.steps.length === 1
      ? "single"
      : request.mode === "chain" ? "chain" : request.worktree ? "parallel" : "ordered");
    const entries: DelegationEntry[] = storedGroup?.presentation.entries.map(entry => ({ ...entry })) ?? seeds.map((seed, index) => ({
      runId: seed.id, agent: seed.agent.name, color: seed.agent.color,
      // The original requested task, never the chained rewrite that executes.
      requestedTask: request.kind === "resume" ? seed.task : request.steps[index].task,
      phase: "pending",
    }));
    const presentation: DelegationPresentation = { mode, entries };
    const resultsById = new Map<string, Run>();
    const liveById = new Map<string, Run>();
    let lastActivity = seeds[0]?.activity ?? "Starting";
    // Emits every requested entry, including ones with no run yet, so a partial group update keeps
    // earlier completed workers visible and does not hide the queue behind the active step.
    const emitUpdate = () => {
      if (!onUpdate) return;
      const ordered = entries.map((entry) => resultsById.get(entry.runId) ?? liveById.get(entry.runId)).filter((run): run is Run => Boolean(run));
      const snapshot = { mode, entries: entries.map((entry) => ({ ...entry })) };
      const details = mode === "single" && ordered[0] ? ordered[0] : { steps: ordered, presentation: snapshot };
      onUpdate({ content: [{ type: "text", text: lastActivity }], details });
    };
    if (ctx.mode === "tui") startHeartbeat(options.callbackId);
    const executionOptions = async (seed: Run, entryIndex: number) => {
      let previous: Run | undefined;
      try { previous = await runtime.read(seed.id); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      let recoveryApproved = false;
      if (previous && previous.status !== "succeeded" && previous.status !== "aborted" && (previous.status !== "paused" || Boolean(request.kind === "resume" && request.continuation && (previous.noProgressPauses ?? 0) >= 2))) {
        const approved = approvedResumes.delete(seed.id) || pi.getFlag("subagent-resume") === seed.id;
        if (!approved && (!ctx.hasUI || !(await ctx.ui.confirm(previous.status === "paused" ? "Repeated pauses without useful progress: approve revised plan?" : "Recover stopped delegation?", `Run ${seed.id} will continue work in ${seed.cwd}. Previously interrupted side effects may be uncertain.`)))) {
          throw new Error(`Explicit resume approval required. In headless mode pass --subagent-resume ${seed.id}.`);
        }
        recoveryApproved = true;
      }
      const depth = seed.delegationDepth ?? options.depth;
      const nested = depth < MAX_DEPTH ? {
        prefix: seed.id, parameters, description: nestedDescription,
        run: (callId: string, nestedArgs: Record<string, unknown>, nestedSignal: AbortSignal | undefined, emit: (text: string) => void) =>
          delegate(nestedArgs, { depth: depth + 1, callbackId: callId, signal: nestedSignal, ctx, nested: true,
            onUpdate: (update) => emit(update.content.map((part) => part.text).join("\n")) }),
      } : undefined;
      return {
        recoveryApproved, continuation: request.kind === "resume" && request.runId === seed.id ? request.continuation : undefined,
        models: bridgeModels(ctx.modelRegistry, seed.conversationId ?? seed.id), tools: bridgeTools(seed.agent, ctx, nested), signal, nested: options.nested,
        onUpdate: (run: Run) => {
          observeRun(run, ctx);
          liveById.set(run.id, run);
          entries[entryIndex].phase = "run";
          lastActivity = run.activity;
          if (mode === "single" && !seed.nonblocking) emitUpdate();
        },
      };
    };
    const executeSeed = async (seed: Run, entryIndex: number) => {
      const result = await (seed.nonblocking ? runtime.start.bind(runtime) : runtime.execute.bind(runtime))(seed, await executionOptions(seed, entryIndex));
      observeRun(result, ctx); resultsById.set(result.id, result); liveById.delete(result.id); entries[entryIndex].phase = "run";
      return result;
    };
    if (seeds.length === 1 && seeds[0].nonblocking) {
      try {
        const handle = await executeSeed(seeds[0], 0);
        return { content: [{ type: "text", text: `Nonblocking Run ${handle.id} · ${handle.status}. Work continues; inspect with subagent_status, wait with subagent_wait (default 60 seconds), or cancel with subagent_cancel.` }], details: handle, isError: handle.status === "failed", usage: undefined };
      } finally { if (ctx.mode === "tui") stopHeartbeat(options.callbackId); }
    }
    let results: Run[] = [];
    let groupSnapshot: GroupSnapshot | undefined;
    const groupId = storedGroup?.id ?? runId(sessionId, `${options.callbackId}:group`);
    const group: Group = storedGroup ?? { version: 1, id: groupId, sessionId, nonblocking: seeds.some(seed => seed.nonblocking),
      seeds: seeds.map(seed => ({ ...seed, groupId })), presentation };
    try {
      if (mode !== "single") {
        groupSnapshot = await runtime.executeGroup(group, {
          optionsForRun: seed => executionOptions(seed, seeds.findIndex(candidate => candidate.id === seed.id)), signal,
          resumeId: request.kind === "resume" ? request.runId : undefined,
          onUpdate: snapshot => { updateStickyGroup(snapshot, ctx); if (!group.nonblocking) onUpdate?.({ content: [{ type: "text", text: snapshot.activity }], details: snapshot }); },
        }, group.nonblocking);
        results = groupSnapshot.steps;
        presentation.entries = groupSnapshot.presentation.entries;
        if (group.nonblocking) return { content: [{ type: "text", text: `Nonblocking ${groupSummary(groupSnapshot)}\nInspect, wait or cancel with the group handle; child handles target individual steps. Pending Ordered/Chain dependencies start only after successful final answers.` }], details: groupSnapshot, isError: groupSnapshot.status === "failed", usage: undefined };
      } else {
        if (!signal?.aborted) results.push(await executeSeed(seeds[0], 0));
        for (const entry of entries) entry.phase = resultsById.has(entry.runId) ? "run" : "not-run";
      }
      if (mode === "single") emitUpdate();
    } finally { if (ctx.mode === "tui") stopHeartbeat(options.callbackId); }
    const branch = ctx.sessionManager.getBranch();
    const blocks = results.map((result, index) => {
      const body = result.status === "paused" ? [result.activity, result.handoff, result.handoffLimitation].filter(Boolean).join("\n\n") : result.status === "succeeded" ? result.output ?? result.activity : `${result.error ?? result.activity}${result.output ? `\nPartial answer:\n${result.output}` : ""}`;
      const label = mode === "single" ? `Run ${result.id} · ${result.status}` : `Step ${presentation.entries.findIndex(entry => entry.runId === result.id) + 1}/${seeds.length} · ${result.agent.name} · Run ${result.id} · ${result.status}`;
      const place = result.worktree ? ` · ${result.worktree.branch}` : "";
      const metadata = runMetadata(result, { billed: usageToReport(result, branch), retrieved: retrieved.has(result.id) });
      return `${label}${place}\n${metadata}\n${body.slice(0, 30000)}${body.length > 30000 ? `\n[Truncated. Full result: ${join(storage, result.id, "run.json")}]` : ""}`;
    });
    const unavailable = [...new Set(results.flatMap((result) => result.unavailable))];
    const unresolved = results.map((result) => notes.get(result.id) ?? "").join("");
    const retained = results.flatMap((result) => result.worktree ? [`${result.worktree.branch} at ${result.worktree.path}`] : []);
    const isolated = retained.length ? `\nIsolated checkouts of the caller's HEAD: ${retained.join("; ")}. Merge what you keep; they are retained, not removed.` : "";
    return {
      content: [{ type: "text", text: `${groupSnapshot ? `${groupSummary(groupSnapshot)}\n\n` : ""}${blocks.join("\n\n")}${unavailable.length ? `\nUnavailable declared tools: ${unavailable.join(", ")}` : ""}${unresolved}${isolated}` }],
      details: mode === "single" && results[0] ? results[0] : groupSnapshot ?? { steps: results, presentation },
      isError: groupSnapshot?.status === "paused" ? false : results.length !== seeds.length || results.some((result) => result.status !== "succeeded" && result.status !== "paused"),
      // Pi automatically includes nested-tool usage; report only the Sub-agents' own model spend here.
      usage: usageForRuns(results, branch),
    };
  }

  const timeoutPolicy = Type.Optional(Type.Unsafe<number | null>({ type: ["number", "null"], minimum: 1, maximum: 480, description: "Execution allowance in minutes; null explicitly removes the deadline. Overrides Agent default. Omitted uses Agent default, otherwise no deadline. This is not a supervision wait duration." }));
  const handoffRetryPolicy = Type.Optional(Type.Union([Type.Literal("bounded"), Type.Literal("unlimited")], { description: "Handoff transient retry policy; default bounded allows three retries. Unlimited remains cancellable and session-owned." }));
  const parameters = Type.Object({
    nonblocking: Type.Optional(Type.Boolean({ description: "Explicitly return a stable execution or group handle while requested work continues; blocking remains the default" })),
    agent: Type.Optional(Type.String({ description: "Named agent for a new delegation" })),
    task: Type.Optional(Type.String({ minLength: 1, maxLength: 200000, description: "Self-contained task, including necessary context" })),
    model: Type.Optional(Type.String({ description: "Exact provider/model-id, task:<pool name>, or inherit-parent" })),
    role: Type.Optional(Type.String({ description: "Named model pool to resolve the model from" })),
    timeoutMinutes: timeoutPolicy,
    handoffRetryPolicy,
    tasks: Type.Optional(Type.Array(Type.Object({
      agent: Type.Optional(Type.String({ description: "Named agent for this step" })),
      task: Type.String({ description: "Self-contained task for this step" }),
      model: Type.Optional(Type.String({ description: "Exact provider/model-id for this step" })),
      role: Type.Optional(Type.String({ description: "Model pool for this step" })),
      timeoutMinutes: timeoutPolicy,
      handoffRetryPolicy,
    }), { minItems: 1, maxItems: MAX_STEPS, description: "Several steps, each recorded as its own run. agent, role, and model on the call are defaults for steps that omit them. Without worktree they run one after another." })),
    chain: Type.Optional(Type.Array(Type.Object({
      agent: Type.Optional(Type.String({ description: "Named agent for this step" })),
      task: Type.String({ description: "Self-contained task for this step" }),
      model: Type.Optional(Type.String({ description: "Exact provider/model-id for this step" })),
      role: Type.Optional(Type.String({ description: "Model pool for this step" })),
      timeoutMinutes: timeoutPolicy,
      handoffRetryPolicy,
    }), { minItems: 1, maxItems: MAX_STEPS, description: "Sequential steps where each step receives the previous step's answer. Runs in the caller's directory." })),
    worktree: Type.Optional(Type.Union([
      Type.Boolean(),
      Type.Object({ branch: Type.Optional(Type.String({ description: "Branch name for the first step" })), base: Type.Optional(Type.String({ description: "Commit or ref to check out" })) }),
    ], { description: "true gives every step its own git checkout and runs them concurrently. A checkout holds the base commit, so it never includes uncommitted changes." })),
    cloud_base_branch: Type.Optional(Type.String({ description: "Accepted as the checkout base, spelled the way swarm playbooks spell it" })),
    reassessment: Type.Optional(Type.String({ description: "Progress and remaining-work reassessment required with resume plus a fresh timeoutMinutes (or null) to continue allowance-paused work" })),
    resume: Type.Optional(Type.String({ pattern: "^[a-f0-9]{32}$", description: "Existing run ID to explicitly resume or retrieve" })),
  });

  pi.registerTool({
    name: "subagent", label: "Subagent", exposure: "model-only",
    renderShell: "self",
    description: `Delegate a self-contained task with {agent, task}, run several steps with {tasks: [...]} or {chain: [...]}, optionally forcing a different model with {model} or a pool with {role}, or resume/retrieve an existing delegation with {resume: runId}. Available agents: ${initial.agents.map((agent) => `${agent.name}: ${agent.description}`).join("; ")}. Fresh context; same working directory. Steps without {worktree: true} run one after another in the caller's directory; with it, each step gets its own git checkout and they run concurrently. One delegation per directory at a time, and nesting is bounded. To continue allowance-paused work, provide resume, a nonempty reassessment, and a fresh timeoutMinutes or null. Repeated pauses without tool progress require operator attention. Never recover interrupted or failed work without the user's explicit permission.`,
    parameters,
    async execute(toolCallId, args, signal, onUpdate, ctx) {
      return delegate(args as Record<string, unknown>, { depth: 0, callbackId: toolCallId, signal, ctx, nested: false, onUpdate });
    },
    renderCall(args, theme, context) {
      if (activeDelegations.has(context.toolCallId)) rowRedraws.set(context.toolCallId, context.invalidate);
      else rowRedraws.delete(context.toolCallId);
      return new Container();
    },
    renderResult(result, options, theme, context) {
      if (activeDelegations.has(context.toolCallId)) rowRedraws.set(context.toolCallId, context.invalidate);
      else rowRedraws.delete(context.toolCallId);
      const state = context.state as RendererState;
      const details = result.details as Run | { steps?: Run[]; presentation?: DelegationPresentation } | undefined;
      if (details && typeof details === "object" && "steps" in details && Array.isArray(details.steps)) {
        const requested = Array.isArray(context.args.chain) ? context.args.chain : Array.isArray(context.args.tasks) ? context.args.tasks : [];
        const presentation = details.presentation ?? {
          mode: Array.isArray(context.args.chain) ? "chain" as const : details.steps.some((run) => run.worktree) ? "parallel" as const : "ordered" as const,
          entries: details.steps.map((run, index) => ({ runId: run.id, agent: run.agent.name, requestedTask: typeof requested[index]?.task === "string" ? requested[index].task : run.task, phase: "run" as const })),
        };
        state.lastGroup = { presentation, runs: details.steps };
        if (presentation.mode === "single" && !details.steps.length) {
          const entry = presentation.entries[0];
          return renderGenericResult(entry ? `○ ${entry.agent} (${entry.requestedTask.replace(/\s+/g, " ")})\n  ⎿ ${entry.phase === "not-run" ? "Not run" : "Pending"}` : "", options.expanded);
        }
        return renderGroup(presentation, details.steps, options.expanded, theme, { active: options.isPartial, state, invalidate: context.invalidate });
      }
      if ((details as Run | undefined)?.version === 1) {
        const run = details as Run;
        return renderRun(run, options.expanded, theme, { active: options.isPartial && ["running", "pausing", "preparing-handoff"].includes(run.status), state, invalidate: context.invalidate });
      }
      const errorText = result.content.filter((part) => part.type === "text").map((part) => clean(part.text)).join("\n");
      if (state.lastGroup?.presentation && state.lastGroup.presentation.mode !== "single") {
        const group = new Container();
        group.addChild(renderGroup(state.lastGroup.presentation, state.lastGroup.runs, options.expanded, theme, { state, invalidate: context.invalidate }));
        group.addChild(renderGenericResult(errorText, options.expanded));
        return group;
      }
      return renderGenericResult(errorText, options.expanded);
    },
  });

  const handleParameters = { run: Type.String({ pattern: "^[a-f0-9]{32}$", description: "Execution handle returned by subagent" }) };
  for (const operation of ["status", "wait", "cancel"] as const) pi.registerTool({
    name: `subagent_${operation}`, label: `Subagent ${operation}`, exposure: "model-only", renderShell: "self",
    renderCall() { return new Container(); },
    description: operation === "wait" ? "Wait up to 60 seconds (override waitSeconds) without stopping the child. Returns the current execution state." : `${operation === "cancel" ? "Cancel and await cleanup of" : "Inspect live progress and retained result for"} an execution owned by this session.`,
    parameters: Type.Object({ ...handleParameters, ...(operation === "wait" ? { waitSeconds: Type.Optional(Type.Number({ minimum: 0, maximum: 3600 })) } : {}) }),
    renderResult(result, options, theme, context) {
      const details = result.details as GroupSnapshot | undefined;
      if (details && Array.isArray(details.steps)) return renderGroup(details.presentation, details.steps, options.expanded, theme, { state: context.state as RendererState, invalidate: context.invalidate });
      return renderGenericResult(result.content.filter(part => part.type === "text").map(part => clean(part.text)).join("\n"), options.expanded);
    },
    async execute(_id, args, signal, _update, ctx) {
      const id = String(args.run); const sessionId = ctx.sessionManager.getSessionId();
      const stored = await runtime.readGroup(id);
      const owningGroup = stored ?? await runtime.groupForChild(id, sessionId);
      if (stored || owningGroup && operation === "cancel") {
        const group = operation === "cancel" ? await runtime.cancelGroup(owningGroup!.id, sessionId, stored ? undefined : id)
          : operation === "wait" ? await runtime.waitGroup(id, { sessionId, timeoutSeconds: typeof args.waitSeconds === "number" ? args.waitSeconds : undefined, signal }) : await runtime.groupStatus(id, sessionId);
        updateStickyGroup(group, ctx);
        if (!stored) {
          const child = group.steps.find(run => run.id === id);
          if (child) { observeRun(child, ctx); return { content: [{ type: "text", text: `Run ${child.id} · ${child.status} · ${child.activity}` }], details: child, usage: usageToReport(child, ctx.sessionManager.getBranch()) }; }
          const entry = group.presentation.entries.find(entry => entry.runId === id)!;
          return { content: [{ type: "text", text: `Child ${id} · Not run` }], details: { id, groupId: group.id, phase: entry.phase, status: entry.phase } };
        }
        return { content: [{ type: "text", text: groupSummary(group) }], details: group, isError: group.status === "failed", usage: usageForRuns(group.steps, ctx.sessionManager.getBranch()) };
      }
      if (owningGroup) {
        // Admission publishes a live child before its group phase reaches disk.
        // Project actual children so immediate controls never report started work
        // as an unstarted dependency during that persistence window.
        const currentGroup = await runtime.groupStatus(owningGroup.id, sessionId);
        const entry = currentGroup.presentation.entries.find(entry => entry.runId === id)!;
        if (entry.phase !== "run") return { content: [{ type: "text", text: `Child ${id} · ${entry.phase === "pending" ? "Pending dependency" : "Not run"}` }], details: { id, groupId: owningGroup.id, phase: entry.phase, status: entry.phase } };
      }
      await runtime.status(id, sessionId);
      if (operation === "cancel") await runtime.cancel(id);
      const run = operation === "wait" ? await runtime.wait(id, { sessionId, timeoutSeconds: typeof args.waitSeconds === "number" ? args.waitSeconds : undefined, signal }) : await runtime.inspect(id, { sessionId, models: bridgeModels(ctx.modelRegistry, id) });
      observeRun(run, ctx);
      return { content: [{ type: "text", text: `Run ${run.id} · ${run.status} · ${run.activity}\n${run.steering ? `Guidance: accepted ${run.steering.accepted}, consumed ${run.steering.consumed}, pending ${run.steering.pending}, discarded ${run.steering.discarded} (boundary insertion does not prove obedience).\n` : ""}${run.status === "paused" ? run.handoff ?? run.handoffLimitation ?? "" : run.output ?? run.error ?? ""}${run.contextHealth ? `\n${formatContextHealth(run.contextHealth)}` : ""}` }], details: run, isError: run.status === "failed", usage: usageToReport(run, ctx.sessionManager.getBranch()) };
    },
  });
  pi.registerTool({
    name: "subagent_followup", label: "Subagent follow-up", exposure: "model-only",
    description: "Assign a new task to a completed child under a distinct execution handle. Retains conversation by default with frozen Agent/model/tools/workspace; inspect context first, choose reuse:true after a warning or fresh:true for fresh context. Active work requires steering. Previous results remain available by their original handles.",
    parameters: Type.Object({ ...handleParameters, task: Type.String({ minLength: 1 }), reuse: Type.Optional(Type.Boolean()), fresh: Type.Optional(Type.Boolean()), nonblocking: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    async execute(toolCallId, args, signal, onUpdate, ctx) {
      for (const key of Object.keys(args)) if (!["run", "task", "reuse", "fresh", "nonblocking"].includes(key)) throw new Error(`Follow-up cannot replace authority: ${key}`);
      const sessionId = ctx.sessionManager.getSessionId();
      const previous = await runtime.status(args.run, sessionId);
      if (previous.cwd !== ctx.cwd && !previous.worktree) throw new Error("Run belongs to another working directory");
      const id = runId(sessionId, `followup:${toolCallId}`);
      const depth = previous.delegationDepth ?? 0;
      const nested = depth < MAX_DEPTH ? {
        prefix: id, parameters, description: nestedDescription,
        run: (callId: string, nestedArgs: Record<string, unknown>, nestedSignal: AbortSignal | undefined, emit: (text: string) => void) =>
          delegate(nestedArgs, { depth: depth + 1, callbackId: callId, signal: nestedSignal, ctx, nested: true,
            onUpdate: update => emit(update.content.map(part => part.text).join("\n")) }),
      } : undefined;
      const update = (run: Run) => { observeRun(run, ctx); onUpdate?.({ content: [{ type: "text", text: `Run ${run.id} · ${run.status} · ${run.activity}` }], details: run }); };
      const run = await runtime.followUp(args.run, { executionId: id, sessionId, task: args.task, reuse: args.reuse, fresh: args.fresh, nonblocking: args.nonblocking }, {
        models: bridgeModels(ctx.modelRegistry, args.fresh ? id : previous.conversationId ?? previous.id), tools: bridgeTools(previous.agent, ctx, nested), signal, onUpdate: update,
      });
      observeRun(run, ctx);
      return { content: [{ type: "text", text: `Run ${run.id} · ${run.status} · conversation ${run.conversationId ?? run.id}\n${run.output ?? run.activity}\n${formatContextHealth(run.contextHealth!)}` }], details: run, isError: run.status === "failed", usage: run.nonblocking ? undefined : usageToReport(run, ctx.sessionManager.getBranch()) };
    },
    renderResult(result, options, theme, context) {
      const run = result.details as Run | undefined;
      return run?.id ? renderRun(run, options.expanded, theme, { state: context.state as RendererState, invalidate: context.invalidate }) : renderGenericResult(result.content.map(part => part.type === "text" ? part.text : "").join("\n"), options.expanded);
    },
  });
  pi.registerTool({
    name: "subagent_compact", label: "Compact retained subagent", exposure: "model-only",
    description: "Explicitly compact an idle completed or allowance-paused retained conversation. Reports applied, no-op, or failed; preserves historical answers and fixed authority. Does not guarantee reasoning quality.",
    parameters: Type.Object({ ...handleParameters, instructions: Type.Optional(Type.String()) }),
    async execute(toolCallId, args, signal, _update, ctx) {
      const operationId = runId(ctx.sessionManager.getSessionId(), `compact:${toolCallId}`);
      const target = await runtime.status(String(args.run), ctx.sessionManager.getSessionId());
      const run = await runtime.compact(String(args.run), { sessionId: ctx.sessionManager.getSessionId(), models: bridgeModels(ctx.modelRegistry, target.conversationId ?? target.id), instructions: args.instructions, operationId, signal });
      const operation = run.compactions!.find(operation => operation.id === operationId)!;
      const delivered = ctx.sessionManager.getBranch().some(entry => {
        if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "subagent_compact") return false;
        const details = entry.message.details as unknown as { compactionOperationId?: string } | undefined;
        return details?.compactionOperationId === operationId;
      });
      return { content: [{ type: "text", text: `Compaction ${operation.outcome}${operation.error ? `: ${operation.error}` : ""}\n${formatContextHealth(run.contextHealth!)}` }], details: { ...run, compactionOperationId: operationId }, isError: operation.outcome === "failed", usage: delivered ? undefined : operation.usage };
    },
  });
  pi.registerTool({
    name: "subagent_steer", label: "Subagent steer", exposure: "model-only",
    description: "Queue guidance for active work by execution handle. Preserves original scope and authority; accepted and consumed at a safe boundary are distinct from obedience. Does not interrupt running tools. Completed-child tasks require follow-up.",
    parameters: Type.Object({ ...handleParameters, guidance: Type.String({ minLength: 1, maxLength: 8000 }) }),
    async execute(_id, args, _signal, _update, ctx) {
      const run = await runtime.steer(args.run, ctx.sessionManager.getSessionId(), args.guidance);
      observeRun(run, ctx);
      return { content: [{ type: "text", text: `Run ${run.id} · guidance ${run.steering?.latest?.state} · accepted ${run.steering?.accepted} · consumed ${run.steering?.consumed} · pending ${run.steering?.pending}. Consumption is boundary insertion, not proof of obedience.` }], details: run, usage: usageToReport(run, ctx.sessionManager.getBranch()) };
    },
  });
  pi.on("agent_settled", async (_event, ctx) => {
    await notificationWork;
    await flushNotifications(ctx, true);
  });
  pi.on("message_end", async (event, ctx) => {
    const message = event.message;
    if (!ownerLive || message.role !== "custom" || message.customType !== NOTIFICATION_TYPE) return;
    const details = message.details as Delivery | undefined;
    if (!details?.eventId || details.sessionId !== ctx.sessionManager.getSessionId()) return;
    const receipt = await notifications.acknowledge(details.eventId);
    if (!receipt) return;
    inFlight.delete(details.eventId);
    if (receipt.kind === "succeeded" || receipt.kind === "failed") {
      deliveredRuns.add(receipt.executionId);
      const run = await runtime.status(receipt.runId, ctx.sessionManager.getSessionId());
      if (ownerLive) updateSticky(run, ctx);
    }
  });
  pi.registerMessageRenderer(NOTIFICATION_TYPE, (message, options) => renderGenericResult(typeof message.content === "string" ? message.content : JSON.stringify(message.content), options.expanded));
  // Nested host calls retain their host permission path. Parent effectful calls must not race
  // an execution that owns its workspace; unknown extension tools are conservatively effectful.
  pi.on("tool_call", (event, ctx) => {
    if (event.parentToolCallId || !runtime.ownsWorkspace(ctx.cwd)) return;
    const safe = new Set(["read", "grep", "find", "ls", "subagent", "subagents_list", "subagent_status", "subagent_wait", "subagent_cancel", "subagent_compact", "subagent_followup", "subagent_steer", "worktree_list"]);
    if (!safe.has(event.toolName)) return { block: true, reason: "Active Sub-agent owns this workspace; wait or cancel before parent writes. Use isolated worktrees for concurrent writers." };
  });

  pi.registerTool({
    name: "subagents_list", label: "List subagents", exposure: "model-only",
    description: "List the available Sub-agent definitions: their declared tools, declared model and thinking level, and whether they may delegate further. The declared model is only a default; the actual model is resolved per Delegation from the request, configured pins/pools, or the caller.",
    parameters: Type.Object({}),
    async execute() {
      const loaded = await loadAgents(definitions);
      const lines = loaded.agents.map((agent) => [
        `${agent.name}: ${agent.description}`,
        `  tools: ${agent.tools.join(", ")}`,
        `  declared model: ${agent.model ?? "not declared (resolved per Delegation)"}  thinking: ${agent.thinking ?? "inherits the caller"}  execution allowance: ${agent.timeoutMinutes === undefined ? "no deadline" : `${agent.timeoutMinutes}m`}`,
        ...(agent.tools.includes("subagent") ? ["  may delegate: yes"] : []),
      ].join("\n"));
      const problems = loaded.errors.map((error) => `${error.file}: ${error.message}`);
      return { content: [{ type: "text", text: [...lines, ...problems].join("\n") || "No agent definitions found." }], details: undefined };
    },
  });

  pi.registerTool({
    name: "subagents_write_task_models", label: "Write model pools", exposure: "model-only",
    description: `Merge named model pools and per-agent model pins into ${configPath}. Existing entries are kept. Pools are selected by {role: "<pool name>"} or {model: "task:<pool name>"}.`,
    parameters: Type.Object({
      pools: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String()), { description: "Pool name to an ordered list of provider/model-id" })),
      agents: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Agent name to a provider/model-id pin" })),
    }),
    async execute(_toolCallId, args) {
      const update: { pools?: Record<string, string[]>; agents?: Record<string, string> } = {};
      if (args.pools) update.pools = args.pools;
      if (args.agents) update.agents = args.agents;
      if (!update.pools && !update.agents) throw new Error("Provide pools, agents, or both. Pools map a name to an ordered list of provider/model-id.");
      const config = await writeModelConfig(configPath, update);
      return { content: [{ type: "text", text: `Wrote ${configPath}\n${JSON.stringify({ models: { agents: config.agents, pools: config.pools } }, null, 2)}` }], details: undefined };
    },
  });

  pi.registerTool({
    name: "worktree_list", label: "List worktrees", exposure: "model-only",
    description: "List the isolated git checkouts this extension created and retained for this Pi session. Remove one with worktree_remove.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _args, _signal, _onUpdate, ctx) {
      const runs = await runtime.list(ctx.sessionManager.getSessionId());
      const rows = runs.filter((run) => run.worktree).map((run) => `${run.id} · ${run.status} · ${run.worktree!.branch} · ${run.worktree!.path}`);
      return { content: [{ type: "text", text: rows.join("\n") || "No retained checkouts in this session." }], details: undefined };
    },
  });

  pi.registerTool({
    name: "worktree_remove", label: "Remove worktree", exposure: "model-only",
    description: "Remove a retained checkout by run ID. The branch is kept because it holds the work. A checkout with uncommitted changes is refused unless force is true, since those changes are then lost.",
    parameters: Type.Object({
      run: Type.String({ description: "Run ID whose checkout to remove" }),
      force: Type.Optional(Type.Boolean({ description: "Remove even with uncommitted changes in that checkout" })),
    }),
    async execute(_toolCallId, args) {
      const run = await runtime.read(args.run);
      if (!run.worktree) throw new Error(`Run ${run.id} has no checkout`);
      if (!isTerminal(run)) throw new Error(`Run ${run.id} is ${run.status}; cancel it before removing its checkout`);
      await removeWorktree(run.worktree.path, { force: args.force === true });
      return { content: [{ type: "text", text: `Removed checkout ${run.worktree.path}. Branch ${run.worktree.branch} is kept.` }], details: undefined };
    },
  });

  // Entries are durable and excluded from model context, unlike messages.
  pi.registerEntryRenderer("durable-subagent-result", (entry, options, theme) => {
    const run = entry.data as Run | undefined;
    return run?.version === 1 ? renderRun(run, options.expanded, theme) : undefined;
  });
  pi.registerMessageRenderer("durable-subagent-result", (message, options, theme) => {
    return renderRun(message.details as Run, options.expanded, theme);
  });
  pi.registerCommand("subagents", {
    description: "Inspect durable delegations, view results, or request explicit resume",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) { throw new Error("/subagents requires a dialog-capable UI; use subagent({resume: runId}) for explicit recovery in headless mode"); }
      const runs = await runtime.list(ctx.sessionManager.getSessionId());
      if (!runs.length) { ctx.ui.notify("No durable delegations in this session yet.", "info"); return; }
      const choices = runs.map((run) => `${run.id} · ${run.agent.name} · ${run.status} · ${preview(run.task, 70)}`);
      const selected = await ctx.ui.select("Durable subagents", choices);
      if (!selected) return;
      const run = runs[choices.indexOf(selected)];
      const action = await ctx.ui.select(`${run.agent.name} · ${run.status}`, ["View result", ...((run.status === "interrupted" || run.status === "failed") ? ["Resume", "Cancel"] : run.status === "paused" ? ["Continue", "Cancel"] : [])]);
      if (action === "View result") {
        // Display-only: never inject a stored answer into the parent's model context.
        pi.appendEntry("durable-subagent-result", run);
      } else if (action === "Resume") {
        if (await ctx.ui.confirm("Resume delegation?", `This will continue work in ${run.cwd}. Interrupted tools may have uncertain side effects. Tools not declared replay-safe will not be automatically repeated.`)) {
          approvedResumes.add(run.id);
          pi.sendUserMessage(`I explicitly approve resuming durable subagent run ${run.id}. Call subagent with {"resume":"${run.id}"}; do not create a new delegation.`, { deliverAs: "followUp" });
        }
      } else if (action === "Continue") {
        pi.sendUserMessage(`Reassess the completed progress and useful remaining work for durable subagent run ${run.id}. Continue within its original scope by calling subagent with {"resume":"${run.id}","reassessment":"<your assessment>","timeoutMinutes":<fresh allowance or null>}. Preserve completed side effects.`, { deliverAs: "followUp" });
      } else if (action === "Cancel") {
        if (await ctx.ui.confirm("Cancel delegation?", "This stops pending work; it does not undo completed filesystem changes or external actions.")) {
          try {
            await runtime.cancel(run.id);
          } catch (error) {
            // A recent crash leaves a real lease behind; it expires on its own, so retrying is the fix.
            if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
              ctx.ui.notify("This run's lease is still held (for example by a process that just exited). Try again in a few seconds.", "warning");
              return;
            }
            throw error;
          }
          observeRun(await runtime.status(run.id, ctx.sessionManager.getSessionId()), ctx);
          ctx.ui.notify("Delegation cancelled.", "info");
        }
      }
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    ownerLive = false;
    await runtime.close();
    await notificationWork; await notifications.close();
    notifications = new Notifications(storage); inFlight.clear(); deliveredRuns.clear();
    runtime = new Runtime(storage, { maxActive });
    stickyDispose?.(); stickyDispose = undefined; stickyRuns.clear(); stickyGroups.clear(); stickyInstalled = false; stickyRedraw = undefined;
    if (ctx.mode === "tui") ctx.ui.setWidget("durable-subagents", undefined);
    ownerLive = true;
    approvedResumes.clear();
    const runs = await runtime.list(ctx.sessionManager.getSessionId());
    interruptedRuns.clear();
    for (const run of runs) {
      if (run.status === "interrupted") interruptedRuns.add(run.id);
      if (run.nonblocking) {
        await notifications.observe(run);
        if (await notifications.deliveredResult(run) && run.status !== "paused") deliveredRuns.add(`${run.id}:${run.executionAttempt ?? 0}`);
        updateSticky(run, ctx);
      }
    }
    for (const group of await runtime.listGroups(ctx.sessionManager.getSessionId())) if (group.nonblocking) updateStickyGroup(await runtime.groupStatus(group.id, group.sessionId), ctx);
    await flushNotifications(ctx);
    pendingStatus(ctx);
    const count = interruptedRuns.size;
    if (count && ctx.hasUI) ctx.ui.notify(`${count} interrupted subagent run${count === 1 ? "" : "s"}. Use /subagents to inspect and explicitly resume.`, "info");
    const problems = [...directoryErrors, ...initial.errors.map((error) => `${error.file}: ${error.message}`), ...initialConfig.errors];
    if (problems.length && ctx.hasUI) ctx.ui.notify(problems.join("\n"), "warning");
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    ownerLive = false;
    stickyDispose?.(); stickyDispose = undefined; stickyRuns.clear(); stickyGroups.clear(); stickyInstalled = false; stickyRedraw = undefined;
    if (ctx.mode === "tui") ctx.ui.setWidget("durable-subagents", undefined);
    clearInterval(heartbeat);
    heartbeat = undefined;
    rowRedraws.clear();
    activeDelegations.clear();
    await runtime.close();
    await notificationWork; await notifications.close(); inFlight.clear();
  });
}
