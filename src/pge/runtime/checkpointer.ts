import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import type { TopologySpec } from "../../contracts/topology.js";
import type { CheckpointOutcome } from "../../orchestrator/checkpoints/types.js";
import { canonicalJson } from "../registry/reducers.js";
import { OverallStateSchema } from "../state/overall.js";
import type { Exact, OverallState } from "../state/overall.js";
import type { DiagnosticCode } from "../topology/validate.js";
import type { PendingTask } from "./frontier.js";
import type { TaskFailure } from "./interpreter.js";
import { assertSafePathSegment, errnoCode } from "./scratch.js";
import type { Implements } from "./scratch.js";

/**
 * The run checkpointer: one JSON file per superstep under
 * `.bober/checkpoints/<runId>/<superstep>.json`.
 *
 * ── Why the filesystem and nothing else (ADR-5) ──
 *
 * The discriminating success criterion is "a run killed after node 3 and restarted in a
 * FRESH PROCESS re-invokes zero of nodes 1-3". No in-process store can satisfy it — that
 * is the whole reason `MemorySaver`-shaped state was rejected — and the human-in-the-loop
 * round trip that motivates resume spans separate CLI invocations, which is why
 * `src/orchestrator/checkpoints/mechanisms/disk.ts` already exists on disk too.
 *
 * A database was rejected for the opposite reason: a checkpoint has to stay readable with
 * `cat` and diffable with `git diff`, because "where did this run stop, and with what
 * state" is the single question an operator asks after a crash. So the bytes are indented,
 * key-sorted JSON — canonical enough that two identical checkpoints are byte-identical,
 * readable enough that a human can answer that question without a tool.
 *
 * ── Atomicity is temp-file-plus-rename, and nothing weaker ──
 *
 * {@link GraphCheckpointer.put} writes to a DOT-prefixed temp name in the SAME directory,
 * fsyncs it, and then renames it over the final name. Three properties follow. The first
 * two are asserted adversarially in `__tests__/checkpointer.conformance.test.ts`; the
 * third is stated here and pinned by nothing, which the suite's docblock says out loud.
 *
 *   1. A process killed partway through a write leaves a `.tmp` file that no reader can
 *      see — {@link listCheckpointFiles} matches `^\d+\.json$` only — so a partial
 *      checkpoint is not merely rejected, it is INVISIBLE.
 *   2. `rename(2)` within one directory replaces the name in one step, so the previous
 *      checkpoint's bytes are never touched. `put` overwrites `<superstep>.json` on EVERY
 *      superstep of a real run, and an in-place write would truncate the last good
 *      checkpoint before its replacement exists — a window in which a kill destroys a
 *      checkpoint that was valid a moment ago and leaves nothing in its place. The
 *      conformance suite catches an in-place `put` by the inode identity of the replaced
 *      file and by a hard-link witness holding the old bytes.
 *   3. The fsync is what stops the rename from landing before the bytes do on a power
 *      loss. Observing it needs a crashing kernel or a mocked `node:fs`, and this
 *      implementation is tested against neither, so no test would notice its removal.
 *
 * Writing in place loses (2). Writing to the OS temp directory and moving across
 * filesystems loses the atomicity of the rename itself. Neither is done here.
 *
 * ── Reject, then fall back ──
 *
 * A file that IS damaged — truncated by a full disk, or hand-edited into invalid JSON —
 * must never decode as a valid checkpoint. {@link GraphCheckpointer.get} throws
 * {@link CorruptCheckpointError} for it, and {@link GraphCheckpointer.list} and
 * {@link GraphCheckpointer.latest} skip past it to the last good one. That is the contract
 * the published `@langchain/langgraph-checkpoint-validation` suite certifies for a custom
 * saver, restated here without taking that package as a dependency: `list` never yields a
 * ref whose `get` fails.
 *
 * ── No module-level instance ──
 *
 * {@link createFsCheckpointer} takes `projectRoot` as a required argument. A worktree run
 * substitutes the root, so a module-level singleton would write every worktree's
 * checkpoints into whichever root loaded the module first.
 */

// ── Paths ───────────────────────────────────────────────────────────

