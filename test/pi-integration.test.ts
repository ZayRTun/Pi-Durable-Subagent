import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

// Definitions are explicit now; point the extension at the fixture set the removed bundled fallback found.
process.env.PI_SUBAGENT_AGENTS ??= fileURLToPath(new URL("./fixtures/agents/", import.meta.url));
import extension from "../index.ts";

for (const loading of ["inline", "file"] as const) {
for (const optional of [false, true]) {
test(`real Pi SDK ${loading} delegation supplies workspace and preserves hooks with optional tools ${optional ? "present" : "absent"}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-pi-sdk-"));
  const old = process.env.PI_SUBAGENT_STORAGE;
  process.env.PI_SUBAGENT_STORAGE = join(directory, "runs");
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    await writeFile(join(directory, "evidence.txt"), "important evidence");
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("subagent", { agent: "scout", task: "Read evidence.txt and report." }, { id: "delegate-1" })], { stopReason: "toolUse" }),
      (context) => {
        assert.ok(JSON.stringify(context).includes(directory), "Child must receive its working directory without the task specifying it");
        assert.match(JSON.stringify(context), /Start with the named paths/);
        assert.match(JSON.stringify(context), /not a filesystem sandbox/);
        return fauxAssistantMessage([fauxToolCall(optional ? "fffind" : "read", { path: "evidence.txt" }, { id: "read-1" })], { stopReason: "toolUse" });
      },
      fauxAssistantMessage([fauxText("Evidence verified.")]),
      fauxAssistantMessage([fauxText("The scout verified the evidence.")]),
    ]);
    const modelRuntime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, modelsStorePath: join(directory, "models.json"), refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const model = modelRuntime.getModel("faux", "faux-1")!;
    assert.ok(model);
    let reads = 0;
    let optionalExecutions = 0;
    let blockOptional = false;
    const settingsManager = SettingsManager.inMemory({ defaultTools: ["read", "subagent"] });
    const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      additionalExtensionPaths: loading === "file" ? [fileURLToPath(new URL("../index.ts", import.meta.url))] : [],
      extensionFactories: [...(loading === "inline" ? [extension] : []), (pi) => {
        pi.on("tool_call", (event) => {
          if (event.toolName === (optional ? "fffind" : "read")) reads++;
          if (blockOptional && event.toolName === "fffind") return { block: true, reason: "Permission denied by Pi hook" };
        });
        if (optional) pi.registerTool({ name: "fffind", label: "Optional lookup", exposure: "codemode", description: "Optional extension fixture", parameters: Type.Object({ path: Type.String() }),
          execute: async () => { optionalExecutions++; return { content: [{ type: "text", text: "optional evidence" }], details: undefined }; } });
      }],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime, model,
      settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(directory), thinkingLevel: "off" }));
    await session.prompt("Delegate inspection to scout.");
    assert.equal(session.getLastAssistantText(), "The scout verified the evidence.");
    const result = session.messages.find((message) => message.role === "toolResult" && message.toolName === "subagent");
    assert.ok(result && result.role === "toolResult");
    assert.equal(result.isError, false, JSON.stringify(result.content));
    assert.equal(reads, 1);
    assert.ok(result.details && typeof result.details === "object" && !Array.isArray(result.details));
    const details = result.details as Record<string, unknown>;
    assert.equal(details.status, "succeeded");
    assert.equal(details.output, "Evidence verified.");
    assert.ok(Array.isArray(details.unavailable));
    assert.equal(details.unavailable.includes("fffind"), !optional);
    assert.ok(details.unavailable.includes("ffgrep"));
    if (optional) {
      assert.equal(optionalExecutions, 1);
      blockOptional = true;
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("subagent", { agent: "scout", task: "Exercise the permission hook." }, { id: "blocked-delegation" })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxToolCall("fffind", { path: "evidence.txt" }, { id: "blocked-lookup" })], { stopReason: "toolUse" }),
        (context) => {
          const tool = context.messages.findLast((message) => message.role === "toolResult");
          assert.ok(tool && tool.role === "toolResult" && tool.isError);
          assert.match(JSON.stringify(tool.content), /Permission denied/);
          return fauxAssistantMessage([fauxText("The lookup was blocked; no evidence was inspected.")]);
        },
        fauxAssistantMessage([fauxText("The permission hook blocked the lookup.")]),
      ]);
      await session.prompt("Verify the optional tool's permission hook.");
      assert.equal(optionalExecutions, 1);
      assert.equal(reads, 2);
    }
    if (!optional) {
      const recordPath = join(directory, "runs", String(details.id), "run.json");
      const record = JSON.parse(await readFile(recordPath, "utf8"));
      record.status = "interrupted";
      await writeFile(recordPath, JSON.stringify(record));
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("subagent", { resume: String(details.id) }, { id: "resume-without-approval" })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxText("Operator approval is required.")]),
      ]);
      await session.prompt("The model should not silently resume unfinished work.");
      const lastTool = session.messages.filter((message) => message.role === "toolResult").at(-1);
      assert.ok(lastTool && lastTool.role === "toolResult");
      assert.equal(lastTool.isError, true);
      assert.match(JSON.stringify(lastTool.content), /Explicit resume approval required/);
      assert.equal(JSON.parse(await readFile(recordPath, "utf8")).status, "interrupted");
    }
  } finally {
    session?.dispose();
    if (old === undefined) delete process.env.PI_SUBAGENT_STORAGE; else process.env.PI_SUBAGENT_STORAGE = old;
    await rm(directory, { recursive: true, force: true });
  }
});
}
}
