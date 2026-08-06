import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import type { EffectTag } from "../../contracts/topology.js";
import {
  EngineConformanceHarness,
  emptyOnAllEnginesFields,
  fullyPopulatedFields,
} from "../../orchestrator/workflow/conformance.js";
import type { PipelineEngineName } from "../../orchestrator/workflow/engine.js";
import type {
  ConformanceArtifactName,
  ConformanceField,
  ConformanceReport,
} from "../../orchestrator/workflow/types.js";
import type { PipelineResult } from "../../orchestrator/pipeline.js";
import { logger } from "../../utils/logger.js";
import {
  EffectChannelClosed,
  EffectNotDeclaredError,
  EffectNotRegisteredError,
} from "../registry/effects.js";
import type { EffectRegistry } from "../registry/effects.js";
import type { NodeContext, ScratchStore } from "../registry/nodes.js";
import { ScratchRefSchema } from "../state/overall.js";
import type { ScratchRef } from "../state/overall.js";
import { createScratchStore } from "./scratch.js";
import type { SandboxOutcome, SandboxPolicy, SandboxRunner } from "./sandbox.js";
import { readSpans, tracePath } from "./trace.js";
import type { SpanHandle, TraceWriter } from "./trace.js";

/**
 * Offline replay of a recorded run, and the recording seam that makes one possible.
 *
 * ── WHAT A REPLAY REGRESSION-TESTS ──
 *
 * The RUNTIME and the ARTIFACT SHAPE, and nothing else. A replay re-executes a recorded
 * run with every outward call answered from the recording, so what it proves is that the
 * interpreter, the commit boundary, the reducers and the `.bober/` writers still turn the
 * SAME provider answers into the SAME artifacts. It says nothing whatsoever about whether
 * those answers were any good — model output quality is not observable here and a replay
 * that "passed" a bad plan is working exactly as designed.
 *
 * ── THE RECORDING LIVES ON THE SPAN ──
 *
 * `Span.toolOutputRef` is a {@link ScratchRef} the span schema already reserved and that
 * nothing in the shipped runtime ever set. {@link createRunRecorder} fills it: the effect
 * decorator writes each node's cumulative request/response bundle into the scratch store
 * and the trace decorator stamps the resulting ref onto that node's own span when it ends.
 * No new span kind, no fabricated `phase`, no second file to keep in step with the trace —
 * `.bober/traces/<runId>.jsonl` plus `.bober/scratch/<runId>/` IS the recording, and
 * {@link readRecording} reads it back through {@link readSpans} rather than by re-parsing
 * the JSONL by hand.
 *
 * ── A MISS IS A FAILURE, NEVER A DEFAULT ──
 *
 * {@link createReplayEffectRegistry} answers ONLY the calls it holds a recording for and
 * throws {@link MissingRecordingError} for everything else. It never falls through to the
 * real effect, so a replay performs zero provider calls, zero git commands and zero
 * filesystem effects outside the replay root. The same rule governs the two escape hatches
 * a node body could otherwise reach the world through: {@link withNetworkDisabled} installs
 * a `fetch` that THROWS, and {@link createRefusingSandbox} is a {@link SandboxRunner} that
 * throws instead of spawning. A canned default in any of those three places would let a
 * replay quietly diverge from the run it claims to reproduce, which is the one outcome that
 * would make the whole exercise worthless.
 *
 * ── ONE COMPARATOR ──
 *
 * The artifact comparison is {@link EngineConformanceHarness} — the same normalisation,
 * the same volatile-key stripping and the same order-tolerant structured diff the ts-vs-pge
 * conformance gate uses. There is no second normaliser in this module; a private one would
 * be free to disagree with the gate about what "identical" means.
 */

// ── Recording format ────────────────────────────────────────────────

export const RECORDING_FORMAT_VERSION = 1;

/**
 * One recorded effect invocation.
 *
 * `callIndex` counts invocations per `(nodeId, branchKey)` across ALL effect names — the
 * same identity {@link BudgetLedger} charges under — so the key is a position in the node's
 * own call sequence and a replay reproduces it by counting the same way.
 */
