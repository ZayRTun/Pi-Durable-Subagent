import { initTheme } from "@earendil-works/pi-coding-agent";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { renderRun } from "../ui.ts";

const base = {
  version: 1, id: "3f4c1a9b2d5e6f708192a3b4c5d6e7f8", sessionId: "s", cwd: "/Users/zayar/code/mat-skill-test",
  agent: { name: "scout", description: "Read-only reconnaissance", instructions: "Inspect", tools: ["read", "ls", "ffgrep", "fffind", "bash"], timeoutMinutes: 30, color: "cyan" },
  task: "Map how the health endpoint resolves interview counts, and report the files involved.",
  model: { provider: "opencode-go", modelId: "deepseek-v4.1-flash" }, thinking: "low",
  unavailable: [], createdAt: 0, updatedAt: 0,
};

const states = {
  running: { status: "running", activity: "Reading app/Http/Controllers/HealthController.php", elapsedMs: 4200, usage: null },
  succeeded: { status: "succeeded", activity: "Completed", elapsedMs: 18400, usage: { input: 12000, output: 900, cacheRead: 48000, cacheWrite: 0, totalTokens: 60900, cost: { input: 0.0004, output: 0.0006, cacheRead: 0.0002, cacheWrite: 0, total: 0.0012 } },
    output: "## Answer\nThe health endpoint reads counts through `interviewCountsByStatus()` and formats them in `HealthController`.\n\n- `app/Http/Controllers/HealthController.php`\n- `app/Models/InterviewSession.php`" },
  failed: { status: "failed", activity: "Failed", elapsedMs: 8100, error: "Timed out after 30 minutes", usage: null },
  aborted: { status: "aborted", activity: "Cancelled", elapsedMs: 2200, usage: null },
  interrupted: { status: "interrupted", activity: "Awaiting explicit resume", elapsedMs: 6300, usage: null },
};

const gaps = { unavailable: ["web_search", "codemode"], activityLog: [
  { callId: "c1", name: "ffgrep", status: "done", output: "3 matches in app/Http/Controllers" },
  { callId: "c2", name: "hold", status: "done", uncertain: true, output: "interrupted before a result was recorded" },
] };

initTheme("dark", false);
const rule = (label, width) => `\n${"─".repeat(width)} ${label}`;
for (const width of [100, 56]) {
  for (const [name, state] of Object.entries(states)) {
    const run = { ...base, ...state };
    console.log(rule(`${name} · collapsed · width ${width}`, width));
    console.log(renderRun(run, false, theme, "/r/run.json").render(width).join("\n"));
  }
  const rich = { ...base, ...states.succeeded, ...gaps };
  console.log(rule(`succeeded with gaps, uncertainty, activity · expanded · width ${width}`, width));
  console.log(renderRun(rich, true, theme, "/r/run.json").render(width).join("\n"));
}
