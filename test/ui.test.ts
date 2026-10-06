import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { Box, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { clean, clipAnsi, preview, renderGroup, renderRun } from "../ui.ts";
import type { DelegationPresentation } from "../presentation.ts";
import type { Run } from "../runtime.ts";

function run(name: string, status: Run["status"], extra: Partial<Run> = {}): Run {
  return { version: 1, id: `${name}-${status}`.padEnd(32, "0").slice(0, 32), sessionId: "test",
    agent: { name, description: "Inspect", tools: [], instructions: "Inspect", timeoutMinutes: 30 },
    task: "Inspect files", cwd: "/work/repo", model: { provider: "test", modelId: "test" }, thinking: "low",
    status, activity: "Activity", output: "Final response.", unavailable: [], createdAt: 0, updatedAt: 0, ...extra };
}

test("collapsed single runs name every state rather than requiring an icon legend", () => {
  initTheme("dark", false);
  const labels: Record<Run["status"], string> = { running: "Running", succeeded: "Done", failed: "Failed", aborted: "Cancelled", interrupted: "Interrupted", paused: "Paused", pausing: "Pausing", "preparing-handoff": "Preparing handoff" };
  for (const status of ["running", "succeeded", "failed", "aborted", "interrupted", "paused", "pausing", "preparing-handoff"] as const) {
    const text = clean(renderRun(run("scout", status), false, theme).render(100).join("\n"));
    assert.match(text, new RegExp(`\\b${labels[status]}\\b`), text);
  }
});

test("a collapsed single run is the approved two-line base", () => {
  initTheme("dark", false);
  const text = renderRun(run("worker", "running", { task: "Implement ONLY Durable generic optional Agent-definitions", elapsedMs: 259100, toolCount: 12,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 117800, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0123 } } }), false, theme, { now: 1000 }).render(120).map(clean);
  assert.deepEqual(text, [
    " ⠹ worker (Implement ONLY Durable generic optional Agent-def…)",
    "    ⎿ Running (test · low · 12 tool uses · 117.8k tokens · ~$0.0123 · 4m 19.1s)",
  ]);
});

test("the requested order and tree prefixes are the approved group geometry", () => {
  initTheme("dark", false);
  const scout = run("scout", "succeeded", { task: "Find the retry implementation.", elapsedMs: 4300, toolCount: 2, output: "Found it.",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1200, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0012 } } });
  const worker = run("worker", "running", { task: "Implement the policy using the findings.", elapsedMs: 2000, toolCount: 1,
    activityLog: [{ callId: "a", name: "bash", status: "running", summary: "npm test -- retry-policy" }],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 500, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const presentation: DelegationPresentation = { mode: "ordered", entries: [
    { runId: scout.id, agent: "scout", requestedTask: "Find the retry implementation.", phase: "run" },
    { runId: worker.id, agent: "worker", requestedTask: "Implement the policy using the findings.", phase: "run" },
    { runId: "pending-reviewer".padEnd(32, "0").slice(0, 32), agent: "reviewer", requestedTask: "Review the retry policy.", phase: "pending" },
  ] };
  const text = renderGroup(presentation, [scout, worker], false, theme, { now: 1000 }).render(120).map(clean);
  assert.deepEqual(text, [
    " Delegation · Ordered · 1/3 done · ~$0.0012",
    "  ├ ✓ scout (Find the retry implementation.)",
    "  │    ⎿ Done (test · low · 2 tool uses · 1.2k tokens · ~$0.0012 · 4.3s)",
    "  │",
    "  ├ ⠹ worker (Implement the policy using the findings.)",
    "  │    ⎿ Running (test · low · 1 tool use · 500 tokens · 2.0s)",
    "  │",
    "  └ ○ reviewer (Review the retry policy.)",
    "       ⎿ Pending",
  ]);
});

