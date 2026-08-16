// ── conformance.engines.test.ts ─────────────────────────────────────
//
// sc-13-2 — THE CENTRAL CLAIM OF SPRINT 13, and sc-13-3's end-to-end half.
//
// `EngineConformanceHarness` has existed since sprint 4 and has never been pointed at a real
// engine. Here it is: `runnerFor("ts")` runs the shipped `TsPipelineEngine` and
// `runnerFor("pge")` runs the shipped `PgeEngine`, each against its OWN fresh project root
// from `projectRootFactory`, under a FROZEN clock and a FIXED run id, over the single golden
// spec fixture. Both runners return their `PipelineResult`, which is the eleventh field.
//
// ── What is substituted, and why it is substituted IDENTICALLY ──
//
// The two engines reach the outside world through different seams by construction: the
// imperative engine imports the five agent functions directly, and the graph engine reaches
// them through the effect registry the artifact declares. So the substitution is made at
// BOTH seams from ONE set of bodies (`sharedAgents`), and those bodies persist what their
// real counterparts persist. A difference in `.bober/briefings/` is then a fact about the
// engines, because the thing that wrote the briefing was the same function.
//
// Nothing else is replaced: `runTsPipeline` is the real pipeline, the interpreter, commit
// boundary, registries and all forty-four node implementations are the shipped ones, and
// both engines write to real temp directories.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── The two seams, mocked to ONE set of bodies ──────────────────────
//
// `vi.mock` is hoisted, so each factory creates bare `vi.fn()`s and `beforeEach` binds them
// to the shared bodies once a project root exists.

vi.mock("../research-agent.js", () => ({ runResearch: vi.fn() }));
vi.mock("../planner-agent.js", () => ({ runPlanner: vi.fn() }));
vi.mock("../contract-materialization.js", () => ({ materializeContracts: vi.fn() }));
vi.mock("../curator-agent.js", () => ({ runCurator: vi.fn() }));
vi.mock("../generator-agent.js", () => ({ runGenerator: vi.fn() }));
vi.mock("../evaluator-agent.js", () => ({ runEvaluatorAgent: vi.fn() }));
vi.mock("../code-reviewer-agent.js", () => ({ runCodeReviewer: vi.fn() }));
vi.mock("../documenter-agent.js", () => ({ runDocumenter: vi.fn() }));
vi.mock("../../utils/git.js", () => ({
  commitAll: vi.fn(() => Promise.resolve("0000000")),
  getCurrentBranch: vi.fn(() => Promise.resolve("bober/conformance")),
  getChangedFiles: vi.fn(() => Promise.resolve(["src/example.ts"])),
}));
vi.mock("../../graph/pipeline-lifecycle.js", () => ({
  graphPipelineLifecycle: {
    backendHealth: vi.fn().mockReturnValue("disabled"),
    getGraphClient: vi.fn().mockReturnValue(null),
    getGraphDeps: vi.fn().mockReturnValue(null),
  },
}));

import { runPlanner } from "../planner-agent.js";
import { materializeContracts } from "../contract-materialization.js";
import { runCurator } from "../curator-agent.js";
import { runGenerator } from "../generator-agent.js";
import { runEvaluatorAgent } from "../evaluator-agent.js";
import { runCodeReviewer } from "../code-reviewer-agent.js";
import { runDocumenter } from "../documenter-agent.js";
import type { PipelineResult } from "../pipeline.js";
import { getAuditPath } from "../checkpoints/audit.js";
import type { ApprovalRecord } from "../checkpoints/audit.js";
import { PIPELINE_COMPLETE_EVENT } from "../finalize.js";
import { loadHistory } from "../../state/history.js";
import { listContracts } from "../../state/sprint-state.js";
import { CompletionTailer } from "../../chat/completion-tailer.js";
import { PgeEngine } from "../../pge/engine/pge-engine.js";
import {
  CODING_GRAPH_ID,
  GOLDEN_SPEC_ID,
  conformanceConfig,
  seedCommittedArtifact,
  sharedAgents,
  wholeGraphBindings,
} from "../../pge/engine/__fixtures__/whole-graph.js";
import type { BoberConfig } from "../../config/schema.js";
import { withGoldenApproval } from "../../pge/golden/executor.js";
import {
  ARCHITECTURALLY_ACCEPTED_DIVERGENCES,
  EngineConformanceHarness,
  canonical,
  emptyOnAllEnginesFields,
  equivalentModuloAcceptedDivergences,
  fullyPopulatedFields,
} from "./conformance.js";
import type { EngineRunner } from "./conformance.js";
import type { PipelineEngineName } from "./engine.js";
import { TsPipelineEngine } from "./ts-engine.js";
import { CONFORMANCE_FIELDS } from "./types.js";
import type { ConformanceField, ConformanceReport } from "./types.js";

// ── Determinism ─────────────────────────────────────────────────────

/** The instant both engines run at. Frozen, so no artifact can differ by a timestamp. */
const FROZEN_ISO = "2026-08-05T00:00:00.000Z";
/** The run id both engines are given, so neither derives one from the clock. */
const RUN_ID = "run-conformance";
const PROMPT = "Wire the graph engine behind the private seam.";

let tmpRoots: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(FROZEN_ISO));
  tmpRoots = [];
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tmpRoots.map((r) => rm(r, { recursive: true, force: true })));
  tmpRoots = [];
});

afterAll(() => {
  vi.restoreAllMocks();
});

/** A FRESH root per engine, each carrying the committed artifact and its prompt store. */
async function projectRootFactory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bober-conformance-"));
  tmpRoots.push(dir);
  await seedCommittedArtifact(dir);
  return dir;
}

/**
 * Bind the imperative engine's five agent seams to the shared bodies for `projectRoot`.
 *
 * Re-bound per root because the bodies persist into the root they were built for — the same
 * reason `wholeGraphBindings` takes the run's own `projectRoot`.
 */
function bindTsAgents(projectRoot: string): void {
  const agents = sharedAgents(projectRoot);
  vi.mocked(runPlanner).mockImplementation(() => agents.planner());
  vi.mocked(materializeContracts).mockImplementation(() => agents.materialize());
  vi.mocked(runCurator).mockImplementation((contract) => agents.curator(contract));
  vi.mocked(runGenerator).mockImplementation((handoff) =>
    agents.generator(handoff.currentContract?.contractId ?? "unknown"),
  );
  vi.mocked(runEvaluatorAgent).mockImplementation((handoff) =>
    agents.evaluator(handoff.currentContract),
  );
  vi.mocked(runCodeReviewer).mockImplementation((contract) => agents.reviewer(contract));
  vi.mocked(runDocumenter).mockImplementation((contract, evaluation, generatorResult, root) =>
    agents.documenter(contract, evaluation, generatorResult, root),
  );
}

/** The runner for each engine — the SHIPPED engine class, unadapted. */
function runnerFor(engine: PipelineEngineName): EngineRunner {
  const config = conformanceConfig();
  if (engine === "pge") {
    return async (projectRoot: string): Promise<PipelineResult> =>
      new PgeEngine({
        graphId: CODING_GRAPH_ID,
        bindings: (input) => wholeGraphBindings(input),
      }).run(PROMPT, projectRoot, config, { runId: RUN_ID });
  }
  return async (projectRoot: string): Promise<PipelineResult> => {
    bindTsAgents(projectRoot);
    return new TsPipelineEngine().run(PROMPT, projectRoot, config, { runId: RUN_ID });
  };
}

