import assert from "node:assert/strict";
import { test } from "node:test";
import { subagentInstructions } from "../prompt.ts";

test("workspace guidance preserves role, quotes unusual paths and never promises isolation", () => {
  const cwd = '/tmp/project "quoted"\nnext-line';
  const prompt = subagentInstructions({ name: "scout", description: "Inspect", instructions: "Read-only role.", tools: ["read", "web_search"], timeoutMinutes: 1 }, cwd, ["read"], ["web_search"]);
  assert.ok(prompt.startsWith("Read-only role."));
  assert.ok(prompt.includes(JSON.stringify(cwd)));
  assert.match(prompt, /Relative tool paths resolve from this working directory/);
  assert.match(prompt, /Start with the named paths/);
  assert.match(prompt, /unless the task explicitly requires it/);
  assert.match(prompt, /not a filesystem sandbox/);
  assert.match(prompt, /Available tools: read/);
  assert.match(prompt, /Unavailable declared tools: web_search/);
});

test("bounded-context guidance is present but stays short", () => {
  const prompt = subagentInstructions({ name: "scout", description: "Inspect", instructions: "Read-only role.", tools: ["read"], timeoutMinutes: 1 }, "/work", ["read"], []);
  assert.match(prompt, /read only the region you need/);
  assert.match(prompt, /charged to this task's budget/);
  const overhead = prompt.length - "Read-only role.".length;
  assert.ok(overhead < 1400, `instruction overhead grew too large: ${overhead} chars`);
});

test("a loaded definition names its source and directory without re-rooting tool paths", () => {
  const definitionPath = "/opt/agents/scout.md";
  const prompt = subagentInstructions({ name: "scout", description: "Inspect", instructions: "Read-only role.", tools: ["read"], timeoutMinutes: 1, definitionPath }, "/work", ["read"], []);
  assert.match(prompt, /loaded from "\/opt\/agents\/scout\.md"/);
  assert.match(prompt, /definition-relative resource reference resolves against its containing directory "\/opt\/agents"/);
  assert.match(prompt, /Relative tool paths resolve from this working directory/);
  assert.match(prompt, /ordinary tool paths stay relative to the working directory/);
});
