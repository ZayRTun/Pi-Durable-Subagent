import { dirname } from "node:path";
import type { AgentDefinition } from "./agents.ts";

/** Plain run data only: fresh and resumed Sub-agents get the same workspace guidance. */
export function subagentInstructions(agent: AgentDefinition, cwd: string, available: string[], unavailable: string[]): string {
  const definition = agent.definitionPath
    ? `\nThis definition was loaded from ${JSON.stringify(agent.definitionPath)}; a definition-relative resource reference resolves against its containing directory ${JSON.stringify(dirname(agent.definitionPath))}, while ordinary tool paths stay relative to the working directory above.`
    : "";
  return `${agent.instructions}\n\nWorkspace: ${JSON.stringify(cwd)}. Relative tool paths resolve from this working directory.${definition}
Start with the named paths; read them directly before considering a search. If discovery is necessary, search only the relevant subtree within this workspace. Do not search the filesystem root, home directory, or unrelated workspaces unless the task explicitly requires it. Ask for clarification or report missing paths rather than broadening the search silently.
Keep context small: for a long file read only the region you need and return for more if required; prefer narrow paths and bounded output over whole-file or whole-tree dumps. Tool output is charged to this task's budget.
This is not a filesystem sandbox. Tools run with the invoking Pi process's permissions; follow the task scope and permission hooks.
Available tools: ${available.join(", ") || "none"}.
Unavailable declared tools: ${unavailable.join(", ") || "none"}. Do not assume unavailable capabilities. Report verification gaps and capability limitations honestly.`;
}
