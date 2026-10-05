export interface ModelRef {
  provider: string;
  modelId: string;
}

export interface DelegationStep {
  agent: string;
  task: string;
  /** Parent execution policy, distinct from any future supervision wait. null means no deadline. */
  timeoutMinutes?: number | null;
  model?: ModelRef;
  pool?: string;
  /** Ask for the caller's own model explicitly, which some playbooks spell `inherit-parent` or `auto`. */
  inherit?: boolean;
}

export type DelegationRequest =
  | { kind: "resume"; runId: string }
  | { kind: "delegate"; steps: DelegationStep[]; mode: "steps" | "chain"; worktree?: { branch?: string; base?: string } };

const RUN_ID = /^[a-f0-9]{32}$/;
const ACCEPTED = ["agent", "task", "tasks", "chain", "model", "role", "worktree", "cloud_base_branch", "resume", "timeoutMinutes"];
const STEP_KEYS = ["agent", "task", "model", "role", "timeoutMinutes"];
const INHERIT = new Set(["inherit-parent", "auto"]);
export const MAX_STEPS = 8;

export function parseModelRef(value: unknown): ModelRef {
  if (typeof value !== "string") throw new Error("model must be a provider/model-id string");
  const split = value.indexOf("/");
  const provider = split > 0 ? value.slice(0, split).trim() : "";
  const modelId = split > 0 ? value.slice(split + 1).trim() : "";
  if (!provider || !modelId) throw new Error("model must be provider/model-id with nonempty parts");
  return { provider, modelId };
}

interface Selection {
  timeoutMinutes?: number | null;
  agent?: string;
  model?: ModelRef;
  pool?: string;
  inherit?: boolean;
}

function parseSelection(source: Record<string, unknown>, prefix: string): Selection {
  const selection: Selection = {};
  if (source.timeoutMinutes !== undefined) {
    const value = source.timeoutMinutes;
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 480)) {
      throw new Error(`${prefix}timeoutMinutes must be null (no deadline) or a number between 1 and 480`);
    }
    selection.timeoutMinutes = value as number | null;
  }
  if (source.agent !== undefined) {
    if (typeof source.agent !== "string" || !source.agent.trim()) throw new Error(`${prefix}agent must be a nonempty name`);
    selection.agent = source.agent.trim();
  }
  if (source.role !== undefined) {
    if (typeof source.role !== "string" || !source.role.trim()) throw new Error(`${prefix}role must be a nonempty pool name`);
    selection.pool = source.role.trim();
  }
  if (typeof source.model === "string" && source.model.startsWith("task:")) {
    if (selection.pool) throw new Error(`${prefix}specify either role or model: task:<pool>, not both`);
    const name = source.model.slice("task:".length).trim();
    if (!name) throw new Error(`${prefix}model: task:<pool> requires a pool name`);
    selection.pool = name;
  } else if (source.model !== undefined) {
    if (typeof source.model === "string" && INHERIT.has(source.model.trim())) selection.inherit = true;
    else selection.model = parseModelRef(source.model);
  }
  return selection;
}

function parseTask(source: Record<string, unknown>, prefix: string): string {
  if (typeof source.task !== "string" || !source.task.trim()) throw new Error(`${prefix}requires a nonempty task`);
  return source.task;
}

