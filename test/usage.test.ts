import assert from "node:assert/strict";
import { test } from "node:test";
import { usageToReport } from "../usage.ts";
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