/** `<projectRoot>/.bober/checkpoints`. Added to `.gitignore` in the same change. */
export function checkpointsRoot(projectRoot: string): string {
  return join(projectRoot, ".bober", "checkpoints");
}

export function checkpointDir(projectRoot: string, runId: string): string {
  assertSafePathSegment("runId", runId);
  return join(checkpointsRoot(projectRoot), runId);
}

export function checkpointPath(projectRoot: string, runId: string, superstep: number): string {
  return join(checkpointDir(projectRoot, runId), `${String(superstep)}.json`);
}

/** The only file name shape a reader will look at. Temp files are dot-prefixed. */
const CHECKPOINT_FILE = /^(\d+)\.json$/;

// ── Shapes ──────────────────────────────────────────────────────────

export interface CheckpointRef {
  readonly runId: string;
  readonly superstep: number;
}

/**
 * A human decision recorded against one of the nine documented checkpoint ids.
 *
 * Mirrors `CheckpointOutcome` from the shipped checkpoint subsystem rather than defining a
 * second outcome vocabulary. Zod widens every `unknown` field to OPTIONAL in its inferred
 * type — `undefined extends unknown` — so the declared interfaces below stay the source of
 * truth and {@link toCheckpointOutcome} is the one place a parsed value becomes one.
 */
export const CheckpointOutcomeSchema = z.union([
  z.object({ approved: z.literal(true), editDelta: z.unknown().optional() }),
  z.object({ approved: z.literal(false), feedback: z.string() }),
  z.object({ edit: z.literal(true), editDelta: z.unknown() }),
]);

/** Narrow a parsed outcome to the shipped `CheckpointOutcome` union. */
export function toCheckpointOutcome(
  raw: z.infer<typeof CheckpointOutcomeSchema>,
): CheckpointOutcome {
  if ("approved" in raw) {
    if (raw.approved) {
      return raw.editDelta === undefined
        ? { approved: true }
        : { approved: true, editDelta: raw.editDelta };
    }
    return { approved: false, feedback: raw.feedback };
  }
  return { edit: true, editDelta: raw.editDelta };
}

/** One paused approval. `payload` is what the mechanism renders for the human. */
export const InterruptRecordSchema = z.object({
  checkpointId: z.string().min(1),
  nodeId: z.string().min(1),
  branchKeys: z.array(z.string()),
  payload: z.unknown(),
  raisedAt: z.string().min(1),
  superstep: z.number().int().min(0),
});

export interface InterruptRecord {
  readonly checkpointId: string;
  readonly nodeId: string;
  readonly branchKeys: readonly string[];
  readonly payload: unknown;
  readonly raisedAt: string;
  readonly superstep: number;
}

/** The declared shape and the validated shape must carry the SAME field set. */
export const _interruptRecordKeysAreExact: Exact<
  keyof InterruptRecord,
  keyof z.infer<typeof InterruptRecordSchema>
> = true;

/**
 * A frontier entry, exactly as `frontier.ts` builds it.
 *
 * {@link _pendingTaskKeysAreExact} is what stops the two from drifting: a field added to
 * `PendingTask` that this schema drops would silently vanish across a resume, and the
 * failure would look like a scheduling bug three supersteps later.
 */
export const PendingTaskSchema = z.object({
  taskKey: z.string().min(1),
  nodeId: z.string().min(1),
  branchKey: z.string().nullable(),
  input: z.unknown(),
  contractId: z.string().min(1).optional(),
  dependsOn: z.array(z.string()),
  files: z.array(z.string()),
});

export const _pendingTaskKeysAreExact: Exact<
  keyof PendingTask,
  keyof z.infer<typeof PendingTaskSchema>
> = true;

/** Restore the exact `PendingTask` shape the planner consumes from a parsed entry. */
export function toPendingTask(raw: z.infer<typeof PendingTaskSchema>): PendingTask {
  return {
    taskKey: raw.taskKey,
    nodeId: raw.nodeId,
    branchKey: raw.branchKey,
    input: raw.input,
    ...(raw.contractId === undefined ? {} : { contractId: raw.contractId }),
    dependsOn: raw.dependsOn,
    files: raw.files,
  };
}

