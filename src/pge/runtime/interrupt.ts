import type { BoberConfig } from "../../config/schema.js";
import type { EffectTag, NodeSpec } from "../../contracts/topology.js";
import { runWithAudit } from "../../orchestrator/checkpoints/audit.js";
import type { MechanismName } from "../../orchestrator/checkpoints/audit.js";
import {
  getCheckpointMechanismFor,
  resolveCheckpointMechanismName,
} from "../../orchestrator/checkpoints/registry.js";
import { isCheckpointId } from "../../orchestrator/checkpoints/types.js";
import type { CheckpointId, CheckpointOutcome } from "../../orchestrator/checkpoints/types.js";
import type { GraphMessage, OverallState } from "../state/overall.js";
import { OverallStateSchema } from "../state/overall.js";
import { CheckpointOutcomeSchema, toCheckpointOutcome } from "./checkpointer.js";
import type { Checkpoint, InterruptRecord } from "./checkpointer.js";
import { hashInput } from "./frontier.js";

/**
 * Human-in-the-loop interrupts, evaluated at a SUPERSTEP BOUNDARY (ADR-6).
 *
 * ── Before the node, never inside it ──
 *
 * {@link InterruptController.maybeInterrupt} is called by the interpreter BEFORE
 * `Scheduler.settle` dispatches anything, so a node body is entered only after its
 * approval has already been decided. The alternative — the framework idiom of calling
 * `interrupt()` from inside a node and restarting the node from the top on resume — makes
 * every file write, git operation and history append that precedes the pause execute
 * twice. Here the double-execution class does not exist: nothing ran, so nothing re-runs.
 *
 * ── One approval path, not two ──
 *
 * The mechanism is resolved through the SHIPPED registry (`getCheckpointMechanismFor`) and
 * every outcome is recorded through the SHIPPED audit writer (`runWithAudit`). No second
 * approval verb, no second audit file, no tenth checkpoint id — `bober approve` and
 * `bober reject` keep working against `.bober/approvals/`, and the audit stays at
 * `.bober/audits/<runId>.jsonl`. {@link assertKnownCheckpointId} is what stops a topology
 * artifact inventing an id the CLI cannot answer.
 *
 * ── Fail-closed is about WHO approved, not whether anything approved ──
 *
 * `noop` is the autopilot mechanism: it returns `{ approved: true }` without asking
 * anybody. That is fine for a planner clarification and unacceptable for a git commit or a
 * deploy, so an autopilot approval is deliberately NOT recorded as a grant. A node
 * carrying {@link GATED_EFFECTS} therefore proceeds only when a DURABLE mechanism — the
 * disk marker `bober approve` writes, a PR review, an interactive CLI answer — or a
 * decision supplied on resume actually granted its upstream gate. With no such record it
 * blocks, the node body is never entered, and the block is written to the audit log.
 *
 * ── An approval authorises ONE PASS, not a run (see {@link grantKey}) ──
 *
 * A graph has cycles: the coding topology's bounded rework loop re-enters the same nodes
 * with new content. An approval cached under the bare checkpoint id would therefore be
 * granted once and then silently re-used for every later iteration — the human approves
 * commit #1 and the run commits #2 and #3 on that record, with nothing in the audit to
 * show for it. So a grant is keyed by the PASS that earned it: the gate node, its branch,
 * its superstep and a hash of the exact payload the human was shown. Re-entering the gate
 * later is a different pass, the stale grant is DISCARDED before the mechanism is asked,
 * and the downstream git node fails closed if the second answer is no.
 *
 * The one re-entry that is the SAME pass is a resume: the interrupt checkpoint restores
 * the frontier into the superstep it paused at, so the gate is re-evaluated with an
 * identical pass identity and the decision `applyResume` recorded is found. That path — and
 * every other gate evaluation — writes an audit line, so "this gate authorised something"
 * is never an absence in `.bober/audits/<runId>.jsonl`.
 */

// ── Effects that require a recorded approval ────────────────────────

/**
 * The effects a node may not perform without a recorded approval.
 *
 * `git` is the commit path and `process-exec` is the deploy path — the two irreversible
 * things a run can do to a user's machine. `fs-write` and `network` are deliberately absent:
 * every node writes files, and gating that would make the gate meaningless.
 */
export const GATED_EFFECTS: readonly EffectTag[] = ["git", "process-exec"];

const GATED = new Set<string>(GATED_EFFECTS);

/** The gated effects a node declares, sorted. Empty when the node needs no approval. */
export function gatedEffectsOf(node: NodeSpec): EffectTag[] {
  return node.effects.filter((effect) => GATED.has(effect)).sort();
}

