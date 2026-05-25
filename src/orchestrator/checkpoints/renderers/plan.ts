/**
 * Renderer for `plan-spec` artifacts.
 *
 * Extracts: title, ambiguity score, features count, sprints count (inline only),
 * assumptions list, out-of-scope list. Caps output at 300 lines.
 *
 * Pure function — no I/O. Receives the parsed PlanSpec object directly.
 *
 * Sprint 11 — colocated in renderers/ per mechanisms/ precedent.
 */

import { applyLineCap } from "./_util.js";

interface PlanSpecLike {
  type?: string;
  specId?: string;
  title?: string;
  status?: string;
  ambiguityScore?: number;
  features?: unknown[];
  sprints?: unknown[];
  assumptions?: string[];
  outOfScope?: string[];
}

/**
 * Render a `plan-spec` artifact as markdown.
 */
export function renderPlanSpec(artifact: unknown): string {
  const spec = (artifact ?? {}) as PlanSpecLike;

  const lines: string[] = [
    `## Plan: ${spec.title ?? "(untitled)"}`,
    ``,
    `- **Spec ID:** \`${spec.specId ?? "unknown"}\``,
    `- **Status:** ${spec.status ?? "unknown"}`,
    `- **Ambiguity:** ${spec.ambiguityScore ?? "n/a"}/10`,
    `- **Features:** ${spec.features?.length ?? 0}`,
    `- **Sprints (inline):** ${spec.sprints?.length ?? 0}`,
    ``,
    `### Assumptions (${spec.assumptions?.length ?? 0})`,
    ...(spec.assumptions ?? []).map((a) => `- ${a}`),
    ``,
    `### Out of scope (${spec.outOfScope?.length ?? 0})`,
    ...(spec.outOfScope ?? []).map((o) => `- ${o}`),
  ];

  return applyLineCap(lines.join("\n"), 300);
}
