import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SprintContractSchema } from "../../contracts/sprint-contract.js";
import type { PlanSpec } from "../../contracts/spec.js";
import { isPipelineReady } from "../../contracts/spec.js";
import { createFsCheckpointer } from "../runtime/checkpointer.js";
import { CODING_GRAPH } from "../topology/coding.graph.js";
import {
  clarificationInterrupts,
  compileRegion,
  runRegion,
  seedResearchDigest,
  stubContracts,
  stubDigest,
  stubPlanSpec,
  stubQuestion,
} from "./__fixtures__/region-harness.js";
import type { RegionRun } from "./__fixtures__/region-harness.js";
import type { PlannerRequest } from "./effects.js";
import { PLAN_NODE_IDS } from "./plan.js";
import { PLAN_REGION } from "./regions.js";

/**
 * The plan region: the clarification loop, the suspend-and-resume round trip, and the
 * contracts it materialises.
 *
 * What each test here exists to catch:
 *
 *  - a clarification loop that materialises contracts BEFORE the human has answered, so a
 *    run that pauses for a decision has already written the artifacts the decision was
 *    supposed to shape (sc-11-3). The assertion is the zero-count taken while the run is
 *    still paused, not the presence of contracts afterwards;
 *  - a resume that re-enters the planner WITHOUT the answers, which looks identical to a
 *    working one from the outside because the planner will happily produce a spec either
 *    way (sc-11-3);
 *  - a node body that re-runs across the pause, which is the double-execution class the
 *    before-dispatch interrupt evaluation exists to make impossible (ADR-6);
 *  - a second clarification-question type invented beside the shipped one (nonGoal #3).
 *
 * ── The plan region is a REGION, not a subgraph ──
 *
 * `supervisor.test.ts` pins the artifact's own answer; this file compiles what the
 * artifact declares (`regionSpec(CODING_GRAPH, "plan")`) and never a hand-built graph.
 *
 * ── The checkpoint-id substitution ──
 *
 * `plan_clarify` declares `checkpointId: "plan-clarify"` (`coding.graph.ts:413`), which is
 * NOT one of the nine ids the shipped approval subsystem answers
 * (`src/orchestrator/checkpoints/types.ts:16-26`) — `assertKnownCheckpointId`
 * (`interrupt.ts:454`) throws on it, so the interrupt is unreachable against the artifact
 * as committed. {@link clarificationInterrupts} substitutes the shipped `"post-plan"` id
 * and delegates everything else to the real controller. The substitution is a FIXTURE
 * because neither `coding.graph.ts` (sealed, outside this sprint's `estimatedFiles`) nor
 * `CHECKPOINT_IDS` (the shipped nine-id subsystem) may be changed here; the mismatch is
 * reported as a finding.
 */

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-pge-plan-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const RUN_ID = "run-plan-region";
const ANSWER = "Only its channels; the commit boundary owns the files.";

interface PlannerLog {
  requests: PlannerRequest[];
}

/**
 * Bindings whose planner behaves the way the shipped one is documented to: it emits
 * clarification questions until it has answers, then reports `ready`.
 *
 * It returns THE SAME spec object both times, with the question still open. The answers
 * are folded in by `plan_draft` itself, through the shipped `resolveClarification` — so
 * what this test exercises is the node's use of the existing vocabulary, not a stub that
 * did the resolving on its behalf.
 */
function planBindings(
  log: PlannerLog,
  options: { questions?: boolean; contracts?: (spec: PlanSpec) => ReturnType<typeof stubContracts> } = {},
): Parameters<typeof runRegion>[0]["bindings"] {
  const spec = options.questions === false ? stubPlanSpec() : stubPlanSpec([stubQuestion()]);
  return {
    // Unused by the plan region, but the bindings type is shared across both regions.
    reflect: async () => ({}),
    critique: async () => ({ critique: null }),
    planner: async (userPrompt, projectRoot, _config, researchDoc) => {
      log.requests.push({
        userPrompt,
        projectRoot,
        ...(researchDoc === undefined ? {} : { researchDoc }),
        resolvedClarifications: [],
      });
      return {
        kind: userPrompt.includes(ANSWER) ? ("ready" as const) : ("needs-clarification" as const),
        spec,
      };
    },
    // A materializer that does NOT persist, so `artifactLog.contracts` counts exactly the
    // writes the COMMIT BOUNDARY made. The shipped `materializeContracts` persists as well
    // (`contract-materialization.ts:132`), which would make the count ambiguous.
    materialize: async (planSpec) => (options.contracts ?? stubContracts)(planSpec),
  };
}

