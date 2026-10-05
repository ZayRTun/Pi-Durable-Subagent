import assert from "node:assert/strict";
import { test } from "node:test";
import { groupFacts, groupHeading, MODE_LABELS, type DelegationEntry } from "../presentation.ts";

const entry = (runId: string): DelegationEntry => ({ runId, agent: "worker", requestedTask: "task", phase: "run" });
const run = (id: string, status: string, cost = 0) => ({ id, status, usage: { cost: { total: cost } } });

test("done counts succeeded, failed, and aborted, and excludes running, interrupted, pending, and not-run", () => {
  const entries = [entry("a"), entry("b"), entry("c"), entry("d"), entry("e")];
  const runs = [run("a", "succeeded"), run("b", "failed"), run("c", "running"), run("d", "interrupted")];
  const facts = groupFacts(entries, runs);
  assert.equal(facts.total, 5);
  assert.equal(facts.done, 2);
  assert.equal(facts.failed, 1);
  assert.equal(facts.interrupted, 1);
});

test("the heading reports flags only when present and sums recorded cost", () => {
  const facts = groupFacts([entry("a"), entry("b")], [run("a", "succeeded", 0.001), run("b", "aborted", 0.002)]);
  const heading = groupHeading("ordered", facts);
  assert.match(heading, /^Delegation · Ordered · 2\/2 done · 1 cancelled · ~\$0\.0030$/);
  assert.equal(groupHeading("parallel", groupFacts([entry("a")], [run("a", "running")])), "Delegation · Parallel · 0/1 done");
});

test("mode labels are the approved names", () => {
  assert.deepEqual(MODE_LABELS, { single: "Single", ordered: "Ordered", chain: "Chain", parallel: "Parallel" });
});
