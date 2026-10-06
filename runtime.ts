import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, rmdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels, type Models, type Usage, type AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, UserEntry, createRegistry, defineExtension, Harness, type LiveState, type UsageState, type ToolRegistration } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import lockfile from "proper-lockfile";
import type { DelegationPresentation } from "./presentation.ts";
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
  /** Owning requested group; unstarted dependencies live in its separate durable record. */
  groupId?: string;
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
export interface Group {
  version: 1;
  id: string;
  sessionId: string;
  nonblocking: boolean;
  seeds: Run[];
  presentation: DelegationPresentation;
  cancelled?: boolean;
  errors?: Record<string, string>;
}
export interface GroupSnapshot extends Group {
  steps: Run[];
  status: RunStatus;
  activity: string;
}
export interface GroupOptions {
  optionsForRun: (run: Run) => ExecuteOptions | Promise<ExecuteOptions>;
  onUpdate?: (group: GroupSnapshot) => void;
  signal?: AbortSignal;
  /** Only this stopped child is authorized to continue/recover. */
  resumeId?: string;
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

/** One SQLite harness per execution with awaited owner shutdown and no idle scheduler. */
export class Runtime {
  readonly directory: string;
  private active = new Map<string, { stop: (reason?: string) => void; done: Promise<Run>; cwd: string; sessionId: string }>();
  /** Latest in-memory snapshot per active run, so inspection shows live progress instead of the start record. */
  private live = new Map<string, Run>();
  private steering = new Map<string, (guidance: string) => Promise<Run>>();
  private groups = new Map<string, { group: Group; done: Promise<GroupSnapshot>; controller: AbortController }>();
  private closing = false;
  readonly maxActive: number;
  constructor(directory: string, options: { maxActive?: number } = {}) {
    this.directory = resolve(directory);
    this.maxActive = options.maxActive ?? 8;
    if (!Number.isInteger(this.maxActive) || this.maxActive < 1) throw new Error("Active capacity must be a positive integer");
  }
  /** Workspace ownership stays live after a detached start returns. */
  ownsWorkspace(cwd: string): boolean { return [...this.active.values()].some(run => run.cwd === cwd); }
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
  private groupPath(id: string) { validateId(id); return join(this.directory, ".groups", `${id}.json`); }
  private async saveGroup(group: Group) {
    await mkdir(join(this.directory, ".groups"), { recursive: true, mode: 0o700 });
    const file = this.groupPath(group.id), temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(group), { mode: 0o600 }); await rename(temp, file);
  }
  async readGroup(id: string): Promise<Group | undefined> {
    try {
      const group: Group = JSON.parse(await readFile(this.groupPath(id), "utf8"));
      if (group.version !== 1 || group.id !== id) throw new Error("Unsupported group metadata");
      return group;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  async listGroups(sessionId: string): Promise<Group[]> {
    let files: string[];
    try { files = await readdir(join(this.directory, ".groups")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const groups = await Promise.all(files.filter(file => /^[a-f0-9]{32}\.json$/.test(file)).map(file => this.readGroup(file.slice(0, 32))));
    return groups.filter((group): group is Group => !!group && group.sessionId === sessionId);
  }
  async groupForChild(id: string, sessionId: string): Promise<Group | undefined> {
    return (await this.listGroups(sessionId)).find(group => group.seeds.some(seed => seed.id === id));
  }
  async groupStatus(id: string, sessionId: string): Promise<GroupSnapshot> {
    const group = this.groups.get(id)?.group ?? await this.readGroup(id);
    if (!group) throw new Error("Unknown group handle");
    if (group.sessionId !== sessionId) throw new Error("Group belongs to another Pi session");
    const steps: Run[] = [];
    for (const seed of group.seeds) {
      try { steps.push(await this.status(seed.id, sessionId)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const status: RunStatus = steps.some(run => ["running", "pausing", "preparing-handoff"].includes(run.status)) ? "running"
      : group.cancelled ? "aborted" : steps.some(run => run.status === "paused") ? "paused"
      : steps.some(run => run.status === "interrupted") || group.presentation.entries.some(entry => entry.phase === "pending") ? "interrupted"
      : Object.keys(group.errors ?? {}).length || steps.some(run => run.status === "failed") ? "failed"
      : steps.some(run => run.status === "aborted") ? "aborted" : "succeeded";
    return { ...group, presentation: { ...group.presentation, entries: group.presentation.entries.map(entry => ({ ...entry })) }, steps,
      status, activity: status === "paused" ? "Dependent steps held pending explicit continuation" : status === "interrupted" ? "Awaiting explicit recovery; pending steps remain stopped" : status === "running" ? "Group executing" : status === "succeeded" ? "Group completed" : "Group stopped" };
  }
  /** Uses the same execution engine and its actual-child admission, never queues capacity failures. */
  async executeGroup(seed: Group, options: GroupOptions, detached = false): Promise<GroupSnapshot> {
    if (this.closing) throw new Error("Runtime is shutting down");
    if (this.groups.has(seed.id)) throw new Error("This group is already executing");
    const stored = await this.readGroup(seed.id);
    const group = stored ?? seed;
    if (group.sessionId !== seed.sessionId) throw new Error("Group belongs to another Pi session");
    if (group.cancelled) return this.groupStatus(group.id, group.sessionId);
    await this.saveGroup(group);
    // Recheck after persistence so concurrent calls cannot supervise the same graph twice.
    if (this.closing || this.groups.has(seed.id)) throw new Error("Group unavailable or already executing");
    const controller = new AbortController();
    let admit!: () => void;
    const ready = new Promise<void>(resolve => { admit = resolve; });
    const abort = () => controller.abort("cancelled");
    if (!detached) { options.signal?.addEventListener("abort", abort, { once: true }); if (options.signal?.aborted) abort(); }
    let writes = Promise.resolve();
    const persist = () => { writes = writes.then(() => this.saveGroup(group)); return writes; };
    const publish = async () => { const snapshot = await this.groupStatus(group.id, group.sessionId); options.onUpdate?.(snapshot); return snapshot; };
    const runChild = async (index: number) => {
      const entry = group.presentation.entries[index];
      if (group.cancelled || controller.signal.aborted || this.closing || entry.phase === "not-run") return;
      let child = group.seeds[index];
      let existing: Run | undefined;
      try { existing = await this.status(child.id, group.sessionId); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (existing && child.id !== options.resumeId) return existing;
      if (group.presentation.mode === "chain" && index > 0 && !existing) {
        const previous = await this.status(group.seeds[index - 1].id, group.sessionId);
        if (previous.status !== "succeeded") return;
        child = { ...child, task: `${child.task}\n\nAnswer from the previous step in this chain:\n${previous.output ?? ""}` };
        group.seeds[index] = child;
      }
      const childOptions = await options.optionsForRun(child);
      if (group.cancelled || controller.signal.aborted || this.closing || group.presentation.entries[index].phase === "not-run") return;
      try {
        const result = await this.execute(child, { ...childOptions, signal: controller.signal,
          onAdmitted: run => { entry.phase = "run"; void persist(); admit(); childOptions.onAdmitted?.(run); },
          onUpdate: run => { childOptions.onUpdate?.(run); void publish(); },
        });
        entry.phase = "run"; await persist(); await publish(); return result;
      } catch (error) {
        entry.phase = "not-run";
        (group.errors ??= {})[child.id] = error instanceof Error ? error.message : String(error);
        await persist(); await publish();
      }
    };
    // Start in the next microtask, after the group owner is registered.
    const done = Promise.resolve().then(async () => {
      try {
        if (group.presentation.mode === "parallel") await Promise.all(group.seeds.map((_, index) => runChild(index)));
        else for (let index = 0; index < group.seeds.length; index++) {
          const result = await runChild(index);
          if (!result || result.status !== "succeeded") {
            if (result?.status !== "paused" && result?.status !== "interrupted") for (const entry of group.presentation.entries.slice(index + 1)) if (entry.phase === "pending") entry.phase = "not-run";
            break;
          }
        }
        if (controller.signal.reason === "cancelled" || group.cancelled) for (const entry of group.presentation.entries) if (entry.phase === "pending") entry.phase = "not-run";
        await persist(); return await publish();
      } finally { options.signal?.removeEventListener("abort", abort); this.groups.delete(group.id); }
    });
    this.groups.set(group.id, { group, done, controller });
    if (detached) { await Promise.race([ready, done]); return this.groupStatus(group.id, group.sessionId); }
    return done;
  }
  async waitGroup(id: string, options: { sessionId: string; timeoutSeconds?: number; signal?: AbortSignal }): Promise<GroupSnapshot> {
    await this.groupStatus(id, options.sessionId);
    const seconds = options.timeoutSeconds ?? 60;
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600) throw new Error("Wait duration must be between 0 and 3600 seconds");
    const active = this.groups.get(id);
    if (!active) return this.groupStatus(id, options.sessionId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort!: () => void;
    const boundary = new Promise<void>(resolve => { timer = setTimeout(resolve, seconds * 1000); abort = resolve; options.signal?.addEventListener("abort", abort, { once: true }); if (options.signal?.aborted) resolve(); });
    try { await Promise.race([active.done, boundary]); return await this.groupStatus(id, options.sessionId); }
    finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
  }
  async cancelGroup(id: string, sessionId: string, childId?: string): Promise<GroupSnapshot> {
    const group = this.groups.get(id)?.group ?? await this.readGroup(id);
    if (!group || group.sessionId !== sessionId) throw new Error("Group belongs to another Pi session or does not exist");
    if (!childId) { group.cancelled = true; this.groups.get(id)?.controller.abort("cancelled"); }
    for (const [index, seed] of group.seeds.entries()) {
      if (childId && seed.id !== childId) continue;
      const entry = group.presentation.entries[index];
      if (entry.phase === "pending") { entry.phase = "not-run"; if (this.active.has(seed.id)) await this.cancel(seed.id); }
      else if (entry.phase === "run") await this.cancel(seed.id);
    }
    // A cancelled dependency cannot advance an ordered/chain graph.
    if (childId && group.presentation.mode !== "parallel") {
      const index = group.seeds.findIndex(seed => seed.id === childId);
      for (const entry of group.presentation.entries.slice(index + 1)) if (entry.phase === "pending") entry.phase = "not-run";
    }
    await this.saveGroup(group);
    if (!childId) await this.groups.get(id)?.done;
    return this.groupStatus(id, sessionId);
  }
  async execute(seed: Run, options: ExecuteOptions): Promise<Run> {
    if (this.closing) throw new Error("Runtime is shutting down");
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
    if (this.active.has(seed.id)) throw new Error("This run is already executing");
    if ([...this.active.values()].filter(run => run.sessionId === seed.sessionId).length >= this.maxActive) throw new Error(`Active Sub-agent capacity ${this.maxActive}: busy; no work queued`);
    // Conservative v1: one delegation per cwd, even read-only agents may have bash. A nested run is
    // already inside an admitted tree, so it is exempt.
    if (!options.nested && [...this.active.values()].some((run) => run.cwd === seed.cwd)) throw new Error("Another delegation is using this working directory; wait for it to finish");
    const controller = new AbortController();
    const done = this.perform(seed, options, controller);
    this.active.set(seed.id, { stop: (reason = "shutdown") => controller.abort(reason), done, cwd: seed.cwd, sessionId: seed.sessionId });
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
        settings: { toolExecution: "sequential", stream: { maxRetries: 0 }, get retry() {
          return { maxRetries: preparingHandoff ? run.handoffRetryPolicy === "unlimited" ? Infinity : Math.max(0, 3 - priorHandoffRetries) : 2 };
        } } }, context);
      const instructions = subagentInstructions(run.agent, run.cwd, options.tools.map((tool) => tool.name), run.unavailable);
      const root = await harness.root(context, { agent: {
        model: run.model, thinkingLevel: run.thinking,
        tools: workTools, cwd: run.cwd,
        instructions,
      } });
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
            run.usage = modelUsage(ledger.models);
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
    options.onUpdate?.({ ...run, ...(run.activityLog ? { activityLog: run.activityLog.map((call) => ({ ...call })) } : {}) });
    return run;
  }
  async cancel(id: string): Promise<void> {
    const active = this.active.get(id);
    if (active) { active.stop("cancelled"); await active.done; return; }
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
    const groups = [...this.groups.values()];
    const active = [...this.active.values()];
    active.forEach((run) => run.stop());
    groups.forEach(group => group.controller.abort("shutdown"));
    await Promise.allSettled(active.map((run) => run.done));
    await Promise.allSettled(groups.map(group => group.done));
  }
}
