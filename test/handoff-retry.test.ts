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

for (const outcome of ["transient-success", "exhausted", "permanent", "empty-corrected", "empty-repeat", "empty-exhausted", "empty-budget", "unlimited", "cancel-backoff", "shutdown-backoff"] as const) {
test(`host handoff retries: ${outcome}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "durable-policy-"));
    const errors = outcome === "unlimited" ? 4 : outcome === "exhausted" ? 4 : outcome === "permanent" ? 1 : outcome.includes("backoff") ? 4 : outcome === "transient-success" || outcome === "empty-budget" ? 2 : 0;
    let handoffRequests = 0;
    const oldStorage = process.env.PI_SUBAGENT_STORAGE, oldAgents = process.env.PI_SUBAGENT_AGENTS;
    process.env.PI_SUBAGENT_STORAGE = join(directory, "runs");
    process.env.PI_SUBAGENT_AGENTS = join(directory, "agents");
    const originalTimer = globalThis.setTimeout;

    let workCalls = 0;
    const states: string[] = [];
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      await mkdir(join(directory, "agents"));
      await writeFile(join(directory, "agents", "worker.md"), `---\nname: worker\ndescription: Policy fixture\ntools: [policy_work]\ntimeoutMinutes: 1\n---\nComplete the work.\n`);
      const faux = fauxProvider();
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("subagent", { agent: "worker", task: "Produce evidence.", ...(outcome === "unlimited" || outcome.includes("backoff") ? { handoffRetryPolicy: "unlimited" } : {}), timeoutMinutes: 1 })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxToolCall("policy_work", {}), fauxToolCall("policy_work", {})], { stopReason: "toolUse" }),
        fauxAssistantMessage("Work stopped."),
        ...Array.from({ length: errors }, () => (context: Context) => {
          if (context.messages.some(message => message.role === "toolResult" && message.toolName === "subagent")) return fauxAssistantMessage("Parent completed.");
          handoffRequests++;
          assert.deepEqual(context.tools ?? [], [], "even failed handoffs expose no work tools");
          return fauxAssistantMessage([], { stopReason: "error", errorMessage: outcome === "permanent" ? "401 Unauthorized" : "503 Service unavailable" });
        }),
        ...(outcome.startsWith("empty") ? [(context: Context) => { handoffRequests++; assert.deepEqual(context.tools ?? [], []); return fauxAssistantMessage(""); }] : []),
        ...(outcome === "empty-budget" ? Array.from({ length: 2 }, () => (context: Context) => {
          handoffRequests++;
          assert.deepEqual(context.tools ?? [], []);
          return fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 Service unavailable" });
        }) : []),
        ...(outcome === "exhausted" || outcome === "permanent" || outcome === "empty-budget" ? [] : [(context: Context) => {
          if (context.messages.some(message => message.role === "toolResult" && message.toolName === "subagent")) return fauxAssistantMessage("Parent completed.");
          handoffRequests++;
          assert.deepEqual(context.tools ?? [], [], "handoff exposes no work tools");
          return fauxAssistantMessage(outcome === "empty-exhausted" ? "" : "Checkpoint: evidence written. Remaining: second change.");
        }]),
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
              const workTimer = originalTimer(() => { signal?.removeEventListener("abort", abort); resolve(); }, 100);
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
      if (outcome.includes("backoff")) {
        while (handoffRequests === 0) await new Promise(resolve => originalTimer(resolve, 5));
        const inspector = new Runtime(join(directory, "runs"));
        const [active] = await inspector.list(session.sessionManager.getSessionId());
        const models = createModels(); models.setProvider(faux.provider);
        await assert.rejects(inspector.execute({ ...active, id: runId("competitor", outcome), task: "Competing workspace task" }, { models, tools: [] }), /already being held/);
        if (outcome === "cancel-backoff") await session.abort();
        else await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        await pending;
        const [stopped] = await inspector.list(session.sessionManager.getSessionId());
        assert.equal(stopped.status, outcome === "cancel-backoff" ? "aborted" : "interrupted");
        assert.equal(handoffRequests, 1);
        assert.equal(workCalls, 1);
        if (outcome === "shutdown-backoff") {
          assert.equal(stopped.interruptedPhase, "preparing-handoff");
          await assert.rejects(inspector.execute(stopped, { models, tools: [] }), /Explicit resume approval required/);
          faux.setResponses([(context: Context) => {
            assert.match(JSON.stringify(context.messages), /operator approved recovery/);
            return fauxAssistantMessage("Recovered remaining work after interrupted handoff.");
          }]);
          const recovered = await inspector.execute(stopped, { models, tools: [], recoveryApproved: true });
          assert.equal(recovered.status, "succeeded");
          assert.equal(recovered.output, "Recovered remaining work after interrupted handoff.");
          assert.equal(recovered.executionAttempt, 1, "recovery cannot retrieve the earlier work submission");
          assert.equal(workCalls, 1, "recovery does not replay completed tools");
        }
        return;
      }
      await pending;
      const result = session.messages.find(message => message.role === "toolResult" && message.toolName === "subagent");
      assert.ok(result && result.role === "toolResult");
      assert.equal(workCalls, 1, "only the already admitted tool may change the workspace");
      assert.equal(await readFile(join(directory, "evidence.txt"), "utf8"), "useful work finished");
      const run = result.details as unknown as Run;
      assert.equal(run.status, "paused");
      if (outcome === "exhausted" || outcome === "permanent" || outcome === "empty-budget") assert.match(run.handoffLimitation!, /503|401/);
      else if (outcome === "empty-exhausted") assert.match(run.handoffLimitation!, /no text/);
      else assert.equal(run.handoff, "Checkpoint: evidence written. Remaining: second change.");
      assert.equal(handoffRequests, outcome === "empty-budget" ? 5 : outcome === "exhausted" ? 4 : outcome === "permanent" ? 1 : outcome.startsWith("empty") ? 2 : errors + 1);
      assert.equal(run.handoffCorrected, outcome.startsWith("empty"));
      assert.ok(run.usage, "provider usage remains recorded on every outcome");
      assert.equal(run.handoffRetries, outcome === "exhausted" || outcome === "empty-budget" ? 3 : outcome === "permanent" ? 0 : errors);
      if (outcome === "empty-repeat") {
        const before = run.usage!.totalTokens;
        let correctionCalls = 0;
        faux.setResponses([
          fauxAssistantMessage([fauxToolCall("subagent", { resume: run.id, reassessment: "Continue the remaining change with another allowance.", timeoutMinutes: 1 })], { stopReason: "toolUse" }),
          fauxAssistantMessage([fauxToolCall("policy_work", {})], { stopReason: "toolUse" }),
          fauxAssistantMessage("Second work period stopped."),
          (context: Context) => { assert.deepEqual(context.tools ?? [], []); return fauxAssistantMessage(""); },
          (context: Context) => { correctionCalls++; assert.deepEqual(context.tools ?? [], []); return fauxAssistantMessage("New checkpoint after continuation."); },
          fauxAssistantMessage("Parent received second checkpoint."),
        ]);
        await session.prompt("Continue after reassessing remaining work.");
        const result = session.messages.findLast(message => message.role === "toolResult" && message.toolName === "subagent");
        assert.ok(result && result.role === "toolResult");
        const continued = result.details as unknown as Run;
        assert.equal(continued.status, "paused");
        assert.equal(continued.handoff, "New checkpoint after continuation.");
        assert.equal(continued.handoffCorrected, true);
        assert.equal(continued.executionAttempt, 1);
        assert.equal(correctionCalls, 1, "a new pause must request a new correction rather than retrieve a cached checkpoint");
        assert.equal(workCalls, 2, "only new authorized work executes");
        assert.equal(result.usage!.totalTokens, continued.usage!.totalTokens - before);
        return;
      }
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
