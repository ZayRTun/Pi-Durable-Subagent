import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseModelRef, type ModelRef } from "./request.ts";

export interface ModelPoolConfig {
  agents: Record<string, string>;
  pools: Record<string, string[]>;
}

/** A fresh object each time: a shared empty value would let one write leak into every later read. */
const emptyConfig = (): ModelPoolConfig => ({ agents: {}, pools: {} });

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) if (typeof entry === "string") out[key] = entry;
  return out;
}

function poolRecord(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string[]> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (Array.isArray(entry) && entry.length && entry.every((item) => typeof item === "string")) out[key] = entry as string[];
  }
  return out;
}

/**
 * The config file is optional. A missing one is silent; a malformed one is reported rather than
 * fatal, so a typo in a pool name never blocks delegation.
 */
export async function loadModelConfig(path: string): Promise<{ config: ModelPoolConfig; errors: string[] }> {
  let source: string;
  try { source = await readFile(path, "utf8"); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { config: emptyConfig(), errors: code === "ENOENT" ? [] : [`${path}: ${(error as Error).message}`] };
  }
  try {
    const data = JSON.parse(source) as { models?: { agents?: unknown; pools?: unknown } } | null;
    const models = data?.models ?? {};
    return { config: { agents: stringRecord(models.agents), pools: poolRecord(models.pools) }, errors: [] };
  } catch (error) {
    return { config: emptyConfig(), errors: [`${path}: ${(error as Error).message}`] };
  }
}

export interface ResolvedModel {
  model: ModelRef;
  pool?: string;
  poolResolved: boolean;
}

/** Prefer a pool entry that differs from the caller's own model, because a second opinion needs a different model. */
function preferDistinct(entries: readonly string[], parent?: ModelRef): ModelRef {
  const refs = entries.map((entry) => parseModelRef(entry));
  return refs.find((ref) => !parent || ref.provider !== parent.provider || ref.modelId !== parent.modelId) ?? refs[0];
}

/**
 * A call-level model wins, then a named pool, then an operator pin, then the definition, then the parent.
 * An unconfigured pool falls back and reports itself unresolved so the caller sees the substitution.
 */
export function resolveModel(input: {
  agentName: string;
  agentModel?: string;
  parent?: ModelRef;
  model?: ModelRef;
  pool?: string;
  inherit?: boolean;
  config: ModelPoolConfig;
}): ResolvedModel | undefined {
  if (input.inherit) return input.parent ? { model: input.parent, poolResolved: true } : undefined;
  if (input.model) return { model: input.model, pool: input.pool, poolResolved: true };
  if (input.pool) {
    const entries = input.config.pools[input.pool];
    if (entries) return { model: preferDistinct(entries, input.parent), pool: input.pool, poolResolved: true };
  }
  const configured = input.config.agents[input.agentName] ?? input.agentModel;
  const model = configured ? parseModelRef(configured) : input.parent;
  return model ? { model, pool: input.pool, poolResolved: false } : undefined;
}

/**
 * Read the whole config document so unrelated top-level fields survive a model rewrite. A missing file
 * starts empty; an existing unreadable or non-object file is refused rather than silently overwritten.
 */
async function readConfigDocument(path: string): Promise<Record<string, unknown>> {
  let source: string;
  try { source = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`${path}: refusing to overwrite existing config: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(source); }
  catch (error) { throw new Error(`${path}: refusing to overwrite existing config: ${(error as Error).message}`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path}: refusing to overwrite existing config: expected a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** Merge pools and pins into the config file, so model selection is configurable without hand-editing JSON. */
export async function writeModelConfig(path: string, update: { pools?: Record<string, string[]>; agents?: Record<string, string> }): Promise<ModelPoolConfig> {
  const document = await readConfigDocument(path);
  const models = document.models && typeof document.models === "object" && !Array.isArray(document.models)
    ? document.models as Record<string, unknown> : {};
  const config: ModelPoolConfig = { agents: stringRecord(models.agents), pools: poolRecord(models.pools) };
  for (const [name, entries] of Object.entries(update.pools ?? {})) {
    if (!name.trim()) throw new Error("pool names must not be empty");
    if (!Array.isArray(entries) || !entries.length) throw new Error(`pool ${name} needs at least one model`);
    config.pools[name] = entries.map((entry) => {
      const ref = parseModelRef(entry);
      return `${ref.provider}/${ref.modelId}`;
    });
  }
  for (const [name, model] of Object.entries(update.agents ?? {})) {
    if (!name.trim()) throw new Error("agent names must not be empty");
    const ref = parseModelRef(model);
    config.agents[name] = `${ref.provider}/${ref.modelId}`;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ ...document, models: { ...models, agents: config.agents, pools: config.pools } }, null, 2)}\n`);
  return config;
}