export const RecordedCallSchema = z.object({
  nodeId: z.string().min(1),
  branchKey: z.string().nullable(),
  effectName: z.string().min(1),
  callIndex: z.number().int().min(0),
  request: z.unknown(),
  response: z.unknown(),
});
export type RecordedCall = z.infer<typeof RecordedCallSchema>;

/**
 * Everything one node execution recorded, as stored in scratch.
 *
 * Cumulative rather than one blob per call: a span carries exactly one `toolOutputRef`, so
 * the bundle a node's span points at has to describe every call that node made. Each
 * invocation rewrites the bundle, and because the scratch store is content-addressed the
 * rewrite is a new immutable object rather than a mutation of the previous one.
 */
export const RecordingBundleSchema = z.object({
  formatVersion: z.literal(RECORDING_FORMAT_VERSION),
  runId: z.string().min(1),
  nodeId: z.string().min(1),
  branchKey: z.string().nullable(),
  calls: z.array(RecordedCallSchema),
});
export type RecordingBundle = z.infer<typeof RecordingBundleSchema>;

/** The identity a recorded call is looked up by. Stable across a re-execution. */
export function recordingKey(input: {
  nodeId: string;
  branchKey: string | null;
  callIndex: number;
}): string {
  return `${input.nodeId}@${input.branchKey ?? ""}#${String(input.callIndex)}`;
}

// ── Errors ──────────────────────────────────────────────────────────

/** Why a lookup failed. Both mean the replay may not proceed. */
export const MISSING_RECORDING_REASONS = ["absent", "effect-mismatch"] as const;
export type MissingRecordingReason = (typeof MISSING_RECORDING_REASONS)[number];

/**
 * The replay asked for a call the recording does not hold.
 *
 * THROWN, never defaulted. A canned answer here would let the replayed run continue with a
 * response the recorded run never saw, and the artifact comparison downstream would then be
 * comparing a fabrication — which is worse than no comparison, because it passes.
 */
export class MissingRecordingError extends Error {
  constructor(
    readonly key: string,
    readonly effectName: string,
    readonly reason: MissingRecordingReason,
    detail: string,
  ) {
    super(
      `Replay has no recorded response for effect "${effectName}" at ${key} (${reason}): ${detail}`,
    );
    this.name = "MissingRecordingError";
  }
}

/** Something inside a replay tried to reach the network. */
export class NetworkDisabledInReplayError extends Error {
  constructor(readonly target: string) {
    super(
      `Replay attempted a network call to ${target}; a replay answers from the recording only. ` +
        `A live call would make the replayed artifacts depend on something the recorded run never saw.`,
    );
    this.name = "NetworkDisabledInReplayError";
  }
}

/** Something inside a replay tried to spawn a process. */
export class ProcessExecutionDisabledInReplayError extends Error {
  constructor(readonly command: string) {
    super(
      `Replay attempted to execute "${command}"; a replay answers from the recording only.`,
    );
    this.name = "ProcessExecutionDisabledInReplayError";
  }
}

/** `replayRecordedRun` was handed a root factory that did not yield the two roots it needs. */
export class ReplayRootExhaustedError extends Error {
  constructor(readonly requested: number) {
    super(
      `The conformance harness requested ${String(requested)} project roots; a replay compares exactly two (recorded, replayed).`,
    );
    this.name = "ReplayRootExhaustedError";
  }
}

// ── Recorder ────────────────────────────────────────────────────────

/**
 * The two decorators that turn a live run into a recorded one.
 *
 * They are a PAIR and share one in-memory index: `effects` collects the calls and parks a
 * scratch ref per node execution, `trace` stamps that ref onto the node's own span. Wrapping
 * only one of them records nothing — the calls would be in scratch with no span pointing at
 * them, or the spans would carry no ref at all.
 */
export interface RunRecorder {
  effects(inner: EffectRegistry): EffectRegistry;
  trace(inner: TraceWriter): TraceWriter;
  /** Every call recorded so far, in invocation order. For assertions and diagnostics. */
  calls(): readonly RecordedCall[];
}

export interface RunRecorderInput {
  readonly runId: string;
  readonly scratch: ScratchStore;
}