export const TaskFailureSchema = z.object({
  nodeId: z.string().min(1),
  branchKey: z.string().nullable(),
  superstep: z.number().int().min(0),
  errorClass: z.string(),
  message: z.string(),
});

export const _taskFailureIsSerializable: Implements<
  TaskFailure,
  z.infer<typeof TaskFailureSchema>
> = true;

/** One branch's result, buffered at a fan-in target across a resume. */
export interface JoinEntry {
  readonly branchKey: string;
  readonly value: unknown;
}

/** One fan-in target's buffered branch results, held across a resume. */
export interface JoinBucket {
  readonly nodeId: string;
  readonly entries: readonly JoinEntry[];
}

export const JoinBucketSchema = z.object({
  nodeId: z.string().min(1),
  entries: z.array(z.object({ branchKey: z.string().min(1), value: z.unknown() })),
});

/**
 * The whole resumable run.
 *
 * `graphId`, `graphVersion` and `checksum` are the graph IDENTITY. Resuming a checkpoint
 * against a different artifact would replay task keys — `sha256(nodeId + branchKey +
 * inputHash)` — into a graph where those ids mean something else, so
 * {@link assertCheckpointMatchesGraph} throws {@link ChecksumMismatchError} instead. That
 * is a deliberate failure, not an unsupported migration.
 *
 * `nextSuperstep` exists because the two checkpoint kinds resume at different points: a
 * post-commit checkpoint at superstep S restores a frontier that runs at S+1, while an
 * interrupt checkpoint at S restores the frontier that was ABOUT to run at S and never
 * did. Deriving one from the other would make the interrupt path re-run a superstep.
 */
export interface Checkpoint {
  readonly formatVersion: 1;
  readonly runId: string;
  readonly superstep: number;
  readonly nextSuperstep: number;
  readonly graphId: string;
  readonly graphVersion: string;
  readonly checksum: string;
  readonly createdAt: string;
  readonly state: OverallState;
  readonly pending: readonly PendingTask[];
  readonly completedTaskKeys: readonly string[];
  readonly interrupt: InterruptRecord | null;
  /** Approvals already granted this run, so a second interrupt does not lose the first. */
  readonly decisions: Readonly<Record<string, CheckpointOutcome>>;
  readonly activeBranches: readonly string[];
  readonly joinBuffer: readonly JoinBucket[];
  readonly failures: readonly TaskFailure[];
  readonly deadlocked: boolean;
}

export const CheckpointSchema = z.object({
  formatVersion: z.literal(1),
  runId: z.string().min(1),
  superstep: z.number().int().min(0),
  nextSuperstep: z.number().int().min(0),
  graphId: z.string().min(1),
  graphVersion: z.string().min(1),
  checksum: z.string().min(1),
  createdAt: z.string().min(1),
  state: OverallStateSchema,
  pending: z.array(PendingTaskSchema),
  completedTaskKeys: z.array(z.string()),
  interrupt: InterruptRecordSchema.nullable(),
  decisions: z.record(z.string(), CheckpointOutcomeSchema),
  activeBranches: z.array(z.string()),
  joinBuffer: z.array(JoinBucketSchema),
  failures: z.array(TaskFailureSchema),
  deadlocked: z.boolean(),
});

export const _checkpointKeysAreExact: Exact<
  keyof Checkpoint,
  keyof z.infer<typeof CheckpointSchema>
> = true;

export const CHECKPOINT_FORMAT_VERSION = 1;

export interface GraphCheckpointer {
  put(cp: Checkpoint): Promise<CheckpointRef>;
  get(ref: CheckpointRef): Promise<Checkpoint>;
  latest(runId: string): Promise<Checkpoint | undefined>;
  list(runId: string): AsyncIterable<CheckpointRef>;
  prune(runId: string, keep: number): Promise<void>;
}

// ── Errors ──────────────────────────────────────────────────────────

export class CheckpointNotFoundError extends Error {
  readonly runId: string;
  readonly superstep: number;

