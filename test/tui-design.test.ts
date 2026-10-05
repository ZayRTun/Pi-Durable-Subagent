import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import { clean, renderGenericResult, renderGroup, renderRun, type RendererState } from "../ui.ts";
import type { Run } from "../runtime.ts";
import type { DelegationPresentation } from "../presentation.ts";

function sample(): Run {
  return { version: 1, id: "a".repeat(32), sessionId: "fixture", agent: { name: "worker", description: "Fixture", tools: [], instructions: "Fixture", timeoutMinutes: 30 }, task: "Inspect the retry policy.", cwd: "/project", model: { provider: "fixture", modelId: "deepseek-v4.1-flash" }, thinking: "low", createdAt: 0, updatedAt: 0, status: "running", activity: "Waiting for provider", unavailable: [] };
}

test("chain presentation shows the requested task rather than previous-step context", () => {
  initTheme("dark", false);
  const run = { ...sample(), task: "Inspect the retry policy.\n\nAnswer from the previous step in this chain:\nPREVIOUS_STEP_RESPONSE" };
  const presentation: DelegationPresentation = { mode: "chain", entries: [{ runId: run.id, agent: "worker", requestedTask: "Inspect the retry policy.", phase: "run" }] };
  const lines = renderGroup(presentation, [run], true, theme).render(80);
  assert.ok(lines.every((line) => !line.includes("\n")));
  const text = clean(lines.join("\n"));
  assert.match(text, /Task[\s\S]*Inspect the retry policy\./);
  assert.doesNotMatch(text, /PREVIOUS_STEP_RESPONSE|Answer from the previous/);
});

test("group inset covers wrapped headings, expanded content and separators in every mode", () => {
  initTheme("dark", false);
  const first = { ...sample(), status: "succeeded" as const, output: "A project finding." };
  const last = { ...sample(), id: "b".repeat(32) };
  for (const mode of ["ordered", "chain", "parallel"] as const) {
    const presentation: DelegationPresentation = { mode, entries: [
      { runId: first.id, agent: "worker", requestedTask: first.task, phase: "run" },
      { runId: last.id, agent: "worker", requestedTask: last.task, phase: "run" },
    ] };
    const lines = renderGroup(presentation, [first, last], true, theme).render(80).map(clean);
    assert.ok(lines.includes("  │"));
    assert.ok(lines.includes("  │      Task"));
    assert.ok(lines.some((line) => line.trimEnd() === "  │      A project finding."));
    assert.ok(lines.includes("         Task"));
    assert.ok(lines.includes("         Current tool"));
    for (const width of [12, 24, 80, 120]) {
      const rows = renderGroup(presentation, [first, last], true, theme).render(width).map(clean);
      assert.ok(rows.every((row) => row.startsWith(" ") && visibleWidth(row) <= width));
      if (width === 12) assert.equal(rows[0], " Delegation");
    }
  }
});

test("a multiline single task is flattened only in its collapsed caption", () => {
  initTheme("dark", false);
  const run = { ...sample(), task: "First line\nSecond line" };
  const lines = renderRun(run, true, theme).render(80).map(clean);
  assert.equal(lines[0], " ⠹ worker (First line Second line)");
  assert.ok(lines.includes("    First line") && lines.includes("    Second line"));
});

test("task captions cap normalized Unicode text at 50 characters without changing expanded tasks", () => {
  initTheme("dark", false);
  const cases = [
    { task: "a".repeat(24) + "\n\n" + "b".repeat(30), caption: "a".repeat(24) + " " + "b".repeat(24) + "…", body: ["a".repeat(24), "", "b".repeat(30)] },
    { task: "x".repeat(50), caption: "x".repeat(50), body: ["x".repeat(50)] },
    { task: "a".repeat(48) + "😀bc", caption: "a".repeat(48) + "😀…", body: ["a".repeat(48) + "😀bc"] },
    { task: "a".repeat(49) + "😀", caption: "a".repeat(49) + "😀", body: ["a".repeat(49) + "😀"] },
  ];
  for (const width of [120, 200]) {
    for (const { task, caption, body } of cases) {
      const run = { ...sample(), task };
      const presentation: DelegationPresentation = { mode: "ordered", entries: [{ runId: run.id, agent: "worker", requestedTask: task, phase: "run" }] };
      for (const grouped of [false, true]) {
        for (const expanded of [false, true]) {
          const lines = (grouped ? renderGroup(presentation, [run], expanded, theme) : renderRun(run, expanded, theme)).render(width).map(clean);
          assert.equal(lines[grouped ? 1 : 0], (grouped ? "  └ " : " ") + "⠹ worker (" + caption + ")");
          assert.equal(Array.from(caption).length, 50);
          if (expanded) {
            const prefix = grouped ? "         " : "    ";
            const start = lines.indexOf(prefix + "Task") + 2;
            assert.deepEqual(lines.slice(start, start + body.length), body.map((line) => prefix + line));
          }
        }
      }
    }
  }
});


  initTheme("dark", false);
