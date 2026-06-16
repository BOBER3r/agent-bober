/**
 * MedicalSopEngine — Gate 1 (consent) wired (Phase 6, Sprint 2).
 *
 * Implements PipelineEngine with pipelineShape 'medical-sop'.
 * Gate 1 (consent) is enforced FIRST: absent consent ⇒ refuse MedicalAnswer
 * with ZERO downstream calls. Gate 2 (red-flag) and numerics/retrieval land
 * in S3/S4/S6.
 *
 * No LLM calls, no SDK imports. All timestamps are injected via opts.now.
 */
import type { BoberConfig } from "../config/schema.js";
import type { PipelineResult } from "../orchestrator/pipeline.js";
import type { PipelineEngine, PipelineEngineName } from "../orchestrator/workflow/engine.js";
import { createSpec } from "../contracts/spec.js";
import { AuditLog } from "./audit.js";
import { ConsentGate } from "./consent.js";
import { DisclaimerComposer } from "./disclaimer.js";
import type { MedicalAnswer } from "./types.js";

// ── Dependency injection seam ───────────────────────────────────────

/**
 * Optional deps injected by tests.
 * Production code leaves this undefined; run() constructs real instances.
 * bober: simple optional-deps seam; swap for a DI container if the dep graph grows.
 */
export interface MedicalSopDeps {
  auditLog?: AuditLog;
  consentGate?: ConsentGate;
  disclaimer?: DisclaimerComposer;
}

// ── Canned messages ─────────────────────────────────────────────────

const CONSENT_REQUIRED_MSG =
  "Consent is required before this assistant can respond to health-related questions. " +
  "Please provide consent to continue.";

// ── MedicalSopEngine ────────────────────────────────────────────────

/**
 * Medical-SOP pipeline engine.
 *
 * Zero-arg constructor is preserved so that src/orchestrator/workflow/selector.ts
 * can call `new MedicalSopEngine()` without changes (Sprint 1 contract).
 * Fakes are injected via the optional `deps` constructor argument.
 *
 * bober: stub returns placeholder MedicalAnswer; real SOP (LLM/numerics/retrieval) in S4/S6.
 */
export class MedicalSopEngine implements PipelineEngine {
  readonly name: PipelineEngineName = "medical-sop";

  constructor(private readonly deps?: MedicalSopDeps) {}

  async run(
    userPrompt: string,
    projectRoot: string,
    _config: BoberConfig,
    opts?: { runId?: string; now?: string },
  ): Promise<PipelineResult> {
    // All timestamps come from the injected `now` — never the wall clock.
    // bober: fallback ISO for ad-hoc manual runs only; tests must always inject `now`.
    const now = opts?.now ?? new Date().toISOString();

    // ── Construct real instances when not injected ────────────────────
    const auditLog = this.deps?.auditLog ?? new AuditLog(projectRoot);
    const consentGate = this.deps?.consentGate ?? new ConsentGate(projectRoot, auditLog);
    const disclaimer = this.deps?.disclaimer ?? new DisclaimerComposer();

    const footer = disclaimer.footer();

    // ── Gate 1: Consent (fail-closed) ────────────────────────────────
    const hasConsent = await consentGate.hasConsent();

    if (!hasConsent) {
      // Refuse — ZERO downstream calls (no numerics, no LLM, no retrieval).
      await auditLog.append({
        tIso: now,
        event: "refuse",
        ruleId: "consent-required",
      });

      const refuseAnswer: MedicalAnswer = {
        body: CONSENT_REQUIRED_MSG,
        abstained: false,
        citations: [],
        disclaimerFooter: footer,
        shortCircuit: true,
      };

      const spec = createSpec(
        "Medical SOP — consent refused",
        "Consent gate refused the request before any downstream processing.",
        [],
      );

      return {
        success: false,
        spec,
        completedSprints: [],
        failedSprints: [],
        duration: 0,
        // Surface the MedicalAnswer in the spec description for downstream callers.
        // bober: attach MedicalAnswer to PipelineResult via a typed extension in S6.
        medicalAnswer: refuseAnswer,
      } as PipelineResult & { medicalAnswer: MedicalAnswer };
    }

    // ── Gate 2+ (stub): GuardrailSet.evaluate (allow-only this sprint) ──
    // Real red-flag detection lands in S3. For now the guardrail always allows.
    const consentRecord = await consentGate.current();
    const rulesetVersion = consentRecord?.rulesetVersion;

    await auditLog.append({
      tIso: now,
      event: "answer",
      rulesetVersion,
    });

    const placeholderAnswer: MedicalAnswer = {
      body: `[Medical SOP placeholder — prompt: ${userPrompt.slice(0, 0)}]`,
      abstained: false,
      citations: [],
      disclaimerFooter: footer,
      shortCircuit: false,
    };

    const spec = createSpec(
      "Medical SOP (stub)",
      "Placeholder spec for the medical-sop engine stub. Real SOP implementation in S2/S3/S4/S6.",
      [],
    );

    return {
      success: true,
      spec,
      completedSprints: [],
      failedSprints: [],
      duration: 0,
      medicalAnswer: placeholderAnswer,
    } as PipelineResult & { medicalAnswer: MedicalAnswer };
  }
}
