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
    //    writer through the commit boundary — and the boundary cannot reconstruct a
    //    `curator-start`/`curator-complete` PAIR from one superstep commit. Larger than this
    //    sprint may make.
    //  - `audits`: NOT a duplicated checkpoint id. The imperative pipeline records EIGHT
    //    checkpoints under eight distinct ids; the graph records three, all `end-of-pipeline`,
    //    because that is the only checkpoint id the committed artifact declares. Two of the
    //    three come from the artifact's `hitl_commit` gate and one from `finalizePipelineRun`.
    //    The middle one is an `outcome: "rejected"` FAIL_CLOSED record: under autopilot the
    //    gate mechanism is `noop`, a `noop` mechanism deliberately GRANTS nothing
    //    (`runtime/interrupt.ts`), so the `git`-effect `commit` node is refused and never
    //    executed — sc-12-9's shipped behaviour, pinned by `nodes/commit.test.ts` and
    //    `topology-invariants.test.ts`. Closing it would mean declaring the other seven
    //    checkpoint ids in `.bober/topology/coding.json`, which this sprint may not edit.
    //  - `contracts`: THREE field deltas on the one contract, and `iterationHistory` is NOT
    //    one of them — it is `[]` on both sides for this fixture. `sprint_exit` writes
    //    `status: "completed"` where `runSprintCycle` writes `"passed"`, and the graph never
    //    populates `evaluatorFeedback` or `generatorNotes`. Closing it means changing what
    //    `sprint_exit` writes, which `nodes/sprint-evaluate.test.ts` pins deliberately.
    //  - `pipelineResult`: does NOT merely follow from `contracts` — it is worse, and it is
    //    the sprint-12 limitation `nodes/sprint-review.ts` documents. `commit.finalize` reads
    //    `state.sprintContracts`, and `appendById` resolves a duplicate `contractId` by
    //    CANONICAL ORDER, under which every settled status sorts before the seeded
    //    `"proposed"` — so the channel keeps the PLANNED copy and a pge run reports a
    //    contract still marked `"proposed"` inside `completedSprints`. Closing it needs a
    //    monotone discriminator on `SprintContract`, i.e. a shipped-schema revision.
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

    // ── 2. audits: eight distinct checkpoint ids versus one id recorded three times ──
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

    // Every graph-side record is `end-of-pipeline` because that is the only checkpoint id
    // the committed artifact declares — not because one id was recorded twice.
    expect(new Set(pgeAudits.map((record) => record.checkpointId))).toEqual(
      new Set(["end-of-pipeline"]),
    );
    expect(pgeAudits.map((record) => record.outcome)).toEqual(["approved", "rejected", "approved"]);

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

    expect(tsContract.status).toBe("passed");
    expect(pgeContract.status).toBe("completed");
    expect(tsContract.evaluatorFeedback).toBeDefined();
    expect(pgeContract.evaluatorFeedback).toBeUndefined();
    expect(tsContract.generatorNotes).toBeDefined();
    expect(pgeContract.generatorNotes).toBeUndefined();
    // Refutes the reading that the imperative engine accumulates iteration bookkeeping the
    // graph lacks: on a first-attempt pass neither engine writes any.
    expect(tsContract.iterationHistory).toEqual([]);
    expect(pgeContract.iterationHistory).toEqual([]);

    // ── 4. pipelineResult: the graph reports a contract still marked "proposed" ──
    //
    // The sprint-12 limitation `nodes/sprint-review.ts` documents, observed end to end for
    // the first time: `commit.finalize` classifies the branch as completed from
    // `branchStatus`, but the contract it REPORTS comes from `state.sprintContracts`, whose
    // `appendById` reducer resolves the duplicate `contractId` by canonical order and keeps
    // the seeded `"proposed"` copy. So the settled status reaches `.bober/contracts/` and
    // never reaches the returned result.
    expect(tsResult?.completedSprints.map((c) => c.status)).toEqual(["passed"]);
    expect(pgeResult?.completedSprints.map((c) => c.status)).toEqual(["proposed"]);
    expect(pgeResult?.failedSprints).toEqual([]);
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
