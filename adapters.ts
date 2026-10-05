// Root export also works with Pi 1.0's unbundled compat alias; /models does not.
import { createModels, type Models } from "@earendil-works/pi-ai";
import type { ExtensionToolContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { AgentDefinition } from "./agents.ts";
import { selectTools } from "./agents.ts";

type ToolDefinition = Parameters<typeof defineTool>[0];

export interface NestedResult {
  content: { type: "text"; text: string }[];
  isError: boolean;
}

/** A nested delegation, supplied by this extension rather than taken from the caller's Pi tool list. */
export interface NestedDelegation {
  prefix: string;
  parameters: ToolDefinition["parameters"];
  description: string;
  run(callId: string, args: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: (text: string) => void): Promise<NestedResult>;
}

/** Use Pi's configured provider/auth path. No credentials are copied into durable storage. */
export function bridgeModels(registry: Pick<ModelRegistry, "find" | "getAll" | "streamSimple">, sessionId: string): Models {
  const models = createModels();
  models.getModel = (provider, id) => registry.find(provider, id);
  models.getModels = (provider) => registry.getAll().filter((model) => !provider || model.provider === provider);
  models.streamSimple = (model, context, options) => registry.streamSimple(model, context, { ...options, sessionId, deferred: false });
  models.completeSimple = (model, context, options) => models.streamSimple(model, context, options).result();
  return models;
}

/**
 * Call through the live owning Pi runtime, preserving host permissions/hooks. Detached execution
 * retains the context only until the awaited session shutdown; every call supplies its own signal.
 * `nested` is offered only to a definition that asks to delegate, and only while depth remains.
 */
export function bridgeTools(agent: AgentDefinition, ctx: ExtensionToolContext, nested?: NestedDelegation): ToolRegistration[] {
  const { tools } = selectTools(agent, ctx.tools.map((tool) => tool.name));
  const registrations = tools.map((name) => {
    const source = ctx.tools.find((tool) => tool.name === name)!;
    return defineTool({
      name, description: source.description, parameters: source.parameters,
      // Third-party hooks may add effects, so even nominally read-only nested tools default to unsafe.
      replay: "unsafe",
      executionMode: "sequential",
      execute: async (args, api, context) => {
        const result = await ctx.executeTool(name, args, {
          signal: context.abortSignal,
          onUpdate: (update) => {
            // Keep details/output bounded by Durable, rather than persisting arbitrary extension internals.
            const text = update.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
            if (text) api.output(text.slice(-4096));
          },
        });
        return { content: result.result.content, isError: result.isError };
      },
    });
  });
  if (nested && agent.tools.includes("subagent")) {
    let count = 0;
    registrations.push(defineTool({
      name: "subagent", description: nested.description, parameters: nested.parameters,
      replay: "unsafe", executionMode: "sequential",
      execute: async (args, api, context) => {
        const result = await nested.run(`${nested.prefix}:${++count}`, args as Record<string, unknown>, context.abortSignal,
          (text) => api.output(text.slice(-4096)));
        return { content: result.content, isError: result.isError };
      },
    }));
  }
  return registrations;
}
