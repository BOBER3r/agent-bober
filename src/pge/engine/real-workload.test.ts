// ── real-workload.test.ts ───────────────────────────────────────────
//
// ONE PgeEngine run of the COMMITTED artifact over THIS REPOSITORY'S OWN committed ~29 KB
// PlanSpec, with every effect stubbed and the network disabled — and the measurement of
// what actually happens, committed as data.
//
//   sc-1-1  a real PgeEngine, constructed over the committed coding.json, run with the
//           real spec as the planner's output and every effect answered from a stub.
//   sc-1-2  every rejected write recorded: channel id, nodeId, serialised bytes, and the
//           channel's declared limit — read off StateBloatError, never regexed.
//   sc-1-3  the terminal node and the run verdict, read off the INTERPRETER's own
//           GraphRunResult, never off the PipelineResult PgeEngine.run returns.
//   sc-1-4  re-running the harness against unchanged inputs reproduces byte-identical
//           measurement output.
//   sc-1-5  if the observation contradicts the derivation, the measurement is committed
//           unchanged; see the generator's completion notes for any such contradiction.
//   sc-2-3  the same "corpus-sized payload against the declared limit" question, extended
//           from `spec`/`sprintContracts` to `messages`, `evaluations` and `refs` — read
//           off the committed workload corpus at `.bober/workload/`
//           (`src/pge/golden/workload.ts`), never off an invented payload.
//
// ── Sprint 4 of spec-20260812-pge-real-workload-errors ──
//
// Sprint 3 raised `spec` and `sprintContracts` far enough that `plan_materialize`'s writes
// stopped rejecting, which revealed a SECOND, independent ceiling: with `state.spec` no
// longer null, the run proceeds into the real 14-contract fan-out and trips the
// interpreter's own runaway guard, `SuperstepLimitExceededError` at
// `DEFAULT_MAX_SUPERSTEPS = 200`, before reaching any terminal node. This sprint's own tests:
//
//   sc-4-1  zero StateBloatError failures over the committed 29 KB spec and its 14
//           contracts — the half of the original criterion sprint 3 made true.
//   sc-4-2  the same run leaves `state.spec` non-null and `state.sprintContracts` holding
//           all 14 contracts.
//   sc-4-3  the superstep cost measured, not argued: supersteps consumed, and how that
//           scales across two different contract counts (1 and 14), committed as data.
//   sc-4-4  the verdict the measurement supports — INSUFFICIENT CEILING, not
//           NON-CONVERGENCE — with the evidence that distinguishes them: the branch set
//           fully drains (every dispatched contract settles `"succeeded"`), no loop
//           counter is ever spent, and the ONLY recorded `TaskFailure` is the
//           already-documented `commit` `FailClosed` refusal.
//   sc-4-5  the ceiling raised to a MEASURED basis (`PGE_ENGINE_MAX_SUPERSTEPS`,
//           `../pge-engine.ts`), pinned two-directionally: the shipped value equals a pure
//           function of the measured cost (never a hand-picked literal), and lowering it
//           below the measured cost reproduces `SuperstepLimitExceededError`. The reached
//           terminal is `graceful_failure`, explicitly NOT `finalize` — `commit` is still
//           FAIL_CLOSED-refused under the autopilot `noop` mechanism, a later sprint's
//           territory.
//
// ── The one thing that decides this sprint ──
//
// `PgeEngine.run` computes the interpreter's own `GraphRunResult` and then DISCARDS its
// `.verdict` and `.failures` before returning a `PipelineResult`
// (src/pge/engine/pge-engine.ts:461-482). A harness that only inspected the returned
// `PipelineResult` would observe NOTHING. So `PgeEngine.run` is what is DRIVEN here — sc-1-1
// requires "a real PgeEngine" — and the interpreter's own result is captured through the
// engine's own `PgeEngineDeps.interpreterFactory` seam (pge-engine.ts:162, consumed at
// :420), never through a private reimplementation of `run()`. Precedent that the seam is
// real and already exercised: `pge-engine.test.ts:319-338`.
//
// ── Sprint 10 of spec-20260814-pge-full-convergence ──
//
// Every prior sprint that touched this file measured the fixture-stubbed run's SHAPE
// (rejections, terminal node, superstep cost) or a STATIC corpus payload
// (`corpusHeadroom`, three of eleven channels). Neither answers whether THIS run's own
// writes — after sprint 5 (of THIS spec) tripled what `sprint_evaluate` puts in one
// `evaluations` entry, and sprint 8 taught `critique`/`rework_route` to execute — still fit
// every channel's declared cap, or which of the 44 declared nodes this SPECIFIC real
// workload actually drives. This sprint's own tests:
//
//   sc-10-1  restated: a real PgeEngine run completes against the real, committed 29 KB
//            PlanSpec — the sprint-4 assertions above already prove this; unchanged here.
//   sc-10-2  `observedWrites`: every one of the eleven declared channels, from THIS run's
//            own commit-boundary traffic (`recordingCommitBoundary` below), not a static
//            corpus proxy — the largest single `ChannelUpdate.value` this run ever asked
//            the boundary to commit, per channel, compared against that channel's own
//            declared cap. Directly answers the carried finding: `evaluations` now carries
//            three independent copies of unbounded text per entry
//            (`nodes/sprint-evaluate.ts`'s `bober:` comment) and does NOT breach on this
//            stub-driven corpus — see the generator's completion notes for the measured
//            bytes and why that is not a guarantee for a real evaluator's longer output.
//   sc-10-3  `nodeCoverage`: this run's OWN executed-node set, read off its OWN spans with
//            the same `status: "ok"` rule `src/pge/golden/coverage.test.ts` uses, against
//            ALL 44 declared nodes — not the golden dataset's `NEVER_EXECUTED` (two
//            structural blocks only). One real run takes one path, so it misses every node
//            whose triggering condition this workload's inputs and stub collaborators never
//            produce; each is named, not averaged away.
//   sc-10-4  the extended measurement — `observedWrites` and `nodeCoverage` alongside the
//            fields sprints 1–4 already committed — is regenerated and committed as
//            evidence, through the SAME `MEASURE_REAL_WORKLOAD=1` byte-identical-compare
//            mechanism those sprints established.
//
// Regenerate the committed measurement with:
//   MEASURE_REAL_WORKLOAD=1 npx vitest run src/pge/engine/real-workload.test.ts

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TopologySpec } from "../../contracts/topology.js";
import { TopologySpecSchema } from "../../contracts/topology.js";
import { GoldenBindingInvokedError } from "../golden/executor.js";
import { WORKLOAD_DIR, capForCorpusMax, loadWorkloadCorpus, maxBytesPerChannel } from "../golden/workload.js";
import type { CodingBindings } from "../registry/index.js";
import { byteSize, createFixedClock } from "../runtime/commit.js";
import type { ChannelUpdate, CommitBoundary } from "../runtime/commit.js";
import { DEFAULT_MAX_SUPERSTEPS, createGraphInterpreter } from "../runtime/interpreter.js";
import type { GraphInterpreter, GraphRunResult } from "../runtime/interpreter.js";
import { withNetworkDisabled } from "../runtime/replay.js";
import { readSpans, tracePath } from "../runtime/trace.js";
import { checksumTopology } from "../topology/canonical.js";
import { serializeTopology } from "../topology/dump.js";
import {
  MEASURED_REAL_WORKLOAD_SUPERSTEPS,
  PGE_ENGINE_MAX_SUPERSTEPS,
  PgeEngine,
  SUPERSTEP_HEADROOM_FACTOR,
  readValidatedTopologySpec,
  superstepsForMeasuredCost,
} from "./pge-engine.js";
import type { PgeRegistriesInput } from "./pge-engine.js";
import { CODING_GRAPH_ID, REPO_ROOT, conformanceConfig, seedCommittedArtifact } from "./__fixtures__/whole-graph.js";
import { REAL_SPEC_PATH, realWorkload, realWorkloadBindings } from "./__fixtures__/real-workload.js";
import type { Workload } from "./__fixtures__/real-workload.js";

