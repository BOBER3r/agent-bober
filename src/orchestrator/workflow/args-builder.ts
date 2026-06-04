// ── ArgsPayloadBuilder ──────────────────────────────────────────────

import type { BoberConfig } from "../../config/schema.js";
import { MissingKnobError, AgentCapError, NonSerializableArgError } from "./errors.js";
import type { WorkflowArgs, ResumeCursor } from "./types.js";

/**
 * Marshals config + user prompt + resume cursor into a fully JSON-serializable
 * WorkflowArgs payload.
 *
 * Pure function — no fs / Date.now / Math.random inside build().
 * Throws typed errors at build time before any agent is dispatched:
 *   - MissingKnobError   — a required knob is undefined
 *   - AgentCapError      — worst-case agent count exceeds 16/1000 caps
 *   - NonSerializableArgError — args cannot round-trip through JSON
 */
export class ArgsPayloadBuilder {
  /**
   * @param userPrompt  Plain-text user request passed verbatim to the workflow.
   * @param config      Validated BoberConfig (all defaults already applied).
   * @param resumeCursor  Pre-built cursor from ResumeCursorReconstructor.
   * @param principles  Raw principles text (caller reads from disk; keep build pure).
   */
  build(
    userPrompt: string,
    config: BoberConfig,
    resumeCursor: ResumeCursor,
    principles: string = "",
  ): WorkflowArgs {
    // ── 1. Pull required knobs; throw MissingKnobError if undefined ──

    const maxIterations = config.evaluator.maxIterations;
    if (maxIterations === undefined) {
      throw new MissingKnobError("evaluator.maxIterations");
    }

    const maxSprints = config.sprint.maxSprints;
    if (maxSprints === undefined) {
      throw new MissingKnobError("sprint.maxSprints");
    }

    const researchPhase = config.pipeline.researchPhase;
    if (researchPhase === undefined) {
      throw new MissingKnobError("pipeline.researchPhase");
    }

    const architectPhase = config.pipeline.architectPhase;
    if (architectPhase === undefined) {
      throw new MissingKnobError("pipeline.architectPhase");
    }

    const curatorEnabled = config.curator?.enabled;
    if (curatorEnabled === undefined) {
      throw new MissingKnobError("curator.enabled");
    }

    const codeReviewEnabled = config.codeReview?.enabled;
    if (codeReviewEnabled === undefined) {
      throw new MissingKnobError("codeReview.enabled");
    }

    const requireContracts = config.sprint.requireContracts;
    if (requireContracts === undefined) {
      throw new MissingKnobError("sprint.requireContracts");
    }

    // ── 2. Resolve models ────────────────────────────────────────────

    const plannerModel = config.planner.model;
    if (plannerModel === undefined) {
      throw new MissingKnobError("planner.model");
    }

    const curatorModel = config.curator?.model;
    if (curatorModel === undefined) {
      throw new MissingKnobError("curator.model");
    }

    const generatorModel = config.generator.model;
    if (generatorModel === undefined) {
      throw new MissingKnobError("generator.model");
    }

    const evaluatorModel = config.evaluator.model;
    if (evaluatorModel === undefined) {
      throw new MissingKnobError("evaluator.model");
    }

    // ── 3. Derive evaluatorLenses ────────────────────────────────────

    const lenses: string[] =
      config.evaluator.strategies.length > 0
        ? config.evaluator.strategies.map((s) => s.label ?? s.type)
        : ["default"];

    // ── 4. Cap check ─────────────────────────────────────────────────

    const total = maxSprints * maxIterations * lenses.length;
    if (lenses.length > 16 || total > 1000) {
      throw new AgentCapError(
        `Agent cap exceeded: lenses=${lenses.length} (max 16), total=${total} (max 1000, computed as maxSprints=${maxSprints} × maxIterations=${maxIterations} × lenses=${lenses.length}).`,
      );
    }

    // ── 5. Assemble args ─────────────────────────────────────────────

    const args: WorkflowArgs = {
      userPrompt,
      knobs: {
        maxIterations,
        maxSprints,
        researchPhase,
        architectPhase,
        curatorEnabled,
        codeReviewEnabled,
        requireContracts,
      },
      models: {
        planner: plannerModel,
        curator: curatorModel,
        generator: generatorModel,
        evaluator: evaluatorModel,
      },
      evaluatorLenses: lenses,
      principles,
      preloadedContracts: [],
      resumeCursor,
    };

    // ── 6. JSON round-trip serializability check ─────────────────────
    //
    // Two failure modes:
    //   a) JSON.stringify throws (BigInt, circular refs) → catch and throw NonSerializableArgError
    //   b) JSON.stringify silently drops/transforms values (functions, undefined, Symbol)
    //      → detected by a replacer that throws on non-serializable types, then
    //        a round-trip comparison to confirm JSON.parse(JSON.stringify(x)) === JSON.stringify(x).

    function strictReplacer(_key: string, value: unknown): unknown {
      if (typeof value === "function") {
        throw new NonSerializableArgError(
          `WorkflowArgs contains a non-serializable function value at key "${_key}".`,
        );
      }
      if (typeof value === "symbol") {
        throw new NonSerializableArgError(
          `WorkflowArgs contains a non-serializable Symbol value at key "${_key}".`,
        );
      }
      if (typeof value === "undefined") {
        throw new NonSerializableArgError(
          `WorkflowArgs contains an undefined value at key "${_key}" (would be silently dropped).`,
        );
      }
      return value;
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(args, strictReplacer);
    } catch (err) {
      if (err instanceof NonSerializableArgError) {
        throw err;
      }
      throw new NonSerializableArgError(
        `WorkflowArgs could not be serialized to JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const roundTripped = JSON.parse(serialized) as unknown;
    if (JSON.stringify(roundTripped) !== serialized) {
      throw new NonSerializableArgError(
        "WorkflowArgs failed JSON round-trip equality check: serialized and re-parsed representations differ.",
      );
    }

    return args;
  }
}
