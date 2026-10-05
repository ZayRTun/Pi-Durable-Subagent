import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { bridgeModels } from "../adapters.ts";

test("durable model adapter sends stable child session routing on generation and compaction", async () => {
  const faux = fauxProvider();
  const models = createModels(); models.setProvider(faux.provider);
  const ids: (string | undefined)[] = [];
  const registry = {
    find: (provider: string, id: string) => models.getModel(provider, id),
    getAll: () => [...models.getModels()],
    streamSimple: models.streamSimple.bind(models),
  };
  faux.setResponses([
    (_context, options) => { ids.push(options?.sessionId); return fauxAssistantMessage("answer"); },
    (_context, options) => { ids.push(options?.sessionId); return fauxAssistantMessage("summary"); },
  ]);
  const bridge = bridgeModels(registry, "durable-child-session");
  const model = bridge.getModel("faux", "faux-1")!;
  await bridge.streamSimple(model, { messages: [] }).result();
  await bridge.completeSimple(model, { messages: [] });
  assert.deepEqual(ids, ["durable-child-session", "durable-child-session"]);
});
