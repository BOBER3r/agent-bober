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

import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TopologySpec } from "../../contracts/topology.js";
import { TopologySpecSchema } from "../../contracts/topology.js";
import { GoldenBindingInvokedError } from "../golden/executor.js";
import { canonicalJson } from "../registry/reducers.js";
import type { CodingBindings } from "../registry/index.js";
import { createFixedClock } from "../runtime/commit.js";
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

/** The exact boundary the commit boundary measures against: canonical bytes, not file bytes. */
function byteSize(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), "utf8");
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
  readonly rejections: readonly RecordedRejection[];
  readonly failures: readonly RecordedFailure[];
  readonly terminalNodeId: string;
  readonly status: GraphRunResult["status"];
  readonly verdict: string | null;
  readonly specChannelNullAtBoundary: boolean;
  readonly engineOutcome: EngineOutcome;
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
): Promise<{ measurement: Measurement; observed: GraphRunResult }> {
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

  // `observed` is populated by the recorder REGARDLESS of what PgeEngine.run did with the
  // result afterwards — that is the whole point of driving it through this seam.
  if (observed === null) {
    throw new Error(`run "${runId}" never reached the interpreter's own result`);
  }
  const run: GraphRunResult = observed;

  const spans = await readSpans(tracePath(projectRoot, runId));
  const last = spans[spans.length - 1];
  if (last === undefined) {
    throw new Error(`run "${runId}" produced no spans; the run did not execute`);
  }

  const channelLimits: Record<string, number> = {};
  for (const channel of [...topology.channels].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    channelLimits[channel.id] = channel.maxInlineBytes;
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
    workload: {
      specPath: relative(REPO_ROOT, REAL_SPEC_PATH),
      specId: workload.spec.specId,
      specCanonicalBytes: byteSize(workload.spec),
      contractCount: workload.contracts.length,
      contractsCanonicalBytes: byteSize(workload.contracts),
    },
    channelLimits,
    rejections,
    failures,
    terminalNodeId: last.nodeId,
    status: run.status,
    verdict: run.status === "completed" ? run.verdict : null,
    specChannelNullAtBoundary: run.state.spec === null,
    engineOutcome,
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
      // healthier. Assert the loaded graph is the COMMITTED one, with every channel still
      // at the shipped 4096 — measured off the loaded artifact, never off a list here.
      const topology = await readValidatedTopologySpec(projectRoot, CODING_GRAPH_ID);
      expect(topology.graphId).toBe("coding");
      expect(topology.channels.length).toBeGreaterThan(0);
      for (const channel of topology.channels) {
        expect(channel.maxInlineBytes, `channel "${channel.id}" cap`).toBe(4096);
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

      // Non-vacuity: plan_materialize genuinely ran, so an empty rejection list could not be
      // an artefact of the node never being reached.
      const spans = await readSpans(tracePath(projectRoot, "run-real-workload"));
      expect(spans.some((span) => span.nodeId === "plan_materialize")).toBe(true);

      // sc-1-1: a real PgeEngine ran, over the committed artifact, with the real spec as the
      // planner's output — proven by the interpreter having committed at least one superstep.
      expect(observed.commits.length).toBeGreaterThan(0);

      // sc-1-2: every rejection carries the four required fields, read off StateBloatError.
      expect(measurement.rejections.length).toBeGreaterThan(0);
      for (const rejection of measurement.rejections) {
        expect(rejection.limit).toBe(4096);
        expect(rejection.bytes).toBeGreaterThan(rejection.limit);
      }
      const rejectedChannels = new Set(measurement.rejections.map((r) => r.channel));
      expect(rejectedChannels.has("spec")).toBe(true);
      expect(rejectedChannels.has("sprintContracts")).toBe(true);

      // sc-1-3: terminal node and the boundary fact about `spec`, read off GraphRunResult
      // and the trace — never off the PipelineResult PgeEngine.run returns.
      expect(measurement.terminalNodeId).toBeTruthy();
      expect(measurement.specChannelNullAtBoundary).toBe(true);

      // sc-1-5: the derivation says a rejected `spec` write leaves state.spec null at the
      // gate, which routes to graceful_failure, which is OVER (status "completed") with
      // spec still null — so PgeEngine.run's own unconditional `commit.finalize` call is
      // expected to REJECT with FinalizeWithoutSpecError (commit.ts:436). This assertion IS
      // the observation: if a future run of this exact test observes something else, this
      // line fails FIRST, loudly, before the measurement below is ever written — which is
      // what makes it safe to commit the measurement unchanged rather than adjust it.
      expect(measurement.status).toBe("completed");
      expect(measurement.engineOutcome).toEqual({
        kind: "threw",
        errorClass: "FinalizeWithoutSpecError",
      });

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

      const named = observed.failures.find((failure) => failure.errorClass === "GoldenBindingInvokedError");
      expect(named, JSON.stringify(observed.failures)).toBeDefined();
      expect(named?.message).toContain("materialize");
    },
    120_000,
  );
});

// ── The harness measures the declared cap, not a hardcoded number ─────

describe("the harness reads each channel's own declared limit", () => {
  it(
    "raising the spec channel's cap in a LOCAL COPY of the artifact removes exactly the spec rejection",
    async () => {
      const workload = await realWorkload();
      const projectRoot = await seededRoot();

      // A mutation of a COPY inside a throwaway temp root — the committed
      // .bober/topology/coding.json is never touched, and no cap this sprint reports is
      // raised (nonGoal 1). The checksum is recomputed through the shipped
      // canonicalize/checksum helpers, exactly as `dumpTopology` would, so the mutated copy
      // is a legitimately re-signed artifact rather than a stale one `readValidatedTopologySpec`
      // would refuse for `ChecksumStale` before the engine ever sees it.
      const artifactPath = join(projectRoot, ".bober", "topology", "coding.json");
      const raw = JSON.parse(await readFile(artifactPath, "utf-8")) as Record<string, unknown>;
      const specBytes = byteSize(workload.spec);
      const channels = (raw.channels as Array<{ id: string; maxInlineBytes: number }>).map((channel) =>
        channel.id === "spec" ? { ...channel, maxInlineBytes: specBytes + 1024 } : channel,
      );
      const parsed: TopologySpec = TopologySpecSchema.parse({ ...raw, channels });
      const resigned: TopologySpec = { ...parsed, checksum: checksumTopology(parsed) };
      await writeFile(artifactPath, serializeTopology(resigned), "utf-8");

      const { measurement } = await observeRealWorkload(projectRoot, "run-mutated-cap", workload, (input) =>
        realWorkloadBindings(input, workload),
      );

      const rejectedChannels = new Set(measurement.rejections.map((r) => r.channel));
      expect(rejectedChannels.has("spec")).toBe(false);
      // sprintContracts' cap is untouched, so its rejection survives — proving this harness
      // reads each channel's OWN declared limit rather than one constant shared by all ten.
      expect(rejectedChannels.has("sprintContracts")).toBe(true);
    },
    120_000,
  );
});
