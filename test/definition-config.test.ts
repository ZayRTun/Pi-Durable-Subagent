import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { resolveAgentDirectories } from "../definition-config.ts";

const DEFAULT = "/default/agents";

async function withRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "durable-defdir-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

const missingConfig = (root: string) => join(root, "durable-subagents.json");

test("a missing config, or one without agentDirectories, uses the standalone default", async () => {
  await withRoot(async (root) => {
    const absent = await resolveAgentDirectories({ configPath: missingConfig(root), defaultDirectory: DEFAULT });
    assert.deepEqual(absent, { directories: [DEFAULT], errors: [] });

    const configPath = join(root, "models-only.json");
    await writeFile(configPath, JSON.stringify({ models: { agents: { scout: "acme/s" } } }));
    assert.deepEqual(await resolveAgentDirectories({ configPath, defaultDirectory: DEFAULT }), { directories: [DEFAULT], errors: [] });
  });
});

test("a truthy PI_SUBAGENT_AGENTS path list wins over the config", async () => {
  await withRoot(async (root) => {
    const configPath = join(root, "durable-subagents.json");
    await writeFile(configPath, JSON.stringify({ agentDirectories: ["/from/config"] }));
    const resolved = await resolveAgentDirectories({ configPath, defaultDirectory: DEFAULT, envValue: ` /a${delimiter}/b ${delimiter} ` });
    assert.deepEqual(resolved, { directories: ["/a", "/b"], errors: [] });
  });
});

test("an explicitly nonempty but blank environment override fails closed", async () => {
  await withRoot(async (root) => {
    for (const envValue of ["   ", delimiter]) {
      const result = await resolveAgentDirectories({ configPath: missingConfig(root), defaultDirectory: DEFAULT, envValue });
      assert.deepEqual(result.directories, []);
      assert.match(result.errors[0], /PI_SUBAGENT_AGENTS/);
    }
  });
});

test("configured relative paths resolve against the config directory, absolute paths stay, and ~ expands", async () => {
  await withRoot(async (root) => {
    const configDir = join(root, "cfg");
    await mkdir(configDir, { recursive: true });
    const configPath = join(configDir, "durable-subagents.json");
    await writeFile(configPath, JSON.stringify({ agentDirectories: ["agents", "/abs/agents", "~/shared-agents"] }));
    const resolved = await resolveAgentDirectories({ configPath, defaultDirectory: DEFAULT });
    assert.deepEqual(resolved, {
      directories: [join(configDir, "agents"), "/abs/agents", join(homedir(), "shared-agents")],
      errors: [],
    });
  });
});

test("an explicit empty array loads no definitions without an error", async () => {
  await withRoot(async (root) => {
    const configPath = join(root, "durable-subagents.json");
    await writeFile(configPath, JSON.stringify({ agentDirectories: [] }));
    assert.deepEqual(await resolveAgentDirectories({ configPath, defaultDirectory: DEFAULT }), { directories: [], errors: [] });
  });
});

test("unreadable, malformed, or invalidly typed configs fail closed, never widening to the default", async () => {
  await withRoot(async (root) => {
    const cases: [string, string][] = [
      ["broken.json", "{ not json"],
      ["array.json", JSON.stringify(["agents"])],
      ["scalar.json", JSON.stringify("agents")],
      ["nonarray.json", JSON.stringify({ agentDirectories: "agents" })],
      ["entries.json", JSON.stringify({ agentDirectories: ["agents", 42] })],
      ["empty-entry.json", JSON.stringify({ agentDirectories: ["  "] })],
    ];
    for (const [name, body] of cases) {
      const configPath = join(root, name);
      await writeFile(configPath, body);
      const resolved = await resolveAgentDirectories({ configPath, defaultDirectory: DEFAULT });
      assert.deepEqual(resolved.directories, [], `${name} must not fall back to the default`);
      assert.equal(resolved.errors.length, 1, `${name} reports a problem`);
      assert.match(resolved.errors[0], new RegExp(name.replace(".", "\\.")));
    }

    // An unreadable path (a directory) is a reported failure, not a default.
    const directory = join(root, "as-dir");
    await mkdir(directory);
    const unreadable = await resolveAgentDirectories({ configPath: directory, defaultDirectory: DEFAULT });
    assert.deepEqual(unreadable.directories, []);
    assert.equal(unreadable.errors.length, 1);
  });
});
