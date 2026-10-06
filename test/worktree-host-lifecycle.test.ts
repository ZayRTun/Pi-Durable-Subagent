import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { type Context } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import extension from "../index.ts";
import type { Run } from "../runtime.ts";
import { cleanupWorktreeHostFixture, initializeWorktreeHostRepo } from "./fixtures/worktree-host.ts";

const run = promisify(execFile);
const agents = fileURLToPath(new URL("./fixtures/agents/", import.meta.url));

test("a worktree Follow-up retains its conversation and performs relative reads and writes in the assigned checkout", async () => {
  const repo = await mkdtemp(join(tmpdir(), "durable-worktree-lifecycle-"));
  const harness = await mkdtemp(join(tmpdir(), "durable-worktree-lifecycle-state-"));
  const store = join(dirname(repo), `${basename(repo)}-runs`);
  const worktrees = join(dirname(repo), `${basename(repo)}-worktrees`);
  const previous = { agents: process.env.PI_SUBAGENT_AGENTS, storage: process.env.PI_SUBAGENT_STORAGE };
  process.env.PI_SUBAGENT_AGENTS = agents;
  process.env.PI_SUBAGENT_STORAGE = store;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let childStep = 0;
  let toolCalls = 0;
  let initialIssued = false;
  const followupsIssued = new Set<string>();
  let childGenerations = 0;
  try {
    await initializeWorktreeHostRepo(repo);
    await writeFile(join(repo, "base.txt"), "committed checkout value\n");
    await run("git", ["-C", repo, "add", "base.txt"]);
    await run("git", ["-C", repo, "commit", "-qm", "requested base"]);
    await writeFile(join(repo, "base.txt"), "parent-only modification\n");

    const faux = fauxProvider();
    const isParent = (context: Context) =>
      context.messages.some(message => message.role === "system" && message.toolsAdded?.some(tool => tool.name === "subagent"));
    faux.setResponses(Array.from({ length: 40 }, () => context => {
      if (isParent(context)) {
        const latest = JSON.stringify(context.messages.findLast(message => message.role === "user"));
        if (!initialIssued && latest.includes("Delegate initial checkout")) {
          initialIssued = true;
          return fauxAssistantMessage([fauxToolCall("subagent", {
          agent: "worker", task: "Complete the initial checkout task.", worktree: true,
        }, { id: "lifecycle-delegate" })], { stopReason: "toolUse" });
        }
        if ((latest.includes("Start retained-context follow-up") || latest.includes("Start follow-up after checkout replacement") || latest.includes("Start follow-up after checkout removal")) && !followupsIssued.has(latest)) {
          followupsIssued.add(latest);
          return fauxAssistantMessage([fauxToolCall("subagent_followup", {
          run: context.messages.filter(message => message.role === "toolResult" && message.toolName === "subagent").at(-1)?.role === "toolResult"
            ? ((context.messages.filter(message => message.role === "toolResult" && message.toolName === "subagent").at(-1) as { details?: Run }).details?.id ?? "missing-run")
            : "missing-run",
          task: "Follow-up: read base.txt and create followup.txt.",
          reuse: true,
        }, { id: "lifecycle-follow-up" })], { stopReason: "toolUse" });
        }
        return fauxAssistantMessage("Parent complete.");
      }

      childGenerations++;
      const latest = JSON.stringify(context.messages.findLast(message => message.role === "user"));
      const result = context.messages.findLast(message => message.role === "toolResult");
      if (latest.includes("initial checkout task")) {
        if (childStep++ === 0) return fauxAssistantMessage([fauxToolCall("write", {
          path: "initial.txt", content: "initial effect\n",
        }, { id: "initial-effect" })], { stopReason: "toolUse" });
        assert.ok(result && result.role === "toolResult" && !result.isError, JSON.stringify(result));
        return fauxAssistantMessage("Initial checkout task completed.");
      }

      assert.ok(latest.includes("Follow-up: read base.txt"), latest);
      if (childStep++ === 0) return fauxAssistantMessage([fauxToolCall("read", { path: "base.txt" }, { id: "followup-read" })], { stopReason: "toolUse" });
      if (childStep === 2) {
        assert.ok(result && result.role === "toolResult" && !result.isError, JSON.stringify(result));
        assert.equal(result.content.filter(part => part.type === "text").map(part => part.text).join("\n"), "committed checkout value\n");
        return fauxAssistantMessage([fauxToolCall("write", { path: "followup.txt", content: "follow-up effect\n" }, { id: "followup-write" })], { stopReason: "toolUse" });
      }
      assert.ok(result && result.role === "toolResult" && !result.isError, JSON.stringify(result));
      toolCalls++;
      return fauxAssistantMessage("Follow-up read the committed checkout value and wrote in the retained workspace.");
    }));

    const models = await ModelRuntime.create({ authPath: join(harness, "auth.json"), modelsPath: null, modelsStorePath: join(harness, "models.json"), refreshOnCreate: false });
    models.registerNativeProvider(faux.provider);
    const settings = SettingsManager.inMemory({ defaultTools: ["subagent", "subagent_followup", "read", "write"] });
    const loader = new DefaultResourceLoader({ cwd: repo, agentDir: repo, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [extension],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd: repo, agentDir: repo, modelRuntime: models, model: models.getModel("faux", "faux-1")!,
      settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.inMemory(repo), thinkingLevel: "off" }));

    await session.prompt("Delegate initial checkout work.");
    const originalResult = session.messages.findLast(message => message.role === "toolResult" && message.toolName === "subagent");
    assert.ok(originalResult && originalResult.role === "toolResult" && !originalResult.isError, JSON.stringify(originalResult));
    const original = originalResult.details as unknown as Run;
    assert.equal(original.status, "succeeded");
    assert.equal(await readFile(join(original.worktree!.path, "initial.txt"), "utf8"), "initial effect\n");
    assert.equal(await readFile(join(repo, "base.txt"), "utf8"), "parent-only modification\n");

    childStep = 0;
    await session.prompt("Start retained-context follow-up.");
    const followupResult = session.messages.findLast(message => message.role === "toolResult" && message.toolName === "subagent_followup");
    assert.ok(followupResult && followupResult.role === "toolResult" && !followupResult.isError, JSON.stringify(followupResult));
    const followup = followupResult.details as unknown as Run;
    assert.notEqual(followup.id, original.id);
    assert.equal(followup.conversationId, original.id);
    assert.equal(followup.previousExecutionId, original.id);
    assert.deepEqual(followup.worktree, original.worktree);
    assert.equal(followup.cwd, original.cwd);
    assert.equal(followup.status, "succeeded");
    assert.equal(await readFile(join(original.worktree!.path, "base.txt"), "utf8"), "committed checkout value\n");
    assert.equal(await readFile(join(original.worktree!.path, "followup.txt"), "utf8"), "follow-up effect\n");
    assert.equal(await readFile(join(original.worktree!.path, "initial.txt"), "utf8"), "initial effect\n", "Follow-up must not replay completed effects");
    assert.equal(await readFile(join(repo, "base.txt"), "utf8"), "parent-only modification\n");
    await assert.rejects(readFile(join(repo, "followup.txt"), "utf8"), { code: "ENOENT" });
    assert.equal(toolCalls, 1);

    const movedCheckout = `${original.worktree!.path}-moved`;
    await run("mv", [original.worktree!.path, movedCheckout]);
    await symlink(movedCheckout, original.worktree!.path);
    const generationsBeforeSymlinkedCheckout = childGenerations;
    await session.prompt("Start follow-up after checkout replacement.");
    const replaced = session.messages.findLast(message => message.role === "toolResult" && message.toolName === "subagent_followup");
    assert.ok(replaced && replaced.role === "toolResult" && replaced.isError, JSON.stringify(replaced));
    assert.match(JSON.stringify(replaced.content), /Retained worktree.*unavailable or changed.*will not use the parent workspace/i);
    assert.equal(childGenerations, generationsBeforeSymlinkedCheckout, "A symlink replacement fails before child generation or tools");
    await rm(original.worktree!.path, { force: true });
    await rm(movedCheckout, { recursive: true, force: true });

    await rm(original.worktree!.path, { recursive: true, force: true });
    const generationsBeforeUnavailableFollowup = childGenerations;
    await session.prompt("Start follow-up after checkout removal.");
    const unavailable = session.messages.findLast(message => message.role === "toolResult" && message.toolName === "subagent_followup");
    assert.ok(unavailable && unavailable.role === "toolResult" && unavailable.isError, JSON.stringify(unavailable));
    assert.match(JSON.stringify(unavailable.content), /Retained worktree.*unavailable or changed.*will not use the parent workspace/i);
    assert.equal(childGenerations, generationsBeforeUnavailableFollowup, "An unavailable retained checkout fails before child generation or tool invocation");
  } finally {
    if (previous.agents === undefined) delete process.env.PI_SUBAGENT_AGENTS; else process.env.PI_SUBAGENT_AGENTS = previous.agents;
    if (previous.storage === undefined) delete process.env.PI_SUBAGENT_STORAGE; else process.env.PI_SUBAGENT_STORAGE = previous.storage;
    try { session?.dispose?.(); } catch {}
    await cleanupWorktreeHostFixture({ repo, harness, store, worktrees });
  }
});

