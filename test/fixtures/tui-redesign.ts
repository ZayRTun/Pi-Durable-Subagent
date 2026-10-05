import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { TruncatedText } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "../../node_modules/@earendil-works/pi-ai/dist/providers/faux.js";

export default function tuiFixture(pi: ExtensionAPI) {
  const directory = process.env.DURABLE_TUI_FIXTURE;
  if (!directory) throw new Error("Disposable TUI fixture directory required");
  if (process.env.DURABLE_TUI_PAUSE === "1") {
    const timer = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => timer(callback, delay === 60000 ? 1800 : delay === 48000 ? 1400 : delay, ...args)) as typeof setTimeout;
  }
  const emit = (event: string, details: unknown) => appendFileSync(join(directory, "events.jsonl"), JSON.stringify({ event, details }) + "\n");
  const faux = fauxProvider({ provider: "tui-local" });
  faux.setResponses(Array.from({ length: 200 }, () => (context) => {
    const parent = context.tools?.some((tool) => tool.name === "subagent") || context.messages.some((message) => message.role === "system" && message.toolsAdded?.some((tool) => tool.name === "subagent"));
    const user = context.messages.findLast((message) => message.role === "user");
    const task = user?.role === "user" ? typeof user.content === "string" ? user.content : user.content.filter((part) => part.type === "text").map((part) => part.text).join(" ") : "";
    if (parent) {
      if (context.messages.at(-1)?.role === "toolResult") return fauxAssistantMessage("Offline fixture complete.");
      if (task.includes("baseline")) return fauxAssistantMessage([fauxToolCall("baseline_clip", {}, { id: "baseline" })], { stopReason: "toolUse" });
      const items = ["scout", "worker", "reviewer"].map((agent) => ({ agent, task: `Inspect the retry policy and preserve the original error on exhaustion. Verify the timeout behavior and report the relevant project findings for ${agent}.` }));
      const args = task.includes("parallel") ? { tasks: items, worktree: true } : task.includes("chain") ? { chain: items } : task.includes("ordered") ? { tasks: items } : { agent: "worker", task: "Inspect the retry policy and preserve the original error on exhaustion. Verify the timeout behavior and report the relevant project findings. " + task };
      return fauxAssistantMessage([fauxToolCall("subagent", { ...args, ...(task.includes("pause") ? { timeoutMinutes: 1 } : {}) }, { id: `preview-${faux.state.callCount}` })], { stopReason: "toolUse" });
    }
    const completed = context.messages.filter((message) => message.role === "toolResult").length;
    if (completed < 3) return fauxAssistantMessage([fauxToolCall("tui_read", { path: join(directory, `sample-${completed}.txt`) }, { id: `read-${completed}` })], { stopReason: "toolUse" });
    if (completed === 3) return fauxAssistantMessage([fauxToolCall("tui_wait", { command: "npm test -- retry-policy" }, { id: "test-policy" })], { stopReason: "toolUse" });
    if (task.includes("failure")) return fauxAssistantMessage([], { stopReason: "error", errorMessage: "Synthetic retry-policy verification failure." });
    return fauxAssistantMessage("## Changes\n\nChecked retry exhaustion and timeout behavior in the disposable project.\n\n- The original error is preserved when the retry budget is exhausted. This long bullet tests whether its continuation aligns under the bullet text without changing the tree's content column.\n- Timeout behavior remains unchanged.\n\n## Verification\n\nThree real fixture files were read. The waiting tool is synthetic; no npm tests or network requests were executed.\n\n```ts\nconst exhausted = attempts >= retryLimit;\n```\n");
  }));
  pi.registerProvider(faux.provider);
  pi.registerTool({ name: "baseline_clip", label: "Baseline clipping", description: "Native truncation background reproduction", parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: "Baseline" }], details: undefined }; },
    renderCall(_args, theme) { return new TruncatedText(theme.fg("muted", "Baseline sample " + "long styled text ".repeat(40))); },
    renderResult(_result, _options, theme) { return new TruncatedText(theme.fg("muted", "Baseline sample " + "long styled text ".repeat(40))); }
  });
  pi.registerTool({ name: "tui_read", label: "Fixture read", exposure: "codemode", description: "Read a real disposable file with a controlled delay", parameters: Type.Object({ path: Type.String() }),
    async execute(_id, args) {
      const text = readFileSync(args.path, "utf8");
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { content: [{ type: "text", text }], details: undefined };
    } });
  pi.registerTool({ name: "tui_wait", label: "Fixture wait", exposure: "codemode", description: "Synthetic verification wait; command is display data, not executed", parameters: Type.Object({ command: Type.String() }),
    async execute(_id, _args, signal) {
      emit("wait", {});
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, 2500);
        const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new Error("Synthetic verification cancelled.")); };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
      return { content: [{ type: "text", text: "Synthetic verification finished." }], details: undefined };
    } });
  pi.on("tool_result", (event) => { if (event.toolName === "subagent") emit("result", { isError: event.isError, details: event.details }); });
}
