import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type, createModels, type Context } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Runtime, runId, type Run } from "../runtime.ts";
import extension from "../index.ts";

for (const outcome of ["handoff", "handoff-tool", "permanent-error", "cancel", "shutdown"] as const) {
test(`host allowance boundary: ${outcome}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "durable-policy-"));
    const policy = { agent: 1, parent: 1, effective: 1 };
    const oldStorage = process.env.PI_SUBAGENT_STORAGE, oldAgents = process.env.PI_SUBAGENT_AGENTS;
    process.env.PI_SUBAGENT_STORAGE = join(directory, "runs");
    process.env.PI_SUBAGENT_AGENTS = join(directory, "agents");
    const originalTimer = globalThis.setTimeout;

    let workCalls = 0;
    const states: string[] = [];
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      await mkdir(join(directory, "agents"));
      await writeFile(join(directory, "agents", "worker.md"), `---\nname: worker\ndescription: Policy fixture\ntools: [policy_work]\n${policy.agent === undefined ? "" : `timeoutMinutes: ${policy.agent}\n`}---\nComplete the work.\n`);
      const faux = fauxProvider();
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("subagent", { agent: "worker", task: "Produce evidence.", ...(policy.parent !== undefined ? { timeoutMinutes: policy.parent } : {}) })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxToolCall("policy_work", {}), fauxToolCall("policy_work", {})], { stopReason: "toolUse" }),
        fauxAssistantMessage("Work stopped."),
        ...(outcome === "permanent-error" ? [fauxAssistantMessage([], { stopReason: "error", errorMessage: "400 Permanent handoff failure" })] : [(context: Context) => {
          assert.deepEqual(context.tools ?? [], [], "handoff exposes no work tools");
          return outcome === "handoff-tool"
            ? fauxAssistantMessage([fauxToolCall("policy_work", {})], { stopReason: "toolUse" })
            : fauxAssistantMessage("Checkpoint: evidence written. Remaining: second change.");
        }]),
        ...(outcome === "handoff-tool" ? [fauxAssistantMessage("Checkpoint: evidence written. Remaining: second change.")] : []),
        fauxAssistantMessage("Parent completed."),
      ]);
      const modelRuntime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, modelsStorePath: join(directory, "models.json"), refreshOnCreate: false });
      modelRuntime.registerNativeProvider(faux.provider);
      const settingsManager = SettingsManager.inMemory({ defaultTools: ["subagent"] });
      const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        extensionFactories: [extension, pi => pi.registerTool({ name: "policy_work", label: "Policy work", description: "Write observable evidence", parameters: Type.Object({}),
          execute: async (_id, _args, signal) => {
            workCalls++;
            await new Promise<void>((resolve, reject) => {
              const abort = () => { clearTimeout(workTimer); reject(new Error("Stopped by owner")); };
              signal?.addEventListener("abort", abort, { once: true });
              const workTimer = originalTimer(() => { signal?.removeEventListener("abort", abort); resolve(); }, outcome === "cancel" || outcome === "shutdown" ? 10000 : 100);
            });
            await writeFile(join(directory, "evidence.txt"), "useful work finished");
            return { content: [{ type: "text", text: "Evidence written." }], details: undefined };
          } })],
      });
      await loader.reload();
      ({ session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime, model: modelRuntime.getModel("faux", "faux-1")!,
        settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(directory), thinkingLevel: "off" }));
      // Time is a system boundary: accelerate only execution-sized timers at the allowance boundary.
      globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {

        return originalTimer(callback, delay === 60000 ? 30 : delay === 48000 ? 10 : delay, ...args);
      }) as typeof setTimeout;
      session.subscribe(event => {
        if (event.type === "tool_execution_update" && event.toolName === "subagent") {
          const detail = event.partialResult?.details as unknown as Run | undefined;
          if (detail?.status) states.push(detail.status);
        }
      });
      await session.bindExtensions({ mode: "print" });
      const pending = session.prompt("Delegate the work.");
      if (outcome === "cancel" || outcome === "shutdown") {
        await new Promise(resolve => originalTimer(resolve, 100));
        const inspector = new Runtime(join(directory, "runs"));
        const [active] = await inspector.list(session.sessionManager.getSessionId());
        // A second runtime sees disk state as interrupted, while active host updates retain Pausing.
        assert.ok(active);
        assert.ok(states.includes("pausing"), "stuck tool remains visibly Pausing");
        const models = createModels(); models.setProvider(faux.provider);
        await assert.rejects(inspector.execute({ ...active, id: runId("competitor", outcome), task: "Competing workspace task" }, { models, tools: [] }), /already being held/);
        if (outcome === "cancel") await session.abort();
        else await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        await pending;
        const [stopped] = await inspector.list(session.sessionManager.getSessionId());
        assert.equal(stopped.status, outcome === "cancel" ? "aborted" : "interrupted");
        await assert.rejects(readFile(join(directory, "evidence.txt")), /ENOENT/);
        return;
      }
      await pending;
      const result = session.messages.find(message => message.role === "toolResult" && message.toolName === "subagent");
      assert.ok(result && result.role === "toolResult");
      assert.equal(workCalls, 1, "only the already admitted tool may change the workspace");
      assert.equal(await readFile(join(directory, "evidence.txt"), "utf8"), "useful work finished");
      const run = result.details as unknown as Run;
      assert.equal(run.status, "paused");
      if (outcome === "permanent-error") assert.match(run.handoffLimitation!, /400 Permanent handoff failure/);
      else assert.equal(run.handoff, "Checkpoint: evidence written. Remaining: second change.");
      const inspector = new Runtime(join(directory, "runs"));
      assert.equal((await inspector.list(session.sessionManager.getSessionId()))[0].status, "paused", "reopening must preserve the allowance pause");
      assert.equal(run.output, undefined);
      assert.ok(states.includes("pausing"));
      assert.ok(states.includes("preparing-handoff"));
      const models = createModels(); models.setProvider(faux.provider);
      faux.setResponses([fauxAssistantMessage("Ownership reacquired safely.")]);
      const next = await inspector.execute({ ...run, id: runId("competitor", outcome), task: "New authorized task", status: "running", handoff: undefined }, { models, tools: [] });
      assert.equal(next.status, "succeeded", "safe pause releases workspace ownership");
    } finally {
      globalThis.setTimeout = originalTimer;
      if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
      if (oldStorage === undefined) delete process.env.PI_SUBAGENT_STORAGE; else process.env.PI_SUBAGENT_STORAGE = oldStorage;
      if (oldAgents === undefined) delete process.env.PI_SUBAGENT_AGENTS; else process.env.PI_SUBAGENT_AGENTS = oldAgents;
      await rm(directory, { recursive: true, force: true });
    }
  });
}