/** The instant every run in this file is frozen at, through the engine's own clock seam. */
const FIXED_INSTANT = "2026-08-12T00:00:00.000Z";

/** The committed measurement artifact — sc-1-2, sc-1-3, sc-1-4, sc-4-3, sc-4-7. */
const MEASUREMENT_PATH = join(REPO_ROOT, ".bober", "topology", "measurements", "real-workload.json");

/** Rewrites the committed measurement instead of comparing against it. Never gates the run itself. */
const MEASURING = process.env.MEASURE_REAL_WORKLOAD === "1";

let tmpRoots: string[] = [];

beforeEach(() => {
  tmpRoots = [];
});

afterEach(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots = [];
});

async function seededRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bober-pge-real-workload-"));
  tmpRoots.push(dir);
  await seedCommittedArtifact(dir);
  return dir;
}

// ── The measurement shape ───────────────────────────────────────────

interface RecordedRejection {
  readonly channel: string;
  readonly nodeId: string;
  readonly branchKey: string | null;
  readonly bytes: number;
  readonly limit: number;
  readonly superstep: number;
}

interface RecordedFailure {
  readonly nodeId: string;
  readonly branchKey: string | null;
  readonly superstep: number;
  readonly errorClass: string;
}

type EngineOutcome =
  | { readonly kind: "resolved"; readonly success: boolean }
  | { readonly kind: "threw"; readonly errorClass: string };

/**
 * sc-2-3: the same "corpus-sized payload against the declared limit" question sc-1's
 * `spec`/`sprintContracts` rejections already answered, extended to `messages`,
 * `evaluations` and `refs` — the three channels real generator and evaluator payloads flow
 * through. `corpusMaxBytes` is `maxBytesPerChannel(corpus)[channel]` — the boundary's own
 * `byteSize`, never reimplemented (sc-2-2) — and `declaredLimit` is read off the SAME
 * `channelLimits` this measurement already records, so `wouldReject` is exactly the
 * comparison `commit.ts:358-359` performs, computed from the corpus's own real numbers
 * rather than an invented payload.
 */
interface CorpusHeadroom {
  readonly corpusMaxBytes: number;
  readonly declaredLimit: number;
  readonly wouldReject: boolean;
}

/** The channels sc-2-3 extends the measurement to. `spec`/`sprintContracts` are sc-1's. */
const CORPUS_HEADROOM_CHANNELS = ["messages", "evaluations", "refs"] as const;

/**
 * sc-4-5: the ceiling `PgeEngine.run` is CURRENTLY shipping, recorded alongside the
 * measurement it was derived from — `configured` and `measuredBasis` are the SAME shipped
 * constants every run reads, never per-observation values, so this field documents the
 * production fact even when a test drives a probe override underneath it.
 */
interface SuperstepCeilingFacts {
  readonly configured: number;
  readonly measuredBasis: number;
  readonly headroomFactor: number;
}

/** sc-4-3: one contract count's own supersteps cost and terminal, in `spec.sprints` order. */
interface ContractCountScalingEntry {
  readonly contractCount: number;
  readonly supersteps: number;
  readonly terminalNodeId: string;
  readonly status: GraphRunResult["status"];
}

/**
 * sc-10-2: what THIS run actually wrote to one channel, over its WHOLE lifetime — not the
 * committed corpus's static payloads (`CorpusHeadroom` above), and not the final merged
 * channel value (which unions every write and would overstate a single update's cost).
 * `maxBytes` is the largest SINGLE `ChannelUpdate.value` the commit boundary ever measured
 * for this channel during this run, read via `byteSize` — the exact metric
 * `commit.ts:388-400` compares against `maxInlineBytes` before a reducer ever sees the
 * value — so `wouldReject` here is not inferred, it is the literal boundary comparison,
 * repeated for every channel rather than the three `CORPUS_HEADROOM_CHANNELS` cover.
 *
 * `writeCount` absent (0) means the channel was never written by ANY node this run
 * reached — itself a fact worth recording separately from "measured and found small": a
 * channel with `writeCount: 0` had its cap exercised zero times, so a `wouldReject: false`
 * for it says nothing about headroom.
 */