/**
 * Every `ApprovalRecord` one run wrote, in write order.
 *
 * Read at `getAuditPath` — the path the shipped writer publishes — rather than by scanning
 * the directory, because both engines run under the same fixed {@link RUN_ID} and the
 * question this answers is "what did THIS run record", in the order it recorded it.
 */
async function readAuditRecords(projectRoot: string): Promise<ApprovalRecord[]> {
  let text: string;
  try {
    text = await readFile(getAuditPath(projectRoot, RUN_ID), "utf-8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ApprovalRecord);
}

async function compare(): Promise<ConformanceReport> {
  return new EngineConformanceHarness().assertEquivalent(
    GOLDEN_SPEC_ID,
    ["ts", "pge"],
    projectRootFactory,
    runnerFor,
  );
}

// ── The eleven fields, and the population gate ──────────────────────

/**
 * The fields NEITHER engine writes, and why — asserted exactly, so a field that silently
 * stopped being written fails here instead of quietly joining the list.
 *
 *  - `runState` (`.bober/runs/<runId>/state.json`) has no writer in either engine. It is
 *    written by the CHAT layer (`src/chat/run-spawner.ts`, `src/chat/chat-session.ts`)
 *    around a spawned run, and a `PipelineEngine.run` never produces one.
 *  - `progress` (`.bober/progress.generated.md`) is written by `updateProgress`, which has
 *    no call site in `runTsPipeline` and none in the graph runtime. Its only caller is
 *    `RunResultFlusher.flush`, reachable solely through `WorkflowEngine` — which
 *    `selectPipelineEngine` never constructs while `isWorkflowEligible` returns a
 *    hardcoded `false`. The skill pipeline's curated `.bober/progress.md` is a DIFFERENT
 *    file with a different writer and is not an engine artifact at all.
 *
 * Both are recorded as KNOWN-EMPTY rather than counted as matches: `emptyOnAllEnginesFields`
 * exists precisely so an equivalence cannot rest on two absences.
 */
const KNOWN_EMPTY: ConformanceField[] = ["progress", "runState"];

describe("EngineConformanceHarness against the REAL engines (sc-13-2)", () => {
  it("compares two real engine runs, each on its own fresh root, and reports every field", async () => {
    const report = await compare();

    // The comparison happened over eleven fields, and it was not vacuous.
    expect(report.fields.map((f) => f.field).sort()).toEqual([...CONFORMANCE_FIELDS].sort());
    expect(report.fields).toHaveLength(11);
    expect(report.vacuous).toBe(false);

    // ── THE POPULATION GATE ──
    //
    // "Equivalent because both engines wrote nothing" is the one way this test could pass
    // while proving nothing, so every field is accounted for: nine are populated on BOTH
    // sides, and the two that are populated on neither are named above with the reason.
    expect(emptyOnAllEnginesFields(report).sort()).toEqual([...KNOWN_EMPTY].sort());
    const populated = fullyPopulatedFields(report).sort();
    expect(populated).toEqual(
      CONFORMANCE_FIELDS.filter((field) => !KNOWN_EMPTY.includes(field)).sort(),
    );
    expect(populated).toHaveLength(9);

    // And populated means non-empty for EACH engine, counted, not merely flagged.
    for (const entry of report.fields) {
      if (KNOWN_EMPTY.includes(entry.field)) {
        expect(entry.counts.ts, `${entry.field} on ts`).toBe(0);
        expect(entry.counts.pge, `${entry.field} on pge`).toBe(0);
        continue;
      }
      expect(entry.counts.ts, `${entry.field} on ts`).toBeGreaterThan(0);
      expect(entry.counts.pge, `${entry.field} on pge`).toBeGreaterThan(0);
    }
  }, 60_000);

  it("reports every divergence as a STRUCTURED ConformanceDiff naming artifact, path and engines", async () => {
    const report = await compare();

    for (const diff of report.diffs) {
      expect(diff.engines).toEqual(["ts", "pge"]);
      expect(diff.artifact.length).toBeGreaterThan(0);
      expect(diff.path.length).toBeGreaterThan(0);
      expect(diff.field.length).toBeGreaterThan(0);
      expect(diff.detail.length).toBeGreaterThan(0);
      expect(CONFORMANCE_FIELDS).toContain(diff.field);
    }

    // ── THE RECORDED DIVERGENCE SET ──
    //
    // Pinned EXACTLY: not asserted to be empty, and not asserted merely to be non-empty. The
    // sprint contract's fourth stop condition pre-authorises this outcome — "pge ships as a
    // permanently opt-in engine, the default stays 'ts', nothing is deleted, and the
    // divergences are recorded rather than papered over" — and a pinned set is what
    // "recorded" means operationally: a NEW divergence fails this test, and a divergence that
    // gets FIXED fails it too, so neither can happen silently. Not one volatile key was added
    // to make this list shorter.
    //
    // WHICH fields diverge is pinned here. WHAT each divergence IS — the checkpoint ids, the
    // contract fields, the offending status value — is pinned in "records what each
    // divergence IS" below, from the artifacts of the same two runs. Prose in a comment is
    // not a record; that test is, and it is what keeps the paragraphs under it honest.
    //
    // `history` CLOSED at sprint 4 of `spec-20260814-pge-full-convergence` and is no longer
    // one of the three below. What used to be true, and is recorded here so the closure has
    // a before-and-after: the imperative engine appended TEN phase events from
    // `runTsPipeline` itself (`pipeline-start` … `sprint-docs-complete`), then the shared
    // `pipeline-complete`, while a graph run's history had exactly ONE writer,
    // `finalizePipelineRun` — `grep -rn "appendHistory\|history.jsonl" src/pge
    // --include="*.ts"` (non-test) returned ZERO hits. That was a MISSING WRITER, not a
    // missing place for one: the topology already declared TWO `role: "curator"` nodes
    // (`sprint_curate_explain`, `coding.graph.ts:576`; `sprint_curate_mocks`, `:592`), so the
    // prior disposition's "no curator node to emit a history write" premise was FALSE — a
    // correction recorded at commit `e48962e` (2026-08-14), before this sprint. Sprint 4
    // closed the actual gap: `src/pge/runtime/history.ts` exports `emitPhaseEvent`, a thin
    // wrapper that delegates to the SAME `appendHistory` the imperative engine calls (no
    // parallel writer, no parallel file — sc-4-4), and nine graph nodes now call it at the
    // node's real lifecycle boundary — `research_body` (entry, `pipeline-start`),
    // `plan_materialize` (after persisting, `planning-complete`), `sprint_curate_explain`
    // (before/after `curator.brief`, `curator-start`/`curator-complete` — the latter only on
    // a cache MISS, since a cache HIT never fetches the `SprintBriefing` the three counts
    // come from), `sprint_generate` (entry, `generator-start`), `sprint_evaluate` (entry,
    // `evaluator-start`; on the passing return path, `sprint-passed`, carrying the RAW
    // `result.summary` rather than the decorated `evaluations`-channel copy),
    // `sprint_review` (after `reviewer.sprint`, `code-review-complete`) and `documenter`
    // (after `documenter.summary`, `sprint-docs-complete` — never on the
    // nothing-to-document early return). The tenth event, `pipeline-complete`, is untouched:
    // it was already shared (`finalizePipelineRun`, both engines) and sc-4's nonGoals forbid
    // moving it. `iteration` (events 5-7) is neither `sprint-evaluate.ts`'s `iterationOf` nor
    // the shared `sprintIterations` loop counter — both were tried against a REAL golden
    // capture and both produced a wrong number; see `src/pge/nodes/gates.ts`'s
    // `generateAttemptsSoFar` doc comment for the full account of why, and what does work.
    // The three-events-versus-one shape asserted below, in "1. history", is now the
    // CONVERGENCE itself: the pge list equals the ts list, not merely has the same length.
    //
    // The two still-diverged fields, with what each one IS and why it does not close:
    //
    //  - `audits`: NOT a duplicated checkpoint id, and — since
    //    `spec-20260814-pge-full-convergence` sprint 3 — no longer a single declared id
    //    either. The imperative pipeline records EIGHT checkpoints under eight distinct
    //    ids; the graph now records FOUR, under TWO distinct ids: `post-sprint-contract`
    //    once, FIRST, and `end-of-pipeline` three times. Sprint 3 declared
    //    `post-sprint-contract` on `gate_plan_out` (`coding.graph.ts:513-526`) — the
    //    effect-free gate that fires immediately after `plan_materialize` persists the
    //    same `contracts` payload the imperative pipeline's own `post-sprint-contract`
    //    checkpoint answers (`pipeline.ts:1017-1025`), which is why the new record
    //    precedes every other one. `plan_materialize` could not host it instead: it
    //    declares `effects: ["fs-write"]`, which trips `EffectfulNodeContainsHitl`.
    //    `post-plan` remains declared too (`coding.graph.ts:484`, since 1.2.0), reachable
    //    only through the conditional edge `e-plan-clarify` (label `clarify`) that a
    //    settled plan never takes — the only DECLARED checkpoint id THIS FIXTURE never
    //    evaluates, not the only one the artifact declares. The three `end-of-pipeline`
    //    records are exactly as before sprint 3: two come from the artifact's
    //    `hitl_commit` gate and one from `finalizePipelineRun`. The middle one is still an
    //    `outcome: "rejected"` FAIL_CLOSED record: under autopilot the gate mechanism is
    //    `noop`, a `noop` mechanism deliberately GRANTS nothing (`runtime/interrupt.ts`),
    //    so the `git`-effect `commit` node is refused and never executed — sc-12-9's
    //    shipped behaviour, pinned by `nodes/commit.test.ts` and
    //    `topology-invariants.test.ts`, and left standing by sprint 3's nonGoal 2 (no
    //    reclassifying a refusal to make the trail match). Sprint 2's durable approval
    //    (`goldenApprovedConfig`) does not reach it either: that config lives only in the
    //    golden dataset, never in `conformanceConfig()` below, which is the shipped
    //    autopilot path this harness deliberately measures — see the assertion below this
    //    comment for the fact, run rather than assumed. Of the six checkpoint ids still
    //    absent from this trail, FIVE (`pre-curator`, `pre-generator`, `pre-evaluator`,
    //    `pre-code-reviewer`, `post-sprint`) sit inside the sprint fan-out region, where
    //    `InterruptInsideFanOut` (`topology/validate.ts:1089-1099`) is a BLOCKING
    //    validation error (`severity: "error"`) — originally by ADR-6
    //    (`.bober/architecture/arch-20260805-pge-graph-engineering-adr-6.md`), and
    //    REVISITED AND UPHELD by `spec-20260814-pge-full-convergence` sprint 1
    //    (`.bober/architecture/arch-20260814-pge-full-convergence-adr-1.md`):
    //    `Checkpoint.interrupt` holds one pending interrupt, `grantScope`/`clearScope` are
    //    branch-blind so a sibling branch evicts a prior branch's grant, and
    //    `resumeMessageId` collapses every branch's decision onto one message row — a
    //    per-branch interrupt is unsound, not merely unrevisited. They cannot be declared
    //    in the topology AT ALL, not merely "this sprint may not edit them" — pinned by
    //    the assertion below. The sixth, `post-plan`, is already declared and simply does
    //    not fire on this fixture. `audits` therefore STAYS in the divergence set,
    //    recorded — per the spec's amended feat-3 AC2 — as RECOMMENDED FOR PERMANENT
    //    ACCEPTANCE, on architectural grounds this closure paragraph does not touch — unlike
    //    `history` above, which was open work rather than architecturally barred, and is now
    //    closed.
    //  - `pipelineResult`: NOT the same delta it carried before sprint 6, and narrower than
    //    it looks from the field name alone — the CONTAINER portion is now fully closed and
    //    a genuinely SEPARATE, independent field is what keeps this name in the set.
    //    `PipelineResult.completedSprints`/`failedSprints` carry whole `SprintContract`
    //    objects — the identical object each engine's own `run()` returned, which is the
    //    identical object `listContracts` reads back off disk (`pipeline.ts:1053`/`:594` on
    //    the ts side; `commit.finalize` on the pge side) — so THAT portion of this field
    //    reduces exactly to the `contracts` divergence, and CLOSED when `contracts` closed
    //    below (verified in "4. pipelineResult", both engines' container checked against
    //    their own contract, not merely the pge side as before sprint 6). What remains is
    //    `PipelineFailure`, the `errors?: readonly PipelineFailure[]` key
    //    (`pipeline.ts`'s `PipelineResult` doc comment) — populated ONLY by `PgeEngine.run`,
    //    from the interpreter's own `TaskFailure` records
    //    (`pge/engine/pge-engine.ts:551-572`), and on THIS fixture always non-empty: the
    //    SAME FAIL_CLOSED `commit`-node refusal recorded in "2b. THE MATERIAL FACT" above
    //    surfaces here too, as `{nodeId: "commit", errorClass: "FailClosed", ...}`. The
    //    imperative engine has no equivalent SOURCE, not merely a missing write: `runTsPipeline`
    //    has no interpreter and no `TaskFailure` concept at all, and its own auto-commit
    //    (`commitAll`, unconditional when `config.generator.autoCommit` is true) is not gated
    //    behind any HITL checkpoint the way the graph's `git`-effect `commit` node is — there
    //    is no refusal for it to ever report. Synthesising an `errors` entry for the
    //    imperative engine would misrepresent an event that never happens there, the same
    //    class of dishonesty this sprint's own stop condition forbids for `version` — so
    //    `pipelineResult` stays in the divergence set for `errors` alone, ARCHITECTURAL in
    //    the same sense `audits` is (a real capability gap, not an unclosed TODO), and is
    //    recorded rather than papered over. Closing it — either by giving the imperative
    //    engine an equivalent checkpoint-gated commit step (a real behaviour change, not
    //    this sprint's business) or by joining `audits` as a permanently-accepted divergence
    //    — is a decision for a future sprint, not a silent default here.
    //
    // `contracts` CLOSED at sprint 6 of `spec-20260814-pge-full-convergence` and is no
    // longer in the set above. What used to be true, recorded here so the closure has a
    // before-and-after, same as `history`'s: the last delta was ONE field on the one
    // contract — `version` alone — down from THREE before sprint 5 of
    // `spec-20260814-pge-full-convergence` (and from FOUR before sprint 5 of
    // `spec-20260812-terminal-vocabulary`). `status` and `evaluatorFeedback`/`generatorNotes`
    // were already closed by sprint 5 (see that sprint's write-up for the account). `version`
    // itself was a MISSING WRITER, the same shape as `history`'s gap: `sprint_exit` has
    // written `version: attempts` — a count of non-`skipped` `evaluations` entries, floored
    // at 1 — since sprint 3 of `spec-20260812-terminal-vocabulary`
    // (`src/pge/nodes/sprint-review.ts:260-265,282-287`), and `runSprintCycle` wrote none at
    // all. Sprint 6 closed the gap by giving `runSprintCycle` its OWN count of the same
    // shape: `settledAttempts` (`pipeline.ts`), incremented once per round that reaches a
    // decisive verdict (the evaluator ran), written as `Math.max(1, settledAttempts)` at all
    // four of the function's settle sites, BEFORE the `updateContract` call at each — never a
    // shared write site with the graph engine, never a clock, an ordering or a superstep
    // (disqualified for exactly those reasons at
    // `docs/sprints/sprint-spec-20260812-terminal-vocabulary-3.md:27-80`). A
    // generator-failure round does NOT increment it, mirroring `gate_syntax`'s "without
    // spending an evaluation" retry (`coding.graph.ts:642`) — pinned by `pipeline.test.ts`'s
    // dedicated `describe` for this. `version` is deliberately NOT one of `VOLATILE_KEYS`
    // (`conformance.ts:65-76`; unchanged by this sprint — sc-6-4): it is a real convergence,
    // not a field excluded from comparison. Asserted below (Pattern B, `toBeDefined()` on
    // both sides first) and by the whole-object `canonical(pgeContract) ===
    // canonical(tsContract)` with NOTHING stripped.
    //
    // Everything else — specs, evalResults, briefings, reviews, completionMarker — is
    // IDENTICAL across the two engines, which is the positive half of the claim and is
    // asserted two tests below.
    expect([...new Set(report.diffs.map((diff) => diff.field))].sort()).toEqual([
      "audits",
      "pipelineResult",
    ]);
    expect(report.equivalent).toBe(false);
  }, 60_000);

  // ── sc-11-1 (amended): what `equivalent: true` becomes once every non-architectural
  // divergence has closed ─────────────────────────────────────────────
  //
  // The contract's literal sc-11-1 text — "the harness reports equivalent: true on a real
  // run" — is UNSATISFIABLE BY BUILDING: `audits` and `pipelineResult` are both
  // architectural (see `ARCHITECTURALLY_ACCEPTED_DIVERGENCES`'s doc comment for the
  // source-grounded reason each one is), so `report.equivalent` stays `false` forever under
  // the bar's current wording — asserted explicitly below, so this test would fail loudly
  // the day it stopped being true rather than silently going stale. The amendment (this
  // sprint's contract, `amendment.sc-11-1.amendedTo`) replaces that unreachable claim with
  // one that IS reachable and IS met: the divergence set the harness reports on a REAL run
  // is EXACTLY the accepted, individually-justified set — no unaccepted divergence, and
  // neither accepted divergence missing. `equivalentModuloAcceptedDivergences` is that
  // amended claim, made a function rather than left as a sentence in a doc; this is a real
  // run of both engines, the same `compare()` every other test here uses, not a synthetic
  // report standing in for one.
  it("sc-11-1: the amended bar is MET on a real run — every remaining divergence is exactly the architectural set, named with a reason", async () => {
    const report = await compare();

    // The literal, unamended claim: still unreached, and recorded as such rather than
    // quietly stopped asserting.
    expect(report.equivalent).toBe(false);

    // The amended claim: met. Not vacuous, and the two fields the report actually diverges
    // on are exactly the two this sprint's amendment names as architectural.
    expect(equivalentModuloAcceptedDivergences(report)).toBe(true);
    expect(Object.keys(ARCHITECTURALLY_ACCEPTED_DIVERGENCES).sort()).toEqual([
      "audits",
      "pipelineResult",
    ]);
    // Every accepted field carries a non-empty, source-grounded reason — "recorded" per
    // sc-11-1's amended text means more than an empty string in a set.
    for (const field of Object.keys(ARCHITECTURALLY_ACCEPTED_DIVERGENCES)) {
      const reason = ARCHITECTURALLY_ACCEPTED_DIVERGENCES[field as ConformanceField];
      expect(reason?.length, `${field}'s recorded reason`).toBeGreaterThan(20);
    }
  }, 60_000);

  // ── sc-11-2 (amended): the amended assertion fails in BOTH directions ──
  //
  // Synthetic, hand-built `ConformanceReport` values against the EXPORTED function itself —
  // the `coverage.test.ts:311-354` idiom this file's own "sc-4-3/sc-6-3" block below already
  // follows for the unamended pin. Two directions, both distinct from what that older test
  // already covers (which is the raw field-name array, not this function):
  //
  //  1. A NEW, unaccepted divergence appearing (e.g. a regression, or a genuinely new gap)
  //     must flip the amended claim to `false` — the same as it always would for
  //     `report.equivalent`.
  //  2. A SILENTLY-RELAXED comparison — one of the two accepted, real divergences dropping
  //     out of `report.diffs` without the underlying architectural gap actually closing —
  //     must ALSO flip it to `false`. This is the direction a naive re-specification would
  //     miss: "fewer diffs than expected" reads as progress unless the bar specifically
  //     checks that the diffs it DOES expect are still there.
  it("sc-11-2: fails when a new divergence appears, and fails when one of the two architectural divergences silently stops being reported", () => {
    const diffFor = (field: ConformanceField): ConformanceReport["diffs"][number] => ({
      artifact: "audit",
      path: `.bober/${field}/`,
      engines: ["ts", "pge"],
      field,
    });
    const baseline: ConformanceReport = {
      equivalent: false,
      vacuous: false,
      fields: [],
      diffs: [diffFor("audits"), diffFor("pipelineResult")],
    };

    // Sanity: the exact accepted set, as a baseline, reads TRUE — the assertion above this
    // one already proves this against a real run, so this proves the synthetic baseline
    // agrees with reality's own shape before mutating it.
    expect(equivalentModuloAcceptedDivergences(baseline)).toBe(true);

    // Direction 1: a genuinely NEW divergence (a closed field regressing, or a fresh gap)
    // joins the two accepted ones.
    const withNewDivergence: ConformanceReport = {
      ...baseline,
      diffs: [...baseline.diffs, diffFor("history")],
    };
    expect(equivalentModuloAcceptedDivergences(withNewDivergence)).toBe(false);

    // Direction 2a: ONE of the two accepted divergences silently stops being reported — a
    // comparison bug that under-reports, not a real convergence.
    const missingOne: ConformanceReport = { ...baseline, diffs: [diffFor("audits")] };
    expect(equivalentModuloAcceptedDivergences(missingOne)).toBe(false);

    // Direction 2b: BOTH accepted divergences vanish. This is the genuine, literal
    // `equivalent: true` this amended bar deliberately does NOT claim to have reached —
    // `report.equivalent` is the assertion for that claim, and it stays pinned `false`
    // above. A function that returned `true` here would be the exact "adjust the
    // comparison to reach it" the contract's stop condition forbids.
    expect(equivalentModuloAcceptedDivergences({ ...baseline, diffs: [] })).toBe(false);

    // A vacuous report can never pass either, for the same reason `report.equivalent` never
    // allows it: an empty comparison proves nothing about either engine.
    expect(equivalentModuloAcceptedDivergences({ ...baseline, diffs: [], vacuous: true })).toBe(
      false,
    );
  });

  // ── The two comparison-integrity holes the post-spec security audit found ──
  //
  // Neither was exploitable when it was found — the sole diff producer
  // (`EngineConformanceHarness.assertEquivalent`) names a `field` on every diff it emits,
  // and only `ts` and `pge` are ever compared, so there is exactly one engine pair. Both
  // are nonetheless the exact class of hole this predicate exists to close: a divergence
  // that is REPORTED but not COUNTED by the bar. They are pinned here rather than left to
  // the current producer's good behaviour, in the same synthetic idiom as `sc-11-2` above.

  it("a diff that names no field is treated as an UNACCEPTED divergence, not as an absent one", () => {
    const diffFor = (field: ConformanceField): ConformanceReport["diffs"][number] => ({
      artifact: "audit",
      path: `.bober/${field}/`,
      engines: ["ts", "pge"],
      field,
    });

    // `ConformanceDiff.field` is REQUIRED as of this change, which is the structural half
    // of the fix — every in-repo producer is type-checked into naming one. The cast is the
    // point of this test: it stands in for a producer that reached the predicate from
    // outside the type system (a JavaScript caller, a report round-tripped through JSON, a
    // cast exactly like this one), which is the only remaining way a field-less diff can
    // arrive. The bar must not trust the type it is checking.
    const fieldless = {
      artifact: "audit",
      path: ".bober/somewhere/",
      engines: ["ts", "pge"],
    } as unknown as ConformanceReport["diffs"][number];

    const baseline: ConformanceReport = {
      equivalent: false,
      vacuous: false,
      fields: [],
      diffs: [diffFor("audits"), diffFor("pipelineResult")],
    };
    expect(equivalentModuloAcceptedDivergences(baseline)).toBe(true);

    // The whole defect, in one report: it carries THREE divergences, and
    // `report.equivalent`'s own formula (`diffs.length === 0 && !vacuous`) counts every
    // one of them. A bar that DISCARDED the field-less diff would call this report
    // equivalent-modulo-accepted while an unaccepted divergence sat in the same report —
    // the two claims disagreeing, with the narrower one the more permissive.
    const withFieldless: ConformanceReport = {
      ...baseline,
      diffs: [...baseline.diffs, fieldless],
    };
    expect(withFieldless.diffs).toHaveLength(3);
    expect(withFieldless.diffs.length === 0 && !withFieldless.vacuous).toBe(false);
    expect(equivalentModuloAcceptedDivergences(withFieldless)).toBe(false);

    // Same rule for a field that is PRESENT but is not one of the eleven known fields —
    // an unrecognised divergence is unaccepted for the same reason an unnamed one is.
    const unknownField = {
      ...fieldless,
      field: "somethingNew",
    } as unknown as ConformanceReport["diffs"][number];
    expect(
      equivalentModuloAcceptedDivergences({
        ...baseline,
        diffs: [...baseline.diffs, unknownField],
      }),
    ).toBe(false);

    // And it is not merely that a THIRD diff fails: a field-less diff standing in for one
    // of the two accepted ones fails too, because it proves nothing about which field
    // diverged.
    expect(
      equivalentModuloAcceptedDivergences({
        ...baseline,
        diffs: [diffFor("audits"), fieldless],
      }),
    ).toBe(false);
  });

  it("refuses a report whose diffs span more than one engine pair, rather than judging their union", () => {
    const diffFor = (
      field: ConformanceField,
      engines: ConformanceReport["diffs"][number]["engines"],
    ): ConformanceReport["diffs"][number] => ({
      artifact: "audit",
      path: `.bober/${field}/`,
      engines,
      field,
    });

    // One pair, exactly the accepted set — today's real shape, and the only shape this
    // bar is defined for.
    const onePair: ConformanceReport = {
      equivalent: false,
      vacuous: false,
      fields: [],
      diffs: [diffFor("audits", ["ts", "pge"]), diffFor("pipelineResult", ["ts", "pge"])],
    };
    expect(equivalentModuloAcceptedDivergences(onePair)).toBe(true);

    // The pair is UNORDERED — `[ts, pge]` and `[pge, ts]` are the same comparison, and
    // must not read as two pairs.
    expect(
      equivalentModuloAcceptedDivergences({
        ...onePair,
        diffs: [diffFor("audits", ["pge", "ts"]), diffFor("pipelineResult", ["ts", "pge"])],
      }),
    ).toBe(true);

    // The defect: with a third engine, each pair diverges on only ONE accepted field, so
    // NEITHER pair meets the bar — but the flattened union of their fields is exactly the
    // accepted set. A union-based bar calls this equivalent.
    const twoPairs: ConformanceReport = {
      ...onePair,
      diffs: [
        diffFor("audits", ["ts", "pge"]),
        diffFor("pipelineResult", ["ts", "workflow"]),
      ],
    };
    expect([...new Set(twoPairs.diffs.map((diff) => diff.field))].sort()).toEqual([
      "audits",
      "pipelineResult",
    ]);
    expect(equivalentModuloAcceptedDivergences(twoPairs)).toBe(false);

    // Even a report where one pair DOES meet the bar on its own is refused while a second
    // pair is present: the bar answers about one comparison, so it declines the question
    // rather than picking a pair.
    expect(
      equivalentModuloAcceptedDivergences({
        ...onePair,
        diffs: [...onePair.diffs, diffFor("audits", ["ts", "workflow"])],
      }),
    ).toBe(false);
  });

  // ── sc-4-3/sc-6-3: the divergence-set pin fails in BOTH directions ────
  //
  // A pure-function control over the SAME transform the pin above applies
  // (`[...new Set(diffs.map((diff) => diff.field))].sort()`), in the
  // `coverage.test.ts:311-354` idiom: proven against synthetic input rather than being
  // hostage to whichever divergences the real dataset happens to produce today. Two
  // directions, both checked: `history` or `contracts` re-appearing (regressions sprints 4
  // and 6 exist to prevent) and one of the two remaining fields silently vanishing (a false
  // "it converged" this harness exists to catch) must BOTH fail the committed pin.
  it("the committed divergence-set pin fails if a closed field re-appears, and fails if `audits` or `pipelineResult` silently disappears", () => {
    const uniqueSortedFields = (diffs: readonly { field: string }[]): string[] =>
      [...new Set(diffs.map((diff) => diff.field))].sort();
    const committedPin = ["audits", "pipelineResult"];

    // The committed pin, unchanged — sanity check that the transform agrees with itself.
    expect(uniqueSortedFields([{ field: "audits" }, { field: "pipelineResult" }])).toEqual(
      committedPin,
    );

    // Direction 1: a CLOSED field re-diverging must NOT silently match the committed pin —
    // `history` (sprint 4) and `contracts` (sprint 6).
    for (const regressed of ["history", "contracts"] as const) {
      const withRegression = uniqueSortedFields([
        { field: "audits" },
        { field: "pipelineResult" },
        { field: regressed },
      ]);
      expect(withRegression, `${regressed} re-appearing must not match the committed pin`).not.toEqual(committedPin);
    }

    // Direction 2: either remaining field silently closing must NOT match the committed pin
    // either — an evaluator that only checked "nothing new appeared" would pass on this too.
    // `audits` is permanently accepted (ADR-1); `pipelineResult` diverges on `errors` alone
    // (sprint 6, an architectural gap, not a TODO) — `equivalent: true` on either would be a
    // false convergence.
    expect(uniqueSortedFields([{ field: "pipelineResult" }])).not.toEqual(committedPin);
    expect(uniqueSortedFields([{ field: "audits" }])).not.toEqual(committedPin);
  });

  // ── HISTORICAL control (sc-5-4, superseded by sc-6-3) — retained deliberately ──
  //
  // Before sprint 6, the real-run assertion below isolated `contracts`'s claim by stripping
  // `version` from both sides before comparing (sprint 5's `sc-5-4`: "the delta is `version`
  // ALONE"). Sprint 6 closed `version` itself, so the real-run assertion no longer strips
  // anything — it compares the two contracts WHOLE (`canonical(pgeContract) ===
  // canonical(tsContract)`, sc-6-3). This test is kept rather than deleted (the house rule
  // this file follows for a closed divergence — see `history`'s treatment above) as a
  // synthetic proof, over hand-built input in the `coverage.test.ts:311-354` idiom, that the
  // stripping transform sprint 5 relied on behaved correctly in isolation: `version` alone
  // does NOT count as a divergence once stripped (direction 1), and a REAL field differing
  // is still caught even after stripping (direction 2) — an assertion that stripped too much
  // would pass on both cases the field-level pin exists to catch. Nothing below this comment
  // is exercised by the real-run assertion any more; it is a record of the mechanism, not a
  // live dependency.
  it("[historical] the version-alone canonical comparison strips only `version`, in both directions", () => {
    const base = {
      contractId: "sprint-fixture-1",
      status: "completed",
      evaluatorFeedback: "all criteria met",
      generatorNotes: "generated sprint-fixture-1",
    };
    const stripVersion = (value: Record<string, unknown>): unknown => {
      const { version: _version, ...rest } = value;
      return rest;
    };

    // Direction 1: two contracts differing ONLY in `version` must compare EQUAL once
    // `version` is stripped from both sides.
    const tsLike = { ...base };
    const pgeLike = { ...base, version: 1 };
    expect(canonical(stripVersion(tsLike))).toBe(canonical(stripVersion(pgeLike)));
    // And WITHOUT stripping, the same pair is NOT canonically equal — proof the stripping
    // step is doing real work, not comparing two objects that already matched.
    expect(canonical(tsLike)).not.toBe(canonical(pgeLike));

    // Direction 2: a REAL field differing (here, `generatorNotes`) must still fail the
    // comparison even after `version` is stripped from both sides, so this transform cannot
    // silently start ignoring a real divergence.
    const pgeWithRealDrift = { ...base, version: 1, generatorNotes: "a different generator note" };
    expect(canonical(stripVersion(tsLike))).not.toBe(canonical(stripVersion(pgeWithRealDrift)));
  });

  it("records WHAT each divergence IS, from the artifacts of the same two runs", async () => {
    // ── Why this test exists ──
    //
    // sc-13-2's literal text asks for `equivalent: true`. A real run of the two engines does
    // not produce it, and the contract's fourth stop condition pre-authorises that outcome on
    // ONE condition: that "the divergences are recorded rather than papered over". A list of
    // FIELD NAMES is not that record — it says four things differ without saying how, and a
    // reader cannot tell a cosmetic bookkeeping difference from a run whose commit never
    // happened. So the record is made here, as assertions over the same two runs the harness
    // compares, using the shipped readers. Every claim the paragraphs above make is checked
    // below; a claim that stops being true fails a test instead of ageing into a lie.
    //
    // The two runs are produced exactly as `EngineConformanceHarness` produces them: a fresh
    // root from `projectRootFactory` per engine, and the SHIPPED runner from `runnerFor`.
    const tsRoot = await projectRootFactory();
    const tsResult = await runnerFor("ts")(tsRoot);
    const pgeRoot = await projectRootFactory();
    const pgeResult = await runnerFor("pge")(pgeRoot);

    // ── 1. history: CLOSED at sprint 4 — the pge list now equals the ts list ──
    //
    // The ts list is still pinned literally: it is the imperative engine's own emission
    // order and does not depend on anything this sprint touched. The pge list is asserted
    // against the ts list's OWN ANSWER, not a second literal copy — the same idiom "3.
    // contracts" and "sc-13-3" below use for an already-converged field — so the claim
    // pinned is the CONVERGENCE itself, and a future divergence (an event dropped, reordered
    // or gaining a wrong `iteration`) fails this line rather than requiring two literals to
    // be kept in sync by hand.
    const tsHistoryEvents = (await loadHistory(tsRoot)).map((entry) => entry.event);
    expect(tsHistoryEvents).toEqual([
      "pipeline-start",
      "planning-complete",
      "curator-start",
      "curator-complete",
      "generator-start",
      "evaluator-start",
      "sprint-passed",
      "code-review-complete",
      "sprint-docs-complete",
      PIPELINE_COMPLETE_EVENT,
    ]);
    const pgeHistoryEvents = (await loadHistory(pgeRoot)).map((entry) => entry.event);
    expect(pgeHistoryEvents).toEqual(tsHistoryEvents);

    // ── 2. audits: eight distinct checkpoint ids versus two, one of them recorded
    // three times (sc-3-1, sc-3-2, sc-3-3) ──
    const tsAudits = await readAuditRecords(tsRoot);
    const pgeAudits = await readAuditRecords(pgeRoot);

    expect(tsAudits.map((record) => record.checkpointId)).toEqual([
      "post-plan",
      "post-sprint-contract",
      "pre-curator",
      "pre-generator",
      "pre-evaluator",
      "pre-code-reviewer",
      "post-sprint",
      "end-of-pipeline",
    ]);
    expect(tsAudits.every((record) => record.outcome === "approved")).toBe(true);

    // sc-3-3's premise, CHECKED against the harness rather than assumed: sprint 2's
    // durable approval (`goldenApprovedConfig`) never reaches this config. If it did —
    // `checkpointOverrides: { "end-of-pipeline": "disk" }` — `runnerFor` would hand that
    // SAME config to the ts engine too, and `finalizePipelineRun` would then resolve
    // `end-of-pipeline` through the real `DiskCheckpointMechanism` and block the
    // imperative run. `conformanceConfig()` deliberately measures the shipped autopilot
    // path instead, so the middle `end-of-pipeline` record below is still a FAIL_CLOSED
    // refusal, not an approval reached honestly.
    expect(conformanceConfig().pipeline.checkpointOverrides).toEqual({});

    // `gate_plan_out` now records `post-sprint-contract` FIRST — the effect-free gate
    // that fires immediately after `plan_materialize`, matching the imperative pipeline's
    // own ordering (`pipeline.ts:1017-1025`, `coding.graph.ts:513-526`). The three
    // `end-of-pipeline` records that follow are exactly as before sprint 3 of
    // spec-20260814-pge-full-convergence.
    expect(pgeAudits.map((record) => record.checkpointId)).toEqual([
      "post-sprint-contract",
      "end-of-pipeline",
      "end-of-pipeline",
      "end-of-pipeline",
    ]);
    // The id SET is now TWO, not one — not because one id was recorded twice, and not
    // because it is the only id the artifact declares (it also declares `post-plan`,
    // unreached on this fixture — see "THE RECORDED DIVERGENCE SET" above).
    expect(new Set(pgeAudits.map((record) => record.checkpointId))).toEqual(
      new Set(["post-sprint-contract", "end-of-pipeline"]),
    );
    expect(pgeAudits.map((record) => record.outcome)).toEqual([
      "approved",
      "approved",
      "rejected",
      "approved",
    ]);

    // sc-3-1's negative half, pinned against the RUNNING trail rather than merely
    // narrated: none of the five checkpoint ids sprint 1's ADR forbids inside the sprint
    // fan-out region ever appears, because none of them is declared anywhere in the
    // topology for a mechanism to answer.
    for (const undeclarable of [
      "pre-curator",
      "pre-generator",
      "pre-evaluator",
      "pre-code-reviewer",
      "post-sprint",
    ] as const) {
      expect(
        pgeAudits.some((record) => record.checkpointId === undeclarable),
        `${undeclarable} is permanently undeclarable inside the sprint fan-out region — arch-20260814-pge-full-convergence-adr-1`,
      ).toBe(false);
    }

    // ── 2b. THE MATERIAL FACT the field list alone hides ──
    //
    // The middle record is a FAIL_CLOSED refusal of the `git`-effect `commit` node. Under
    // autopilot the gate mechanism is `noop`, and a `noop` mechanism grants nothing
    // (`runtime/interrupt.ts`), so the node is blocked BEFORE its body is entered: a pge run
    // under the shipped autopilot config does not commit. That is sc-12-9 working as
    // designed — `nodes/commit.test.ts` and `topology-invariants.test.ts` pin it directly —
    // and it is recorded here because it is the single most consequential behavioural
    // difference between the two engines on this fixture, and nothing in a list of four
    // field names says it.
    const refusal = pgeAudits.find((record) => record.outcome === "rejected");
    expect(refusal?.feedbackText).toContain("FAIL_CLOSED");
    expect(refusal?.feedbackText).toContain('node "commit"');
    expect(refusal?.feedbackText).toContain("was not executed");

    // And the consequence that follows from it, recorded rather than corrected here:
    // `PipelineResult` has no error channel and this sprint may not add one (nonGoal 3), so
    // the refusal does NOT downgrade the run's reported success. Both engines report
    // `success: true`; only the graph engine did so without committing.
    expect(tsResult?.success).toBe(true);
    expect(pgeResult?.success).toBe(true);

    // ── 3. contracts: CLOSED at sprint 6 — `version` was the last field delta, and
    // iterationHistory is NOT one of them ──
    const tsContract = (await listContracts(tsRoot))[0];
    const pgeContract = (await listContracts(pgeRoot))[0];
    expect(tsContract.contractId).toBe(pgeContract.contractId);

    // The status delta is CLOSED (sprint 5 of spec-20260812-terminal-vocabulary): both
    // engines write "completed" for a settled sprint. Asserted against the OTHER engine's
    // own answer, not a literal, so the claim pinned is the CONVERGENCE itself, not merely
    // that today's literal happens to be "completed".
    expect(tsContract.status).toBe("completed");
    expect(pgeContract.status).toBe("completed");
    expect(tsContract.status).toBe(pgeContract.status);

    // evaluatorFeedback/generatorNotes are CLOSED (sc-5-1, sc-5-2 — sprint 5 of
    // spec-20260814-pge-full-convergence): asserted against the OTHER engine's OWN answer
    // (Pattern D), not a literal, plus a `toBeDefined()` on each side first so two
    // `undefined`s cannot pass the equality check that follows.
    expect(tsContract.evaluatorFeedback).toBeDefined();
    expect(pgeContract.evaluatorFeedback).toBeDefined();
    expect(pgeContract.evaluatorFeedback).toBe(tsContract.evaluatorFeedback);
    expect(tsContract.generatorNotes).toBeDefined();
    expect(pgeContract.generatorNotes).toBeDefined();
    expect(pgeContract.generatorNotes).toBe(tsContract.generatorNotes);

    // `version` is CLOSED at sprint 6 (sc-6-1): `sprint_exit` writes a monotone `version`
    // (`attempts`), and `runSprintCycle` now writes an EQUIVALENT one (`settledAttempts`,
    // `pipeline.ts`) — `toBeDefined()` on BOTH sides FIRST, so two `undefined`s cannot pass
    // the equality that follows (Pattern B). `conformanceConfig()` sets
    // `evaluator.maxIterations: 1`, so this fixture settles on the one decisive round and
    // both sides write `1` — the two-round discriminating case lives in
    // `pipeline.test.ts`'s dedicated `describe`, not here (pitfall 7 in the sprint 6 brief).
    expect(tsContract.version).toBeDefined();
    expect(pgeContract.version).toBeDefined();
    expect(tsContract.version).toBe(pgeContract.version);
    // Refutes the reading that the imperative engine accumulates iteration bookkeeping the
    // graph lacks: on a first-attempt pass neither engine writes any.
    expect(tsContract.iterationHistory).toEqual([]);
    expect(pgeContract.iterationHistory).toEqual([]);

    // sc-6-3: the `contracts` divergence is now CLOSED entirely — asserted directly as a
    // WHOLE-OBJECT `canonical` comparison with NOTHING stripped (unlike sprint 5's
    // `version`-stripped control, now historical — see the HISTORICAL test above), so a
    // delta nobody named above would still be caught.
    expect(canonical(pgeContract)).toBe(canonical(tsContract));

    // ── 4. pipelineResult: the CONTAINER portion is CLOSED at sprint 6, as a CONSEQUENCE of
    // `contracts` closing — not by any write inside PipelineResult itself, and not
    // special-cased in this harness — but the field as a WHOLE stays in the divergence set
    // for a genuinely separate reason: `errors` ──
    //
    // `appendById` resolves the duplicate `contractId` by RANK (`registry/reducers.ts`,
    // `rankIsGreater`), not canonical order (closed at sprint 4 of
    // spec-20260812-terminal-vocabulary), so `commit.finalize` reads the SETTLED copy out of
    // `state.sprintContracts`: the contract inside `completedSprints` is not stuck at the
    // seeded `"proposed"`.
    expect(tsResult?.completedSprints.map((c) => c.status)).toEqual(["completed"]);
    expect(pgeResult?.completedSprints.map((c) => c.status)).toEqual(["completed"]);
    expect(pgeResult?.failedSprints).toEqual([]);

    // `PipelineResult.completedSprints` is a CONTAINER for `SprintContract` objects: the
    // IDENTICAL object each engine's own runner returned, which is the IDENTICAL object
    // `listContracts` reads back off disk (`pipeline.ts:1053`/`:594`). Asserted on BOTH
    // engines — before sprint 6 only the pge side was pinned this way — so the container
    // claim is checked, not assumed, on the side that changed too. This portion of
    // `pipelineResult` is therefore fully converged.
    expect(pgeResult?.completedSprints[0]).toEqual(pgeContract);
    expect(tsResult?.completedSprints[0]).toEqual(tsContract);

    // What keeps `pipelineResult` in the divergence set: `errors`, populated ONLY on the pge
    // side, from the interpreter's own `TaskFailure` records
    // (`pge-engine.ts:551-572`) — the SAME FAIL_CLOSED `commit`-node refusal recorded in
    // "2b. THE MATERIAL FACT" above. `"errors" in result` (not `=== undefined`) is the
    // documented check (`pipeline.ts`'s `PipelineResult` doc comment) because the TS engine's
    // `PipelineResult` never carries the key AT ALL, not merely an empty one — asserted here
    // both ways so an accidental `errors: []` on the ts side (a false "it converged") would
    // still be caught by the field-level pin above even if this narrower check missed it.
    expect("errors" in (tsResult ?? {})).toBe(false);
    expect(pgeResult?.errors).toBeDefined();
    expect(pgeResult?.errors?.length).toBeGreaterThan(0);
    expect(pgeResult?.errors?.[0]?.nodeId).toBe("commit");
    expect(pgeResult?.errors?.[0]?.errorClass).toBe("FailClosed");
  }, 60_000);

  it("is EQUIVALENT on every field outside the recorded divergence set", async () => {
    const report = await compare();
    const diverged = new Set(report.diffs.map((diff) => diff.field));

    // The five fields both engines populate and AGREE on, byte-for-byte after volatile-key
    // stripping and project-root redaction. This is the substantive half of sc-13-2: two
    // completely different execution models produced the same spec, the same evaluation
    // results, the same briefings, the same reviews and the same completion marker — and the
    // completion marker is the one the chat layer tails, so the agreement is load-bearing
    // rather than incidental.
    for (const field of ["specs", "evalResults", "briefings", "reviews", "completionMarker"] as const) {
      expect(diverged.has(field), `${field} diverged`).toBe(false);
      const entry = report.fields.find((f) => f.field === field);
      expect(entry?.counts.ts, `${field} on ts`).toBeGreaterThan(0);
      expect(entry?.counts.pge, `${field} on pge`).toBeGreaterThan(0);
    }
  }, 60_000);
});

// ── sc-13-3 ─────────────────────────────────────────────────────────

describe("both engines finalize through the sprint-4 single owner (sc-13-3)", () => {
  it("CompletionTailer.poll() yields the runId for a pge run exactly as for a ts run", async () => {
    const seen: Record<string, string[]> = { ts: [], pge: [] };

    for (const engine of ["ts", "pge"] as const) {
      const projectRoot = await projectRootFactory();
      // The tailer is constructed BEFORE the run, exactly as `chat-session.ts` does: it
      // remembers the history offset it started at, and a marker written before it exists
      // is not the case this is about.
      const tailer = new CompletionTailer(projectRoot);
      await tailer.poll();

      await runnerFor(engine)(projectRoot);

      const completions = await tailer.poll();
      seen[engine] = completions.map((entry) => entry.runId);
    }

    expect(seen.ts).toEqual([RUN_ID]);
    // EXACTLY as for a ts run — asserted against the other engine's own answer rather than
    // against a literal, so the claim is the equivalence and not the string.
    expect(seen.pge).toEqual(seen.ts);
  }, 60_000);
});

// ── sc-3-3 ─────────────────────────────────────────────────────────

describe("the commit refusal is gone under a REAL durable approval, not a reclassified one (sc-3-3)", () => {
  it("gives the pge run its OWN config with end-of-pipeline routed to disk, and every record approves through a real grant", async () => {
    // ── Why this is a SEPARATE run, not a change to the run above ──
    //
    // "records WHAT each divergence IS" pins that a run under the SHARED `conformanceConfig()`
    // still records the middle `end-of-pipeline` as `rejected` (mechanism `noop`), and that
    // sprint 2's durable approval never reaches THAT config — mutating the one instance both
    // engines share would route the ts run through `disk` too and block it. That premise is
    // correct, and it stays correct here: `conformanceConfig()` is asserted unmutated below,
    // and the assertion above it — and the compare()-based tests that use it — are untouched.
    //
    // What the premise does not establish is that pge is stuck with that config. `runnerFor`
    // (above) builds `config = conformanceConfig()` freshly INSIDE each `runnerFor(engine)`
    // call — the pge branch and the ts branch never share the returned object — so nothing
    // stops a caller from giving the pge engine a DIFFERENT config than `runnerFor("ts")`
    // ever sees. This test does exactly that: start from `conformanceConfig()` and override
    // only `end-of-pipeline` to `disk` — the SAME override sprint 2 shipped as
    // `goldenApprovedConfig` (`golden/executor.ts:152-161`) — then run it through
    // `withGoldenApproval` (`golden/executor.ts:390-412`), the pairing this repository's own
    // committed `.bober/golden/replay-full-run-commit-approved.json` already proves yields an
    // all-approved trail via a real `disk` grant, not a reclassified refusal.
    const pgeRoot = await projectRootFactory();
    const sharedConfig = conformanceConfig();
    const approvedConfig: BoberConfig = {
      ...sharedConfig,
      pipeline: {
        ...sharedConfig.pipeline,
        checkpointOverrides: { ...sharedConfig.pipeline.checkpointOverrides, "end-of-pipeline": "disk" },
      },
    };

    // `needed: true` unconditionally — unlike the executor's data-driven
    // `goldenCase.input.config !== undefined`, this run always wants the swapped-in,
    // run-root-scoped `disk` mechanism, never the checkout's own registered instance.
    const result = await withGoldenApproval(pgeRoot, true, () =>
      new PgeEngine({
        graphId: CODING_GRAPH_ID,
        bindings: (input) => wholeGraphBindings(input),
      }).run(PROMPT, pgeRoot, approvedConfig, { runId: RUN_ID }),
    );

    const audits = await readAuditRecords(pgeRoot);

    // The checkpoint id SEQUENCE is exactly as under the shared config asserted above — this
    // override changes which mechanism ANSWERS `end-of-pipeline`, not which checkpoints fire
    // or in what order.
    expect(audits.map((record) => record.checkpointId)).toEqual([
      "post-sprint-contract",
      "end-of-pipeline",
      "end-of-pipeline",
      "end-of-pipeline",
    ]);

    // ── THE ASSERTION sc-3-3 asks for ──
    //
    // Not "no rejected outcome" alone — that would also be true of a run that never asked
    // the question, or one whose mechanism resolution silently fell through to `noop`.
    // `mechanism` is what tells a real grant from a reclassified refusal apart: `noop` means
    // nothing was asked and the FAIL_CLOSED default answered instead; `disk` means a pending
    // marker was written, polled for, and answered by a real approval file on disk. All
    // three `end-of-pipeline` records resolve through `disk` — the override reaches every
    // ask, `hitl_commit`'s own gate and `finalizePipelineRun`'s both.
    expect(audits.map((record) => record.mechanism)).toEqual(["noop", "disk", "disk", "disk"]);
    expect(audits.map((record) => record.outcome)).toEqual(["approved", "approved", "approved", "approved"]);
    expect(audits.some((record) => record.outcome === "rejected")).toBe(false);

    // The refusal text "records WHAT each divergence IS" pins for the SHARED-config run
    // ("FAIL_CLOSED", `node "commit"`, "was not executed") appears nowhere in THIS trail —
    // not because it was reclassified, but because the run that would have produced it never
    // happens: `commit` is granted a real approval and executes.
    for (const record of audits) {
      expect(record.feedbackText ?? "").not.toContain("FAIL_CLOSED");
    }

    // `conformanceConfig()` itself is unaffected by this run having existed — read fresh
    // rather than off `sharedConfig` above, so a mutation reaching the shared object (a
    // shallow spread does not protect a NESTED value) would be caught here too. The same pin
    // "records WHAT each divergence IS" asserts, re-checked after the run that would expose
    // a leak if the override above were anything but a fresh copy.
    expect(conformanceConfig().pipeline.checkpointOverrides).toEqual({});

    expect(result.success).toBe(true);
  }, 60_000);
});
