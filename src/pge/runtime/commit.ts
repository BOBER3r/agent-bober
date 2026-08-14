import { Buffer } from "node:buffer";

import type { BoberConfig } from "../../config/schema.js";
import type { PlanSpec } from "../../contracts/spec.js";
import type { SprintContract } from "../../contracts/sprint-contract.js";
import { finalizePipelineRun } from "../../orchestrator/finalize.js";
import type { PipelineResult } from "../../orchestrator/pipeline.js";
import { saveContract, saveSpec } from "../../state/index.js";
import type { Phase } from "../../state/history.js";
import { PhaseSchema } from "../../state/history.js";
import type { CompiledGraph } from "../compile/compiler.js";
import type { Clock } from "../registry/nodes.js";
import { canonicalJson } from "../registry/reducers.js";
import { OverallStateSchema, RunVerdictSchema } from "../state/overall.js";
import type { OverallState } from "../state/overall.js";

/**
 * The commit boundary: the ONE place a superstep's work becomes state, and the ONE place
 * a `.bober/` domain artifact is written.
 *
 * ── Why a boundary at all ──
 *
 * `RunResultFlusher` already proved the shape for the workflow engine: a single host-side
 * component owning every write and every `new Date()`, so a script cannot smear timestamps
 * or half-written state across the tree. This generalises that from one flush at the end
 * of a run to one flush per superstep. Nodes return values; they do not write files, and
 * they do not read a clock.
 *
 * ── Exactly once per channel, by construction ──
 *
 * A channel's reducer is invoked ONCE per superstep with the WHOLE batch of updates for
 * that channel — never folded update-by-update. Two consequences, both load-bearing:
 *
 *   - "exactly one write per channel per superstep" is a property of the code path rather
 *     than a discipline, and {@link CommitResult.writesPerChannel} reports it so a spy can
 *     count REDUCER INVOCATIONS at the boundary rather than node returns.
 *   - order-invariance survives, because a pairwise fold would let arrival order into the
 *     result even with an associative merge. That is what makes a concurrency-1 run and a
 *     concurrency-8 run commit the same bytes.
 *
 * ── Bulk offloading is ENFORCED here, not advised ──
 *
 * Every update is measured against its channel's `maxInlineBytes` BEFORE it reaches the
 * reducer. An oversized value is rejected with {@link StateBloatError} naming the channel
 * and the byte count, and it does not participate in the merge. A node holding a 5 MB
 * diff therefore has exactly one legal move: put the bytes in the scratch store and commit
 * the four-field {@link ScratchRef}.
 *
 * ── Control-plane keys ──
 *
 * Three keys of {@link OverallState} are not channels and have no reducer:
 * `currentPhase`, `verdict` and `specId`. They are single-valued run facts, so instead of
 * a merge they take a UNANIMITY rule — every update in one batch must agree, or the commit
 * fails with {@link ConflictingControlUpdateError}. Unanimity is order-independent by
 * construction, which is the property a "last writer wins" rule would quietly lose. Three
 * further keys — `runId`, `projectRoot`, `featureRequest` — are run identity and are
 * refused outright.
 *
 * ── `finalize` is a boundary METHOD, distinct from the unreachable `finalize` NODE ──
 *
 * `PgeEngine.run` calls {@link CommitBoundary.finalize} unconditionally at the end of
 * every run, whatever terminal node the interpreter actually reached — it is not the
 * graph's own `finalize` tool node (whose only inbound edge is `commit -> finalize`, and
 * which stays unreachable while `commit` is FAIL_CLOSED-refused under the shipped
 * autopilot mechanism). Sprint 7 of spec-20260812-pge-real-workload-errors taught this
 * method to fall back to `state.specDraft` when `state.spec` is null, so a plan whose
 * clarification never converges RESOLVES with a failed `PipelineResult` instead of
 * throwing {@link FinalizeWithoutSpecError} — see that class and this method for the
 * narrowed condition.
 */