interface ObservedChannelWrite {
  readonly maxBytes: number;
  readonly writeCount: number;
  readonly declaredLimit: number;
  readonly wouldReject: boolean;
}

/**
 * sc-10-3: which of the artifact's declared nodes this run's own spans show entering their
 * handler and finishing `status: "ok"` — `src/pge/golden/coverage.test.ts`'s own rule
 * (`executedNodeIdsFromSpans`), applied here to ONE real run instead of the golden dataset's
 * many cases. `neverExecutedNodeIds` is deliberately not the golden dataset's
 * `NEVER_EXECUTED` (`context_compact`, `synthesize` only): a single run necessarily takes
 * one path through the graph, so it misses every node whose triggering condition this
 * workload's own inputs and stub collaborators never produce, not only the two nodes no
 * INPUT could ever trigger. See the generator's completion notes and the corresponding
 * `docs/pge-graph.md` section for which of `neverExecutedNodeIds` is structural (unreachable
 * by any input) and which is workload-specific (reachable, just not by this one).
 */
interface NodeCoverage {
  readonly totalNodes: number;
  readonly executedNodeIds: readonly string[];
  readonly neverExecutedNodeIds: readonly string[];
}

interface Measurement {
  readonly formatVersion: 1;
  readonly graph: { readonly graphId: string; readonly graphVersion: string };
  readonly workload: {
    readonly specPath: string;
    readonly specId: string;
    readonly specCanonicalBytes: number;
    readonly contractCount: number;
    readonly contractsCanonicalBytes: number;
  };
  readonly channelLimits: Record<string, number>;
  /**
   * `null` exactly when the INTERPRETER ITSELF threw before ever returning a
   * `GraphRunResult` — see `engineOutcome` and the comment on `observeRealWorkload` below.
   * There is no rejection list, terminal node, status, verdict or supersteps count to read
   * off a result that was never produced. As of sprint 4's ceiling raise this is the
   * NORMAL run's outcome only under a deliberately lowered probe ceiling (the two-directional
   * pin below) — the committed measurement itself now carries a real `GraphRunResult`.
   */
  readonly rejections: readonly RecordedRejection[] | null;
  readonly failures: readonly RecordedFailure[] | null;
  readonly terminalNodeId: string | null;
  readonly status: GraphRunResult["status"] | null;
  readonly verdict: string | null;
  readonly specChannelNullAtBoundary: boolean | null;
  /** sc-4-3: supersteps the interpreter actually consumed, or `null` under the same condition as the fields above. */
  readonly supersteps: number | null;
  readonly superstepCeiling: SuperstepCeilingFacts;
  readonly engineOutcome: EngineOutcome;
  readonly corpusHeadroom: Record<string, CorpusHeadroom>;
  /** sc-10-2: every declared channel, keyed by channel id, from this run's own writes. */
  readonly observedWrites: Record<string, ObservedChannelWrite>;
  /** sc-10-3: every declared node, from this run's own spans. */
  readonly nodeCoverage: NodeCoverage;
}

/**
 * The shape actually written to disk: `Measurement` plus the contract-count scaling data
 * (sc-4-3, sc-4-4), layered on AFTER the single real-workload observation resolves —
 * mirroring how `RunResultFlusher.flush` layers `needsClarification` onto a finalized
 * result with a spread rather than folding it into the same computation
 * (`src/orchestrator/workflow/flusher.ts:113-127`).
 */
interface CommittedMeasurement extends Measurement {
  readonly contractCountScaling: readonly ContractCountScalingEntry[];
}

/** One writer for the file and for the compare, exactly `goldenCaseJson`'s shape. */
function measurementJson(measurement: CommittedMeasurement): string {
  return `${JSON.stringify(measurement, null, 2)}\n`;
}

/** The ceiling facts every `Measurement` records — the shipped constants, not a per-run value. */
function superstepCeilingFacts(): SuperstepCeilingFacts {
  return {
    configured: PGE_ENGINE_MAX_SUPERSTEPS,
    measuredBasis: MEASURED_REAL_WORKLOAD_SUPERSTEPS,
    headroomFactor: SUPERSTEP_HEADROOM_FACTOR,
  };
}

/**
 * sc-10-2: wraps a real `CommitBoundary` to record, per channel, the largest single
 * `ChannelUpdate.value` this run ever asked it to commit and how many updates it saw —
 * BEFORE the boundary's own accept/reject decision, so a rejected write is recorded here
 * too (it also shows up in `rejections`; recording it here as well is what lets
 * `observedWrites` answer "every channel" without a caller needing to reconcile two lists).
 * Delegates to `inner` unchanged — this NEVER alters what the boundary accepts, rejects or
 * commits, only observes it, the same non-interference `recordingInterpreterFactory` below
 * already gives `maxSupersteps`.
 */
function recordingCommitBoundary(
  inner: CommitBoundary,
  sink: Map<string, { maxBytes: number; writeCount: number }>,
): CommitBoundary {
  return {
    commit: (graph, current, batch: readonly ChannelUpdate[], ctx) => {
      for (const update of batch) {
        const bytes = byteSize(update.value);
        const prior = sink.get(update.channel);
        sink.set(update.channel, {
          maxBytes: prior === undefined ? bytes : Math.max(prior.maxBytes, bytes),
          writeCount: (prior?.writeCount ?? 0) + 1,
        });
      }
      return inner.commit(graph, current, batch, ctx);
    },
    finalize: (state, ctx) => inner.finalize(state, ctx),
  };
}

/**
 * Drive a real `PgeEngine` over `projectRoot`'s committed `coding` artifact and measure
 * what the run actually did, reading every fact off the INTERPRETER's own `GraphRunResult`
 * — captured through `interpreterFactory`, the seam that exists for exactly this — and
 * never off the `PipelineResult` `PgeEngine.run` returns (which discards `.verdict` and
 * `.failures`, see the file header).
 *
 * `options.maxSupersteps`, when given, OVERRIDES the ctx the interpreter runs with —
 * exclusively a TEST-side probe (the two-directional pin below reproduces the pre-sprint-4
 * throw by lowering it; nothing here ever lowers the shipped `PGE_ENGINE_MAX_SUPERSTEPS`
 * `PgeEngine.run` itself configures). Absent, the run uses whatever `PgeEngine.run` sets on
 * `ctx` unmodified — the production path.
 */
