import assert from "node:assert/strict";
import { test } from "node:test";
import { sumUsage, usageToReport } from "../usage.ts";
import type { Run } from "../runtime.ts";
import type { Usage } from "@earendil-works/pi-ai";
const usage = (tokens: number): Usage => ({ input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens,
  cost: { input: tokens / 1000, output: 0, cacheRead: 0, cacheWrite: 0, total: tokens / 1000 } });
const run = { id: "run", usage: usage(20) } as Run;
const entry = (tokens: number) => ({ type: "message", message: { role: "toolResult", toolName: "subagent", details: { id: "run", usage: usage(tokens) } } });

test("cached but undelivered results still report their spend", () => {
  assert.deepEqual(usageToReport(run, []), usage(20));
});
test("retrieval does not count delivered usage twice", () => {
  assert.equal(usageToReport(run, [entry(20)]), undefined);
});
test("resume reports only additional model usage on the active branch", () => {
  assert.deepEqual(usageToReport(run, [entry(5), entry(10)]), usage(10));
});
test("usage totals sum every token and nested cost field and default an empty model set to zero", () => {
  const detailed = (n: number): Usage => ({ input: n, output: n + 1, cacheRead: n + 2, cacheWrite: n + 3,
    totalTokens: 4 * n + 6, cost: { input: n / 8, output: (n + 1) / 8, cacheRead: (n + 2) / 8, cacheWrite: (n + 3) / 8, total: (4 * n + 6) / 8 } });
  assert.deepEqual(sumUsage([detailed(1), detailed(2)]), { input: 3, output: 5, cacheRead: 7, cacheWrite: 9, totalTokens: 24,
    cost: { input: 0.375, output: 0.625, cacheRead: 0.875, cacheWrite: 1.125, total: 3 } });
  assert.deepEqual(sumUsage([]), usage(0));
});
