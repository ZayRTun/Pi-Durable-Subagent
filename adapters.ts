// Root export also works with Pi 1.0's unbundled compat alias; /models does not.
import { createModels, type Models } from "@earendil-works/pi-ai";
import type { ExtensionToolContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { isAbsolute, resolve } from "node:path";
import type { AgentDefinition } from "./agents.ts";
import { selectTools } from "./agents.ts";

type ToolDefinition = Parameters<typeof defineTool>[0];

/** Exact namespace instruction that explicitly opts an extension tool into worktree use. */
export const WORKSPACE_INDEPENDENT_TOOL_INSTRUCTION = "pi-durable-subagent: workspace-independent";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function bindWorkspaceArguments(name: string, args: Record<string, unknown>, cwd: string): Record<string, unknown> {
  const bound = { ...args };
  if (name === "bash" && typeof bound.command === "string") {
    bound.command = `(cd -- ${shellQuote(cwd)} && {\n${bound.command}\n})`;
  } else if (name === "read" && typeof bound.path === "string" && !isAbsolute(bound.path)) {
    bound.path = resolve(cwd, bound.path);
  } else if (["grep", "find", "ls"].includes(name)) {
    // These Pi built-ins resolve omitted scopes from the host cwd. Make the
    // effective scope explicit before entering Pi's normal validation/hooks.
    const scope = bound.path;
    if (typeof scope !== "string" || !scope) bound.path = cwd;
    else if (!isAbsolute(scope)) bound.path = resolve(cwd, scope);
  }
  return bound;
}

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
export function bridgeTools(agent: AgentDefinition, ctx: ExtensionToolContext, nested?: NestedDelegation,
  workspace?: { cwd: string }, builtinTools: ReadonlySet<string> = new Set(),
  declaredWorkspaceIndependent: ReadonlySet<string> = new Set()): ToolRegistration[] {
  const { tools } = selectTools(agent, ctx.tools.map((tool) => tool.name));
  const boundBuiltinNames = new Set(["bash", "read", "grep", "find", "ls"]);
  const registrations = tools.filter((name) => !workspace ||
    (boundBuiltinNames.has(name) && builtinTools.has(name)) || declaredWorkspaceIndependent.has(name)).map((name) => {
    const source = ctx.tools.find((tool) => tool.name === name)!;
    return defineTool({
      name, description: source.description, parameters: source.parameters,
      // Third-party hooks may add effects, so even nominally read-only nested tools default to unsafe.
      replay: "unsafe",
      executionMode: "sequential",
      execute: async (args, api, context) => {
        const shouldBindBuiltin = workspace && builtinTools.has(name) && boundBuiltinNames.has(name);
        const result = await ctx.executeTool(name, shouldBindBuiltin ? bindWorkspaceArguments(name, args as Record<string, unknown>, workspace.cwd) : args, {
          signal: context.abortSignal,
          onUpdate: (update) => {
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