async function observeRealWorkload(
  projectRoot: string,
  runId: string,
  workload: Workload,
  bindings: (input: PgeRegistriesInput) => CodingBindings,
  options?: { readonly maxSupersteps?: number },
): Promise<{ measurement: Measurement; observed: GraphRunResult | null }> {
  const topology = await readValidatedTopologySpec(projectRoot, CODING_GRAPH_ID);

  let observed: GraphRunResult | null = null;
  // sc-10-2: populated by `recordingCommitBoundary` for EVERY channel this run's own
  // commits touch, regardless of how the run ends — a probe that throws mid-run still
  // leaves whatever was recorded before the throw, which is exactly what the null-outcome
  // branch below reports rather than discarding.
  const writeBytes = new Map<string, { maxBytes: number; writeCount: number }>();
  const recordingInterpreterFactory = (): GraphInterpreter => {
    const inner = createGraphInterpreter();
    const withOverride = (ctx: Parameters<GraphInterpreter["run"]>[2]) => ({
      ...ctx,
      ...(options?.maxSupersteps === undefined ? {} : { maxSupersteps: options.maxSupersteps }),
      commit: recordingCommitBoundary(ctx.commit, writeBytes),
    });
    return {
      run: async (graph, init, ctx) => {
        observed = await inner.run(graph, init, withOverride(ctx));
        return observed;
      },
      resume: async (graph, ref, resumeValue, ctx) => {
        observed = await inner.resume(graph, ref, resumeValue, withOverride(ctx));
        return observed;
      },
    };
  };

  let engineOutcome: EngineOutcome;
  try {
    const result = await withNetworkDisabled(() =>
      new PgeEngine({
        graphId: CODING_GRAPH_ID,
        clock: createFixedClock(FIXED_INSTANT),
        bindings,
        interpreterFactory: recordingInterpreterFactory,
      }).run("Wire the graph engine.", projectRoot, conformanceConfig(), { runId }),
    );
    engineOutcome = { kind: "resolved", success: result.success };
  } catch (error) {
    engineOutcome = { kind: "threw", errorClass: (error as Error).name };
  }

  const channelLimits: Record<string, number> = {};
  for (const channel of [...topology.channels].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    channelLimits[channel.id] = channel.maxInlineBytes;
  }

  // sc-2-3: the committed corpus lives under the REPOSITORY root, never under the seeded
  // temp `projectRoot` this run drives — see the corpus module's own header for why it is
  // not `.bober/golden/`.
  const corpus = await loadWorkloadCorpus(join(REPO_ROOT, WORKLOAD_DIR));
  if (corpus.errors.length > 0) {
    throw new Error(`the committed workload corpus does not load cleanly: ${corpus.errors.join("; ")}`);
  }
  const corpusMax = maxBytesPerChannel(corpus);
  const corpusHeadroom: Record<string, CorpusHeadroom> = {};
  for (const channelId of CORPUS_HEADROOM_CHANNELS) {
    const corpusMaxBytes = corpusMax[channelId];
    const declaredLimit = channelLimits[channelId];
    if (corpusMaxBytes === undefined || declaredLimit === undefined) {
      throw new Error(`no corpus entry (or no declared limit) for channel "${channelId}"`);
    }
    corpusHeadroom[channelId] = { corpusMaxBytes, declaredLimit, wouldReject: corpusMaxBytes > declaredLimit };
  }

  const workloadFacts = {
    specPath: relative(REPO_ROOT, REAL_SPEC_PATH),
    specId: workload.spec.specId,
    specCanonicalBytes: byteSize(workload.spec),
    contractCount: workload.contracts.length,
    contractsCanonicalBytes: byteSize(workload.contracts),
  };

  // sc-10-2: EVERY declared channel, not only `CORPUS_HEADROOM_CHANNELS` — a channel
  // `writeBytes` never saw a write for is reported with `writeCount: 0` rather than
  // omitted, so "not exercised by this workload" is a fact this measurement states rather
  // than a gap a reader has to notice on their own.
  const observedWrites: Record<string, ObservedChannelWrite> = {};
  for (const channel of [...topology.channels].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const observedForChannel = writeBytes.get(channel.id);
    observedWrites[channel.id] = {
      maxBytes: observedForChannel?.maxBytes ?? 0,
      writeCount: observedForChannel?.writeCount ?? 0,
      declaredLimit: channel.maxInlineBytes,
      wouldReject: (observedForChannel?.maxBytes ?? 0) > channel.maxInlineBytes,
    };
  }

  // sc-10-3: this run's OWN spans against the artifact's full node list — mirrors
  // `src/pge/golden/coverage.test.ts`'s `executedNodeIdsFromSpans` rule (status "ok" only)
  // applied to one real run rather than the golden dataset. Read regardless of how the run
  // ended, so a probe that throws mid-run (the two-directional ceiling pin below) still
  // reports whatever spans exist rather than an empty coverage record.
  const declaredNodeIds = topology.nodes.map((node) => node.id).sort();
  const allSpans = await readSpans(tracePath(projectRoot, runId));
  const executedNodeIds = [
    ...new Set(allSpans.filter((span) => span.status === "ok").map((span) => span.nodeId)),
  ].sort();
  const executedSet = new Set(executedNodeIds);
  const nodeCoverage: NodeCoverage = {
    totalNodes: declaredNodeIds.length,
    executedNodeIds,
    neverExecutedNodeIds: declaredNodeIds.filter((id) => !executedSet.has(id)),
  };

  // `observed` is populated by the recorder REGARDLESS of what PgeEngine.run did with the
  // result afterwards — that is the whole point of driving it through this seam. It stays
  // `null` only when the INTERPRETER ITSELF throws before ever returning a `GraphRunResult`
  // — as of sprint 4's ceiling raise, that happens ONLY under a deliberately lowered
  // `options.maxSupersteps` probe (the two-directional pin below); the production ceiling
  // this file's default calls use is now enough for this repository's own real workload.
  if (observed === null) {
    const measurement: Measurement = {
      formatVersion: 1,
      graph: { graphId: topology.graphId, graphVersion: topology.graphVersion },
      workload: workloadFacts,
      channelLimits,
      rejections: null,
      failures: null,
      terminalNodeId: null,
      status: null,
      verdict: null,
      specChannelNullAtBoundary: null,
      supersteps: null,
      superstepCeiling: superstepCeilingFacts(),
      engineOutcome,
      corpusHeadroom,
      observedWrites,
      nodeCoverage,
    };
    return { measurement, observed: null };
  }
  const run: GraphRunResult = observed;

  // Reuses `allSpans`, read once above (before the null-outcome branch) precisely so
  // `nodeCoverage` is available on both outcomes — never a second, independent read.
  const spans = allSpans;
  const last = spans[spans.length - 1];
  if (last === undefined) {
    throw new Error(`run "${runId}" produced no spans; the run did not execute`);
  }

  const rejections: RecordedRejection[] = run.commits.flatMap((commit) =>
    commit.rejected.map((rejection) => ({
      channel: rejection.channel,
      nodeId: rejection.nodeId,
      branchKey: rejection.branchKey,
      bytes: rejection.bytes,
      limit: rejection.limit,
      superstep: commit.superstep,
    })),
  );

  const failures: RecordedFailure[] = run.failures.map((failure) => ({
    nodeId: failure.nodeId,
    branchKey: failure.branchKey,
    superstep: failure.superstep,
    errorClass: failure.errorClass,
  }));

  const measurement: Measurement = {
    formatVersion: 1,
    graph: { graphId: topology.graphId, graphVersion: topology.graphVersion },
    workload: workloadFacts,
    channelLimits,
    rejections,
    failures,
    terminalNodeId: last.nodeId,
    status: run.status,
    verdict: run.status === "completed" ? run.verdict : null,
    specChannelNullAtBoundary: run.state.spec === null,
    supersteps: run.supersteps,
    superstepCeiling: superstepCeilingFacts(),
    engineOutcome,
    corpusHeadroom,
    observedWrites,
    nodeCoverage,
  };

  return { measurement, observed: run };
}

