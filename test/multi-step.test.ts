import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

// Definitions are explicit now; point the extension at the fixture set the removed bundled fallback found.
process.env.PI_SUBAGENT_AGENTS ??= fileURLToPath(new URL("./fixtures/agents/", import.meta.url));

test("several steps run in order and are each recorded as their own run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-multi-step-"));
  const store = join(directory, "runs");
  const previous = process.env.PI_SUBAGENT_STORAGE;
  process.env.PI_SUBAGENT_STORAGE = store;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const faux = fauxProvider();
    const answer = () => fauxAssistantMessage([fauxText("step answer")]);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("subagent", { agent: "scout", tasks: [{ task: "First step" }, { agent: "reviewer", task: "Second step" }] }, { id: "multi" })], { stopReason: "toolUse" }),
      ...Array.from({ length: 12 }, () => answer),
    ]);
    const modelRuntime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, modelsStorePath: join(directory, "models.json"), refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const model = modelRuntime.getModel("faux", "faux-1")!;
    const settingsManager = SettingsManager.inMemory({ defaultTools: ["read", "subagent"] });
    const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url))] });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime, model,
      settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(directory), thinkingLevel: "off" }));
    await session.prompt("Run both steps.");
    const result = session.messages.find((message) => message.role === "toolResult" && message.toolName === "subagent");
    assert.ok(result && result.role === "toolResult");
    assert.equal(result.isError, false);

    const records = [];
    for (const id of (await readdir(store)).filter((name) => /^[a-f0-9]{32}$/.test(name))) {
      records.push(JSON.parse(await readFile(join(store, id, "run.json"), "utf8")) as { agent: { name: string }; task: string; status: string });
    }
    assert.equal(records.length, 2);
    assert.deepEqual(Object.fromEntries(records.map((run) => [run.agent.name, run.task])),
      { scout: "First step", reviewer: "Second step" });
    assert.ok(records.every((run) => run.status === "succeeded"));

    // The result carries an optional presentation that reflects the requested order and tasks,
    // including a stable run ID per step, so the UI does not infer structure from the tasks alone.
    const details = result.details as { steps: { id: string }[]; presentation?: { mode: string; entries: { runId: string; requestedTask: string; phase: string }[] } };
    assert.equal(details.presentation?.mode, "ordered");
    assert.deepEqual(details.presentation?.entries.map((entry) => entry.requestedTask), ["First step", "Second step"]);
    assert.ok(details.presentation!.entries.every((entry) => entry.phase === "run"));
    assert.deepEqual(details.presentation!.entries.map((entry) => entry.runId), details.steps.map((step) => step.id));

    const text = result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
    assert.match(text, /Step 1\/2 · scout/);
    assert.match(text, /Step 2\/2 · reviewer/);
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_STORAGE; else process.env.PI_SUBAGENT_STORAGE = previous;
    try { session?.dispose?.(); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
});
