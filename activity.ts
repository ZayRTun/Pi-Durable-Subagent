// These fields are the presentation contract of Durable's pi.live document.
type LiveActivity = {
  tools?: { name: string; status: string }[];
  compactions?: { blocking: boolean }[];
  generation?: { retry?: unknown; deferred?: unknown; message?: { content?: unknown[] } };
};

type ToolDiagnostic = { severity?: string; message?: string; code?: string };
type ToolSlot = {
  callId: string; name: string; status: string; output?: string; entry?: unknown;
  diagnostics?: readonly ToolDiagnostic[];
};

const diagnosticCodes = (call: ToolSlot) => new Set((call.diagnostics ?? []).flatMap((diagnostic) => diagnostic.code ? [diagnostic.code] : []));

export type ToolArguments = Record<string, unknown>;

/**
 * Real tool-call arguments by call ID, read from the model messages of committed entries. The live
 * tool slots do not carry arguments, so this is the only source that does not guess from output text.
 */
export function collectToolArguments(entries: readonly { model?: readonly unknown[] }[]): Map<string, ToolArguments> {
  const map = new Map<string, ToolArguments>();
  for (const entry of entries) {
    for (const raw of entry.model ?? []) {
      if (!raw || typeof raw !== "object") continue;
      const message = raw as { role?: string; content?: unknown };
      if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (!part || typeof part !== "object") continue;
        const call = part as { type?: string; id?: string; arguments?: unknown };
        if (call.type === "toolCall" && typeof call.id === "string" && call.arguments && typeof call.arguments === "object") map.set(call.id, call.arguments as ToolArguments);
      }
    }
  }
  return map;
}

const SUMMARY_KEYS = ["command", "file_path", "filePath", "path"];
const SUMMARY_LIMIT = 120;

/**
 * A bounded, sanitized first line of the one real argument that reads best as a path or command.
 * The whole argument set is never persisted; only this short presentation string is.
 */
export function summarizeArguments(args: ToolArguments | undefined): string | undefined {
  if (!args) return undefined;
  let value: unknown;
  for (const key of SUMMARY_KEYS) if (typeof args[key] === "string" && (args[key] as string).trim()) { value = args[key]; break; }
  if (typeof value !== "string") return undefined;
  // Commands containing credential-like options, assignments, or URLs are not cosmetic labels.
  if (value === args.command && /token|secret|passw(?:ord|d)|authorization|api.?key|bearer|:\/\/|(?:^|\s)[\w]+=|--(?:env|header|user|proxy-user|auth|login-options)|(?:^|\s)-[HpuU](?:\s|\S)/i.test(value)) return undefined;
  const line = value.split("\n")[0]!.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").replace(/\s+/g, " ").trim();
  if (!line) return undefined;
  return line.length > SUMMARY_LIMIT ? `${line.slice(0, SUMMARY_LIMIT - 1)}…` : line;
}

export function describeActivity(live?: LiveActivity): string {
  const running = live?.tools?.find(tool => tool.status === "running");
  if (running) return `Using ${running.name}`;
  const pending = live?.tools?.find(tool => tool.status === "pending");
  if (pending) return `Queued ${pending.name}`;
  if (live?.compactions?.some(task => task.blocking)) return "Compacting context";
  if (live?.generation?.retry) return "Waiting to retry model";
  if (live?.generation?.deferred) return "Waiting for provider";
  if (live?.generation?.message?.content?.length) return "Receiving model response";
  return "Waiting for model";
}

export function reconcileToolDiagnostics(
  log: { callId: string; status?: string; uncertain?: boolean; failed?: boolean }[],
  entries: readonly { kind: string; model?: readonly { role: string; toolCallId?: string; isError?: boolean }[]; data?: unknown }[],
): void {
  for (const entry of entries) {
    const diagnostics = entry.data && typeof entry.data === "object" && "diagnostics" in entry.data ? entry.data.diagnostics : undefined;
    if (entry.kind !== "pi.tool-result") continue;
    const message = entry.model?.find(message => message.role === "toolResult");
    const call = log.find(call => call.callId === message?.toolCallId);
    if (!call) continue;
    const has = (code: string) => Array.isArray(diagnostics) && diagnostics.some(diagnostic =>
      diagnostic && typeof diagnostic === "object" && diagnostic.code === code);
    call.status = has("aborted") ? "aborted" : "done";
    if (message?.isError) call.failed = true;
    if (has("interrupted")) call.uncertain = true;
  }
}

/**
 * A finished tool call is not necessarily a successful one. Uncertainty comes from Durable's own
 * interruption diagnostic, from a missing result entry (faulted or orphaned), or from cancellation,
 * never from inspecting arbitrary tool text.
 */
export function toolActivity(call: ToolSlot, args?: ToolArguments) {
  const codes = diagnosticCodes(call);
  const uncertain = codes.has("interrupted") || (call.status === "done" && call.entry === undefined);
  const summary = summarizeArguments(args);
  return {
    callId: call.callId, name: call.name,
    status: codes.has("aborted") ? "aborted" : call.status,
    ...(call.output ? { output: call.output.slice(-2000) } : {}),
    ...(summary ? { summary } : {}),
    ...(uncertain ? { uncertain: true } : {}),
    ...(call.diagnostics?.some((diagnostic) => diagnostic.severity === "error" && diagnostic.code !== "interrupted" && diagnostic.code !== "aborted") ? { failed: true } : {}),
  };
}
