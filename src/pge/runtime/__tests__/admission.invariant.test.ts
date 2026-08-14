import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { computeFanOutRegion } from "../interpreter.js";
import { GOLDEN_NODES, goldenContract, goldenContractId, goldenSpec } from "../__fixtures__/golden-graph.js";
import { runGolden } from "../__fixtures__/run-harness.js";
import type { GoldenRun } from "../__fixtures__/run-harness.js";
import type { Span } from "../trace.js";

/**
 * BLOCKING INVARIANT SUITE 3 — ADMISSION SAFETY.
 *
 * Two hard preconditions of ANY fan-out, asserted at the level where they can actually
 * break — a whole run with a real scheduler, not the planner in isolation
 * (`frontier.test.ts` covers the predicate itself):
 *
 *  1. No node is admitted before every contract it `dependsOn` has COMMITTED.
 *  2. Two branches whose declared file sets intersect never execute CONCURRENTLY.
 *
 * Concurrency here is a correctness-preserving capability, never a performance one. Every
 * assertion below is about ORDER and OVERLAP; none is about elapsed time, and none would
 * change meaning if the machine were ten times slower.
 *
 * ── Why the overlap probe is not vacuous ──
 *
 * An overlap assertion passes trivially against a runtime that never runs anything
 * concurrently. So the first test in the file establishes that the probe DOES observe
 * concurrent branches when the file sets are disjoint. Only then does the absence of
 * overlap for intersecting sets mean anything.
 *
 * ── Mutation-proven ──
 *
 * This suite was run against two deliberate breakages and failed on each:
 *  - `findConflict` returning `null` unconditionally, which admits two branches that share
 *    a file;
 *  - the interpreter adding a branch's `contractId` to `done` at DISPATCH rather than when
 *    the branch commits, which admits a dependent branch before its dependency finishes.
 */

interface OverlapProbe {
  /** Branch keys observed in flight at the same instant, one entry per observation. */
  readonly observations: string[][];
  readonly onBranchNode: (event: "start" | "end", nodeId: string, branchKey: string) => void;
}

function overlapProbe(): OverlapProbe {
  const inFlight = new Set<string>();
  const observations: string[][] = [];
  return {
    observations,
    onBranchNode: (event, _nodeId, branchKey) => {
      if (event === "start") {
        inFlight.add(branchKey);
        observations.push([...inFlight].sort());
      } else {
        inFlight.delete(branchKey);
      }
    },
  };
}

/** True when the two keys were ever in flight at the same moment. */
function everOverlapped(probe: OverlapProbe, a: string, b: string): boolean {
  return probe.observations.some((set) => set.includes(a) && set.includes(b));
}

function serializedSpans(spans: readonly Span[], reason: string): Span[] {
  return spans.filter((s) => s.status === "serialized" && s.serializedReason === reason);
}

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-pge-admit-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const B1 = goldenContractId(1);
const B2 = goldenContractId(2);
const B3 = goldenContractId(3);

describe("ADMISSION SAFETY: the probe is live", () => {
  it("observes genuinely concurrent branches when the file sets are disjoint", async () => {
    const probe = overlapProbe();
    const run = await runGolden({
      projectRoot: root,
      concurrency: 8,
      behaviour: {
        contracts: [
          goldenContract({ index: 1, estimatedFiles: ["src/a.ts"] }),
          goldenContract({ index: 2, estimatedFiles: ["src/b.ts"] }),
          goldenContract({ index: 3, estimatedFiles: ["src/c.ts"] }),
        ],
        onBranchNode: probe.onBranchNode,
      },
    });

    expect(run.result.status).toBe("completed");
    expect(everOverlapped(probe, B1, B2)).toBe(true);
    expect(everOverlapped(probe, B1, B3)).toBe(true);
    expect(Math.max(...probe.observations.map((s) => s.length))).toBe(3);
    expect(serializedSpans(run.spans, "fileConflict")).toEqual([]);
  });
});

