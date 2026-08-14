// ── The capture step — how a `replay` golden case comes into existence ──

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONFORMANCE_FIELDS } from "../../orchestrator/workflow/types.js";
import { redactProjectRoot } from "../../orchestrator/workflow/conformance.js";
import { PgeEngine } from "../engine/pge-engine.js";
import type { PgeRegistriesInput } from "../engine/pge-engine.js";
import { createEffectRegistry } from "../registry/effects.js";
import type { CodingBindings } from "../registry/index.js";
import { createRunRecorder } from "../runtime/replay.js";
import type { RecordedCall } from "../runtime/replay.js";
import { readSpans, tracePath } from "../runtime/trace.js";
import { createScratchStore } from "../runtime/scratch.js";
import { CODING_GRAPH_ID } from "../topology/coding.graph.js";
import { GOLDEN_CASE_FORMAT_VERSION } from "./case-schema.js";
import type { GoldenArtifacts, GoldenCase } from "./case-schema.js";
import type { GoldenRunArtifacts } from "./runner.js";
import {
  GOLDEN_RUN_ID,
  goldenSandbox,
  resolveGoldenConfig,
  seedGoldenRoot,
  withGoldenApproval,
} from "./executor.js";

/**
 * Turns a real `PgeEngine` run into a committed `replay` golden case.
 *
 * This is the capture step earlier sprints named and did not build, and building it is
 * what turned the pass-rate half of the blocking CI job from an announcement into a gate.
 * The shape of the problem is worth stating, because it is not obvious:
 *
 *  1. A REPLAY answers every outward call from the recording, so it only produces the
 *     artifacts the run's own machinery writes — the commit boundary's channel writes and
 *     `finalize`'s terminal writes. The artifacts a COLLABORATOR writes (a briefing, a
 *     review, an eval result) are written inside the effect, which a replay does not
 *     perform.
 *  2. So an expectation captured from the RECORDED run would never be reproduced by a
 *     replay of it, and every case would fail forever.
 *
 * Hence two runs per case: a RECORDED one with real collaborator bindings to obtain the
 * pins, then a REPLAY of those pins whose artifacts become `expected.artifacts`. What the
 * committed case then asserts is exactly what the gate can check — that the same pinned
 * answers, fed through the same graph, still leave the same artifacts behind.
 *
 * ── This is a change detector, and that is the whole point ──
 *
 * A captured expectation is captured from the code under test, so it cannot prove the
 * behaviour is CORRECT — only that it has not changed. Recapture is therefore a deliberate
 * act with a visible diff: `GOLDEN_CAPTURE=1` rewrites the committed cases, and the diff
 * is the statement "these artifacts changed and here is how". A recapture pushed without
 * reading that diff defeats the gate exactly as surely as deleting it.
 *
 * ── The bindings are the caller's ──
 *
 * `capture` takes its collaborator set as an argument and ships none. A capture needs
 * bodies that answer deterministically (the golden executor's own bindings all throw, by
 * design), and choosing them decides what scenario the case describes — which is the
 * caller's business, not this module's. `src/pge/engine/__fixtures__/whole-graph.ts` is
 * the set this repository captures with.
 */

// ── Input ───────────────────────────────────────────────────────────

export interface GoldenCaptureInput {
  /** The checkout the committed artifact is read from. */
  readonly projectRoot: string;
  readonly caseId: string;
  readonly title: string;
  readonly intent: string;
  readonly tags: readonly string[];
  /** Why this expectation is what it is, for the reader of a failing diff. */
  readonly notes: string;
  readonly featureRequest: string;
  /**
   * The collaborator set the RECORDED run uses. The replay never invokes one.
   *
   * `sandbox` is overridden with {@link goldenSandbox} on both runs, so capture and replay
   * are given the same fixed process outcome — see that function.
   */
  readonly bindings: (input: PgeRegistriesInput) => CodingBindings;
  readonly graphId?: string;
  /**
   * Opts the recorded run (and the replay that derives its expectation) into
   * {@link resolveGoldenConfig}'s approved config, and is written verbatim into the
   * committed case's `input.config` so a later replay resolves the identical config.
   * Absent means the case runs under the autopilot default, exactly as every case did
   * before this field existed.
   */
  readonly configInput?: Readonly<Record<string, unknown>>;
}

export interface GoldenCaptureResult {
  readonly goldenCase: GoldenCase;
  /** Every call the recorded run made, in invocation order. */
  readonly calls: readonly RecordedCall[];
  /** The node the recorded run's last span belongs to. */
  readonly terminalNodeId: string;
}

// ── Capture ─────────────────────────────────────────────────────────

/** The eleven fields in sorted key order, so the emitted JSON is already canonical. */
function sortedArtifacts(produced: GoldenRunArtifacts): GoldenArtifacts {
  const out: Record<string, readonly unknown[]> = {};
  for (const field of [...CONFORMANCE_FIELDS].sort()) out[field] = produced[field] ?? [];
  return out as GoldenArtifacts;
}

/**
 * Record a run, replay it, and emit the case.
 *
 * The emitted case is NOT parsed here. `capture.test.ts` parses it through
 * `GoldenCaseSchema` before writing it, so a capture that produced something the dataset
 * would reject fails at the moment of capture rather than at the next CI run.
 */
