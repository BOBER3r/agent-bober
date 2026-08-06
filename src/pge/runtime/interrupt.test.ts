import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { NodeSpec } from "../../contracts/topology.js";
import { DiskCheckpointMechanism } from "../../orchestrator/checkpoints/mechanisms/disk.js";
import {
  getCheckpointMechanism,
  registerCheckpointMechanism,
} from "../../orchestrator/checkpoints/registry.js";
import { CHECKPOINT_IDS } from "../../orchestrator/checkpoints/types.js";
import type { CheckpointMechanism, CheckpointOutcome } from "../../orchestrator/checkpoints/types.js";
import { initialOverallState } from "../state/overall.js";
import {
  CHECKPOINT_FORMAT_VERSION,
  createFsCheckpointer,
} from "./checkpointer.js";
import type { Checkpoint } from "./checkpointer.js";
import { CheckpointerRequiredError, computeEffectGates } from "./interpreter.js";
import {
  GATED_EFFECTS,
  GraphInterrupted,
  NoPendingInterruptError,
  UngatedEffectError,
  UnknownCheckpointIdError,
  assertKnownCheckpointId,
  createInterruptController,
  gatedEffectsOf,
  grantKey,
  grantScope,
  isApproved,
  resumeMessageId,
} from "./interrupt.js";
import {
  HITL_CHECKPOINTS,
  HITL_NODES,
  hitlConfig,
  hitlReworkSpec,
  hitlSpec,
  runHitl,
} from "./__fixtures__/hitl-graph.js";
import { goldenSpec } from "./__fixtures__/golden-graph.js";

/**
 * Human-in-the-loop interrupts at the superstep boundary (ADR-6).
 *
 * Two families of assertion, and the second is the one that matters:
 *
 *  1. The controller resolves through the SHIPPED subsystem — `getCheckpointMechanismFor`
 *     and `runWithAudit` — rather than a second approval path. Asserted by registering a
 *     real `DiskCheckpointMechanism` into the shipped registry, answering it the way
 *     `bober approve` does (by dropping `<id>.approved.json` next to the pending marker),
 *     and then reading `.bober/audits/<runId>.jsonl` — the file the existing subsystem
 *     writes, at the path it already used.
 *  2. A blocked effect DID NOT HAPPEN. `HitlBehaviour.performed` records a node the instant
 *     its body is entered, so "the git commit was refused" is checked as an empty array
 *     rather than as the presence of an error — an implementation that ran the commit and
 *     then reported a rejection fails.
 *
 * ── The gate is entered more than once ──
 *
 * `hitlSpec()` is a straight line, and a straight line cannot express the failure this
 * subsystem is most exposed to: a gate inside a REWORK CYCLE, asked once and thereafter
 * self-approving. `hitlReworkSpec()` adds the one edge that closes the loop, and the
 * REWORK CYCLE group below is what makes "an approval authorises one pass" falsifiable.
 *
 * ── Mutation-proven ──
 *
 * Run against each of these breakages of `interrupt.ts`, measured across all of
 * `src/pge/runtime` (337 tests at the time), and reverted:
 *
 *  - the reviewed defect itself — one grant per checkpoint id, returned silently on
 *    re-entry — restored as `if (grantInScope(scope) !== undefined) return it` before the
 *    pass lookup: 6 red, four in the REWORK CYCLE group and two in controller primitives;
 *  - a cache hit returning the grant WITHOUT `runWithAudit`: 1 red, the gate that
 *    authorised a pass and wrote nothing down;
 *  - not clearing the scope before re-asking, so a stale approval outlives the pass that
 *    earned it: 2 red, including the autopilot-takeover case where the stale grant would
 *    pay for a second commit;
 *  - `applyResume` recording the decision under the bare checkpoint id instead of the
 *    pass key: 3 red, because the resumed gate then never finds the answer it was given.
 *
 * Earlier breakages this suite was also built against, each observed red when it was
 * introduced: the controller granting on a `noop` outcome as well as a durable one; the
 * gate decision no longer gating dispatch; the suspend path dispatching the superstep
 * before returning `interrupted`; `applyResume` not writing the decision into
 * `state.messages`.
 */

let root = "";
let approvals = "";
let originalDisk: CheckpointMechanism;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-pge-hitl-"));
  approvals = join(root, ".bober", "approvals");
  await mkdir(approvals, { recursive: true });
  originalDisk = getCheckpointMechanism("disk");
});

afterEach(async () => {
  // The registry is module state. Restore the shipped instance so no other suite inherits
  // a mechanism pointed at a temp directory that no longer exists.
  registerCheckpointMechanism("disk", originalDisk);
  await rm(root, { recursive: true, force: true });
});

