/**
 * generateRecommendation — recommendation generation end-to-end.
 *
 * Wires the sprint-2 judge loop into a real recommendation path:
 *  1. Assemble profile context from FactStore + medical profile
 *  2. Build four per-lens LLM clients (tier-diverse when cloud ON, all local when cloud OFF)
 *  3. Generate a candidate + gate through runJudgeLoop
 *  4. Emit a Finding:
 *     - accepted   → kind="action" (LLM-assigned urgency/severity/confidence, NO refer-out hedging)
 *     - rejected   → kind="question" flagged for review (per-lens dissent)
 *     - short-circuit/refuse → canned escalation, NO finding
 *  5. Append AuditLog entry (IDs/enums only — NonGoal #3)
 *
 * engine.ts is NO-TOUCH: patterns are COPIED (not imported) from engine.ts:250-410.
 * runJudgeLoop is IMPORTED — do NOT re-implement (NonGoal #5).
 *
 * sc-3-5 (fail-closed model selection): when egress.isAllowed("cloud-inference") is FALSE,
 * EVERY client (all four lenses + the generator) resolves via buildMedicalInferenceClient.
 * deps.clientFactory is threaded through both paths so tests can spy without network.
 */

import { join } from "node:path";

import type { BoberConfig } from "../../config/schema.js";
import type { LLMClient } from "../../providers/types.js";
import { EgressGuard } from "../egress.js";
import type { GuardrailSet } from "../types.js";
import { MedicalGuardrails } from "../guardrails.js";
import { buildMedicalInferenceClient } from "../inference.js";
import type { ClientFactory } from "../inference.js";
import { createClient } from "../../providers/factory.js";
import { tierPolicy } from "../../fleet/tier-policy.js";
import { AuditLog } from "../audit.js";
import type { FactStore } from "../../state/facts.js";
import type { ProfileCipher } from "../profile.js";
import { findingId } from "../analysis/finding.js";
import type { MedicalFinding } from "../analysis/finding.js";
import { writeFinding } from "../analysis/finding-writer.js";
import { runJudgeLoop } from "./judge-panel.js";
import type { LensClients, PanelOutcome } from "./types.js";
import { assembleRecommendationContext, contextToString } from "./context.js";
import { assignUrgencySeverity } from "./urgency.js";
import type { UrgencyResult } from "./urgency.js";

// -- Types ---------------------------------------------------------------

/** Discriminated outcome of generateRecommendation. */
export type RecommendOutcomeKind = "accepted" | "question" | "escalated" | "refused";

export interface RecommendOutcome {
  kind: RecommendOutcomeKind;
  /** Absolute path to the written Finding note (accepted + question paths). */
  findingPath?: string;
  /** Canned escalation response (escalated path). */
  cannedResponse?: string;
  /** Refusal reason (refused path). */
  reason?: string;
}

// -- Injectable deps (for tests) -----------------------------------------

/**
 * Injectable dependencies for generateRecommendation.
 * Production callers pass no deps. Tests inject everything to avoid real network/fs.
 */
export interface RecommendDeps {
  /** Pre-built lens clients (tests inject fake ScriptedClients). */
  lensClients?: LensClients;
  /** Override the candidate generator (tests inject a deterministic fn). */
  generateCandidate?: (prevFeedback?: string) => Promise<string>;
  /** Override the guardrail set (tests inject shortCircuitGuard / allowGuard). */
  redFlag?: GuardrailSet;
  /** Override the urgency assigner (tests inject a fn returning fixed values). */
  assignUrgency?: (
    llm: LLMClient,
    model: string,
    candidate: string,
    context: string,
  ) => Promise<UrgencyResult>;
  /** Override writeFinding (tests inject a fn that writes to a temp vault). */
  writeFindingFn?: typeof writeFinding;
  /** Injected FactStore (tests pass :memory:; caller owns lifecycle). */
  facts?: FactStore;
  /** Override the EgressGuard (tests inject a fixed allow/deny guard). */
  egress?: EgressGuard;
  /**
   * Injectable ClientFactory for cloud-OFF spy test (sc-3-5).
   * Threaded into BOTH buildMedicalInferenceClient AND the tier createClient calls
   * so tests can assert no cloud provider was constructed.
   */
  clientFactory?: ClientFactory;
  /** Override the AuditLog (tests inject a no-op or in-memory log). */
  auditLog?: AuditLog;
  /** Override ProfileCipher (tests inject a reversible fake). */
  profileCipher?: ProfileCipher;
}