function seed(state: Parameters<NonNullable<Parameters<typeof runRegion>[0]["seed"]>>[0]) {
  return seedResearchDigest(root, RUN_ID, state, stubDigest());
}

/** How many `.bober/contracts/` files exist on disk right now. */
async function contractFiles(): Promise<string[]> {
  try {
    return (await readdir(join(root, ".bober", "contracts"))).sort();
  } catch {
    return [];
  }
}

// ── sc-11-7: the plan region compiles and runs ──────────────────────

describe("PLAN REGION: compiles from the committed artifact and runs end to end (sc-11-7)", () => {
  it("compiles the plan region the artifact's own supervisor dispatch reaches", () => {
    const compiled = compileRegion(PLAN_REGION, planBindings({ requests: [] }));
    expect([...compiled.graph.nodes.keys()].sort()).toEqual(
      [
        "gate_plan_in",
        "gate_plan_out",
        "graceful_failure",
        "plan_clarify",
        "plan_clarify_check",
        "plan_draft",
        "plan_materialize",
        CODING_GRAPH.defaults.supervisorNodeId,
      ].sort(),
    );
    // The artifact declares no `plan` subgraph, so the projection declares none either.
    expect([...compiled.graph.subgraphs.keys()]).toEqual([]);
  });

  it("produces the spec and contracts the existing pipeline produces for this phase", async () => {
    const log: PlannerLog = { requests: [] };
    const run = await runRegion({
      projectRoot: root,
      region: PLAN_REGION,
      runId: RUN_ID,
      bindings: planBindings(log, { questions: false }),
      seed,
    });

    expect(run.result.status).toBe("completed");
    expect(run.result.failures).toEqual([]);
    expect(run.finalState.spec).not.toBeNull();
    expect(run.finalState.sprintContracts.length).toBeGreaterThan(0);

    // Written to `.bober/` by the COMMIT BOUNDARY off the channel writes, not by the node.
    expect(run.artifactLog.specs).toEqual([run.finalState.spec?.specId]);
    expect(await contractFiles()).toHaveLength(run.finalState.sprintContracts.length);
    expect(run.handlerLog.calls.graceful_failure).toBeUndefined();
  });

  it("passes the offloaded research digest to the planner as the shipped researchDoc", async () => {
    const log: PlannerLog = { requests: [] };
    await runRegion({
      projectRoot: root,
      region: PLAN_REGION,
      runId: RUN_ID,
      bindings: planBindings(log, { questions: false }),
      seed,
    });
    expect(log.requests[0].researchDoc?.id).toBe(stubDigest().researchId);
  });
});

// ── sc-11-3: the clarification loop ─────────────────────────────────

