import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import extension from "../index.ts";
import { cleanupWorktreeHostFixture, initializeWorktreeHostRepo } from "./fixtures/worktree-host.ts";

const run = promisify(execFile);
const agentDirectory = fileURLToPath(new URL("./fixtures/agents/", import.meta.url));

test("a real Pi delegated host shell and relative reads use the committed worktree and preserve permission hooks", async () => {
  const repo = await mkdtemp(join(tmpdir(), "durable-host-binding-"));
  const harness = await mkdtemp(join(tmpdir(), "durable-host-binding-state-"));
  const store = join(dirname(repo), `${basename(repo)}-runs`);
  const worktrees = join(dirname(repo), `${basename(repo)}-worktrees`);
  const previous = { agents: process.env.PI_SUBAGENT_AGENTS, storage: process.env.PI_SUBAGENT_STORAGE };
  process.env.PI_SUBAGENT_AGENTS = agentDirectory;
  process.env.PI_SUBAGENT_STORAGE = store;
  const permissionInputs: Array<{ name: string; input: Record<string, unknown> }> = [];
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    await initializeWorktreeHostRepo(repo);
    await writeFile(join(repo, "tracked.txt"), "committed base value\n");
    await writeFile(join(repo, "unicode space.txt"), "unicode space value\n");
    await run("git", ["-C", repo, "add", "tracked.txt", "unicode space.txt"]);
    await run("git", ["-C", repo, "commit", "-qm", "requested base"]);
    await writeFile(join(repo, "tracked.txt"), "parent-only modification\n");
    await writeFile(join(repo, "parent-only.txt"), "parent-only untracked value\n");

    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("subagent", { agent: "scout", task: "Check shell directory and read paths in the assigned checkout.", worktree: true }, { id: "host-binding" })], { stopReason: "toolUse" }),
      (context) => {
        const tools = context.messages.find((message) => message.role === "system")?.toolsAdded ?? [];
        assert.ok(tools.some((tool) => tool.name === "bash"));
        assert.ok(tools.some((tool) => tool.name === "read"));
        assert.ok(!tools.some((tool) => tool.name === "fffind"), "unbound search tools are not exposed in an isolated run");
        return fauxAssistantMessage([fauxToolCall("bash", { command: "printf 'cwd='; pwd; printf 'toplevel='; git rev-parse --show-toplevel" }, { id: "child-shell" })], { stopReason: "toolUse" });
      },
      (context) => {
        const result = context.messages.findLast((message) => message.role === "toolResult");
        assert.ok(result && result.role === "toolResult" && !result.isError);
        const output = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
        const cwd = output.match(/cwd=(.+)/)?.[1];
        const top = output.match(/toplevel=(.+)/)?.[1];
        assert.ok(cwd && cwd !== repo && cwd.endsWith("-worktrees/" + cwd.split("/").at(-1)), output);
        assert.equal(top, cwd, output);
        return fauxAssistantMessage([fauxToolCall("read", { path: "tracked.txt" }, { id: "child-read-base" })], { stopReason: "toolUse" });
      },
      (context) => {
        const result = context.messages.findLast((message) => message.role === "toolResult");
        assert.ok(result && result.role === "toolResult" && !result.isError);
        assert.equal(result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"), "committed base value\n");
        return fauxAssistantMessage([fauxToolCall("read", { path: "@tracked.txt" }, { id: "child-read-at-prefix" })], { stopReason: "toolUse" });
      },
      (context) => {
        const result = context.messages.findLast((message) => message.role === "toolResult");
        assert.ok(result && result.role === "toolResult" && !result.isError);
        assert.equal(result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"), "committed base value\n");
        return fauxAssistantMessage([fauxToolCall("read", { path: "unicode\u00a0space.txt" }, { id: "child-read-unicode-space" })], { stopReason: "toolUse" });
      },
      (context) => {
        const result = context.messages.findLast((message) => message.role === "toolResult");
        assert.ok(result && result.role === "toolResult" && !result.isError);
        assert.equal(result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"), "unicode space value\n");
        return fauxAssistantMessage([fauxToolCall("read", { path: "~/.pi-durable-subagent-path-probe-missing" }, { id: "child-read-tilde" })], { stopReason: "toolUse" });
      },
      (context) => {
        const result = context.messages.findLast((message) => message.role === "toolResult");
        assert.ok(result && result.role === "toolResult" && result.isError, JSON.stringify(result));
        return fauxAssistantMessage([fauxToolCall("read", { path: pathToFileURL(join(repo, "parent-only.txt")).href }, { id: "child-read-file-url" })], { stopReason: "toolUse" });
      },
      (context) => {
        const result = context.messages.findLast((message) => message.role === "toolResult");
        assert.ok(result && result.role === "toolResult" && !result.isError);
        assert.equal(result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"), "parent-only untracked value\n");
        return fauxAssistantMessage([fauxToolCall("read", { path: "parent-only.txt" }, { id: "child-read-parent-only" })], { stopReason: "toolUse" });
      },
      (context) => {
        const result = context.messages.findLast((message) => message.role === "toolResult");
        assert.ok(result && result.role === "toolResult" && result.isError, JSON.stringify(result));
        return fauxAssistantMessage([fauxText("Shell and relative reads used the assigned committed worktree; normalized absolute paths kept host semantics.")]);
      },
      fauxAssistantMessage([fauxText("The isolated checkout was verified.")]),
    ]);
    const modelRuntime = await ModelRuntime.create({ authPath: join(harness, "auth.json"), modelsPath: null, modelsStorePath: join(harness, "models.json"), refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const settingsManager = SettingsManager.inMemory({ defaultTools: ["read", "bash", "subagent"] });
    const loader = new DefaultResourceLoader({ cwd: repo, agentDir: repo, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [
        (pi) => { pi.on("tool_call", (event) => {
          if (event.parentToolCallId && (event.toolName === "bash" || event.toolName === "read")) {
            permissionInputs.push({ name: event.toolName, input: { ...event.input } });
          }
        }); },
        extension,
      ],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd: repo, agentDir: repo, modelRuntime, model: modelRuntime.getModel("faux", "faux-1")!,
      settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(repo), thinkingLevel: "off" }));
    await session.prompt("Delegate shell and file checks to an isolated checkout.");

    const delegation = session.messages.find((message) => message.role === "toolResult" && message.toolName === "subagent");
    assert.ok(delegation && delegation.role === "toolResult");
    assert.equal(delegation.isError, false, JSON.stringify(delegation.content));
    const reportDetails = delegation.details as { output?: string; worktree?: { path: string } } | undefined;
    const report = reportDetails?.output;
    const worktree = reportDetails?.worktree?.path;
    assert.ok(worktree, JSON.stringify(reportDetails));
    assert.match(report ?? "", /normalized absolute paths kept host semantics/);
    const shell = permissionInputs.find((entry) => entry.name === "bash");
    assert.ok(shell && typeof shell.input.command === "string");
    assert.match(shell.input.command as string, /^\(cd -- '.*-worktrees\/.*' && \{/);
    const reads = permissionInputs.filter((entry) => entry.name === "read");
    assert.equal(reads.length, 6);
    assert.ok(reads.slice(0, 3).every((entry) => typeof entry.input.path === "string" && (entry.input.path as string).includes("-worktrees/") && !(entry.input.path as string).startsWith(repo)), JSON.stringify(permissionInputs));
    assert.equal(reads[1].input.path, join(worktree, "tracked.txt"), "@ paths use Pi's strip-prefix rule before checkout binding");
    assert.equal(reads[2].input.path, join(worktree, "unicode space.txt"), "Pi-normalized Unicode spaces remain checkout-relative");
    assert.equal(reads[3].input.path, join(homedir(), ".pi-durable-subagent-path-probe-missing"), "tilde paths expand to the host home directory");
    assert.equal(reads[4].input.path, join(repo, "parent-only.txt"), "file URL absolute paths retain their existing host-policy target after Pi normalization");
    assert.equal(reads[5].input.path, join(worktree, "parent-only.txt"), "a parent-only relative file is checked inside the worktree");
    assert.equal(await readFile(join(repo, "tracked.txt"), "utf8"), "parent-only modification\n");
    assert.equal(await readFile(join(repo, "parent-only.txt"), "utf8"), "parent-only untracked value\n");
  } finally {
    if (previous.agents === undefined) delete process.env.PI_SUBAGENT_AGENTS; else process.env.PI_SUBAGENT_AGENTS = previous.agents;
    if (previous.storage === undefined) delete process.env.PI_SUBAGENT_STORAGE; else process.env.PI_SUBAGENT_STORAGE = previous.storage;
    try { session?.dispose?.(); } catch {}
    await cleanupWorktreeHostFixture({ repo, harness, store, worktrees });
  }
});
