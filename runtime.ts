import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, rmdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels, type Models, type Usage, type AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, createRegistry, defineExtension, Harness, type LiveState, type UsageState, type ToolRegistration } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import lockfile from "proper-lockfile";
import type { AgentDefinition } from "./agents.ts";
import { subagentInstructions } from "./prompt.ts";
import { collectToolArguments, describeActivity, reconcileToolDiagnostics, toolActivity } from "./activity.ts";

export type RunStatus = "running" | "succeeded" | "failed" | "aborted" | "interrupted";
/** Succeeded, Failed, and Aborted are finished; Running and Interrupted are not. */
export const TERMINAL_STATUSES: readonly RunStatus[] = ["succeeded", "failed", "aborted"];
export const isTerminal = (run: Pick<Run, "status">) => TERMINAL_STATUSES.includes(run.status);
export interface Run {
  version: 1;
  id: string;
  sessionId: string;
  agent: AgentDefinition;
  task: string;
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
  /** Unique tool calls across this run's history, reconstructed from durable entries on recovery. */
  toolCount?: number;
  activityLog?: { callId: string; name: string; status: string; output?: string; summary?: string; uncertain?: boolean; failed?: boolean }[];
  error?: string;
  usage?: Usage;
}
export interface ExecuteOptions {
  models: Models;
  tools: ToolRegistration[];
  signal?: AbortSignal;
  onUpdate?: (run: Run) => void;
  /**
   * A nested delegation inside an already admitted tree. The tree's root holds the workspace
   * admission, so nested runs still record and recover but do not take the workspace lock again.
   */
  nested?: boolean;
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

/** One SQLite harness per delegation. No idle scheduler and no expired Pi tool context. */
export class Runtime {
  readonly directory: string;
  private active = new Map<string, { stop: () => void; done: Promise<Run>; cwd: string }>();
  /** Latest in-memory snapshot per active run, so inspection shows live progress instead of the start record. */
  private live = new Map<string, Run>();
  private closing = false;
  constructor(directory: string) { this.directory = resolve(directory); }
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
      if (!terminal(run) && !this.active.has(id)) { run.status = "interrupted"; run.activity = "Awaiting explicit resume"; }
      // A running delegation reports what it is doing now; the on-disk record only has its start state.
      runs.push(this.active.has(id) ? { ...(this.live.get(id) ?? run) } : run);
    }
    return runs.sort((a, b) => b.createdAt - a.createdAt);
  }
  async execute(seed: Run, options: ExecuteOptions): Promise<Run> {
    if (this.closing) throw new Error("Runtime is shutting down");
    let cached: Run | undefined;
    try { cached = await this.read(seed.id); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (cached) {
      if (cached.sessionId !== seed.sessionId || cached.cwd !== seed.cwd || cached.task !== seed.task) throw new Error("Run identity does not match this delegation");
      if (terminal(cached)) return cached;
    }
    // Recheck after the read: another invocation may have entered or shutdown begun.
    if (this.closing) throw new Error("Runtime is shutting down");
    if (this.active.has(seed.id)) throw new Error("This run is already executing");
    // Conservative v1: one delegation per cwd, even read-only agents may have bash. A nested run is
    // already inside an admitted tree, so it is exempt.
    if (!options.nested && [...this.active.values()].some((run) => run.cwd === seed.cwd)) throw new Error("Another delegation is using this working directory; wait for it to finish");
    const controller = new AbortController();
    const done = this.perform(seed, options, controller);
    this.active.set(seed.id, { stop: () => controller.abort("shutdown"), done, cwd: seed.cwd });
    try { return await done; }
    finally { this.active.delete(seed.id); this.live.delete(seed.id); }
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
    let finishActivity: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let progressTimer: ReturnType<typeof setInterval> | undefined;
    // Unique call IDs seen this execution; the bounded activityLog is not a tool-use total.
    const seenCalls = new Set<string>();
    const historicalCalls = new Set<string>();
    let priorToolCount = 0;
    const abort = () => controller.abort("cancelled");
    let run = seed;
    const attemptStart = Date.now();
    const file = join(directory, "run.json");
    try {
      // Never persist a record before admission: a delegation that loses the workspace lock must
      // leave no orphan record that later looks like resumable work. `run` stays in memory as seed.
      try { run = await this.read(seed.id); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (run.sessionId !== seed.sessionId || run.cwd !== seed.cwd || run.task !== seed.task) throw new Error("Run identity does not match this delegation");
      identityValid = true;
      if (terminal(run)) return run;
      priorToolCount = run.toolCount ?? 0;
      if (!options.nested) {
        const canonicalCwd = await realpath(run.cwd);
        const workspace = join(this.directory, ".workspaces", createHash("sha256").update(canonicalCwd).digest("hex"));
        await mkdir(workspace, { recursive: true, mode: 0o700 });
        workspaceRelease = await lockfile.lock(workspace, { realpath: false, stale: 10000, update: 2000, retries: 0,
          onCompromised: () => controller.abort("lock lost") });
      }
      persist = true;
      if (!options.models.getModel(run.model.provider, run.model.modelId)) throw new Error(`Model unavailable: ${run.model.provider}/${run.model.modelId}`);
      run = { ...run, status: "running", error: undefined, activity: "Starting", unavailable: run.agent.tools.filter((name) => !options.tools.some((tool) => tool.name === name)) };
      const registry = createRegistry();
      registry.install(defineExtension({ name: "pi-tools", tools: options.tools }));
      harness = await Harness.open(await openNodeSqliteStorage(join(directory, "agent.sqlite")), { models: options.models, registry,
        settings: { toolExecution: "sequential", retry: { maxRetries: 2 } } }, context);
      const instructions = subagentInstructions(run.agent, run.cwd, options.tools.map((tool) => tool.name), run.unavailable);
      const root = await harness.root(context, { agent: {
        model: run.model, thinkingLevel: run.thinking,
        tools: options.tools, cwd: run.cwd,
        instructions,
      } });
      // Reconfigure only the loadout, not the frozen role/model/task on resume.
      await root.configure({ tools: options.tools, instructions }, context);
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
        if (run.status !== "running" || controller.signal.aborted) return;
        const live = view.value.docs["pi.live"] as LiveState | undefined;
        const calls = live?.tools;
        const ledger = view.value.docs["pi.usage"] as Partial<UsageState> | undefined;
        if (ledger?.models) run.usage = modelUsage(ledger.models);
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
        run.activity = activity;
        if (changed || Date.now() - last >= 150) {
          last = Date.now();
          // Deep copy the activity list so an earlier emitted update never mutates under a later one.
          const snapshot = { ...run, updatedAt: last, elapsedMs: (run.elapsedMs ?? 0) + last - attemptStart, ...(run.activityLog ? { activityLog: run.activityLog.map((call) => ({ ...call })) } : {}) };
          this.live.set(run.id, snapshot);
          options.onUpdate?.(snapshot);
        }
      };
      finishActivity = () => reconcileToolDiagnostics(run.activityLog ?? [], view.value.entries.slice(-60));
      const off = view.subscribe(publish);
      // Active execution keeps the host alive even when a tool awaits only a Promise and there
      // is no deadline timer. This only publishes progress and is cleared on completion/shutdown.
      progressTimer = setInterval(publish, 1000);
      unsubscribe = () => { off(); view.dispose(); };
      await save(file, run);
      options.onUpdate?.({ ...run, updatedAt: attemptStart, ...(run.activityLog ? { activityLog: run.activityLog.map((call) => ({ ...call })) } : {}) });
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      const allowance = run.timeoutMinutes !== undefined ? run.timeoutMinutes : run.agent.timeoutMinutes;
      if (allowance != null) timer = setTimeout(() => controller.abort("timeout"), allowance * 60000);
      const waitContext = withAbortSignal(controller.signal, context);
      if (controller.signal.aborted) throw new Error(String(controller.signal.reason));
      const submission = await root.submit({ type: "input", content: run.task, requestId: `delegation:${run.id}` }, waitContext);
      const settled = await submission.wait(waitContext);
      if (settled.status !== "done" || settled.type !== "input" || !settled.answer) {
        const entries = await root.entries({}, 20, undefined, context);
        const failure = entries.items.flatMap((entry) => entry.model ?? []).find(
          (message): message is AssistantMessage => message.role === "assistant" && Boolean(message.errorMessage),
        );
        throw new Error(`Delegation unanswered: ${settled.reason ?? settled.status}${failure?.errorMessage ? `\nProvider error: ${failure.errorMessage}` : ""}`);
      }
      const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer!), context);
      const message = entry?.model?.[0] as AssistantMessage | undefined;
      run.output = message?.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("") ?? "";
      if (message?.stopReason === "error" || message?.stopReason === "aborted") throw new Error(message.errorMessage ?? "Model did not complete");
      run.status = "succeeded"; run.activity = "Completed";
    } catch (error) {
      if (!identityValid) throw error;
      // A competing delegation must not turn recoverable work into a failed run.
      if ((error as NodeJS.ErrnoException).code === "ELOCKED") throw error;
      const reason = controller.signal.reason;
      run.status = reason === "shutdown" || reason === "lock lost" ? "interrupted" : reason === "cancelled" ? "aborted" : "failed";
      run.error = reason === "timeout" ? `Timed out after ${run.timeoutMinutes !== undefined ? run.timeoutMinutes : run.agent.timeoutMinutes} minutes` : error instanceof Error ? error.message : String(error);
      run.activity = run.status === "interrupted" ? "Awaiting explicit resume" : run.status === "aborted" ? "Cancelled" : "Failed";
      if (harness && run.status !== "interrupted") {
        const root = await harness.root(context);
        await root.abort(context);
      }
    } finally {
      clearTimeout(timer);
      clearInterval(progressTimer);
      options.signal?.removeEventListener("abort", abort);
      finishActivity?.();
      unsubscribe?.();
      try {
        if (harness) {
          try {
            const ledger = await harness.usage(context);
            run.usage = modelUsage(ledger.models);
          } finally { await harness.close(context); }
        }
        if (identityValid && persist) {
          if (harness) run.elapsedMs = (run.elapsedMs ?? 0) + Date.now() - attemptStart;
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
    options.onUpdate?.({ ...run, ...(run.activityLog ? { activityLog: run.activityLog.map((call) => ({ ...call })) } : {}) });
    return run;
  }
  async cancel(id: string): Promise<void> {
    if (this.active.has(id)) throw new Error("Use Pi's cancellation control to stop an active delegation");
    const directory = this.path(id);
    const release = await lockfile.lock(directory, { realpath: false, stale: 10000, retries: 0 });
    let harness: Harness | undefined;
    try {
      const run = await this.read(id);
      if (terminal(run)) return;
      harness = await Harness.open(await openNodeSqliteStorage(join(directory, "agent.sqlite")), { models: createModels(), registry: createRegistry() }, context);
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
    await Promise.allSettled(active.map((run) => run.done));
  }
}