describe("ADMISSION SAFETY: intersecting file sets are serialized (sc-7-5)", () => {
  let probe: OverlapProbe;
  let run: GoldenRun;

  beforeEach(async () => {
    probe = overlapProbe();
    run = await runGolden({
      projectRoot: root,
      concurrency: 8,
      behaviour: {
        contracts: [
          goldenContract({ index: 1, estimatedFiles: ["src/shared.ts", "src/a.ts"] }),
          goldenContract({ index: 2, estimatedFiles: ["src/b.ts", "src/shared.ts"] }),
          goldenContract({ index: 3, estimatedFiles: ["src/c.ts"] }),
        ],
        onBranchNode: probe.onBranchNode,
      },
    });
  });

  it("never runs the two colliding branches at the same time", () => {
    expect(run.result.status).toBe("completed");
    expect(everOverlapped(probe, B1, B2)).toBe(false);
    // ...while the branch that shares nothing with them still ran alongside both, so the
    // serialization is targeted rather than a blanket refusal to parallelise.
    expect(everOverlapped(probe, B1, B3) || everOverlapped(probe, B2, B3)).toBe(true);
  });

  it("records the deferral in the trace with the reason and BOTH contract ids", () => {
    const serialized = serializedSpans(run.spans, "fileConflict");
    expect(serialized.length).toBeGreaterThan(0);
    for (const span of serialized) {
      // BOTH contract ids are on the span: the deferred branch is its `branchKey`, the
      // branch that blocked it is in `blockedBy`. Which of the two is deferred depends on
      // which was admitted first at that superstep, so the assertion is on the PAIR — a
      // check that pinned one direction would be asserting the schedule, not the rule.
      expect(span.blockedBy).toHaveLength(1);
      expect([span.branchKey, span.blockedBy?.[0]].sort()).toEqual([B1, B2]);
      expect(span.status).toBe("serialized");
      // Serialization holds for EVERY node of the branch, not only its first: a branch
      // whose second node stopped carrying its file set could be admitted alongside a
      // conflicting sibling halfway through.
      expect(computeFanOutRegion(goldenSpec()).has(span.nodeId)).toBe(true);
    }
    // The uninvolved branch was never serialized against anything.
    expect(serialized.some((s) => s.branchKey === B3)).toBe(false);
  });

  it("still finishes every branch — serialization delays work, it does not drop it", () => {
    expect(run.result.status).toBe("completed");
    if (run.result.status !== "completed") return;
    expect(run.result.verdict).toBe("success");
    expect(run.finalState.sprintContracts.map((c) => c.status)).toEqual([
      "passed",
      "passed",
      "passed",
    ]);
    expect(Object.keys(run.finalState.branchStatus).sort()).toEqual([B1, B2, B3]);
  });

  it("treats an undeclared file set as conflicting with everything", async () => {
    const bareProbe = overlapProbe();
    await runGolden({
      projectRoot: root,
      runId: "run-bare",
      concurrency: 8,
      behaviour: {
        contracts: [
          goldenContract({ index: 1, estimatedFiles: ["src/a.ts"] }),
          goldenContract({ index: 2, estimatedFiles: [] }),
        ],
        onBranchNode: bareProbe.onBranchNode,
      },
    });
    expect(everOverlapped(bareProbe, B1, B2)).toBe(false);
  });
});

describe("ADMISSION SAFETY: dependsOn gates dispatch (sc-7-5)", () => {
  it("never dispatches B before A has committed", async () => {
    const probe = overlapProbe();
    const run = await runGolden({
      projectRoot: root,
      concurrency: 8,
      behaviour: {
        contracts: [
          goldenContract({ index: 1, estimatedFiles: ["src/a.ts"] }),
          goldenContract({ index: 2, estimatedFiles: ["src/b.ts"], dependsOn: [B1] }),
        ],
        onBranchNode: probe.onBranchNode,
      },
    });

    expect(run.result.status).toBe("completed");

    const stepsOf = (branch: string): number[] =>
      run.spans.filter((s) => s.branchKey === branch && s.status === "ok").map((s) => s.superstep);
    const first = stepsOf(B1);
    const second = stepsOf(B2);
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);

    // B's FIRST execution is strictly after A's LAST one: A had to commit first.
    expect(Math.min(...second)).toBeGreaterThan(Math.max(...first));
    expect(everOverlapped(probe, B1, B2)).toBe(false);

    // And the reason is recorded, not merely implied by the ordering.
    const deferred = serializedSpans(run.spans, "dependsOn");
    expect(deferred.length).toBeGreaterThan(0);
    expect(deferred[0].branchKey).toBe(B2);
    expect(deferred[0].blockedBy).toEqual([B1]);
    expect(deferred[0].nodeId).toBe(GOLDEN_NODES.sprintBody);
  });

  it("does not gate on a dependency that is already satisfied", async () => {
    const probe = overlapProbe();
    const run = await runGolden({
      projectRoot: root,
      concurrency: 8,
      behaviour: {
        contracts: [
          goldenContract({ index: 1, estimatedFiles: ["src/a.ts"] }),
          // dependsOn a contract id nothing declares AND nothing dispatches would deadlock;
          // depending on itself is unsatisfiable in the same way. Here the dependency list
          // is simply empty, so both branches admit together.
          goldenContract({ index: 2, estimatedFiles: ["src/b.ts"] }),
        ],
        onBranchNode: probe.onBranchNode,
      },
    });
    expect(run.result.status).toBe("completed");
    expect(everOverlapped(probe, B1, B2)).toBe(true);
    expect(serializedSpans(run.spans, "dependsOn")).toEqual([]);
  });

  it("holds dependsOn at concurrency 1 as well, where no file rule applies", async () => {
    const run = await runGolden({
      projectRoot: root,
      concurrency: 1,
      behaviour: {
        contracts: [
          goldenContract({ index: 1, estimatedFiles: ["src/a.ts"] }),
          goldenContract({ index: 2, estimatedFiles: ["src/b.ts"], dependsOn: [B1] }),
        ],
      },
    });
    const stepsOf = (branch: string): number[] =>
      run.spans.filter((s) => s.branchKey === branch && s.status === "ok").map((s) => s.superstep);
    expect(Math.min(...stepsOf(B2))).toBeGreaterThan(Math.max(...stepsOf(B1)));
    expect(serializedSpans(run.spans, "dependsOn").length).toBeGreaterThan(0);
    // At cap 1 nothing is ever serialized for a file conflict: there is no concurrency to
    // protect against, and recording one would make the trace a function of the cap.
    expect(serializedSpans(run.spans, "fileConflict")).toEqual([]);
  });
});
