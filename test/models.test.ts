import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadModelConfig, resolveModel, writeModelConfig, type ModelPoolConfig } from "../models.ts";

const empty: ModelPoolConfig = { agents: {}, pools: {} };
const config: ModelPoolConfig = {
  agents: { "poteto-agent": "acme/pinned" },
  pools: { reviewers: ["acme/parent", "acme/other"], "swarm workers": ["acme/worker"] },
};

test("inherit-parent resolves to the caller's own model, past any pool or pin", () => {
  const parent = { provider: "acme", modelId: "parent" };
  const inherited = resolveModel({ agentName: "poteto-agent", agentModel: "acme/definition", parent, inherit: true, config });
  assert.deepEqual(inherited, { model: { provider: "acme", modelId: "parent" }, poolResolved: true });
  assert.equal(resolveModel({ agentName: "scout", inherit: true, config }), undefined, "nothing to inherit without a caller model");
});

test("writing pools merges into the config file and validates every model reference", async () => {
  const root = await mkdtemp(join(tmpdir(), "durable-models-write-"));
  try {
    const path = join(root, "nested", "durable-subagents.json");
    const first = await writeModelConfig(path, { pools: { reviewers: ["acme/a"] }, agents: { scout: "acme/s" } });
    assert.deepEqual(first.pools.reviewers, ["acme/a"]);
    const second = await writeModelConfig(path, { pools: { judges: ["acme/j", "acme/k"] } });
    assert.deepEqual(second.pools.reviewers, ["acme/a"], "existing pools are kept");
    assert.equal(second.agents.scout, "acme/s", "existing pins are kept");
    assert.deepEqual((await loadModelConfig(path)).config.pools.judges, ["acme/j", "acme/k"]);
    assert.deepEqual((await loadModelConfig(path)).errors, []);
    await assert.rejects(() => writeModelConfig(path, { pools: { bad: [] } }), /needs at least one model/);
    await assert.rejects(() => writeModelConfig(path, { agents: { scout: "unqualified" } }), /provider\/model-id/);
    // A rejected write must not have half-applied.
    assert.deepEqual((await loadModelConfig(path)).config.pools, { reviewers: ["acme/a"], judges: ["acme/j", "acme/k"] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("config is optional and a malformed one is reported rather than fatal", async () => {
  const root = await mkdtemp(join(tmpdir(), "durable-models-"));
  try {
    const missing = await loadModelConfig(join(root, "absent.json"));
    assert.deepEqual(missing.errors, []);
    assert.deepEqual(missing.config, empty);

    const broken = join(root, "broken.json");
    await writeFile(broken, "{ not json");
    const malformed = await loadModelConfig(broken);
    assert.equal(malformed.errors.length, 1);
    assert.deepEqual(malformed.config, empty);
    const valid = join(root, "valid.json");
    await writeFile(valid, JSON.stringify({ models: { agents: { scout: "acme/s" }, pools: { recon: ["acme/r1", "acme/r2"] } } }));
    const loaded = await loadModelConfig(valid);
    assert.deepEqual(loaded.errors, []);
    assert.deepEqual(loaded.config.pools.recon, ["acme/r1", "acme/r2"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("resolution order is call model, then pool, then pin, then definition, then parent", () => {
  const parent = { provider: "acme", modelId: "parent" };
  const explicit = resolveModel({ agentName: "scout", agentModel: "acme/definition", parent, model: { provider: "acme", modelId: "call" }, config });
  assert.deepEqual(explicit, { model: { provider: "acme", modelId: "call" }, pool: undefined, poolResolved: true });

  const pooled = resolveModel({ agentName: "scout", agentModel: "acme/definition", parent, pool: "reviewers", config });
  assert.equal(pooled?.poolResolved, true);
  assert.equal(pooled?.model.modelId, "other", "a pool prefers an entry that differs from the caller's own model");

  const pinned = resolveModel({ agentName: "poteto-agent", agentModel: "acme/definition", parent, config });
  assert.equal(pinned?.model.modelId, "pinned", "an operator pin beats the definition");

  const definition = resolveModel({ agentName: "scout", agentModel: "acme/definition", parent, config });
  assert.equal(definition?.model.modelId, "definition");

  const inherited = resolveModel({ agentName: "scout", parent, config });
  assert.equal(inherited?.model.modelId, "parent");

  assert.equal(resolveModel({ agentName: "scout", config }), undefined);
});

test("an unconfigured pool falls back and says so instead of pretending it resolved", () => {
  const parent = { provider: "acme", modelId: "parent" };
  const unresolved = resolveModel({ agentName: "scout", parent, pool: "typo pool", config });
  assert.equal(unresolved?.poolResolved, false);
  assert.equal(unresolved?.pool, "typo pool");
  assert.equal(unresolved?.model.modelId, "parent");

  // A single-entry pool that equals the parent stays honest about where the model came from.
  const same = resolveModel({ agentName: "scout", parent, pool: "swarm workers", config: { agents: {}, pools: { "swarm workers": ["acme/parent"] } } });
  assert.equal(same?.poolResolved, true);
  assert.equal(same?.model.modelId, "parent");
});

test("a model write preserves unrelated top-level fields and refuses to overwrite malformed configs", async () => {
  const root = await mkdtemp(join(tmpdir(), "durable-models-preserve-"));
  try {
    const path = join(root, "durable-subagents.json");
    await writeFile(path, JSON.stringify({ agentDirectories: ["./agents", "~/shared-agents"], theme: "dark", models: { agents: { scout: "acme/s" }, customPolicy: "keep" } }));
    await writeModelConfig(path, { pools: { reviewers: ["acme/r"] } });
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    assert.deepEqual(raw.agentDirectories, ["./agents", "~/shared-agents"], "directory config survives a model write");
    assert.equal(raw.theme, "dark");
    assert.deepEqual(raw.models, { agents: { scout: "acme/s" }, pools: { reviewers: ["acme/r"] }, customPolicy: "keep" });
    assert.deepEqual((await loadModelConfig(path)).errors, []);

    for (const bad of ["{ not json", JSON.stringify(["array"]), JSON.stringify("scalar")]) {
      await writeFile(path, bad);
      await assert.rejects(() => writeModelConfig(path, { agents: { scout: "acme/s" } }), /refusing to overwrite/);
      assert.equal(await readFile(path, "utf8"), bad, "a refused write leaves the file untouched");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
