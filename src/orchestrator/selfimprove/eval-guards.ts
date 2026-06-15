/**
 * PURE evaluator anti-degeneration guards.
 *
 * PURE — no clock (no Date.now()), no filesystem access, no network, no mutation of inputs.
 * All three exports return NEW objects (structuredClone / spread). Model on distill.ts.
 *
 * Guards are ALL off by default (Sprint 1 schema: SelfImproveSectionSchema flags default false).
 * Wiring in evaluator-agent.ts and pipeline.ts uses `config.selfImprove?.<flag>` so that an
 * absent selfImprove section (e.g. createDefaultConfig output) is falsy → existing path.
 */

import type { EvalResult, EvalDetail } from "../../contracts/eval-result.js";
import type { ContextHandoff } from "../context-handoff.js";

// ── Guard 1: Deterministic-first short-circuit ──────────────────────────────

/**
 * Returns true iff at least one programmatic result has passed===false AND
 * its evaluator type is in the requiredEvaluators set.
 *
 * NOTE: EvalResult carries `evaluator` (the strategy type name), NOT `required`.
 * The caller builds requiredEvaluators from config.evaluator.strategies
 * (filter s => s.required, map s => s.type).
 *
 * Pure: reads no clock, no fs, returns a boolean, mutates nothing.
 */
export function shouldShortCircuitJudge(
  programmaticResults: EvalResult[],
  requiredEvaluators: Set<string>,
): boolean {
  return programmaticResults.some(
    (result) => !result.passed && requiredEvaluators.has(result.evaluator),
  );
}

// ── Guard 2: Rubric isolation ───────────────────────────────────────────────

/**
 * Returns a deep-cloned handoff whose currentContract omits successCriteria
 * and evaluatorNotes (including each successCriteria[].verificationMethod),
 * while preserving title, description, definitionOfDone, generatorNotes, and nonGoals.
 *
 * The original handoff object is NEVER mutated (structuredClone + spread).
 *
 * The returned currentContract uses a single neutral placeholder criterion
 * so that downstream code that expects successCriteria to be non-empty
 * (SprintContractSchema.min(1)) does not throw if re-validated.
 * Note: the generator path only JSON.stringify's the handoff (serializeHandoff),
 * it does NOT re-parse through the schema, so this is belt-and-suspenders safe.
 */
export function redactRubric(handoff: ContextHandoff): ContextHandoff {
  if (!handoff.currentContract) {
    // No contract to redact — return the same reference (pure no-op).
    return handoff;
  }

  const {
    successCriteria: _successCriteria,
    evaluatorNotes: _evaluatorNotes,
    ...contractWithoutRubric
  } = handoff.currentContract;

  const redactedContract = {
    ...contractWithoutRubric,
    // Neutral placeholder criterion (keeps schema min(1) happy if re-validated).
    successCriteria: [
      {
        criterionId: "rubric-redacted",
        description:
          "Rubric redacted for generator isolation — see evaluator handoff for full criteria.",
        verificationMethod: "manual" as const,
        required: false,
      },
    ],
  };

  return {
    ...handoff,
    currentContract: redactedContract,
  };
}

// ── Guard 3: Cited-artifact enforcement ────────────────────────────────────

/**
 * Returns true when an EvalDetail with passed===false carries a citation that
 * proves the assertion is grounded in an observable artifact:
 *   - detail.file is a non-empty string, OR
 *   - detail.message contains a failing-test or command-output signal substring.
 *
 * Recognized signals (case-sensitive):
 *   '.test.'  — failing test file reference
 *   'FAIL '   — Jest/vitest FAIL line
 *   'npm run' — shell command invocation
 *   'tsc'     — TypeScript compiler output
 *   'exit code' — process exit code mention
 *   ':'        — path-like token (e.g. "src/foo.ts:42")
 */
function isCited(detail: EvalDetail): boolean {
  if (typeof detail.file === "string" && detail.file.length > 0) {
    return true;
  }
  const msg = detail.message;
  return (
    msg.includes(".test.") ||
    msg.includes("FAIL ") ||
    msg.includes("npm run") ||
    msg.includes("tsc") ||
    msg.includes("exit code") ||
    msg.includes(":")
  );
}

/**
 * Returns a NEW EvalResult in which every detail with passed===false that has
 * no citation is rewritten to passed:true, severity:'info', and a note is
 * appended to its message.
 *
 * Cited FAIL details (detail.file non-empty OR message contains a command/test
 * signal) are passed through unchanged.
 *
 * result.passed is recomputed from the returned details.
 *
 * Pure: no clock, no fs, input is NOT mutated.
 */
export function enforceCitedArtifacts(result: EvalResult): EvalResult {
  const newDetails: EvalDetail[] = result.details.map((detail) => {
    if (!detail.passed && !isCited(detail)) {
      return {
        ...detail,
        passed: true,
        severity: "info" as const,
        message: detail.message + " [downgraded: no cited artifact]",
      };
    }
    return detail;
  });

  const newPassed = newDetails.every((d) => d.passed);

  return {
    ...result,
    details: newDetails,
    passed: newPassed,
  };
}