// ── sc-1-1, sc-1-2, sc-1-3, sc-1-5, sc-4-1, sc-4-2, sc-4-3, sc-4-7 ─────

describe("PgeEngine over this repository's own real workload (feat-1, feat-2)", () => {
  it(
    "reaches a real terminal node with zero StateBloatError failures, a non-null spec, and commits the measurement (sc-1-1, sc-1-2, sc-1-3, sc-1-5, sc-4-1, sc-4-2, sc-4-3, sc-4-7)",
    async () => {
      const projectRoot = await seededRoot();

      // Structural guard against the trap this sprint's briefing names: the runtime's OWN
      // fixture graph (src/pge/runtime/__fixtures__/golden-graph.ts:360,366) raises `spec`
      // to 8192 and `sprintContracts` to 65536, which would show FEWER rejections and look
      // healthier. Assert the loaded graph is the COMMITTED one, with every channel's cap
      // equal to capForCorpusMax of ITS OWN corpus maximum — measured off the loaded
      // artifact and the committed corpus, never off a hardcoded number here (sprint 3 of
      // spec-20260812-pge-real-workload-errors: `spec` and `sprintContracts` moved off the
      // shipped 4,096 default; the other eight channels did not).
      const topology = await readValidatedTopologySpec(projectRoot, CODING_GRAPH_ID);
      expect(topology.graphId).toBe("coding");
      expect(topology.channels.length).toBeGreaterThan(0);
      const guardCorpus = await loadWorkloadCorpus(join(REPO_ROOT, WORKLOAD_DIR));
      expect(guardCorpus.errors).toEqual([]);
      const guardCorpusMax = maxBytesPerChannel(guardCorpus);
      for (const channel of topology.channels) {
        const corpusMaxBytes = guardCorpusMax[channel.id];
        expect(corpusMaxBytes, `no corpus entry for channel "${channel.id}"`).toBeDefined();
        expect(channel.maxInlineBytes, `channel "${channel.id}" cap`).toBe(
          capForCorpusMax(corpusMaxBytes as number),
        );
      }

      const workload = await realWorkload();
      expect(workload.spec.specId).toBe("spec-20260805-pge-graph-engineering");
      // The real spec's own canonical size, not the derivation's number, and not the file's
      // on-disk byte count: >20_000 so a future edit to the spec cannot flip this the wrong
      // way, while still being nowhere near a fixture's byte count.
      expect(byteSize(workload.spec)).toBeGreaterThan(20_000);
      expect(workload.contracts.length).toBe(14);

      const { measurement, observed } = await observeRealWorkload(
        projectRoot,
        "run-real-workload",
        workload,
        (input) => realWorkloadBindings(input, workload),
      );

      // Non-vacuity: plan_materialize genuinely ran, so a `null`/empty rejection list could
      // not be an artefact of the node never being reached.
      const spans = await readSpans(tracePath(projectRoot, "run-real-workload"));
      expect(spans.some((span) => span.nodeId === "plan_materialize")).toBe(true);

      // sc-1-1: a real PgeEngine ran, over the committed artifact, with the real spec as the
      // planner's output. As of sprint 4's ceiling raise the run REACHES a terminal node —
      // `PGE_ENGINE_MAX_SUPERSTEPS` (`../pge-engine.ts`) is now what `PgeEngine.run`
      // configures, and it comfortably covers the measured natural cost below.
      expect(observed).not.toBeNull();
      expect(measurement.engineOutcome.kind).toBe("resolved");

      // sc-1-2 / sc-4-1: zero StateBloatError rejections. Both of this repository's own real
      // writes fit under their corpus-derived caps (sprint 3) — restated here as the exact
      // comparison the commit boundary itself performs, computed directly.
      expect(byteSize(workload.spec)).toBeLessThan(measurement.channelLimits.spec as number);
      expect(byteSize(workload.contracts)).toBeLessThan(measurement.channelLimits.sprintContracts as number);
      expect(measurement.rejections).toEqual([]);

      // sc-4-2: state.spec non-null and state.sprintContracts holding all 14 contracts, read
      // directly off the interpreter's own committed state — never off the measurement's
      // derived `specChannelNullAtBoundary` alone.
      expect(measurement.specChannelNullAtBoundary).toBe(false);
      expect(observed?.state.spec).not.toBeNull();
      expect(observed?.state.sprintContracts.length).toBe(14);

      // sc-1-3, sc-4-4: the terminal node and the verdict, read off the INTERPRETER's own
      // GraphRunResult. `graceful_failure`, explicitly NOT `finalize` — `commit` is still
      // FAIL_CLOSED-refused under the autopilot `noop` mechanism (a later sprint's
      // territory, not this one), and the ONLY recorded failure names exactly that refusal.
      expect(measurement.status).toBe("completed");
      expect(measurement.terminalNodeId).not.toBeNull();
      expect(measurement.terminalNodeId).not.toBe("finalize");
      expect(measurement.terminalNodeId).toBe("graceful_failure");
      expect(measurement.failures).toHaveLength(1);
      expect(measurement.failures?.[0]?.nodeId).toBe("commit");
      expect(measurement.failures?.[0]?.errorClass).toBe("FailClosed");

      // sc-4-3: the superstep cost, measured. Reproducible (pinned below against the
      // committed file) and comfortably under the shipped ceiling — the headroom this
      // sprint's function-derived cap exists to provide.
      expect(measurement.supersteps).toBe(MEASURED_REAL_WORKLOAD_SUPERSTEPS);
      expect(measurement.supersteps).toBeLessThan(PGE_ENGINE_MAX_SUPERSTEPS);
      // And the fact that MADE this a real defect rather than a hypothetical one: the
      // INTERPRETER's own pre-sprint-4 baseline genuinely was not enough.
      expect(DEFAULT_MAX_SUPERSTEPS).toBeLessThan(MEASURED_REAL_WORKLOAD_SUPERSTEPS);

      // Every one of the 14 dispatched branches settled `"succeeded"` on its first attempt
      // — sc-4-4's evidence that this is real work fully draining, not a stuck loop. A
      // branch that never settled, or settled after retries, would show up here.
      const branchStatus = observed?.state.branchStatus ?? {};
      expect(Object.keys(branchStatus).sort()).toEqual(
        workload.contracts.map((c) => c.contractId).sort(),
      );
      for (const [contractId, entry] of Object.entries(branchStatus)) {
        expect(entry.state, contractId).toBe("succeeded");
        expect(entry.attempts, contractId).toBe(1);
      }

      // sc-2-3: the measurement extended to messages, evaluations and refs under
      // corpus-sized payloads. Every one of `CORPUS_HEADROOM_CHANNELS` must have been
      // measured — an absent key would mean a channel silently escaped this extension.
      for (const channelId of CORPUS_HEADROOM_CHANNELS) {
        expect(measurement.corpusHeadroom[channelId], channelId).toBeDefined();
        expect(measurement.corpusHeadroom[channelId]?.declaredLimit).toBe(4096);
      }
      // Against this repository's own real payloads, only `spec` and `sprintContracts`
      // exceed the shipped 4096-byte cap (the rejections asserted above). `messages`,
      // `evaluations` and `refs` are comfortably under it — reported here rather than
      // engineered around, per this sprint's stopCondition.
      for (const channelId of CORPUS_HEADROOM_CHANNELS) {
        expect(measurement.corpusHeadroom[channelId]?.wouldReject, channelId).toBe(false);
      }

      // sc-10-2: EVERY declared channel — not only the three `CORPUS_HEADROOM_CHANNELS`
      // above cover — because `observedWrites` is keyed off `topology.channels` directly.
      expect(Object.keys(measurement.observedWrites).sort()).toEqual(
        Object.keys(measurement.channelLimits).sort(),
      );
      expect(Object.keys(measurement.observedWrites)).toHaveLength(11);

      // The carried finding (sprint 5's security audit, see the generator's completion
      // notes): one `evaluations` entry now carries THREE independent copies of unbounded
      // model text (`summary`, `evaluatorFeedback`, `generatorNotes` — the `bober:` comment
      // at `nodes/sprint-evaluate.ts` names the tripling explicitly). Measured here against
      // the ACTUAL bytes this run wrote, not the static corpus the earlier
      // `corpusHeadroom` block reads: `sprint_evaluate` genuinely ran with the tripled
      // shape (`writeCount` at least one per dispatched branch) and did NOT breach — this
      // stub-driven corpus's free text is short enough that even three copies stay far
      // under the cap. That is a fact about THIS measurement's stub collaborators, not a
      // guarantee about a real evaluator's longer output — see the generator's completion
      // notes for the distinction.
      expect(measurement.observedWrites.evaluations?.writeCount).toBeGreaterThanOrEqual(14);
      expect(measurement.observedWrites.evaluations?.maxBytes).toBeGreaterThan(0);
      expect(measurement.observedWrites.evaluations?.wouldReject).toBe(false);

      // `verdict`'s sole writer is `finalize` (`nodes/root.ts`'s own doc comment), and this
      // run never reaches it (see `nodeCoverage` below) — so `verdict`'s cap is measured as
      // NEVER EXERCISED here, not as "measured and found small". Stated explicitly rather
      // than left for a reader to notice a `wouldReject: false` can mean either.
      expect(measurement.observedWrites.verdict?.writeCount).toBe(0);
      expect(measurement.observedWrites.verdict?.maxBytes).toBe(0);

      // sc-10-2 / this sprint's stopCondition: every channel this run wrote to stayed under
      // its declared cap. Had any come back `true`, the obligation was to report the
      // breach, not raise the cap that caught it — this loop is what would have surfaced
      // one.
      for (const [channelId, write] of Object.entries(measurement.observedWrites)) {
        expect(write.wouldReject, channelId).toBe(false);
      }

      // sc-10-3: this run's OWN node coverage — deliberately NOT the golden dataset's
      // 42/44 (`src/pge/golden/coverage.test.ts`'s `NEVER_EXECUTED`), because one real run
      // takes one path through the graph. Six of these eight ARE reachable (proven by a
      // golden case each: `commit`/`finalize` under `goldenApprovedConfig()`,
      // `critique`/`rework_route` under a corrected-then-still-failing sprint,
      // `sprint_correct` under any correction, `plan_clarify` under a clarifying planner) —
      // this workload's own stub collaborators and its plain (non-approved) config just
      // never trigger any of the six. Only `context_compact` and `synthesize` are the
      // golden dataset's OWN structural blocks. See the generator's completion notes and
      // docs/pge-graph.md's "The real workload's own node coverage" section for the reason
      // recorded against each one.
      expect(measurement.nodeCoverage.totalNodes).toBe(44);
      expect(measurement.nodeCoverage.neverExecutedNodeIds).toEqual([
        "commit",
        "context_compact",
        "critique",
        "finalize",
        "plan_clarify",
        "rework_route",
        "sprint_correct",
        "synthesize",
      ]);
      expect(measurement.nodeCoverage.executedNodeIds).toHaveLength(36);
      expect(
        measurement.nodeCoverage.totalNodes - measurement.nodeCoverage.neverExecutedNodeIds.length,
      ).toBe(measurement.nodeCoverage.executedNodeIds.length);

      // sc-4-3, sc-4-4: the contract-count scaling comparison — the single experiment that
      // distinguishes INSUFFICIENT CEILING from NON-CONVERGENCE. A 1-contract slice of the
      // SAME committed workload, driven through the SAME harness, at a fresh seeded root.
      const soleContract = workload.contracts.slice(0, 1);
      expect(soleContract).toHaveLength(1);
      const soleRoot = await seededRoot();
      const { measurement: soleMeasurement, observed: soleObserved } = await observeRealWorkload(
        soleRoot,
        "run-real-workload-1-contract",
        { spec: workload.spec, contracts: soleContract },
        (input) => realWorkloadBindings(input, { spec: workload.spec, contracts: soleContract }),
      );
      expect(soleObserved).not.toBeNull();
      expect(soleMeasurement.supersteps).not.toBeNull();
      expect(soleMeasurement.terminalNodeId).toBe("graceful_failure");
      // The relationship sc-4-3 asks for, reported rather than argued: supersteps scale
      // with the declared work (14 real, cross-contract-dependent branches cost strictly
      // more than 1 trivial one), not held constant regardless of contract count — the
      // signature NON-CONVERGENCE would NOT show.
      expect(soleMeasurement.supersteps as number).toBeLessThan(measurement.supersteps as number);
      expect(Object.keys(soleObserved?.state.branchStatus ?? {})).toEqual([soleContract[0]?.contractId]);
      expect(soleObserved?.state.branchStatus[soleContract[0]?.contractId as string]?.state).toBe("succeeded");

      const contractCountScaling: ContractCountScalingEntry[] = [
        {
          contractCount: 1,
          supersteps: soleMeasurement.supersteps as number,
          terminalNodeId: soleMeasurement.terminalNodeId as string,
          status: soleMeasurement.status,
        },
        {
          contractCount: workload.contracts.length,
          supersteps: measurement.supersteps as number,
          terminalNodeId: measurement.terminalNodeId as string,
          status: measurement.status,
        },
      ];

      const committedMeasurement: CommittedMeasurement = { ...measurement, contractCountScaling };
      const bytes = measurementJson(committedMeasurement);
      if (MEASURING) {
        await writeFile(MEASUREMENT_PATH, bytes, "utf-8");
        return;
      }

      let committed: string | null;
      try {
        committed = await readFile(MEASUREMENT_PATH, "utf-8");
      } catch {
        committed = null;
      }
      expect(
        committed,
        `${MEASUREMENT_PATH} is not committed; run MEASURE_REAL_WORKLOAD=1 npx vitest run src/pge/engine/real-workload.test.ts`,
      ).not.toBeNull();
      expect(bytes).toBe(committed);
    },
    120_000,
  );
});