describe("PLAN CLARIFICATION: suspends, resumes with the answers in the planner's input, and materialises nothing before the loop exits (sc-11-3)", () => {
  async function pause(log: PlannerLog): Promise<RegionRun> {
    return runRegion({
      projectRoot: root,
      region: PLAN_REGION,
      runId: RUN_ID,
      bindings: planBindings(log),
      checkpointer: createFsCheckpointer(root),
      interrupts: clarificationInterrupts(),
      seed,
    });
  }

  it("emits clarification questions and suspends with ZERO contracts materialised", async () => {
    const log: PlannerLog = { requests: [] };
    const paused = await pause(log);

    expect(paused.result.status).toBe("interrupted");
    if (paused.result.status !== "interrupted") return;
    expect(paused.result.pending.nodeId).toBe(PLAN_NODE_IDS.clarify);

    // The claim, taken BEFORE the resume: nothing was materialised while the run waited.
    expect(paused.artifactLog.contracts).toEqual([]);
    expect(paused.artifactLog.specs).toEqual([]);
    expect(await contractFiles()).toEqual([]);
    expect(paused.finalState.sprintContracts).toEqual([]);
    expect(paused.finalState.spec).toBeNull();

    // The node that materialises was never entered, and neither was the paused node: the
    // interrupt is evaluated before dispatch, so nothing ran and nothing can re-run.
    expect(paused.handlerLog.calls[PLAN_NODE_IDS.materialize]).toBeUndefined();
    expect(paused.handlerLog.calls[PLAN_NODE_IDS.clarify]).toBeUndefined();
    expect(paused.handlerLog.calls[PLAN_NODE_IDS.draft]).toBe(1);

    // The planner did surface the questions, in the shipped vocabulary.
    const drafted = (paused.inputLog.inputs[PLAN_NODE_IDS.clarifyCheck] ?? [])[0] as PlanSpec;
    expect(drafted.clarificationQuestions.map((q) => q.questionId)).toEqual([
      stubQuestion().questionId,
    ]);
    expect(isPipelineReady(drafted)).toBe(false);
  });

  it("resumes the same run with the answers present in the planner node's input", async () => {
    const log: PlannerLog = { requests: [] };
    const paused = await pause(log);
    if (paused.result.status !== "interrupted") throw new Error("the run did not suspend");

    const resumed = await runRegion({
      projectRoot: root,
      region: PLAN_REGION,
      runId: RUN_ID,
      bindings: planBindings(log),
      checkpointer: createFsCheckpointer(root),
      interrupts: clarificationInterrupts(),
      resumeFrom: {
        ref: paused.result.checkpointRef,
        value: {
          approved: true,
          editDelta: { answers: [{ questionId: stubQuestion().questionId, answer: ANSWER }] },
        },
      },
    });

    expect(resumed.result.status).toBe("completed");

    // THE criterion: `plan_draft` was re-entered, and the answers were in ITS INPUT.
    const redrafted = (resumed.inputLog.inputs[PLAN_NODE_IDS.draft] ?? [])[0] as PlanSpec;
    expect(redrafted.resolvedClarifications.map((entry) => entry.answer)).toEqual([ANSWER]);
    expect(redrafted.resolvedClarifications[0].questionId).toBe(stubQuestion().questionId);

    // And the answer reached the shipped agent's prompt, which is its only channel for one.
    expect(log.requests.at(-1)?.userPrompt).toContain(ANSWER);

    // Exactly one entry each: the pause did not double-execute anything.
    expect(resumed.handlerLog.calls[PLAN_NODE_IDS.clarify]).toBe(1);
    expect(resumed.handlerLog.calls[PLAN_NODE_IDS.draft]).toBe(1);
  });

  it("materialises contracts only after the loop exits, and they are the shipped SprintContract", async () => {
    const log: PlannerLog = { requests: [] };
    const paused = await pause(log);
    if (paused.result.status !== "interrupted") throw new Error("the run did not suspend");
    expect(await contractFiles()).toEqual([]);

    const resumed = await runRegion({
      projectRoot: root,
      region: PLAN_REGION,
      runId: RUN_ID,
      bindings: planBindings(log),
      checkpointer: createFsCheckpointer(root),
      interrupts: clarificationInterrupts(),
      resumeFrom: {
        ref: paused.result.checkpointRef,
        value: {
          approved: true,
          editDelta: { answers: [{ questionId: stubQuestion().questionId, answer: ANSWER }] },
        },
      },
    });

    expect(resumed.artifactLog.contracts.length).toBeGreaterThan(0);
    expect(await contractFiles()).toHaveLength(resumed.artifactLog.contracts.length);
    for (const contract of resumed.finalState.sprintContracts) {
      expect(() => SprintContractSchema.parse(contract)).not.toThrow();
    }

    // The resolved answer survived into committed state, on the shipped spec shape.
    const spec = resumed.finalState.spec;
    expect(spec?.resolvedClarifications.map((entry) => entry.answer)).toEqual([ANSWER]);
    expect(spec === null ? false : isPipelineReady(spec)).toBe(true);
  });
});
