import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

// The first test drives the chain through the real fixture set; the nesting test overrides it.
process.env.PI_SUBAGENT_AGENTS = fileURLToPath(new URL("./fixtures/agents/", import.meta.url));

async function recordsUnder(store: string) {
  const records = [];
  for (const id of (await readdir(store)).filter((name) => /^[a-f0-9]{32}$/.test(name))) {
    records.push(JSON.parse(await readFile(join(store, id, "run.json"), "utf8")) as { task: string; status: string; unavailable: string[]; agent: { name: string } });
  }
  return records;
}

test("a chain hands each step the previous step's answer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-chain-"));
  const store = join(directory, "runs");
  const previous = process.env.PI_SUBAGENT_STORAGE;
  process.env.PI_SUBAGENT_STORAGE = store;
  const seen: string[] = [];
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("subagent", { agent: "scout", chain: [{ task: "First step" }, { task: "Second step" }] }, { id: "chained" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("the first answer")]),
      (context) => { seen.push(JSON.stringify(context)); return fauxAssistantMessage([fauxText("the second answer")]); },
      fauxAssistantMessage([fauxText("done")]),
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
    await session.prompt("Run the chain.");

    assert.equal(seen.length, 1, "the second step is the only one that should see a predecessor");
    assert.match(seen[0], /previous step in this chain/);
    assert.match(seen[0], /the first answer/);

    const records = await recordsUnder(store);
    assert.equal(records.length, 2);
    assert.ok(records.every((record) => record.status === "succeeded"));
    const second = records.find((record) => record.task.startsWith("Second step"));
    assert.ok(second, "the second step must be recorded");
    assert.match(second.task, /the first answer/, "the record shows exactly what the step was given");
    assert.equal(records.find((record) => record.task === "First step")?.task, "First step");
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_STORAGE; else process.env.PI_SUBAGENT_STORAGE = previous;
    try { session?.dispose?.(); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
});

test("nesting reaches depth three, shares the caller's directory without deadlocking, and stops there", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-nest-"));
  const agents = join(directory, "agents");
  const store = join(directory, "runs");
  const previous = { agents: process.env.PI_SUBAGENT_AGENTS, storage: process.env.PI_SUBAGENT_STORAGE };
  process.env.PI_SUBAGENT_AGENTS = agents;
  process.env.PI_SUBAGENT_STORAGE = store;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(agents, { recursive: true });
    await writeFile(join(agents, "delegator.md"), "---\nname: delegator\ndescription: Delegates one level further\ntools: read, subagent\n---\nDelegate one level further when asked, otherwise answer directly.\n");

    const delegate = (task: string, id: string) => fauxAssistantMessage([fauxToolCall("subagent", { agent: "delegator", task }, { id })], { stopReason: "toolUse" });
    const answer = (text: string) => fauxAssistantMessage([fauxText(text)]);
    const faux = fauxProvider();
    faux.setResponses([
      delegate("level 0", "n0"),
      delegate("level 1", "n1"),
      delegate("level 2", "n2"),
      delegate("level 3", "n3"),
      answer("deepest answer"),
      ...Array.from({ length: 8 }, () => answer("ok")),
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
    await session.prompt("Start the nested delegation.");

    const records = await recordsUnder(store);
    assert.deepEqual(records.map((record) => record.task).sort(), ["level 0", "level 1", "level 2", "level 3"]);
    assert.ok(records.every((record) => record.status === "succeeded"), `all levels must succeed: ${JSON.stringify(records.map((r) => [r.task, r.status]))}`);

    // Sharing one directory across a nested tree is what the workspace-lock exemption buys.
    const blocked = records.filter((record) => /Another delegation is using this working directory/.test(JSON.stringify(record)));
    assert.deepEqual(blocked, [], "nesting must not deadlock on the workspace lock");

    const cannotDelegate = records.filter((record) => record.unavailable.includes("subagent"));
    assert.deepEqual(cannotDelegate.map((record) => record.task), ["level 3"], "only the deepest level loses the ability to delegate");
  } finally {
    if (previous.agents === undefined) delete process.env.PI_SUBAGENT_AGENTS; else process.env.PI_SUBAGENT_AGENTS = previous.agents;
    if (previous.storage === undefined) delete process.env.PI_SUBAGENT_STORAGE; else process.env.PI_SUBAGENT_STORAGE = previous.storage;
    try { session?.dispose?.(); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
});