// ── sc-1-4 ──────────────────────────────────────────────────────────

describe("reproducibility (sc-1-4)", () => {
  it(
    "two independent runs against unchanged inputs produce byte-identical measurement output",
    async () => {
      const workload = await realWorkload();
      const rootA = await seededRoot();
      const rootB = await seededRoot();

      const { measurement: a } = await observeRealWorkload(rootA, "run-repro-a", workload, (input) =>
        realWorkloadBindings(input, workload),
      );
      const { measurement: b } = await observeRealWorkload(rootB, "run-repro-b", workload, (input) =>
        realWorkloadBindings(input, workload),
      );

      // Two DIFFERENT seeded roots and two DIFFERENT run ids — neither appears in the
      // measurement, so byte-identical output here also proves neither leaked in. Also
      // proves the supersteps count itself is deterministic (sc-4-3): a run whose cost
      // depended on scheduling order would break this the moment it stopped agreeing.
      expect(a.supersteps).not.toBeNull();
      expect(a.supersteps).toBe(b.supersteps);
      expect(measurementJson({ ...a, contractCountScaling: [] })).toBe(
        measurementJson({ ...b, contractCountScaling: [] }),
      );
    },
    120_000,
  );
});

// ── NFR: the network and collaborator doors are genuinely shut ────────