  constructor(ref: CheckpointRef) {
    super(
      `No checkpoint for run "${ref.runId}" at superstep ${String(ref.superstep)}. Run \`ls .bober/checkpoints/${ref.runId}\` to see what survived.`,
    );
    this.name = "CheckpointNotFoundError";
    this.runId = ref.runId;
    this.superstep = ref.superstep;
  }
}

/**
 * A checkpoint file that exists but does not decode.
 *
 * Raised for a truncated write, invalid JSON, a schema violation and an identity mismatch
 * alike: every one of them means the bytes on disk are not a checkpoint, and the ONLY safe
 * response is to refuse them rather than to resume from a half-state.
 */
export class CorruptCheckpointError extends Error {
  readonly runId: string;
  readonly superstep: number;
  readonly reason: string;

  constructor(ref: CheckpointRef, reason: string) {
    super(
      `Checkpoint ${ref.runId}/${String(ref.superstep)}.json is not readable as a checkpoint: ${reason}. It will not be resumed from; the last good checkpoint below it is used instead.`,
    );
    this.name = "CorruptCheckpointError";
    this.runId = ref.runId;
    this.superstep = ref.superstep;
    this.reason = reason;
  }
}

/** The checkpoint belongs to a different graph, or to a different version of this one. */
export class ChecksumMismatchError extends Error {
  readonly code = "ChecksumMismatch";
  readonly expected: { graphId: string; graphVersion: string; checksum: string };
  readonly actual: { graphId: string; graphVersion: string; checksum: string };