// ── Errors ──────────────────────────────────────────────────────────

/** A channel value too large to sit inline. Names the channel, the size and the cap. */
export class StateBloatError extends Error {
  readonly channel: string;
  readonly bytes: number;
  readonly limit: number;
  readonly nodeId: string;
  readonly branchKey: string | null;

  constructor(args: {
    channel: string;
    bytes: number;
    limit: number;
    nodeId: string;
    branchKey: string | null;
  }) {
    super(
      `Channel "${args.channel}" rejected an update from node "${args.nodeId}"${
        args.branchKey === null ? "" : ` (branch ${args.branchKey})`
      }: it serialises to ${String(args.bytes)} bytes, above the channel's maxInlineBytes of ${String(args.limit)}. Offload the payload to the scratch store and commit a ScratchRef.`,
    );
    this.name = "StateBloatError";
    this.channel = args.channel;
    this.bytes = args.bytes;
    this.limit = args.limit;
    this.nodeId = args.nodeId;
    this.branchKey = args.branchKey;
  }
}

/** An update naming a channel the topology does not declare (or that is not a state key). */
export class UndeclaredChannelError extends Error {
  readonly channel: string;
  readonly nodeId: string;

  constructor(channel: string, nodeId: string, detail: string) {
    super(`Node "${nodeId}" wrote channel "${channel}", which ${detail}.`);
    this.name = "UndeclaredChannelError";
    this.channel = channel;
    this.nodeId = nodeId;
  }
}

/** Two nodes disagreeing about a control-plane value in the same superstep. */
export class ConflictingControlUpdateError extends Error {
  readonly key: string;
  readonly values: string[];

  constructor(key: string, values: string[]) {
    super(
      `Control key "${key}" received ${String(values.length)} disagreeing values in one superstep (${values.join(", ")}). Control keys have no reducer: a superstep must be unanimous about them or the result would depend on arrival order.`,
    );
    this.name = "ConflictingControlUpdateError";
    this.key = key;
    this.values = values;
  }
}

/** An attempt to rewrite run identity. */
export class ImmutableStateKeyError extends Error {
  readonly key: string;

  constructor(key: string, nodeId: string) {
    super(`Node "${nodeId}" wrote "${key}", which is run identity and is fixed for the life of a run.`);
    this.name = "ImmutableStateKeyError";
    this.key = key;
  }
}

/**
 * `finalize` on a run that never produced EITHER a committed spec or a plan draft.
 *
 * NARROWED at sprint 7 of spec-20260812-pge-real-workload-errors, not deleted: before
 * that sprint this threw whenever `state.spec` was null, including a planner that never
 * stopped asking clarifying questions — a run whose plan never settled crashed the
 * engine instead of reporting a failure. `finalize` (below) now falls back to
 * `state.specDraft` (`plan_draft`'s own channel, written on every round) when `spec` is
 * null, so this error is reachable only when NEITHER `spec` NOR `specDraft` was ever
 * written — a run that never dispatched `plan_draft` at all.
 */
export class FinalizeWithoutSpecError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(
      `Run "${runId}" cannot be finalized: neither state.spec nor state.specDraft is set, and the terminal artifact set is built from the plan spec.`,
    );
    this.name = "FinalizeWithoutSpecError";
    this.runId = runId;
  }
}

// ── Key classification ──────────────────────────────────────────────

/** State keys with no reducer, merged by unanimity. */
export const CONTROL_KEYS = ["currentPhase", "specId", "verdict"] as const;
export type ControlKey = (typeof CONTROL_KEYS)[number];

/** State keys fixed for the life of a run. */
export const IMMUTABLE_KEYS = ["runId", "projectRoot", "featureRequest"] as const;

const CONTROL_KEY_SET: ReadonlySet<string> = new Set<string>(CONTROL_KEYS);
const IMMUTABLE_KEY_SET: ReadonlySet<string> = new Set<string>(IMMUTABLE_KEYS);

