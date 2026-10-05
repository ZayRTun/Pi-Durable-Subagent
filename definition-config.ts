import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";

/** A definition-directory list plus every problem found while building it. */
export interface AgentDirectoryResolution {
  directories: string[];
  errors: string[];
}

function expandHome(entry: string): string {
  if (entry === "~") return homedir();
  if (entry.startsWith("~/") || entry.startsWith("~\\")) return resolve(homedir(), entry.slice(2));
  return entry;
}

/**
 * Resolve definition directories, most specific first. A truthy `PI_SUBAGENT_AGENTS` path list wins,
 * then the config's top-level `agentDirectories`, then the standalone `<agent dir>/agents` default.
 * Relative configured paths resolve against the config file's directory and `~/` expands to home.
 * A missing config yields the default; an unreadable, malformed, or invalidly typed config fails
 * closed with reported errors instead of silently widening to the default. `agentDirectories: []`
 * explicitly loads no definitions.
 */
export async function resolveAgentDirectories(options: {
  configPath: string;
  defaultDirectory: string;
  envValue?: string;
}): Promise<AgentDirectoryResolution> {
  const env = options.envValue;
  if (env) {
    const entries = env.split(delimiter).map((entry) => entry.trim()).filter(Boolean);
    if (!entries.length) return { directories: [], errors: ["PI_SUBAGENT_AGENTS must name at least one directory"] };
    return { directories: entries.map((entry) => resolve(expandHome(entry))), errors: [] };
  }

  let source: string;
  try {
    source = await readFile(options.configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { directories: [options.defaultDirectory], errors: [] };
    return { directories: [], errors: [`${options.configPath}: ${(error as Error).message}`] };
  }

  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch (error) {
    return { directories: [], errors: [`${options.configPath}: ${(error as Error).message}`] };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { directories: [], errors: [`${options.configPath}: expected a JSON object`] };
  }
  if (!Object.hasOwn(data, "agentDirectories")) return { directories: [options.defaultDirectory], errors: [] };

  const configured = (data as { agentDirectories?: unknown }).agentDirectories;
  if (!Array.isArray(configured)) {
    return { directories: [], errors: [`${options.configPath}: agentDirectories must be an array of directory paths`] };
  }
  const directories: string[] = [];
  for (const entry of configured) {
    if (typeof entry !== "string" || !entry.trim()) {
      return { directories: [], errors: [`${options.configPath}: agentDirectories entries must be nonempty strings`] };
    }
    directories.push(resolve(dirname(options.configPath), expandHome(entry.trim())));
  }
  return { directories, errors: [] };
}
