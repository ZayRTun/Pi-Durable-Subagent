import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, rmdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels, type Models, type Usage, type AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, UserEntry, createRegistry, defineExtension, Harness, type LiveState, type UsageState, type ToolRegistration } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import lockfile from "proper-lockfile";
import { inspectContext, type ContextHealth } from "./context-health.ts";
import type { AgentDefinition } from "./agents.ts";
import { subagentInstructions } from "./prompt.ts";
import { collectToolArguments, describeActivity, reconcileToolDiagnostics, toolActivity } from "./activity.ts";

export type RunStatus = "running" | "succeeded" | "failed" | "aborted" | "interrupted" | "pausing" | "preparing-handoff" | "paused";
/** Paused work is unfinished and safely inactive; Interrupted requires explicit recovery. */
export const TERMINAL_STATUSES: readonly RunStatus[] = ["succeeded", "failed", "aborted"];
export const isTerminal = (run: Pick<Run, "status">) => TERMINAL_STATUSES.includes(run.status);
export interface Run {
  version: 1;
  id: string;
  sessionId: string;
  agent: AgentDefinition;
  task: string;
  /** Explicitly detached from the starting parent tool call. */
  nonblocking?: boolean;
  /** Effective execution allowance; null explicitly removes the deadline. Absent on historical records. */
  timeoutMinutes?: number | null;
  cwd: string;
  model: { provider: string; modelId: string };
  /** The requested model pool name, recorded even when it resolved to something else. */
  role?: string;
  /** The isolated checkout this run owned, when the caller asked for worktree isolation. */
  worktree?: { path: string; branch: string };
  thinking: AgentDefinition["thinking"];
  createdAt: number;
  updatedAt: number;
  elapsedMs?: number;
  status: RunStatus;
  activity: string;
  unavailable: string[];
  output?: string;
  pauseReason?: "allowance";
  handoff?: string;
  handoffRetryPolicy?: "bounded" | "unlimited";
  handoffRetries?: number;
  handoffCorrected?: boolean;
  handoffLimitation?: string;
  checkpointRequestedAt?: number;
  executionAttempt?: number;
  interruptedPhase?: RunStatus;
  noProgressPauses?: number;
  pauseToolCount?: number;
  recoveryHistory?: { error?: string; status: RunStatus; approvedAt: number }[];
  /** Unique tool calls across this run's history, reconstructed from durable entries on recovery. */
  toolCount?: number;
  activityLog?: { callId: string; name: string; status: string; output?: string; summary?: string; uncertain?: boolean; failed?: boolean }[];
  /** Boundary insertion is consumption, never proof that guidance was obeyed. */
  steering?: { accepted: number; consumed: number; discarded: number; pending: number; latest?: { id: string; state: "accepted" | "consumed" | "discarded"; acceptedAt: number; consumedAt?: number } };
  error?: string;
  usage?: Usage;
  contextHealth?: ContextHealth;
  compactions?: { id: string; outcome: "applied" | "noop" | "failed"; error?: string; usage: Usage; at: number }[];
}
export interface ExecuteOptions {
  models: Models;
  tools: ToolRegistration[];
  signal?: AbortSignal;
  onUpdate?: (run: Run) => void;
  /** Admission boundary after lease acquisition and durable record persistence. */
  onAdmitted?: (run: Run) => void;
  /**
   * A nested delegation inside an already admitted tree. The tree's root holds the workspace
   * admission, so nested runs still record and recover but do not take the workspace lock again.
   */
  nested?: boolean;
  continuation?: { reassessment: string; timeoutMinutes: number | null };
  recoveryApproved?: boolean;
}
const context = BACKGROUND_CONTEXT;
const terminal = (run: Run) => isTerminal(run);
export function runId(sessionId: string, toolCallId: string) {
  return createHash("sha256").update(`${sessionId}\0${toolCallId}`).digest("hex").slice(0, 32);
}
function validateId(id: string) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid run ID");
}
async function save(file: string, run: Run) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(run), { mode: 0o600 });
  await rename(temp, file);
}

