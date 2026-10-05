import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import extension from "../index.ts";

for (const policy of [
  { name: "malformed policy does not start child work", agent: undefined, parent: 0, effective: null, malformed: true },
  { name: "omitted policies allow progress beyond the former deadline", agent: undefined, parent: undefined, effective: null },
  { name: "explicit no deadline overrides the Agent allowance", agent: 1, parent: null, effective: null },
  { name: "explicit duration overrides the Agent allowance", agent: 30, parent: 2, effective: 2 },
  { name: "omitted parent policy uses the Agent allowance", agent: 30, parent: undefined, effective: 30 },
]) {
  test(`host Delegation: ${policy.name}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "durable-policy-"));
    const oldStorage = process.env.PI_SUBAGENT_STORAGE, oldAgents = process.env.PI_SUBAGENT_AGENTS;
    process.env.PI_SUBAGENT_STORAGE = join(directory, "runs");
    process.env.PI_SUBAGENT_AGENTS = join(directory, "agents");
    const originalTimer = globalThis.setTimeout;
    const deadlines: number[] = [];
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      await mkdir(join(directory, "agents"));
      await writeFile(join(directory, "agents", "worker.md"), `---\nname: worker\ndescription: Policy fixture\ntools: [policy_work]\n${policy.agent === undefined ? "" : `timeoutMinutes: ${policy.agent}\n`}---\nComplete the work.\n`);
      const faux = fauxProvider();
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("subagent", { agent: "worker", task: "Produce evidence.", ...(policy.parent !== undefined ? { timeoutMinutes: policy.parent } : {}) })], { stopReason: "toolUse" }),
        ...("malformed" in policy ? [] : [fauxAssistantMessage([fauxToolCall("policy_work", {})], { stopReason: "toolUse" }), fauxAssistantMessage("Work completed.")]),
        fauxAssistantMessage("Parent completed."),
      ]);
      const modelRuntime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, modelsStorePath: join(directory, "models.json"), refreshOnCreate: false });
      modelRuntime.registerNativeProvider(faux.provider);
      const settingsManager = SettingsManager.inMemory({ defaultTools: ["subagent"] });
      const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        extensionFactories: [extension, pi => pi.registerTool({ name: "policy_work", label: "Policy work", description: "Write observable evidence", parameters: Type.Object({}),
          execute: async () => {
            await new Promise<void>(resolve => originalTimer(resolve, 60));
            await writeFile(join(directory, "evidence.txt"), "useful work finished");
            return { content: [{ type: "text", text: "Evidence written." }], details: undefined };
          } })],
      });
      await loader.reload();
      ({ session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime, model: modelRuntime.getModel("faux", "faux-1")!,
        settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(directory), thinkingLevel: "off" }));
      // Time is a system boundary: accelerate only execution-sized timers when no deadline is expected.
      globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
        if (delay === 60000 || delay === 120000 || delay === 1800000) deadlines.push(delay);
        return originalTimer(callback, policy.effective === null && (delay === 60000 || delay === 1800000) ? 20 : delay, ...args);
      }) as typeof setTimeout;
      await session.prompt("Delegate the work.");
      const result = session.messages.find(message => message.role === "toolResult" && message.toolName === "subagent");
      assert.ok(result && result.role === "toolResult");
      if ("malformed" in policy) {
        assert.equal(result.isError, true, JSON.stringify(result));
        assert.match(JSON.stringify(result.content), /timeoutMinutes/);
        await assert.rejects(readFile(join(directory, "evidence.txt")), /ENOENT/);
        assert.deepEqual(deadlines, []);
        return;
      }
      assert.equal(result.isError, false, JSON.stringify(result.content));
      assert.equal(await readFile(join(directory, "evidence.txt"), "utf8"), "useful work finished");
      assert.deepEqual(deadlines, policy.effective === null ? [] : [policy.effective * 60000]);
      assert.equal((result.details as { timeoutMinutes: number | null }).timeoutMinutes, policy.effective);
    } finally {
      globalThis.setTimeout = originalTimer;
      session?.dispose();
      if (oldStorage === undefined) delete process.env.PI_SUBAGENT_STORAGE; else process.env.PI_SUBAGENT_STORAGE = oldStorage;
      if (oldAgents === undefined) delete process.env.PI_SUBAGENT_AGENTS; else process.env.PI_SUBAGENT_AGENTS = oldAgents;
      await rm(directory, { recursive: true, force: true });
    }
  });
}
