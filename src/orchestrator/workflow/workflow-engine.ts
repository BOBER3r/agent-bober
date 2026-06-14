// ── WorkflowEngine ─────────────────────────────────────────────────

import type { BoberConfig } from "../../config/schema.js";
import type { PipelineResult } from "../pipeline.js";
import { logger } from "../../utils/logger.js";
import type { PipelineEngine, PipelineEngineName } from "./engine.js";
import { isWorkflowEligible } from "./eligibility.js";
import { ResumeCursorReconstructor } from "./resume-cursor.js";
import { ArgsPayloadBuilder } from "./args-builder.js";
import { RunResultFlusher } from "./flusher.js";
import { TsPipelineEngine } from "./ts-engine.js";
import { WorkflowUnavailableError } from "./errors.js";
import type { WorkflowArgs, WorkflowRunResult } from "./types.js";

// ── WorkflowEngine ──────────────────────────────────────────────────

/**
 * Pipeline engine that assembles and invokes the Dynamic Workflows runtime.
 *
 * Control flow (eligibility FIRST — avoids MissingKnobError on the downgrade path):
 *   1. if (!isWorkflowEligible(config))  → log once + return tsEngine.run(...)   ← NO args built
 *   2. cursor = reconstruct(...)         ← read-only (listContracts + loadHistory)
 *   3. args   = build(...)               ← pure; may throw MissingKnobError (acceptable: eligible)
 *   4. try { result = invoke(args); return flush(result) }
 *      catch WorkflowUnavailableError → log once + return tsEngine.run(...)  ← NO partial flush
 *      catch other → rethrow
 *
 * invoke() is DORMANT this release — always throws WorkflowUnavailableError.
 * The eligible path is only reachable in tests that force eligibility=true via
 * the injection seam (constructor param + vi.mock).
 */
export class WorkflowEngine implements PipelineEngine {
  readonly name: PipelineEngineName = "workflow";

  /**
   * Injection seam — tsEngineFactory defaults to () => new TsPipelineEngine().
   * Tests inject a fake factory that returns a sentinel PipelineResult without
   * spawning real LLM agents.
   */
  constructor(
    private readonly tsEngineFactory: () => PipelineEngine = () =>
      new TsPipelineEngine(),
  ) {}

  async run(
    userPrompt: string,
    projectRoot: string,
    config: BoberConfig,
    opts?: { runId?: string },
  ): Promise<PipelineResult> {
    // ── STEP 1: Eligibility check FIRST (avoids MissingKnobError on downgrade path) ──
    if (!isWorkflowEligible(config)) {
      logger.info(
        "workflow runtime unavailable — re-dispatching TS engine",
      );
      return this.tsEngineFactory().run(userPrompt, projectRoot, config, opts);
    }

    // ── STEP 2: Reconstruct cursor (read-only — writes nothing) ────────────────
    // specId is derived from config or empty — invoke is dormant so this is
    // never persisted. The PipelineEngine.run() signature is frozen (no specId).
    const specId = (config.project as { specId?: string } | undefined)?.specId ?? "";
    const cursor = await new ResumeCursorReconstructor().reconstruct(
      projectRoot,
      specId,
    );

    // ── STEP 3: Build args (pure — throws MissingKnobError if knobs missing) ────
    const args = new ArgsPayloadBuilder().build(userPrompt, config, cursor, "");

    // ── STEP 4: Invoke → flush; catch WorkflowUnavailableError → re-dispatch ───
    try {
      const result: WorkflowRunResult = await this.invoke(args);
      return await new RunResultFlusher().flush(projectRoot, config, result);
    } catch (e) {
      if (e instanceof WorkflowUnavailableError) {
        logger.info(
          "workflow runtime unavailable — re-dispatching TS engine",
        );
        return this.tsEngineFactory().run(userPrompt, projectRoot, config, opts);
      }
      throw e;
    }
  }

  // ── Dormant invoke (non-goal: no live transport this release) ──────────────
  //
  // Always throws WorkflowUnavailableError so the run() catch block re-dispatches
  // to the TS engine with zero partial flush (flush is only reached post-invoke).
  private async invoke(_args: WorkflowArgs): Promise<WorkflowRunResult> {
    throw new WorkflowUnavailableError(
      "Programmatic workflow invoke is not implemented this release.",
    );
  }
}
