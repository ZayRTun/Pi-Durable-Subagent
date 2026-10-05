import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

// Definitions are explicit now; point the extension at the fixture set the removed bundled fallback found.
process.env.PI_SUBAGENT_AGENTS ??= fileURLToPath(new URL("./fixtures/agents/", import.meta.url));

for (const mode of ["tasks", "chain"] as const) {
  test(`retrieving a completed ${mode} step reports no new usage`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "durable-multi-retrieval-"));
    const previous = process.env.PI_SUBAGENT_STORAGE;
    process.env.PI_SUBAGENT_STORAGE = join(directory, "runs");
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      const faux = fauxProvider();
      const settingsManager = SettingsManager.inMemory({ defaultTools: ["read", "subagent"] });
      const modelRuntime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, modelsStorePath: join(directory, "models.json"), refreshOnCreate: false });
      modelRuntime.registerNativeProvider(faux.provider);
      const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url))] });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      ({ session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime,
        model: modelRuntime.getModel("faux", "faux-1")!, settingsManager, resourceLoader: loader,
        sessionManager: SessionManager.inMemory(directory), thinkingLevel: "off" }));
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("subagent", { [mode]: [
          { agent: "scout", task: "Return FIRST without tools." },
          { agent: "scout", task: "Return SECOND without tools." },
        ] }, { id: "multi" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("FIRST"),
        fauxAssistantMessage("SECOND"),
        fauxAssistantMessage("Both complete."),
      ]);
      await session.prompt("Delegate both steps.");
      const first = session.messages.find(message => message.role === "toolResult" && message.toolName === "subagent");
      assert.ok(first && first.role === "toolResult" && !first.isError);
      assert.ok(first.usage && first.usage.totalTokens > 0);
      const details = first.details as { steps: { id: string }[] };
      assert.equal(details.steps.length, 2);
      const id = details.steps[0].id;
      const path = join(directory, "runs", id, "run.json");
      const before = await readFile(path, "utf8");
      const calls = faux.state.callCount;
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("subagent", { resume: id }, { id: "retrieve" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("Retrieved."),
      ]);
      await session.prompt("Retrieve the first step.");
      const second = session.messages.filter(message => message.role === "toolResult" && message.toolName === "subagent").at(-1);
      assert.ok(second && second.role === "toolResult" && !second.isError);
      const text = second.content.filter(part => part.type === "text").map(part => part.text).join("\n");
      assert.match(text, /retrieved; not newly billed/);
      assert.equal(second.usage, undefined, "stored multi-step usage must not be reported again");
      assert.equal(await readFile(path, "utf8"), before);
      assert.equal(faux.state.callCount - calls, 2, "only the scripted parent may make model calls during retrieval");
    } finally {
      session?.dispose();
      if (previous === undefined) delete process.env.PI_SUBAGENT_STORAGE; else process.env.PI_SUBAGENT_STORAGE = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });
}
