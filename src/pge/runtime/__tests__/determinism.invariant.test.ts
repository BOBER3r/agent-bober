import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readArtifactTree } from "../__fixtures__/artifact-tree.js";
import { goldenContracts } from "../__fixtures__/golden-graph.js";
import { runGolden } from "../__fixtures__/run-harness.js";
import type { GoldenRun } from "../__fixtures__/run-harness.js";
import type { OverallState } from "../../state/overall.js";
import type { Span } from "../trace.js";

/**
 * BLOCKING INVARIANT SUITE 1 of 3 — DETERMINISM.
 *
 * ADR-1 accepts a hand-owned Pregel loop on one condition: that a bespoke barrier, commit
 * and admission implementation "carries silent state-corruption bugs ... with no upstream
 * maintainer", and that the only defence is a set of blocking invariant suites — "if they
 * are treated as optional, this decision becomes indefensible". This is one of them.
 *
 * The claim under test: the same golden topology and the same inputs, run at concurrency 1
 * and at concurrency 8, produce byte-identical `.bober/` artifacts.
 *
 * ── What is compared, and what is not ──
 *
 * BYTES, of every file the commit boundary owns — specs, contracts, history, the
 * completion marker — read off disk after two REAL runs into two REAL temp directories.
 * Not parsed objects: a comparison of parsed objects would forgive key reordering, number
 * formatting and whitespace, which is exactly the class of difference a hand-written
 * serializer introduces. The only substitutions are wall-clock values and the temp root
 * (see `__fixtures__/artifact-tree.ts`, which justifies each one).
 *
 * `.bober/traces/` is excluded from the byte comparison and checked separately as a
 * multiset. A trace is one line per execution carrying the superstep that admitted it, and
 * raising the cap is precisely a change of schedule — demanding identical trace bytes
 * would be demanding the two runs have the same schedule, which is the opposite of the
 * claim. What must not differ is WHICH executions happened, and that is asserted below.
 *
 * ── Mutation-proven ──
 *
 * This suite was run against three deliberate breakages and failed on each:
 *  - `CommitBoundary.commit` folding the batch pairwise instead of invoking the reducer
 *    once with the whole batch;
 *  - `FrontierPlanner.plan` admitting in arrival order instead of the sorted total order;
 *  - the interpreter flushing the join buffer as soon as ANY branch left the fan-out
 *    region rather than when the last one did.
 */

const RUN_ID = "run-determinism";

let rootSequential = "";
let rootConcurrent = "";

beforeEach(async () => {
  rootSequential = await mkdtemp(join(tmpdir(), "bober-pge-det-c1-"));
  rootConcurrent = await mkdtemp(join(tmpdir(), "bober-pge-det-c8-"));
});

afterEach(async () => {
  await rm(rootSequential, { recursive: true, force: true });
  await rm(rootConcurrent, { recursive: true, force: true });
});

/**
 * The committed state, with the one field that is a fact about `mkdtemp` rather than about
 * the runtime replaced. Everything else is compared literally.
 */
function comparableState(state: OverallState): string {
  return JSON.stringify({ ...state, projectRoot: "<ROOT>" });
}

/** The identity of one execution, with its schedule position deliberately excluded. */
function spanIdentity(span: Span): string {
  return [
    span.nodeId,
    span.branchKey ?? "-",
    span.kind,
    span.phase,
    span.status,
    span.route?.goto.kind ?? "-",
    span.route?.label ?? "-",
    (span.route?.goto.sends ?? []).map((s) => s.branchKey).join("+"),
    (span.privKeys ?? []).join("+"),
  ].join("|");
}

async function runAt(projectRoot: string, concurrency: number): Promise<GoldenRun> {
  return runGolden({
    projectRoot,
    runId: RUN_ID,
    concurrency,
    finalize: true,
    behaviour: {
      contracts: goldenContracts(5),
      reworkBranches: ["sprint-golden-2", "sprint-golden-4"],
      // Branches complete in a scrambled order at cap 8 and in index order at cap 1.
      // If anything downstream depended on completion order, these two runs would diverge.
      stagger: (key) => (key.charCodeAt(key.length - 1) * 7) % 5,
    },
  });
}

describe("DETERMINISM: concurrency 1 and concurrency 8 commit the same bytes (sc-7-8)", () => {
  it("produces byte-identical .bober/ artifact trees", async () => {
    const sequential = await runAt(rootSequential, 1);
    const concurrent = await runAt(rootConcurrent, 8);

    expect(sequential.result.status).toBe("completed");
    expect(concurrent.result.status).toBe("completed");

    const a = await readArtifactTree(rootSequential);
    const b = await readArtifactTree(rootConcurrent);

    // The trees are non-trivial: a vacuous pass on two empty directories is not a pass.
    expect(a.size).toBeGreaterThanOrEqual(7);
    expect([...a.keys()]).toEqual([...b.keys()]);
    expect([...a.keys()]).toContain(".bober/specs/spec-golden-1.json");
    expect([...a.keys()]).toContain(".bober/contracts/sprint-golden-1.json");
    expect([...a.keys()]).toContain(".bober/history.jsonl");
    expect([...a.keys()]).toContain(`.bober/runs/${RUN_ID}.completed.json`);

    // File by file, so a failure names the artifact rather than the tree.
    for (const [path, bytes] of a) {
      expect(b.get(path), `artifact ${path} differs between concurrency 1 and 8`).toBe(bytes);
    }
  });

  it("commits the same final state, key for key", async () => {
    const sequential = await runAt(rootSequential, 1);
    const concurrent = await runAt(rootConcurrent, 8);
    expect(comparableState(concurrent.finalState)).toBe(comparableState(sequential.finalState));
  });

  it("executes the same multiset of node executions, however they interleaved", async () => {
    const sequential = await runAt(rootSequential, 1);
    const concurrent = await runAt(rootConcurrent, 8);

    const a = sequential.spans.map(spanIdentity).sort();
    const b = concurrent.spans.map(spanIdentity).sort();
    expect(b).toEqual(a);
    expect(a.length).toBeGreaterThan(25);
  });

  it("does differ in SCHEDULE, which is what makes the byte equality meaningful", async () => {
    const sequential = await runAt(rootSequential, 1);
    const concurrent = await runAt(rootConcurrent, 8);

    // Concurrency 1 needs strictly more supersteps for the same work. If these were equal
    // the byte comparison above would be comparing two identical schedules and proving
    // nothing about the barrier or the reducers.
    expect(sequential.result.supersteps).toBeGreaterThan(concurrent.result.supersteps);
    const widest = Math.max(
      ...concurrent.result.commits.map((c) => Math.max(0, ...Object.values(c.batchSizePerChannel))),
    );
    expect(widest).toBeGreaterThan(1);
    const widestSequential = Math.max(
      ...sequential.result.commits.map((c) => Math.max(0, ...Object.values(c.batchSizePerChannel))),
    );
    expect(widestSequential).toBe(1);
  });

  it("repeats identically when the same concurrency is run twice", async () => {
    const first = await runAt(rootSequential, 8);
    const second = await runAt(rootConcurrent, 8);
    const a = await readArtifactTree(rootSequential);
    const b = await readArtifactTree(rootConcurrent);
    for (const [path, bytes] of a) expect(b.get(path)).toBe(bytes);
    expect(comparableState(second.finalState)).toBe(comparableState(first.finalState));
  });
});
