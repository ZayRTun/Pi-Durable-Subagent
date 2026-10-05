import { readdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";

export const AGENT_COLORS: Record<string, string> = { cyan: "#56B6C2", green: "#98C379", yellow: "#E5C07B", blue: "#61AFEF", purple: "#C678DD", red: "#E06C75", orange: "#D19A66", pink: "#E88CB2" };
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export interface AgentDefinition {
  name: string;
  description: string;
  instructions: string;
  /** Realpath of the definition file this agent was loaded from; absent for parseAgent-only definitions. */
  definitionPath?: string;
  tools: string[];
  color?: string;
  model?: string;
  thinking?: typeof THINKING[number];
  timeoutMinutes?: number;
}

/** Explicit allowlists are required: absent/malformed configuration never grants all tools. */
export function parseAgent(source: string): AgentDefinition {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(source);
  if (!match) throw new Error("Agent definition requires YAML frontmatter");
  const doc = parseDocument(match[1], { uniqueKeys: true });
  if (doc.errors.length) throw new Error(doc.errors[0].message);
  const data = doc.toJS();
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid frontmatter");
  for (const field of ["name", "description"] as const) {
    if (typeof data[field] !== "string" || !data[field].trim()) throw new Error(`Missing ${field}`);
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(data.name)) throw new Error("Invalid agent name");
  const tools = typeof data.tools === "string" ? data.tools.split(",").map((t: string) => t.trim()) : data.tools;
  if (!Array.isArray(tools) || tools.some((t) => typeof t !== "string" || !t.trim())) {
    throw new Error("tools must be an explicit list of nonempty names; add one, or shadow this definition from an earlier directory");
  }
  const timeout = data.timeoutMinutes;
  if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 1 || timeout > 480)) {
    throw new Error("timeoutMinutes must be between 1 and 480");
  }
  if (data.allowSubagents !== undefined && typeof data.allowSubagents !== "boolean") throw new Error("allowSubagents must be a boolean");
  if (data.model !== undefined && (typeof data.model !== "string" || !/^[^/\s]+\/\S+$/.test(data.model))) {
    throw new Error("model must be provider/model");
  }
  if (data.color !== undefined && (typeof data.color !== "string" || (!Object.hasOwn(AGENT_COLORS, data.color) && !/^#[0-9a-f]{6}$/i.test(data.color)))) {
    throw new Error("color must be a supported named badge color or six-digit hex");
  }
  if (data.thinking !== undefined && !THINKING.includes(data.thinking)) throw new Error("Invalid thinking level");
  const instructions = match[2].trim();
  if (!instructions) throw new Error("Agent instructions are empty");
  const declared = [...new Set<string>(tools.map((name: string) => name.trim()))];
  // `allowSubagents` is how a packaged definition spells "this one may delegate".
  if (data.allowSubagents === true && !declared.includes("subagent")) declared.push("subagent");
  return {
    name: data.name,
    description: data.description,
    instructions,
    tools: declared,
    ...(timeout !== undefined ? { timeoutMinutes: timeout } : {}),
    ...(typeof data.color === "string" ? { color: data.color } : {}),
    ...(data.model !== undefined ? { model: data.model } : {}),
    ...(data.thinking !== undefined ? { thinking: data.thinking } : {}),
  };
}

/**
 * Load definitions from one or more directories. Earlier directories win, so an operator definition
 * shadows a bundled one with the same name. A duplicate inside a single directory stays an error.
 */
export async function loadAgents(directory: string | readonly string[]): Promise<{
  agents: AgentDefinition[];
  errors: { file: string; message: string }[];
}> {
  const directories = typeof directory === "string" ? [directory] : directory;
  const agents: AgentDefinition[] = [];
  const errors: { file: string; message: string }[] = [];
  for (const source of directories) {
    let files: string[];
    try { files = await readdir(source); }
    catch (error) {
      errors.push({ file: source, message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const inherited = new Set(agents.map((agent) => agent.name));
    const seen = new Set<string>();
    for (const file of files.filter((f) => f.endsWith(".md")).sort()) {
      const path = join(source, file);
      try {
        const source = await readFile(path, "utf8");
        const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
        const document = header ? parseDocument(header[1], { uniqueKeys: true }) : undefined;
        const name = document && !document.errors.length ? document.toJS()?.name : undefined;
        if (typeof name === "string" && inherited.has(name)) {
          if (seen.has(name)) throw new Error(`Duplicate agent name: ${name}`);
          seen.add(name);
          continue;
        }
        const agent = parseAgent(source);
        if (seen.has(agent.name)) throw new Error(`Duplicate agent name: ${agent.name}`);
        seen.add(agent.name);
        if (agents.some((existing) => existing.name === agent.name)) continue;
        agents.push({ ...agent, definitionPath: await realpath(path) });
      } catch (error) {
        errors.push({ file: path, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { agents, errors };
}

/** Callable tools only; never widen permissions or expose delegation through a bridge. */
export function selectTools(agent: AgentDefinition, available: readonly string[]) {
  const callable = new Set(available);
  const forbidden = new Set(["subagent", "codemode", "tool_search"]);
  const tools = agent.tools.filter((name) => callable.has(name) && !forbidden.has(name));
  return { tools, unavailable: agent.tools.filter((name) => !tools.includes(name)) };
}