// ── Errors ──────────────────────────────────────────────────────────

/**
 * The suspend signal. Thrown by {@link InterruptController.raiseSuspend}, caught by the
 * interpreter and converted into `{ status: "interrupted" }`. A node handler must never
 * see it, which is exactly what evaluating interrupts before dispatch guarantees.
 */
export class GraphInterrupted extends Error {
  readonly record: InterruptRecord;

  constructor(record: InterruptRecord) {
    super(
      `Run paused at node "${record.nodeId}" for checkpoint "${record.checkpointId}" (superstep ${String(record.superstep)}). Answer it with \`bober approve\` / \`bober reject\` and resume.`,
    );
    this.name = "GraphInterrupted";
    this.record = record;
  }
}

/** A node declaring a gated effect with no HITL gate on any inbound edge. */
export class UngatedEffectError extends Error {
  readonly nodeId: string;
  readonly effects: EffectTag[];

  constructor(nodeId: string, effects: EffectTag[]) {
    super(
      `Node "${nodeId}" declares gated effects (${effects.join(", ")}) but no inbound edge comes from a node with a HITL policy. A git or deploy effect is reachable only through an approval gate (ADR-6).`,
    );
    this.name = "UngatedEffectError";
    this.nodeId = nodeId;
    this.effects = effects;
  }
}

/** A topology naming a checkpoint id outside the nine the shipped subsystem answers. */
export class UnknownCheckpointIdError extends Error {
  readonly nodeId: string;
  readonly checkpointId: string;

  constructor(nodeId: string, checkpointId: string) {
    super(
      `Node "${nodeId}" declares checkpointId "${checkpointId}", which is not one of the nine documented checkpoint ids. \`bober approve\` cannot answer it.`,
    );
    this.name = "UnknownCheckpointIdError";
    this.nodeId = nodeId;
    this.checkpointId = checkpointId;
  }
}

/** A resolved mechanism name the audit writer does not know how to attribute. */
export class UnknownMechanismNameError extends Error {
  readonly mechanism: string;

  constructor(mechanism: string) {
    super(
      `Checkpoint mechanism "${mechanism}" is registered but is not one of cli/disk/pr/noop, so the audit log cannot attribute an approver to it.`,
    );
    this.name = "UnknownMechanismNameError";
    this.mechanism = mechanism;
  }
}

/** `applyResume` on a checkpoint that is not paused. */
export class NoPendingInterruptError extends Error {
  readonly runId: string;
  readonly superstep: number;

  constructor(cp: Checkpoint) {
    super(
      `Checkpoint ${cp.runId}/${String(cp.superstep)} carries no pending interrupt, so there is no decision to apply to it.`,
    );
    this.name = "NoPendingInterruptError";
    this.runId = cp.runId;
    this.superstep = cp.superstep;
  }
}

// ── Shapes ──────────────────────────────────────────────────────────

/**
 * The HITL gate that authorises a downstream node's effects.
 *
 * Derived from the ARTIFACT by the interpreter — the checkpointId of a node with a `hitl`
 * policy that has a declared edge into this one — so what a topology diff shows is what
 * gates what.
 */
export interface EffectGate {
  readonly checkpointId: string;
  readonly gateNodeId: string;
  readonly onReject: string | null;
}

/**
 * What the controller needs from the run.
 *
 * Deliberately narrower than the interpreter's `RunContext`, which satisfies it
 * structurally: a controller that demanded the whole run context could not be exercised
 * without assembling eleven collaborators, and the type dependency would be circular.
 */
export interface InterruptContext {
  readonly runId: string;
  readonly projectRoot: string;
  readonly config: BoberConfig;
  readonly superstep: number;
  readonly branchKeys?: readonly string[];
}

/**
 * How an unanswered approval is handled.
 *
 * `mechanism` asks the shipped registry and blocks until it answers — right when the
 * approver is at the same terminal. `suspend` does not ask: it raises {@link
 * GraphInterrupted} so the process can exit with a checkpoint and a LATER CLI invocation
 * resumes with the decision. The second is the round trip ADR-5 chose the filesystem for.
 */
export const INTERRUPT_MODES = ["mechanism", "suspend"] as const;
export type InterruptMode = (typeof INTERRUPT_MODES)[number];

