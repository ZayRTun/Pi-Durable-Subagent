import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgents, parseAgent, selectTools } from "../agents.ts";

const definition = (fields = "tools: read, bash, fffind, web_search") => `---\nname: scout\ndescription: Investigate\n${fields}\n---\nInspect without changing files.\n`;

test("loads the self-contained fixture definitions without changing them", async () => {
  const directory = fileURLToPath(new URL("./fixtures/agents/", import.meta.url));
  const { agents, errors } = await loadAgents(directory);
  assert.deepEqual(errors, []);
  assert.deepEqual(agents.map((a) => a.name), ["poteto-agent", "researcher", "reviewer", "scout", "worker"]);
  assert.equal(agents.find((a) => a.name === "scout")?.color, "cyan");
  assert.ok(agents.every((a) => a.model === undefined), "no role should pin a model");
  assert.ok(agents.every((a) => a.definitionPath !== undefined), "every loaded role records its definition file");
  assert.equal(agents.find((a) => a.name === "scout")?.definitionPath, await realpath(join(directory, "scout.md")));
  // Measured: detection survived at every thinking level, but the only under-graded
  // finding came from `low`, so the judgement roles must not declare it.
  assert.ok(agents.every((a) => a.thinking !== undefined), "every role should declare its level");
  for (const role of ["reviewer", "researcher"]) {
    assert.notEqual(agents.find((a) => a.name === role)?.thinking, "low");
  }
});

test("records the realpath of a loaded definition, following a symlinked directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "durable-realpath-agents-"));
  try {
    const real = join(root, "real");
    const link = join(root, "link");
    await mkdir(real);
    await writeFile(join(real, "scout.md"), definition());
    await symlink(real, link, "dir");
    const viaLink = await loadAgents(link);
    const direct = await loadAgents(real);
    assert.deepEqual(viaLink.errors, []);
    assert.equal(viaLink.agents[0].definitionPath, await realpath(join(real, "scout.md")));
    assert.equal(direct.agents[0].definitionPath, viaLink.agents[0].definitionPath);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("optional tools disappear without widening the allowlist", () => {
  const agent = parseAgent(definition());
  assert.deepEqual(selectTools(agent, ["read", "bash", "write"]), {
    tools: ["read", "bash"], unavailable: ["fffind", "web_search"],
  });
  assert.deepEqual(selectTools(agent, ["read", "bash", "fffind", "web_search"]).unavailable, []);
});

test("missing or malformed allowlists fail closed", () => {
  for (const fields of ["", "tools: 42", "tools: [read, null]", "tools: read,,bash"]) {
    assert.throws(() => parseAgent(definition(fields)), /tools/);
  }
  assert.deepEqual(parseAgent(definition("tools: []")).tools, []);
});

test("supports YAML lists, comments, and independent model/thinking declarations", () => {
  const agent = parseAgent(definition("tools: [read, bash, read]\nmodel: example/model\n# thinking: high\ntimeoutMinutes: 12"));
  assert.deepEqual(agent.tools, ["read", "bash"]);
  assert.equal(agent.model, "example/model");
  assert.equal(agent.thinking, undefined);
  assert.equal(agent.timeoutMinutes, 12);
});

test("rejects invalid configuration", () => {
  for (const field of ["timeoutMinutes: 0", "timeoutMinutes: .inf", "thinking: typo", "model: unqualified", "allowSubagents: maybe", "name: duplicate"]) {
    assert.throws(() => parseAgent(definition(`tools: [read]\n${field}`)));
  }
});

test("a delegating declaration is accepted, and delegation is never bridged from the caller's tool list", () => {
  for (const fields of ["tools: [read, subagent]", "tools: read, subagent", 'tools: [read, " subagent "]', "tools: [read]\nallowSubagents: true"]) {
    const agent = parseAgent(definition(fields));
    assert.ok(agent.tools.includes("subagent"), `${fields} should keep the declared delegation`);
    // The extension supplies its own depth-aware tool, so a caller's tool list cannot widen delegation.
    assert.deepEqual(selectTools(agent, ["read", "subagent"]).tools, ["read"]);
  }
});

test("missing agent directories report a load error without aborting extension initialization", async () => {
  const root = await mkdtemp(join(tmpdir(), "durable-missing-agents-"));
  try {
    const result = await loadAgents(join(root, "missing"));
    assert.deepEqual(result.agents, []);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an earlier definition directory shadows a later one, and a later-only agent still loads", async () => {
  const root = await mkdtemp(join(tmpdir(), "durable-shadow-agents-"));
  const operator = join(root, "operator");
  const bundled = join(root, "bundled");
  const agent = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\ntools: read\n---\nInspect files.\n`;
  try {
    await mkdir(operator, { recursive: true });
    await mkdir(bundled, { recursive: true });
    await writeFile(join(operator, "shared.md"), agent("shared", "operator copy"));
    await writeFile(join(bundled, "shared.md"), agent("shared", "bundled copy").replace("tools: read\n", ""));
    await writeFile(join(bundled, "extra.md"), agent("extra", "bundled only"));
    const result = await loadAgents([operator, bundled]);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.agents.map((entry) => entry.name), ["shared", "extra"]);
    assert.equal(result.agents[0].description, "operator copy");
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const shadowed of [false, true]) {
  test(`duplicate names within a directory are rejected${shadowed ? " even when shadowed" : ""}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "durable-duplicate-agents-"));
    const earlier = join(root, "earlier");
    const later = join(root, "later");
    try {
      await mkdir(earlier);
      await mkdir(later);
      if (shadowed) await writeFile(join(earlier, "scout.md"), definition());
      await writeFile(join(later, "a.md"), definition());
      await writeFile(join(later, "b.md"), definition());
      const result = await loadAgents([earlier, later]);
      assert.deepEqual(result.agents.map((agent) => agent.name), ["scout"]);
      assert.deepEqual(result.errors, [{ file: join(later, "b.md"), message: "Duplicate agent name: scout" }]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("unshadowed definitions without tool allowlists remain unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "durable-invalid-agent-"));
  try {
    await writeFile(join(root, "scout.md"), definition(""));
    const result = await loadAgents(root);
    assert.deepEqual(result.agents, []);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /tools must be an explicit list/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("badge colors are validated against supported names or six-digit hex", () => {
  for (const value of ['42', 'null', '"typo"', '"#abc"', '"#12345g"']) {
    assert.throws(() => parseAgent(definition(`tools: []\ncolor: ${value}`)), /color/);
  }
  assert.equal(parseAgent(definition('tools: []\ncolor: "#aBc123"')).color, "#aBc123");
});

test("provider/model syntax permits namespaced model IDs but not empty or whitespace parts", () => {
  assert.equal(parseAgent(definition("tools: []\nmodel: openrouter/anthropic/claude-sonnet")).model, "openrouter/anthropic/claude-sonnet");
  for (const model of ['" /model"', '"provider/ model"', '"provider/model "', '"/model"', '"provider/"']) {
    assert.throws(() => parseAgent(definition(`tools: []\nmodel: ${model}`)), /model/);
  }
});

test("cannot bridge tools that bypass the Sub-agent's allowlist", () => {
  const agent = { ...parseAgent(definition("tools: [read, codemode, tool_search]")), tools: ["read", "codemode", "tool_search", "subagent"] };
  assert.deepEqual(selectTools(agent, agent.tools), {
    tools: ["read"], unavailable: ["codemode", "tool_search", "subagent"],
  });
});