describe("the collaborator doors are shut", () => {
  it(
    "a reached collaborator fails the run by name, as GoldenBindingInvokedError",
    async () => {
      const workload = await realWorkload();
      const projectRoot = await seededRoot();

      const refuse =
        (binding: string): (() => never) =>
        () => {
          throw new GoldenBindingInvokedError(binding);
        };

      const { observed } = await observeRealWorkload(projectRoot, "run-refuse-materialize", workload, (input) => ({
        ...realWorkloadBindings(input, workload),
        materialize: refuse("materialize"),
      }));

      // The refusal happens INSIDE materialize's own node body, before any large write is
      // ever attempted, so the interpreter completes (routing on the recorded failure)
      // rather than running long enough to trip the runaway guard — unaffected by this
      // sprint's cap change.
      expect(observed, "the interpreter must have produced a result for this scenario").not.toBeNull();
      const named = observed?.failures.find((failure) => failure.errorClass === "GoldenBindingInvokedError");
      expect(named, JSON.stringify(observed?.failures)).toBeDefined();
      expect(named?.message).toContain("materialize");
    },
    120_000,
  );
});

// ── The harness measures the declared cap, not a hardcoded number ─────

describe("the harness reads each channel's own declared limit", () => {
  it(
    "LOWERING the spec channel's cap in a LOCAL COPY of the artifact re-introduces exactly the spec rejection",
    async () => {
      const workload = await realWorkload();
      const projectRoot = await seededRoot();

      // A mutation of a COPY inside a throwaway temp root — the committed
      // .bober/topology/coding.json is never touched, and no cap this sprint reports is
      // lowered on the shipped artifact (nonGoal 1). The checksum is recomputed through the
      // shipped canonicalize/checksum helpers, exactly as `dumpTopology` would, so the
      // mutated copy is a legitimately re-signed artifact rather than a stale one
      // `readValidatedTopologySpec` would refuse for `ChecksumStale` before the engine ever
      // sees it.
      //
      // LOWERED rather than raised (sprint 3): the shipped `spec` cap already admits this
      // repository's own real spec (proven above — byteSize < the declared cap) — raising it
      // further would prove nothing new. Lowering it below the real spec's own byte size
      // reproduces the pre-sprint-3 rejection deliberately: the same proof, "the harness
      // reads each channel's OWN declared limit," and one that survives any future
      // corpus-driven cap value without editing.
      const artifactPath = join(projectRoot, ".bober", "topology", "coding.json");
      const raw = JSON.parse(await readFile(artifactPath, "utf-8")) as Record<string, unknown>;
      const specBytes = byteSize(workload.spec);
      const channels = (raw.channels as Array<{ id: string; maxInlineBytes: number }>).map((channel) =>
        channel.id === "spec" ? { ...channel, maxInlineBytes: specBytes - 1 } : channel,
      );
      const parsed: TopologySpec = TopologySpecSchema.parse({ ...raw, channels });
      const resigned: TopologySpec = { ...parsed, checksum: checksumTopology(parsed) };
      await writeFile(artifactPath, serializeTopology(resigned), "utf-8");

      const { measurement } = await observeRealWorkload(projectRoot, "run-mutated-cap", workload, (input) =>
        realWorkloadBindings(input, workload),
      );

      // With `spec` rejected again, `state.spec` is null at the boundary gate the same way
      // it was before this sprint, so the run completes quickly via the same short route
      // rather than running long enough to trip the runaway guard.
      expect(measurement.rejections, "the mutated run must complete for this control to mean anything").not.toBeNull();
      const rejectedChannels = new Set((measurement.rejections ?? []).map((r) => r.channel));
      expect(rejectedChannels.has("spec")).toBe(true);
      // sprintContracts' cap is untouched and still admits the real 14 contracts, so its
      // write does NOT reject here — proving this harness reads each channel's OWN declared
      // limit rather than one constant shared by all ten.
      expect(rejectedChannels.has("sprintContracts")).toBe(false);
    },
    120_000,
  );
});