function modelUsage(models: Record<string, Usage>): Usage {
  return Object.values(models).reduce<Usage>((total, usage) => ({
    input: total.input + usage.input, output: total.output + usage.output,
    cacheRead: total.cacheRead + usage.cacheRead, cacheWrite: total.cacheWrite + usage.cacheWrite,
    totalTokens: total.totalTokens + usage.totalTokens,
    cost: { input: total.cost.input + usage.cost.input, output: total.cost.output + usage.cost.output,
      cacheRead: total.cost.cacheRead + usage.cost.cacheRead, cacheWrite: total.cost.cacheWrite + usage.cost.cacheWrite,
      total: total.cost.total + usage.cost.total },
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
}

/** Compaction has its own accounting identity, separate from ordinary execution spend. */
function executionUsage(models: Record<string, Usage>, run: Run): Usage {
  const total = modelUsage(models);
  for (const operation of run.compactions ?? []) {
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) total[key] = Math.max(0, total[key] - operation.usage[key]);
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) total.cost[key] = Math.max(0, total.cost[key] - operation.usage.cost[key]);
  }
  return total;
}

/** One SQLite harness per execution with awaited owner shutdown and no idle scheduler. */
export class Runtime {
  readonly directory: string;
  private active = new Map<string, { stop: (reason?: string) => void; done: Promise<Run>; cwd: string; sessionId: string }>();
  /** Latest in-memory snapshot per active run, so inspection shows live progress instead of the start record. */
  private live = new Map<string, Run>();
  private contextReaders = new Map<string, () => Promise<ContextHealth>>();
  private managing = new Map<string, { stop: () => void; done: Promise<Run>; cwd: string; sessionId: string }>();
  private steering = new Map<string, (guidance: string) => Promise<Run>>();
  private closing = false;
  readonly maxActive: number;
  constructor(directory: string, options: { maxActive?: number } = {}) {
    this.directory = resolve(directory);
    this.maxActive = options.maxActive ?? 8;
    if (!Number.isInteger(this.maxActive) || this.maxActive < 1) throw new Error("Active capacity must be a positive integer");
  }
  /** Workspace ownership stays live after a detached start returns. */
  ownsWorkspace(cwd: string): boolean { return [...this.active.values(), ...this.managing.values()].some(run => run.cwd === cwd); }
  async status(id: string, sessionId: string): Promise<Run> {
    const run = this.live.get(id) ?? await this.read(id);
    if (run.sessionId !== sessionId) throw new Error("Run belongs to another Pi session");
    return { ...run, ...(!terminal(run) && run.status !== "paused" && !this.active.has(id) ? { status: "interrupted" as const, activity: "Awaiting explicit resume" } : {}) };
  }
  async steer(id: string, sessionId: string, guidance: string): Promise<Run> {
    const run = await this.status(id, sessionId);
    if (!guidance.trim() || guidance.length > 8000) throw new Error("Guidance must contain 1–8000 characters");
    const send = this.steering.get(id);
    if (this.closing || run.status !== "running" || !send) throw new Error("Steering requires active work; use follow-up for a completed child, or explicit continuation/recovery for stopped work");
    return send(guidance);
  }
  /** Returns only after admission/persistence; retains an independent controller until completion. */
  async start(seed: Run, options: ExecuteOptions): Promise<Run> {
    let admit!: (run: Run) => void;
    const ready = new Promise<Run>(resolve => { admit = resolve; });
    const done = this.execute({ ...seed, nonblocking: true }, { ...options, signal: undefined, onAdmitted: run => {
      admit(run); options.onAdmitted?.(run);
    } });
    // Attach rejection immediately: setup failure is reported to start; later failure is inspectable.
    return Promise.race([ready, done]);
  }
  async wait(id: string, options: { sessionId: string; timeoutSeconds?: number; signal?: AbortSignal }): Promise<Run> {
    await this.status(id, options.sessionId);
    const seconds = options.timeoutSeconds ?? 60;
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600) throw new Error("Wait duration must be between 0 and 3600 seconds");
    const active = this.active.get(id);
    if (!active) return this.status(id, options.sessionId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort!: () => void;
    const boundary = new Promise<void>(resolve => {
      timer = setTimeout(resolve, seconds * 1000); abort = resolve;
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) resolve();
    });
    try { await Promise.race([active.done, boundary]); return await this.status(id, options.sessionId); }
    finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
  }
  private path(id: string) { validateId(id); return join(this.directory, id); }
  async read(id: string): Promise<Run> {
    const value: Run = JSON.parse(await readFile(join(this.path(id), "run.json"), "utf8"));
    if (value.version !== 1 || value.id !== id) throw new Error("Unsupported or corrupt run metadata");
    return value;
  }
  async list(sessionId: string): Promise<Run[]> {
    let files: string[];
    try { files = await readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const runs: Run[] = [];
    for (const id of files.filter((name) => /^[a-f0-9]{32}$/.test(name))) {
      let run: Run;
      try { run = await this.read(id); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (run.sessionId !== sessionId) continue;
      if (!terminal(run) && run.status !== "paused" && !this.active.has(id)) { run.status = "interrupted"; run.activity = "Awaiting explicit resume"; }
      // A running delegation reports what it is doing now; the on-disk record only has its start state.
      runs.push(this.active.has(id) ? { ...(this.live.get(id) ?? run) } : run);
    }
    return runs.sort((a, b) => b.createdAt - a.createdAt);
  }
  async execute(seed: Run, options: ExecuteOptions): Promise<Run> {
    if (this.closing) throw new Error("Runtime is shutting down");
    if (this.managing.has(seed.id)) throw new Error("Conversation is busy compacting");
    let cached: Run | undefined;
    try { cached = await this.read(seed.id); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (cached) {
      if (cached.sessionId !== seed.sessionId || cached.cwd !== seed.cwd || cached.task !== seed.task) throw new Error("Run identity does not match this delegation");
      if (options.continuation && cached.status !== "paused") throw new Error("Only an allowance-paused run can be continued");
      if (cached.status === "aborted" || cached.status === "succeeded" || (cached.status === "failed" && !options.recoveryApproved)) return cached;
      if (cached.status === "paused") {
        if (!options.continuation) return cached;
        const choice = options.continuation;
        if (!choice.reassessment.trim() || (choice.timeoutMinutes !== null && (!Number.isFinite(choice.timeoutMinutes) || choice.timeoutMinutes < 1 || choice.timeoutMinutes > 480))) throw new Error("Continuation requires reassessment and a fresh allowance or null");
        if ((cached.noProgressPauses ?? 0) >= 2 && !options.recoveryApproved) throw new Error("Repeated allowance pauses without useful tool progress require operator reassessment; stop and revise the plan");
      } else if (!options.recoveryApproved) throw new Error("Explicit resume approval required");
    }
    // Recheck after the read: another invocation may have entered or shutdown begun.
    if (this.closing) throw new Error("Runtime is shutting down");
    if (this.managing.has(seed.id)) throw new Error("Conversation is busy compacting");
    if (this.active.has(seed.id)) throw new Error("This run is already executing");
    if ([...this.active.values(), ...this.managing.values()].filter(run => run.sessionId === seed.sessionId).length >= this.maxActive) throw new Error(`Active Sub-agent capacity ${this.maxActive}: busy; no work queued`);
    // Conservative v1: one delegation per cwd, even read-only agents may have bash. A nested run is
    // already inside an admitted tree, so it is exempt.
    if (!options.nested && this.ownsWorkspace(seed.cwd)) throw new Error("Another delegation is using this working directory; wait for it to finish");
    const controller = new AbortController();
    const done = this.perform(seed, options, controller);
    this.active.set(seed.id, { stop: (reason = "shutdown") => controller.abort(reason), done, cwd: seed.cwd, sessionId: seed.sessionId });
    try { return await done; }
    finally { this.active.delete(seed.id); this.live.delete(seed.id); this.contextReaders.delete(seed.id); }
  }
  private async perform(seed: Run, options: ExecuteOptions, controller: AbortController): Promise<Run> {
    const directory = this.path(seed.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(directory, { realpath: false, stale: 10000, update: 2000, retries: 0,
      onCompromised: () => controller.abort("lock lost") });
    let workspaceRelease: (() => Promise<void>) | undefined;
    let identityValid = false;
    let persist = false;
    let harness: Harness | undefined;
    let unsubscribe: (() => void) | undefined;
    let stopConversation: (() => void) | undefined;
    let conversationStopped: Promise<void> | undefined;
    let finishActivity: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let checkpointTimer: ReturnType<typeof setTimeout> | undefined;
    let pauseRequested = false;
    let preparingHandoff = false;
    let priorHandoffRetries = 0;
    let activeWorkTools = 0;
    let publishPhase = () => {};
    let pauseConfiguration: Promise<void> | undefined;
    let progressTimer: ReturnType<typeof setInterval> | undefined;
    // Unique call IDs seen this execution; the bounded activityLog is not a tool-use total.
    const seenCalls = new Set<string>();
    const historicalCalls = new Set<string>();
    let priorToolCount = 0;
    const abort = () => controller.abort("cancelled");
    let run = seed;
    let steeringWrites = Promise.resolve();
    let steeringAdmissions = Promise.resolve();
    let acceptingGuidance = true;
    const pendingGuidance = new Map<string, { abort: () => Promise<unknown> }>();
    const persistSteering = () => {
      steeringWrites = steeringWrites.then(() => save(file, run));
      return steeringWrites;
    };
    const attemptStart = Date.now();
    const file = join(directory, "run.json");
    try {
      // Never persist a record before admission: a delegation that loses the workspace lock must
      // leave no orphan record that later looks like resumable work. `run` stays in memory as seed.
      try { run = await this.read(seed.id); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (run.sessionId !== seed.sessionId || run.cwd !== seed.cwd || run.task !== seed.task) throw new Error("Run identity does not match this delegation");
      identityValid = true;
      if (run.status === "aborted" || run.status === "succeeded") return run;
      priorToolCount = run.toolCount ?? 0;
      if (!options.nested) {
        const canonicalCwd = await realpath(run.cwd);
        const workspace = join(this.directory, ".workspaces", createHash("sha256").update(canonicalCwd).digest("hex"));
        await mkdir(workspace, { recursive: true, mode: 0o700 });
        workspaceRelease = await lockfile.lock(workspace, { realpath: false, stale: 10000, update: 2000, retries: 0,
          onCompromised: () => controller.abort("lock lost") });
      }
      persist = true;
      const continuing = run.status === "paused" && options.continuation;
      const failedRecovery = run.status === "failed";
      const handoffRecovery = run.status === "interrupted" && run.interruptedPhase === "preparing-handoff";
      if (continuing || failedRecovery || handoffRecovery) {
        run = { ...run, executionAttempt: (run.executionAttempt ?? 0) + 1 };
        if (continuing) {
          run.timeoutMinutes = continuing.timeoutMinutes;
          if (options.recoveryApproved) run.noProgressPauses = 0;
        }
        if (failedRecovery) run.recoveryHistory = [...(run.recoveryHistory ?? []), { error: run.error, status: run.status, approvedAt: Date.now() }];
      }
      const attempt = run.executionAttempt ?? 0;
      if (!options.models.getModel(run.model.provider, run.model.modelId)) throw new Error(`Model unavailable: ${run.model.provider}/${run.model.modelId}`);
      run = { ...run, status: "running", error: undefined, activity: "Starting", unavailable: run.agent.tools.filter((name) => !options.tools.some((tool) => tool.name === name)) };
      const registry = createRegistry();
      // Dispatch admission is checked even for calls already emitted in a model tool batch.
      // Removing the offered tools alone cannot revoke such an already planned call.
      const workTools = options.tools.filter(tool => run.agent.tools.includes(tool.name)).map(tool => ({ ...tool, execute: async (...args: Parameters<typeof tool.execute>) => {
        if (pauseRequested || controller.signal.aborted) throw new Error("Execution allowance ended; new work tools are prohibited");
        activeWorkTools++;
        try { return await tool.execute(...args); }
        finally {
          activeWorkTools--;
          if (pauseRequested && !controller.signal.aborted && activeWorkTools === 0) {
            run.status = "preparing-handoff";
            run.activity = "Preparing tool-free handoff";
            publishPhase();
          }
        }
      } }));
      registry.install(defineExtension({ name: "pi-tools", tools: workTools }));
      harness = await Harness.open(await openNodeSqliteStorage(join(directory, "agent.sqlite")), { models: options.models, registry,
        // Only the durable SDK owns transient retries. Provider-internal retries are disabled.
        // Settings are resolved afresh by the installed SDK for every failed generation.
        settings: { compaction: { enabled: false }, toolExecution: "sequential", stream: { maxRetries: 0 }, get retry() {
          return { maxRetries: preparingHandoff ? run.handoffRetryPolicy === "unlimited" ? Infinity : Math.max(0, 3 - priorHandoffRetries) : 2 };
        } } }, context);
      const instructions = subagentInstructions(run.agent, run.cwd, options.tools.map((tool) => tool.name), run.unavailable);
      const root = await harness.root(context, { agent: {
        model: run.model, thinkingLevel: run.thinking,
        tools: workTools, cwd: run.cwd,
        instructions,
      } });
      this.contextReaders.set(run.id, () => inspectContext(root, options.models.getModel(run.model.provider, run.model.modelId)?.contextWindow));
      // Aborting a submission wait alone does not stop SDK-owned retry work.
      stopConversation = () => {
        // Ordinary work shutdown is suspended by harness.close for explicit recovery.
        // Tool-free handoff has no recoverable work invocation and must stop retries now.
        if (preparingHandoff) { conversationStopped = root.abort(context); void conversationStopped.catch(() => {}); }
      };
      controller.signal.addEventListener("abort", stopConversation, { once: true });
      if (controller.signal.aborted) stopConversation();
      // Reconfigure only the loadout, not the frozen role/model/task on resume.
      await root.configure({ tools: workTools, instructions }, context);
      // Scan history once so resuming cannot count old live slots again, even after compaction
      // or a hard kill that left only the start metadata on disk.
      let cursor: Parameters<typeof root.entries>[2];
      do {
        const page = await root.entries({}, 200, cursor, context);
        for (const id of collectToolArguments(page.items).keys()) historicalCalls.add(id);
        cursor = page.next;
      } while (cursor);
      priorToolCount = Math.max(priorToolCount, historicalCalls.size);
      const view = await root.viewState(context);
      let last = 0;
      const publish = () => {
        if (controller.signal.aborted) return;
        const live = view.value.docs["pi.live"] as LiveState | undefined;
        const calls = live?.tools;
        if (preparingHandoff && live?.generation?.retry) run.handoffRetries = priorHandoffRetries + live.generation.attempt;
        const ledger = view.value.docs["pi.usage"] as Partial<UsageState> | undefined;
        if (ledger?.models) run.usage = executionUsage(ledger.models, run);
        const argsById = collectToolArguments(view.value.entries.slice(-120));
        for (const call of calls ?? []) {
          const log = run.activityLog ??= [];
          if (!historicalCalls.has(call.callId)) seenCalls.add(call.callId);
          const item = toolActivity(call, argsById.get(call.callId));
          const index = log.findIndex((existing) => existing.callId === call.callId);
          if (index < 0) log.push(item); else log[index] = item;
          if (log.length > 30) log.shift();
        }
        run.toolCount = priorToolCount + seenCalls.size;
        reconcileToolDiagnostics(run.activityLog ?? [], view.value.entries.slice(-60));
        const activity = describeActivity(live);
        const changed = activity !== run.activity;
        if (run.status === "running") run.activity = activity;
        if (changed || Date.now() - last >= 150) {
          last = Date.now();
          // Deep copy the activity list so an earlier emitted update never mutates under a later one.
          const snapshot = { ...run, updatedAt: last, elapsedMs: (run.elapsedMs ?? 0) + last - attemptStart, ...(run.activityLog ? { activityLog: run.activityLog.map((call) => ({ ...call })) } : {}) };
          this.live.set(run.id, snapshot);
          options.onUpdate?.(snapshot);
        }
      };
      publishPhase = publish;
      const consumeGuidance = () => {
        for (const [id] of pendingGuidance) {
          const inserted = view.value.entries.some(entry => entry.model?.some(message => message.role === "user" && typeof message.content === "string" && message.content.startsWith(`[Parent guidance ${id}]`)));
          if (!inserted) continue;
          pendingGuidance.delete(id);
          const summary = run.steering!;
          summary.consumed++; summary.pending--;
          if (summary.latest?.id === id) summary.latest = { ...summary.latest, state: "consumed", consumedAt: Date.now() };
          void persistSteering().catch(() => controller.abort("steering persistence failed"));
        }
      };
      const consumeOff = view.subscribe(consumeGuidance);
      finishActivity = () => reconcileToolDiagnostics(run.activityLog ?? [], view.value.entries.slice(-60));
      const off = view.subscribe(publish);
      // Active execution keeps the host alive even when a tool awaits only a Promise and there
      // is no deadline timer. This only publishes progress and is cleared on completion/shutdown.
      progressTimer = setInterval(publish, 1000);
      unsubscribe = () => { off(); consumeOff(); view.dispose(); };
      await save(file, run);
      options.onUpdate?.({ ...run, updatedAt: attemptStart, ...(run.activityLog ? { activityLog: run.activityLog.map((call) => ({ ...call })) } : {}) });
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      const allowance = run.timeoutMinutes !== undefined ? run.timeoutMinutes : run.agent.timeoutMinutes;
      if (allowance != null) {
        checkpointTimer = setTimeout(() => {
          run.checkpointRequestedAt = Date.now();
          // Steering is consumed at a safe generation/tool boundary; it cannot stop a tool.
          void root.submit({ type: "input", whenBusy: "steer", content: "Your execution allowance is nearing expiry. Preserve a checkpoint of progress and remaining work before the pause boundary.", requestId: `checkpoint:${run.id}:${attempt}` }, context).catch(() => {});
        }, allowance * 48000);
        timer = setTimeout(() => {
          pauseRequested = true;
          run.status = activeWorkTools ? "pausing" : "preparing-handoff";
          run.pauseReason = "allowance";
          run.activity = activeWorkTools ? "Waiting for current work to finish" : "Preparing tool-free handoff";
          pauseConfiguration = root.configure({ tools: [] }, context);
          // Observe rejection immediately, while the awaited work safely drains.
          void pauseConfiguration.catch(() => {});
          publish();
        }, allowance * 60000);
      }
      const waitContext = withAbortSignal(controller.signal, context);
      if (controller.signal.aborted) throw new Error(String(controller.signal.reason));
      const submission = await root.submit({ type: "input", content: continuing ? `Continue the original task within its original scope. Parent reassessment: ${continuing.reassessment}. Use retained progress; do not repeat completed side effects.` : failedRecovery || handoffRecovery ? "The operator approved recovery of the original task. Review retained history and the previous failure; continue remaining work without blindly replaying the unanswered submission or completed side effects." : run.task, requestId: attempt ? `continuation:${run.id}:${attempt}` : `delegation:${run.id}` }, waitContext);
      this.steering.set(run.id, guidance => {
        const admission = steeringAdmissions.then(async () => {
          if (!acceptingGuidance || controller.signal.aborted || pauseRequested || run.status !== "running" || (await submission.status(context)).status === "done") throw new Error("Steering requires active work; use follow-up for a completed child");
          if (pendingGuidance.size >= 8) throw new Error("Steering queue is full; wait for a safe boundary");
          const id = randomUUID();
          // Passive writes enter at a tool/turn boundary and cannot start another task if the
          // original submission settles between the active check and admission.
          const queued = await root.submit({ type: "write", entry: { kind: UserEntry.kind, model: [{ role: "user", content: `[Parent guidance ${id}] Guidance for the original task only; preserve its scope and fixed authority.\n${guidance}`, timestamp: Date.now() }] }, requestId: `steering:${run.id}:${id}` }, context);
          pendingGuidance.set(id, { abort: () => queued.abort(context) });
          const summary = run.steering ??= { accepted: 0, consumed: 0, discarded: 0, pending: 0 };
          summary.accepted++; summary.pending++; summary.latest = { id, state: "accepted", acceptedAt: Date.now() };
          consumeGuidance();
          await persistSteering(); publish();
          return { ...run, steering: { ...summary, latest: summary.latest ? { ...summary.latest } : undefined } };
        });
        steeringAdmissions = admission.then(() => {}, () => {});
        return admission;
      });
      options.onAdmitted?.({ ...run });
      let settled = await submission.wait(waitContext);
      acceptingGuidance = false;
      await steeringAdmissions;
      this.steering.delete(run.id);
      consumeGuidance();
      // An answer settled inside the work allowance is completion; metadata/ledger commits
      // after this boundary must not turn it into an unrequested pause.
      if (!pauseRequested) { clearTimeout(timer); clearTimeout(checkpointTimer); }
      if (pauseRequested) {
        await pauseConfiguration;
        // No outstanding tool remains when the submission settles. The final turn has no
        // offered tools, and the dispatch gate remains closed until harness shutdown.
        run.status = "preparing-handoff";
        run.activity = "Preparing tool-free handoff";
        publish();
        preparingHandoff = true;
        run.handoffRetries = 0;
        run.handoffCorrected = false;
        const handoff = await root.submit({ type: "input", content: "Execution is paused. Produce a final tool-free handoff: completed progress, unfinished task, workspace state, and limitations. Do not claim the task is complete.", requestId: `handoff:${run.id}:${attempt}` }, waitContext);
        settled = await handoff.wait(waitContext);
        if (settled.status === "done" && settled.type === "input" && settled.answer) {
          const entry = await root.commit(tx => tx.entry(AssistantEntry, settled.answer!), context);
          const message = entry?.model?.[0] as AssistantMessage | undefined;
          const text = message?.content.flatMap(part => part.type === "text" ? [part.text] : []).join("") ?? "";
          if (!text.trim() && message?.stopReason !== "error" && message?.stopReason !== "aborted") {
            run.handoffCorrected = true;
            priorHandoffRetries = run.handoffRetries ?? 0;
            run.activity = "Correcting empty handoff";
            publish();
            const correction = await root.submit({ type: "input", content: "Your handoff was empty. Provide a brief textual checkpoint with completed progress, unfinished work, workspace state, and limitations. Use no tools and do not continue the task.", requestId: `handoff-correction:${run.id}:${attempt}` }, waitContext);
            settled = await correction.wait(waitContext);
          }
        }
      }
      if (settled.status !== "done" || settled.type !== "input" || !settled.answer) {
        const entries = await root.entries({}, 20, undefined, context);
        const failure = entries.items.flatMap((entry) => entry.model ?? []).find(
          (message): message is AssistantMessage => message.role === "assistant" && Boolean(message.errorMessage),
        );
        throw new Error(`Delegation unanswered: ${settled.reason ?? settled.status}${failure?.errorMessage ? `\nProvider error: ${failure.errorMessage}` : ""}`);
      }
      const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer!), context);
      const message = entry?.model?.[0] as AssistantMessage | undefined;
      const answer = message?.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("") ?? "";
      if (message?.stopReason === "error" || message?.stopReason === "aborted") throw new Error(message.errorMessage ?? "Model did not complete");
      if (pauseRequested) {
        run.handoff = answer;
        if (!answer.trim()) run.handoffLimitation = "The handoff model returned no text; retained progress remains inspectable.";
        run.status = "paused"; run.activity = "Paused at execution allowance";
      } else { run.output = answer; run.status = "succeeded"; run.activity = "Completed"; }
    } catch (error) {
      if (!identityValid) throw error;
      // A competing delegation must not turn recoverable work into a failed run.
      if ((error as NodeJS.ErrnoException).code === "ELOCKED") throw error;
      const reason = controller.signal.reason;
      if (reason === "shutdown" || reason === "lock lost") run.interruptedPhase = run.status;
      run.status = reason === "shutdown" || reason === "lock lost" ? "interrupted" : reason === "cancelled" ? "aborted" : "failed";
      run.error = error instanceof Error ? error.message : String(error);
      if (pauseRequested && !controller.signal.aborted) {
        run.status = "paused";
        run.handoffLimitation = `Handoff unavailable: ${run.error}. Review retained activity and unfinished task.`;
        run.error = undefined;
      }
      run.activity = run.status === "paused" ? "Paused; handoff unavailable" : run.status === "interrupted" ? "Awaiting explicit resume" : run.status === "aborted" ? "Cancelled" : "Failed";
      if (harness && run.status !== "interrupted") {
        const root = await harness.root(context);
        await root.abort(context);
      }
    } finally {
      acceptingGuidance = false;
      this.steering.delete(run.id);
      await steeringAdmissions;
      // Withdraw queued input before closing the harness, so explicit recovery cannot replay it.
      for (const [id, queued] of pendingGuidance) {
        await queued.abort().catch(() => {});
        if (pendingGuidance.has(id) && run.steering) {
          run.steering.pending--; run.steering.discarded++;
          if (run.steering.latest?.id === id) run.steering.latest = { ...run.steering.latest, state: "discarded" };
        }
      }
      pendingGuidance.clear();
      await steeringWrites.catch(() => {});
      clearTimeout(timer);
      clearTimeout(checkpointTimer);
      clearInterval(progressTimer);
      options.signal?.removeEventListener("abort", abort);
      if (stopConversation) controller.signal.removeEventListener("abort", stopConversation);
      await conversationStopped?.catch(() => {});
      finishActivity?.();
      unsubscribe?.();
      try {
        if (harness) {
          try {
            const ledger = await harness.usage(context);
            run.usage = executionUsage(ledger.models, run);
          } finally { await harness.close(context); }
        }
        if (identityValid && persist) {
          if (harness) run.elapsedMs = (run.elapsedMs ?? 0) + Date.now() - attemptStart;
          if (run.status === "paused") {
            run.noProgressPauses = (run.toolCount ?? 0) > (run.pauseToolCount ?? 0) ? 0 : (run.noProgressPauses ?? 0) + 1;
            run.pauseToolCount = run.toolCount ?? 0;
          }
          run.updatedAt = Date.now();
          await save(file, run);
        }
      } finally {
        try { await workspaceRelease?.(); }
        finally { await release(); }
        // Best effort: an unadmitted run leaves no record and no empty run directory behind.
        if (!persist) { try { await rmdir(directory); } catch { /* directory is not empty or already gone */ } }
      }
    }
    this.contextReaders.delete(run.id);
    options.onUpdate?.({ ...run, ...(run.activityLog ? { activityLog: run.activityLog.map((call) => ({ ...call })) } : {}) });
    return run;
  }
  /** Read-only projection; opening the SDK does not resume retained tasks. */
  async inspect(id: string, options: { sessionId: string; models: Models }): Promise<Run> {
    const run = await this.status(id, options.sessionId);
    const capacity = options.models.getModel(run.model.provider, run.model.modelId)?.contextWindow;
    const reader = this.contextReaders.get(id);
    if (reader) return { ...run, contextHealth: await reader() };
    if (this.managing.has(id)) return { ...run, contextHealth: { ...await inspectContext(undefined, capacity), compaction: "running" } };
    const directory = this.path(id);
    const release = await lockfile.lock(directory, { realpath: false, stale: 10000, retries: 0 });
    let harness: Harness | undefined;
    try {
      harness = await Harness.open(await openNodeSqliteStorage(join(directory, "agent.sqlite")), { models: options.models, registry: createRegistry(), settings: { compaction: { enabled: false } } }, context);
      return { ...run, contextHealth: await inspectContext(await harness.root(context), capacity) };
    } finally { try { await harness?.close(context); } finally { await release(); } }
  }
  async compact(id: string, options: { sessionId: string; models: Models; instructions?: string; signal?: AbortSignal }): Promise<Run> {
    const run = await this.status(id, options.sessionId);
    if (this.closing) throw new Error("Runtime is shutting down");
    if (this.active.has(id) || this.managing.has(id) || !["succeeded", "paused"].includes(run.status)) throw new Error("Compaction requires an eligible idle completed or allowance-paused conversation");
    if ([...this.active.values(), ...this.managing.values()].filter(item => item.sessionId === options.sessionId).length >= this.maxActive) throw new Error("Execution capacity is busy");
    const controller = new AbortController();
    const abort = () => controller.abort(); options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const done = this.compactIdle(run, options, controller.signal);
    this.managing.set(id, { stop: abort, done, cwd: run.cwd, sessionId: run.sessionId });
    try { return await done; } finally { this.managing.delete(id); options.signal?.removeEventListener("abort", abort); }
  }
  private async compactIdle(run: Run, options: { models: Models; instructions?: string }, signal: AbortSignal): Promise<Run> {
    const directory = this.path(run.id);
    const release = await lockfile.lock(directory, { realpath: false, stale: 10000, update: 2000, retries: 0 });
    let workspaceRelease: (() => Promise<void>) | undefined; let harness: Harness | undefined;
    try {
      const workspace = join(this.directory, ".workspaces", createHash("sha256").update(await realpath(run.cwd)).digest("hex"));
      await mkdir(workspace, { recursive: true, mode: 0o700 });
      workspaceRelease = await lockfile.lock(workspace, { realpath: false, stale: 10000, update: 2000, retries: 0 });
      harness = await Harness.open(await openNodeSqliteStorage(join(directory, "agent.sqlite")), { models: options.models, registry: createRegistry(), settings: { compaction: { enabled: false }, stream: { maxRetries: 0 }, retry: { maxRetries: 0 } } }, context);
      const root = await harness.root(context);
      const inspection = await harness.inspect(context);
      const state = await root.viewState(context);
      const live = state.value.docs["pi.live"] as LiveState | undefined;
      const inbox = state.value.docs["pi.inbox"] as { items?: unknown[] } | undefined;
      if (inspection.tasks.length || inspection.submissions.length || live?.run || live?.compactions?.length || inbox?.items?.length) throw new Error("Retained conversation has unfinished work; compaction refused without resuming it");
      const before = modelUsage((await harness.usage(context)).models);
      const operation: NonNullable<Run["compactions"]>[number] = { id: randomUUID(), outcome: "noop", usage: before, at: Date.now() };
      try {
        if (signal.aborted) throw new Error("Compaction cancelled");
        const task = await root.compact(options.instructions, context);
        const cancel = () => { void harness!.abortTask(task, context).catch(() => {}); };
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
        try {
          const receipt = await harness.waitForTask(task, context);
          if (receipt.state.outcome.status !== "completed") throw new Error(`Compaction ${receipt.state.outcome.status}`);
          const result = receipt.state.outcome.result;
          if (result.submissionId) {
            const submission = await harness.submission(result.submissionId, context);
            const placement = await submission?.wait(context);
            if (placement?.status !== "done" || placement.type !== "write" || !placement.entry) throw new Error("Compaction summary was not applied");
            operation.outcome = "applied";
          } else if (result.entryId) operation.outcome = "applied";
        } finally { signal.removeEventListener("abort", cancel); }
      } catch (error) { operation.outcome = "failed"; operation.error = (error as Error).message; }
      const after = modelUsage((await harness.usage(context)).models);
      operation.usage = { input: after.input-before.input, output: after.output-before.output, cacheRead: after.cacheRead-before.cacheRead, cacheWrite: after.cacheWrite-before.cacheWrite, totalTokens: after.totalTokens-before.totalTokens,
        cost: { input: after.cost.input-before.cost.input, output: after.cost.output-before.cost.output, cacheRead: after.cost.cacheRead-before.cost.cacheRead, cacheWrite: after.cost.cacheWrite-before.cost.cacheWrite, total: after.cost.total-before.cost.total } };
      const updated = { ...run, compactions: [...(run.compactions ?? []), operation], contextHealth: await inspectContext(root, options.models.getModel(run.model.provider, run.model.modelId)?.contextWindow) };
      await save(join(directory, "run.json"), updated);
      return updated;
    } finally { try { await harness?.close(context); } finally { try { await workspaceRelease?.(); } finally { await release(); } } }
  }
  async cancel(id: string): Promise<void> {
    const managing = this.managing.get(id);
    if (managing) { managing.stop(); await managing.done; return; }
    const active = this.active.get(id);
    if (active) { active.stop("cancelled"); await active.done; return; }
    const directory = this.path(id);
    const release = await lockfile.lock(directory, { realpath: false, stale: 10000, retries: 0 });
    let harness: Harness | undefined;
    try {
      const run = await this.read(id);
      if (terminal(run)) return;
      harness = await Harness.open(await openNodeSqliteStorage(join(directory, "agent.sqlite")), { models: createModels(), registry: createRegistry(), settings: { compaction: { enabled: false } } }, context);
      const root = await harness.root(context);
      await root.abort(context);
      await save(join(directory, "run.json"), { ...run, status: "aborted", activity: "Cancelled", updatedAt: Date.now() });
    } finally {
      try { if (harness) await harness.close(context); }
      finally { await release(); }
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    const active = [...this.active.values()];
    active.forEach((run) => run.stop());
    const managing = [...this.managing.values()]; managing.forEach(run => run.stop());
    await Promise.allSettled([...active, ...managing].map((run) => run.done));
  }
}
