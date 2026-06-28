/**
 * Judge panel loop for medical recommendation candidates.
 *
 * PURE orchestration over injected fns — NO fs / NO network / NO real provider / NO FactStore.
 *
 * Regenerate-on-reject loop structure adapted from runCritiqueLoop (src/fleet/critic-deep.ts:211-278),
 * with the accept-best / fail-open tail REPLACED by fail-closed (mirror grounding-critic.ts:203-206).
 *
 * FAIL-CLOSED INVERSION: see getLensVerdict (lenses.ts) and the constant comment below.
 * Red-flag guard fires FIRST — generateCandidate is NEVER called when the guard short-circuits.
 */
import type { GuardrailContext, GuardrailSet } from "../types.js";
import type { LLMClient } from "../../providers/types.js";
import {
  MEDICAL_PANEL_MAX_ROUNDS,
  type LensClients,
  type LensName,
  type LensSpec,
  type LensVerdict,
  type PanelDecision,
  type PanelOutcome,
} from "./types.js";
import {
  getLensVerdict,
  buildEvidenceGraderSystemPrompt,
  buildContraindicationCheckerSystemPrompt,
  buildConservativeCliniciansSystemPrompt,
  buildOptimizationLensSystemPrompt,
} from "./lenses.js";

// ── reconcilePanel ────────────────────────────────────────────────────

/**
 * Reconciles four lens verdicts into a panel decision.
 *
 * CRITICAL ORDERING:
 * 1. Veto check FIRST — any veto:true from contraindication-checker forces accepted:false
 *    with reason:'contraindication-veto' REGARDLESS of the approve count. A veto can NEVER
 *    be overridden by a vote majority under any code path (NonGoal #4).
 * 2. Strict majority — approveCount > rejectCount. A tie (2 approve / 2 reject) resolves
 *    to accepted:false (fail-closed per lens-panel.md:80-84).
 */
export function reconcilePanel(verdicts: Record<LensName, LensVerdict>): PanelDecision {
  // Step 1: absolute contraindication veto (checked BEFORE the vote count)
  if (verdicts["contraindication-checker"].veto === true) {
    return { accepted: false, reason: "contraindication-veto" };
  }

  // Step 2: strict majority (fail-closed on tie)
  const all = Object.values(verdicts);
  const approveCount = all.filter((v) => v.verdict === "approve").length;
  const rejectCount = all.filter((v) => v.verdict === "reject").length;

  if (approveCount > rejectCount) {
    return { accepted: true };
  }

  return { accepted: false, reason: "no-consensus" };
}

// ── Internal: run one lens with throw-catching ────────────────────────

async function runLens(
  spec: LensSpec,
  systemPrompt: string,
  userContent: string,
): Promise<LensVerdict> {
  const llm: LLMClient = spec.client;
  return getLensVerdict({ llm, model: spec.model, systemPrompt, userContent });
}

// ── runJudgeLoop ──────────────────────────────────────────────────────

/**
 * Runs the full multi-lens judge loop for a medical recommendation candidate.
 *
 * Execution order:
 *  (1) Red-flag guard first — returns short-circuit/refuse BEFORE calling generateCandidate.
 *  (2) For each round up to maxRounds: generate a candidate, run all four lenses, reconcile.
 *  (3) On accept: return accepted outcome immediately.
 *  (4) On reject: regenerate with collected dissent feedback for the next round.
 *  (5) After maxRounds without consensus: return rejected outcome (fail-closed).
 *
 * NEVER throws — a thrown lens client is caught and counted as a reject verdict (fail-closed).
 * NEVER exceeds MEDICAL_PANEL_MAX_TOTAL_CALLS.
 *
 * FAIL-CLOSED INVERSION: mirrors grounding-critic.ts:203-206, NOT critic-deep.ts:199-201.
 */
