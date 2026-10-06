import type { Conversation } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

// Native resolution avoids Pi's Jiti root compat alias rewriting public subpath imports.
let estimator: Promise<typeof import("@earendil-works/pi-ai/utils/estimate")> | undefined;
function contextEstimator() {
  return estimator ??= import(import.meta.resolve("@earendil-works/pi-ai/utils/estimate"));
}

export interface ContextHealth {
  estimatedTokens: number | null;
  modelCapacity: number | null;
  basis: "committed-context-estimate" | "unknown";
  limitation: string;
  warningThreshold: number;
  freshThreshold: number;
  warning: boolean | null;
  recommendFresh: boolean | null;
  requiresReuseDecision: boolean;
  compaction: "none" | "applied" | "running" | "unknown";
}

export async function inspectContext(root: Conversation | undefined, capacity: number | undefined): Promise<ContextHealth> {
  const modelCapacity = capacity && Number.isFinite(capacity) && capacity > 0 ? capacity : null;
  let estimatedTokens: number | null = null;
  let measurementError = "";
  let compaction: ContextHealth["compaction"] = "unknown";
  if (root) {
    try {
      const view = await root.context(BACKGROUND_CONTEXT);
      const state = await root.viewState(BACKGROUND_CONTEXT);
      const live = state.value.docs["pi.live"] as { compactions?: unknown[] } | undefined;
      compaction = live?.compactions?.length ? "running" : view.head?.kind === "pi.compaction" ? "applied" : "none";
      const { estimateContextTokens } = await contextEstimator();
      const estimate = estimateContextTokens(view.messages);
      if (Number.isFinite(estimate.tokens) && estimate.tokens >= 0) estimatedTokens = estimate.tokens;
    } catch (error) {
      measurementError = ` Estimation unavailable: ${(error as Error).message}`;
    }
  }
  const warningThreshold = Math.min(120000, modelCapacity === null ? 120000 : modelCapacity * .8);
  const freshThreshold = Math.min(150000, modelCapacity === null ? 150000 : modelCapacity * .95);
  const warning = estimatedTokens === null ? null : estimatedTokens >= warningThreshold;
  return {
    estimatedTokens, modelCapacity,
    basis: estimatedTokens === null ? "unknown" : "committed-context-estimate",
    limitation: "Approximate committed model context; excludes live partial output and next-request transformations. Compaction does not guarantee restored reasoning quality." + measurementError,
    warningThreshold, freshThreshold, warning,
    recommendFresh: estimatedTokens === null ? null : estimatedTokens >= freshThreshold,
    requiresReuseDecision: warning === true, compaction,
  };
}

/** Shared validation for retained-conversation follow-ups. Unknown estimates remain visible. */
export function validateReuseDecision(health: ContextHealth, reuse?: boolean): void {
  if (health.requiresReuseDecision && reuse !== true) throw new Error("Context warning: inspect context health and explicitly choose reuse:true, or start a fresh conversation.");
}

export function formatContextHealth(health: ContextHealth): string {
  return `Context: ${health.estimatedTokens === null ? "unknown" : `~${health.estimatedTokens} tokens`} / ${health.modelCapacity ?? "unknown"} capacity · compaction ${health.compaction}${health.recommendFresh ? " · fresh conversation recommended" : health.warning ? " · context warning; explicit reuse decision required" : ""}\n${health.limitation}`;
}
