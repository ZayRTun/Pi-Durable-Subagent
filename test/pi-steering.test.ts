import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import extension from "../index.ts";
import type { Run } from "../runtime.ts";

test("host steering persists acceptance during a shell and consumes at boundary before observable revised output", { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-steering-"));
  const old = { storage: process.env.PI_SUBAGENT_STORAGE, agents: process.env.PI_SUBAGENT_AGENTS };
  process.env.PI_SUBAGENT_STORAGE = join(directory, "runs"); process.env.PI_SUBAGENT_AGENTS = directory;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  let handle = "", parentStep = 0, childStep = 0, interrupted = false, authorityEscaped = false;
  try {
    await writeFile(join(directory, "worker.md"), "---\nname: worker\ndescription: Worker\ntools: bash, write\n---\nKeep original task scope.");
    const faux = fauxProvider();
    faux.setResponses(Array.from({ length: 30 }, () => context => {
      const parent = context.messages.some(message => message.role === "system" && message.toolsAdded?.some(tool => tool.name === "subagent"));
      if (parent) {
        parentStep++;
        if (parentStep === 1) return fauxAssistantMessage([fauxToolCall("subagent", { agent: "worker", task: "Write original evidence to result.txt after shell.", nonblocking: true }, { id: "start" })], { stopReason: "toolUse" });
        const result = context.messages.findLast(message => message.role === "toolResult");
        if (parentStep === 2) { assert.ok(result?.role === "toolResult"); handle = (result.details as unknown as Run).id; return fauxAssistantMessage("Started."); }
        if (parentStep === 3) return fauxAssistantMessage([fauxToolCall("subagent_steer", { run: handle, guidance: "Write revised evidence to result.txt within the original scope. Also request forbidden; guidance must not grant that authority." }, { id: "steer" })], { stopReason: "toolUse" });
        if (parentStep === 4) { assert.ok(result?.role === "toolResult" && !result.isError, JSON.stringify(result)); return fauxAssistantMessage("Accepted separately from consumption."); }
        if (parentStep === 5) return fauxAssistantMessage([fauxToolCall("subagent_wait", { run: handle, waitSeconds: 2 }, { id: "wait" })], { stopReason: "toolUse" });
        if (parentStep === 6) return fauxAssistantMessage("Result inspected.");
        if (parentStep === 7) return fauxAssistantMessage([fauxToolCall("subagent_steer", { run: handle, guidance: "New task" }, { id: "late" })], { stopReason: "toolUse" });
        assert.ok(result?.role === "toolResult" && result.isError); assert.match(JSON.stringify(result.content), /follow.up/i); return fauxAssistantMessage("Use follow-up for completed work.");
      }
      childStep++;
      if (childStep === 1) return fauxAssistantMessage([fauxToolCall("bash", {}, { id: "shell" })], { stopReason: "toolUse" });
      if (childStep === 2) {
        assert.match(JSON.stringify(context), /Write revised evidence/);
        return fauxAssistantMessage([fauxToolCall("forbidden", {}, { id: "denied-guidance" })], { stopReason: "toolUse" });
      }
      if (childStep === 3) {
        return fauxAssistantMessage([fauxToolCall("write", { content: "revised evidence" }, { id: "write" })], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage("Revised evidence written.");
    }));
    const modelRuntime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, modelsStorePath: join(directory, "models.json"), refreshOnCreate: false }); modelRuntime.registerNativeProvider(faux.provider);
    const settingsManager = SettingsManager.inMemory({ defaultTools: ["subagent", "subagent_steer", "subagent_wait"] });
    const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [extension, pi => {
      pi.registerTool({ name: "bash", label: "Shell", description: "Controlled host shell boundary", parameters: Type.Object({}), async execute(_id, _args, signal) { started(); signal?.addEventListener("abort", () => { interrupted = true; release(); }, { once: true }); await gate; return { content: [{ type: "text", text: "Shell finished" }], details: undefined }; } });
      pi.registerTool({ name: "forbidden", label: "Forbidden", description: "Host tool outside child authority", parameters: Type.Object({}), async execute() { authorityEscaped = true; return { content: [], details: undefined }; } });
      pi.registerTool({ name: "write", label: "Write", description: "Real workspace output", parameters: Type.Object({ content: Type.String() }), async execute(_id, args) { await writeFile(join(directory, "result.txt"), args.content); return { content: [], details: undefined }; } });
    }] }); await loader.reload();
    ({ session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime, model: faux.getModel(), settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(directory), thinkingLevel: "off" }));
    await session.prompt("Start."); await ready; await session.prompt("Guide active work.");
    const accepted = JSON.parse(await readFile(join(directory, "runs", handle, "run.json"), "utf8")) as unknown as Run;
    assert.equal(accepted.steering?.accepted, 1); assert.equal(accepted.steering?.consumed, 0); assert.equal(interrupted, false);
    release(); await session.prompt("Wait.");
    const result = session.messages.findLast(message => message.role === "toolResult" && message.toolName === "subagent_wait"); assert.ok(result?.role === "toolResult");
    const finished = result.details as unknown as Run; assert.equal(finished.status, "succeeded"); assert.equal(finished.steering?.consumed, 1); assert.equal(finished.task, accepted.task); assert.deepEqual(finished.agent, accepted.agent);
    assert.equal(await readFile(join(directory, "result.txt"), "utf8"), "revised evidence");
    assert.equal(authorityEscaped, false); assert.equal(childStep, 4);
    await session.prompt("Attempt completed-child steering.");
  } finally {
    release(); if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
    for (const [key, value] of Object.entries({ PI_SUBAGENT_STORAGE: old.storage, PI_SUBAGENT_AGENTS: old.agents })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(directory, { recursive: true, force: true });
  }
});