export async function runJudgeLoop(input: {
  question: string;
  generateCandidate: (prevFeedback?: string) => Promise<string>;
  lensClients: LensClients;
  context: string;
  redFlag: GuardrailSet;
  maxRounds?: number;
  now?: string;
}): Promise<PanelOutcome> {
  const {
    question,
    generateCandidate,
    lensClients,
    context,
    redFlag,
    maxRounds = MEDICAL_PANEL_MAX_ROUNDS,
  } = input;

  // Step 1: Red-flag guard FIRST — generateCandidate is never called for short-circuit / refuse.
  // Matches behaviour of MedicalGuardrails.evaluate (guardrails.ts:84-111).
  const guardCtx: GuardrailContext = {};
  const guardVerdict = redFlag.evaluate(question, guardCtx);

  if (guardVerdict.kind === "short-circuit") {
    return {
      outcome: "short-circuit",
      rule: guardVerdict.rule,
      cannedResponse: guardVerdict.cannedResponse,
    };
  }

  if (guardVerdict.kind === "refuse") {
    return {
      outcome: "refuse",
      rule: guardVerdict.rule,
      reason: guardVerdict.reason,
    };
  }

  // Step 2: Regenerate-on-reject loop (structure from critic-deep.ts:211-278, fail-open REPLACED)
  let prevFeedback: string | undefined;
  let lastVerdicts: Record<LensName, LensVerdict> | undefined;
  let lastDecision: PanelDecision | undefined;

  for (let round = 1; round <= maxRounds; round++) {
    // Generate a candidate (counted in MEDICAL_PANEL_MAX_TOTAL_CALLS budget)
    const candidate = await generateCandidate(prevFeedback);

    // Build user content for lens calls
    const userContent =
      `Patient question: ${question}\n\n` +
      `Proposed recommendation:\n${candidate}\n\n` +
      `Profile context: ${context}`;

    // Run all four lenses — each wrapped in try/catch; a throw counts as reject (fail-closed)
    const lensEntries: Array<{ name: LensName; spec: LensSpec; systemPrompt: string }> = [
      {
        name: "evidence-grader",
        spec: lensClients.evidenceGrader,
        systemPrompt: buildEvidenceGraderSystemPrompt(question, context),
      },
      {
        name: "contraindication-checker",
        spec: lensClients.contraindicationChecker,
        systemPrompt: buildContraindicationCheckerSystemPrompt(question, context),
      },
      {
        name: "conservative-clinician",
        spec: lensClients.conservativeClinician,
        systemPrompt: buildConservativeCliniciansSystemPrompt(question, context),
      },
      {
        name: "optimization-lens",
        spec: lensClients.optimizationLens,
        systemPrompt: buildOptimizationLensSystemPrompt(question, context),
      },
    ];

    const verdicts: Partial<Record<LensName, LensVerdict>> = {};

    for (const lens of lensEntries) {
      try {
        const verdict = await runLens(lens.spec, lens.systemPrompt, userContent);
        verdicts[lens.name] = verdict;
      } catch {
        // Transport failure — count as reject (fail-closed), never propagate (sc-2-7)
        // FAIL-CLOSED inversion of critic-deep.ts:237-244 (which breaks to accept-best on throw).
        // bober: map lens throw to reject; intentional for medical safety.
        verdicts[lens.name] = {
          verdict: "reject",
          feedback: "<lens client threw; counted as reject for medical safety>",
          veto: false,
        };
      }
    }

    const typedVerdicts = verdicts as Record<LensName, LensVerdict>;

    // Reconcile the panel
    const decision = reconcilePanel(typedVerdicts);
    lastVerdicts = typedVerdicts;
    lastDecision = decision;

    if (decision.accepted) {
      // Step 3: Accept — return immediately (sc-2-2)
      return {
        outcome: "accepted",
        accepted: true,
        recommendation: candidate,
        verdicts: typedVerdicts,
        rounds: round,
      };
    }

    // Step 4: Reject — fold dissent feedback for next round
    const dissentParts: string[] = [];
    for (const [name, verdict] of Object.entries(typedVerdicts)) {
      if (verdict.feedback) {
        dissentParts.push(`[${name}] ${verdict.feedback}`);
      }
    }
    prevFeedback = dissentParts.join("; ");
  }

  // Step 5: Post-loop — fail-closed after maxRounds (sc-2-6)
  // FAIL-CLOSED inversion of critic-deep.ts:274-277 (which accept-best on exhaustion).
  // Mirrors grounding-critic.ts:203-206: reject on exhaustion; intentional for medical safety.
  // bober: fail-closed after maxRounds; no candidate surfaced; dissent captured.
  const finalVerdicts = lastVerdicts ?? ({} as Record<LensName, LensVerdict>);
  const dissent: Record<LensName, string> = {
    "evidence-grader": finalVerdicts["evidence-grader"]?.feedback ?? "",
    "contraindication-checker": finalVerdicts["contraindication-checker"]?.feedback ?? "",
    "conservative-clinician": finalVerdicts["conservative-clinician"]?.feedback ?? "",
    "optimization-lens": finalVerdicts["optimization-lens"]?.feedback ?? "",
  };

  return {
    outcome: "rejected",
    accepted: false,
    reason: lastDecision?.reason ?? "no-consensus",
    dissent,
    verdicts: finalVerdicts,
    rounds: maxRounds,
  };
}