test("chain and parallel keep their distinct heading and requested order", () => {
  initTheme("dark", false);
  for (const mode of ["chain", "parallel"] as const) {
    const first = run("scout", "succeeded", { task: "Locate the code." });
    const second = run("worker", "failed", { task: "Change the code.", error: "Tests failed." });
    const presentation: DelegationPresentation = { mode, entries: [
      { runId: first.id, agent: "scout", requestedTask: "Locate the code.", phase: "run" },
      { runId: second.id, agent: "worker", requestedTask: "Change the code.", phase: "run" },
    ] };
    const text = renderGroup(presentation, [first, second], false, theme, { now: 1000 }).render(120).map(clean);
    assert.equal(text[0], mode === "chain" ? " Delegation · Chain · 2/2 done · 1 failed" : " Delegation · Parallel · 2/2 done · 1 failed");
    assert.match(text[1], /^  ├ /);
    assert.match(text[text.length - 1], /^       ⎿ /);
  }
});

test("not-run steps are shown as not run rather than a queue that never moves", () => {
  initTheme("dark", false);
  const first = run("scout", "succeeded", { task: "Locate the code." });
  const notRunId = "never-started".padEnd(32, "0").slice(0, 32);
  const presentation: DelegationPresentation = { mode: "chain", entries: [
    { runId: first.id, agent: "scout", requestedTask: "Locate the code.", phase: "run" },
    { runId: notRunId, agent: "worker", requestedTask: "Change the code.", phase: "not-run" },
  ] };
  const text = clean(renderGroup(presentation, [first], false, theme, { now: 1000 }).render(120).join("\n"));
  assert.match(text, /└ ○ worker \(Change the code\.\)/);
  assert.match(text, /Not run/);
});

test("the group cost is the sum of the children, never an added charge", () => {
  initTheme("dark", false);
  const a = run("scout", "succeeded", { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } } });
  const b = run("worker", "succeeded", { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.002 } } });
  const presentation: DelegationPresentation = { mode: "ordered", entries: [
    { runId: a.id, agent: "scout", requestedTask: "a", phase: "run" },
    { runId: b.id, agent: "worker", requestedTask: "b", phase: "run" },
  ] };
  const heading = clean(renderGroup(presentation, [a, b], false, theme, { now: 0 }).render(120)[0]);
  assert.match(heading, /2\/2 done · ~\$0\.0030$/);
});

test("narrow metrics drop tokens first, then the tool count, and never overflow", () => {
  initTheme("dark", false);
  const wide = run("worker", "succeeded", { elapsedMs: 1000, toolCount: 12,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 117800, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0123 } } });
  const at = (width: number) => clean(renderRun(wide, false, theme).render(width).join("\n"));
  assert.match(at(120), /117\.8k tokens · ~\$0\.0123/);
  const medium = at(60);
  assert.doesNotMatch(medium, /117\.8k tokens/, medium);
  assert.match(medium, /12 tool uses · ~\$0\.0123 · 1\.0s/, medium);
  const narrow = at(45);
  assert.doesNotMatch(narrow, /tool uses/, narrow);
  assert.match(narrow, /~\$0\.0123 · 1\.0s/, narrow);
});

test("real visible columns are respected for wide, combining, and emoji text", () => {
  initTheme("dark", false);
  const tricky = run("worker", "succeeded", { task: "Inspect 広い combining e\u0301 and 👩‍👩‍👧‍👦 emoji ".repeat(6), output: "## 見出し\n\n- 項目 e\u0301 👩‍👩‍👧‍👦 ".repeat(10) });
  const presentation: DelegationPresentation = { mode: "ordered", entries: [
    { runId: tricky.id, agent: "worker", requestedTask: tricky.task, phase: "run" },
  ] };
  for (const width of [12, 24, 80, 120]) {
    for (const component of [renderRun(tricky, true, theme), renderRun(tricky, false, theme), renderGroup(presentation, [tricky], true, theme, { now: 0 })]) {
      for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `overflow at ${width}: ${visibleWidth(line)}`);
    }
  }
});

