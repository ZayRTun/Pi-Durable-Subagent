import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

// Definitions are explicit now; point the extension at the fixture set the removed bundled fallback found.
process.env.PI_SUBAGENT_AGENTS ??= fileURLToPath(new URL("./fixtures/agents/", import.meta.url));

const run = promisify(execFile);

test("worktree isolation gives each step its own checkout and leaves the caller's repository alone", async () => {
  const repo = await mkdtemp(join(tmpdir(), "durable-worktree-"));
  const harness = await mkdtemp(join(tmpdir(), "durable-worktree-state-"));
  const worktrees = join(dirname(repo), `${basename(repo)}-worktrees`);
  const store = join(repo, "..", `${basename(repo)}-runs`);
  const previous = process.env.PI_SUBAGENT_STORAGE;
  process.env.PI_SUBAGENT_STORAGE = store;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    await run("git", ["init", "-q", repo]);
    await run("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
    await run("git", ["-C", repo, "config", "user.name", "Test"]);
    await writeFile(join(repo, "tracked.txt"), "committed\n");
    await run("git", ["-C", repo, "add", "tracked.txt"]);
    await run("git", ["-C", repo, "commit", "-qm", "initial"]);
    await writeFile(join(repo, "untracked.txt"), "not committed\n");

    const faux = fauxProvider();
    const answer = () => fauxAssistantMessage([fauxText("step answer")]);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("subagent", { agent: "scout", worktree: true, tasks: [{ task: "First step" }, { task: "Second step" }] }, { id: "isolated" })], { stopReason: "toolUse" }),
      ...Array.from({ length: 12 }, () => answer),
    ]);
    const modelRuntime = await ModelRuntime.create({ authPath: join(harness, "auth.json"), modelsPath: null, modelsStorePath: join(harness, "models.json"), refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const model = modelRuntime.getModel("faux", "faux-1")!;
    const settingsManager = SettingsManager.inMemory({ defaultTools: ["read", "subagent"] });
    const loader = new DefaultResourceLoader({ cwd: repo, agentDir: repo, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url))] });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd: repo, agentDir: repo, modelRuntime, model,
      settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(repo), thinkingLevel: "off" }));
    await session.prompt("Run both steps in isolated checkouts.");

    const records = [];
    for (const id of (await readdir(store)).filter((name) => /^[a-f0-9]{32}$/.test(name))) {
      records.push(JSON.parse(await readFile(join(store, id, "run.json"), "utf8")) as
        { status: string; cwd: string; worktree?: { path: string; branch: string } });
    }
    assert.equal(records.length, 2);
    assert.ok(records.every((record) => record.status === "succeeded"), "both steps must succeed");
    const checkouts = records.map((record) => record.worktree?.path);
    assert.ok(checkouts.every((path) => typeof path === "string" && path !== repo), "each step runs outside the caller's checkout");
    assert.equal(new Set(checkouts).size, 2, "steps must not share a checkout");
    assert.ok(records.every((record) => record.worktree?.branch.startsWith("durable/")));
    assert.ok(records.every((record) => record.cwd === record.worktree?.path), "the run works in its checkout");

    const listed = (await run("git", ["-C", repo, "worktree", "list"])).stdout;
    for (const checkout of checkouts) assert.ok(listed.includes(checkout!), `git must know about ${checkout}`);

    // The caller's working tree keeps its uncommitted file and gains no commits.
    assert.equal((await run("git", ["-C", repo, "status", "--porcelain"])).stdout.trim(), "?? untracked.txt");
    assert.equal((await run("git", ["-C", repo, "rev-list", "--count", "HEAD"])).stdout.trim(), "1");
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_STORAGE; else process.env.PI_SUBAGENT_STORAGE = previous;
    try { session?.dispose?.(); } catch {}
    try { await run("git", ["-C", repo, "worktree", "prune"]); } catch {}
    await rm(worktrees, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
    await rm(harness, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test("worktree isolation reports a clear error outside a git repository", async () => {
  const plain = await mkdtemp(join(tmpdir(), "durable-not-git-"));
  const store = join(plain, "..", `${basename(plain)}-runs`);
  const previous = process.env.PI_SUBAGENT_STORAGE;
  process.env.PI_SUBAGENT_STORAGE = store;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const faux = fauxProvider();
    const answer = () => fauxAssistantMessage([fauxText("answer")]);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("subagent", { agent: "scout", task: "Inspect", worktree: true }, { id: "no-repo" })], { stopReason: "toolUse" }),
      ...Array.from({ length: 6 }, () => answer),
    ]);
    const modelRuntime = await ModelRuntime.create({ authPath: join(plain, "auth.json"), modelsPath: null, modelsStorePath: join(plain, "models.json"), refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const model = modelRuntime.getModel("faux", "faux-1")!;
    const settingsManager = SettingsManager.inMemory({ defaultTools: ["read", "subagent"] });
    const loader = new DefaultResourceLoader({ cwd: plain, agentDir: plain, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url))] });
    await loader.reload();
    ({ session } = await createAgentSession({ cwd: plain, agentDir: plain, modelRuntime, model,
      settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(plain), thinkingLevel: "off" }));
    await session.prompt("Delegate.");
    const result = session.messages.find((message) => message.role === "toolResult" && message.toolName === "subagent");
    assert.ok(result && result.role === "toolResult");
    assert.equal(result.isError, true);
    assert.match(result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(""), /needs a git repository/);
    await assert.rejects(() => readdir(store), /ENOENT/);
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_STORAGE; else process.env.PI_SUBAGENT_STORAGE = previous;
    try { session?.dispose?.(); } catch {}
    await rm(store, { recursive: true, force: true });
    await rm(plain, { recursive: true, force: true });
  }
});

