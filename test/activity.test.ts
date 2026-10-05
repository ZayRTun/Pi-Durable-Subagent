import assert from "node:assert/strict";
import { test } from "node:test";
import { collectToolArguments, describeActivity, reconcileToolDiagnostics, summarizeArguments, toolActivity } from "../activity.ts";

test("activity distinguishes tool work, queued work, model wait, streaming, retries and compaction", () => {
  assert.equal(describeActivity(), "Waiting for model");
  assert.equal(describeActivity({ generation: {} }), "Waiting for model");
  assert.equal(describeActivity({ generation: { message: { content: [{ type: "text", text: "partial" }] } } }), "Receiving model response");
  assert.equal(describeActivity({ generation: { retry: { at: 1, error: "retry" } } }), "Waiting to retry model");
  assert.equal(describeActivity({ generation: { deferred: { pollAt: 1 } } }), "Waiting for provider");
  assert.equal(describeActivity({ compactions: [{ blocking: true }] }), "Compacting context");
  assert.equal(describeActivity({ tools: [{ name: "read", status: "pending" }] }), "Queued read");
  assert.equal(describeActivity({ tools: [{ name: "read", status: "running" }], compactions: [{ blocking: false }] }), "Using read");
});

test("structured interruption diagnostics flag uncertainty even when a result entry exists", () => {
  const log: { callId: string; status?: string; uncertain?: boolean }[] = [{ callId: "interrupted" }, { callId: "blocked" }, { callId: "ordinary" }, { callId: "cancelled", status: "running" }];
  reconcileToolDiagnostics(log, [
    { kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "interrupted" }], data: { diagnostics: [{ code: "interrupted" }] } },
    { kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "blocked" }], data: { diagnostics: [{ code: "blocked" }] } },
    { kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "ordinary" }], data: { diagnostics: [] } },
    { kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "cancelled" }], data: { diagnostics: [{ code: "aborted" }] } },
  ]);
  assert.equal(log[0].uncertain, true);
  assert.equal(log[1].uncertain, undefined);
  assert.equal(log[2].uncertain, undefined);
  assert.equal(log[3].status, "aborted");
});

test("live interruption and cancellation diagnostics survive without text inference", () => {
  const interrupted = { callId: "a", name: "hold", status: "done", entry: "entry-1", diagnostics: [{ severity: "error", code: "interrupted", message: "may have partially run" }] };
  const aborted = { callId: "b", name: "hold", status: "done", entry: "entry-2", diagnostics: [{ severity: "error", code: "aborted" }] };
  const ordinary = { callId: "c", name: "read", status: "done", entry: "entry-3", diagnostics: [{ severity: "error", code: "tool_error" }] };
  assert.deepEqual(toolActivity(interrupted), { callId: "a", name: "hold", status: "done", uncertain: true });
  assert.deepEqual(toolActivity(aborted), { callId: "b", name: "hold", status: "aborted" });
  // A result entry with an ordinary tool error is a known outcome, not uncertainty.
  assert.deepEqual(toolActivity(ordinary), { callId: "c", name: "read", status: "done", failed: true });
});

test("tool log marks done-without-result uncertain, not ordinary completion or pending work", () => {
  assert.equal(toolActivity({ callId: "x", name: "hold", status: "done" }).uncertain, true);
  assert.equal(toolActivity({ callId: "x", name: "read", status: "done", entry: "result-entry" }).uncertain, undefined);
  assert.equal(toolActivity({ callId: "x", name: "hold", status: "running" }).uncertain, undefined);
  assert.equal(toolActivity({ callId: "x", name: "read", status: "pending" }).uncertain, undefined);
  assert.equal(toolActivity({ callId: "x", name: "hold", status: "running", output: "x".repeat(3000) }).output?.length, 2000);
});

test("tool arguments are read from real call arguments and summarized within bounds", () => {
  const entries = [{ model: [{ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "npm test -- retry-policy\nsecond line" } }] }] },
    { model: [{ role: "assistant", content: [{ type: "toolCall", id: "call-2", name: "edit", arguments: { file_path: "/work/repo/src/retry-policy.ts" } }] }] }];
  const args = collectToolArguments(entries);
  assert.deepEqual([...args.keys()], ["call-1", "call-2"]);
  assert.deepEqual(toolActivity({ callId: "call-1", name: "bash", status: "done", entry: "result-entry" }, args.get("call-1")), { callId: "call-1", name: "bash", status: "done", summary: "npm test -- retry-policy" });
  assert.equal(summarizeArguments({ command: "x".repeat(400) })!.length, 120);
  assert.equal(summarizeArguments({}), undefined);
  assert.equal(summarizeArguments({ path: "\x1b[31msrc/file.ts\x1b[0m\x00" }), "src/file.ts");
  assert.equal(summarizeArguments({ patterns: [] }), undefined, "no string argument means no summary, never a guessed one");
  for (const args of [{ apiKey: "private" }, { prompt: "private prompt" }, { url: "https://user:private@example.test/?token=private" }, { command: "TOKEN=private npm test" }, { command: "curl -H 'Authorization: Bearer private' https://example.test" }, { command: "curl --user alice:abc123 example.test" }, { command: "curl --user=alice:abc123 example.test" }, { command: "curl -ualice:abc123 example.test" }, { command: "curl -u alice:abc123 example.test" }, { command: "curl --proxy-user=alice:abc123 example.test" }, { command: "curl -Ualice:abc123 example.test" }]) {
    assert.equal(summarizeArguments(args), undefined, "do not copy secrets or arbitrary string arguments into cosmetic labels");
  }
});
