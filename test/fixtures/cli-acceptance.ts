// Explicitly loaded, offline-only CLI acceptance fixture. Not part of the extension.
import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "../../node_modules/@earendil-works/pi-ai/dist/providers/faux.js";
import { Runtime } from "../../runtime.ts";

export default function acceptanceFixture(pi: ExtensionAPI) {
  const directory = process.env.DURABLE_ACCEPTANCE_DIR;
  if (!directory) throw new Error("Acceptance fixture requires its disposable directory");
  const scenario = process.env.DURABLE_ACCEPTANCE_SCENARIO ?? "inspect";
  const emit = (event: string, details: Record<string, unknown> = {}) => {
    appendFileSync(join(directory, "events.jsonl"), JSON.stringify({ event, scenario, pid: process.pid, ...details }) + "\n");
  };
  const faux = fauxProvider({ provider: "acceptance-local" });
  const response: FauxResponseFactory = (context) => {
    const parent = context.tools?.some((tool) => tool.name === "subagent") || context.messages.some(message =>
      message.role === "system" && message.toolsAdded?.some(tool => tool.name === "subagent"));
    emit("model", { parent: Boolean(parent) });
    if (parent) {
      const last = context.messages.at(-1);
      if (last?.role === "toolResult" && last.toolName === "subagent") return fauxAssistantMessage("Fixture parent complete.");
      if (scenario === "ui") {
        const user = context.messages.findLast(message => message.role === "user");
        const text = user?.role === "user" ? typeof user.content === "string" ? user.content : user.content.filter(part => part.type === "text").map(part => part.text).join(" ") : "";
        const resume = /resuming durable subagent run ([a-f0-9]{32})/.exec(text);
        return fauxAssistantMessage([fauxToolCall("subagent", resume ? { resume: resume[1] } : { agent: "probe", task: text }, { id: `ui-${process.pid}-${faux.state.callCount}` })], { stopReason: "toolUse" });
      }
      if (scenario === "hold") return fauxAssistantMessage([fauxToolCall("subagent", { agent: "probe", task: "Run hold once. Do not repeat side effects." }, { id: "kill-delegate" })], { stopReason: "toolUse" });
      if (["denied", "early", "resume", "retrieve"].includes(scenario)) {
        const id = process.env.DURABLE_ACCEPTANCE_RUN;
        assert.ok(id);
        return fauxAssistantMessage([fauxToolCall("subagent", { resume: id }, { id: `recover-${scenario}` })], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage("Inspection only; no work requested.");
    }
    if (scenario === "ui") {
      const user = context.messages.findLast(message => message.role === "user");
      const text = user?.role === "user" ? typeof user.content === "string" ? user.content : user.content.filter(part => part.type === "text").map(part => part.text).join(" ") : "";
      const tool = context.messages.findLast(message => message.role === "toolResult");
      if (tool?.role === "toolResult" && tool.isError) return fauxAssistantMessage("Recovered UI fixture; interrupted effect outcome is uncertain.");
      if (text.includes("ui failure")) return fauxAssistantMessage([], { stopReason: "error", errorMessage: "400 fixture-provider-error: synthetic failure, no network request" });
      if (text.includes("ui hold")) return fauxAssistantMessage([fauxToolCall("hold", {}, { id: `ui-hold-${faux.state.callCount}` })], { stopReason: "toolUse" });
      return fauxAssistantMessage("Verified fixture result. Unavailable fixture capability was not used.");
    }
    if (scenario === "hold") return fauxAssistantMessage([fauxToolCall("hold", {}, { id: "uncertain-effect" })], { stopReason: "toolUse" });
    assert.equal(scenario, "resume", "Only approved resume may make a child model request");
    const transcript = JSON.stringify(context);
    assert.match(transcript, /Original fixture role/);
    assert.doesNotMatch(transcript, /Changed fixture role/);
    const last = context.messages.findLast((message) => message.role === "toolResult");
    assert.ok(last?.isError, "Unsafe interrupted call must be uncertain, not replayed");
    assert.equal(readFileSync(join(directory, "effect.txt"), "utf8"), "effect\n");
    emit("recovered", { uncertain: true });
    return fauxAssistantMessage("Recovered. Interrupted effect outcome is uncertain; it was not repeated.");
  };
  faux.setResponses(Array.from({ length: scenario === "ui" ? 1000 : 12 }, () => response));
  pi.registerProvider(faux.provider);
  pi.registerTool({ name: "hold", label: "Acceptance hold", exposure: "codemode", description: "Disposable side-effect fixture; waits until killed or cancelled", parameters: Type.Object({}),
    execute: async (_id, _args, signal, onUpdate) => {
      appendFileSync(join(directory, "effect.txt"), "effect\n");
      onUpdate?.({ content: [{ type: "text", text: "Fixture effect recorded; waiting." }], details: undefined });
      emit("hold-ready");
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(new Error("Fixture interrupted"));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
      return { content: [], details: undefined };
    } });
  pi.on("session_start", async (_event, ctx) => {
    const runtime = new Runtime(join(directory, "runs"));
    try {
      const runs = await runtime.list(ctx.sessionManager.getSessionId());
      emit("inspected", { mode: ctx.mode, hasUI: ctx.hasUI, sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(), runs: runs.map(run => ({ id: run.id, status: run.status })) });
    } finally { await runtime.close(); }
  });
  pi.on("tool_result", event => {
    if (event.toolName === "subagent") emit("result", { isError: event.isError, content: event.content, details: event.details });
  });
}
