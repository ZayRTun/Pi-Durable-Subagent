import type { Usage } from "@earendil-works/pi-ai";
import type { Run } from "./runtime.ts";

/** Sum the delivered spend of several runs, so a multi-step call reports one usage figure. */
export function usageForRuns(runs: readonly Run[], entries: readonly { type: string; message?: unknown }[]): Usage | undefined {
  const parts = runs.map((run) => usageToReport(run, entries)).filter((usage): usage is Usage => Boolean(usage));
  if (!parts.length) return undefined;
  return parts.reduce((total, usage) => ({
    input: total.input + usage.input, output: total.output + usage.output,
    cacheRead: total.cacheRead + usage.cacheRead, cacheWrite: total.cacheWrite + usage.cacheWrite,
    totalTokens: total.totalTokens + usage.totalTokens,
    cost: { input: total.cost.input + usage.cost.input, output: total.cost.output + usage.cost.output,
      cacheRead: total.cost.cacheRead + usage.cost.cacheRead, cacheWrite: total.cost.cacheWrite + usage.cost.cacheWrite,
      total: total.cost.total + usage.cost.total },
  }));
}

/** Account against delivered results on the active Pi branch, not merely cached metadata. */
export function usageToReport(run: Run, entries: readonly { type: string; message?: unknown }[]): Usage | undefined {
  if (!run.usage) return undefined;
  let accounted: Usage | undefined;
  const account = (usage: Usage | undefined) => {
    if (!usage) return;
    if (!accounted) { accounted = usage; return; }
    // Retained notifications/results may arrive in a different order from recovery.
    // A historical cumulative snapshot must never lower an already reported baseline.
    const max = Math.max;
    accounted = { input: max(accounted.input, usage.input), output: max(accounted.output, usage.output),
      cacheRead: max(accounted.cacheRead, usage.cacheRead), cacheWrite: max(accounted.cacheWrite, usage.cacheWrite),
      totalTokens: max(accounted.totalTokens, usage.totalTokens),
      cost: { input: max(accounted.cost.input, usage.cost.input), output: max(accounted.cost.output, usage.cost.output),
        cacheRead: max(accounted.cost.cacheRead, usage.cost.cacheRead), cacheWrite: max(accounted.cost.cacheWrite, usage.cost.cacheWrite),
        total: max(accounted.cost.total, usage.cost.total) } };
  };
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: string; toolName?: string; details?: { id?: string; usage?: Usage; steps?: { id?: string; usage?: Usage }[] } } | undefined;
    if (message?.role === "toolResult" && ["subagent", "subagent_status", "subagent_wait", "subagent_cancel", "subagent_steer"].includes(message.toolName ?? "")) {
      const delivered = message.details?.id === run.id ? message.details : message.details?.steps?.find((step) => step.id === run.id);
      account(delivered?.usage);
    }
  }
  const delta = (a: number, b = 0) => Math.max(0, a - b);
  const usage: Usage = {
    input: delta(run.usage.input, accounted?.input), output: delta(run.usage.output, accounted?.output),
    cacheRead: delta(run.usage.cacheRead, accounted?.cacheRead), cacheWrite: delta(run.usage.cacheWrite, accounted?.cacheWrite),
    totalTokens: delta(run.usage.totalTokens, accounted?.totalTokens),
    cost: { input: delta(run.usage.cost.input, accounted?.cost.input), output: delta(run.usage.cost.output, accounted?.cost.output),
      cacheRead: delta(run.usage.cost.cacheRead, accounted?.cost.cacheRead), cacheWrite: delta(run.usage.cost.cacheWrite, accounted?.cost.cacheWrite),
      total: delta(run.usage.cost.total, accounted?.cost.total) },
  };
  return usage.totalTokens || usage.cost.total ? usage : undefined;
}
