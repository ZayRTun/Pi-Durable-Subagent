import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, Type } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineTool } from "@earendil-works/pi-durable";
import { Runtime, runId, type Run } from "../runtime.ts";

test("the tool counter outlives the thirty-call presentation window", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-counter-"));
  const runtime = new Runtime(join(directory, "runs"));
  try {
    const faux = fauxProvider();
    faux.setResponses([
      ...Array.from({ length: 35 }, (_, index) => fauxAssistantMessage([fauxToolCall("ping", {}, { id: `ping-${index}` })], { stopReason: "toolUse" })),
      fauxAssistantMessage("Finished."),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    let executed = 0;
    const tool = defineTool({ name: "ping", description: "Counter fixture", parameters: Type.Object({}), execute: async () => {
      executed++;
      return { content: [{ type: "text", text: "pong" }] };
    } });
    const seed: Run = { version: 1, id: runId("counter", "fixture"), sessionId: "counter", agent: { name: "probe", description: "Counter", tools: ["ping"], instructions: "Use the requested tools.", timeoutMinutes: 1 }, task: "Count tool uses.", cwd: directory, model: { provider: "faux", modelId: "faux-1" }, thinking: "off", status: "running", activity: "Starting", unavailable: [], createdAt: Date.now(), updatedAt: Date.now() };
    const result = await runtime.execute(seed, { models, tools: [tool] });
    assert.equal(result.status, "succeeded");
    assert.equal(executed, 35);
    assert.equal(result.toolCount, 35);
    assert.equal(result.activityLog?.length, 30);
    assert.equal(result.activityLog?.at(-1)?.callId, "ping-34");
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
