import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type, type Usage } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

test("normal SDK shutdown/reopen stays paused; operator-approved resume preserves workspace without replaying unsafe tools", { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-pi-recovery-"));
  const old = { agents: process.env.PI_SUBAGENT_AGENTS, storage: process.env.PI_SUBAGENT_STORAGE };
  process.env.PI_SUBAGENT_AGENTS = directory;
  process.env.PI_SUBAGENT_STORAGE = join(directory, "runs");
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let calls = 0;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const faux = fauxProvider();
  try {
    await writeFile(join(directory, "scout.md"), "---\nname: scout\ndescription: Recovery fixture\ntools: lookup\n---\nOriginal read-only role.");
    const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, modelsStorePath: join(directory, "models.json"), refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
    const manager = SessionManager.inMemory(directory);
    const settings = SettingsManager.inMemory({ defaultTools: ["subagent"] });
    async function open() {
      const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: settings,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url))],
        extensionFactories: [pi => {
          pi.registerTool({ name: "lookup", label: "Lookup", exposure: "codemode", description: "Controlled interruptible fixture", parameters: Type.Object({}),
            execute: async (_id, _args, signal) => {
              calls++; started();
              await new Promise<void>((_resolve, reject) => {
                const abort = () => reject(new Error("Fixture interrupted"));
                signal?.addEventListener("abort", abort, { once: true });
                if (signal?.aborted) abort();
              });
              return { content: [], details: undefined };
            } });
        }],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      const result = await createAgentSession({ cwd: directory, agentDir: directory, resourceLoader: loader, modelRuntime: runtime,
        model: faux.getModel(), sessionManager: manager, settingsManager: settings, thinkingLevel: "off" });
      session = result.session;
      await session.bindExtensions({ mode: "print" });
      return loader;
    }
    await open();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("subagent", { agent: "scout", task: "Inspect the relative workspace; wait for lookup." }, { id: "delegate" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("lookup", {}, { id: "lookup" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Parent stopped."),
    ]);
    const pending = session!.prompt("Delegate the recovery fixture.");
    await ready;
    await session!.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    await pending;
    const interrupted = session!.messages.find(m => m.role === "toolResult" && m.toolName === "subagent");
    assert.ok(interrupted && interrupted.role === "toolResult");
    const details = interrupted.details as unknown as { id: string; status: string; usage: Usage; toolCount: number };
    assert.equal(details.status, "interrupted");
    assert.equal(details.toolCount, 1);
    assert.ok(details.usage.totalTokens > 0);
    session!.dispose(); session = undefined;
    await writeFile(join(directory, "scout.md"), "---\nname: scout\ndescription: Changed fixture\ntools: lookup\n---\nChanged role.");
    const loader = await open();
    assert.equal(calls, 1, "Reopen must not execute pending work");
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("subagent", { resume: details.id }, { id: "denied" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Approval required."),
    ]);
    await session!.prompt("Try resuming without operator approval.");
    const denied = session!.messages.filter(m => m.role === "toolResult").at(-1);
    assert.ok(denied && denied.role === "toolResult" && denied.isError);
    assert.match(JSON.stringify(denied.content), /Explicit resume approval required/);
    assert.equal(calls, 1);
    // The CLI populates this public runtime map from operator-provided flags.
    loader.getExtensions().runtime.flagValues.set("subagent-resume", details.id);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("subagent", { resume: details.id }, { id: "approved" })], { stopReason: "toolUse" }),
      context => {
        assert.ok(JSON.stringify(context).includes(directory));
        assert.match(JSON.stringify(context), /Original read-only role/);
        assert.doesNotMatch(JSON.stringify(context), /Changed role/);
        const tool = context.messages.findLast(m => m.role === "toolResult");
        assert.ok(tool && tool.role === "toolResult" && tool.isError, "Interrupted unsafe tools must have uncertain outcomes, not be replayed");
        return fauxAssistantMessage("Recovered; lookup outcome is uncertain.");
      },
      fauxAssistantMessage("Parent recovered."),
    ]);
    await session!.prompt("Operator explicitly approves this recovery.");
    const recovered = session!.messages.filter(m => m.role === "toolResult").at(-1);
    assert.ok(recovered && recovered.role === "toolResult");
    assert.equal(recovered.isError, false, JSON.stringify(recovered.content));
    assert.equal(calls, 1);
    const final = recovered.details as unknown as { status: string; usage: Usage; toolCount: number };
    assert.equal(final.status, "succeeded");
    assert.equal(final.toolCount, 1, "recovery must not recount the interrupted call");
    assert.ok(recovered.usage);
    assert.equal(recovered.usage.totalTokens, final.usage.totalTokens - details.usage.totalTokens);
    const text = recovered.content.filter(part => part.type === "text").map(part => part.text).join("\n");
    assert.match(text, /billed this call \(.+ recorded\)/);
    assert.doesNotMatch(text, /retrieved;/);
  } finally {
    if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
    for (const [key, value] of [["PI_SUBAGENT_AGENTS", old.agents], ["PI_SUBAGENT_STORAGE", old.storage]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});


test("historical failed recovery requires approval, preserves failure until approved, and uses a fresh input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-failed-recovery-"));
  const old = { agents: process.env.PI_SUBAGENT_AGENTS, storage: process.env.PI_SUBAGENT_STORAGE };
  process.env.PI_SUBAGENT_AGENTS = directory;
  process.env.PI_SUBAGENT_STORAGE = join(directory, "runs");
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  const faux = fauxProvider();
  try {
    await writeFile(join(directory, "scout.md"), "---\nname: scout\ndescription: Failed fixture\ntools: []\n---\nOriginal role.");
    const models = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, modelsStorePath: join(directory, "models.json"), refreshOnCreate: false });
    models.registerNativeProvider(faux.provider);
    const settings = SettingsManager.inMemory({ defaultTools: ["subagent"] });
    const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url))] });
    await loader.reload();
    ({ session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: models, model: faux.getModel(),
      settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.inMemory(directory), thinkingLevel: "off" }));
    await session.bindExtensions({ mode: "print" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("subagent", { agent: "scout", task: "Inspect evidence." })], { stopReason: "toolUse" }),
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "400 Permanent fixture failure" }),
      fauxAssistantMessage("Parent sees failure."),
    ]);
    await session.prompt("Run failing work.");
    const result = session.messages.findLast(m => m.role === "toolResult" && m.toolName === "subagent");
    assert.ok(result && result.role === "toolResult");
    const run = result.details as unknown as import("../runtime.ts").Run;
    assert.equal(run.status, "failed");
    const { Runtime } = await import("../runtime.ts");
    const inspector = new Runtime(join(directory, "runs"));
    const before = await inspector.read(run.id);
    assert.equal((await inspector.list(run.sessionId))[0].status, "failed");
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("subagent", { resume: run.id })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Approval required."),
    ]);
    await session.prompt("Attempt recovery without approval.");
    const denial = session.messages.findLast(m => m.role === "toolResult");
    assert.ok(denial && denial.role === "toolResult" && denial.isError);
    assert.match(JSON.stringify(denial.content), /Explicit resume approval required/);
    assert.deepEqual(await inspector.read(run.id), before);
    loader.getExtensions().runtime.flagValues.set("subagent-resume", run.id);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("subagent", { resume: run.id })], { stopReason: "toolUse" }),
      context => {
        assert.match(JSON.stringify(context.messages), /operator approved recovery/);
        assert.match(JSON.stringify(context.messages), /Inspect evidence/);
        return fauxAssistantMessage("Recovered useful evidence.");
      },
      fauxAssistantMessage("Parent recovered."),
    ]);
    await session.prompt("Operator approves recovery.");
    const final = await inspector.read(run.id);
    assert.equal(final.status, "succeeded");
    assert.equal(final.output, "Recovered useful evidence.");
    assert.match(final.recoveryHistory![0].error!, /400 Permanent fixture failure/);
  } finally {
    if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
    for (const [key, value] of [["PI_SUBAGENT_AGENTS", old.agents], ["PI_SUBAGENT_STORAGE", old.storage]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
