/**
 * Materialize sprint contracts from a plan spec's feature list.
 *
 * Extracted verbatim from the runTsPipeline inline loop so that both the run
 * pipeline AND the standalone `plan` command (Sprint 2) share one source of
 * truth. Contract content is feature-derived; ids are deterministic and
 * zero-padded as `sprint-<specId>-NN` so listContracts() lexical ordering
 * matches sprint execution order.
 *
 * These auto-generated contracts use placeholder precision fields;
 * a planner-authored contract (saved directly by the bober-planner
 * subagent) supersedes them with substantive nonGoals, stopConditions,
 * and definitionOfDone.
 *
 * The post-plan and post-sprint-contract audit checkpoints are pipeline
 * concerns and live in pipeline.ts — NOT here. This helper has zero
 * runWithAudit / appendHistory / checkpoint references.
 */

import type { BoberConfig } from "../config/schema.js";
import type { PlanSpec } from "../contracts/spec.js";
import type { SprintContract } from "../contracts/sprint-contract.js";
import { createContract, SprintContractSchema } from "../contracts/sprint-contract.js";
import { generateContractPrecision } from "./planner-agent.js";
import { saveContract } from "../state/index.js";
import { logger } from "../utils/logger.js";

/**
 * Create and persist one SprintContract per feature in spec.features.
 *
 * Contract content is derived from feature fields. Ids are set to
 * `sprint-<specId>-NN` (width-2 zero-padded) after construction so
 * listContracts() lexical sort equals sprint execution order.
 *
 * Returns the contracts array in feature / sprintNumber order so the caller
 * can pass it to the post-sprint-contract checkpoint and the sprint loop.
 */
export async function materializeContracts(
  spec: PlanSpec,
  projectRoot: string,
  config: BoberConfig,
): Promise<SprintContract[]> {
  // ── Embedded branch: prefer valid spec.sprints when present ──────────
  // Real bober-authored specs have string sprints (ids) — safeParse fails
  // those and falls through to the feature-derived branch below.
  // External/planner-authored specs may carry full contract objects here.
  if (Array.isArray(spec.sprints) && spec.sprints.length > 0) {
    const embedded: SprintContract[] = [];
    let allParsed = true;

    for (let i = 0; i < spec.sprints.length; i++) {
      const parsed = SprintContractSchema.safeParse(spec.sprints[i]);
      if (!parsed.success) {
        allParsed = false;
        logger.warn(
          `Embedded spec.sprints[${i}] failed schema validation; falling back to feature-derived contracts for the whole spec.`,
        );
        break;
      }
      const contract = parsed.data;
      contract.status = "proposed";
      contract.specId = spec.specId;
      contract.sprintNumber = i + 1;
      // bober: width-2 pad covers 1–99; widen to 3 if suite grows past 99.
      contract.contractId = `sprint-${spec.specId}-${String(i + 1).padStart(2, "0")}`;
      // Security (sprint 4 of spec-20260812-terminal-vocabulary): strip a producer-supplied
      // `version` on the seeded copy, alongside the four fields already normalized above.
      // `SprintContractSchema.version` is bounded only by `.int().min(0)` — no upper bound —
      // and as of this sprint the `sprintContracts` channel's join (`registry/reducers.ts`)
      // consults it to decide which of two same-id contracts survives. An embedded contract
      // is producer-supplied (an external/planner-authored spec's `spec.sprints`), so an
      // inflated `version` here would permanently outrank the SETTLED copy `sprint_exit`
      // writes (bounded by `sprintIterations.maxIterations`) — inverting exactly the
      // ordering the rank-aware join exists to provide. The feature-derived branch below
      // needs no equivalent strip: `createContract` never sets `version`.
      delete contract.version;
      embedded.push(contract);
    }

    if (allParsed && embedded.length > 0) {
      try {
        for (const c of embedded) {
          await saveContract(projectRoot, c);
        }
        return embedded;
      } catch (err) {
        logger.warn(
          `Embedded sprints failed the precision gate; falling back to feature-derived contracts: ${err instanceof Error ? err.message : String(err)}`,
        );
        // fall through to feature-derived loop
      }
    }
  }

  // ── Feature-derived branch (fallback and default path) ───────────────
  const contracts: SprintContract[] = [];
  for (let i = 0; i < spec.features.length; i++) {
    const feature = spec.features[i];
    // Generate substantive precision fields (nonGoals/stopConditions/
    // definitionOfDone) so the contract passes the generator's BLOCKING
    // precision preflight. Without this the standalone pipeline emits
    // placeholder contracts that every generator (Claude or DeepSeek) refuses.
    const precision = await generateContractPrecision(feature, spec, config);
    if (precision) {
      logger.info(
        `Generated precision fields for sprint ${i + 1} (${precision.nonGoals.length} non-goals, ${precision.stopConditions.length} stop conditions).`,
      );
    } else {
      logger.warn(
        `Could not generate precision fields for sprint ${i + 1}; contract will use placeholders and the generator may block it.`,
      );
    }
    const contract = createContract(
      feature.title,
      feature.description,
      feature.acceptanceCriteria.map((ac, idx) => ({
        criterionId: `${feature.featureId}-criterion-${idx + 1}`,
        description: ac,
        verificationMethod: "agent-evaluation",
      })),
      {
        specId: spec.specId,
        sprintNumber: i + 1,
        features: [feature.featureId],
        ...(precision
          ? {
              nonGoals: precision.nonGoals,
              stopConditions: precision.stopConditions,
              definitionOfDone: precision.definitionOfDone,
            }
          : {}),
      },
    );
    // createContract doesn't take assumptions/outOfScope; set them directly.
    if (precision) {
      contract.assumptions = precision.assumptions;
      contract.outOfScope = precision.outOfScope;
    }
    // Deterministic, zero-padded id: lexical order == execution order.
    // bober: width-2 pad covers 1–99 sprints; widen to 3 if suite grows past 99.
    contract.contractId = `sprint-${spec.specId}-${String(i + 1).padStart(2, "0")}`;
    contracts.push(contract);
    await saveContract(projectRoot, contract);
  }
  return contracts;
}
