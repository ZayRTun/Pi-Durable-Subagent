import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { Runtime, runId, type Run } from "../runtime.ts";

function seed(task = "Find facts."): Run {
  return { version: 1, id: runId("session", task), sessionId: "session", task,
    agent: { name: "scout", description: "Inspect", tools: ["lookup", "web_search"], instructions: "Return facts.", timeoutMinutes: 1 },
    cwd: process.cwd(), model: { provider: "faux", modelId: "faux-1" }, thinking: "off",
    createdAt: Date.now(), updatedAt: Date.now(), status: "running", activity: "Starting", unavailable: [] };
}
function setup() {
  const faux = fauxProvider();
  const models = createModels(); models.setProvider(faux.provider);
  return { faux, models };
}
async function temporary(fn: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "durable-runtime-"));
  try { await fn(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("progress switches to tool work immediately and elapsed time keeps updating while blocked", async () => temporary(async (directory) => {
  const { faux, models } = setup();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("lookup", {}, { id: "progress" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Finished."),
  ]);
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let elapsed!: () => void;
  const heartbeat = new Promise<void>(resolve => { elapsed = resolve; });
  const updates: string[] = [];
  let liveTokens = 0;
  const tool = defineTool({ name: "lookup", description: "Wait", parameters: Type.Object({}),
    execute: async () => { started(); await gate; return { content: [{ type: "text", text: "Done" }] }; } });
  const runtime = new Runtime(directory);
  const execution = runtime.execute(seed("Observe progress"), { models, tools: [tool], onUpdate: run => {
    updates.push(run.activity);
    liveTokens = Math.max(liveTokens, run.usage?.totalTokens ?? 0);
    if (run.activity === "Using lookup" && (run.elapsedMs ?? 0) >= 500) elapsed();
  } });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await ready;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(liveTokens > 0, "committed model usage must be visible while the tool is blocked");
    assert.ok(updates.includes("Using lookup"), `Started tool must not remain labelled model wait: ${updates.join(", ")}`);
    await Promise.race([heartbeat, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("Elapsed progress did not refresh")), 2000); })]);
  } finally {
    clearTimeout(timeout);
    release();
    await execution;
    await runtime.close();
  }
}));

test("delegates, invokes a tool, stores result and retrieves without another model call", async () => temporary(async (directory) => {
  const { faux, models } = setup();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("lookup", {}, { id: "lookup-1" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Found the answer.")]),
  ]);
  let calls = 0;
  const tools = [defineTool({ name: "lookup", description: "Read facts", parameters: Type.Object({}), replay: "safe",
    execute: async () => { calls++; return { content: [{ type: "text", text: "facts" }] }; } })];
  const runtime = new Runtime(directory);
  const run = seed();
  const result = await runtime.execute(run, { models, tools });
  assert.equal(result.status, "succeeded");
  assert.equal(result.output, "Found the answer.");
  assert.deepEqual(result.unavailable, ["web_search"]);
  assert.equal(calls, 1);
  await runtime.close();
  const reopened = new Runtime(directory);
  assert.equal((await reopened.list("session"))[0].status, "succeeded");
  const retrieved = await reopened.execute(run, { models, tools });
  assert.equal(retrieved.output, "Found the answer.");
  assert.equal(calls, 1);
  assert.deepEqual(await reopened.list("another-session"), []);
  await reopened.close();
}));

test("terminal retrieval leaves record bytes and timestamps unchanged for every terminal state", async () => temporary(async directory => {
  const { faux, models } = setup();
  faux.setResponses([fauxAssistantMessage("Cached answer")]);
  const runtime = new Runtime(directory);
  const run = seed("Read-only retrieval");
  await runtime.execute(run, { models, tools: [] });
  const path = join(directory, run.id, "run.json");
  const record = await runtime.read(run.id);
  try {
    for (const status of ["succeeded", "failed", "aborted"] as const) {
      const snapshot = JSON.stringify({ ...record, status, updatedAt: 123 });
      await writeFile(path, snapshot);
      const result = await runtime.execute(run, { models, tools: [] });
      assert.equal(result.updatedAt, 123);
      assert.equal(await readFile(path, "utf8"), snapshot, `${status} retrieval rewrote metadata`);
    }
  } finally { await runtime.close(); }
}));

