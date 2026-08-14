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
    engineHealth: vi.fn().mockReturnValue("disabled"),
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
import { EngineConformanceHarness, emptyOnAllEnginesFields, fullyPopulatedFields } from "./conformance.js";
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
 *  - `progress` (`.bober/progress.md`) is written by `updateProgress`, which has no call
 *    site in `runTsPipeline` and none in the graph runtime.
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
    // WHICH fields diverge is pinned here. WHAT each divergence IS — the events, the
    // checkpoint ids, the contract fields, the offending status value — is pinned in
    // "records what each divergence IS" below, from the artifacts of the same two runs.
    // Prose in a comment is not a record; that test is, and it is what keeps the four
    // paragraphs under it honest.
    //
    // The four, with what each one IS and what closing it would take:
    //
    //  - `history`: the imperative engine appends TEN phase events from `runTsPipeline`
    //    itself (`pipeline-start` … `sprint-docs-complete`), then the shared
    //    `pipeline-complete`. A graph run's history has exactly ONE writer,
    //    `finalizePipelineRun`, because phase is a CHANNEL in the graph and per-node progress
    //    lives in the superstep trace, not in `history.jsonl`. Closing it means either
    //    deleting the imperative engine's event stream or giving nine node bodies a history
    //    writer through the commit boundary. CORRECTION, not an amendment: a prior version
    //    of this comment claimed the boundary "cannot reconstruct a
    //    `curator-start`/`curator-complete` pair... because there is NO CURATOR NODE to emit
    //    that pair from" — that clause is FALSE. The topology declares TWO
    //    `role: "curator"` nodes, `sprint_curate_explain` (`coding.graph.ts:576`) and
    //    `sprint_curate_mocks` (`:592`) — a node to host the write exists. What is actually
    //    true: `appendHistory` (`src/state/history.ts:81`) is a plain exported function the
    //    imperative engine calls inline at ten sites in `pipeline.ts`, and
    //    `grep -rn "appendHistory\|history.jsonl" src/pge --include="*.ts"` (non-test) is
    //    ZERO hits — no PGE node body, curator or otherwise, calls it. That is a MISSING
    //    WRITER, not a missing place for one: `history` is OPEN WORK, not RECOMMENDED FOR
    //    PERMANENT ACCEPTANCE — left undone on scope grounds alone
    //    (`spec-20260814-pge-full-convergence`'s own `outOfScope[0]`, inherited from
    //    `spec-20260812-terminal-vocabulary`'s), not an architectural bound the way
    //    `audits`' fan-out block below is.
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
    //    ACCEPTANCE — `history` (corrected above) is NOT, it is open work — not as open
    //    work a later sprint can close further.
    //  - `contracts`: THREE field deltas on the one contract (was four before sprint 5 of
    //    spec-20260812-terminal-vocabulary), and `iterationHistory` is NOT one of them — it
    //    is `[]` on both sides for this fixture. `status` is CLOSED: `runSprintCycle` now
    //    writes `"completed"`, exactly what `sprint_exit` already wrote. What remains is that
    //    the graph never populates `evaluatorFeedback` or `generatorNotes` — PGE has no
    //    writer for either field anywhere in `src/pge/`, so this is a missing-writer gap, not
    //    a word disagreement — and, since sprint 3, `sprint_exit` also writes `version` (the
    //    graph's monotone ordering discriminator for `versionRank`,
    //    `registry/reducers.ts:366-393`) where the imperative engine writes none.
    //    `evaluatorFeedback`/`generatorNotes` would need a new writer inside a PGE node body;
    //    `version` is deliberately NOT one of `VOLATILE_KEYS` (`conformance.ts:65-76`) because
    //    stripping it would hide a real divergence rather than close one. None of the three
    //    is closable by a vocabulary change, which is what sprint 5's stop condition
    //    pre-authorises recording rather than forcing.
    //  - `pipelineResult`: NO LONGER the seeded-copy defect closed at sprint 4 of
    //    spec-20260812-terminal-vocabulary. `appendById` now resolves a duplicate
    //    `contractId` by RANK (`registry/reducers.ts`, `rankIsGreater`/`mergeEntries`)
    //    instead of canonical order, so `commit.finalize` reads the SETTLED copy out of
    //    `state.sprintContracts` and `completedSprints[0].status` is `"completed"`, not
    //    `"proposed"` — the sprint-12 limitation `nodes/sprint-review.ts` used to document is
    //    gone (verified below in "4. pipelineResult"). What remains is NOT independently
    //    closable: `PipelineResult.completedSprints`/`failedSprints` carry whole
    //    `SprintContract` objects, so `pipelineResult`'s divergence REDUCES EXACTLY to the
    //    `contracts` divergence above (the same `evaluatorFeedback`/`generatorNotes`/
    //    `version` deltas, none of them `VOLATILE_KEYS`, `conformance.ts:65-76`) — it is a
    //    CONTAINER for the contract, and the `status` field inside that container is now
    //    identical on both engines (sprint 5 of spec-20260812-terminal-vocabulary). It closes
    //    exactly when `contracts` closes, not before.
    //
    // Everything else — specs, evalResults, briefings, reviews, completionMarker — is
    // IDENTICAL across the two engines, which is the positive half of the claim and is
    // asserted two tests below.
    expect([...new Set(report.diffs.map((diff) => diff.field))].sort()).toEqual([
      "audits",
      "contracts",
      "history",
      "pipelineResult",
    ]);
    expect(report.equivalent).toBe(false);
  }, 60_000);

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

    // ── 1. history: ten imperative phase events versus one shared terminal event ──
    expect((await loadHistory(tsRoot)).map((entry) => entry.event)).toEqual([
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
    expect((await loadHistory(pgeRoot)).map((entry) => entry.event)).toEqual([
      PIPELINE_COMPLETE_EVENT,
    ]);

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

    // ── 3. contracts: three field deltas, and iterationHistory is NOT one of them ──
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
    expect(tsContract.evaluatorFeedback).toBeDefined();
    expect(pgeContract.evaluatorFeedback).toBeUndefined();
    expect(tsContract.generatorNotes).toBeDefined();
    expect(pgeContract.generatorNotes).toBeUndefined();
    // The remaining delta: `sprint_exit` writes a monotone `version`; `runSprintCycle` writes none.
    expect(tsContract.version).toBeUndefined();
    expect(pgeContract.version).toBeDefined();
    // Refutes the reading that the imperative engine accumulates iteration bookkeeping the
    // graph lacks: on a first-attempt pass neither engine writes any.
    expect(tsContract.iterationHistory).toEqual([]);
    expect(pgeContract.iterationHistory).toEqual([]);

    // ── 4. pipelineResult: the sprint-12 seeded-copy defect is CLOSED (sprint 4 of
    // spec-20260812-terminal-vocabulary) — but the DIVERGENCE is not, because it reduces
    // exactly to the `contracts` divergence above ──
    //
    // `appendById` now resolves the duplicate `contractId` by RANK
    // (`registry/reducers.ts`, `rankIsGreater`) rather than canonical order, so
    // `commit.finalize` reads the SETTLED copy out of `state.sprintContracts`: the contract
    // inside `completedSprints` is no longer stuck at the seeded `"proposed"`.
    expect(tsResult?.completedSprints.map((c) => c.status)).toEqual(["completed"]);
    expect(pgeResult?.completedSprints.map((c) => c.status)).toEqual(["completed"]);
    expect(pgeResult?.failedSprints).toEqual([]);

    // The positive half of the claim, and why sc-4-5's literal wording ("the divergence is
    // CLOSED") rests on a false premise: `completedSprints[0]` is not merely "not proposed"
    // any more, it is the IDENTICAL object `listContracts` reads back off disk —
    // `PipelineResult.completedSprints` is a CONTAINER for `SprintContract` objects, so
    // whatever still differs between the two engines' contracts (the four `contracts`
    // deltas asserted above) is exactly what still differs here. A container cannot
    // converge before its contents do.
    expect(pgeResult?.completedSprints[0]).toEqual(pgeContract);
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
