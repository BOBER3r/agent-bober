import type { BoberConfig } from "../../config/schema.js";
import type { PipelineResult } from "../pipeline.js";

// ── Types ──────────────────────────────────────────────────────────

/** Well-known orchestration engine names. Mirrors the z.enum in PipelineSectionSchema. */
export type PipelineEngineName = "ts" | "skill" | "workflow";

/** Interface every pipeline engine implementation must satisfy. */
export interface PipelineEngine {
  readonly name: PipelineEngineName;
  run(
    userPrompt: string,
    projectRoot: string,
    config: BoberConfig,
  ): Promise<PipelineResult>;
}