test("terminal retrieval succeeds while another delegation is active in the same workspace", async () => temporary(async directory => {
  const { faux, models } = setup();
  faux.setResponses([fauxAssistantMessage("Cached answer")]);
  const runtime = new Runtime(directory);
  const completed = seed("Completed before active");
  await runtime.execute(completed, { models, tools: [] });
  const snapshot = await readFile(join(directory, completed.id, "run.json"), "utf8");
  let started!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  faux.setResponses([fauxAssistantMessage([fauxToolCall("lookup", {}, { id: "held" })], { stopReason: "toolUse" }), fauxAssistantMessage("Finished")]);
  const tool = defineTool({ name: "lookup", description: "Wait", parameters: Type.Object({}), execute: async () => {
    started(); await gate; return { content: [{ type: "text", text: "Done" }] };
  } });
  const work = runtime.execute(seed("Active while retrieving"), { models, tools: [tool] });
  try {
    await ready;
    const result = await runtime.execute(completed, { models, tools: [] });
    assert.equal(result.output, "Cached answer");
    assert.equal(await readFile(join(directory, completed.id, "run.json"), "utf8"), snapshot);
  } finally { release(); await work; await runtime.close(); }
}));

test("a delegation that loses the cross-process workspace lock leaves no orphan record", async () => temporary(async directory => {
  const { faux, models } = setup();
  const owner = new Runtime(directory);
  const contender = new Runtime(directory);
  let started!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const tool = defineTool({ name: "lookup", description: "Wait", parameters: Type.Object({}), execute: async () => {
    started(); await gate; return { content: [{ type: "text", text: "Done" }] };
  } });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("lookup", {}, { id: "held" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Finished"),
  ]);
  const held = owner.execute(seed("Holding the workspace"), { models, tools: [tool] });
  try {
    await ready;
    const blocked = seed("Never admitted");
    await assert.rejects(contender.execute(blocked, { models, tools: [tool] }), /ELOCKED|already being held/i);
    await assert.rejects(contender.read(blocked.id), /ENOENT/);
    assert.deepEqual((await contender.list("session")).map(run => run.id), [runId("session", "Holding the workspace")]);
  } finally { release(); await held; await owner.close(); await contender.close(); }
}));

test("inspection reports the live activity of a running delegation without waking it", async () => temporary(async directory => {
  const { faux, models } = setup();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("lookup", {}, { id: "live-inspect" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Finished"),
  ]);
  let started!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const tool = defineTool({ name: "lookup", description: "Wait", parameters: Type.Object({}), execute: async () => {
    started(); await gate; return { content: [{ type: "text", text: "Done" }] };
  } });
  const runtime = new Runtime(directory);
  const run = seed("Inspect while running");
  const execution = runtime.execute(run, { models, tools: [tool] });
  try {
    await ready;
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    const listed = (await runtime.list("session"))[0];
    assert.equal(listed.status, "running");
    assert.equal(listed.activity, "Using lookup");
    // Inspection must not disturb the record that the run is still writing.
    listed.status = "aborted";
    assert.equal((await runtime.list("session"))[0].status, "running");
  } finally { release(); await execution; await runtime.close(); }
}));