test("expanded running shows the current tool and at most three finished calls, newest first", () => {
  initTheme("dark", false);
  const activityLog = [
    { callId: "1", name: "read", status: "done", summary: "src/a.ts" },
    { callId: "2", name: "edit", status: "done", summary: "src/b.ts" },
    { callId: "3", name: "water", status: "done" },
    { callId: "4", name: "grep", status: "done", summary: "retry" },
    { callId: "5", name: "bash", status: "running", summary: "npm test" },
  ];
  const text = clean(renderRun(run("worker", "running", { task: "Fix it", activityLog }), true, theme, { now: 1000 }).render(120).join("\n"));
  assert.match(text, /Current tool[\s\S]*bash · npm test/);
  const recent = text.split("Recent activity")[1]!;
  assert.ok(!recent.includes("npm test"), "the running call must not appear as recent");
  assert.match(recent, /grep · retry/);
  assert.ok(recent.indexOf("grep") < recent.indexOf("edit"), "newest finished call comes first");
  assert.equal((recent.match(/✓|■|⚠/g) ?? []).length, 3, "exactly three finished calls");
});

test("a running run with no tool says it is waiting for the model instead of inventing one", () => {
  initTheme("dark", false);
  const text = clean(renderRun(run("worker", "running", { task: "Fix it", activity: "Waiting for model" }), true, theme, { now: 0 }).render(120).join("\n"));
  assert.match(text, /Current tool[\s\S]*Waiting for model/);
});

test("a completed expanded run renders its response without run IDs, cwd, or records", () => {
  initTheme("dark", false);
  const output = "## Changes\n\n- Added a retry limit to the client.\n- Preserved the original error on exhaustion.";
  const text = clean(renderRun(run("worker", "succeeded", { task: "Add retry", output }), true, theme, { now: 0 }).render(120).join("\n"));
  assert.match(text, /Task[\s\S]*Add retry/);
  assert.match(text, /Response[\s\S]*Changes[\s\S]*Added a retry limit/);
  assert.doesNotMatch(text, /\/work\/repo|run\.json|sessionId|record/);
});

test("uncertainty and interruption add compact warnings; a missing tool list does not", () => {
  initTheme("dark", false);
  const uncertain = run("worker", "failed", { task: "Migrate", error: "migration failed", unavailable: ["web_search"],
    activityLog: [{ callId: "x", name: "bash", status: "done", uncertain: true }] });
  const text = clean(renderRun(uncertain, false, theme).render(120).join("\n"));
  assert.match(text, /A tool's outcome is unknown/);
  assert.doesNotMatch(text, /unavailable/i);
  const interrupted = clean(renderRun(run("worker", "interrupted"), true, theme).render(120).join("\n"));
  assert.match(interrupted, /Stopped before completion/);
});

test("the running icon uses the braille clock while active and a static frame otherwise", () => {
  initTheme("dark", false);
  const frames = new Set<string>();
  for (const now of [0, 120, 240, 360]) frames.add(clean(renderRun(run("worker", "running"), false, theme, { active: true, now }).render(80)[0]).match(/^ (\S+)/)![1]);
  assert.ok(frames.has("⠋") && frames.has("⠙") && frames.has("⠹") && frames.has("⠸"), [...frames].join(" "));
  assert.match(clean(renderRun(run("worker", "running"), false, theme).render(80)[0]), /^ ⠹ /);
});

test("rendering a tool result creates no timers", async () => {
  initTheme("dark", false);
  const loader = new DefaultResourceLoader({ cwd: fileURLToPath(new URL("../", import.meta.url)), agentDir: fileURLToPath(new URL("../", import.meta.url)), settingsManager: SettingsManager.inMemory(), noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url))] });
  await loader.reload();
  const tool = loader.getExtensions().extensions.flatMap(extension => [...extension.tools.values()]).find(tool => tool.definition.name === "subagent")!;
  const original = globalThis.setInterval;
  let created = 0;
  globalThis.setInterval = ((...args: Parameters<typeof original>) => { created++; return original(...args); }) as typeof original;
  try {
    const context = { args: {}, toolCallId: "row", invalidate: () => {}, lastComponent: undefined, state: {}, cwd: process.cwd(), executionStarted: true, argsComplete: true, isPartial: true, expanded: false, showImages: false, isError: false };
    tool.definition.renderResult!({ content: [{ type: "text", text: "body" }], details: run("worker", "running") }, { expanded: false, isPartial: true }, theme, context as never).render(80);
  } finally {
    globalThis.setInterval = original;
  }
  assert.equal(created, 0, "no timer may be created during rendering");
});