// ── sc-4-5: the superstep ceiling is pinned two-directionally ─────────

describe("the superstep ceiling has a measured basis, pinned two-directionally (sc-4-5)", () => {
  it("PGE_ENGINE_MAX_SUPERSTEPS equals a pure function of the measured cost, never a hand-picked literal", () => {
    expect(PGE_ENGINE_MAX_SUPERSTEPS).toBe(superstepsForMeasuredCost(MEASURED_REAL_WORKLOAD_SUPERSTEPS));
    // HEADROOM: comfortably above the measured cost, by the declared factor.
    expect(PGE_ENGINE_MAX_SUPERSTEPS).toBeGreaterThanOrEqual(
      MEASURED_REAL_WORKLOAD_SUPERSTEPS * SUPERSTEP_HEADROOM_FACTOR,
    );
    // FLOOR: the function never lowers the interpreter's own runaway guard, proven by a
    // measured cost small enough that only the floor could produce the result.
    expect(superstepsForMeasuredCost(1)).toBe(DEFAULT_MAX_SUPERSTEPS);
    // SENSITIVITY: the function is not a constant wearing a parameter — two different
    // measured costs the shipped headroom factor pushes across a power-of-two boundary
    // produce two different ceilings.
    expect(superstepsForMeasuredCost(1000)).not.toBe(PGE_ENGINE_MAX_SUPERSTEPS);
    expect(superstepsForMeasuredCost(1000)).toBeGreaterThan(PGE_ENGINE_MAX_SUPERSTEPS);
  });

  it(
    "LOWERING the ceiling below the measured cost reproduces exactly SuperstepLimitExceededError, over the SAME real workload",
    async () => {
      const workload = await realWorkload();
      const projectRoot = await seededRoot();

      // The interpreter's OWN pre-sprint-4 baseline — not a number invented for this test —
      // driven through the SAME `observeRealWorkload` seam every other test in this file
      // uses, via its `maxSupersteps` probe option. Nothing here lowers the SHIPPED
      // `PGE_ENGINE_MAX_SUPERSTEPS` constant or anything `PgeEngine.run` itself configures.
      const { measurement, observed } = await observeRealWorkload(
        projectRoot,
        "run-lowered-ceiling",
        workload,
        (input) => realWorkloadBindings(input, workload),
        { maxSupersteps: DEFAULT_MAX_SUPERSTEPS },
      );

      expect(observed).toBeNull();
      expect(measurement.engineOutcome).toEqual({ kind: "threw", errorClass: "SuperstepLimitExceededError" });
      expect(measurement.supersteps).toBeNull();
    },
    120_000,
  );
});
