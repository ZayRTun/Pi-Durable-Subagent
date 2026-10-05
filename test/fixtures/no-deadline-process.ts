import { createModels, Type } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineTool } from "@earendil-works/pi-durable";
import { Runtime, runId, type Run } from "../../runtime.ts";

const directory = process.argv[2];
const runtime = new Runtime(directory);
const faux = fauxProvider();
const models = createModels(); models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" })]);
const run: Run = { version: 1, id: runId("liveness", "work"), sessionId: "liveness", task: "Hold safely.",
  agent: { name: "worker", description: "Liveness fixture", instructions: "Use hold.", tools: ["hold"] },
  cwd: directory, model: { provider: "faux", modelId: "faux-1" }, thinking: "off", createdAt: Date.now(), updatedAt: Date.now(), status: "running", activity: "Starting", unavailable: [] };
process.on("SIGTERM", () => { void runtime.close(); });
const tool = defineTool({ name: "hold", description: "Await cancellation", parameters: Type.Object({}), execute: async (_args, _api, context) => {
  console.log("ready");
  await new Promise<void>((_resolve, reject) => {
    const abort = () => reject(new Error("Stopped"));
    context.abortSignal?.addEventListener("abort", abort, { once: true });
    if (context.abortSignal?.aborted) abort();
  });
  return {};
} });
const result = await runtime.execute(run, { models, tools: [tool] });
console.log(result.status);
await runtime.close();
