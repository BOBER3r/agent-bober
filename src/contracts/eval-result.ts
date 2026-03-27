import { z } from "zod";

// ── Enums ───────────────────────────────────────────────────────────

export const SeveritySchema = z.enum(["error", "warning", "info"]);
export type Severity = z.infer<typeof SeveritySchema>;

// ── Eval Detail ─────────────────────────────────────────────────────

export const EvalDetailSchema = z.object({
  criterion: z.string().min(1),
  passed: z.boolean(),
  message: z.string(),
  file: z.string().optional(),
  line: z.number().int().optional(),
  severity: SeveritySchema,
});
export type EvalDetail = z.infer<typeof EvalDetailSchema>;

// ── Structured feedback types (for enriched results) ────────────────

export const CriterionResultSchema = z.object({
  criterionId: z.string(),
  description: z.string(),
  required: z.boolean(),
  result: z.enum(["pass", "fail", "skipped"]),
  evidence: z.string().optional(),
  feedback: z.string().optional(),
});
export type CriterionResult = z.infer<typeof CriterionResultSchema>;

export const RegressionSchema = z.object({
  description: z.string(),
  evidence: z.string(),
  severity: z.enum(["critical", "major", "minor"]),
});
export type Regression = z.infer<typeof RegressionSchema>;

export const GeneratorFeedbackItemSchema = z.object({
  priority: z.enum(["critical", "high", "medium", "low"]),
  category: z.enum([
    "bug",
    "missing-feature",
    "regression",
    "quality",
    "performance",
  ]),
  file: z.string().optional(),
  line: z.number().optional(),
  description: z.string(),
  expected: z.string().optional(),
  reproduction: z.string().optional(),
});
export type GeneratorFeedbackItem = z.infer<
  typeof GeneratorFeedbackItemSchema
>;

// ── Eval Result ─────────────────────────────────────────────────────

export const EvalResultSchema = z.object({
  evaluator: z.string().min(1),
  passed: z.boolean(),
  score: z.number().min(0).max(100).optional(),
  details: z.array(EvalDetailSchema),
  summary: z.string(),
  feedback: z.string(),
  timestamp: z.string().datetime(),
  // Enriched fields (optional, populated by agent evaluator)
  iteration: z.number().int().min(1).optional(),
  contractId: z.string().optional(),
  criteriaResults: z.array(CriterionResultSchema).optional(),
  regressions: z.array(RegressionSchema).optional(),
  designScore: z.number().min(0).max(100).optional(),
  generatorFeedback: z.array(GeneratorFeedbackItemSchema).optional(),
});
export type EvalResult = z.infer<typeof EvalResultSchema>;

// ── Sprint Evaluation ───────────────────────────────────────────────

export const SprintEvaluationSchema = z.object({
  sprintId: z.string().min(1),
  round: z.number().int().min(1),
  results: z.array(EvalResultSchema),
  overallPassed: z.boolean(),
  aggregateFeedback: z.string(),
});
export type SprintEvaluation = z.infer<typeof SprintEvaluationSchema>;

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Aggregate multiple eval results into a sprint evaluation.
 */
export function aggregateResults(
  sprintId: string,
  round: number,
  results: EvalResult[],
): SprintEvaluation {
  const overallPassed = results.every((r) => r.passed);

  const feedbackParts: string[] = [];

  for (const result of results) {
    if (!result.passed) {
      feedbackParts.push(`[${result.evaluator}] FAILED: ${result.feedback}`);
    } else {
      feedbackParts.push(`[${result.evaluator}] PASSED: ${result.summary}`);
    }
  }

  const aggregateFeedback = feedbackParts.join("\n");

  return {
    sprintId,
    round,
    results,
    overallPassed,
    aggregateFeedback,
  };
}

/**
 * Format a sprint evaluation into a human-readable feedback string.
 */
export function formatFeedback(evaluation: SprintEvaluation): string {
  const lines: string[] = [];
  const statusLabel = evaluation.overallPassed ? "PASS" : "FAIL";

  lines.push(
    `Sprint ${evaluation.sprintId} - Round ${evaluation.round}: ${statusLabel}`,
  );
  lines.push("=".repeat(60));

  for (const result of evaluation.results) {
    const resultStatus = result.passed ? "PASS" : "FAIL";
    lines.push(
      `\n[${resultStatus}] ${result.evaluator}${result.score !== undefined ? ` (score: ${result.score}/100)` : ""}`,
    );
    lines.push(`  Summary: ${result.summary}`);

    const failures = result.details.filter((d) => !d.passed);
    if (failures.length > 0) {
      lines.push(`  Issues (${failures.length}):`);
      for (const detail of failures) {
        const location =
          detail.file
            ? ` at ${detail.file}${detail.line !== undefined ? `:${detail.line}` : ""}`
            : "";
        lines.push(
          `    - [${detail.severity.toUpperCase()}] ${detail.message}${location}`,
        );
      }
    }

    if (!result.passed && result.feedback) {
      lines.push(`  Feedback: ${result.feedback}`);
    }
  }

  lines.push("\n" + "=".repeat(60));
  lines.push(
    evaluation.overallPassed
      ? "All evaluators passed. Sprint complete."
      : "Some evaluators failed. Rework needed.",
  );

  return lines.join("\n");
}