/** True when `key` is merged by unanimity rather than by a registered reducer. */
export function isControlKey(key: string): key is ControlKey {
  return CONTROL_KEY_SET.has(key);
}

// ── Shapes ──────────────────────────────────────────────────────────

export interface ChannelUpdate {
  readonly channel: string;
  readonly nodeId: string;
  readonly branchKey: string | null;
  readonly value: unknown;
}

export interface CommitResult {
  readonly state: OverallState;
  /**
   * Reducer invocations per channel for THIS superstep. Every touched channel maps to
   * exactly 1; an untouched channel is absent. This is the number the exactly-once spy
   * counts.
   */
  readonly writesPerChannel: Record<string, number>;
  /** How many updates went into each channel's single merge. Diagnostic, not a guarantee. */
  readonly batchSizePerChannel: Record<string, number>;
  /** Updates refused by the inline-size guard. Non-empty means the commit lost work. */
  readonly rejected: StateBloatError[];
  /** Domain artifact writes actually performed by this commit. */
  readonly artifactWrites: number;
}

/**
 * What the boundary needs from the run. Deliberately narrower than the interpreter's
 * `RunContext`, which the interpreter satisfies structurally — a boundary that demanded
 * the whole run context could not be exercised without one.
 */
export interface CommitContext {
  readonly runId: string;
  readonly projectRoot: string;
  readonly config: BoberConfig;
  readonly superstep: number;
  /** `Date.now()` at run start; `finalize` derives the run duration from it. */
  readonly startedAtMs: number;
}

/**
 * The `.bober/` writes the boundary performs, behind an interface.
 *
 * Injected so a test can count REAL write calls rather than assert that a file exists —
 * "the artifact is there" is equally true after one write and after four.
 */
export interface DomainArtifactWriter {
  saveSpec(projectRoot: string, spec: PlanSpec): Promise<void>;
  saveContract(projectRoot: string, contract: SprintContract): Promise<void>;
}

/** The real writer: the same `src/state/` functions the TS engine has always used. */
export function createDomainArtifactWriter(): DomainArtifactWriter {
  return {
    saveSpec: (projectRoot, spec) => saveSpec(projectRoot, spec),
    saveContract: (projectRoot, contract) => saveContract(projectRoot, contract),
  };
}

export interface CommitBoundary {
  commit(
    graph: CompiledGraph,
    current: OverallState,
    batch: readonly ChannelUpdate[],
    ctx: CommitContext,
  ): Promise<CommitResult>;
  finalize(state: OverallState, ctx: CommitContext): Promise<PipelineResult>;
}

// ── Clock ───────────────────────────────────────────────────────────

/**
 * The runtime's clock.
 *
 * This is the ONLY `new Date()` in the modules this boundary owns. Nodes read
 * `NodeContext.clock`, which is this object, so a replayed superstep handed a recorded
 * clock produces the recorded artifact.
 */
export function createSystemClock(): Clock {
  return {
    now: () => new Date(),
    nowMs: () => Date.now(),
    nowIso: () => new Date().toISOString(),
  };
}

/** A clock that never moves. Not for production — it exists so tests need not fake globals. */
export function createFixedClock(iso: string): Clock {
  const at = new Date(iso);
  return {
    now: () => new Date(at.getTime()),
    nowMs: () => at.getTime(),
    nowIso: () => at.toISOString(),
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * The metric the cap check below measures against: canonical-JSON byte length.
 *
 * Exported so a corpus's own "maximum serialised byte size per channel" calculation
 * (`src/pge/golden/workload.ts`) is never a reimplementation of the boundary's own number —
 * two copies of the metric that decides every channel cap is exactly the drift a committed
 * corpus exists to prevent.
 */
export function byteSize(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), "utf8");
}

/** The state key a channel id names, proven to be one of the fifteen. */
function stateKeyOf(key: string): keyof OverallState | null {
  return Object.prototype.hasOwnProperty.call(OverallStateSchema.shape, key)
    ? (key as keyof OverallState)
    : null;
}