test("allowance Continuation retains the assigned worktree and does not repeat a completed effect", { timeout: 15000 }, async () => {
  const repo = await mkdtemp(join(tmpdir(), "durable-worktree-continuation-"));
  const harness = await mkdtemp(join(tmpdir(), "durable-worktree-continuation-state-"));
  const store = join(dirname(repo), `${basename(repo)}-runs`);
  const worktrees = join(dirname(repo), `${basename(repo)}-worktrees`);
  const previous = { agents: process.env.PI_SUBAGENT_AGENTS, storage: process.env.PI_SUBAGENT_STORAGE };
  const originalSetTimeout = globalThis.setTimeout;
  process.env.PI_SUBAGENT_AGENTS = agents;
  process.env.PI_SUBAGENT_STORAGE = store;
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
    originalSetTimeout(fn, delay === 60_000 ? 160 : delay, ...args)) as typeof setTimeout;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let startRequested = false;
  const issued = new Set<string>();
  let childPhase = 0;
  let continuationPhase = 0;
  let childBashStarted!: () => void;
  const bashStarted = new Promise<void>(resolve => { childBashStarted = resolve; });
  try {
    await initializeWorktreeHostRepo(repo);
    await writeFile(join(repo, "base.txt"), "committed base\n");
    await run("git", ["-C", repo, "add", "base.txt"]);
    await run("git", ["-C", repo, "commit", "-qm", "requested base"]);
    const faux = fauxProvider();
    faux.setResponses(Array.from({ length: 40 }, () => context => {
      const isParent = context.messages.some(message => message.role === "system" && message.toolsAdded?.some(tool => tool.name === "subagent"));
      const latest = JSON.stringify(context.messages.findLast(message => message.role === "user"));
      if (isParent) {
        if (!startRequested && latest.includes("Begin allowance-limited checkout work")) {
          startRequested = true;
          return fauxAssistantMessage([fauxToolCall("subagent", {
            agent: "worker", task: "Allowance task: complete two checkout steps.", worktree: true,
            nonblocking: true, timeoutMinutes: 1,
          }, { id: "continuation-start" })], { stopReason: "toolUse" });
        }
        if ((latest.includes("Wait for allowance pause") || latest.includes("Continue allowance task") || latest.includes("Wait for continuation completion")) && !issued.has(latest)) {
          issued.add(latest);
          const start = context.messages.findLast(message => message.role === "toolResult" && message.toolName === "subagent");
          const id = start?.role === "toolResult" ? (start.details as unknown as Run).id : "missing-run";
          if (latest.includes("Wait for allowance pause") || latest.includes("Wait for continuation completion")) return fauxAssistantMessage([fauxToolCall("subagent_wait", {
            run: id, waitSeconds: 5,
          }, { id: "continuation-wait" })], { stopReason: "toolUse" });
          return fauxAssistantMessage([fauxToolCall("subagent", {
            resume: id, reassessment: "The first file is complete; create the second file and finish.", timeoutMinutes: null,
          }, { id: "continuation-resume" })], { stopReason: "toolUse" });
        }
        return fauxAssistantMessage("Parent task complete.");
      }

      if (latest.includes("Continue the original task within its original scope")) {
        if (continuationPhase++ === 0) return fauxAssistantMessage([fauxToolCall("write", {
          path: "continued.txt", content: "continued effect\n",
        }, { id: "continued-effect" })], { stopReason: "toolUse" });
        const result = context.messages.findLast(message => message.role === "toolResult");
        assert.ok(result && result.role === "toolResult" && !result.isError, JSON.stringify(result));
        return fauxAssistantMessage("Both checkout steps are complete.");
      }
      if (latest.includes("tool-free handoff")) return fauxAssistantMessage("HANDOFF: first.txt is complete; continued.txt remains.");
      const result = context.messages.findLast(message => message.role === "toolResult");
      if (childPhase++ === 0) return fauxAssistantMessage([fauxToolCall("write", {
        path: "first.txt", content: "completed before pause\n",
      }, { id: "completed-before-pause" })], { stopReason: "toolUse" });
      if (childPhase === 2) return fauxAssistantMessage([fauxToolCall("bash", {
        command: "sleep 0.35; printf 'boundary reached\\n'",
      }, { id: "allowance-boundary" })], { stopReason: "toolUse" });
      assert.ok(result && result.role === "toolResult" && !result.isError, JSON.stringify(result));
      return fauxAssistantMessage("Initial work is ready to pause.");
    }));
    const models = await ModelRuntime.create({ authPath: join(harness, "auth.json"), modelsPath: null, modelsStorePath: join(harness, "models.json"), refreshOnCreate: false });
    models.registerNativeProvider(faux.provider);
    const settings = SettingsManager.inMemory({ defaultTools: ["subagent", "subagent_wait", "read", "write", "bash"] });
    const loader = new DefaultResourceLoader({ cwd: repo, agentDir: repo, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [extension, pi => { pi.on("tool_call", event => {
        if (event.toolName === "bash" && event.parentToolCallId) childBashStarted();
      }); }],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd: repo, agentDir: repo, modelRuntime: models, model: models.getModel("faux", "faux-1")!,
      settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.inMemory(repo), thinkingLevel: "off" }));
    await session.prompt("Begin allowance-limited checkout work.");
    const started = session.messages.findLast(message => message.role === "toolResult" && message.toolName === "subagent");
    assert.ok(started && started.role === "toolResult" && !started.isError, JSON.stringify(started));
    const original = started.details as unknown as Run;
    await bashStarted;
    await session.prompt("Wait for allowance pause.");
    const pausedResult = session.messages.findLast(message => message.role === "toolResult" && message.toolName === "subagent_wait");
    assert.ok(pausedResult && pausedResult.role === "toolResult" && !pausedResult.isError, JSON.stringify(pausedResult));
    const paused = pausedResult.details as unknown as Run;
    assert.equal(paused.status, "paused");
    assert.match(paused.handoff ?? "", /first.txt is complete/);
    assert.equal(await readFile(join(original.worktree!.path, "first.txt"), "utf8"), "completed before pause\n");
    await assert.rejects(readFile(join(original.worktree!.path, "continued.txt"), "utf8"), { code: "ENOENT" });

    await session.prompt("Continue allowance task.");
    const resumed = session.messages.findLast(message => message.role === "toolResult" && message.toolName === "subagent");
    assert.ok(resumed && resumed.role === "toolResult" && !resumed.isError, JSON.stringify(resumed));
    await session.prompt("Wait for continuation completion.");
    const completion = session.messages.findLast(message => message.role === "toolResult" && message.toolName === "subagent_wait");
    assert.ok(completion && completion.role === "toolResult" && !completion.isError, JSON.stringify(completion));
    const completed = completion.details as unknown as Run;
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.executionAttempt, 1);
    assert.equal(completed.worktree!.path, original.worktree!.path);
    assert.equal(await readFile(join(original.worktree!.path, "first.txt"), "utf8"), "completed before pause\n", "Continuation must not repeat its completed effect");
    assert.equal(await readFile(join(original.worktree!.path, "continued.txt"), "utf8"), "continued effect\n");
    await assert.rejects(readFile(join(repo, "first.txt"), "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(join(repo, "continued.txt"), "utf8"), { code: "ENOENT" });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    if (previous.agents === undefined) delete process.env.PI_SUBAGENT_AGENTS; else process.env.PI_SUBAGENT_AGENTS = previous.agents;
    if (previous.storage === undefined) delete process.env.PI_SUBAGENT_STORAGE; else process.env.PI_SUBAGENT_STORAGE = previous.storage;
    try { session?.dispose?.(); } catch {}
    await cleanupWorktreeHostFixture({ repo, harness, store, worktrees });
  }
});