export interface InterruptController {
  /**
   * Decide whether `node` may execute. Returns the outcome, or throws
   * {@link GraphInterrupted} to pause the run.
   *
   * @param gate the HITL gate authorising this node's gated effects, or `null`.
   */
  maybeInterrupt(
    node: NodeSpec,
    payload: unknown,
    ctx: InterruptContext,
    gate?: EffectGate | null,
  ): Promise<CheckpointOutcome>;
  raiseSuspend(record: InterruptRecord): never;
  applyResume(cp: Checkpoint, value: unknown): Checkpoint;
  /**
   * Every decision granted so far, keyed by {@link grantKey}, for the checkpoint writer to
   * carry across a resume.
   */
  decisions(): Readonly<Record<string, CheckpointOutcome>>;
  /**
   * Re-seed the granted decisions from a restored checkpoint.
   *
   * Without it a run that pauses twice loses the FIRST approval on the second resume, and
   * a git node downstream of an already-approved gate would fail closed in the second
   * process for no reason a user could see. Restoring a key REPLACES whatever the same
   * scope held, so the "at most one grant per scope" invariant survives the round trip.
   */
  restore(decisions: Readonly<Record<string, CheckpointOutcome>>): void;
}

export interface InterruptControllerOptions {
  /** Default `"mechanism"`. */
  mode?: InterruptMode;
  /**
   * Decisions already recorded — restored from a checkpoint, or supplied on resume.
   *
   * Keyed by {@link grantKey}, NOT by checkpoint id: an approval belongs to the pass that
   * earned it. A record keyed by a bare checkpoint id grants nothing.
   */
  decisions?: Readonly<Record<string, CheckpointOutcome>>;
  /** ISO timestamp source for {@link InterruptRecord.raisedAt}. */
  nowIso?: () => string;
}

// ── Grant identity ──────────────────────────────────────────────────

/**
 * Separates the scope an approval lives in from the pass that earned it.
 *
 * Spelled with spaces so a checkpoint file stays readable with `cat` — the whole reason
 * ADR-5 chose the filesystem — and so the two halves are visually separable:
 * `"post-sprint @ gate_commit # 9f2c…"`. A checkpoint id is one of the nine documented
 * ids and contains no space, so the scope half cannot be confused with a node id that
 * happens to contain the separator.
 */
const GRANT_SEPARATOR = " # ";

/**
 * The scope an approval lives in: one checkpoint id, answered at one gate node.
 *
 * The downstream effect node knows only this much — its gate's checkpoint id and the gate
 * node that owns it, both read off the artifact by `computeEffectGates` — so this is the
 * key it looks a grant up by. At most one grant exists per scope at any moment, because a
 * fresh pass through the gate discards the previous one.
 */
export function grantScope(checkpointId: string, gateNodeId: string): string {
  return `${checkpointId} @ ${gateNodeId}${GRANT_SEPARATOR}`;
}

/** What makes one arrival at a gate node distinct from the next one. */
export interface GrantPass {
  readonly branchKeys: readonly string[];
  readonly superstep: number;
  /** Exactly the artifact the mechanism renders for the human. */
  readonly payload: unknown;
}

/**
 * `<scope>#<sha256(branchKeys, superstep, payload)>` — the identity of ONE pass.
 *
 * `payload` is in the key because the human approved THAT content and nothing else.
 * `superstep` is in it because a rework cycle can re-enter a gate with a payload that
 * happens to be byte-identical and still be a second, unapproved commit. `branchKeys` is
 * in it so one branch's approval is not another's.
 *
 * A resume reproduces all three exactly — the interrupt checkpoint restores the frontier
 * into the superstep it paused at, with the same task input — which is what makes the
 * resume a cache HIT rather than a second question to the human.
 */
export function grantKey(scope: string, pass: GrantPass): string {
  return `${scope}${hashInput([[...pass.branchKeys].sort(), pass.superstep, pass.payload])}`;
}

/** The scope half of a {@link grantKey}, or `null` for a key that is not one. */
function scopeOfKey(key: string): string | null {
  const at = key.lastIndexOf(GRANT_SEPARATOR);
  return at < 0 ? null : key.slice(0, at + GRANT_SEPARATOR.length);
}

// ── Helpers ─────────────────────────────────────────────────────────

const APPROVED: CheckpointOutcome = { approved: true };

/** True when the outcome lets the node run. An edit is an approval with a mutation. */
export function isApproved(outcome: CheckpointOutcome): boolean {
  if ("approved" in outcome) return outcome.approved;
  return outcome.edit === true;
}

/** Throw unless the artifact's checkpointId is one the shipped subsystem answers. */
export function assertKnownCheckpointId(nodeId: string, checkpointId: string): CheckpointId {
  if (!isCheckpointId(checkpointId)) throw new UnknownCheckpointIdError(nodeId, checkpointId);
  return checkpointId;
}

const MECHANISM_NAMES = new Set<string>(["cli", "disk", "pr", "noop"]);

