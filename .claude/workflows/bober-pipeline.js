// ── bober-pipeline.js — Dynamic Workflows script (DORMANT this release) ──
// Pure-JS orchestrator: plan → curate → generate → panel → reconcile → retry.
// Owns NO truth. NO fs / Date.now / new Date / Math.random — host flusher stamps time.
import { reconcile } from "./lib/reconcile.js";

// C1 REQUIREMENT: meta must be a PURE LITERAL (no variables, no interpolation).
export const meta = {
  name: "bober-pipeline",
  description: "Bober plan→curate→generate→panel→reconcile→retry orchestration.",
  phases: [{ title: "Plan" }, { title: "Sprint" }],
};

// ── Pure exported helpers (unit-testable without the live agent() runtime) ──

/**
 * Split an array into chunks of at most `size` elements.
 * Returns an array of sub-arrays, each with length <= size.
 */
export function chunk(items, size) {
  const groups = [];
  for (let i = 0; i < items.length; i += size) {
    groups.push(items.slice(i, i + size));
  }
  return groups;
}

/**
 * Filter contracts to exclude those whose sprintNumber is in completedSprintNumbers.
 */
export function skipCompleted(contracts, completedSprintNumbers) {
  const completed = new Set(completedSprintNumbers);
  return contracts.filter((c) => !completed.has(c.sprintNumber));
}

/**
 * Decide the outcome string for a sprint that did not pass reconcile.
 * Returns "needs-rework" if there are iterations remaining, "failed" if exhausted.
 */
export function decideOutcome(reconciled, iteration, maxIterations) {
  if (reconciled.passed) {
    return "passed";
  }
  if (iteration < maxIterations) {
    return "needs-rework";
  }
  return "failed";
}

// ── Main orchestration (uses injected runtime hooks: agent, parallel, phase, log) ──

export async function main(args) {
  // PLAN
  phase("Plan");
  log("Running planner agent...");
  const spec = await agent({
    agentType: "bober-planner",
    model: args.models.planner,
  });

  if (spec.needsClarification) {
    return {
      spec,
      perSprint: [],
      needsClarification: true,
      pendingHistory: [],
    };
  }

  const perSprint = [];
  const pendingHistory = [];

  // Skip contracts already completed in a prior run
  const contracts = skipCompleted(
    args.preloadedContracts,
    args.resumeCursor.completedSprintNumbers,
  );

  phase("Sprint");

  for (const contract of contracts) {
    log(`Starting sprint: ${contract.contractId}`);

    // CURATE
    await agent({
      agentType: "bober-curator",
      model: args.models.curator,
    });

    let finalVerdict = null;
    let lensVerdicts = [];
    let iterationsUsed = 0;
    let outcome = "failed";

    // RETRY loop
    for (let iteration = 1; iteration <= args.knobs.maxIterations; iteration++) {
      iterationsUsed = iteration;

      // GENERATE
      await agent({
        agentType: "bober-generator",
        model: args.models.generator,
      });

      // PANEL — chunk evaluatorLenses into groups of ≤16 for parallel fan-out
      lensVerdicts = [];
      const lensGroups = chunk(args.evaluatorLenses, 16);
      for (const group of lensGroups) {
        const groupVerdicts = await parallel(
          group.map((lens) => () =>
            agent({
              agentType: "bober-evaluator",
              model: args.models.evaluator,
              label: lens,
            })
          ),
        );
        lensVerdicts.push(...groupVerdicts);
      }

      // RECONCILE — pass "" as timestamp; host flusher re-stamps on flush
      finalVerdict = reconcile(
        contract.contractId,
        iteration,
        lensVerdicts,
        "",
      );

      if (finalVerdict.passed) {
        outcome = "passed";
        break;
      }

      outcome = decideOutcome(finalVerdict, iteration, args.knobs.maxIterations);
    }

    perSprint.push({
      contract,
      finalVerdict,
      iterationsUsed,
      outcome,
      lensVerdicts,
    });
  }

  return {
    spec,
    perSprint,
    needsClarification: false,
    pendingHistory,
  };
}