test("shutdown preserves pending work; reopen is paused and explicit resume reuses the same run", async () => temporary(async (directory) => {
  const { faux, models } = setup();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("lookup", {}, { id: "lookup-1" })], { stopReason: "toolUse" }),
    (context) => {
      const prompt = JSON.stringify(context);
      assert.ok(prompt.includes(JSON.stringify(directory).slice(1, -1)), "Resume must retain the original workspace");
      assert.match(prompt, /Return facts/);
      assert.doesNotMatch(prompt, /Changed role/);
      assert.match(prompt, /Start with the named paths/);
      return fauxAssistantMessage([fauxText("Recovered answer.")]);
    },
  ]);
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let calls = 0;
  const tool = defineTool({ name: "lookup", description: "Read facts", parameters: Type.Object({}), replay: "safe",
    execute: async (_args, _api, context) => {
      calls++;
      if (calls === 1) {
        started();
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(new Error("interrupted"));
          context.abortSignal?.addEventListener("abort", abort, { once: true });
          if (context.abortSignal?.aborted) abort();
        });
      }
      return { content: [{ type: "text", text: "facts" }] };
    } });
  const runtime = new Runtime(directory);
  const run = seed("Recover task");
  run.cwd = directory;
  const execution = runtime.execute(run, { models, tools: [tool] });
  await ready;
  await runtime.close();
  assert.equal((await execution).status, "interrupted");
  const reopened = new Runtime(directory);
  const pending = await reopened.list("session");
  assert.equal(pending[0].status, "interrupted");
  assert.equal(calls, 1);
  const changedSeed = { ...run, agent: { ...run.agent, instructions: "Changed role" } };
  const result = await reopened.execute(changedSeed, { models, tools: [tool] });
  assert.equal(result.status, "succeeded");
  assert.equal(result.output, "Recovered answer.");
  assert.equal(calls, 2);
  assert.equal((await reopened.list("session")).length, 1);
  await reopened.close();
}));

test("user cancellation is terminal and does not become resumable", async () => temporary(async (directory) => {
  const { faux, models } = setup();
  faux.setResponses([fauxAssistantMessage([fauxText("Unused")])]);
  const controller = new AbortController(); controller.abort();
  const runtime = new Runtime(directory);
  const run = seed("Cancel");
  const result = await runtime.execute(run, { models, tools: [], signal: controller.signal });
  assert.equal(result.status, "aborted");
  assert.equal((await runtime.list("session"))[0].status, "aborted");
  await runtime.close();
}));

test("cancel stored interrupted work without executing tools", async () => temporary(async (directory) => {
  const { faux, models } = setup();
  faux.setResponses([fauxAssistantMessage([fauxText("Never execute")])]);
  const runtime = new Runtime(directory);
  const run = seed("Interrupted");
  const stop = new AbortController(); stop.abort();
  await runtime.execute(run, { models, tools: [], signal: stop.signal });
  const path = join(directory, run.id, "run.json");
  const record = JSON.parse(await readFile(path, "utf8")); record.status = "interrupted";
  await writeFile(path, JSON.stringify(record));
  await runtime.cancel(run.id);
  assert.equal((await runtime.read(run.id)).status, "aborted");
  await runtime.close();
}));

test("active attempt timeout aborts owned work and records a failure", async () => temporary(async (directory) => {
  const { faux, models } = setup();
  faux.setResponses([fauxAssistantMessage([fauxToolCall("lookup", {}, { id: "timeout-1" })], { stopReason: "toolUse" })]);
  const tools = [defineTool({ name: "lookup", description: "Wait", parameters: Type.Object({}),
    execute: async (_args, _api, context) => {
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(new Error("aborted"));
        context.abortSignal?.addEventListener("abort", abort, { once: true });
        if (context.abortSignal?.aborted) abort();
      });
      return {};
    } })];
  const run = seed("Timeout");
  // Direct runtime fixture accelerates the timeout; public definitions still require >= 1 minute.
  run.agent.timeoutMinutes = 0.001;
  const runtime = new Runtime(directory);
  const result = await runtime.execute(run, { models, tools });
  assert.equal(result.status, "failed");
  assert.match(result.error!, /Timed out/);
  assert.equal((await runtime.read(run.id)).status, "failed");
  await runtime.close();
}));

test("failed delegation preserves the provider's actual error rather than blaming optional tools", async () => temporary(async (directory) => {
  const { faux, models } = setup();
  faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "400 MissingSessionID: Request is missing x-opencode-session" })]);
  const runtime = new Runtime(directory);
  const result = await runtime.execute(seed("Provider error"), { models, tools: [] });
  assert.equal(result.status, "failed");
  assert.match(result.error!, /MissingSessionID.*x-opencode-session/);
  await runtime.close();
}));

test("rejects unsafe run identifiers", async () => {
  const runtime = new Runtime(tmpdir());
  await assert.rejects(runtime.read("../../outside"), /Invalid run ID/);
});
