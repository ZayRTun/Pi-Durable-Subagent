import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const poolConfig = { models: { pools: { "probe reviewers": ["faux/faux-1"] } } };

const shapes = [
  ["single: agent + task", { agent: "scout", task: "Reply with the single word ok." }],
  ["poteto agent name", { agent: "poteto-agent", task: "Reply with the single word ok." }],
  ["role resolved", { agent: "scout", task: "Reply with the single word ok.", role: "probe reviewers" }, poolConfig],
  ["role unconfigured", { agent: "scout", task: "Reply with the single word ok.", role: "no such pool" }, poolConfig],
  ["explicit model", { agent: "scout", task: "Reply with the single word ok.", model: "faux/faux-1" }],
  ["role, the old shape", { agent: "scout", task: "Reply with the single word ok.", role: "recon" }],
  ["tasks, two steps", { agent: "scout", tasks: [{ task: "Reply A." }, { agent: "reviewer", task: "Reply B." }] }],
  ["chain sequential", { chain: [{ agent: "scout", task: "Reply A." }, { agent: "scout", task: "Reply B." }] }],
];

async function probe(label, args, config) {
  const directory = await mkdtemp(join(tmpdir(), "poteto-shape-"));
  const store = join(directory, "runs");
  const previous = { storage: process.env.PI_SUBAGENT_STORAGE, config: process.env.PI_SUBAGENT_CONFIG };
  process.env.PI_SUBAGENT_STORAGE = store;
  let session;
  try {
    if (config) {
      process.env.PI_SUBAGENT_CONFIG = join(directory, "durable-subagents.json");
      await writeFile(process.env.PI_SUBAGENT_CONFIG, JSON.stringify(config));
    } else {
      delete process.env.PI_SUBAGENT_CONFIG;
    }
    const faux = fauxProvider();
    const answer = () => fauxAssistantMessage([fauxText("faux-ok")]);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("subagent", args, { id: "probe" })], { stopReason: "toolUse" }),
      ...Array.from({ length: 12 }, () => answer),
    ]);
    const modelRuntime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, modelsStorePath: join(directory, "models.json"), refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const model = modelRuntime.getModel("faux", "faux-1");
    const settingsManager = SettingsManager.inMemory({ defaultTools: ["read", "subagent"] });
    const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, additionalExtensionPaths: [extensionPath] });
    await loader.reload();
    const loadErrors = loader.getExtensions().errors;
    ({ session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime, model,
      settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(directory), thinkingLevel: "off" }));
    await session.prompt("Delegate.");
    const result = session.messages.find((message) => message.role === "toolResult" && message.toolName === "subagent");
    const content = (result?.content ?? []).map((part) => part.type === "text" ? part.text : "").join("").replace(/\s+/g, " ").slice(0, 220);
    let records = [];
    try { records = (await readdir(store)).filter((name) => /^[a-f0-9]{32}$/.test(name)); } catch {}
    const recorded = [];
    for (const id of records) {
      const run = JSON.parse(await readFile(join(store, id, "run.json"), "utf8"));
      recorded.push({ agent: run.agent.name, model: `${run.model.provider}/${run.model.modelId}`, role: run.role, task: run.task.slice(0, 30) });
    }
    return { label, loadErrors: loadErrors.length, isError: result?.isError === true, records: records.length, recorded, content: content || "(no result)" };
  } catch (error) {
    return { label, loadErrors: -1, isError: true, records: 0, content: `THREW: ${String(error.message).slice(0, 200)}` };
  } finally {
    if (previous.storage === undefined) delete process.env.PI_SUBAGENT_STORAGE; else process.env.PI_SUBAGENT_STORAGE = previous.storage;
    if (previous.config === undefined) delete process.env.PI_SUBAGENT_CONFIG; else process.env.PI_SUBAGENT_CONFIG = previous.config;
    try { session?.dispose?.(); } catch {}
    await rm(directory, { recursive: true, force: true });
  }
}

for (const [label, args, config] of shapes) console.log(JSON.stringify(await probe(label, args, config)));