test("worktree isolation runs the steps concurrently rather than one after another", async () => {
  const repo = await mkdtemp(join(tmpdir(), "durable-parallel-"));
  const harness = await mkdtemp(join(tmpdir(), "durable-parallel-state-"));
  const worktrees = join(dirname(repo), `${basename(repo)}-worktrees`);
  const store = join(dirname(repo), `${basename(repo)}-runs`);
  const previous = process.env.PI_SUBAGENT_STORAGE;
  process.env.PI_SUBAGENT_STORAGE = store;
  let inFlight = 0;
  let maxInFlight = 0;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    await run("git", ["init", "-q", repo]);
    await run("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
    await run("git", ["-C", repo, "config", "user.name", "Test"]);
    await writeFile(join(repo, "tracked.txt"), "committed\n");
    await run("git", ["-C", repo, "add", "tracked.txt"]);
    await run("git", ["-C", repo, "commit", "-qm", "initial"]);

    // Overlapping model requests are the signal. A retry after a failure never overlaps, so
    // this stays a true guard even though the harness retries a failed step.
    const answer = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 50));
      } finally { inFlight -= 1; }
      return fauxAssistantMessage([fauxText("concurrent answer")]);
    };
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("subagent", { agent: "scout", worktree: true, tasks: [{ task: "First step" }, { task: "Second step" }] }, { id: "concurrent" })], { stopReason: "toolUse" }),
      ...Array.from({ length: 12 }, () => answer),
    ]);
    const modelRuntime = await ModelRuntime.create({ authPath: join(harness, "auth.json"), modelsPath: null, modelsStorePath: join(harness, "models.json"), refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const model = modelRuntime.getModel("faux", "faux-1")!;
    const settingsManager = SettingsManager.inMemory({ defaultTools: ["read", "subagent"] });
    const loader = new DefaultResourceLoader({ cwd: repo, agentDir: repo, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url))] });
    await loader.reload();
    ({ session } = await createAgentSession({ cwd: repo, agentDir: repo, modelRuntime, model,
      settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(repo), thinkingLevel: "off" }));
    await session.prompt("Run both steps in isolated checkouts.");

    assert.ok(maxInFlight >= 2, `at most ${maxInFlight} step(s) were in flight at once; the steps did not run concurrently`);
    const records = [];
    for (const id of (await readdir(store)).filter((name) => /^[a-f0-9]{32}$/.test(name))) {
      records.push(JSON.parse(await readFile(join(store, id, "run.json"), "utf8")) as { status: string });
    }
    assert.equal(records.length, 2);
    assert.ok(records.every((record) => record.status === "succeeded"), "both steps must succeed");
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_STORAGE; else process.env.PI_SUBAGENT_STORAGE = previous;
    try { session?.dispose?.(); } catch {}
    try { await run("git", ["-C", repo, "worktree", "prune"]); } catch {}
    await rm(worktrees, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
    await rm(harness, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test("worktree parsing rejects shapes it cannot honour", async () => {
  const { parseDelegationRequest } = await import("../request.ts");
  assert.deepEqual(parseDelegationRequest({ agent: "scout", task: "Inspect", worktree: true }),
    { kind: "delegate", mode: "steps", steps: [{ agent: "scout", task: "Inspect" }], worktree: {} });
  assert.deepEqual(parseDelegationRequest({ agent: "scout", task: "Inspect", worktree: { branch: "wip", base: "main" } }),
    { kind: "delegate", mode: "steps", steps: [{ agent: "scout", task: "Inspect" }], worktree: { branch: "wip", base: "main" } });
  assert.deepEqual(parseDelegationRequest({ agent: "scout", task: "Inspect", worktree: false }),
    { kind: "delegate", mode: "steps", steps: [{ agent: "scout", task: "Inspect" }] });
  assert.throws(() => parseDelegationRequest({ agent: "scout", task: "Inspect", worktree: "yes" }), /worktree must be true or an object/);
  assert.throws(() => parseDelegationRequest({ agent: "scout", task: "Inspect", worktree: { branch: "" } }), /worktree branch must be a nonempty string/);
  assert.throws(() => parseDelegationRequest({ agent: "scout", task: "Inspect", worktree: { depth: 1 } }), /worktree has unknown parameter depth/);
  assert.throws(() => parseDelegationRequest({ resume: "a".repeat(32), worktree: true }), /cannot be combined with worktree/);
});