/**
 * A control-plane value, VALIDATED rather than coerced.
 *
 * All three keys go through the schema that owns them — `specId` included. Coercing it with
 * `String(value)` instead would turn a node's `{ oops: 1 }` into the literal string
 * `"[object Object]"`, which is a perfectly valid `z.string()` and therefore sails through
 * the `OverallStateSchema.parse` at the end of the merge. That re-parse is the last line of
 * defence against a corrupted state, and a hand-rolled coercion in front of it defeats it.
 */
function parseControlValue(key: ControlKey, value: unknown): Phase | string | null {
  if (key === "currentPhase") return PhaseSchema.parse(value);
  if (key === "verdict") return RunVerdictSchema.parse(value);
  return OverallStateSchema.shape.specId.parse(value);
}

// ── Boundary ────────────────────────────────────────────────────────

export interface CommitBoundaryOptions {
  clock?: Clock;
  artifacts?: DomainArtifactWriter;
}

/**
 * A commit boundary for one run.
 *
 * Per-run, never module-level: it memoises the canonical bytes of every domain artifact it
 * has written, and that memo is what makes a rework loop that re-commits an IDENTICAL
 * contract perform zero further writes. Sharing the memo between runs would suppress a
 * second run's first write.
 */
export function createCommitBoundary(options: CommitBoundaryOptions = {}): CommitBoundary {
  const clock = options.clock ?? createSystemClock();
  const artifacts = options.artifacts ?? createDomainArtifactWriter();

  /** `artifact id -> canonical bytes last written`. */
  const persisted = new Map<string, string>();

  /** Write only when the bytes differ from what this run last wrote. Returns writes done. */
  async function persistIfChanged(
    id: string,
    value: unknown,
    write: () => Promise<void>,
  ): Promise<number> {
    const bytes = canonicalJson(value);
    if (persisted.get(id) === bytes) return 0;
    await write();
    persisted.set(id, bytes);
    return 1;
  }

  return {
    // `_ctx` is the run context the interface declares. The merge itself needs nothing
    // from it — the superstep index and the run id belong to the trace and to
    // `finalize` — and it is kept in the signature so a later sprint's checkpoint hook
    // does not change every call site.
    async commit(graph, current, batch, _ctx): Promise<CommitResult> {
      const rejected: StateBloatError[] = [];
      const byChannel = new Map<string, unknown[]>();
      const controls = new Map<ControlKey, Map<string, unknown>>();

      for (const update of batch) {
        if (IMMUTABLE_KEY_SET.has(update.channel)) {
          throw new ImmutableStateKeyError(update.channel, update.nodeId);
        }

        if (isControlKey(update.channel)) {
          const parsed = parseControlValue(update.channel, update.value);
          const seen = controls.get(update.channel) ?? new Map<string, unknown>();
          seen.set(canonicalJson(parsed), parsed);
          controls.set(update.channel, seen);
          continue;
        }

        const declared = graph.channels.get(update.channel);
        if (!declared) {
          throw new UndeclaredChannelError(
            update.channel,
            update.nodeId,
            "the topology does not declare in channels[]",
          );
        }
        const key = stateKeyOf(update.channel);
        if (key === null) {
          throw new UndeclaredChannelError(
            update.channel,
            update.nodeId,
            "is not one of the fifteen keys of OverallState",
          );
        }

        const bytes = byteSize(update.value);
        if (bytes > declared.decl.maxInlineBytes) {
          rejected.push(
            new StateBloatError({
              channel: update.channel,
              bytes,
              limit: declared.decl.maxInlineBytes,
              nodeId: update.nodeId,
              branchKey: update.branchKey,
            }),
          );
          continue;
        }

        const bucket = byChannel.get(update.channel);
        if (bucket) bucket.push(update.value);
        else byChannel.set(update.channel, [update.value]);
      }

      // ── Merge: one reducer invocation per channel, whole batch ──
      //
      // Channel ids are visited in sorted order so `writesPerChannel` and any artifact
      // the merge triggers are produced in a stable sequence regardless of the order the
      // updates arrived in.
      const next: Record<string, unknown> = { ...current };
      const writesPerChannel: Record<string, number> = {};
      const batchSizePerChannel: Record<string, number> = {};

      for (const channelId of [...byChannel.keys()].sort()) {
        const updates = byChannel.get(channelId) as unknown[];
        // Present by construction: a channel only reaches `byChannel` after the lookup
        // above succeeded. The re-lookup is what keeps `compiled` non-null for `tsc`.
        const compiled = graph.channels.get(channelId);
        if (!compiled) continue;
        const key = stateKeyOf(channelId) as keyof OverallState;
        next[channelId] = compiled.reducer.merge(current[key] as unknown, updates);
        writesPerChannel[channelId] = 1;
        batchSizePerChannel[channelId] = updates.length;
      }

      for (const key of CONTROL_KEYS) {
        const seen = controls.get(key);
        if (!seen || seen.size === 0) continue;
        if (seen.size > 1) {
          throw new ConflictingControlUpdateError(key, [...seen.keys()].sort());
        }
        next[key] = [...seen.values()][0];
        writesPerChannel[key] = 1;
        batchSizePerChannel[key] = 1;
      }

      // Re-parsed, not cast: a reducer that produced a shape `OverallState` forbids is a
      // silent corruption exactly one superstep before it becomes someone else's problem.
      const state = OverallStateSchema.parse(next);

      // ── Domain artifacts ──
      let artifactWrites = 0;
      if (writesPerChannel.spec !== undefined && state.spec !== null) {
        artifactWrites += await persistIfChanged(`spec:${state.spec.specId}`, state.spec, () =>
          artifacts.saveSpec(state.projectRoot, state.spec as PlanSpec),
        );
      }
      if (writesPerChannel.sprintContracts !== undefined) {
        for (const contract of [...state.sprintContracts].sort((a, b) =>
          a.contractId < b.contractId ? -1 : a.contractId > b.contractId ? 1 : 0,
        )) {
          artifactWrites += await persistIfChanged(
            `contract:${contract.contractId}`,
            contract,
            () => artifacts.saveContract(state.projectRoot, contract),
          );
        }
      }

      return { state, writesPerChannel, batchSizePerChannel, rejected, artifactWrites };
    },

    async finalize(state, ctx): Promise<PipelineResult> {
      // ── The specDraft fallback (sprint 7 of spec-20260812-pge-real-workload-errors) ──
      //
      // `state.spec` is null exactly when `plan_materialize` never ran — most commonly a
      // planner whose `planClarifyRounds` budget ran out before the plan converged, which
      // routes straight to `graceful_failure` without ever reaching `plan_materialize`.
      // Throwing here used to crash the whole engine run for that case. `state.specDraft`
      // is `plan_draft`'s OWN channel (`src/pge/topology/coding.graph.ts`), written on
      // EVERY round — clarifying or settled — so it survives exactly when `plan_draft`
      // ran at least once, which a `spec`-less run that reached this boundary always did.
      //
      // The literal below MIRRORS the imperative engine's own needs-clarification return
      // (`runTsPipeline`, `src/orchestrator/pipeline.ts`) rather than routing through
      // `finalizePipelineRun`: that function's completion marker and pipeline-complete
      // history line assert a run that reached its terminal artifact set, which a plan
      // that never left the clarification loop did not — there are no sprint contracts to
      // split into completed/failed and no commit to record. `errors` is deliberately NOT
      // set here: it is layered onto the RETURNED PipelineResult by `PgeEngine.run`, from
      // the interpreter's OWN `TaskFailure` records (sprint 5's machinery, unmodified) —
      // and the interpreter already records one for this exact case, because exhausting a
      // declared loop bound and being rerouted to `onExhausted` is a `LoopExhausted`
      // `TaskFailure` by construction (`src/pge/runtime/interpreter.ts`). `finalize` here
      // has no interpreter trace to draw one from — it sees only `state` — so inventing an
      // `errors` entry would be fabricating a `nodeId` this boundary does not actually
      // know.
      if (state.spec === null) {
        if (state.specDraft === null) throw new FinalizeWithoutSpecError(state.runId);
        return {
          success: false,
          spec: state.specDraft,
          completedSprints: [],
          failedSprints: [],
          duration: clock.nowMs() - ctx.startedAtMs,
          needsClarification: true,
        };
      }

      // ── The split, and why the CONTRACT STATUS alone still cannot decide it ──
      //
      // `runTsPipeline` used to split on `status === "passed"`, the same literal as below —
      // as of sprint 5 of spec-20260812-terminal-vocabulary it splits on
      // `isSettledContractStatus(result.contract.status)` instead (`pipeline.ts:1052`), and
      // `runSprintCycle` no longer WRITES `"passed"` at all: it writes `"completed"`
      // (`pipeline.ts:589`), the identical word `sprint_review` has always written. So
      // `c.status === "passed"` below is no longer merely insufficient for a GRAPH run — it
      // is now a comparison against a word NEITHER engine's settled-sprint writer produces,
      // for any run, imperative or graph. (`appendById` resolving a duplicate `contractId` by
      // RANK rather than canonical order — sprint 4, `registry/reducers.ts`, `rankIsGreater`
      // — is the separate, already-fixed reason the settled copy reaches this channel at all;
      // `sprint-evaluate.test.ts` pins that.) Migrating this comparison to
      // `isSettledContractStatus` would change which contracts land in `completedSprints`
      // for a GRAPH run specifically, which moves golden cases and is exactly what sc-5-4's
      // stop condition (spec-20260812-terminal-vocabulary sprint 5) forbids — so this
      // comparison stays a live, documented, deliberately-deferred defect rather than a
      // migrated reader.
      //
      // The settled outcome is therefore still read from the channel that unambiguously
      // distinguishes PASS from FAIL today: `branchStatus`, keyed by `contractId`, carrying
      // an explicit `attempts` discriminator, with `sprint_exit` as its only terminal writer.
      // Without this, a graph run in which every sprint passed still reported
      // `completedSprints: []` and `success: false` — the engine contradicting its own
      // trace, which is precisely the class of divergence the conformance harness exists to
      // surface.
      //
      // A branch that is `succeeded` is the same fact as a contract that is `passed`; a
      // branch in any other state, or no branch at all, leaves the contract's own status to
      // decide. Nothing here invents a pass: an absent `branchStatus` reduces this to the
      // imperative engine's rule exactly.
      const succeededBranches = new Set(
        Object.entries(state.branchStatus)
          .filter(([, status]) => status.state === "succeeded")
          .map(([branchKey]) => branchKey),
      );
      const passed = (c: SprintContract): boolean =>
        c.status === "passed" || succeededBranches.has(c.contractId);
      const completedSprints = state.sprintContracts.filter((c) => passed(c));
      const failedSprints = state.sprintContracts.filter((c) => !passed(c));

      // THE THIRD CALLER of finalizePipelineRun, alongside runTsPipeline and
      // RunResultFlusher.flush. Every engine must emit the identical terminal set — the
      // `.completed.json` marker FIRST, then the pipeline-complete history line — because
      // the marker is the sole carrier of the runId and the history line is only the
      // trigger. Emitting them the other way round strands a run for
      // src/chat/completion-tailer.ts, which is a defect this repository has already had
      // once. Re-implementing the block here instead of calling it is how it comes back.
      return finalizePipelineRun({
        projectRoot: state.projectRoot,
        runId: state.runId,
        config: ctx.config,
        spec: state.spec,
        completedSprints,
        failedSprints,
        startedAtMs: ctx.startedAtMs ?? clock.nowMs(),
      });
    },
  };
}
