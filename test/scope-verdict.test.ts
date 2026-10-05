import assert from "node:assert/strict";
import { test } from "node:test";
import { scopeVerdict } from "../benchmarks/scope-verdict.ts";

const base = { fixture: "full" as const, workspace: "/fixture/workspace", reads: ["README.md", "package.json"], bashCommands: [] as string[] };

test("named root reads and a plain listing are classified as in scope", () => {
  const result = scopeVerdict({ ...base, bashCommands: ["pwd && ls -la"] });
  assert.equal(result.scopeViolation, false);
  assert.deepEqual(result.unverifiedBash, []);
});

test("same-named nested or external files are not the named root files", () => {
  for (const path of ["docs/README.md", "../package.json", "/other/package.json"]) {
    const result = scopeVerdict({ ...base, reads: [...base.reads, path] });
    assert.equal(result.scopeViolation, true);
    assert.deepEqual(result.outOfScopeReads, [path]);
  }
});

test("unclassified shell commands yield unknown, not a clean scope verdict", () => {
  for (const command of ["git show HEAD:composer.json", "jq . composer.json", "php -r 'echo file_get_contents(\"composer.json\");'", "ls $(cat composer.json)", "grep CONTEXT.md README.md"]) {
    const result = scopeVerdict({ ...base, bashCommands: [command] });
    assert.equal(result.scopeViolation, null);
    assert.deepEqual(result.unverifiedBash, [command]);
  }
});

test("other tools are surfaced as unclassified evidence", () => {
  for (const name of ["ffgrep", "fffind", "ls"]) {
    const result = scopeVerdict({ ...base, otherTools: [name] });
    assert.equal(result.scopeViolation, null);
    assert.deepEqual(result.unverifiedTools, [name]);
  }
});

test("the absence fixture permits up to two root descriptors", () => {
  const result = scopeVerdict({ ...base, fixture: "absence", reads: ["README.md", "package.json", "composer.json"] });
  assert.equal(result.scopeViolation, false);
  assert.deepEqual(result.fallbackFiles, ["package.json", "composer.json"]);
  assert.deepEqual(result.outOfScopeReads, []);
});

test("the absence fixture rejects more than two fallback descriptors", () => {
  const result = scopeVerdict({ ...base, fixture: "absence", reads: ["package.json", "composer.json", "CONTEXT.md"] });
  assert.equal(result.scopeViolation, true);
  assert.equal(result.tooManyFallbacks, true);
});

test("an empty inspection cannot be counted as a successful scope check", () => {
  const result = scopeVerdict({ ...base, reads: [] });
  assert.equal(result.scopeViolation, null);
  assert.equal(result.requiredFilesInspected, false);
});