export function createRunRecorder(input: RunRecorderInput): RunRecorder {
  const { runId, scratch } = input;
  /** `nodeId@branchKey` -> that node execution's cumulative bundle. */
  const bundles = new Map<string, RecordingBundle>();
  /** `nodeId@branchKey` -> the ref of the latest bundle written for it. */
  const refs = new Map<string, ScratchRef>();
  const ordered: RecordedCall[] = [];

  const nodeKey = (nodeId: string, branchKey: string | null): string =>
    `${nodeId}@${branchKey ?? ""}`;

  return {
    calls: () => ordered,

    effects(inner: EffectRegistry): EffectRegistry {
      return {
        register: (def) => {
          inner.register(def);
        },
        list: () => inner.list(),
        seal: () => {
          inner.seal();
        },
        sealed: () => inner.sealed(),

        async invoke(name: string, req: unknown, ctx: NodeContext): Promise<unknown> {
          // The real registry runs FIRST and unchanged: its seal check, its declared-tag
          // check and both of its Zod parses are the boundary, and a decorator that
          // pre-empted any of them would be recording a call the boundary might refuse.
          const response = await inner.invoke(name, req, ctx);

          const key = nodeKey(ctx.nodeId, ctx.branchKey);
          const bundle: RecordingBundle = bundles.get(key) ?? {
            formatVersion: RECORDING_FORMAT_VERSION,
            runId,
            nodeId: ctx.nodeId,
            branchKey: ctx.branchKey,
            calls: [],
          };
          const call: RecordedCall = {
            nodeId: ctx.nodeId,
            branchKey: ctx.branchKey,
            effectName: name,
            callIndex: bundle.calls.length,
            request: req,
            response,
          };
          const next: RecordingBundle = { ...bundle, calls: [...bundle.calls, call] };
          bundles.set(key, next);
          ordered.push(call);
          refs.set(key, await scratch.put(runId, "payload", JSON.stringify(next)));

          return response;
        },
      };
    },

    trace(inner: TraceWriter): TraceWriter {
      return {
        path: () => inner.path(),
        close: () => inner.close(),
        begin(span): SpanHandle {
          const handle = inner.begin(span);
          const key = nodeKey(span.nodeId, span.branchKey);
          return {
            spanId: handle.spanId,
            startedAt: handle.startedAt,
            end(outcome): void {
              const ref = refs.get(key);
              // A caller that set `toolOutputRef` itself keeps it: the recording is an
              // addition to the span, never an overwrite of something the runtime meant.
              handle.end(
                ref === undefined || outcome.toolOutputRef !== undefined
                  ? outcome
                  : { ...outcome, toolOutputRef: ref },
              );
            },
          };
        },
      };
    },
  };
}

// ── Reading a recording back ────────────────────────────────────────

/** Every recorded call of one run, addressed by {@link recordingKey}. */
export interface Recording {
  readonly runId: string;
  readonly calls: readonly RecordedCall[];
  get(key: string): RecordedCall | undefined;
  has(key: string): boolean;
  readonly size: number;
}

/** A recording over an explicit call list — the seam a test drops one call through. */
export function createRecording(runId: string, calls: readonly RecordedCall[]): Recording {
  const byKey = new Map<string, RecordedCall>();
  for (const call of calls) byKey.set(recordingKey(call), call);
  return {
    runId,
    calls: [...calls],
    get: (key) => byKey.get(key),
    has: (key) => byKey.has(key),
    get size() {
      return byKey.size;
    },
  };
}

/**
 * Read `.bober/traces/<runId>.jsonl` and resolve every recording it points at.
 *
 * A `toolOutputRef` that does not parse as a {@link RecordingBundle} is SKIPPED rather than
 * fatal: the field is general-purpose and a future node is free to park its own tool output
 * there. A payload that is not a recording is not a missing recording — the miss surfaces
 * later, at the call that needed it, where the error can name the node.
 */
