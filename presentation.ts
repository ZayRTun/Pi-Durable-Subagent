import { formatCost } from "./cost.ts";

/**
 * The names the Durable TUI uses for a delegation. `single` is one run with no group header;
 * the others describe how the requested steps relate to each other, which the UI must not infer
 * from the tasks alone: `ordered` runs one at a time without a result handoff, `chain` hands each
 * answer to the next step, and `parallel` runs concurrent steps in isolated checkouts.
 */
export type DelegationMode = "single" | "ordered" | "chain" | "parallel";

/**
 * `pending` is requested but not started, `run` is executing or finished, and `not-run` is a
 * requested step that will not start because execution aborted first.
 */
export type EntryPhase = "pending" | "run" | "not-run";

/** One requested step in requested order. `requestedTask` is the original task, never a chained rewrite. */
export interface DelegationEntry {
  runId: string;
  agent: string;
  color?: string;
  requestedTask: string;
  phase: EntryPhase;
}

/**
 * Optional metadata added to the existing `{ steps: Run[] }` details. Model-facing content and usage
 * are unchanged; this only lets the UI show every requested entry, including ones with no run yet.
 */
export interface DelegationPresentation {
  mode: DelegationMode;
  entries: DelegationEntry[];
}

export const MODE_LABELS: Record<DelegationMode, string> = { single: "Single", ordered: "Ordered", chain: "Chain", parallel: "Parallel" };

/** Finite statuses that count toward "done": a returned failure or cancellation still finished. */
const DONE = new Set(["succeeded", "failed", "aborted"]);

export interface GroupFacts {
  done: number;
  total: number;
  failed: number;
  cancelled: number;
  interrupted: number;
  cost: number;
}

/**
 * Counts over the requested entries, using the run attached to each when it exists. "done" is
 * succeeded, failed, and aborted only, so running, pending, not-run, and interrupted stay out.
 * The cost is the sum of the children's recorded cost, never an extra charge.
 */
export function groupFacts(entries: readonly { runId: string }[], runs: readonly { id: string; status: string; usage?: { cost: { total: number } } }[]): GroupFacts {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const facts: GroupFacts = { done: 0, total: entries.length, failed: 0, cancelled: 0, interrupted: 0, cost: 0 };
  for (const entry of entries) {
    const run = byId.get(entry.runId);
    if (!run) continue;
    if (DONE.has(run.status)) facts.done++;
    if (run.status === "failed") facts.failed++;
    if (run.status === "aborted") facts.cancelled++;
    if (run.status === "interrupted") facts.interrupted++;
    facts.cost += run.usage?.cost.total ?? 0;
  }
  return facts;
}

/** The heading readings in requested order: mode, progress, any failure flags, then the summed cost. */
export function groupHeading(mode: DelegationMode, facts: GroupFacts): string {
  const readings = [`Delegation`, MODE_LABELS[mode], `${facts.done}/${facts.total} done`];
  if (facts.failed) readings.push(`${facts.failed} failed`);
  if (facts.cancelled) readings.push(`${facts.cancelled} cancelled`);
  if (facts.interrupted) readings.push(`${facts.interrupted} interrupted`);
  const cost = formatCost(facts.cost);
  if (cost) readings.push(cost);
  return readings.join(" · ");
}