export async function captureGoldenCase(
  input: GoldenCaptureInput,
): Promise<GoldenCaptureResult> {
  const graphId = input.graphId ?? CODING_GRAPH_ID;

  // ── 1. The recorded run: real bindings, every call written down ──
  const recordRoot = await mkdtemp(join(tmpdir(), `golden-capture-${input.caseId.slice(0, 24)}-`));
  let calls: RecordedCall[];
  let terminalNodeId: string;
  let graphVersion: string;
  let entryNodeId: string;
  try {
    const spec = await seedGoldenRoot(input.projectRoot, recordRoot, graphId);
    graphVersion = spec.graphVersion;
    // The entry the executor requires: the graph's OWN, read from the artifact so a
    // topology that moves its entry moves every captured case with it.
    entryNodeId = spec.entry;
    const recorder = createRunRecorder({
      runId: GOLDEN_RUN_ID,
      scratch: createScratchStore(recordRoot),
    });

    // The SAME resolution the replay half uses (`executor.ts`'s `createGoldenExecutor`), so
    // a case's recorded run and the replay that derives its expectation can never disagree
    // about which config produced them.
    const config = resolveGoldenConfig(input.configInput);

    await withGoldenApproval(recordRoot, input.configInput !== undefined, () =>
      new PgeEngine({
        graphId,
        registries: async (registryInput) => {
          const { codingRegistries } = await import("../registry/index.js");
          const bound = input.bindings(registryInput);
          const registries = codingRegistries(registryInput.spec, {
            ...bound,
            runtime: {
              ...bound.runtime,
              sandbox: goldenSandbox(registryInput.scratch, registryInput.runId),
            },
          });
          return {
            ...registries,
            effects: recorder.effects(registries.effects ?? createEffectRegistry()),
          };
        },
      }).run(input.featureRequest, recordRoot, config, { runId: GOLDEN_RUN_ID }),
    );

    // The recorded root is a throwaway `mkdtemp` directory and it appears inside recorded
    // requests (`projectRoot`) and occasionally inside responses (a written path). Left in,
    // every capture would differ from the last for a reason that is not a behaviour change,
    // and the committed case would be unusable on any machine but the one that wrote it.
    // Redacted through the harness's own redactor, so the placeholder is the same one the
    // artifact comparison uses. Requests are never compared by a replay; responses are, and
    // the expectation below is produced from these same redacted responses, so both sides
    // are consistent by construction.
    //
    // NOT normalized, and that is a decision with a failure behind it. The shipped writers
    // stamp a wall clock into the values they hand back, so an unfrozen capture drifts —
    // but stripping those keys the way the artifact comparison does breaks the REPLAY:
    // `PlanSpecSchema` requires `createdAt`, so a stripped `planner.draft` response never
    // becomes a spec and the run dies in `finalize` with `FinalizeWithoutSpecError`. A pin
    // is an INPUT to a run and has to satisfy the schemas the run parses it with, which is
    // a stricter obligation than an expectation's. The clock is frozen by the caller
    // instead — see `capture.test.ts`.
    calls = await Promise.all(
      recorder.calls().map(async (call) => ({
        ...call,
        request: await redactProjectRoot(call.request, recordRoot),
        response: await redactProjectRoot(call.response, recordRoot),
      })),
    );

    // The node the run came to rest on, read off the trace rather than assumed. Recorded
    // for the reader of a failing case; the comparison itself is over the artifacts.
    const spans = await readSpans(tracePath(recordRoot, GOLDEN_RUN_ID));
    const last = spans[spans.length - 1];
    if (last === undefined) {
      throw new Error(`capture of "${input.caseId}" produced no spans; the run did not execute`);
    }
    terminalNodeId = last.nodeId;
  } finally {
    await rm(recordRoot, { recursive: true, force: true });
  }

  if (calls.length === 0) {
    throw new Error(
      `capture of "${input.caseId}" recorded no outward calls; a case that pins nothing exercises nothing`,
    );
  }

  // ── 2. The replay: the artifacts the committed expectation is made of ──
  //
  // Deliberately through the SHIPPED executor rather than a private second wiring — the
  // expectation is then produced by the very function the gate will run, so a capture
  // cannot pin artifacts the gate could never reproduce.
  const { createGoldenExecutor } = await import("./executor.js");
  const execute = await createGoldenExecutor({ projectRoot: input.projectRoot, graphId });

  const draft: GoldenCase = {
    formatVersion: GOLDEN_CASE_FORMAT_VERSION,
    caseId: input.caseId,
    title: input.title,
    intent: input.intent,
    tags: [...input.tags],
    enforcement: "replay",
    graph: { graphId, graphVersion },
    input: {
      featureRequest: input.featureRequest,
      entryNodeId,
      ...(input.configInput === undefined ? {} : { config: input.configInput }),
    },
    pinnedResponses: calls,
    expected: { terminalNodeId, artifacts: {}, notes: input.notes },
  };

  const produced = await execute(draft);

  const goldenCase: GoldenCase = {
    ...draft,
    expected: { ...draft.expected, artifacts: sortedArtifacts(produced) },
  };

  return { goldenCase, calls, terminalNodeId };
}

/**
 * The committed case's JSON bytes, sorted the way a golden file is written.
 *
 * One writer for the file and for the up-to-date check, so "the committed file differs
 * from a fresh capture" can never be a difference in formatting.
 */
export function goldenCaseJson(goldenCase: GoldenCase): string {
  return `${JSON.stringify(goldenCase, null, 2)}\n`;
}
