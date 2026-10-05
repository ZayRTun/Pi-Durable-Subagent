import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { runMetadata } from "../index.ts";
import { formatCost } from "../cost.ts";
import { clean, renderRun } from "../ui.ts";
import type { Run } from "../runtime.ts";

function costUsage(total: number): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } };
}

function sample(cost?: number): Run {
  return { version: 1, id: "a".repeat(32), sessionId: "test", agent: { name: "scout", description: "Inspect", tools: [], instructions: "Inspect", timeoutMinutes: 30 },
    task: "Inspect files", cwd: "/work/repo", model: { provider: "test", modelId: "test" }, thinking: "off",
    status: "succeeded", activity: "Activity", output: "Final response.", unavailable: [], createdAt: 0, updatedAt: 0,
    ...(cost === undefined ? {} : { usage: costUsage(cost) }) };
}

// Real observed child costs that the four-decimal rendering collapsed or nearly collapsed to zero.
const TINY_COSTS = [[0.000023778, "<$0.0001"], [0.000066378, "~$0.0001"]] as const;

test("the shared cost formatter is pure and keeps normal amounts unchanged", () => {
  assert.equal(formatCost(0.0012), "~$0.0012");
  assert.equal(formatCost(0.000557316), "~$0.0006");
  assert.equal(formatCost(0.000066378), "~$0.0001");
  assert.equal(formatCost(0.000023778), "<$0.0001");
  assert.equal(formatCost(0), "", "a zero cost renders no reading");
  assert.equal(formatCost(-1), "", "a negative cost renders no reading");
});

test("model-facing metadata never renders a positive cost as $0.0000", () => {
  for (const [cost, expected] of TINY_COSTS) {
    const metadata = runMetadata(sample(cost), { retrieved: false });
    assert.ok(metadata.includes(expected), `metadata must display ${expected}: ${metadata}`);
    assert.doesNotMatch(metadata, /\$0\.0000/, `metadata collapsed ${cost} to zero: ${metadata}`);
  }
});

test("the compact TUI never renders a positive cost as $0.0000", () => {
  initTheme("dark", false);
  for (const [cost, expected] of TINY_COSTS) {
    const text = clean(renderRun(sample(cost), false, theme).render(120).join("\n"));
    assert.ok(text.includes(expected), `TUI must display ${expected}: ${text}`);
    assert.doesNotMatch(text, /\$0\.0000/, `TUI collapsed ${cost} to zero: ${text}`);
  }
});

test("a cost below four-decimal resolution is reported as an honest upper bound", () => {
  const metadata = runMetadata(sample(0.000023778), { retrieved: false });
  assert.match(metadata, /<\$0\.0001/, metadata);
  initTheme("dark", false);
  const text = clean(renderRun(sample(0.000023778), false, theme).render(120).join("\n"));
  assert.match(text, /<\$0\.0001/, text);
});

test("normal amounts keep their existing four-decimal rendering", () => {
  initTheme("dark", false);
  const metadata = runMetadata(sample(0.0012), { retrieved: false });
  assert.match(metadata, /~\$0\.0012/, metadata);
  const text = clean(renderRun(sample(0.0012), false, theme).render(120).join("\n"));
  assert.match(text, /~\$0\.0012/, text);
});

test("a run with no recorded cost shows no cost reading at all", () => {
  initTheme("dark", false);
  for (const cost of [undefined, 0, -1]) {
    const metadata = runMetadata(sample(cost), { retrieved: false });
    assert.doesNotMatch(metadata, /\$/, metadata);
    assert.match(metadata, /no model usage/);
    const text = clean(renderRun(sample(cost), false, theme).render(120).join("\n"));
    assert.doesNotMatch(text, /\$/, text);
  }
});
