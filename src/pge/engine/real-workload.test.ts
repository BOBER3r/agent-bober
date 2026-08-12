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
import { createGraphInterpreter } from "../runtime/interpreter.js";
import type { GraphInterpreter, GraphRunResult } from "../runtime/interpreter.js";
import { withNetworkDisabled } from "../runtime/replay.js";
import { readSpans, tracePath } from "../runtime/trace.js";
import { checksumTopology } from "../topology/canonical.js";
import { serializeTopology } from "../topology/dump.js";
import { PgeEngine, readValidatedTopologySpec } from "./pge-engine.js";
import type { PgeRegistriesInput } from "./pge-engine.js";
import { CODING_GRAPH_ID, REPO_ROOT, conformanceConfig, seedCommittedArtifact } from "./__fixtures__/whole-graph.js";
import { REAL_SPEC_PATH, realWorkload, realWorkloadBindings } from "./__fixtures__/real-workload.js";
import type { Workload } from "./__fixtures__/real-workload.js";

/** The instant every run in this file is frozen at, through the engine's own clock seam. */
const FIXED_INSTANT = "2026-08-12T00:00:00.000Z";

/** The committed measurement artifact — sc-1-2, sc-1-3, sc-1-4. */
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
   * There is no rejection list, terminal node, status or verdict to read off a result that
   * was never produced.
   */
  readonly rejections: readonly RecordedRejection[] | null;
  readonly failures: readonly RecordedFailure[] | null;
  readonly terminalNodeId: string | null;
  readonly status: GraphRunResult["status"] | null;
  readonly verdict: string | null;
  readonly specChannelNullAtBoundary: boolean | null;
  readonly engineOutcome: EngineOutcome;
  readonly corpusHeadroom: Record<string, CorpusHeadroom>;
}

/** One writer for the file and for the compare, exactly `goldenCaseJson`'s shape. */
function measurementJson(measurement: Measurement): string {
  return `${JSON.stringify(measurement, null, 2)}\n`;
}

/**
 * Drive a real `PgeEngine` over `projectRoot`'s committed `coding` artifact and measure
 * what the run actually did, reading every fact off the INTERPRETER's own `GraphRunResult`
 * — captured through `interpreterFactory`, the seam that exists for exactly this — and
 * never off the `PipelineResult` `PgeEngine.run` returns (which discards `.verdict` and
 * `.failures`, see the file header).
 */
async function observeRealWorkload(
  projectRoot: string,
  runId: string,
  workload: Workload,
  bindings: (input: PgeRegistriesInput) => CodingBindings,
): Promise<{ measurement: Measurement; observed: GraphRunResult | null }> {
  const topology = await readValidatedTopologySpec(projectRoot, CODING_GRAPH_ID);

  let observed: GraphRunResult | null = null;
  const recordingInterpreterFactory = (): GraphInterpreter => {
    const inner = createGraphInterpreter();
    return {
      run: async (graph, init, ctx) => {
        observed = await inner.run(graph, init, ctx);
        return observed;
      },
      resume: async (graph, ref, resumeValue, ctx) => {
        observed = await inner.resume(graph, ref, resumeValue, ctx);
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

  // `observed` is populated by the recorder REGARDLESS of what PgeEngine.run did with the
  // result afterwards — that is the whole point of driving it through this seam. It stays
  // `null` only when the INTERPRETER ITSELF throws before ever returning a `GraphRunResult`.
  //
  // sprint 3's own discovery, recorded rather than chased (this sprint's contract is
  // `maxInlineBytes` only): raising `spec` and `sprintContracts` far enough that
  // `plan_materialize`'s writes now fit under their caps lets this run proceed past the
  // point that used to end it early (the old 4,096-byte cap rejected both writes at
  // superstep 12, and the routing that followed reached `graceful_failure` within a
  // handful of supersteps). With both writes admitted, the 14-contract fan-out through the
  // sprint subgraph runs long enough to trip the interpreter's own runaway guard —
  // `SuperstepLimitExceededError` at `DEFAULT_MAX_SUPERSTEPS = 200`
  // (`src/pge/runtime/interpreter.ts`) — before reaching any terminal node. That is a
  // materially different fact from `commit.finalize` throwing on a COMPLETED run: there is
  // no `GraphRunResult` to read a rejection list, a terminal node or a verdict off, so
  // those fields are `null` here rather than guessed at.
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
      engineOutcome,
      corpusHeadroom,
    };
    return { measurement, observed: null };
  }
  const run: GraphRunResult = observed;

  const spans = await readSpans(tracePath(projectRoot, runId));
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
    engineOutcome,
    corpusHeadroom,
  };

  return { measurement, observed: run };
}

// ── sc-1-1, sc-1-2, sc-1-3, sc-1-5 ─────────────────────────────────────

describe("PgeEngine over this repository's own real workload (feat-1)", () => {
  it(
    "observes the rejected writes, the terminal node and the verdict off GraphRunResult, and commits the measurement (sc-1-1, sc-1-2, sc-1-3, sc-1-5)",
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
      // planner's output — proven by the trace above. `observed` itself is `null` for THIS
      // run (see `observeRealWorkload`'s own comment): the interpreter runs long enough past
      // `plan_materialize` to trip `SuperstepLimitExceededError` before ever returning a
      // `GraphRunResult`, so there is no `.commits` to inspect this time.
      expect(observed).toBeNull();
      expect(measurement.engineOutcome).toEqual({ kind: "threw", errorClass: "SuperstepLimitExceededError" });

      // sc-1-2, restated for the corpus-derived caps this sprint ships: the exact comparison
      // the commit boundary itself performs (byteSize vs the channel's declared cap,
      // commit.ts:366-378), computed directly rather than read off a rejection list that no
      // longer exists for this run. Both of this repository's own real writes now fit under
      // their caps — plan_materialize's writes are no longer rejected, which is the fix this
      // sprint ships. What happens to the run AFTER that (below) is a separate fact.
      expect(byteSize(workload.spec)).toBeLessThan(measurement.channelLimits.spec as number);
      expect(byteSize(workload.contracts)).toBeLessThan(measurement.channelLimits.sprintContracts as number);

      // sc-1-3 / sc-1-5, restated: no `GraphRunResult` exists for this run (see above), so
      // there is no terminal node, status, verdict or `spec`-null-at-boundary fact to read.
      // This IS the observation — a future run of this exact test that observes something
      // else fails these lines FIRST, which is what makes it safe to commit the measurement
      // unchanged rather than adjust it. See the generator's completion notes for why this
      // is recorded rather than chased.
      expect(measurement.rejections).toBeNull();
      expect(measurement.failures).toBeNull();
      expect(measurement.terminalNodeId).toBeNull();
      expect(measurement.status).toBeNull();
      expect(measurement.specChannelNullAtBoundary).toBeNull();

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

      const bytes = measurementJson(measurement);
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
      // measurement, so byte-identical output here also proves neither leaked in.
      expect(measurementJson(a)).toBe(measurementJson(b));
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
