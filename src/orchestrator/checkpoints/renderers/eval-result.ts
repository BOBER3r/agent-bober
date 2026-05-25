/**
 * Renderer for `eval-result` artifacts.
 *
 * Shows: overallResult, score (passed/failed/total), failing criteria,
 * strategy results (exit codes only — no full stdout). Caps output at 300 lines.
 *
 * Pure function — no I/O. Receives the parsed eval result object directly.
 *
 * Sprint 11 — colocated in renderers/ per mechanisms/ precedent.
 */

import { applyLineCap } from "./_util.js";

interface StrategyResult {
  strategy: string;
  result: string;
  required?: boolean;
  output?: string;
}

interface CriterionResultLike {
  criterionId?: string;
  result?: string;
  feedback?: string;
  evidence?: string;
}

interface ScoreLike {
  criteriaPassed?: number;
  criteriaFailed?: number;
  criteriaTotal?: number;
}

interface EvalResultLike {
  type?: string;
  overallResult?: string;
  passed?: boolean;
  score?: ScoreLike;
  strategyResults?: StrategyResult[];
  criteriaResults?: CriterionResultLike[];
  summary?: string;
}

/**
 * Render an `eval-result` artifact as markdown.
 */
export function renderEvalResult(artifact: unknown): string {
  const e = (artifact ?? {}) as EvalResultLike;

  // Handle both `overallResult` and `passed` boolean shapes
  const overall = e.overallResult ?? (e.passed === true ? "pass" : e.passed === false ? "fail" : "unknown");
  const score = e.score;
  const failing = (e.criteriaResults ?? []).filter(
    (c) => c.result !== "pass" && c.result !== undefined,
  );

  const lines: string[] = [
    `## Eval Result: **${overall.toUpperCase()}**`,
    ``,
    `- **Score:** ${score?.criteriaPassed ?? 0}/${score?.criteriaTotal ?? 0} (${score?.criteriaFailed ?? 0} failed)`,
    ``,
  ];

  // Strategy results — exit codes only (no full stdout)
  if (e.strategyResults && e.strategyResults.length > 0) {
    lines.push(`### Strategies`);
    for (const s of e.strategyResults) {
      const req = s.required === true ? " (required)" : "";
      lines.push(`- \`${s.strategy}\`${req}: **${s.result}**`);
    }
    lines.push(``);
  }

  // Failing criteria
  lines.push(`### Failing criteria (${failing.length})`);
  if (failing.length === 0) {
    lines.push(`_All criteria passed._`);
  } else {
    for (const c of failing) {
      const feedback = c.feedback ?? c.evidence ?? "(no feedback)";
      lines.push(`- **${c.criterionId ?? "?"}**: ${feedback}`);
    }
  }

  if (e.summary) {
    lines.push(``);
    lines.push(`### Summary`);
    lines.push(e.summary);
  }

  return applyLineCap(lines.join("\n"), 300);
}
