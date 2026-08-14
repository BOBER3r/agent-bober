import { PIPELINE_COMPLETE_EVENT } from "../../orchestrator/finalize.js";
import { appendHistory } from "../../state/history.js";
import type { HistoryEntry } from "../../state/history.js";
import type { Clock } from "../registry/nodes.js";

/**
 * The graph engine's phase-event emitter — sprint 4 of spec-20260814-pge-full-convergence.
 *
 * ── The gap this closes ──
 *
 * `runTsPipeline` appends TEN phase events across `pipeline.ts` (nine of its own, plus the
 * shared terminal `pipeline-complete` from `finalizePipelineRun`); a graph run only ever
 * wrote the shared terminal one. `grep -rn "appendHistory\|history.jsonl" src/pge
 * --include="*.ts"` (non-test) returned ZERO hits before this file — a MISSING WRITER, not a
 * missing place for one (two `role: "curator"` nodes already existed). This module is that
 * writer.
 *
 * ── Why a thin runtime wrapper, and not a `NodeContext` collaborator or a channel ──
 *
 * Three seams were possible; this is the recommended one (design note, sprint-4 briefing
 * section 9):
 *   1. THIS ONE — a plain function imported by node bodies, delegating to the existing
 *      {@link appendHistory}. Emits at the TRUE lifecycle boundary (a node can emit "start"
 *      BEFORE it invokes its effect), needs no topology change and no `NodeServices` edit.
 *   2. A `history` field on `NodeContext`/`NodeServices` — the cleanest injection story, but
 *      `NodeServices` is constructed at seven sites (one production, six fixtures); a
 *      required field means editing all seven for a module two lines of code deep.
 *   3. A `historyEvents` channel flushed at the commit boundary — REJECTED. The commit runs
 *      AFTER every body in the superstep has already returned, so a "start" event written
 *      there would be recorded after the work it announces finished — exactly the
 *      misrepresentation the sprint contract's `evaluatorNotes` warns against, moved from run
 *      scope to superstep scope rather than removed. It would also cost a new
 *      `OverallState` channel, a `graphVersion` bump and a full golden re-capture for the
 *      version stamp alone.
 *
 * `appendHistory` (`src/state/history.ts:81`) is called DIRECTLY — this is sc-4-4's
 * requirement: history emission must not become a second source of truth. No parallel
 * writer, no parallel file, no `historyEvents` channel a reader would have to merge with
 * `history.jsonl`.
 *
 * ── Why not `ctx.effects.invoke` (Pattern C) ──
 *
 * `EffectRegistry.invoke` re-checks the calling node's DECLARED `effects` array against the
 * effect's own tags (`registry/effects.ts:147`). `research_body`, `sprint_curate_explain`
 * and `sprint_review` all declare `effects: []` in the committed artifact; tagging a history
 * effect `fs-write` would fail-close all three and force a topology (and `graphVersion`)
 * change this sprint does not need. A node body may import from `src/state/` — the
 * `src/pge/nodes/**` ESLint boundary forbids process spawners and a short list of layers,
 * not `src/state/` (`nodes/effects.ts:32` already imports from it).
 *
 * ── The clock ──
 *
 * `timestamp` is always `ctx.clock.nowIso()`, never `new Date()` — the runtime's ONLY legal
 * time source inside a node body, so a replayed superstep handed a recorded clock produces
 * the recorded artifact and the golden capture stays reproducible.
 */

/**
 * The nine phase-event names a GRAPH NODE emits. The tenth imperative event,
 * `pipeline-complete`, is unchanged: it is `finalize.ts`'s `PIPELINE_COMPLETE_EVENT`,
 * written once by `finalizePipelineRun` for BOTH engines, and this sprint does not touch it
 * (nonGoal: "changing what the imperative engine writes").
 */
export const HISTORY_EVENT = {
  PIPELINE_START: "pipeline-start",
  PLANNING_COMPLETE: "planning-complete",
  CURATOR_START: "curator-start",
  CURATOR_COMPLETE: "curator-complete",
  GENERATOR_START: "generator-start",
  EVALUATOR_START: "evaluator-start",
  SPRINT_PASSED: "sprint-passed",
  CODE_REVIEW_COMPLETE: "code-review-complete",
  SPRINT_DOCS_COMPLETE: "sprint-docs-complete",
} as const;

export type GraphHistoryEventName = (typeof HISTORY_EVENT)[keyof typeof HISTORY_EVENT];

/**
 * One row of the mapping sc-4-1 asks for: which imperative site writes an event, which graph
 * node emits its equivalent, and at which end of that node's execution.
 *
 * `graphNodeId: null` marks an event with NO graph-side emission by THIS module — today that
 * is exactly one row, `pipeline-complete`, because it already has a shared writer
 * (`finalizePipelineRun`) that this sprint must not touch or duplicate.
 */
export interface HistoryEventMapping {
  readonly event: string;
  readonly imperativeSite: string;
  readonly graphNodeId: string | null;
  readonly graphEmissionPoint: string;
}

