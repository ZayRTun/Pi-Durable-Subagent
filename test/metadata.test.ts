import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

// Definitions are explicit now; point the extension at the fixture set the removed bundled fallback found.
process.env.PI_SUBAGENT_AGENTS ??= fileURLToPath(new URL("./fixtures/agents/", import.meta.url));

const call = (id: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall("subagent", args, { id })], { stopReason: "toolUse" });

function textOf(message: { content: { type: string; text?: string }[] }) {
  return message.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
}

test("the model-facing tool result carries a compact per-run metadata line with model, thinking, duration and billed usage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-metadata-"));
  const previous = process.env.PI_SUBAGENT_STORAGE;
  process.env.PI_SUBAGENT_STORAGE = join(directory, "runs");
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const faux = fauxProvider();
    faux.setResponses([
      call("delegate", { agent: "scout", task: "Read the README and report the purpose." }),
      fauxAssistantMessage([fauxText("A tiny fixture.")]),
      fauxAssistantMessage([fauxText("The scout reported the fixture purpose.")]),
    ]);
    const modelRuntime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, modelsStorePath: join(directory, "models.json"), refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const model = modelRuntime.getModel("faux", "faux-1")!;
    const settingsManager = SettingsManager.inMemory({ defaultTools: ["read", "subagent"] });
    const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url))] });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime, model,
      settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(directory), thinkingLevel: "off" }));

    await session.prompt("Delegate to scout.");
    const result = session.messages.find((message) => message.role === "toolResult" && message.toolName === "subagent");
    assert.ok(result && result.role === "toolResult");
    const text = textOf(result);
    assert.match(text, /model faux\/faux-1/, "selected model must be visible to the caller");
    assert.match(text, /thinking (low|off)/, "resolved thinking must be visible to the caller");
    assert.match(text, /·\s*\d+s\s*·/, "elapsed duration must be visible to the caller");
    assert.match(text, /tok/, "recorded tokens must be visible to the caller");
    assert.match(text, /billed this call/, "a fresh run must be labelled as newly billed");
    assert.doesNotMatch(text, /not newly billed/);
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_STORAGE; else process.env.PI_SUBAGENT_STORAGE = previous;
    try { session?.dispose?.(); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
});

for (const retainedDelivery of [true, false])
test(`retrieving a stored run ${retainedDelivery ? "does not re-report delivered usage" : "identifies historical usage reported on a new branch"}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-metadata-resume-"));
  const previous = process.env.PI_SUBAGENT_STORAGE;
  process.env.PI_SUBAGENT_STORAGE = join(directory, "runs");
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const faux = fauxProvider();
    faux.setResponses([
      call("delegate", { agent: "scout", task: "Read the README and report the purpose." }),
      fauxAssistantMessage([fauxText("A tiny fixture.")]),
      fauxAssistantMessage([fauxText("The scout reported the fixture purpose.")]),
    ]);
    const modelRuntime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, modelsStorePath: join(directory, "models.json"), refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const model = modelRuntime.getModel("faux", "faux-1")!;
    const settingsManager = SettingsManager.inMemory({ defaultTools: ["read", "subagent"] });
    const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url))] });
    await loader.reload();
    const manager = SessionManager.inMemory(directory);
    ({ session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime, model,
      settingsManager, resourceLoader: loader, sessionManager: manager, thinkingLevel: "off" }));

    await session.prompt("Delegate to scout.");
    const first = session.messages.find((message) => message.role === "toolResult" && message.toolName === "subagent");
    assert.ok(first && first.role === "toolResult" && typeof first.details === "object" && first.details);
    const runId = String((first.details as { id: string }).id);
    assert.ok(first.usage, "a fresh delegation must report its billed usage to Pi's accounting");

    if (!retainedDelivery) {
      const anchor = manager.getEntries().find(entry => entry.type === "message" && entry.message.role === "user");
      assert.ok(anchor);
      manager.branch(anchor.id);
    }
    faux.setResponses([
      call("retrieve", { resume: runId }),
      fauxAssistantMessage([fauxText("Retrieved the stored answer.")]),
    ]);
    await session.prompt("Retrieve the stored scout result.");
    const second = session.messages.filter((message) => message.role === "toolResult" && message.toolName === "subagent").at(-1);
    assert.ok(second && second.role === "toolResult");
    const text = textOf(second);
    assert.doesNotMatch(text, /billed this call/);
    if (retainedDelivery) {
      assert.match(text, /recorded usage \(retrieved; not newly billed\)/);
      assert.equal(second.usage, undefined, "retrieval must not re-report usage already accounted to Pi");
    } else {
      assert.match(text, /reported on this branch; no new model work/);
      assert.doesNotMatch(text, /not newly billed/);
      assert.deepEqual(second.usage, first.usage, "historical usage missing from this branch is reported, not generated again");
    }
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_STORAGE; else process.env.PI_SUBAGENT_STORAGE = previous;
    try { session?.dispose?.(); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
});