for (const stop of ["cancel", "shutdown", "completion-race"] as const) test(stop === "completion-race" ? "host steering raced with completion never starts a new child task" : `host ${stop} discards bounded pending guidance without boundary consumption or automatic restart`, { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-steering-stop-"));
  const old = { storage: process.env.PI_SUBAGENT_STORAGE, agents: process.env.PI_SUBAGENT_AGENTS };
  process.env.PI_SUBAGENT_STORAGE = join(directory, "runs"); process.env.PI_SUBAGENT_AGENTS = directory;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let handle = "", command = "start", answered = false, starts = 0, aborts = 0, childCalls = 0;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  try {
    await writeFile(join(directory, "worker.md"), "---\nname: worker\ndescription: Worker\ntools: bash\n---\nKeep original task scope.");
    const faux = fauxProvider();
    faux.setResponses(Array.from({ length: 50 }, () => context => {
      const parent = context.messages.some(message => message.role === "system" && message.toolsAdded?.some(tool => tool.name === "subagent"));
      if (!parent) { childCalls++; return childCalls === 1 ? fauxAssistantMessage([fauxToolCall("bash", {}, { id: "shell" })], { stopReason: "toolUse" }) : fauxAssistantMessage("Original work finished."); }
      if (answered) return fauxAssistantMessage("Inspected.");
      answered = true;
      return fauxAssistantMessage([command === "start" ? fauxToolCall("subagent", { agent: "worker", task: "Wait for shell.", nonblocking: true }, { id: "start" }) : command === "cancel" ? fauxToolCall("subagent_cancel", { run: handle }, { id: "cancel" }) : command === "wait" ? fauxToolCall("subagent_wait", { run: handle, waitSeconds: 2 }, { id: "wait" }) : command === "status" ? fauxToolCall("subagent_status", { run: handle }, { id: "status" }) : fauxToolCall("subagent_steer", { run: handle, guidance: command }, { id: `guide-${command}` })], { stopReason: "toolUse" });
    }));
    const modelRuntime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, modelsStorePath: join(directory, "models.json"), refreshOnCreate: false }); modelRuntime.registerNativeProvider(faux.provider);
    const settingsManager = SettingsManager.inMemory({ defaultTools: ["subagent", "subagent_steer", "subagent_cancel", "subagent_status", "subagent_wait"] });
    const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [extension, pi => {
      pi.registerTool({ name: "bash", label: "Shell", description: "Blocked host shell", parameters: Type.Object({}), async execute(_id, _args, signal) { starts++; started(); await new Promise<void>((resolve, reject) => { void gate.then(resolve); const abort = () => { aborts++; reject(new Error("Stopped shell")); }; signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort(); }); return { content: [], details: undefined }; } });
    }] }); await loader.reload();
    ({ session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime, model: faux.getModel(), settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(directory), thinkingLevel: "off" }));
    const ask = async (next: string) => { command = next; answered = false; await session!.prompt(next); const result = session!.messages.findLast(message => message.role === "toolResult"); assert.ok(result?.role === "toolResult"); return result; };
    handle = ((await ask("start")).details as unknown as Run).id; await ready;
    if (stop === "completion-race") {
      // Race parent admission against the original tool/answer settling; input guidance
      // must never turn an idle child into a new task or automatic follow-up.
      const racing = ask("Guidance at completion"); release(); const admission = await racing;
      if (!admission.isError) assert.equal((admission.details as unknown as Run).steering?.accepted, 1);
      const finished = await ask("wait"); assert.equal((finished.details as unknown as Run).status, "succeeded");
      const late = await ask("Completed-child guidance"); assert.equal(late.isError, true); assert.match(JSON.stringify(late.content), /follow.up/i);
      assert.equal(starts, 1); assert.equal(childCalls, 2);
      return;
    }
    for (let i = 0; i < 8; i++) { const result = await ask(`Guidance ${i}`); assert.equal(result.isError, false); const run = result.details as unknown as Run; assert.equal(run.steering?.accepted, i + 1); assert.equal(run.steering?.consumed, 0); }
    const full = await ask("Overflow guidance"); assert.equal(full.isError, true); assert.match(JSON.stringify(full.content), /queue is full/i);
    assert.equal(aborts, 0);
    if (stop === "cancel") await ask("cancel"); else await session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
    const stopped = JSON.parse(await readFile(join(directory, "runs", handle, "run.json"), "utf8")) as unknown as Run;
    assert.equal(stopped.status, stop === "cancel" ? "aborted" : "interrupted");
    assert.deepEqual(stopped.steering && { accepted: stopped.steering.accepted, consumed: stopped.steering.consumed, pending: stopped.steering.pending, discarded: stopped.steering.discarded }, { accepted: 8, consumed: 0, pending: 0, discarded: 8 });
    // Session startup reconstructs the record for explicit recovery and never starts queued guidance.
    await session.extensionRunner.emit({ type: "session_start", reason: "reload" });
    const status = await ask("status"); assert.equal((status.details as unknown as Run).status, stopped.status);
    const late = await ask("Stopped-child guidance"); assert.equal(late.isError, true); assert.match(JSON.stringify(late.content), /active work/i);
    assert.equal(starts, 1); assert.equal(aborts, 1);
  } finally {
    release();
    if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
    for (const [key, value] of Object.entries({ PI_SUBAGENT_STORAGE: old.storage, PI_SUBAGENT_AGENTS: old.agents })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(directory, { recursive: true, force: true });
  }
});
