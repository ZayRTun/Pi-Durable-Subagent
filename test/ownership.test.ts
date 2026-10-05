import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { Runtime, runId, type Run } from "../runtime.ts";

function seed(task: string): Run {
  return { version: 1, id: runId("session", task), sessionId: "session", task,
    agent: { name: "worker", description: "Work", tools: ["write_external"], instructions: "Do the task", timeoutMinutes: 1 },
    cwd: process.cwd(), model: { provider: "faux", modelId: "faux-1" }, thinking: "off",
    createdAt: Date.now(), updatedAt: Date.now(), status: "running", activity: "Starting", unavailable: [] };
}

test("unsafe interrupted calls are not rerun; storage/workspace ownership prevents competing runs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-ownership-"));
  const runtime = new Runtime(directory);
  const competing = new Runtime(directory);
  try {
    const faux = fauxProvider();
    const models = createModels(); models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("write_external", {}, { id: "external-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("The external action was interrupted; verify its effect.")]),
    ]);
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let calls = 0;
    const tools = [defineTool({ name: "write_external", description: "External effect", parameters: Type.Object({}), replay: "unsafe",
      execute: async (_args, _api, context) => {
        calls++; started();
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(new Error("interrupted"));
          context.abortSignal?.addEventListener("abort", abort, { once: true });
          if (context.abortSignal?.aborted) abort();
        });
        return {};
      } })];
    const run = seed("First task");
    const active = runtime.execute(run, { models, tools });
    await ready;
    await assert.rejects(competing.execute(run, { models, tools }), /Lock file is already being held/);
    await assert.rejects(competing.execute(seed("Other task"), { models, tools }), /Lock file is already being held/);
    assert.equal(calls, 1);
    await runtime.close();
    assert.equal((await active).status, "interrupted");
    const result = await competing.execute(run, { models, tools });
    assert.equal(result.status, "succeeded");
    assert.equal(calls, 1);
    assert.match(result.output!, /verify its effect/);
  } finally {
    await runtime.close(); await competing.close();
    await rm(directory, { recursive: true, force: true });
  }
});