export async function readRecording(
  projectRoot: string,
  runId: string,
  scratch: ScratchStore = createScratchStore(projectRoot),
): Promise<Recording> {
  const spans = await readSpans(tracePath(projectRoot, runId));
  const byKey = new Map<string, RecordedCall>();

  for (const span of spans) {
    if (span.toolOutputRef === undefined) continue;
    const ref = ScratchRefSchema.parse(span.toolOutputRef);
    let text: string;
    try {
      text = await scratch.text(ref);
    } catch (error) {
      logger.debug(`[replay] scratch ${ref.uri} is unreadable: ${String(error)}`);
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      continue;
    }
    const bundle = RecordingBundleSchema.safeParse(raw);
    if (!bundle.success) continue;
    for (const call of bundle.data.calls) byKey.set(recordingKey(call), call);
  }

  return createRecording(runId, [...byKey.values()]);
}

// ── Replay effect registry ──────────────────────────────────────────

/**
 * An effect registry that answers from a {@link Recording} and never performs an effect.
 *
 * `inner` is kept for its DECLARATIONS only — `list()` publishes each effect's name and its
 * required tags, which is exactly what the seal check, the unknown-name check and the
 * declared-effects check need. `inner.invoke` is never called, so nothing this registry does
 * can reach a provider, a process or the filesystem.
 *
 * The recorded REQUEST is carried but not compared. Two roots differ by construction (the
 * replay runs somewhere else) so a request carrying a path or a timestamp would fail an
 * equality check for a reason that is not a divergence; the artifact comparison downstream
 * is what makes the claim, and it is the one that names what differed.
 */
export function createReplayEffectRegistry(
  inner: EffectRegistry,
  recording: Recording,
): EffectRegistry {
  /** `nodeId@branchKey` -> how many calls this replay has already answered for it. */
  const cursors = new Map<string, number>();

  return {
    register: (def) => {
      inner.register(def);
    },
    list: () => inner.list(),
    seal: () => {
      inner.seal();
    },
    sealed: () => inner.sealed(),

    async invoke(name: string, _req: unknown, ctx: NodeContext): Promise<unknown> {
      // Same order as the real registry: sealed, then resolvable, then authorised. A
      // recording must not be reachable through a door the live channel keeps shut.
      if (inner.sealed()) throw new EffectChannelClosed(name);

      const declaration = inner.list().find((entry) => entry.name === name);
      if (declaration === undefined) throw new EffectNotRegisteredError(name);

      const declared = new Set<EffectTag>(ctx.declaredEffects);
      for (const tag of declaration.effects) {
        if (!declared.has(tag)) throw new EffectNotDeclaredError(ctx.nodeId, name, tag);
      }

      const cursorKey = `${ctx.nodeId}@${ctx.branchKey ?? ""}`;
      const callIndex = cursors.get(cursorKey) ?? 0;
      cursors.set(cursorKey, callIndex + 1);

      const key = recordingKey({ nodeId: ctx.nodeId, branchKey: ctx.branchKey, callIndex });
      const call = recording.get(key);
      if (call === undefined) {
        throw new MissingRecordingError(
          key,
          name,
          "absent",
          `the trace holds ${String(recording.size)} recorded call(s) and none at this position`,
        );
      }
      if (call.effectName !== name) {
        throw new MissingRecordingError(
          key,
          name,
          "effect-mismatch",
          `the recorded call at this position was "${call.effectName}", so the replayed run diverged from the recorded one`,
        );
      }

      // Cloned: a replayed node body that mutates its response must not edit the recording
      // out from under a later lookup of the same call.
      return cloneRecordedResponse(call.response);
    },
  };
}

/**
 * A defensive copy of a recorded response.
 *
 * A JSON round-trip rather than a structural clone, because a recorded response IS JSON by
 * construction: it reached the recording through `JSON.stringify` into the scratch store and
 * came back through `JSON.parse`. Primitives are returned as they are, so `undefined` — which
 * `JSON.stringify` erases — survives.
 */
