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
import extension from "../index.ts";

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
  const parentInputs: Array<{ name: string; input: Record<string, unknown> }> = [];
  let unboundCalls = 0;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    await mkdir(agents, { recursive: true });
    await writeFile(join(agents, "searcher.md"), "---\nname: searcher\ndescription: Search fixture\ntools: grep, find, ls, fffind\nthinking: low\ntimeoutMinutes: 30\n---\nUse the available discovery tools and report any missing capability.\n");
    await run("git", ["init", "-q", repo]);
    await run("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
    await run("git", ["-C", repo, "config", "user.name", "Test"]);
    await mkdir(join(repo, "search"));
    await writeFile(join(repo, "search", "evidence.txt"), "CHECKOUT_ONLY_NEEDLE\n");
    await writeFile(join(repo, "tracked.txt"), "committed base value\n");
    await run("git", ["-C", repo, "add", "search/evidence.txt", "tracked.txt"]);
    await run("git", ["-C", repo, "commit", "-qm", "requested base"]);
    await writeFile(join(repo, "tracked.txt"), "PARENT_MODIFIED_NEEDLE\n");
    await writeFile(join(repo, "parent-only.txt"), "PARENT_ONLY_NEEDLE\n");

    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("subagent", { agent: "searcher", task: "Use grep, find, and ls with explicit and omitted scopes. Report unavailable tools.", worktree: true }, { id: "search-binding" })], { stopReason: "toolUse" }),
      (context) => {
        const tools = context.messages.find((message) => message.role === "system")?.toolsAdded ?? [];
        for (const name of ["grep", "find", "ls"]) assert.ok(tools.some((tool) => tool.name === name), `${name} should be available: ${JSON.stringify(tools.map(tool => tool.name))}`);
        assert.ok(!tools.some((tool) => tool.name === "fffind"), "workspace-sensitive extension tools without binding must be omitted");
        assert.match(JSON.stringify(context.messages), /Unavailable declared tools: fffind/);
        return fauxAssistantMessage([fauxToolCall("grep", { pattern: "CHECKOUT_ONLY_NEEDLE", path: "search", literal: true }, { id: "grep-explicit" })], { stopReason: "toolUse" });
      },
      (context) => {
        const result = context.messages.findLast((message) => message.role === "toolResult");
        assert.ok(result && result.role === "toolResult" && !result.isError, JSON.stringify(result));
        assert.match(result.content.map(part => part.type === "text" ? part.text : "").join("\n"), /evidence\.txt:1: CHECKOUT_ONLY_NEEDLE/);
        return fauxAssistantMessage([fauxToolCall("grep", { pattern: "CHECKOUT_ONLY_NEEDLE", literal: true }, { id: "grep-omitted" })], { stopReason: "toolUse" });
      },
      (context) => {
        const result = context.messages.findLast((message) => message.role === "toolResult");
        assert.ok(result && result.role === "toolResult" && !result.isError, JSON.stringify(result));
        assert.match(result.content.map(part => part.type === "text" ? part.text : "").join("\n"), /evidence\.txt:1: CHECKOUT_ONLY_NEEDLE/);
        return fauxAssistantMessage([fauxToolCall("find", { pattern: "*.txt", path: "search" }, { id: "find-explicit" })], { stopReason: "toolUse" });
      },
      (context) => {
        const result = context.messages.findLast((message) => message.role === "toolResult");
        assert.ok(result && result.role === "toolResult" && !result.isError, JSON.stringify(result));
        assert.equal(result.content.map(part => part.type === "text" ? part.text : "").join("\n"), "evidence.txt");
        return fauxAssistantMessage([fauxToolCall("find", { pattern: "parent-only.txt" }, { id: "find-omitted" })], { stopReason: "toolUse" });
      },
      (context) => {
        const result = context.messages.findLast((message) => message.role === "toolResult");
        assert.ok(result && result.role === "toolResult" && !result.isError, JSON.stringify(result));
        assert.equal(result.content.map(part => part.type === "text" ? part.text : "").join("\n"), "No files found matching pattern");
        return fauxAssistantMessage([fauxToolCall("ls", { path: "search" }, { id: "ls-explicit" })], { stopReason: "toolUse" });
      },
      (context) => {
        const result = context.messages.findLast((message) => message.role === "toolResult");
        assert.ok(result && result.role === "toolResult" && !result.isError, JSON.stringify(result));
        assert.match(result.content.map(part => part.type === "text" ? part.text : "").join("\n"), /evidence\.txt/);
        return fauxAssistantMessage([fauxToolCall("ls", {}, { id: "ls-omitted" })], { stopReason: "toolUse" });
      },
      (context) => {
        const result = context.messages.findLast((message) => message.role === "toolResult");
        assert.ok(result && result.role === "toolResult" && !result.isError, JSON.stringify(result));
        const listing = result.content.map(part => part.type === "text" ? part.text : "").join("\n");
        assert.doesNotMatch(listing, /parent-only\.txt/);
        return fauxAssistantMessage([fauxToolCall("fffind", { path: "parent-only.txt" }, { id: "unsupported-fffind" })], { stopReason: "toolUse" });
      },
      (context) => {
        const result = context.messages.findLast((message) => message.role === "toolResult");
        assert.ok(result && result.role === "toolResult" && result.isError, "an unavailable capability should fail visibly when requested");
        assert.match(JSON.stringify(result.content), /fffind|tool|not available|not found/i);
        return fauxAssistantMessage([fauxToolCall("grep", { pattern: "PARENT_ONLY_NEEDLE", path: repo, literal: true }, { id: "grep-absolute" })], { stopReason: "toolUse" });
      },
      (context) => {
        const result = context.messages.findLast((message) => message.role === "toolResult");
        assert.ok(result && result.role === "toolResult" && !result.isError, JSON.stringify(result));
        assert.match(result.content.map(part => part.type === "text" ? part.text : "").join("\n"), /parent-only\.txt:1: PARENT_ONLY_NEEDLE/);
        return fauxAssistantMessage([fauxText("All supported searches used the assigned checkout; unavailable extension search was not invoked.")]);
      },
      fauxAssistantMessage([fauxToolCall("grep", { pattern: "PARENT_MODIFIED_NEEDLE", literal: true }, { id: "parent-grep" })], { stopReason: "toolUse" }),
      (context) => {
        const result = context.messages.findLast((message) => message.role === "toolResult");
        assert.ok(result && result.role === "toolResult" && !result.isError, JSON.stringify(result));
        assert.match(result.content.map(part => part.type === "text" ? part.text : "").join("\n"), /tracked\.txt:1: PARENT_MODIFIED_NEEDLE/);
        return fauxAssistantMessage([fauxText("The isolated discovery checks passed.")]);
      },
    ]);

    const modelRuntime = await ModelRuntime.create({ authPath: join(harness, "auth.json"), modelsPath: null, modelsStorePath: join(harness, "models.json"), refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const settingsManager = SettingsManager.inMemory({ defaultTools: ["bash", "read", "grep", "find", "ls", "subagent", "fffind"] });
    const loader = new DefaultResourceLoader({ cwd: repo, agentDir: repo, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [(pi) => {
        pi.registerTool({ name: "fffind", label: "Optional search", exposure: "codemode", description: "Workspace-sensitive unsupported fixture", parameters: Type.Object({ path: Type.String() }),
          execute: async () => { unboundCalls++; return { content: [{ type: "text", text: "wrong parent result" }], details: undefined }; } });
        pi.on("tool_call", (event) => {
          if (event.parentToolCallId && ["grep", "find", "ls"].includes(event.toolName)) hostInputs.push({ name: event.toolName, input: { ...event.input } });
          if (!event.parentToolCallId && event.toolName === "grep") parentInputs.push({ name: event.toolName, input: { ...event.input } });
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
    assert.equal(delegation.isError, false, JSON.stringify(delegation.content));
    const report = (delegation.details as { output?: string } | undefined)?.output;
    assert.match(report ?? "", /unavailable extension search was not invoked/);
    assert.equal(unboundCalls, 0);
    assert.equal(parentInputs.length, 1);
    assert.equal(parentInputs[0].input.path, undefined, "parent scope keeps Pi's normal default");
    assert.deepEqual(hostInputs.map(({ name }) => name), ["grep", "grep", "find", "find", "ls", "ls", "grep"]);
    const isolatedInputs = hostInputs.slice(0, 6);
    for (const { input } of isolatedInputs) {
      const path = input.path;
      assert.equal(typeof path, "string");
      assert.ok((path as string).includes("-worktrees/") && !(path as string).startsWith(repo), JSON.stringify(hostInputs));
    }
    assert.equal(hostInputs[6].input.path, repo, "explicit absolute search scopes preserve host-policy semantics");
    assert.equal(await readFile(join(repo, "tracked.txt"), "utf8"), "PARENT_MODIFIED_NEEDLE\n");
    assert.equal(await readFile(join(repo, "parent-only.txt"), "utf8"), "PARENT_ONLY_NEEDLE\n");
  } finally {
    if (previous.agents === undefined) delete process.env.PI_SUBAGENT_AGENTS; else process.env.PI_SUBAGENT_AGENTS = previous.agents;
    if (previous.storage === undefined) delete process.env.PI_SUBAGENT_STORAGE; else process.env.PI_SUBAGENT_STORAGE = previous.storage;
    try { session?.dispose?.(); } catch {}
    try { await run("git", ["-C", repo, "worktree", "prune"]); } catch {}
    await rm(worktrees, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
    await rm(harness, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});
