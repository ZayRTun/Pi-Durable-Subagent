import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";

interface RegisteredTool {
  description: string;
  execute: (...args: unknown[]) => Promise<{ content: { type: string; text: string }[] }>;
}

test("subagents_list reports declared model/thinking instead of claiming caller inheritance or a resolved model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-list-agents-"));
  const agents = join(directory, "agents");
  const configPath = join(directory, "durable-subagents.json");
  const old = {
    agents: process.env.PI_SUBAGENT_AGENTS,
    config: process.env.PI_SUBAGENT_CONFIG,
    storage: process.env.PI_SUBAGENT_STORAGE,
  };
  try {
    await mkdir(agents, { recursive: true });
    await writeFile(join(agents, "reviewer.md"), "---\nname: reviewer\ndescription: Review fixture\ntools: read, bash\n---\nReview changes.\n");
    // A configured pin and a role pool both override the absent definition model during delegation.
    await writeFile(configPath, JSON.stringify({ models: { agents: { reviewer: "faux/pinned-model" }, pools: { reviewer: ["faux/pool-model"] } } }));
    process.env.PI_SUBAGENT_AGENTS = agents;
    process.env.PI_SUBAGENT_CONFIG = configPath;
    process.env.PI_SUBAGENT_STORAGE = join(directory, "runs");

    const tools = new Map<string, RegisteredTool>();
    const pi = {
      registerFlag: () => {},
      on: () => () => {},
      registerTool: (tool: RegisteredTool & { name: string }) => { tools.set(tool.name, tool); },
      registerCommand: () => {},
      registerEntryRenderer: () => {},
      registerMessageRenderer: () => {},
    } as unknown as ExtensionAPI;
    await extension(pi);

    const list = tools.get("subagents_list");
    assert.ok(list, "subagents_list must be registered");
    assert.match(list.description, /declared model/);
    assert.match(list.description, /resolved per Delegation/);
    assert.doesNotMatch(list.description, /resolved model/i);

    const result = await list.execute("list-1", {}, undefined, undefined, undefined);
    const text = result.content.map((part) => part.text).join("\n");
    assert.match(text, /declared model: not declared \(resolved per Delegation\)/);
    assert.doesNotMatch(text, /model: inherits the caller/);
    // The pin and pool affect delegation resolution; the listing must not present either as the model in use.
    assert.doesNotMatch(text, /pinned-model|pool-model/);
    // Thinking is genuinely inherited when the definition omits it, so its wording stays as inheritance.
    assert.match(text, /thinking: inherits the caller/);
  } finally {
    for (const [key, value] of [["PI_SUBAGENT_AGENTS", old.agents], ["PI_SUBAGENT_CONFIG", old.config], ["PI_SUBAGENT_STORAGE", old.storage]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
