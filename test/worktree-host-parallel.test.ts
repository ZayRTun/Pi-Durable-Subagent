import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { WORKSPACE_INDEPENDENT_TOOL_INSTRUCTION } from "../adapters.ts";
import extension from "../index.ts";

const run = promisify(execFile);

test("parallel worktree children keep real host shell, read, and write effects isolated while the parent inspects", { timeout: 30_000 }, async () => {
  const repo = await mkdtemp(join(tmpdir(), "durable-host-parallel-"));
  const harness = await mkdtemp(join(tmpdir(), "durable-host-parallel-state-"));
  const store = join(dirname(repo), `${basename(repo)}-runs`);
  const worktrees = join(dirname(repo), `${basename(repo)}-worktrees`);
  const old = { agents: process.env.PI_SUBAGENT_AGENTS, storage: process.env.PI_SUBAGENT_STORAGE };
  process.env.PI_SUBAGENT_AGENTS = harness;
  process.env.PI_SUBAGENT_STORAGE = store;

  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let groupId = "";
  let operation: "start" | "inspect-during" | "wait" | "inspect-after" = "start";
  const arrivals = new Set<string>();
  let signalBothArrived!: () => void;
  const bothArrived = new Promise<void>((resolve) => { signalBothArrived = resolve; });
  let releaseBarrier!: () => void;
  const barrierReleased = new Promise<void>((resolve) => { releaseBarrier = resolve; });
  const parentReadResults: string[] = [];
  const childShellResults: Record<string, string> = {};
  const childReadResults: Record<string, string> = {};

  try {
    await writeFile(join(harness, "scout.md"), [
      "---", "name: scout", "description: Parallel workspace fixture", "tools: [bash, read, write, barrier]", "---", "Use the barrier, then verify shell and file operations in your assigned checkout.", "",
    ].join("\n"));
    await run("git", ["init", "-q", repo]);
    await run("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
    await run("git", ["-C", repo, "config", "user.name", "Test"]);
    await writeFile(join(repo, "shared.txt"), "committed shared value\n");
    await writeFile(join(repo, "same-name.txt"), "committed parent value\n");
    await run("git", ["-C", repo, "add", "shared.txt", "same-name.txt"]);
    await run("git", ["-C", repo, "commit", "-qm", "parallel fixture base"]);
    await writeFile(join(repo, "same-name.txt"), "dirty parent value\n");
    await writeFile(join(repo, "parent-only.txt"), "parent-only value\n");
    const parentFilesBefore = (await readdir(repo)).sort();

    const faux = fauxProvider();
    faux.setResponses(Array.from({ length: 80 }, () => (context) => {
      const tools = context.messages.find((message) => message.role === "system")?.toolsAdded ?? [];
      const isParent = tools.some((tool) => tool.name === "subagent");
      if (isParent) {
        if (context.messages.at(-1)?.role === "toolResult") return fauxAssistantMessage("Parent operation completed.");
        if (operation === "start") {
          return fauxAssistantMessage([fauxToolCall("subagent", {
            agent: "scout",
            tasks: [
              { task: "PARALLEL_RED_CHILD: wait at the barrier, then run shell, read shared.txt, and write RED_VALUE to same-name.txt.", timeoutMinutes: null },
              { task: "PARALLEL_BLUE_CHILD: wait at the barrier, then run shell, read shared.txt, and write BLUE_VALUE to same-name.txt.", timeoutMinutes: null },
            ],
            worktree: true,
            nonblocking: true,
          }, { id: "parallel-worktree-start" })], { stopReason: "toolUse" });
        }
        if (operation === "inspect-during") {
          return fauxAssistantMessage([fauxToolCall("read", { path: "parent-only.txt" }, { id: "parent-inspect-during" })], { stopReason: "toolUse" });
        }
        if (operation === "wait") {
          return fauxAssistantMessage([fauxToolCall("subagent_wait", { run: groupId, waitSeconds: 15 }, { id: "parallel-worktree-wait" })], { stopReason: "toolUse" });
        }
        return fauxAssistantMessage([fauxToolCall("read", { path: "same-name.txt" }, { id: "parent-inspect-after" })], { stopReason: "toolUse" });
      }

      const conversation = JSON.stringify(context.messages);
      const child = conversation.includes("PARALLEL_RED_CHILD") ? "RED" : conversation.includes("PARALLEL_BLUE_CHILD") ? "BLUE" : undefined;
      assert.ok(child, "child request retains its task identity");
      const lastResult = context.messages.findLast((message) => message.role === "toolResult");
      if (!lastResult) return fauxAssistantMessage([fauxToolCall("barrier", { child }, { id: `barrier-${child}` })], { stopReason: "toolUse" });
      if (lastResult.toolName === "barrier") {
        return fauxAssistantMessage([fauxToolCall("bash", { command: "printf 'cwd='; pwd; printf 'toplevel='; git rev-parse --show-toplevel" }, { id: `shell-${child}` })], { stopReason: "toolUse" });
      }
      if (lastResult.toolName === "bash") {
        const output = lastResult.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
        childShellResults[child] = output;
        const cwd = output.match(/cwd=(.+)/)?.[1];
        const top = output.match(/toplevel=(.+)/)?.[1];
        assert.ok(cwd && cwd.includes("-worktrees/"), output);
        assert.equal(top, cwd, output);
        return fauxAssistantMessage([fauxToolCall("read", { path: "shared.txt" }, { id: `read-${child}` })], { stopReason: "toolUse" });
      }
      if (lastResult.toolName === "read") {
        const output = lastResult.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
        childReadResults[child] = output;
        assert.equal(output, "committed shared value\n");
        return fauxAssistantMessage([fauxToolCall("write", { path: "same-name.txt", content: `${child}_VALUE\n` }, { id: `write-${child}` })], { stopReason: "toolUse" });
      }
      assert.equal(lastResult.toolName, "write");
      assert.equal(lastResult.isError, false, JSON.stringify(lastResult));
      return fauxAssistantMessage([fauxText(`${child} used its assigned checkout.`)]);
    }));

    const modelRuntime = await ModelRuntime.create({ authPath: join(harness, "auth.json"), modelsPath: null, modelsStorePath: join(harness, "models.json"), refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const settingsManager = SettingsManager.inMemory({ defaultTools: ["read", "write", "bash", "subagent", "subagent_wait"] });
    const loader = new DefaultResourceLoader({ cwd: repo, agentDir: repo, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [
        (pi) => pi.registerTool({
          name: "barrier", label: "Two-child barrier", exposure: "codemode",
          namespace: { name: "parallel-fixture", instructions: WORKSPACE_INDEPENDENT_TOOL_INSTRUCTION },
          description: "Wait until both parallel children have reached the controlled overlap point.",
          parameters: Type.Object({ child: Type.String() }),
          async execute(_id, args) {
            arrivals.add(args.child);
            if (arrivals.size === 2) signalBothArrived();
            await barrierReleased;
            return { content: [{ type: "text", text: `released ${args.child}` }], details: undefined };
          },
        }),
        extension,
      ],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd: repo, agentDir: repo, modelRuntime, model: modelRuntime.getModel("faux", "faux-1")!,
      settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(repo), thinkingLevel: "off" }));

    await session.prompt("Start both isolated parallel children.");
    const started = session.messages.findLast((message) => message.role === "toolResult" && message.toolName === "subagent");
    assert.ok(started && started.role === "toolResult");
    assert.equal(started.isError, false, JSON.stringify({ content: started.content, details: started.details }));
    const group = started.details as { id: string; steps: { status: string }[] } | undefined;
    assert.ok(group?.id);
    groupId = group.id;

    let barrierTimeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([bothArrived, new Promise<void>((_resolve, reject) => {
        barrierTimeout = setTimeout(() => reject(new Error(`children did not reach the barrier: ${JSON.stringify(started.details)}`)), 3_000);
      })]);
    } finally { if (barrierTimeout) clearTimeout(barrierTimeout); }
    assert.deepEqual([...arrivals].sort(), ["BLUE", "RED"], "both children are concurrently held at the deterministic barrier");
    operation = "inspect-during";
    await session.prompt("Read the parent-only file while both children are held.");
    const during = session.messages.findLast((message) => message.role === "toolResult" && message.toolName === "read");
    assert.ok(during && during.role === "toolResult");
    assert.equal(during.isError, false, JSON.stringify(during.content));
    parentReadResults.push(during.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
    assert.equal(parentReadResults[0], "parent-only value\n");
    releaseBarrier();

    operation = "wait";
    await session.prompt("Wait for the parallel children to finish.");
    const waited = session.messages.findLast((message) => message.role === "toolResult" && message.toolName === "subagent_wait");
    assert.ok(waited && waited.role === "toolResult");
    assert.equal(waited.isError, false, JSON.stringify({ content: waited.content, details: waited.details }));
    const completed = waited.details as { status: string; steps: { status: string; cwd: string }[] } | undefined;
    assert.equal(completed?.status, "succeeded", JSON.stringify(waited.details));
    assert.deepEqual(completed?.steps.map((step) => step.status), ["succeeded", "succeeded"]);
    assert.equal(new Set(completed?.steps.map((step) => step.cwd)).size, 2, "each child retains a distinct actual checkout");
    const [red, blue] = completed!.steps;
    const redPath = childShellResults.RED.match(/cwd=(.+)/)?.[1];
    const bluePath = childShellResults.BLUE.match(/cwd=(.+)/)?.[1];
    assert.equal(red.cwd, redPath);
    assert.equal(blue.cwd, bluePath);
    assert.equal(childReadResults.RED, "committed shared value\n");
    assert.equal(childReadResults.BLUE, "committed shared value\n");
    assert.equal(await readFile(join(red.cwd, "same-name.txt"), "utf8"), "RED_VALUE\n");
    assert.equal(await readFile(join(blue.cwd, "same-name.txt"), "utf8"), "BLUE_VALUE\n");
    assert.equal(await readFile(join(repo, "same-name.txt"), "utf8"), "dirty parent value\n");
    assert.equal(await readFile(join(repo, "parent-only.txt"), "utf8"), "parent-only value\n");
    assert.deepEqual((await readdir(repo)).sort(), parentFilesBefore);

    operation = "inspect-after";
    await session.prompt("Read the parent's modified file after both children finish.");
    const after = session.messages.findLast((message) => message.role === "toolResult" && message.toolName === "read");
    assert.ok(after && after.role === "toolResult");
    assert.equal(after.isError, false, JSON.stringify(after.content));
    parentReadResults.push(after.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
    assert.equal(parentReadResults[1], "dirty parent value\n");
  } finally {
    releaseBarrier?.();
    if (old.agents === undefined) delete process.env.PI_SUBAGENT_AGENTS; else process.env.PI_SUBAGENT_AGENTS = old.agents;
    if (old.storage === undefined) delete process.env.PI_SUBAGENT_STORAGE; else process.env.PI_SUBAGENT_STORAGE = old.storage;
    try { session?.dispose?.(); } catch {}
    try { await run("git", ["-C", repo, "worktree", "prune"]); } catch {}
    await rm(worktrees, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
    await rm(harness, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});
