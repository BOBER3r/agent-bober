/**
 * Per-artifact-type renderer registry.
 *
 * Renderers are pure functions: (artifact) => markdown string.
 * Mechanisms (cli/disk/pr) call render(artifact) to get a human-readable
 * summary instead of stringifying the full artifact.
 *
 * Sprint 11 — replaces inline renderArtifact (cli), summarizeArtifact (disk),
 * renderCheckpointComment (pr) bodies. Colocated in renderers/ per mechanisms/
 * precedent established in Sprints 7-10.
 */

import { renderResearch } from "./research.js";
import { renderPlanSpec } from "./plan.js";
import { renderSprintContract } from "./sprint-contract.js";
import { renderCuratorBriefing } from "./curator-briefing.js";
import { renderGeneratorDiff } from "./generator-diff.js";
import { renderEvalResult } from "./eval-result.js";
import { renderCodeReview } from "./code-review.js";
import { renderSprintSummary } from "./sprint-summary.js";
import { renderPipelineSummary } from "./pipeline-summary.js";

/**
 * Canonical artifact type strings.
 * CLI/disk/PR mechanisms MUST pass artifact.type matching one of these.
 * Unknown types fall back to a generic JSON text dump with a stderr warning (s11-c2).
 */
export type ArtifactType =
  | "research"
  | "plan-spec"
  | "sprint-contract"
  | "curator-briefing"
  | "generator-diff"
  | "eval-result"
  | "code-review"
  | "sprint-summary"
  | "pipeline-summary";

/** A renderer function: artifact in, markdown string out. Pure, synchronous. */
export type Renderer = (artifact: unknown) => string;

/** Module-level dispatch table — populated from the 9 canonical renderer modules. */
const renderers = new Map<string, Renderer>([
  ["research", renderResearch],
  ["plan-spec", renderPlanSpec],
  ["sprint-contract", renderSprintContract],
  ["curator-briefing", renderCuratorBriefing],
  ["generator-diff", renderGeneratorDiff],
  ["eval-result", renderEvalResult],
  ["code-review", renderCodeReview],
  ["sprint-summary", renderSprintSummary],
  ["pipeline-summary", renderPipelineSummary],
]);

/**
 * Register a renderer for a given artifact type.
 * Allows test fixtures or future sprints to extend the registry.
 */
export function registerRenderer(type: string, renderer: Renderer): void {
  renderers.set(type, renderer);
}

/**
 * Get the renderer for a given artifact type.
 * Returns undefined if the type is not registered.
 */
export function getRenderer(type: string): Renderer | undefined {
  return renderers.get(type);
}

/**
 * Dispatch to the correct renderer by artifact.type.
 * Unknown types fall through to a generic JSON text dump + stderr warning (s11-c2).
 */
export function render(artifact: unknown): string {
  const a = artifact as { type?: unknown } | null | undefined;
  const type =
    a && typeof a === "object" && typeof a["type"] === "string" ? a["type"] : null;

  if (type !== null && renderers.has(type)) {
    return renderers.get(type)!(artifact);
  }

  process.stderr.write(
    `warn: renderer registry has no entry for artifact.type=${JSON.stringify(type)}; falling back to generic JSON dump.\n`,
  );
  return renderGeneric(artifact);
}

/**
 * Generic fallback renderer — single source of truth for unknown-type rendering.
 *
 * Only picks safe metadata fields (type, path, summary, lines) — never stringifies
 * the entire artifact. Large fields (content, fullContent, text, data) are dropped
 * to preserve the 100ms perf budget (per disk.ts: large artifact safety test).
 */
export function renderGeneric(artifact: unknown): string {
  const a = artifact as Record<string, unknown> | null | undefined;
  if (!a || typeof a !== "object") {
    return `\`\`\`\n${String(artifact)}\n\`\`\``;
  }

  // Safe metadata fields to surface
  const safe: Record<string, unknown> = {};
  const SAFE_FIELDS = ["type", "path", "summary", "lines", "status", "id", "contractId", "specId", "title", "feature"];
  for (const key of SAFE_FIELDS) {
    if (key in a && (typeof a[key] === "string" || typeof a[key] === "number" || typeof a[key] === "boolean")) {
      safe[key] = a[key];
    }
  }

  const json = JSON.stringify(safe, null, 2);
  return ["```json", json, "```"].join("\n");
}