// ── Approval helpers ────────────────────────────────────────────────

/**
 * Answer whatever the disk mechanism asks, the way `bober approve` does.
 *
 * The shipped mechanism deletes stale markers when it starts and then POLLS, so an
 * approval written up front is thrown away — the round trip genuinely has to happen while
 * the run is blocked. The marker is written temp-plus-rename because the mechanism reads
 * the file the moment it appears, and a half-written one makes it throw.
 */
function startApprover(decision: "approved" | "rejected"): { stop: () => Promise<string[]> } {
  const answered: string[] = [];
  let running = true;
  const loop = (async (): Promise<void> => {
    while (running) {
      const names = await readdir(approvals).catch(() => [] as string[]);
      for (const name of names) {
        if (!name.endsWith(".pending.json")) continue;
        const id = name.slice(0, -".pending.json".length);
        const marker = join(approvals, `${id}.${decision}.json`);
        const temp = join(approvals, `.${id}.${String(answered.length)}.answer.tmp`);
        const body =
          decision === "approved"
            ? JSON.stringify({ approvedBy: "test" })
            : JSON.stringify({ feedback: "not this time" });
        try {
          await writeFile(temp, body, "utf8");
          await rename(temp, marker);
          answered.push(id);
        } catch {
          // The run finished and its temp root went away mid-poll. Nothing to answer.
          running = false;
        }
      }
      if (running) await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();
  return {
    stop: async (): Promise<string[]> => {
      running = false;
      await loop;
      return answered;
    },
  };
}

interface AuditLine {
  checkpointId: string;
  mechanism: string;
  outcome: string;
  runId: string;
  feedbackText?: string;
}

async function readAudit(runId: string): Promise<AuditLine[]> {
  const raw = await readFile(join(root, ".bober", "audits", `${runId}.jsonl`), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AuditLine);
}

function useDisk(): void {
  registerCheckpointMechanism("disk", new DiskCheckpointMechanism(approvals, { pollMs: 5 }));
}

// ── Vocabulary ──────────────────────────────────────────────────────

describe("what is gated", () => {
  it("gates exactly the two irreversible effects, and nothing else", () => {
    expect([...GATED_EFFECTS].sort()).toEqual(["git", "process-exec"]);
  });

  it("does not gate fs-write or network, because every node writes files", () => {
    const node = { effects: ["fs-write", "network"] } as unknown as NodeSpec;
    expect(gatedEffectsOf(node)).toEqual([]);
  });

  it("reports the gated effects a node declares, sorted", () => {
    const node = { effects: ["network", "process-exec", "git"] } as unknown as NodeSpec;
    expect(gatedEffectsOf(node)).toEqual(["git", "process-exec"]);
  });

  it("accepts only the nine documented checkpoint ids", () => {
    for (const id of CHECKPOINT_IDS) {
      expect(assertKnownCheckpointId("n", id)).toBe(id);
    }
    expect(() => assertKnownCheckpointId("n", "post-vibes")).toThrow(UnknownCheckpointIdError);
    expect(() => assertKnownCheckpointId("n", "post-sprint ")).toThrow(/nine documented/);
  });

  it("treats an edit as an approval and a rejection as a block", () => {
    expect(isApproved({ approved: true })).toBe(true);
    expect(isApproved({ edit: true, editDelta: "x" })).toBe(true);
    expect(isApproved({ approved: false, feedback: "no" })).toBe(false);
  });
});

describe("effect gates are read off the artifact", () => {
  it("binds each gated node to the HITL gate with a declared edge into it", () => {
    const gates = computeEffectGates(hitlSpec());
    expect(gates.get(HITL_NODES.commit)).toEqual({
      checkpointId: HITL_CHECKPOINTS.commit,
      gateNodeId: HITL_NODES.gateCommit,
      onReject: HITL_NODES.gracefulFailure,
    });
    expect(gates.get(HITL_NODES.deploy)).toEqual({
      checkpointId: HITL_CHECKPOINTS.deploy,
      gateNodeId: HITL_NODES.gateDeploy,
      onReject: HITL_NODES.gracefulFailure,
    });
    expect(gates.get(HITL_NODES.finalize)).toBeUndefined();
  });

  it("finds no gates in a topology that declares no HITL policy", () => {
    expect(computeEffectGates(goldenSpec()).size).toBe(0);
  });

  it("throws UngatedEffectError for a gated node with no gate", async () => {
    const controller = createInterruptController();
    const node = { id: "rogue", effects: ["git"], hitl: undefined } as unknown as NodeSpec;
    await expect(
      controller.maybeInterrupt(
        node,
        {},
        { runId: "r", projectRoot: root, config: hitlConfig(), superstep: 0 },
        null,
      ),
    ).rejects.toThrow(UngatedEffectError);
  });
});

// ── Fail-closed (sc-8-7) ────────────────────────────────────────────

describe("FAIL CLOSED: git and deploy are unreachable without a recorded approval (sc-8-7)", () => {
  it("blocks BOTH effectful nodes under autopilot and never enters either body", async () => {
    const performed: string[] = [];
    const run = await runHitl({ projectRoot: root, behaviour: { performed } });

    // The claim that matters: the git commit did not happen.
    expect(performed).toEqual([]);
    expect(run.handlerLog.calls[HITL_NODES.commit]).toBeUndefined();
    expect(run.handlerLog.calls[HITL_NODES.deploy]).toBeUndefined();

    // And the run ended through the rejection terminal rather than reporting success.
    expect(run.result.status).toBe("completed");
    expect(run.finalState.verdict).toBe("failed");
    expect(run.handlerLog.calls[HITL_NODES.gracefulFailure]).toBe(1);
  });

  it("records the block in the audit log, under the GATE's checkpoint id", async () => {
    const performed: string[] = [];
    const run = await runHitl({ projectRoot: root, behaviour: { performed } });
    const audit = await readAudit(run.runId);

    const blocked = audit.filter((line) => line.outcome === "rejected");
    expect(blocked).toHaveLength(1);
    expect(blocked[0].checkpointId).toBe(HITL_CHECKPOINTS.commit);
    expect(blocked[0].runId).toBe(run.runId);
    expect(blocked[0].feedbackText).toContain("FAIL_CLOSED");
    expect(blocked[0].feedbackText).toContain(HITL_NODES.commit);
  });

  it("marks the blocked span failClosed rather than merely absent", async () => {
    const performed: string[] = [];
    const run = await runHitl({ projectRoot: root, behaviour: { performed } });

    const span = run.spans.find((s) => s.nodeId === HITL_NODES.commit);
    expect(span?.status).toBe("interrupted");
    expect(span?.failClosed).toBe(true);
    expect(span?.errorClass).toBe("FailClosed");
  });

  it("counts a fail-closed block as a run failure, so the verdict cannot be success", async () => {
    const performed: string[] = [];
    const run = await runHitl({ projectRoot: root, behaviour: { performed } });
    expect(run.result.status).toBe("completed");
    if (run.result.status !== "completed") return;
    expect(run.result.failures.map((f) => f.errorClass)).toContain("FailClosed");
    expect(run.result.verdict).not.toBe("success");
  });

  it("lets BOTH proceed once a durable mechanism has recorded an approval", async () => {
    useDisk();
    const approver = startApprover("approved");
    const performed: string[] = [];
    const run = await runHitl({
      projectRoot: root,
      behaviour: { performed },
      config: hitlConfig({ checkpointMechanism: "disk" }),
    });
    const answered = await approver.stop();

    expect(performed).toEqual([HITL_NODES.commit, HITL_NODES.deploy]);
    expect(run.finalState.verdict).toBe("success");
    expect([...new Set(answered)].sort()).toEqual(
      [HITL_CHECKPOINTS.commit, HITL_CHECKPOINTS.deploy].sort(),
    );

    // The audit names the checkpoint id in this direction too — once for the gate, once
    // for the effect it authorised.
    const audit = await readAudit(run.runId);
    expect(audit.every((line) => line.outcome === "approved")).toBe(true);
    expect(audit.filter((l) => l.checkpointId === HITL_CHECKPOINTS.commit)).toHaveLength(2);
    expect(audit.filter((l) => l.checkpointId === HITL_CHECKPOINTS.deploy)).toHaveLength(2);
  });

  it("routes to the gate's onReject and performs nothing when the human says no", async () => {
    useDisk();
    const approver = startApprover("rejected");
    const performed: string[] = [];
    const run = await runHitl({
      projectRoot: root,
      behaviour: { performed },
      config: hitlConfig({ checkpointMechanism: "disk" }),
    });
    await approver.stop();

    expect(performed).toEqual([]);
    expect(run.handlerLog.calls[HITL_NODES.gracefulFailure]).toBe(1);
    expect(run.finalState.verdict).toBe("failed");

    const rejectionSpan = run.spans.find((s) => s.nodeId === HITL_NODES.gateCommit);
    expect(rejectionSpan?.status).toBe("interrupted");
    // A human saying no is the gate WORKING, not a fail-closed block.
    expect(rejectionSpan?.failClosed).toBe(false);
    expect(rejectionSpan?.errorClass).toBe("HitlRejected");
  });
});

// ── A gate inside a rework cycle (sc-8-7) ───────────────────────────

/**
 * Register a scripted mechanism under `disk` and record what it was asked.
 *
 * A real `DiskCheckpointMechanism` is exercised by the sc-8-8 group above; here the
 * question is HOW MANY TIMES the gate was asked and with WHAT, which a scripted mechanism
 * answers without a polling round trip. It still goes through the shipped
 * `getCheckpointMechanismFor` and the shipped `runWithAudit` — only the human is scripted.
 */
function scriptMechanism(
  answers: readonly CheckpointOutcome[],
): { asked: Array<{ checkpointId: string; artifact: unknown }> } {
  const asked: Array<{ checkpointId: string; artifact: unknown }> = [];
  registerCheckpointMechanism("disk", {
    request: (checkpointId, artifact): Promise<CheckpointOutcome> => {
      asked.push({ checkpointId, artifact });
      const answer = answers[Math.min(asked.length - 1, answers.length - 1)];
      return Promise.resolve(answer);
    },
  });
  return { asked };
}

describe("REWORK CYCLE: one approval authorises one pass, not the loop (sc-8-7)", () => {
  it("asks the gate again on the second iteration and blocks the second commit when the answer is no", async () => {
    const { asked } = scriptMechanism([
      { approved: true },
      { approved: false, feedback: "not this revision" },
    ]);
    const performed: string[] = [];
    const run = await runHitl({
      projectRoot: root,
      spec: hitlReworkSpec(),
      behaviour: { performed, reworkRounds: 1 },
      config: hitlConfig({ checkpointMechanism: "disk" }),
    });

    // The gate really was entered twice, with DIFFERENT content each time.
    const gateAsks = asked.filter((a) => a.checkpointId === HITL_CHECKPOINTS.commit);
    expect(gateAsks).toHaveLength(2);
    expect(gateAsks[0].artifact).toEqual({ drafted: true });
    expect(gateAsks[1].artifact).toEqual({ performed: HITL_NODES.commit, revision: 1 });

    // The claim that matters: exactly ONE commit happened. Iteration 2 was refused, and
    // iteration 1's approval did not pay for it.
    expect(performed).toEqual([HITL_NODES.commit]);
    expect(run.handlerLog.calls[HITL_NODES.commit]).toBe(1);
    expect(run.handlerLog.calls[HITL_NODES.gateCommit]).toBe(1);
    expect(run.handlerLog.calls[HITL_NODES.gracefulFailure]).toBe(1);
    expect(run.finalState.verdict).toBe("failed");
  });

  it("writes an audit line for EVERY gate evaluation, so a re-entered gate is never silent", async () => {
    const { asked } = scriptMechanism([
      { approved: true },
      { approved: false, feedback: "not this revision" },
    ]);
    const run = await runHitl({
      projectRoot: root,
      spec: hitlReworkSpec(),
      behaviour: { performed: [], reworkRounds: 1 },
      config: hitlConfig({ checkpointMechanism: "disk" }),
    });
    expect(asked).toHaveLength(2);

    const lines = (await readAudit(run.runId)).filter(
      (line) => line.checkpointId === HITL_CHECKPOINTS.commit,
    );
    // gate pass 1 approved, the commit it authorised, gate pass 2 rejected.
    expect(lines.map((line) => line.outcome)).toEqual(["approved", "approved", "rejected"]);
    expect(lines[2].feedbackText).toContain("not this revision");
  });

  it("commits twice only when the human approves twice", async () => {
    const { asked } = scriptMechanism([{ approved: true }]);
    const performed: string[] = [];
    const run = await runHitl({
      projectRoot: root,
      spec: hitlReworkSpec(),
      behaviour: { performed, reworkRounds: 1 },
      config: hitlConfig({ checkpointMechanism: "disk" }),
    });

    expect(asked.filter((a) => a.checkpointId === HITL_CHECKPOINTS.commit)).toHaveLength(2);
    expect(performed).toEqual([HITL_NODES.commit, HITL_NODES.commit, HITL_NODES.deploy]);
    expect(run.finalState.verdict).toBe("success");

    // Two approvals, two commits, and one audit line per gate evaluation and per effect.
    const lines = (await readAudit(run.runId)).filter(
      (line) => line.checkpointId === HITL_CHECKPOINTS.commit,
    );
    expect(lines).toHaveLength(4);
    expect(lines.map((line) => line.iteration)).toEqual([1, 2, 3, 4]);
  });

  it("blocks the second commit when autopilot takes over after one durable approval", async () => {
    // The reviewer's scenario in its harshest form: ONE recorded approval of the gate's
    // first pass, and thereafter a mechanism that grants nothing durable. The stale grant
    // must not survive into iteration 2.
    const performed: string[] = [];
    const spec = hitlReworkSpec();
    const gateTask = { drafted: true };
    const run = await runHitl({
      projectRoot: root,
      spec,
      behaviour: { performed, reworkRounds: 1 },
      interrupts: createInterruptController({
        decisions: {
          [grantKey(grantScope(HITL_CHECKPOINTS.commit, HITL_NODES.gateCommit), {
            branchKeys: [],
            superstep: 1,
            payload: gateTask,
          })]: { approved: true },
        },
      }),
    });

    expect(performed).toEqual([HITL_NODES.commit]);
    expect(run.handlerLog.calls[HITL_NODES.commit]).toBe(1);
    expect(run.finalState.verdict).toBe("failed");
    const blocked = (await readAudit(run.runId)).filter((line) => line.outcome === "rejected");
    expect(blocked.map((line) => line.checkpointId)).toEqual([HITL_CHECKPOINTS.commit]);
    expect(blocked[0].feedbackText).toContain("FAIL_CLOSED");
    expect(blocked[0].feedbackText).toContain(HITL_NODES.commit);
  });
});

// ── Mechanism + audit wiring (sc-8-8) ───────────────────────────────

describe("resolves through the SHIPPED registry and audit writer (sc-8-8)", () => {
  it("uses the configured disk mechanism, at the path bober approve already writes", async () => {
    useDisk();
    const approver = startApprover("approved");
    const seenPending: string[] = [];
    // Observe the pending markers the shipped mechanism itself writes.
    const watcher = setInterval(() => {
      void readdir(approvals).then((names) => {
        for (const name of names) {
          if (name.endsWith(".pending.json")) seenPending.push(name);
        }
      });
    }, 4);
    const performed: string[] = [];
    const run = await runHitl({
      projectRoot: root,
      behaviour: { performed },
      config: hitlConfig({ checkpointMechanism: "disk" }),
    });
    clearInterval(watcher);
    await approver.stop();

    const audit = await readAudit(run.runId);
    expect(audit.length).toBeGreaterThanOrEqual(4);
    expect(new Set(audit.map((line) => line.mechanism))).toEqual(new Set(["disk"]));
    expect(new Set(audit.map((line) => line.checkpointId))).toEqual(
      new Set([HITL_CHECKPOINTS.commit, HITL_CHECKPOINTS.deploy]),
    );
    // Not a new file in a new place: the audit lives where the shipped subsystem puts it.
    expect(await readdir(join(root, ".bober", "audits"))).toEqual([`${run.runId}.jsonl`]);
  });

  it("records the mechanism as noop under autopilot, without asking anybody", async () => {
    const performed: string[] = [];
    const run = await runHitl({ projectRoot: root, behaviour: { performed } });
    const audit = await readAudit(run.runId);
    expect(new Set(audit.map((line) => line.mechanism))).toEqual(new Set(["noop"]));
    // No approval marker was written, because nothing was asked.
    expect(await readdir(approvals)).toEqual([]);
  });

  it("takes the fast path for an ordinary node: no mechanism, no audit line", async () => {
    const controller = createInterruptController();
    const plain = { id: "plain", effects: [], hitl: undefined } as unknown as NodeSpec;
    const outcome = await controller.maybeInterrupt(
      plain,
      {},
      { runId: "run-plain", projectRoot: root, config: hitlConfig(), superstep: 0 },
    );
    expect(outcome).toEqual({ approved: true });
    await expect(readAudit("run-plain")).rejects.toThrow();
  });

  it("writes no audit line for the golden topology, which declares no HITL policy anywhere", async () => {
    expect(goldenSpec().nodes.filter((node) => node.hitl !== undefined)).toEqual([]);
    expect(computeEffectGates(goldenSpec()).size).toBe(0);
  });
});

// ── Suspend and resume (sc-8-5, sc-8-6) ─────────────────────────────

describe("INTERRUPT: pauses between supersteps and resumes with the decision (sc-8-5)", () => {
  it("returns status interrupted with the checkpoint holding the pending payload", async () => {
    const checkpointer = createFsCheckpointer(root);
    const performed: string[] = [];
    const paused = await runHitl({
      projectRoot: root,
      behaviour: { performed },
      checkpointer,
      interrupts: createInterruptController({ mode: "suspend" }),
    });

    expect(paused.result.status).toBe("interrupted");
    if (paused.result.status !== "interrupted") return;
    expect(paused.result.pending.nodeId).toBe(HITL_NODES.gateCommit);
    expect(paused.result.pending.checkpointId).toBe(HITL_CHECKPOINTS.commit);

    const stored = await checkpointer.get(paused.result.checkpointRef);
    expect(stored.interrupt?.checkpointId).toBe(HITL_CHECKPOINTS.commit);
    expect(stored.interrupt?.payload).toEqual({ drafted: true });
    // The WHOLE frontier is preserved — the paused node is still pending, not dropped.
    expect(stored.pending.map((t) => t.nodeId)).toEqual([HITL_NODES.gateCommit]);
    // And the interrupt checkpoint resumes INTO the same superstep, not the one after it.
    expect(stored.nextSuperstep).toBe(stored.superstep);
  });

  it("records the pause in the SAME audit file as every other outcome", async () => {
    const checkpointer = createFsCheckpointer(root);
    const paused = await runHitl({
      projectRoot: root,
      behaviour: { performed: [] },
      checkpointer,
      interrupts: createInterruptController({ mode: "suspend" }),
    });
    expect(paused.result.status).toBe("interrupted");

    const audit = await readAudit(paused.runId);
    expect(audit).toHaveLength(1);
    expect(audit[0].checkpointId).toBe(HITL_CHECKPOINTS.commit);
    expect(audit[0].outcome).toBe("aborted");
    expect(audit[0].feedbackText).toContain("bober approve");
  });

  it("cannot pause without somewhere to persist the pause", async () => {
    await expect(
      runHitl({
        projectRoot: root,
        behaviour: { performed: [] },
        interrupts: createInterruptController({ mode: "suspend" }),
      }),
    ).rejects.toThrow(CheckpointerRequiredError);
  });

  it("executes NO further node while paused", async () => {
    const checkpointer = createFsCheckpointer(root);
    const performed: string[] = [];
    const paused = await runHitl({
      projectRoot: root,
      behaviour: { performed },
      checkpointer,
      interrupts: createInterruptController({ mode: "suspend" }),
    });

    expect(paused.handlerLog.calls).toEqual({ [HITL_NODES.plan]: 1 });
    expect(performed).toEqual([]);
    expect(paused.spans.map((s) => `${s.nodeId}:${s.status}`)).toEqual([
      `${HITL_NODES.plan}:ok`,
      `${HITL_NODES.gateCommit}:interrupted`,
    ]);
  });

  it("resumes at exactly that node with the human decision present in state", async () => {
    const checkpointer = createFsCheckpointer(root);
    const paused = await runHitl({
      projectRoot: root,
      behaviour: { performed: [] },
      checkpointer,
      interrupts: createInterruptController({ mode: "suspend" }),
    });
    expect(paused.result.status).toBe("interrupted");
    if (paused.result.status !== "interrupted") return;

    const performed: string[] = [];
    const resumed = await runHitl({
      projectRoot: root,
      runId: paused.runId,
      behaviour: { performed },
      checkpointer,
      interrupts: createInterruptController({ mode: "suspend" }),
      resumeFrom: { ref: paused.result.checkpointRef, value: { approved: true } },
    });

    // The decision is IN STATE, so a process that knows nothing about the conversation
    // that produced it can still see what was decided.
    const decision = resumed.finalState.messages.find(
      (m) => m.id === resumeMessageId(HITL_CHECKPOINTS.commit),
    );
    expect(decision).toBeDefined();
    expect(decision?.nodeId).toBe(HITL_NODES.gateCommit);
    expect(JSON.parse(decision?.text ?? "null")).toEqual({ approved: true });

    // The approved gate authorised its downstream effect; the SECOND gate then paused.
    expect(performed).toEqual([HITL_NODES.commit]);
    expect(resumed.result.status).toBe("interrupted");
  });
});

describe("INTERRUPT: no node body re-runs across the pause (sc-8-6)", () => {
  it("records ZERO handler invocations for the interrupted node before resume and exactly one after", async () => {
    const checkpointer = createFsCheckpointer(root);
    const paused = await runHitl({
      projectRoot: root,
      behaviour: { performed: [] },
      checkpointer,
      interrupts: createInterruptController({ mode: "suspend" }),
    });
    expect(paused.result.status).toBe("interrupted");
    if (paused.result.status !== "interrupted") return;

    // BEFORE: the interrupt fired before dispatch, so the gate's body was never entered.
    expect(paused.handlerLog.calls[HITL_NODES.gateCommit]).toBeUndefined();

    const resumed = await runHitl({
      projectRoot: root,
      runId: paused.runId,
      behaviour: { performed: [] },
      checkpointer,
      interrupts: createInterruptController({ mode: "suspend" }),
      resumeFrom: { ref: paused.result.checkpointRef, value: { approved: true } },
    });

    // AFTER: exactly one, and the already-completed `plan` was NOT re-entered.
    expect(resumed.handlerLog.calls[HITL_NODES.gateCommit]).toBe(1);
    expect(resumed.handlerLog.calls[HITL_NODES.plan]).toBeUndefined();

    // Totalled across both processes, every node body ran exactly once.
    const total: Record<string, number> = { ...paused.handlerLog.calls };
    for (const [id, count] of Object.entries(resumed.handlerLog.calls)) {
      total[id] = (total[id] ?? 0) + count;
    }
    expect(total[HITL_NODES.plan]).toBe(1);
    expect(total[HITL_NODES.gateCommit]).toBe(1);
    expect(total[HITL_NODES.commit]).toBe(1);
  });
});

// ── Controller primitives ───────────────────────────────────────────

function bareCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  const spec = hitlSpec();
  return {
    formatVersion: CHECKPOINT_FORMAT_VERSION,
    runId: "run-primitives",
    superstep: 4,
    nextSuperstep: 4,
    graphId: spec.graphId,
    graphVersion: spec.graphVersion,
    checksum: spec.checksum,
    createdAt: "2026-08-05T00:00:00.000Z",
    state: initialOverallState({
      runId: "run-primitives",
      projectRoot: "/tmp/p",
      featureRequest: "f",
    }),
    pending: [],
    completedTaskKeys: [],
    interrupt: {
      checkpointId: HITL_CHECKPOINTS.commit,
      nodeId: HITL_NODES.gateCommit,
      branchKeys: [],
      payload: { drafted: true },
      raisedAt: "2026-08-05T00:00:00.000Z",
      superstep: 4,
    },
    decisions: {},
    activeBranches: [],
    joinBuffer: [],
    failures: [],
    deadlocked: false,
    ...overrides,
  };
}

/** The grant key {@link bareCheckpoint}'s pending interrupt is answered under. */
function keyOfPausedGate(overrides: { superstep?: number; payload?: unknown } = {}): string {
  const record = bareCheckpoint().interrupt;
  if (record === null) throw new Error("bareCheckpoint must carry an interrupt");
  return grantKey(grantScope(record.checkpointId, record.nodeId), {
    branchKeys: record.branchKeys,
    superstep: overrides.superstep ?? record.superstep,
    payload: "payload" in overrides ? overrides.payload : record.payload,
  });
}

describe("controller primitives", () => {
  it("raiseSuspend throws GraphInterrupted carrying the record", () => {
    const controller = createInterruptController({ mode: "suspend" });
    const record = bareCheckpoint().interrupt;
    expect(record).not.toBeNull();
    if (record === null) return;
    try {
      controller.raiseSuspend(record);
      expect.unreachable("raiseSuspend must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(GraphInterrupted);
      expect((error as GraphInterrupted).record).toEqual(record);
      expect((error as GraphInterrupted).message).toContain("bober approve");
    }
  });

  it("applyResume clears the interrupt, records the decision and writes it into state", () => {
    const controller = createInterruptController({ mode: "suspend" });
    const applied = controller.applyResume(bareCheckpoint(), { approved: false, feedback: "no" });
    const key = keyOfPausedGate();

    expect(applied.interrupt).toBeNull();
    // Keyed by the PASS that was paused, not by the checkpoint id, so the decision cannot
    // be spent on a later iteration of the same gate.
    expect(applied.decisions[key]).toEqual({ approved: false, feedback: "no" });
    expect(controller.decisions()[key]).toEqual({ approved: false, feedback: "no" });
    expect(Object.keys(applied.decisions)).toEqual([key]);
    expect(applied.state.messages.map((m) => m.id)).toEqual([
      resumeMessageId(HITL_CHECKPOINTS.commit),
    ]);
  });

  it("applyResume REPLACES a previous decision row rather than appending a second", () => {
    const controller = createInterruptController({ mode: "suspend" });
    const once = controller.applyResume(bareCheckpoint(), { approved: true });
    const twice = controller.applyResume(
      { ...once, interrupt: bareCheckpoint().interrupt },
      { approved: false, feedback: "changed my mind" },
    );
    expect(twice.state.messages).toHaveLength(1);
    expect(JSON.parse(twice.state.messages[0].text ?? "null")).toEqual({
      approved: false,
      feedback: "changed my mind",
    });
  });

  it("applyResume refuses a checkpoint that is not paused", () => {
    const controller = createInterruptController({ mode: "suspend" });
    expect(() => controller.applyResume(bareCheckpoint({ interrupt: null }), { approved: true })).toThrow(
      NoPendingInterruptError,
    );
  });

  it("applyResume refuses a resume value that is not a CheckpointOutcome", () => {
    const controller = createInterruptController({ mode: "suspend" });
    expect(() => controller.applyResume(bareCheckpoint(), { yes: "please" })).toThrow();
    expect(() => controller.applyResume(bareCheckpoint(), "approved")).toThrow();
  });

  it("restore re-seeds the decisions a checkpoint carried, so a second pause keeps the first grant", () => {
    const controller = createInterruptController();
    const key = keyOfPausedGate();
    expect(controller.decisions()).toEqual({});
    controller.restore({ [key]: { approved: true } });
    expect(controller.decisions()).toEqual({ [key]: { approved: true } });
  });

  it("restore REPLACES whatever the same gate scope held, so a scope never holds two grants", () => {
    const controller = createInterruptController();
    controller.restore({ [keyOfPausedGate()]: { approved: true } });
    const later = keyOfPausedGate({ superstep: 9 });
    controller.restore({ [later]: { approved: false, feedback: "not this round" } });
    expect(Object.keys(controller.decisions())).toEqual([later]);
  });

  it("returns a recorded decision for the SAME pass without asking the mechanism again", async () => {
    const controller = createInterruptController({
      decisions: { [keyOfPausedGate({ superstep: 0, payload: { drafted: true } })]: { approved: true } },
    });
    const gate = hitlSpec().nodes.find((n) => n.id === HITL_NODES.gateCommit);
    expect(gate).toBeDefined();
    if (gate === undefined) return;

    const outcome = await controller.maybeInterrupt(
      gate,
      { drafted: true },
      { runId: "run-recorded", projectRoot: root, config: hitlConfig(), superstep: 0 },
    );
    expect(outcome).toEqual({ approved: true });

    // Nobody was asked — but the audit still says this gate authorised this pass. A grant
    // that lets something through and writes nothing down is the hole sc-8-7 forbids.
    const audit = await readAudit("run-recorded");
    expect(audit).toHaveLength(1);
    expect(audit[0].checkpointId).toBe(HITL_CHECKPOINTS.commit);
    expect(audit[0].outcome).toBe("approved");
  });

  it("does NOT reuse a decision recorded for a different pass of the same gate", async () => {
    // Same checkpoint id, same gate node, superstep 0 — and then the gate is entered at
    // superstep 6 with new content. Under a checkpointId-keyed cache this returns the old
    // approval silently; here the mechanism is asked again.
    const asked: unknown[] = [];
    registerCheckpointMechanism("disk", {
      request: async (_id, artifact) => {
        asked.push(artifact);
        return { approved: false, feedback: "not this revision" };
      },
    });
    const controller = createInterruptController({
      decisions: { [keyOfPausedGate({ superstep: 0, payload: { drafted: true } })]: { approved: true } },
    });
    const gate = hitlSpec().nodes.find((n) => n.id === HITL_NODES.gateCommit);
    expect(gate).toBeDefined();
    if (gate === undefined) return;

    const outcome = await controller.maybeInterrupt(
      gate,
      { drafted: true, revision: 2 },
      {
        runId: "run-second-pass",
        projectRoot: root,
        config: hitlConfig({ checkpointMechanism: "disk" }),
        superstep: 6,
      },
    );
    expect(asked).toEqual([{ drafted: true, revision: 2 }]);
    expect(outcome).toEqual({ approved: false, feedback: "not this revision" });

    // And the stale grant is GONE, so the git node downstream finds nothing to cite.
    expect(Object.keys(controller.decisions())).toEqual([
      keyOfPausedGate({ superstep: 6, payload: { drafted: true, revision: 2 } }),
    ]);
  });

  it("keys a pass by branch, superstep and payload — and by nothing else", () => {
    const scope = grantScope(HITL_CHECKPOINTS.commit, HITL_NODES.gateCommit);
    const base = { branchKeys: ["b1"], superstep: 3, payload: { plan: "v1" } };
    expect(grantKey(scope, base)).toBe(grantKey(scope, { ...base, branchKeys: ["b1"] }));
    expect(grantKey(scope, base)).not.toBe(grantKey(scope, { ...base, superstep: 4 }));
    expect(grantKey(scope, base)).not.toBe(grantKey(scope, { ...base, payload: { plan: "v2" } }));
    expect(grantKey(scope, base)).not.toBe(grantKey(scope, { ...base, branchKeys: ["b2"] }));
    // Branch order is not identity: the key sorts them.
    expect(grantKey(scope, { ...base, branchKeys: ["a", "b"] })).toBe(
      grantKey(scope, { ...base, branchKeys: ["b", "a"] }),
    );
    // Every key in a scope starts with it, which is how the effect node finds its grant.
    expect(grantKey(scope, base).startsWith(scope)).toBe(true);
    expect(scope).not.toBe(grantScope(HITL_CHECKPOINTS.deploy, HITL_NODES.gateCommit));
    expect(scope).not.toBe(grantScope(HITL_CHECKPOINTS.commit, HITL_NODES.gateDeploy));
  });
});