test("normal tool errors with generic details retain their message instead of crashing the renderer", async () => {
  initTheme("dark", false);
  const loader = new DefaultResourceLoader({ cwd: fileURLToPath(new URL("../", import.meta.url)), agentDir: fileURLToPath(new URL("../", import.meta.url)), settingsManager: SettingsManager.inMemory(), noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url))] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const tool = loader.getExtensions().extensions.flatMap(extension => [...extension.tools.values()]).find(tool => tool.definition.name === "subagent")!;
  const context = { args: {}, toolCallId: "error-row", invalidate: () => {}, lastComponent: undefined, state: {}, cwd: process.cwd(), executionStarted: false, argsComplete: false, isPartial: false, expanded: false, showImages: false, isError: false };
  const callArgs = [
    {},
    { agent: "scout" },
    { task: "Inspect" },
    { tasks: [{}] },
    { chain: [{}] },
    { agent: "scout", task: "Inspect files" },
    { tasks: [{ agent: "scout", task: "Inspect files" }] },
    { tasks: [{ agent: "scout", task: "Inspect files" }], worktree: true },
    { chain: [{ agent: "scout", task: "Inspect files" }] },
    { resume: "a".repeat(32) },
  ];
  for (const args of callArgs) {
    for (const argsComplete of [false, true]) {
      assert.deepEqual(tool.definition.renderCall!(args, theme, { ...context, args, argsComplete }).render(80), []);
    }
  }
  const component = tool.definition.renderResult!({ content: [{ type: "text", text: "Explicit resume approval required." }], details: {} }, { expanded: false, isPartial: false }, theme, { ...context, executionStarted: true, argsComplete: true, isError: true });
  assert.match(clean(component.render(80).join("\n")), /Explicit resume approval required/);
  assert.ok(loader.getExtensions().extensions.some(extension => extension.entryRenderers?.has("durable-subagent-result")));
});

test("previews remove terminal controls and remain bounded", () => {
  assert.equal(clean("\x1b[31mhello\x1b[0m\x00"), "hello");
  assert.equal(preview("a\n b"), "a b");
  assert.ok(preview("x".repeat(500)).length <= 140);
});

/**
 * Repro and fix for the reported dark patches at truncation markers. The native `truncateToWidth`
 * inserts a bare `\x1b[0m` before its ellipsis, clearing the tool-result background the enclosing
 * Box applied to the whole line. `clipAnsi` slices without a reset, so the ellipsis keeps the row's
 * background. Both run through a real native Box.
 */
test("clipped lines keep the tool-result background that truncateToWidth clears", () => {
  const bg = (text: string) => `\x1b[48;2;20;20;20m${text}\x1b[49m`;
  const box = (line: string) => {
    const container = new Box(0, 0, bg);
    container.addChild({ render: () => [line], invalidate() {} } as Component);
    return container.render(20)[0]!;
  };
  const long = "\x1b[38;2;1;2;3m" + "x".repeat(60) + "\x1b[39m";
  const broken = box(truncateToWidth(long, 20, "…"));
  const resetAt = broken.indexOf("\x1b[0m");
  const ellipsisAt = broken.indexOf("…");
  assert.ok(resetAt >= 0 && resetAt < ellipsisAt, "native truncation inserts a reset before the ellipsis");
  assert.ok(!broken.slice(resetAt, ellipsisAt).includes("\x1b[48"), "background is not restored after the reset");
  const fixed = box(clipAnsi(long, 20));
  assert.ok(fixed.includes("…"));
  assert.ok(!fixed.slice(0, fixed.indexOf("…")).includes("\x1b[0m"), "clipAnsi keeps the background active through the ellipsis");
});