function asMechanismName(name: string): MechanismName {
  if (!MECHANISM_NAMES.has(name)) throw new UnknownMechanismNameError(name);
  return name as MechanismName;
}

/**
 * The message a resumed decision leaves in state.
 *
 * `id` is derived from the checkpoint id, so applying the same decision twice REPLACES the
 * row instead of appending a second one — the same identity discipline the `appendById`
 * reducer uses for every other member of the `messages` channel.
 */
export function resumeMessageId(checkpointId: string): string {
  return `hitl:${checkpointId}`;
}

// ── Controller ──────────────────────────────────────────────────────

export function createInterruptController(
  options: InterruptControllerOptions = {},
): InterruptController {
  const mode: InterruptMode = options.mode ?? "mechanism";
  const nowIso = options.nowIso ?? ((): string => new Date().toISOString());
  /**
   * Approvals that a DURABLE source granted, keyed by {@link grantKey}.
   *
   * An autopilot (`noop`) approval never lands here, which is the whole fail-closed rule:
   * "something returned approved" and "a human approved" are different facts, and only the
   * second may authorise a git commit or a deploy.
   *
   * A `Map` rather than a record because insertion order is the only thing that makes
   * `decisions()` deterministic across a resume, and because the scope invariant below is
   * maintained by deleting keys, which is what `Map` is for.
   */
  const granted = new Map<string, CheckpointOutcome>(Object.entries(options.decisions ?? {}));

  /** Audit `iteration` is 1-based PER CHECKPOINT ID, counting every evaluation. */
  const evaluations = new Map<string, number>();
  const nextIteration = (checkpointId: string): number => {
    const iteration = (evaluations.get(checkpointId) ?? 0) + 1;
    evaluations.set(checkpointId, iteration);
    return iteration;
  };

  /**
   * Drop whatever this scope was granted for an EARLIER pass.
   *
   * Called the moment a gate is entered on a pass it has no answer for, and before the
   * mechanism is asked — so a gate that is about to re-ask cannot leave a stale approval
   * lying where its downstream git node would find it.
   */
  const clearScope = (scope: string): void => {
    for (const key of [...granted.keys()]) {
      if (key.startsWith(scope)) granted.delete(key);
    }
  };

  /** The one grant living in this scope, if any. */
  const grantInScope = (scope: string): CheckpointOutcome | undefined => {
    for (const [key, outcome] of granted) {
      if (key.startsWith(scope)) return outcome;
    }
    return undefined;
  };

  const controller: InterruptController = {
    raiseSuspend(record): never {
      throw new GraphInterrupted(record);
    },

    decisions(): Readonly<Record<string, CheckpointOutcome>> {
      return Object.fromEntries(granted);
    },

    restore(decisions): void {
      for (const [key, outcome] of Object.entries(decisions)) {
        const scope = scopeOfKey(key);
        if (scope !== null) clearScope(scope);
        granted.set(key, outcome);
      }
    },

    applyResume(cp, value): Checkpoint {
      if (cp.interrupt === null) throw new NoPendingInterruptError(cp);
      const outcome = toCheckpointOutcome(CheckpointOutcomeSchema.parse(value));
      const record = cp.interrupt;
      // Keyed by the PASS that was paused, so the gate this decision answers finds it on
      // re-entry at the same superstep and a LATER iteration of a rework cycle does not.
      const scope = grantScope(record.checkpointId, record.nodeId);
      const key = grantKey(scope, {
        branchKeys: record.branchKeys,
        superstep: record.superstep,
        payload: record.payload,
      });
      clearScope(scope);
      granted.set(key, outcome);

      // The decision has to be IN STATE, not merely in the controller: the node that runs
      // next reads the frozen state snapshot and nothing else, and a resumed run in a
      // fresh process has no memory of the conversation that produced the answer.
      const message: GraphMessage = {
        id: resumeMessageId(record.checkpointId),
        seq: record.superstep,
        role: "user",
        nodeId: record.nodeId,
        text: JSON.stringify(outcome),
        tokens: 0,
      };
      const messages = [
        ...cp.state.messages.filter((existing) => existing.id !== message.id),
        message,
      ].sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const state: OverallState = OverallStateSchema.parse({ ...cp.state, messages });

      const carried = Object.fromEntries(
        Object.entries(cp.decisions).filter(([existing]) => !existing.startsWith(scope)),
      );
      return {
        ...cp,
        interrupt: null,
        decisions: { ...carried, [key]: outcome },
        state,
      };
    },

    async maybeInterrupt(node, payload, ctx, gate = null): Promise<CheckpointOutcome> {
      const gated = gatedEffectsOf(node);
      const hitl = node.hitl;

      // The overwhelmingly common case: an ordinary node. No mechanism is resolved, no
      // audit line is written, and the shipped checkpoint subsystem is never touched.
      if (hitl === undefined && gated.length === 0) return APPROVED;

      if (hitl !== undefined) {
        const checkpointId = assertKnownCheckpointId(node.id, hitl.checkpointId);
        const scope = grantScope(checkpointId, node.id);
        const key = grantKey(scope, {
          branchKeys: ctx.branchKeys ?? [],
          superstep: ctx.superstep,
          payload,
        });
        const mechanismName = asMechanismName(
          resolveCheckpointMechanismName(checkpointId, ctx.config),
        );

        const already = granted.get(key);
        if (already !== undefined) {
          // The SAME pass, re-entered — which in practice means a resume walking back into
          // the superstep it paused at. Nobody is asked again, but the audit still records
          // that this gate authorised this pass: sc-8-7 wants the checkpoint id named every
          // time something was let through, and a silent return is an absence.
          return await runWithAudit<CheckpointOutcome>({
            projectRoot: ctx.projectRoot,
            runId: ctx.runId,
            checkpointId,
            mechanism: mechanismName,
            iteration: nextIteration(checkpointId),
            fn: (): Promise<CheckpointOutcome> => Promise.resolve(already),
          });
        }

        // A pass nobody has answered. Whatever an EARLIER pass was granted is void from
        // here on — dropped BEFORE the question is asked, so a gate that is about to
        // re-ask cannot leave its previous approval where the git node downstream would
        // find it while the human is still deciding.
        clearScope(scope);

        if (mode === "suspend") {
          const record: InterruptRecord = {
            checkpointId,
            nodeId: node.id,
            branchKeys: [...(ctx.branchKeys ?? [])].sort(),
            payload,
            raisedAt: nowIso(),
            superstep: ctx.superstep,
          };
          // Through the SAME writer as every other outcome, so a paused run is one line in
          // the same audit file. `runWithAudit` maps a throw to `aborted` and re-throws it.
          return await runWithAudit<CheckpointOutcome>({
            projectRoot: ctx.projectRoot,
            runId: ctx.runId,
            checkpointId,
            mechanism: mechanismName,
            iteration: nextIteration(checkpointId),
            fn: (): Promise<CheckpointOutcome> => {
              controller.raiseSuspend(record);
            },
          });
        }

        const mechanism = getCheckpointMechanismFor(checkpointId, ctx.config);
        const outcome = await runWithAudit<CheckpointOutcome>({
          projectRoot: ctx.projectRoot,
          runId: ctx.runId,
          checkpointId,
          mechanism: mechanismName,
          iteration: nextIteration(checkpointId),
          fn: () => mechanism.request(checkpointId, payload),
        });

        // Autopilot did not ask anybody, so it does not GRANT anybody's approval. The
        // node itself still proceeds — a planner clarification under autopilot is meant to
        // — but nothing downstream may cite this as a recorded approval.
        if (mechanismName !== "noop") granted.set(key, outcome);
        return outcome;
      }

      // ── A gated-effect node: git or deploy ──
      if (gate === null) throw new UngatedEffectError(node.id, gated);
      const checkpointId = assertKnownCheckpointId(gate.gateNodeId, gate.checkpointId);
      const mechanismName = asMechanismName(
        resolveCheckpointMechanismName(checkpointId, ctx.config),
      );
      // The grant living in the gate's scope — which is the one its LATEST pass recorded,
      // because a fresh pass clears the scope before it asks. An approval of iteration 1
      // therefore cannot authorise iteration 2's commit.
      const grant = grantInScope(grantScope(checkpointId, gate.gateNodeId));
      const allowed = grant !== undefined && isApproved(grant);

      const outcome: CheckpointOutcome = allowed
        ? APPROVED
        : {
            approved: false,
            feedback: `FAIL_CLOSED: node "${node.id}" declares effects (${gated.join(", ")}) and there is no recorded approval for checkpoint "${checkpointId}". The node was not executed.`,
          };

      // Audited in BOTH directions, and under the GATE's checkpoint id in both: an
      // executed git commit is exactly as much of an audit fact as a blocked one.
      await runWithAudit<CheckpointOutcome>({
        projectRoot: ctx.projectRoot,
        runId: ctx.runId,
        checkpointId,
        mechanism: mechanismName,
        iteration: nextIteration(checkpointId),
        fn: (): Promise<CheckpointOutcome> => Promise.resolve(outcome),
      });

      return outcome;
    },
  };

  return controller;
}