/**
 * The full ten-event mapping, in the imperative engine's own emission order — read off
 * `src/orchestrator/pipeline.ts` and `src/orchestrator/finalize.ts` (sc-4-1, recorded BEFORE
 * any node body below was touched — see the sprint-4 commit history: this file and its test
 * land in the commit that precedes every node-emitter change).
 *
 * `history.test.ts` checks this table two ways: that `imperativeSite` names actually occur,
 * in this order, in the real source of `pipeline.ts`/`finalize.ts`; and that every non-null
 * `graphNodeId` is a real node id declared in the committed topology artifact. Both checks
 * fail the moment either side of the mapping stops matching what is on disk.
 */
export const HISTORY_EVENT_NODE_MAP: readonly HistoryEventMapping[] = [
  {
    event: HISTORY_EVENT.PIPELINE_START,
    imperativeSite: "pipeline.ts:798",
    graphNodeId: "research_body",
    graphEmissionPoint: "node begin (the graph's entry node)",
  },
  {
    event: HISTORY_EVENT.PLANNING_COMPLETE,
    imperativeSite: "pipeline.ts:996",
    graphNodeId: "plan_materialize",
    graphEmissionPoint: "node end, after the plan and its contracts are persisted",
  },
  {
    event: HISTORY_EVENT.CURATOR_START,
    imperativeSite: "pipeline.ts:260",
    graphNodeId: "sprint_curate_explain",
    graphEmissionPoint: "node begin",
  },
  {
    event: HISTORY_EVENT.CURATOR_COMPLETE,
    imperativeSite: "pipeline.ts:281",
    graphNodeId: "sprint_curate_explain",
    graphEmissionPoint:
      "after EFFECTS.curatorBrief returns (cache-miss path only — see sprint-curate.ts for the cache-hit rationale)",
  },
  {
    event: HISTORY_EVENT.GENERATOR_START,
    imperativeSite: "pipeline.ts:387",
    graphNodeId: "sprint_generate",
    graphEmissionPoint: "node begin",
  },
  {
    event: HISTORY_EVENT.EVALUATOR_START,
    imperativeSite: "pipeline.ts:461",
    graphNodeId: "sprint_evaluate",
    graphEmissionPoint: "node begin",
  },
  {
    event: HISTORY_EVENT.SPRINT_PASSED,
    imperativeSite: "pipeline.ts:596",
    graphNodeId: "sprint_evaluate",
    graphEmissionPoint: "on the passing return path, before routing to sprint_review",
  },
  {
    event: HISTORY_EVENT.CODE_REVIEW_COMPLETE,
    imperativeSite: "pipeline.ts:636",
    graphNodeId: "sprint_review",
    graphEmissionPoint: "after EFFECTS.reviewerSprint returns",
  },
  {
    event: HISTORY_EVENT.SPRINT_DOCS_COMPLETE,
    imperativeSite: "pipeline.ts:675",
    graphNodeId: "documenter",
    graphEmissionPoint: "after EFFECTS.documenterSummary returns (not on the nothing-to-document early return)",
  },
  {
    // The literal string is deliberately NOT spelled here — `repo-invariants.test.ts` pins
    // `finalize.ts` as the ONE production file allowed to spell it, and importing the
    // constant is what keeps this row honest if that name ever changes.
    event: PIPELINE_COMPLETE_EVENT,
    imperativeSite: "finalize.ts:254",
    graphNodeId: null,
    graphEmissionPoint:
      "ALREADY EMITTED by finalizePipelineRun for both engines — not a node-level emission, and not touched by this sprint",
  },
] as const;

/** The ten events, in order — the ts-engine list `HISTORY_EVENT_NODE_MAP` is checked against. */
export const IMPERATIVE_HISTORY_EVENT_ORDER: readonly string[] = HISTORY_EVENT_NODE_MAP.map(
  (row) => row.event,
);

/**
 * Everything {@link emitPhaseEvent} reads off a node's context — deliberately narrower than
 * the full `NodeContext` a node body is handed, so this module does not import (or depend
 * on) that larger interface, and a unit test can construct one without building the other
 * eighteen collaborators a real node body carries.
 *
 * A real `NodeContext` satisfies this structurally: `projectRoot: string` and
 * `clock: Clock` are exact matches, so every call site below passes `ctx` unchanged.
 */
export interface HistoryEmitContext {
  readonly projectRoot: string;
  readonly clock: Pick<Clock, "nowIso">;
}

/**
 * Emit one phase event from inside a node body, through the SAME `appendHistory` the
 * imperative engine calls (sc-4-4).
 *
 * Stamps `timestamp` from `ctx.clock.nowIso()` — never a wall clock — and delegates
 * everything else to {@link appendHistory}, which validates against `HistoryEntrySchema` and
 * throws (naming the failing Zod path) on a malformed entry.
 */
export async function emitPhaseEvent(
  ctx: HistoryEmitContext,
  entry: Omit<HistoryEntry, "timestamp">,
): Promise<void> {
  const historyEntry: HistoryEntry = {
    timestamp: ctx.clock.nowIso(),
    event: entry.event,
    phase: entry.phase,
    details: entry.details,
    ...(entry.sprintId !== undefined ? { sprintId: entry.sprintId } : {}),
  };
  await appendHistory(ctx.projectRoot, historyEntry);
}