test("group rows composed inside a native Box stay in width and keep the background, in both themes", () => {
  const bg = (text: string) => `\x1b[48;2;20;20;20m${text}\x1b[49m`;
  for (const name of ["dark", "light"] as const) {
    initTheme(name, false);
    const first = run("scout", "succeeded", { task: "Find the retry implementation.", output: "Done." });
    const second = run("worker", "running", { task: "Implement the policy for 広い and 👩‍👩‍👧‍👦 characters.", activityLog: [{ callId: "5", name: "bash", status: "running", summary: "npm test" }, { callId: "4", name: "edit", status: "done", summary: "src/retry.ts" }] });
    const presentation: DelegationPresentation = { mode: "chain", entries: [
      { runId: first.id, agent: "scout", requestedTask: "Find the retry implementation.", phase: "run" },
      { runId: second.id, agent: "worker", requestedTask: second.task, phase: "run" },
    ] };
    for (const width of [80, 120]) {
      const box = new Box(1, 1, bg);
      box.addChild(renderGroup(presentation, [first, second], true, theme, { active: true, now: 120 }));
      for (const line of box.render(width)) {
        assert.ok(visibleWidth(line) <= width, `${name} ${width}: ${visibleWidth(line)}`);
        assert.ok(!line.includes("\x1b[0m"), `a native Box line must not clear its own background: ${JSON.stringify(line)}`);
      }
    }
  }
});

test("authoritative live nonblocking results belong only to sticky, across tool surfaces", async (t) => {
  initTheme("dark", false);
  const loader = new DefaultResourceLoader({ cwd: fileURLToPath(new URL("../", import.meta.url)), agentDir: fileURLToPath(new URL("../", import.meta.url)), settingsManager: SettingsManager.inMemory(), noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url))] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const tools = loader.getExtensions().extensions.flatMap(extension => [...extension.tools.values()]);
  for (const name of ["subagent", "subagent_status", "subagent_wait", "subagent_cancel", "subagent_followup"]) {
    const tool = tools.find(tool => tool.definition.name === name)!;
    const context = { args: {}, toolCallId: name, invalidate: () => {}, lastComponent: undefined, state: {}, cwd: process.cwd(), executionStarted: true, argsComplete: true, isPartial: false, expanded: false, showImages: false, isError: false };
    const render = (details: unknown, isError = false) => clean(tool.definition.renderResult!({ content: [{ type: "text", text: "Visible result or error" }], details }, { expanded: false, isPartial: false }, theme, { ...context, isError } as never).render(100).join("\n"));
    const visibleSingle = name === "subagent" || name === "subagent_followup" ? /worker \(Inspect files\)/ : /Visible result or error/;
    await t.test(`${name} single results`, () => {
      for (const status of ["running", "pausing", "preparing-handoff", "paused"] as const) {
        const live = run("worker", status, { nonblocking: true });
        assert.equal(render(live), "", `${name} ${status}`);
        assert.match(render({ ...live, nonblocking: false }), visibleSingle, `${name} blocking ${status}`);
        assert.match(render(live, true), visibleSingle, `${name} actual error`);
      }
      for (const status of ["succeeded", "failed", "aborted", "interrupted"] as const) {
        assert.match(render(run("worker", status, { nonblocking: true })), visibleSingle, `${name} terminal ${status}`);
      }
      assert.match(render({}, true), /Visible result or error/);
    });
    if (name === "subagent_followup") continue;
    await t.test(`${name} group results`, () => {
      const child = run("scout", "paused", { nonblocking: true });
      const pending = run("reviewer", "interrupted", { nonblocking: true });
      const group = { version: 1, id: "group", sessionId: "test", nonblocking: true, status: "running", activity: "Paused dependency", seeds: [child, pending], steps: [child, pending], presentation: { mode: "chain", entries: [
        { runId: child.id, agent: "scout", requestedTask: "Inspect files", phase: "run" },
        { runId: pending.id, agent: "reviewer", requestedTask: "Review files", phase: "pending" },
      ] } };
      assert.equal(render(group), "", `${name} live group with interrupted pending seed`);
      assert.match(render({ ...group, nonblocking: false }), /Delegation · Chain/);
      for (const status of ["succeeded", "failed", "aborted", "interrupted"]) assert.match(render({ ...group, status }), /Delegation · Chain/);
      assert.match(render(group, true), /Delegation · Chain/);
      assert.equal(render(group), "", `${name} cached start stays hidden after terminal retrieval`);
    });
  }
});
