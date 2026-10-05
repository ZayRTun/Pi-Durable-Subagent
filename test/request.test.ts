import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_STEPS, parseDelegationRequest } from "../request.ts";

const step = (agent: string, task: string) => ({ agent, task });

test("accepts a delegation and a resume, and nothing in between", () => {
  assert.deepEqual(parseDelegationRequest({ agent: "scout", task: "Inspect the parser" }),
    { kind: "delegate", steps: [{ agent: "scout", task: "Inspect the parser" }], mode: "steps" });
  assert.deepEqual(parseDelegationRequest({ agent: "scout", task: "Inspect", model: "acme/big-model" }),
    { kind: "delegate", steps: [{ agent: "scout", task: "Inspect", model: { provider: "acme", modelId: "big-model" } }], mode: "steps" });
  assert.deepEqual(parseDelegationRequest({ resume: "a".repeat(32) }), { kind: "resume", runId: "a".repeat(32) });
});

test("several steps keep their order and inherit the call's agent, role, and model", () => {
  assert.deepEqual(parseDelegationRequest({ agent: "scout", tasks: [{ task: "A" }, { task: "B", agent: "reviewer" }] }),
    { kind: "delegate", steps: [step("scout", "A"), step("reviewer", "B")], mode: "steps" });
  assert.deepEqual(
    parseDelegationRequest({ agent: "scout", role: "swarm workers", model: "acme/m", tasks: [{ task: "A" }, { task: "B", role: "judges" }] }),
    { kind: "delegate", mode: "steps", steps: [
      { agent: "scout", task: "A", model: { provider: "acme", modelId: "m" }, pool: "swarm workers" },
      { agent: "scout", task: "B", model: { provider: "acme", modelId: "m" }, pool: "judges" },
    ] });
});

test("a chain is sequential, and says so by refusing isolation it would invalidate", () => {
  assert.deepEqual(parseDelegationRequest({ agent: "scout", chain: [{ task: "A" }, { agent: "worker", task: "B" }] }),
    { kind: "delegate", mode: "chain", steps: [{ agent: "scout", task: "A" }, { agent: "worker", task: "B" }] });
  assert.throws(() => parseDelegationRequest({ agent: "scout", chain: [{ task: "A" }], tasks: [{ task: "B" }] }), /either tasks or chain/);
  assert.throws(() => parseDelegationRequest({ agent: "scout", chain: [{ task: "A" }], task: "B" }), /either task or chain/);
  assert.throws(() => parseDelegationRequest({ agent: "scout", chain: [{ task: "A" }], worktree: true }), /worktree isolation would hide/);
});

test("the spellings poteto's playbooks use resolve rather than fail", () => {
  assert.deepEqual(parseDelegationRequest({ agent: "scout", task: "Inspect", model: "inherit-parent" }),
    { kind: "delegate", mode: "steps", steps: [{ agent: "scout", task: "Inspect", inherit: true }] });
  assert.deepEqual(parseDelegationRequest({ agent: "scout", task: "Inspect", model: "auto" }),
    { kind: "delegate", mode: "steps", steps: [{ agent: "scout", task: "Inspect", inherit: true }] });
  assert.deepEqual(parseDelegationRequest({ agent: "scout", task: "Inspect", cloud_base_branch: "release" }),
    { kind: "delegate", mode: "steps", steps: [{ agent: "scout", task: "Inspect" }], worktree: { base: "release" } });
});

test("a step list is bounded and every step must be usable", () => {
  const many = Array.from({ length: MAX_STEPS }, (_value, index) => ({ task: `step ${index}` }));
  assert.equal((parseDelegationRequest({ agent: "scout", tasks: many }) as { steps: unknown[] }).steps.length, MAX_STEPS);
  assert.throws(() => parseDelegationRequest({ agent: "scout", tasks: [...many, { task: "one too many" }] }), /at most 8 steps/);
  assert.throws(() => parseDelegationRequest({ agent: "scout", tasks: [] }), /at least one step/);
  assert.throws(() => parseDelegationRequest({ agent: "scout", tasks: "not an array" }), /must be an array/);
  assert.throws(() => parseDelegationRequest({ agent: "scout", task: "A", tasks: [{ task: "B" }] }), /either task or tasks/);
  assert.throws(() => parseDelegationRequest({ tasks: [{ task: "A" }] }), /did not give a default agent/);
  assert.throws(() => parseDelegationRequest({ agent: "scout", tasks: [{ agent: "scout" }] }), /tasks\[0\]: requires a nonempty task/);
  assert.throws(() => parseDelegationRequest({ agent: "scout", tasks: ["plain string"] }), /tasks\[0\]: expected an object/);
  assert.throws(() => parseDelegationRequest({ agent: "scout", tasks: [{ task: "A", temperature: 1 }] }), /tasks\[0\]: unknown parameter temperature/);
});

test("a named role and the task:<pool> form both select a pool", () => {
  assert.deepEqual(parseDelegationRequest({ agent: "scout", task: "Inspect", role: "swarm workers" }),
    { kind: "delegate", mode: "steps", steps: [{ agent: "scout", task: "Inspect", pool: "swarm workers" }] });
  assert.deepEqual(parseDelegationRequest({ agent: "scout", task: "Inspect", model: "task:coding" }),
    { kind: "delegate", mode: "steps", steps: [{ agent: "scout", task: "Inspect", pool: "coding" }] });
  assert.throws(() => parseDelegationRequest({ agent: "scout", task: "Inspect", role: "x", model: "task:y" }), /not both/);
  assert.throws(() => parseDelegationRequest({ agent: "scout", task: "Inspect", model: "task:" }), /requires a pool name/);
});

test("an unsupported parameter fails loudly instead of being ignored", () => {
  // Each of these is a shape a caller could plausibly send and then read a successful run as proof it was honoured.
  for (const [args, pattern] of [
    [{ agent: "scout", task: "Inspect", temperature: 0.2 }, /Unknown parameter temperature/],
    [{ agent: "scout", tasks: [{ task: "A", persist: true }] }, /tasks\[0\]: unknown parameter persist/],
  ] as const) {
    assert.throws(() => parseDelegationRequest(args as Record<string, unknown>), pattern);
  }
});

test("rejects malformed requests with a boundary-level error", () => {
  assert.throws(() => parseDelegationRequest({ task: "Inspect" }), /requires agent and task/);
  assert.throws(() => parseDelegationRequest({ agent: "scout" }), /requires agent and task/);
  assert.throws(() => parseDelegationRequest({ agent: "scout", task: "   " }), /requires agent and task/);
  assert.throws(() => parseDelegationRequest({ resume: "not-a-run-id" }), /32-character run ID/);
  assert.throws(() => parseDelegationRequest({ resume: "a".repeat(32), task: "Inspect" }), /cannot be combined with task/);
  assert.throws(() => parseDelegationRequest({ resume: "a".repeat(32), role: "x" }), /cannot be combined with role/);
  assert.throws(() => parseDelegationRequest({ agent: "scout", task: "Inspect", role: "  " }), /nonempty pool name/);
  assert.throws(() => parseDelegationRequest({ agent: "scout", task: "Inspect", model: "no-slash" }), /provider\/model-id/);
  assert.throws(() => parseDelegationRequest({ agent: "scout", task: "Inspect", model: "/model" }), /nonempty parts/);
});