test("long current/recent activity stays one line per call and failures are not green checks", () => {
  initTheme("dark", false);
  const run = { ...sample(), activityLog: [
    { callId: "1", name: "read", status: "done", summary: "project/".repeat(30), failed: true },
    { callId: "2", name: "bash", status: "running", summary: "npm test -- " + "long-argument-".repeat(20) },
  ] };
  const lines = renderRun(run, true, theme).render(80).map(clean);
  const recent = lines.slice(lines.indexOf("    Recent activity") + 2);
  assert.equal(recent.length, 1);
  assert.match(recent[0]!, /^    ✗ read · .*…$/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 80));
});

test("completed responses retain native Markdown headings and cached content across redraws", () => {
  initTheme("light", false);
  const run = { ...sample(), status: "succeeded" as const, output: "## Changes\n\n- A wrapped project finding.\n\n## Verification\n\nTargeted tests passed." };
  const state: RendererState = {};
  const first = clean(renderRun(run, true, theme, { state }).render(80).join("\n"));
  const cached = state.markdown?.[run.id]?.component;
  assert.ok(cached);
  assert.match(first, /Changes[\s\S]*Verification/);
  renderRun(run, true, theme, { state }).render(120);
  assert.equal(state.markdown?.[run.id]?.component, cached);
});

test("generic errors have bounded collapsed previews and expand explicitly", () => {
  const text = Array.from({ length: 20 }, (_, index) => `Error line ${index}`).join("\n");
  const collapsed = renderGenericResult(text).render(80);
  assert.equal(collapsed.length, 6);
  assert.equal(collapsed[5], "(15 more lines, Ctrl+O to expand)");
  assert.equal(renderGenericResult(text, true).render(80).length, 20);
});

test("ultra-narrow metrics omit whole readings instead of slicing a cost", () => {
  initTheme("dark", false);
  const run = { ...sample(), status: "succeeded" as const, elapsedMs: 18100, toolCount: 12, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 117800, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0123 } } };
  for (const width of [12, 20, 24, 40, 80]) {
    const lines = renderRun(run, false, theme).render(width).map(clean);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    if (lines[1]!.includes("$")) assert.ok(lines[1]!.includes("~$0.0123"));
  }
});

for (const nativeTheme of ["dark", "light"]) {
  for (const expanded of [false, true]) {
    test(`${nativeTheme} ${expanded ? "expanded" : "collapsed"} tree prefixes are white without resetting the tool background`, () => {
      initTheme(nativeTheme, false);
      const run = sample();
      const presentation: DelegationPresentation = { mode: "ordered", entries: [
        { runId: run.id, agent: "worker", requestedTask: run.task, phase: "run" },
        { runId: "pending", agent: "worker", requestedTask: "Pending task", phase: "pending" },
        { runId: "not-run", agent: "worker", requestedTask: "Skipped task", phase: "not-run" },
      ] };
      const lines = renderGroup(presentation, [run], expanded, theme, { now: 0 }).render(100);
      const glyphs: string[] = [];
      for (const line of lines) {
        let foreground = "default";
        for (const token of line.matchAll(/\x1b\[([\d;]*)m|([^\x1b])/g)) {
          if (token[1] !== undefined) {
            const codes = (token[1] || "0").split(";").map(Number);
            for (let i = 0; i < codes.length; i++) {
              const code = codes[i]!;
              assert.notEqual(code, 0, "prefix must not reset the tool background");
              assert.ok(!(code >= 40 && code <= 49) && !(code >= 100 && code <= 107), "prefix must not change the tool background");
              if (code === 38 && codes[i + 1] === 2) {
                foreground = codes.slice(i + 2, i + 5).join(",");
                i += 4;
              } else if (code === 38 && codes[i + 1] === 5) {
                foreground = codes[i + 2] === 231 ? "255,255,255" : `indexed:${codes[i + 2]}`;
                i += 2;
              } else if (code === 39 || (code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
                foreground = code === 97 ? "255,255,255" : `sgr:${code}`;
              }
            }
          } else {
            const char = token[2]!;
            if (char === " ") continue;
            if (!"├└│⎿".includes(char)) break;
            glyphs.push(char);
            assert.equal(foreground, "255,255,255", `${char} in ${JSON.stringify(line)}`);
          }
        }
      }
      assert.deepEqual([...new Set(glyphs)].sort(), ["├", "└", "│", "⎿"].sort());
      const single = renderRun(run, expanded, theme, { now: 0 }).render(100)[1]!;
      assert.match(single, /\x1b\[(?:38;2;255;255;255|38;5;231|97)m    ⎿ /);
      assert.doesNotMatch(single.slice(0, single.indexOf("⎿") + 1), /\x1b\[(?:0|4[0-9]|10[0-7])m/);
    });
  }
}
