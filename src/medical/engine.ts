/**
 * MedicalSopEngine stub (Phase 6, Sprint 1).
 *
 * Implements PipelineEngine with pipelineShape 'medical-sop'.
 * The real SOP (consent gate, red-flag gate, numerics, retrieval, answer)
 * is implemented in S2/S3/S4/S6. This stub returns a trivial PipelineResult.
 *
 * No LLM calls, no SDK imports.
 */
import type { BoberConfig } from "../config/schema.js";
import type { PipelineResult } from "../orchestrator/pipeline.js";
import type { PipelineEngine, PipelineEngineName } from "../orchestrator/workflow/engine.js";
import { createSpec } from "../contracts/spec.js";

// ── MedicalSopEngine ────────────────────────────────────────────────

/**
 * Stub engine for the medical-sop pipelineShape.
 * Satisfies the PipelineEngine interface; real SOP logic lands in S2/S3/S6.
 * bober: stub returns trivial result; wire real SOP phases in S2–S6.
 */
export class MedicalSopEngine implements PipelineEngine {
  readonly name: PipelineEngineName = "medical-sop";

  async run(
    _userPrompt: string,
    _projectRoot: string,
    _config: BoberConfig,
    _opts?: { runId?: string },
  ): Promise<PipelineResult> {
    // Stub: real SOP (consent/gate/numerics/retrieval/answer) lands in S2/S3/S4/S6.
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
    };
  }
}
