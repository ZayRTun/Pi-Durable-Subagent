import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import extension from "../index.ts";

const run = promisify(execFile);
const agentDirectory = fileURLToPath(new URL("./fixtures/agents/", import.meta.url));

test("a real Pi delegated write and edit mutate only the assigned worktree and preserve host safeguards", async () => {
  const repo = await mkdtemp(join(tmpdir(), "durable-host-mutations-"));
  const harness = await mkdtemp(join(tmpdir(), "durable-host-mutations-state-"));
  const store = join(dirname(repo), `${basename(repo)}-runs`);
  const worktrees = join(dirname(repo), `${basename(repo)}-worktrees`);
  const absoluteTarget = join(harness, "absolute-target.txt");
  const previous = { agents: process.env.PI_SUBAGENT_AGENTS, storage: process.env.PI_SUBAGENT_STORAGE };
  process.env.PI_SUBAGENT_AGENTS = agentDirectory;
  process.env.PI_SUBAGENT_STORAGE = store;
  const permissionInputs: Array<{ name: string; input: Record<string, unknown> }> = [];
  let worktree: string | undefined;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    await run("git", ["init", "-q", repo]);
    await run("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
    await run("git", ["-C", repo, "config", "user.name", "Test"]);
    await writeFile(join(repo, "tracked.txt"), "committed base value\n");
    await run("git", ["-C", repo, "add", "tracked.txt"]);
    await run("git", ["-C", repo, "commit", "-qm", "requested base"]);
    await writeFile(join(repo, "tracked.txt"), "parent-only modification\n");
    const parentFilesBefore = (await readdir(repo)).sort();

    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("subagent", { agent: "worker", task: "Edit tracked.txt and create child.txt in this checkout.", worktree: true }, { id: "host-mutations" })], { stopReason: "toolUse" }),
      (context) => {
        const tools = context.messages.find((message) => message.role === "system")?.toolsAdded ?? [];
        assert.ok(tools.some((tool) => tool.name === "write"));
        assert.ok(tools.some((tool) => tool.name === "edit"));
        return fauxAssistantMessage([fauxToolCall("edit", { path: "tracked.txt", edits: [{ oldText: "committed base value", newText: "edited in child" }] }, { id: "child-edit" })], { stopReason: "toolUse" });
      },
      (context) => {
        const result = context.messages.findLast((message) => message.role === "toolResult");
        assert.ok(result && result.role === "toolResult" && !result.isError, JSON.stringify(result));
        return fauxAssistantMessage([fauxToolCall("write", { path: "child.txt", content: "created in child\n" }, { id: "child-write" })], { stopReason: "toolUse" });
      },
      (context) => {
        const result = context.messages.findLast((message) => message.role === "toolResult");
        assert.ok(result && result.role === "toolResult" && !result.isError, JSON.stringify(result));
        return fauxAssistantMessage([fauxToolCall("edit", { path: "tracked.txt", edits: [{ oldText: "not present", newText: "must not appear" }] }, { id: "invalid-edit" })], { stopReason: "toolUse" });
      },
      (context) => {
        const result = context.messages.findLast((message) => message.role === "toolResult");
        assert.ok(result && result.role === "toolResult" && result.isError, JSON.stringify(result));
        return fauxAssistantMessage([fauxToolCall("write", { path: "denied.txt", content: "must not be created\n" }, { id: "denied-write" })], { stopReason: "toolUse" });
      },
      (context) => {
        const result = context.messages.findLast((message) => message.role === "toolResult");
        assert.ok(result && result.role === "toolResult" && result.isError, JSON.stringify(result));
        return fauxAssistantMessage([fauxToolCall("write", { path: absoluteTarget, content: "absolute path retained\n" }, { id: "absolute-write" })], { stopReason: "toolUse" });
      },
      (context) => {
        const result = context.messages.findLast((message) => message.role === "toolResult");
        assert.ok(result && result.role === "toolResult" && !result.isError, JSON.stringify(result));
        return fauxAssistantMessage([fauxText("The checkout write and edit succeeded; invalid and denied mutations had no effect.")]);
      },
      fauxAssistantMessage([fauxText("Worktree mutations verified.")]),
    ]);
    const modelRuntime = await ModelRuntime.create({ authPath: join(harness, "auth.json"), modelsPath: null, modelsStorePath: join(harness, "models.json"), refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const settingsManager = SettingsManager.inMemory({ defaultTools: ["read", "write", "edit", "bash", "subagent"] });
    const loader = new DefaultResourceLoader({ cwd: repo, agentDir: repo, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [
        (pi) => { pi.on("tool_call", (event) => {
          if (event.parentToolCallId && (event.toolName === "write" || event.toolName === "edit")) {
            const input = { ...event.input } as Record<string, unknown>;
            permissionInputs.push({ name: event.toolName, input });
            if (event.toolName === "write" && typeof input.path === "string" && input.path.endsWith("/denied.txt")) {
              return { block: true, reason: "Permission denied by Pi hook" };
            }
          }
        }); },
        extension,
      ],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd: repo, agentDir: repo, modelRuntime, model: modelRuntime.getModel("faux", "faux-1")!,
      settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(repo), thinkingLevel: "off" }));
    await session.prompt("Delegate relative file changes to an isolated checkout.");

    const delegation = session.messages.find((message) => message.role === "toolResult" && message.toolName === "subagent");
    assert.ok(delegation && delegation.role === "toolResult");
    assert.equal(delegation.isError, false, JSON.stringify(delegation.content));
    const report = (delegation.details as { output?: string; worktree?: { path: string } } | undefined);
    assert.match(report?.output ?? "", /invalid and denied mutations had no effect/);
    worktree = report?.worktree?.path;
    assert.ok(worktree && basename(dirname(worktree)) === basename(worktrees), JSON.stringify(report));
    assert.equal(await readFile(join(worktree, "tracked.txt"), "utf8"), "edited in child\n");
    assert.equal(await readFile(join(worktree, "child.txt"), "utf8"), "created in child\n");
    await assert.rejects(readFile(join(worktree, "denied.txt"), "utf8"), { code: "ENOENT" });
    assert.equal(await readFile(absoluteTarget, "utf8"), "absolute path retained\n");
    assert.equal(await readFile(join(repo, "tracked.txt"), "utf8"), "parent-only modification\n");
    assert.deepEqual((await readdir(repo)).sort(), parentFilesBefore);
    const mutationInputs = permissionInputs.filter((entry) => entry.name === "write" || entry.name === "edit");
    assert.equal(mutationInputs.length, 5);
    assert.ok(mutationInputs.slice(0, 4).every(({ input }) => typeof input.path === "string" && input.path.startsWith(worktree!)), JSON.stringify(mutationInputs));
    assert.equal(mutationInputs[0].input.path, join(worktree, "tracked.txt"));
    assert.equal(mutationInputs[1].input.path, join(worktree, "child.txt"));
    assert.equal(mutationInputs[2].input.path, join(worktree, "tracked.txt"));
    assert.equal(mutationInputs[3].input.path, join(worktree, "denied.txt"));
    assert.equal(mutationInputs[4].input.path, absoluteTarget, "explicit absolute paths retain their host-policy target");
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
