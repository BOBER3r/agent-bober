import type { BoberConfig } from "../../config/schema.js";
import { runTsPipeline } from "../pipeline.js";
import type { PipelineResult } from "../pipeline.js";
import type { PipelineEngine, PipelineEngineName } from "./engine.js";

// ── TsPipelineEngine ───────────────────────────────────────────────

/**
 * Engine adapter that wraps the original TypeScript pipeline implementation.
 * Delegates to runTsPipeline — the extracted former runPipeline body — with
 * ZERO behaviour change on the default 'ts' path.
 */
export class TsPipelineEngine implements PipelineEngine {
  readonly name: PipelineEngineName = "ts";

  run(
    userPrompt: string,
    projectRoot: string,
    config: BoberConfig,
  ): Promise<PipelineResult> {
    return runTsPipeline(userPrompt, projectRoot, config);
  }
}