// -- generateRecommendation ----------------------------------------------

/**
 * Run the recommendation pipeline end-to-end.
 *
 * @param projectRoot  Absolute project root path
 * @param config       Loaded BoberConfig
 * @param opts         { question, goal?, now } — clock is read ONLY at the CLI boundary
 * @param deps         Optional injectable dependencies for tests
 */
export async function generateRecommendation(
  projectRoot: string,
  config: BoberConfig,
  opts: { question: string; goal?: string; now: string },
  deps: RecommendDeps = {},
): Promise<RecommendOutcome> {
  const { question, goal, now } = opts;

  // 1. Egress guard + factory
  const egress = deps.egress ?? EgressGuard.fromConfig(config);
  const factory = deps.clientFactory ?? createClient;

  // 2. Vault dir for findings (mirrors review-pass.ts:51-52)
  const vaultDir =
    config.medical?.vaultDir ?? join(projectRoot, ".bober", "medical", "vault");

  // 3. Audit log
  const auditLog = deps.auditLog ?? new AuditLog(projectRoot);

  // 4. Red-flag guard
  const redFlag = deps.redFlag ?? new MedicalGuardrails();

  // 5. Build four lens clients + generator client
  //    CRITICAL (sc-3-5): gate the ENTIRE tier branch behind isAllowed("cloud-inference").
  //    When cloud is OFF, ALL four lenses + the generator resolve via buildMedicalInferenceClient
  //    using the injected factory so tests can spy.
  let lensClients: LensClients;
  let generatorSpec: { client: LLMClient; model: string };

  if (deps.lensClients !== undefined) {
    // Test-injected lens clients; build a local generator unless generateCandidate is also injected
    lensClients = deps.lensClients;
    generatorSpec = buildMedicalInferenceClient(config, egress, factory);
  } else if (egress.isAllowed("cloud-inference")) {
    // Cloud ON: use tier diversity (briefing §E)
    // evidenceGrader → cheap (deepseek)
    // contraindicationChecker → standard (grok)
    // conservativeClinician → hard (sonnet)
    // optimizationLens → frontier (opus)
    // generator → hard (sonnet)
    const cheapBlock = tierPolicy.resolveTier("cheap")!.generator; // openai-compat deepseek
    const standardBlock = tierPolicy.resolveTier("standard")!.generator; // openai-compat grok
    const hardBlock = tierPolicy.resolveTier("hard")!.generator; // anthropic sonnet
    const frontierBlock = tierPolicy.resolveTier("frontier")!.generator; // anthropic opus

    lensClients = {
      evidenceGrader: {
        client: factory(
          cheapBlock.provider,
          cheapBlock.endpoint ?? undefined,
          undefined,
          cheapBlock.model,
        ),
        model: cheapBlock.model,
      },
      contraindicationChecker: {
        client: factory(
          standardBlock.provider,
          standardBlock.endpoint ?? undefined,
          undefined,
          standardBlock.model,
        ),
        model: standardBlock.model,
      },
      conservativeClinician: {
        client: factory(
          hardBlock.provider,
          hardBlock.endpoint ?? undefined,
          undefined,
          hardBlock.model,
        ),
        model: hardBlock.model,
      },
      optimizationLens: {
        client: factory(
          frontierBlock.provider,
          frontierBlock.endpoint ?? undefined,
          undefined,
          frontierBlock.model,
        ),
        model: frontierBlock.model,
      },
    };
    generatorSpec = {
      client: factory(
        hardBlock.provider,
        hardBlock.endpoint ?? undefined,
        undefined,
        hardBlock.model,
      ),
      model: hardBlock.model,
    };
  } else {
    // Cloud OFF: ALL four lenses + generator resolve via buildMedicalInferenceClient (fail-closed)
    // bober: all local when cloud-inference off; swap for per-lens routing if cloud is opt-in.
    const localSpec = buildMedicalInferenceClient(config, egress, factory);
    lensClients = {
      evidenceGrader: localSpec,
      contraindicationChecker: localSpec,
      conservativeClinician: localSpec,
      optimizationLens: localSpec,
    };
    generatorSpec = localSpec;
  }

  // 6. Assemble profile context
  const ctx = await assembleRecommendationContext(
    projectRoot,
    config,
    { goal },
    { facts: deps.facts, profileCipher: deps.profileCipher },
  );
  // runJudgeLoop.context is a STRING — must be serialized (judge-panel.ts:92)
  const contextString = contextToString(ctx);

  // 7. Build generateCandidate (or use injected one)
  const generateCandidate =
    deps.generateCandidate ??
    (async (prevFeedback?: string): Promise<string> => {
      const systemPrompt =
        `You are a medical advisor. Given a patient question and their profile context, ` +
        `provide a clear and specific recommendation. Be direct and actionable.` +
        (prevFeedback !== undefined ? `\n\nPanel feedback to incorporate:\n${prevFeedback}` : "");
      const response = await generatorSpec.client.chat({
        model: generatorSpec.model,
        system: systemPrompt,
        messages: [{ role: "user", content: `Question: ${question}\n\nContext:\n${contextString}` }],
      });
      return response.text;
    });

  // 8. Run judge loop (IMPORT — do NOT re-implement)
  const panelOutcome: PanelOutcome = await runJudgeLoop({
    question,
    generateCandidate,
    lensClients,
    context: contextString,
    redFlag,
    now,
  });

  // 9. Handle outcome — switch on outcome.outcome (types.ts:84-133)
  if (panelOutcome.outcome === "short-circuit") {
    // Red-flag matched: canned escalation, NO finding, short-circuit audit entry
    // Pattern from engine.ts:250-289 (copied, not imported)
    await auditLog.append({
      tIso: now,
      event: "short-circuit",
      ruleId: panelOutcome.rule,
      rulesetVersion: redFlag.rulesetVersion,
    });
    return { kind: "escalated", cannedResponse: panelOutcome.cannedResponse };
  }

  if (panelOutcome.outcome === "refuse") {
    // Content-policy refusal: NO finding
    await auditLog.append({
      tIso: now,
      event: "refuse",
      ruleId: panelOutcome.rule,
      rulesetVersion: redFlag.rulesetVersion,
    });
    return { kind: "refused", reason: panelOutcome.reason };
  }

  if (panelOutcome.outcome === "accepted") {
    // Accepted: assign urgency/severity, write kind="action" Finding
    const urgencyFn = deps.assignUrgency ?? assignUrgencySeverity;
    const { urgency, severity, confidence } = await urgencyFn(
      generatorSpec.client,
      generatorSpec.model,
      panelOutcome.recommendation,
      contextString,
    );

    // id is deterministic — re-runs with the same question overwrite the same file (sc-1-4 pattern)
    const id = findingId("medical", question, "recommend-action");

    const finding: MedicalFinding = {
      id,
      domain: "medical",
      // sc-3-2: title states the recommendation DIRECTLY — NO refer-out hedging
      title: panelOutcome.recommendation.slice(0, 120).trimEnd(),
      kind: "action",
      urgency,
      severity,
      // evidence contains the full recommendation text (direct; no hedging added)
      evidence: [panelOutcome.recommendation],
      surfacedAt: now,
      // sc-3-6: confidence recorded in tags (confidence:X.XX)
      tags: [`confidence:${confidence.toFixed(2)}`],
      status: "open",
    };

    const writeFindingFn = deps.writeFindingFn ?? writeFinding;
    const findingPath = await writeFindingFn(vaultDir, finding);

    // IDs/enums only (NonGoal #3) — no recommendation text, no health values
    await auditLog.append({ tIso: now, event: "answer" });

    return { kind: "accepted", findingPath };
  }

  // outcome === "rejected" (no-consensus or contraindication-veto)
  // Write kind="question" Finding with per-lens dissent; NO kind="action" finding (sc-3-3)
  const dissentLines = Object.entries(panelOutcome.dissent)
    .filter(([, text]) => text.length > 0)
    .map(([lens, text]) => `[${lens}] ${text}`);

  const id = findingId("medical", question, "recommend-question");
  const finding: MedicalFinding = {
    id,
    domain: "medical",
    // sc-3-3: title must contain "flagged for your review" (lowercase per contract criterion)
    title: `flagged for your review — panel disagreed on: ${question.slice(0, 80).trimEnd()}`,
    kind: "question",
    urgency: 2,
    severity: 2,
    // evidence = per-lens dissent strings (sc-3-3)
    evidence:
      dissentLines.length > 0 ? dissentLines : ["Panel could not reach consensus"],
    surfacedAt: now,
    tags: ["no-consensus"],
    status: "open",
  };

  const writeFindingFn = deps.writeFindingFn ?? writeFinding;
  const findingPath = await writeFindingFn(vaultDir, finding);

  // IDs/enums only — no recommendation text, no health values
  await auditLog.append({ tIso: now, event: "abstain" });

  return { kind: "question", findingPath };
}
