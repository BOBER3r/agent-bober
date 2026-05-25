/**
 * Renderer for `sprint-contract` artifacts.
 *
 * Extracts: contractId, feature/title, expectedChanges paths, successCriteria
 * count + first 5, and dependsOn. Caps output at 200 lines.
 *
 * Pure function — no I/O. Receives the parsed SprintContract object directly.
 *
 * Sprint 11 — colocated in renderers/ per mechanisms/ precedent.
 */

import { applyLineCap } from "./_util.js";

interface ExpectedChange {
  path?: string;
  action?: string;
  description?: string;
}

interface SuccessCriterionLike {
  criterionId?: string;
  id?: string;
  description?: string;
}

interface SprintContractLike {
  type?: string;
  contractId?: string;
  feature?: string;
  title?: string;
  expectedChanges?: ExpectedChange[];
  successCriteria?: SuccessCriterionLike[];
  dependsOn?: string[];
}

/**
 * Render a `sprint-contract` artifact as markdown.
 */
export function renderSprintContract(artifact: unknown): string {
  const c = (artifact ?? {}) as SprintContractLike;
  const sc = c.successCriteria ?? [];
  const ec = c.expectedChanges ?? [];

  const lines: string[] = [
    `## Sprint Contract: \`${c.contractId ?? "unknown"}\``,
    ``,
    `**Feature:** ${c.feature ?? c.title ?? "(untitled)"}`,
    ``,
    `### Expected changes (${ec.length})`,
    ...ec.map((e) => `- \`${e.path ?? "?"}\` (${e.action ?? "?"})`),
    ``,
    `### Success criteria (${sc.length}, first 5 shown)`,
    ...sc.slice(0, 5).map(
      (s) => `- **${s.criterionId ?? s.id ?? "?"}**: ${s.description ?? ""}`,
    ),
    ``,
    `### Depends on`,
    ...(c.dependsOn ?? []).map((d) => `- \`${d}\``),
  ];

  return applyLineCap(lines.join("\n"), 200);
}
