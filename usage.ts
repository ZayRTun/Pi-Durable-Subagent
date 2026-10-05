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
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: string; toolName?: string; details?: { id?: string; usage?: Usage; steps?: { id?: string; usage?: Usage }[] } } | undefined;
    if (message?.role === "toolResult" && message.toolName === "subagent") {
      const delivered = message.details?.id === run.id ? message.details : message.details?.steps?.find((step) => step.id === run.id);
      accounted = delivered?.usage ?? accounted;
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
