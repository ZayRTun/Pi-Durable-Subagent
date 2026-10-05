import { Markdown, MouseRegion, Container, parseColor, sliceByColumn, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { getMarkdownTheme, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Run } from "./runtime.ts";
import { AGENT_COLORS } from "./agents.ts";
import { formatCost } from "./cost.ts";
import { groupFacts, groupHeading, type DelegationEntry, type DelegationMode, type DelegationPresentation } from "./presentation.ts";

export function clean(text: string) {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
export function preview(text: string, limit = 140) {
  const line = clean(text).replace(/\s+/g, " ").trim();
  const characters = Array.from(line);
  return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}…` : line;
}

/**
 * Clip a line to visible columns without inserting a bare `\x1b[0m`. The native `truncateToWidth`
 * appends a reset before its ellipsis, which clears the tool-result background the enclosing Box
 * applied to the whole line, leaving a terminal-default patch at the truncation marker. Slicing
 * preserves the active styling so the ellipsis keeps the row's background.
 */
export function clipAnsi(text: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  const ellipsisWidth = visibleWidth(ellipsis);
  if (ellipsisWidth >= width) return sliceByColumn(ellipsis, 0, width, true);
  return sliceByColumn(text, 0, width - ellipsisWidth, true) + ellipsis;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const STATUS_ICON: Record<string, string> = { succeeded: "✓", failed: "✗", aborted: "■", interrupted: "◌" };
const STATUS_LABEL: Record<string, string> = { running: "Running", succeeded: "Done", failed: "Failed", aborted: "Cancelled", interrupted: "Interrupted" };

/** Shared per-tool-row renderer state. `state` is the native ToolRenderContext.state bag. */
export interface RendererState {
  /** Independent per-child expansion overrides keyed by stable run ID. */
  childExpanded?: Record<string, boolean>;
  lastGlobalExpanded?: boolean;
  lastGroup?: { presentation?: DelegationPresentation; runs: Run[] };
  markdown?: Record<string, { text: string; theme: Theme; component: Markdown }>;
}

export interface ViewOptions {
  /** The run is executing now, so animate its icon and elapsed time. */
  active?: boolean;
  state?: RendererState;
  /** Native per-row invalidate, used by child MouseRegion handlers. */
  invalidate?: () => void;
  /** Deterministic clock for tests. */
  now?: number;
}

function stateToken(status: string): ThemeColor {
  return status === "succeeded" ? "success" : status === "failed" ? "error" : status === "running" ? "accent" : "warning";
}

function agentName(name: string, color: string | undefined, theme: Theme): string {
  const resolved = color ? AGENT_COLORS[color] ?? (/^#[0-9a-f]{6}$/i.test(color) ? color : undefined) : undefined;
  return resolved ? theme.style(name, { fg: parseColor(resolved), bold: true }) : theme.fg("accent", theme.bold(name));
}

function formatElapsed(ms: number): string {
  const seconds = Math.round(Math.max(0, ms) / 100) / 10;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${(seconds - minutes * 60).toFixed(1)}s`;
}

function usageTokens(usage: Run["usage"]): string | undefined {
  const total = usage?.totalTokens ?? 0;
  if (!total) return undefined;
  return total >= 1000 ? `${(total / 1000).toFixed(1)}k tokens` : `${total} tokens`;
}

/** Metrics drop tokens first and the tool count second, keeping model, cost, and elapsed if they fit. */
function metricsText(run: Run, width: number, elapsedMs: number): string {
  const model = `${clean(run.model.modelId)} · ${run.thinking ?? "off"}`;
  const tools = run.toolCount !== undefined ? `${run.toolCount} tool use${run.toolCount === 1 ? "" : "s"}` : undefined;
  const tokens = usageTokens(run.usage);
  const costValue = run.usage?.cost.total ?? 0;
  const cost = costValue > 0 ? formatCost(costValue) : undefined;
  const elapsed = formatElapsed(elapsedMs);
  let list = [model, ...(tools ? [tools] : []), ...(tokens ? [tokens] : []), ...(cost ? [cost] : []), elapsed];
  if (visibleWidth(list.join(" · ")) > width && tokens) list = list.filter((part) => part !== tokens);
  if (visibleWidth(list.join(" · ")) > width && tools) list = list.filter((part) => part !== tools);
  if (visibleWidth(list.join(" · ")) > width && list[0] === model) {
    const rest = list.slice(1);
    const budget = width - visibleWidth(` · ${rest.join(" · ")}`);
    const thinking = ` · ${run.thinking ?? "off"}`;
    list = budget > visibleWidth(thinking) + 2
      ? [clipAnsi(clean(run.model.modelId), budget - visibleWidth(thinking)) + thinking, ...rest]
      : rest;
  }
  while (list.length && visibleWidth(list.join(" · ")) > width) list.shift();
  return list.join(" · ");
}

function entryState(entry: DelegationEntry, run: Run | undefined, active: boolean, now: number): { icon: string; label: string; token: ThemeColor } {
  if (entry.phase !== "run" || !run) {
    return entry.phase === "not-run" ? { icon: "○", label: "Not run", token: "dim" } : { icon: "○", label: "Pending", token: "dim" };
  }
  if (run.status === "running") return { icon: active ? SPINNER[Math.floor(now / 120) % SPINNER.length] : "⠹", label: "Running", token: "accent" };
  return { icon: STATUS_ICON[run.status] ?? "○", label: STATUS_LABEL[run.status] ?? run.status, token: stateToken(run.status) };
}

/** Only uncertainty and explicit interruption recovery add a warning; a missing tool list is not one. */
function warnings(run: Run | undefined): string[] {
  if (!run) return [];
  const list: string[] = [];
  if (run.status === "interrupted") list.push("Stopped before completion. Review in /subagents before resuming.");
  if (run.activityLog?.some((call) => call.uncertain)) list.push("A tool's outcome is unknown. Check its result before retrying.");
  return list;
}

function activityReading(call: NonNullable<Run["activityLog"]>[number]): string {
  const icon = call.uncertain ? "⚠" : call.status === "aborted" ? "■" : call.failed ? "✗" : "✓";
  return `${icon} ${call.name}${call.summary ? ` · ${call.summary}` : ""}`;
}

/** Wrap plain text to the content column so paragraph continuations and bullet text stay aligned. */
function contentWrapped(text: string, prefix: string, width: number, theme: Theme, token: ThemeColor = "toolOutput"): string[] {
  const contentWidth = Math.max(1, width - visibleWidth(prefix));
  return wrapTextWithAnsi(clean(text), contentWidth).map((line) => prefix + theme.fg(token, line));
}

const OUTPUT_LIMIT = 50000;

interface EntryInput {
  entry: DelegationEntry;
  run?: Run;
  last: boolean;
  grouped: boolean;
}

interface EntryOpts {
  active: boolean;
  now: number;
  expanded: boolean;
  elapsedMs: number;
  state?: RendererState;
}

function expandedLines(input: EntryInput, width: number, theme: Theme, contentPrefix: string, blank: string, opts: EntryOpts): string[] {
  const run = input.run;
  if (!run) return [];
  const out: string[] = [blank, contentPrefix + theme.fg("dim", "Task"), blank, ...contentWrapped(input.entry.requestedTask, contentPrefix, width, theme)];
  if (run.status === "running") {
    const current = run.activityLog?.find((call) => call.status === "running");
    out.push(blank, contentPrefix + theme.fg("dim", "Current tool"), blank);
    out.push(contentPrefix + clipAnsi(current ? `${current.name}${current.summary ? ` · ${current.summary}` : ""}` : clean(run.activity || "Waiting for model"), Math.max(0, width - visibleWidth(contentPrefix))));
    // Finished calls only, newest first, and never the call that is still running.
    const recent = (run.activityLog ?? []).filter((call) => call.status !== "running" && call.status !== "pending").slice(-3).reverse();
    if (recent.length) {
      out.push(blank, contentPrefix + theme.fg("dim", "Recent activity"), blank);
      for (const call of recent) out.push(contentPrefix + clipAnsi(activityReading(call), Math.max(0, width - visibleWidth(contentPrefix))));
    }
    return out;
  }
  if (run.status === "interrupted" && !run.output) return out;
  const body = run.status === "succeeded" ? run.output ?? "" : [run.error, run.output ? `Partial answer:\n${run.output}` : ""].filter(Boolean).join("\n\n");
  if (!body) return out;
  out.push(blank, contentPrefix + theme.fg("dim", "Response"), blank);
  if (run.status === "succeeded") {
    const contentWidth = Math.max(1, width - visibleWidth(contentPrefix));
    const text = clean(body).slice(0, OUTPUT_LIMIT);
    const cached = opts.state?.markdown?.[run.id];
    const markdown = cached?.text === text && cached.theme === theme
      ? cached.component : new Markdown(text, 0, 0, getMarkdownTheme());
    if (opts.state && markdown !== cached?.component) {
      (opts.state.markdown ??= {})[run.id] = { text, theme, component: markdown };
    }
    for (const line of markdown.render(contentWidth)) out.push(contentPrefix + line);
    if (body.length > OUTPUT_LIMIT) out.push(contentPrefix + theme.fg("dim", "Display truncated; use /subagents for the full result."));
  } else {
    out.push(...contentWrapped(body, contentPrefix, width, theme));
  }
  return out;
}

function buildEntryLines(input: EntryInput, width: number, theme: Theme, opts: EntryOpts): string[] {
  const { entry, run, last, grouped } = input;
  const title = grouped ? theme.style(last ? " └ " : " ├ ", { fg: parseColor("#ffffff") }) : " ";
  const metricPrefix = theme.style(grouped ? (last ? "      ⎿ " : " │    ⎿ ") : "    ⎿ ", { fg: parseColor("#ffffff") });
  const contentPrefix = grouped && !last ? theme.style(" │      ", { fg: parseColor("#ffffff") }) : grouped ? "        " : "    ";
  const blank = grouped && !last ? theme.style(" │", { fg: parseColor("#ffffff") }) : "";
  const state = entryState(entry, run, opts.active, opts.now);
  const name = run ? agentName(run.agent.name, run.agent.color, theme) : agentName(entry.agent, entry.color, theme);
  const head = `${title}${theme.fg(state.token, state.icon)} `;
  const available = width - visibleWidth(head) - visibleWidth(name) - 3;
  const task = clipAnsi(preview(entry.requestedTask, 50), Math.max(1, available));
  const lines: string[] = [available > 1 ? `${head}${name} (${theme.fg("muted", task)})` : `${head}${name}`];
  const label = theme.fg(state.token, state.label);
  if (!run || entry.phase !== "run") {
    lines.push(`${metricPrefix}${label}`);
  } else {
    const available2 = width - visibleWidth(metricPrefix) - visibleWidth(state.label) - 3;
    const body = available2 > 3 ? metricsText(run, available2, opts.elapsedMs) : "";
    lines.push(body ? `${metricPrefix}${label}${theme.fg("dim", ` (${body})`)}` : `${metricPrefix}${label}`);
  }
  for (const warning of warnings(run)) lines.push(...contentWrapped(`⚠ ${warning}`, contentPrefix, width, theme, "warning"));
  if (opts.expanded) lines.push(...expandedLines(input, width, theme, contentPrefix, blank, opts));
  return lines;
}

/** A component built from a width-aware line builder; every emitted line is clipped to the width. */
class Fitted implements Component {
  private readonly build: (width: number) => string[];
  constructor(build: (width: number) => string[]) { this.build = build; }
  invalidate() {}
  render(width: number): string[] {
    return this.build(width).map((line) => clipAnsi(line, width));
  }
}

/** The 2-line base plus expansion for one run with no group header. */
export function renderRun(run: Run, expanded: boolean, theme: Theme, options: ViewOptions = {}): Component {
  const input: EntryInput = { entry: { runId: run.id, agent: run.agent.name, requestedTask: run.task, phase: "run" }, run, last: true, grouped: false };
  const active = options.active === true && run.status === "running";
  const startAt = run.updatedAt || options.now || Date.now();
  return new Fitted((width) => {
    const now = options.now ?? Date.now();
    const elapsedMs = (run.elapsedMs ?? 0) + (active ? Math.max(0, now - startAt) : 0);
    return buildEntryLines(input, width, theme, { active, now, expanded, elapsedMs, state: options.state });
  });
}

/** The group heading plus one tree entry per requested step, in requested order. */
export function renderGroup(presentation: DelegationPresentation | undefined, runs: Run[], expanded: boolean, theme: Theme, options: ViewOptions = {}): Component {
  const state = options.state ?? {};
  // A global expansion change resets per-child overrides so the row defaults coherently again.
  if (state.lastGlobalExpanded !== expanded) {
    state.lastGlobalExpanded = expanded;
    state.childExpanded = {};
  }
  const entries: DelegationEntry[] = presentation?.entries?.length
    ? presentation.entries
    : runs.map((run) => ({ runId: run.id, agent: run.agent.name, requestedTask: run.task, phase: "run" as const }));
  const mode: DelegationMode = presentation?.mode ?? "ordered";
  const runById = new Map(runs.map((run) => [run.id, run]));
  const startAt = options.now ?? Date.now();
  const container = new Container();
  container.addChild(new Fitted((width) => wrapTextWithAnsi(clean(groupHeading(mode, groupFacts(entries, runs))), Math.max(1, width - 1)).map((line) => " " + line)));
  entries.forEach((entry, index) => {
    const run = runById.get(entry.runId);
    const last = index === entries.length - 1;
    const input: EntryInput = { entry, ...(run ? { run } : {}), last, grouped: true };
    const build = (width: number) => {
      const now = options.now ?? Date.now();
      const effective = state.childExpanded?.[entry.runId] ?? expanded;
      const active = options.active === true && run?.status === "running";
      const elapsedMs = (run?.elapsedMs ?? 0) + (active ? Math.max(0, now - (run?.updatedAt || startAt)) : 0);
      const lines = buildEntryLines(input, Math.max(0, width - 1), theme, { active, now, expanded: effective, elapsedMs, state });
      if (!last) lines.push(theme.style(" │", { fg: parseColor("#ffffff") }));
      return lines.map((line) => " " + line);
    };
    const component = new Fitted(build);
    if (!options.invalidate) {
      container.addChild(component);
      return;
    }
    const invalidate = options.invalidate;
    container.addChild(new MouseRegion(component, (event) => {
      if (event.type !== "click" || event.button !== "left") return undefined;
      if (event.y > 1) return { handled: true };
      const current = state.childExpanded?.[entry.runId] ?? expanded;
      state.childExpanded = { ...(state.childExpanded ?? {}), [entry.runId]: !current };
      invalidate();
      return { handled: true };
    }));
  });
  return container;
}

/** A plain fallback for a result whose details are not Durable's structured shape. */
export function renderGenericResult(text: string, expanded = false): Component {
  return new Fitted(() => {
    const lines = text.length ? text.split("\n") : [];
    if (expanded || lines.length <= 5) return lines;
    return [...lines.slice(0, 5), `(${lines.length - 5} more lines, Ctrl+O to expand)`];
  });
}