function parseSteps(raw: unknown, defaults: Selection, label: string): DelegationStep[] {
  if (!Array.isArray(raw)) throw new Error(`${label} must be an array of steps`);
  if (!raw.length) throw new Error(`${label} must contain at least one step`);
  if (raw.length > MAX_STEPS) throw new Error(`${label} accepts at most ${MAX_STEPS} steps`);
  return raw.map((entry, index) => {
    const prefix = `${label}[${index}]: `;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${prefix}expected an object with at least a task`);
    const source = entry as Record<string, unknown>;
    for (const key of Object.keys(source)) {
      if (!STEP_KEYS.includes(key)) throw new Error(`${prefix}unknown parameter ${key}. Accepted: ${STEP_KEYS.join(", ")}`);
    }
    const selection = parseSelection(source, prefix);
    const agent = selection.agent ?? defaults.agent;
    if (!agent) throw new Error(`${prefix}requires agent, and the call did not give a default agent`);
    const model = selection.model ?? defaults.model;
    const pool = selection.pool ?? defaults.pool;
    const inherit = selection.inherit ?? defaults.inherit;
    const timeoutMinutes = selection.timeoutMinutes !== undefined ? selection.timeoutMinutes : defaults.timeoutMinutes;
    return { agent, task: parseTask(source, prefix), ...(timeoutMinutes !== undefined ? { timeoutMinutes } : {}), ...(model ? { model } : {}), ...(pool ? { pool } : {}), ...(inherit ? { inherit } : {}) };
  });
}

function parseWorktree(args: Record<string, unknown>): { branch?: string; base?: string } | undefined {
  const declared = parseWorktreeValue(args.worktree);
  if (declared) return declared;
  if (args.cloud_base_branch === undefined) return undefined;
  const base = args.cloud_base_branch;
  if (typeof base !== "string" || !base.trim()) throw new Error("cloud_base_branch must be a nonempty branch or commit");
  return { base: base.trim() };
}

/** Worktree isolation is opt-in and per call, so nothing here creates a checkout the caller did not ask for. */
function parseWorktreeValue(value: unknown): { branch?: string; base?: string } | undefined {
  if (value === undefined || value === false) return undefined;
  if (value === true) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("worktree must be true or an object with branch and base");
  const source = value as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (key !== "branch" && key !== "base") throw new Error(`worktree has unknown parameter ${key}. Accepted: branch, base`);
  }
  const worktree: { branch?: string; base?: string } = {};
  for (const key of ["branch", "base"] as const) {
    const entry = source[key];
    if (entry === undefined) continue;
    if (typeof entry !== "string" || !entry.trim()) throw new Error(`worktree ${key} must be a nonempty string`);
    worktree[key] = entry.trim();
  }
  return worktree;
}

/**
 * Parse tool arguments into a delegation request at the boundary. An unrecognized parameter is an
 * error rather than an ignored key, so a caller that asks for a capability we lack learns that
 * instead of receiving a successful run that quietly dropped its instruction.
 */
export function parseDelegationRequest(args: Record<string, unknown>): DelegationRequest {
  for (const key of Object.keys(args)) {
    if (!ACCEPTED.includes(key)) throw new Error(`Unknown parameter ${key}. Accepted: ${ACCEPTED.join(", ")}`);
  }
  if (args.resume !== undefined) {
    if (typeof args.resume !== "string" || !RUN_ID.test(args.resume)) throw new Error("resume must be a 32-character run ID");
    for (const key of ACCEPTED) {
      if (key !== "resume" && args[key] !== undefined) throw new Error(`resume cannot be combined with ${key}`);
    }
    return { kind: "resume", runId: args.resume };
  }
  const defaults = parseSelection(args, "");
  const worktree = parseWorktree(args);
  if (args.chain !== undefined) {
    for (const key of ["task", "tasks"]) {
      if (args[key] !== undefined) throw new Error(`Specify either ${key} or chain, not both`);
    }
    if (worktree) throw new Error("chain runs its steps in order in the caller's directory; worktree isolation would hide one step's changes from the next");
    return { kind: "delegate", steps: parseSteps(args.chain, defaults, "chain"), mode: "chain" };
  }
  if (args.tasks !== undefined) {
    if (args.task !== undefined) throw new Error("Specify either task or tasks, not both");
    return { kind: "delegate", steps: parseSteps(args.tasks, defaults, "tasks"), mode: "steps", ...(worktree ? { worktree } : {}) };
  }
  if (!defaults.agent || typeof args.task !== "string" || !args.task.trim()) throw new Error("A new delegation requires agent and task");
  const step: DelegationStep = { agent: defaults.agent, task: args.task,
    ...(defaults.timeoutMinutes !== undefined ? { timeoutMinutes: defaults.timeoutMinutes } : {}),
    ...(defaults.model ? { model: defaults.model } : {}), ...(defaults.pool ? { pool: defaults.pool } : {}), ...(defaults.inherit ? { inherit: true } : {}) };
  return { kind: "delegate", steps: [step], mode: "steps", ...(worktree ? { worktree } : {}) };
}
