import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { coreBuiltinToolNames, WORKSPACE_INDEPENDENT_TOOL_INSTRUCTION } from "../adapters.ts";
import extension from "../index.ts";
import { cleanupWorktreeHostFixture, initializeWorktreeHostRepo } from "./fixtures/worktree-host.ts";

const run = promisify(execFile);
const agentDirectory = fileURLToPath(new URL("./fixtures/agents/", import.meta.url));

test("real Pi delegated discovery and search tools use the assigned checkout for explicit and omitted scopes", async () => {
  const repo = await mkdtemp(join(tmpdir(), "durable-host-search-"));
  const harness = await mkdtemp(join(tmpdir(), "durable-host-search-state-"));
  const store = join(dirname(repo), `${basename(repo)}-runs`);
  const agents = join(harness, "agents");
  const worktrees = join(dirname(repo), `${basename(repo)}-worktrees`);
  const previous = { agents: process.env.PI_SUBAGENT_AGENTS, storage: process.env.PI_SUBAGENT_STORAGE };
  process.env.PI_SUBAGENT_AGENTS = agents;
  process.env.PI_SUBAGENT_STORAGE = store;
  const hostInputs: Array<{ name: string; input: Record<string, unknown> }> = [];
  let unboundCalls = 0;
  const independentCalls: string[] = [];
  const sourceInfo: Array<{ name: string; path: string }> = [];
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    await mkdir(agents, { recursive: true });
    await writeFile(join(agents, "searcher.md"), "---\nname: searcher\ndescription: Search fixture\ntools: read, grep, find, ls, fffind, fffind_safe\nthinking: low\ntimeoutMinutes: 30\n---\nUse the available discovery tools and report any missing capability.\n");
    await initializeWorktreeHostRepo(repo);
    await mkdir(join(repo, "search"));
    await writeFile(join(repo, "search", "evidence.txt"), "CHECKOUT_ONLY_NEEDLE\n");
    await writeFile(join(repo, "tracked.txt"), "committed base value\n");
    await run("git", ["-C", repo, "add", "search/evidence.txt", "tracked.txt"]);
    await run("git", ["-C", repo, "commit", "-qm", "requested base"]);
    await writeFile(join(repo, "tracked.txt"), "PARENT_MODIFIED_NEEDLE\n");
    await writeFile(join(repo, "parent-only.txt"), "PARENT_ONLY_NEEDLE\n");

    const faux = fauxProvider();
    let grepCalls = 0;
    let findCalls = 0;
    let lsCalls = 0;
    faux.setResponses(Array.from({ length: 30 }, () => (context) => {
      const system = context.messages.find((message) => message.role === "system");
      const isParent = system?.toolsAdded?.some((tool) => tool.name === "subagent");
      const previous = context.messages.findLast((message) => message.role === "toolResult");
      if (isParent) {
        if (previous?.toolName === "subagent") return fauxAssistantMessage("Parent received the child result.");
        return fauxAssistantMessage([fauxToolCall("subagent", { agent: "searcher", task: "Use grep, find, and ls with explicit and omitted scopes. Report unavailable tools.", worktree: true }, { id: "search-binding" })], { stopReason: "toolUse" });
      }
      const transcript = JSON.stringify(context.messages);
      const tools = system?.toolsAdded ?? [];
      for (const name of ["grep", "find", "ls"]) assert.ok(tools.some((tool) => tool.name === name), `${name} should be available: ${JSON.stringify(tools.map(tool => tool.name))}`);
      assert.ok(!tools.some((tool) => tool.name === "fffind"), "workspace-sensitive extension tools without binding must be omitted");
      if (transcript.includes('"name":"fffind"')) return fauxAssistantMessage([fauxText("The unavailable fffind capability was not used; supported searches were scoped to this checkout.")]);
      if (!previous) return fauxAssistantMessage([fauxToolCall("grep", { pattern: "CHECKOUT_ONLY_NEEDLE", path: "search", literal: true }, { id: "grep-explicit" })], { stopReason: "toolUse" });
      assert.equal(previous.isError, false, JSON.stringify(previous));
      const output = previous.content.map(part => part.type === "text" ? part.text : "").join("\n");
      if (previous.toolName === "grep") {
        assert.match(output, /evidence\.txt:1: CHECKOUT_ONLY_NEEDLE/);
        grepCalls++;
        return grepCalls === 1
          ? fauxAssistantMessage([fauxToolCall("grep", { pattern: "CHECKOUT_ONLY_NEEDLE", literal: true }, { id: "grep-omitted" })], { stopReason: "toolUse" })
          : fauxAssistantMessage([fauxToolCall("find", { pattern: "*.txt", path: "search" }, { id: "find-explicit" })], { stopReason: "toolUse" });
      }
      if (previous.toolName === "find") {
        findCalls++;
        assert.equal(output, findCalls === 1 ? "evidence.txt" : "No files found matching pattern");
        return findCalls === 1
          ? fauxAssistantMessage([fauxToolCall("find", { pattern: "parent-only.txt" }, { id: "find-omitted" })], { stopReason: "toolUse" })
          : fauxAssistantMessage([fauxToolCall("ls", { path: "search" }, { id: "ls-explicit" })], { stopReason: "toolUse" });
      }
      if (previous.toolName === "ls") {
        lsCalls++;
        if (lsCalls === 1) {
          assert.match(output, /evidence\.txt/);
          return fauxAssistantMessage([fauxToolCall("ls", {}, { id: "ls-omitted" })], { stopReason: "toolUse" });
        }
        assert.doesNotMatch(output, /parent-only\.txt/);
        return fauxAssistantMessage([fauxToolCall("fffind_safe", { path: "relative-looking/path" }, { id: "independent-extension" })], { stopReason: "toolUse" });
      }
      if (previous.toolName === "fffind_safe") {
        assert.equal(output, "same:relative-looking/path", "explicitly workspace-independent extension arguments remain unchanged");
        return fauxAssistantMessage([fauxToolCall("fffind", { path: "parent-only.txt" }, { id: "unsupported-fffind" })], { stopReason: "toolUse" });
      }
      throw new Error(`Unexpected child tool result: ${previous.toolName}`);
    }));

    const modelRuntime = await ModelRuntime.create({ authPath: join(harness, "auth.json"), modelsPath: null, modelsStorePath: join(harness, "models.json"), refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const settingsManager = SettingsManager.inMemory({ defaultTools: ["bash", "grep", "find", "ls", "subagent", "fffind", "fffind_safe"] });
    const loader = new DefaultResourceLoader({ cwd: repo, agentDir: repo, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [(pi) => {
        pi.registerTool({ name: "fffind", label: "Optional search", exposure: "codemode", description: "Workspace-sensitive unsupported fixture", parameters: Type.Object({ path: Type.String() }),
          execute: async () => { unboundCalls++; return { content: [{ type: "text", text: "wrong parent result" }], details: undefined }; } });
        pi.registerTool({ name: "fffind_safe", label: "Independent fixture", exposure: "codemode", namespace: { name: "independent-fixture", instructions: WORKSPACE_INDEPENDENT_TOOL_INSTRUCTION }, description: "Explicitly workspace-independent fixture", parameters: Type.Object({ path: Type.String() }),
          execute: async (_id, args) => { independentCalls.push(args.path); return { content: [{ type: "text", text: `same:${args.path}` }], details: undefined }; } });
        pi.on("tool_call", (event) => {
          if (sourceInfo.length === 0) sourceInfo.push(...pi.getAllTools().map(tool => ({ name: tool.name, path: tool.sourceInfo.path })));
          if (event.parentToolCallId && ["grep", "find", "ls"].includes(event.toolName)) hostInputs.push({ name: event.toolName, input: { ...event.input } });
        });
      }, extension],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd: repo, agentDir: repo, modelRuntime, model: modelRuntime.getModel("faux", "faux-1")!,
      settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(repo), thinkingLevel: "off" }));
    await session.prompt("Delegate checkout scoped discovery and search checks.");

    const delegation = session.messages.find((message) => message.role === "toolResult" && message.toolName === "subagent");
    assert.ok(delegation && delegation.role === "toolResult");
    assert.equal(delegation.isError, true, JSON.stringify(delegation.content));
    assert.equal(sourceInfo.find(tool => tool.name === "grep")?.path, "builtin:grep", `the core tool uses its exact Pi builtin identity: ${JSON.stringify(sourceInfo)}`);
    assert.ok(!sourceInfo.find(tool => tool.name === "fffind")?.path?.startsWith("builtin:"), "the fixture extension is not core merely because of its tool name");
    assert.deepEqual([...coreBuiltinToolNames([
      { name: "bash", sourceInfo: { path: "builtin:bash" } },
      { name: "read", sourceInfo: { path: "builtin:search-extension" } },
    ])], ["bash"], "a builtin extension source that replaces read is not trusted as Pi's core read tool");
    const report = (delegation.details as { output?: string } | undefined)?.output;
    assert.match(JSON.stringify(delegation.content), /Task blocked: attempted unavailable workspace capability fffind/);
    assert.doesNotMatch(report ?? "", /unavailable extension search was not invoked/);
    assert.equal(unboundCalls, 0);
    assert.deepEqual(independentCalls, ["relative-looking/path"]);
    assert.deepEqual((delegation.details as { unavailable: string[] }).unavailable.sort(), ["fffind", "read"]);
    assert.deepEqual(hostInputs.map(({ name }) => name), ["grep", "grep", "find", "find", "ls", "ls"]);
    const isolatedInputs = hostInputs.slice(0, 6);
    for (const { input } of isolatedInputs) {
      const path = input.path;
      assert.equal(typeof path, "string");
      assert.ok((path as string).includes("-worktrees/") && !(path as string).startsWith(repo + "/"), JSON.stringify(hostInputs));
    }
    assert.equal(await readFile(join(repo, "tracked.txt"), "utf8"), "PARENT_MODIFIED_NEEDLE\n");
    assert.equal(await readFile(join(repo, "parent-only.txt"), "utf8"), "PARENT_ONLY_NEEDLE\n");
  } finally {
    if (previous.agents === undefined) delete process.env.PI_SUBAGENT_AGENTS; else process.env.PI_SUBAGENT_AGENTS = previous.agents;
    if (previous.storage === undefined) delete process.env.PI_SUBAGENT_STORAGE; else process.env.PI_SUBAGENT_STORAGE = previous.storage;
    try { session?.dispose?.(); } catch {}
    await cleanupWorktreeHostFixture({ repo, harness, store, worktrees });
  }
});