  constructor(
    expected: { graphId: string; graphVersion: string; checksum: string },
    actual: { graphId: string; graphVersion: string; checksum: string },
  ) {
    super(
      `Checkpoint was written against ${expected.graphId}@${expected.graphVersion} (${expected.checksum}) but the loaded topology is ${actual.graphId}@${actual.graphVersion} (${actual.checksum}). Resuming would replay completed task keys into a graph where they mean something else. Start a new run instead.`,
    );
    this.name = "ChecksumMismatchError";
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * A subgraph that declares its own persistence handle.
 *
 * The LangGraph "child checkpointer trap": a nested graph that opens its own saver splits
 * the run's state across two stores, and a resume then restores half of it. `CompiledGraph`
 * has no checkpointer field and `subgraphs[].persistence` is `z.literal("inherit")`, so the
 * defect is unrepresentable in a parsed artifact — this error is what a HAND-EDITED
 * artifact hits, and it carries the validator's own {@link DiagnosticCode} rather than a
 * second spelling of the same rule.
 */
export class NestedCheckpointerError extends Error {
  readonly code: DiagnosticCode = "NestedCheckpointer";
  readonly subgraphId: string;
  readonly persistence: string;

  constructor(subgraphId: string, persistence: string) {
    super(
      `Subgraph "${subgraphId}" declares persistence "${persistence}"; only "inherit" is representable. A child that opens its own checkpointer splits the run's state across two stores and a resume restores half of it (ADR-5).`,
    );
    this.name = "NestedCheckpointerError";
    this.subgraphId = subgraphId;
    this.persistence = persistence;
  }
}

// ── Graph identity ──────────────────────────────────────────────────

/** Throw {@link ChecksumMismatchError} unless the checkpoint belongs to this artifact. */
export function assertCheckpointMatchesGraph(cp: Checkpoint, spec: TopologySpec): void {
  if (
    cp.graphId === spec.graphId &&
    cp.graphVersion === spec.graphVersion &&
    cp.checksum === spec.checksum
  ) {
    return;
  }
  throw new ChecksumMismatchError(
    { graphId: cp.graphId, graphVersion: cp.graphVersion, checksum: cp.checksum },
    { graphId: spec.graphId, graphVersion: spec.graphVersion, checksum: spec.checksum },
  );
}

/**
 * The handle a child scope must use: the PARENT's, by identity.
 *
 * Deliberately returns the same object rather than a derived one, so "the child resolved
 * the parent's handle" is testable with `===` instead of with a path comparison.
 */
export function resolveCheckpointerFor<T>(
  parent: T,
  subgraph: { readonly id: string; readonly persistence: string },
): T {
  if (subgraph.persistence !== "inherit") {
    throw new NestedCheckpointerError(subgraph.id, subgraph.persistence);
  }
  return parent;
}

/**
 * Resolve every subgraph's checkpointer handle, BEFORE any node executes.
 *
 * Called from the interpreter's first line so a nested checkpointer is refused at the top
 * of the run rather than at the superstep that first enters the subgraph.
 */
export function resolveSubgraphCheckpointers<T>(
  spec: TopologySpec,
  parent: T,
): ReadonlyMap<string, T> {
  const resolved = new Map<string, T>();
  for (const subgraph of spec.subgraphs) {
    resolved.set(subgraph.id, resolveCheckpointerFor(parent, subgraph));
  }
  return resolved;
}

// ── Encoding ────────────────────────────────────────────────────────

/**
 * Indented, key-sorted JSON.
 *
 * Key-sorted so two identical checkpoints are byte-identical; indented so `git diff` on a
 * checkpoint shows which field moved rather than one 40 KB line. The whole debugging
 * affordance ADR-5 chose the filesystem for rests on this being readable.
 */
export function encodeCheckpoint(cp: Checkpoint): string {
  return `${JSON.stringify(JSON.parse(canonicalJson(cp)) as unknown, null, 2)}\n`;
}

/** Decode or throw. Never returns a partially valid checkpoint. */
export function decodeCheckpoint(raw: string, ref: CheckpointRef): Checkpoint {
  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new CorruptCheckpointError(
      ref,
      `invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const parsed = CheckpointSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new CorruptCheckpointError(
      ref,
      `schema violation at ${first.path.join(".") || "<root>"}: ${first.message}`,
    );
  }
  if (parsed.data.runId !== ref.runId || parsed.data.superstep !== ref.superstep) {
    throw new CorruptCheckpointError(
      ref,
      `identity mismatch — the file declares ${parsed.data.runId}/${String(parsed.data.superstep)}`,
    );
  }

  // Rebuilt field by field rather than returned as parsed: Zod's inferred type makes every
  // `unknown` field optional, and the declared interfaces are what the interpreter reads.
  const data = parsed.data;
  const decisions: Record<string, CheckpointOutcome> = {};
  for (const [checkpointId, outcome] of Object.entries(data.decisions)) {
    decisions[checkpointId] = toCheckpointOutcome(outcome);
  }
  return {
    formatVersion: data.formatVersion,
    runId: data.runId,
    superstep: data.superstep,
    nextSuperstep: data.nextSuperstep,
    graphId: data.graphId,
    graphVersion: data.graphVersion,
    checksum: data.checksum,
    createdAt: data.createdAt,
    state: data.state,
    pending: data.pending.map(toPendingTask),
    completedTaskKeys: data.completedTaskKeys,
    interrupt:
      data.interrupt === null
        ? null
        : {
            checkpointId: data.interrupt.checkpointId,
            nodeId: data.interrupt.nodeId,
            branchKeys: data.interrupt.branchKeys,
            payload: data.interrupt.payload,
            raisedAt: data.interrupt.raisedAt,
            superstep: data.interrupt.superstep,
          },
    decisions,
    activeBranches: data.activeBranches,
    joinBuffer: data.joinBuffer.map((bucket) => ({
      nodeId: bucket.nodeId,
      entries: bucket.entries.map((entry) => ({ branchKey: entry.branchKey, value: entry.value })),
    })),
    failures: data.failures,
    deadlocked: data.deadlocked,
  };
}

// ── Enumeration ─────────────────────────────────────────────────────

/**
 * The superstep numbers with a `<n>.json` file, ascending.
 *
 * Temp files never match, so a write that was killed before its rename contributes
 * nothing — which is why a partial checkpoint is invisible rather than merely invalid.
 */
export async function listCheckpointFiles(projectRoot: string, runId: string): Promise<number[]> {
  let names: string[];
  try {
    names = await readdir(checkpointDir(projectRoot, runId));
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    throw error;
  }
  const supersteps: number[] = [];
  for (const name of names) {
    const match = CHECKPOINT_FILE.exec(name);
    if (match) supersteps.push(Number(match[1]));
  }
  return supersteps.sort((a, b) => a - b);
}

// ── Checkpointer ────────────────────────────────────────────────────

/**
 * A checkpointer rooted at one project.
 *
 * @param projectRoot REQUIRED. There is deliberately no module-level instance: `worktree.ts`
 *   substitutes the project root per run, and a shared instance would write every
 *   worktree's checkpoints into whichever root loaded this module first.
 */
export function createFsCheckpointer(projectRoot: string): GraphCheckpointer {
  async function read(ref: CheckpointRef): Promise<Checkpoint> {
    const path = checkpointPath(projectRoot, ref.runId, ref.superstep);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if (errnoCode(error) === "ENOENT") {
        throw new CheckpointNotFoundError(ref);
      }
      throw error;
    }
    return decodeCheckpoint(raw, ref);
  }

  /** Every superstep whose file decodes. The contract `list` publishes. */
  async function readableSupersteps(runId: string): Promise<number[]> {
    const candidates = await listCheckpointFiles(projectRoot, runId);
    const readable: number[] = [];
    for (const superstep of candidates) {
      try {
        await read({ runId, superstep });
        readable.push(superstep);
      } catch (error) {
        if (error instanceof CorruptCheckpointError || error instanceof CheckpointNotFoundError) {
          continue;
        }
        throw error;
      }
    }
    return readable;
  }

  return {
    async put(cp): Promise<CheckpointRef> {
      // Validated on the way IN, so a state that no longer matches `OverallStateSchema`
      // fails at the superstep that produced it rather than at the resume six hours later.
      const parsed = CheckpointSchema.parse(cp);
      const dir = checkpointDir(projectRoot, parsed.runId);
      await mkdir(dir, { recursive: true });

      // Dot-prefixed and `.tmp`-suffixed, in the SAME directory as the final name: the
      // prefix keeps it out of every reader's enumeration, and same-directory is what
      // makes the rename below atomic rather than a cross-device copy.
      const temp = join(dir, `.${String(parsed.superstep)}.${randomUUID()}.tmp`);
      const final = join(dir, `${String(parsed.superstep)}.json`);
      const bytes = encodeCheckpoint(cp);

      try {
        const handle = await open(temp, "wx", 0o600);
        try {
          await handle.write(bytes);
          // Durability, not tidiness: without the fsync the rename can land before the
          // bytes do, and a power loss then leaves an EMPTY file under the final name.
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temp, final);
      } catch (error) {
        await unlink(temp).catch(() => {});
        throw error;
      }

      return { runId: parsed.runId, superstep: parsed.superstep };
    },

    get(ref): Promise<Checkpoint> {
      return read(ref);
    },

    async latest(runId): Promise<Checkpoint | undefined> {
      const candidates = await listCheckpointFiles(projectRoot, runId);
      // Highest first, and the FIRST one that decodes wins — so a checkpoint damaged by a
      // full disk falls back to the last good one instead of stranding the run.
      for (const superstep of [...candidates].sort((a, b) => b - a)) {
        try {
          return await read({ runId, superstep });
        } catch (error) {
          if (error instanceof CorruptCheckpointError || error instanceof CheckpointNotFoundError) {
            continue;
          }
          throw error;
        }
      }
      return undefined;
    },

    async *list(runId): AsyncIterable<CheckpointRef> {
      for (const superstep of await readableSupersteps(runId)) {
        yield { runId, superstep };
      }
    },

    async prune(runId, keep): Promise<void> {
      const retained = Math.max(0, Math.trunc(keep));
      const supersteps = await listCheckpointFiles(projectRoot, runId);
      // Newest first, keep the first `retained`, unlink the rest. Damaged files are pruned
      // by the same rule as good ones: a checkpoint too old to resume from is too old to
      // keep whether or not it decodes.
      const doomed = [...supersteps].sort((a, b) => b - a).slice(retained);
      for (const superstep of doomed.sort((a, b) => a - b)) {
        await unlink(checkpointPath(projectRoot, runId, superstep)).catch(() => {});
      }
    },
  };
}