test("approved worktree Recovery uses current permissions, keeps uncertain effects stopped, and never auto-recovers on reopen", { timeout: 20000 }, async () => {
  const repo = await mkdtemp(join(tmpdir(), "durable-worktree-recovery-"));
  const harness = await mkdtemp(join(tmpdir(), "durable-worktree-recovery-state-"));
  const store = join(dirname(repo), `${basename(repo)}-runs`);
  const worktrees = join(dirname(repo), `${basename(repo)}-worktrees`);
  const previous = { agents: process.env.PI_SUBAGENT_AGENTS, storage: process.env.PI_SUBAGENT_STORAGE };
  process.env.PI_SUBAGENT_AGENTS = agents;
  process.env.PI_SUBAGENT_STORAGE = store;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let loader: DefaultResourceLoader | undefined;
  let originalRunId = "";
  let initialIssued = false;
  let recoveryIssued = false;
  let generations = 0;
  let adapterEpoch = 0;
  let recoveryActive = false;
  let deniedWrites = 0;
  let writeEffects = 0;
  let bashCalls = 0;
  let bashStarted!: () => void;
  const bashReady = new Promise<void>(resolve => { bashStarted = resolve; });
  let cancelBashStarted!: () => void;
  const cancelBashReady = new Promise<void>(resolve => { cancelBashStarted = resolve; });
  let cancelRunId = "";
  const pendingParentActions = new Set<string>();
  try {
    await initializeWorktreeHostRepo(repo);
    await writeFile(join(repo, "base.txt"), "committed recovery base\n");
    await run("git", ["-C", repo, "add", "base.txt"]);
    await run("git", ["-C", repo, "commit", "-qm", "requested base"]);
    const faux = fauxProvider();
    faux.setResponses(Array.from({ length: 80 }, () => context => {
      const isParent = context.messages.some(message => message.role === "system" && message.toolsAdded?.some(tool => tool.name === "subagent"));
      const latest = JSON.stringify(context.messages.findLast(message => message.role === "user"));
      if (isParent) {
        const actionKey = latest;
        if (!pendingParentActions.has(actionKey)) {
          if (latest.includes("Start recoverable worktree work")) {
            pendingParentActions.add(actionKey);
            return fauxAssistantMessage([fauxToolCall("subagent", {
              agent: "worker", task: "Recoverable task: write one file, then wait in bash.", worktree: true, nonblocking: true,
            }, { id: "recovery-start" })], { stopReason: "toolUse" });
          }
          if (latest.includes("Inspect after reopening")) {
            pendingParentActions.add(actionKey);
            return fauxAssistantMessage([fauxToolCall("subagent_status", { run: originalRunId || "missing-run" }, { id: "recovery-status" })], { stopReason: "toolUse" });
          }
          if (latest.includes("Try recovery without approval")) {
            pendingParentActions.add(actionKey);
            return fauxAssistantMessage([fauxToolCall("subagent", { resume: originalRunId || "missing-run" }, { id: "recovery-unapproved" })], { stopReason: "toolUse" });
          }
          if (latest.includes("Approve recovery")) {
            pendingParentActions.add(actionKey);
            return fauxAssistantMessage([fauxToolCall("subagent", { resume: originalRunId || "missing-run" }, { id: "recovery-approved" })], { stopReason: "toolUse" });
          }
          if (latest.includes("Wait for approved recovery")) {
            pendingParentActions.add(actionKey);
            return fauxAssistantMessage([fauxToolCall("subagent_wait", { run: originalRunId || "missing-run", waitSeconds: 5 }, { id: "recovery-wait" })], { stopReason: "toolUse" });
          }
          if (latest.includes("Start cancellable worktree")) {
            pendingParentActions.add(actionKey);
            return fauxAssistantMessage([fauxToolCall("subagent", {
              agent: "worker", task: "Cancellation task: hold in bash until cancelled.", worktree: true, nonblocking: true,
            }, { id: "cancellation-start" })], { stopReason: "toolUse" });
          }
          if (latest.includes("Cancel in-flight worktree tool")) {
            pendingParentActions.add(actionKey);
            return fauxAssistantMessage([fauxToolCall("subagent_cancel", { run: cancelRunId || "missing-run" }, { id: "cancellation-stop" })], { stopReason: "toolUse" });
          }
          if (latest.includes("Retrieve cancelled work")) {
            pendingParentActions.add(actionKey);
            return fauxAssistantMessage([fauxToolCall("subagent", { resume: cancelRunId || "missing-run" }, { id: "cancellation-retrieve" })], { stopReason: "toolUse" });
          }
        }
        return fauxAssistantMessage("Parent stopped the interrupted work until explicitly approved.");
      }

      generations++;
      const result = context.messages.findLast(message => message.role === "toolResult");
      if (latest.includes("Cancellation task")) return fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30" }, { id: "cancellable-bash" })], { stopReason: "toolUse" });
      if (latest.includes("operator approved recovery")) {
        if (!recoveryIssued) {
          recoveryIssued = true;
          return fauxAssistantMessage([fauxToolCall("write", { path: "denied.txt", content: "must not be written\n" }, { id: "current-denied-write" })], { stopReason: "toolUse" });
        }
        assert.ok(result && result.role === "toolResult" && result.isError, JSON.stringify(result));
        assert.match(JSON.stringify(result.content), /Current host permission denied/);
        return fauxAssistantMessage("Recovery respected the current permission decision and retained the earlier completed effect.");
      }
      if (!initialIssued) {
        initialIssued = true;
        return fauxAssistantMessage([fauxToolCall("write", { path: "completed.txt", content: "completed before interruption\n" }, { id: "recovery-completed-effect" })], { stopReason: "toolUse" });
      }
      if (result?.role === "toolResult" && result.toolName === "write") {
        assert.equal(result.isError, false, JSON.stringify(result));
        return fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30" }, { id: "recovery-uncertain-bash" })], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage("Unexpected child generation.");
    }));

    const models = await ModelRuntime.create({ authPath: join(harness, "auth.json"), modelsPath: null, modelsStorePath: join(harness, "models.json"), refreshOnCreate: false });
    models.registerNativeProvider(faux.provider);
    const settings = SettingsManager.inMemory({ defaultTools: ["subagent", "subagent_status", "subagent_wait", "subagent_cancel", "write", "bash"] });
    const manager = SessionManager.inMemory(repo);
    async function open() {
      const ownEpoch = ++adapterEpoch;
      loader = new DefaultResourceLoader({ cwd: repo, agentDir: repo, settingsManager: settings,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        extensionFactories: [extension, pi => { pi.on("tool_call", event => {
          if (event.toolName === "bash" && event.parentToolCallId) {
            bashCalls++;
            if (bashCalls === 1) bashStarted(); else cancelBashStarted();
          }
          if (event.toolName === "write" && event.parentToolCallId) {
            const input = event.input as { path?: unknown };
            if (typeof input.path === "string" && input.path.endsWith("/completed.txt")) writeEffects++;
            if (recoveryActive && typeof input.path === "string" && input.path.endsWith("/denied.txt")) {
              assert.equal(ownEpoch, adapterEpoch, "Recovery must use the current host adapter");
              deniedWrites++;
              return { block: true, reason: "Current host permission denied" };
            }
          }
        }); }],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      ({ session } = await createAgentSession({ cwd: repo, agentDir: repo, modelRuntime: models, model: models.getModel("faux", "faux-1")!,
        settingsManager: settings, resourceLoader: loader, sessionManager: manager, thinkingLevel: "off" }));
    }

    await open();
    await session!.prompt("Start recoverable worktree work.");
    const start = session!.messages.findLast(message => message.role === "toolResult" && message.toolName === "subagent");
    assert.ok(start && start.role === "toolResult" && !start.isError, JSON.stringify(start));
    const original = start.details as unknown as Run;
    originalRunId = original.id;
    await bashReady;
    await session!.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session!.dispose(); session = undefined;
    await open();

    await session!.prompt("Inspect after reopening.");
    const inspected = session!.messages.findLast(message => message.role === "toolResult" && message.toolName === "subagent_status");
    assert.ok(inspected && inspected.role === "toolResult" && !inspected.isError, JSON.stringify(inspected));
    assert.equal((inspected.details as unknown as Run).status, "interrupted");
    assert.equal(generations, 2, "Reopening and retrieval do not resume child model work");
    assert.equal(writeEffects, 1);
    assert.equal(bashCalls, 1);
    assert.equal(await readFile(join(original.worktree!.path, "completed.txt"), "utf8"), "completed before interruption\n");

    const beforeUnapproved = generations;
    await session!.prompt("Try recovery without approval.");
    const unapproved = session!.messages.findLast(message => message.role === "toolResult" && message.toolName === "subagent");
    assert.ok(unapproved && unapproved.role === "toolResult" && unapproved.isError, JSON.stringify(unapproved));
    assert.match(JSON.stringify(unapproved.content), /Explicit resume approval required/);
    assert.equal(generations, beforeUnapproved, "Unapproved recovery invokes no child adapters");
    assert.equal(deniedWrites, 0);

    loader!.getExtensions().runtime.flagValues.set("subagent-resume", original.id);
    recoveryActive = true;
    await session!.prompt("Approve recovery.");
    const recovered = session!.messages.findLast(message => message.role === "toolResult" && message.toolName === "subagent");
    assert.ok(recovered && recovered.role === "toolResult" && !recovered.isError, JSON.stringify(recovered));
    await session!.prompt("Wait for approved recovery.");
    const recoveryCompletion = session!.messages.findLast(message => message.role === "toolResult" && message.toolName === "subagent_wait");
    assert.ok(recoveryCompletion && recoveryCompletion.role === "toolResult" && !recoveryCompletion.isError, JSON.stringify(recoveryCompletion));
    const final = recoveryCompletion.details as unknown as Run;
    assert.equal(final.status, "succeeded");
    assert.equal(final.executionAttempt, 1);
    assert.equal(deniedWrites, 1);
    assert.equal(writeEffects, 1);
    assert.equal(bashCalls, 1, "Recovery does not replay an interrupted unsafe tool");
    assert.ok(final.activityLog?.some(call => call.name === "bash" && call.uncertain));
    assert.equal(await readFile(join(original.worktree!.path, "completed.txt"), "utf8"), "completed before interruption\n");
    await assert.rejects(readFile(join(original.worktree!.path, "denied.txt"), "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(join(repo, "completed.txt"), "utf8"), { code: "ENOENT" });

    const generationsBeforeCancel = generations;
    await session!.prompt("Start cancellable worktree.");
    const cancelStart = session!.messages.findLast(message => message.role === "toolResult" && message.toolName === "subagent");
    assert.ok(cancelStart && cancelStart.role === "toolResult" && !cancelStart.isError, JSON.stringify(cancelStart));
    cancelRunId = (cancelStart.details as unknown as Run).id;
    await cancelBashReady;
    await session!.prompt("Cancel in-flight worktree tool.");
    const cancelled = session!.messages.findLast(message => message.role === "toolResult" && message.toolName === "subagent_cancel");
    assert.ok(cancelled && cancelled.role === "toolResult" && !cancelled.isError, JSON.stringify(cancelled));
    assert.equal((cancelled.details as unknown as Run).status, "aborted");
    const generationsAfterCancel = generations;
    await session!.prompt("Retrieve cancelled work.");
    const retrieved = session!.messages.findLast(message => message.role === "toolResult" && message.toolName === "subagent");
    assert.ok(retrieved && retrieved.role === "toolResult" && !retrieved.isError, JSON.stringify(retrieved));
    assert.equal((retrieved.details as unknown as Run).status, "aborted");
    assert.equal(generations, generationsAfterCancel, "Retrieval does not restart cancelled work");
    assert.equal(bashCalls, 2, "Cancellation reaches the second in-flight child tool and terminal retrieval does not invoke it again");
    assert.ok(generationsAfterCancel > generationsBeforeCancel);
  } finally {
    if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
    if (previous.agents === undefined) delete process.env.PI_SUBAGENT_AGENTS; else process.env.PI_SUBAGENT_AGENTS = previous.agents;
    if (previous.storage === undefined) delete process.env.PI_SUBAGENT_STORAGE; else process.env.PI_SUBAGENT_STORAGE = previous.storage;
    await cleanupWorktreeHostFixture({ repo, harness, store, worktrees });
  }
});