function cloneRecordedResponse(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

// ── Refusing the two remaining doors ────────────────────────────────

/** A `fetch` that throws. Installed for the duration of a replay. */
export function createRefusingFetch(): typeof globalThis.fetch {
  const refuse = (input: unknown): never => {
    const target =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : typeof input === "object" && input !== null && "url" in input
            ? String((input as { url: unknown }).url)
            : "<unknown>";
    throw new NetworkDisabledInReplayError(target);
  };
  return refuse as unknown as typeof globalThis.fetch;
}

/**
 * Run `fn` with `globalThis.fetch` replaced by a throwing stub, and restore it after.
 *
 * The stub THROWS rather than resolving a canned response, for the reason the module
 * comment gives: a replay that silently degraded to a default would produce artifacts the
 * recorded run never produced and the comparison would bless them.
 */
export async function withNetworkDisabled<T>(fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch as typeof globalThis.fetch | undefined;
  globalThis.fetch = createRefusingFetch();
  try {
    return await fn();
  } finally {
    if (original === undefined) {
      delete (globalThis as { fetch?: unknown }).fetch;
    } else {
      globalThis.fetch = original;
    }
  }
}

/** A {@link SandboxRunner} that refuses instead of spawning. */
export function createRefusingSandbox(): SandboxRunner {
  return {
    run(cmd: string, _args: readonly string[], _policy: SandboxPolicy): Promise<SandboxOutcome> {
      throw new ProcessExecutionDisabledInReplayError(cmd);
    },
  };
}

// ── The replay root ─────────────────────────────────────────────────

/**
 * The `.bober/` subtrees a replayed run READS and must therefore be given.
 *
 * Inputs only, and deliberately so: the topology artifact and the prompt store are what the
 * run was executed FROM, while contracts, specs, history, briefings, reviews, audits,
 * progress and run markers are what it produced. Copying an output into the replay root
 * would make the comparison read the recorded artifact back on both sides and report an
 * equivalence the replay never earned.
 */
export const REPLAY_INPUT_PATHS = [
  join(".bober", "topology"),
  join(".bober", "prompts"),
] as const;

/** Create `replayRoot` and copy the run's inputs into it. Missing inputs are not an error. */
export async function prepareReplayRoot(
  recordedRoot: string,
  replayRoot: string,
): Promise<string[]> {
  await mkdir(join(replayRoot, ".bober"), { recursive: true });
  const copied: string[] = [];
  for (const relative of REPLAY_INPUT_PATHS) {
    try {
      await cp(join(recordedRoot, relative), join(replayRoot, relative), {
        recursive: true,
        errorOnExist: false,
        force: true,
      });
      copied.push(relative);
    } catch {
      // The recorded root does not have it, so the replay does not need it either.
    }
  }
  return copied;
}

// ── The comparison ──────────────────────────────────────────────────

export const REPLAY_SIDES = ["recorded", "replayed"] as const;
export type ReplaySide = (typeof REPLAY_SIDES)[number];

/**
 * The two harness slots the two sides borrow.
 *
 * {@link EngineConformanceHarness} keys its per-engine collections by
 * {@link PipelineEngineName}, so the two sides of a replay need two DISTINCT names. Passing
 * one name twice is not an option: the second run would overwrite the first in the harness's
 * map and every pair would then compare a collection with ITSELF — `equivalent: true` for
 * any two runs whatsoever, which is the exact false pass this module exists to prevent.
 *
 * So the recorded side takes the harness's oracle slot and the replayed side takes `pge`.
 * The names are the harness's vocabulary and not a claim about which engine produced either
 * side: nothing outside this module ever sees them, because {@link ReplayDivergence} is
 * reported in terms of {@link ReplaySide}.
 */
const SIDE_ENGINE: Readonly<Record<ReplaySide, PipelineEngineName>> = Object.freeze({
  recorded: "ts",
  replayed: "pge",
});

/** One artifact divergence between the recorded run and its replay. */
export interface ReplayDivergence {
  artifact: ConformanceArtifactName;
  path: string;
  sides: readonly [ReplaySide, ReplaySide];
  field?: ConformanceField;
  detail?: string;
}

/** What the caller re-executes the run with. */
export interface ReplayRerunInput {
  readonly projectRoot: string;
  readonly runId: string;
  readonly recording: Recording;
}

export interface ReplayInput {
  /** The root the recorded run wrote its trace, scratch and artifacts into. */
  recordedRoot: string;
  runId: string;
  /** A root the replayed run may write into. Must not be `recordedRoot`. */
  replayRoot: string;
  /**
   * Re-executes the run. The caller composes the engine, because THIS module must not
   * decide which engine a replay is of; it hands back the {@link Recording} so the caller
   * can build a {@link createReplayEffectRegistry} around its own registries.
   */
  rerun: (input: ReplayRerunInput) => Promise<PipelineResult | void>;
  /** Reads the recorded payloads. Defaults to the recorded root's own scratch store. */
  scratch?: ScratchStore;
  /**
   * The recorded run's {@link PipelineResult}, when the caller kept one.
   *
   * A `PipelineResult` is a RETURN VALUE and is not persisted anywhere, so a replay driven
   * from the command line does not have the recorded one. When it is absent the replayed
   * result is dropped too, and `pipelineResult` is reported as empty on both sides rather
   * than counted as a divergence — an asymmetry there would be the harness observing this
   * module's own ignorance.
   */
  recordedResult?: PipelineResult;
  /** Informational spec id passed through to the harness. */
  specId?: string;
  harness?: EngineConformanceHarness;
}

export interface ReplayOutcome {
  runId: string;
  recordedRoot: string;
  replayRoot: string;
  /** True only when every field matched AND the comparison was not vacuous. */
  identical: boolean;
  divergences: ReplayDivergence[];
  /** Fields both sides populated — the ones the verdict actually rests on. */
  comparedFields: ConformanceField[];
  /** Fields neither side produced. Reported, never counted as a match. */
  emptyFields: ConformanceField[];
  /** How many recorded calls the replay had available. */
  recordedCalls: number;
  /** The raw harness report, for a caller that wants the counts. */
  report: ConformanceReport;
  /** Whatever the re-execution returned, even when it was not compared. */
  replayedResult: PipelineResult | undefined;
}

/**
 * Re-execute a recorded run and compare its artifacts with the recorded ones.
 *
 * The recorded side runs NOTHING — its artifacts are already on disk and re-running them
 * would defeat the purpose — so its runner is a no-op that yields the root it was given.
 * The replayed side runs `rerun` with the network stubbed to throw.
 */
export async function replayRecordedRun(input: ReplayInput): Promise<ReplayOutcome> {
  const harness = input.harness ?? new EngineConformanceHarness();
  const scratch = input.scratch ?? createScratchStore(input.recordedRoot);
  const recording = await readRecording(input.recordedRoot, input.runId, scratch);

  const roots = [input.recordedRoot, input.replayRoot];
  let handed = 0;
  const projectRootFactory = async (): Promise<string> => {
    if (handed >= roots.length) throw new ReplayRootExhaustedError(handed + 1);
    const root = roots[handed];
    handed += 1;
    return Promise.resolve(root);
  };

  let replayedResult: PipelineResult | undefined;
  const compareResults = input.recordedResult !== undefined;

  const report = await harness.assertEquivalent(
    input.specId ?? input.runId,
    [SIDE_ENGINE.recorded, SIDE_ENGINE.replayed],
    projectRootFactory,
    (engine) =>
      engine === SIDE_ENGINE.recorded
        ? // The recorded side has nothing to run: its artifacts are already on disk.
          (): Promise<void | PipelineResult> => Promise.resolve(input.recordedResult)
        : async (projectRoot: string): Promise<void | PipelineResult> => {
            const result = await withNetworkDisabled(() =>
              input.rerun({ projectRoot, runId: input.runId, recording }),
            );
            replayedResult = result ?? undefined;
            return compareResults ? result : undefined;
          },
  );

  return {
    runId: input.runId,
    recordedRoot: input.recordedRoot,
    replayRoot: input.replayRoot,
    identical: report.equivalent,
    divergences: report.diffs.map((diff) => ({
      artifact: diff.artifact,
      path: diff.path,
      sides: REPLAY_SIDES,
      ...(diff.field === undefined ? {} : { field: diff.field }),
      ...(diff.detail === undefined ? {} : { detail: diff.detail }),
    })),
    comparedFields: fullyPopulatedFields(report),
    emptyFields: emptyOnAllEnginesFields(report),
    recordedCalls: recording.size,
    report,
    replayedResult,
  };
}
