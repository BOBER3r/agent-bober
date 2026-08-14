import { describe, expect, it } from "vitest";

import {
  ADMISSION_REASONS,
  computeTaskKey,
  createFrontierPlanner,
  createPendingTask,
  hashInput,
} from "./frontier.js";
import type { PendingTask } from "./frontier.js";

/**
 * The admission predicate, tested at the SCHEDULER level.
 *
 * Every case below would pass trivially against a planner that admitted the whole frontier
 * unconditionally, EXCEPT the ones that assert a deferral — those are the tests that fail
 * the moment the predicate is relaxed, which is the only kind worth having here. Nothing
 * in this file asserts elapsed time; the planner has no notion of duration.
 */

function task(overrides: Partial<PendingTask> & { nodeId: string }): PendingTask {
  return createPendingTask({
    nodeId: overrides.nodeId,
    branchKey: overrides.branchKey ?? null,
    input: overrides.input ?? { seed: overrides.nodeId },
    contractId: overrides.contractId,
    dependsOn: overrides.dependsOn ?? [],
    files: overrides.files ?? [],
  });
}

function branch(id: string, files: string[], dependsOn: string[] = []): PendingTask {
  return createPendingTask({
    nodeId: "sprint_body",
    branchKey: id,
    input: { contractId: id },
    contractId: id,
    dependsOn,
    files,
  });
}

describe("task identity", () => {
  it("derives taskKey from nodeId, branchKey and the input hash", () => {
    const a = createPendingTask({ nodeId: "n", branchKey: "b", input: { x: 1 } });
    expect(a.taskKey).toBe(computeTaskKey("n", "b", { x: 1 }));
    expect(a.taskKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable under key reordering and distinct across every component", () => {
    expect(hashInput({ a: 1, b: 2 })).toBe(hashInput({ b: 2, a: 1 }));
    expect(computeTaskKey("n", "b", { x: 1 })).not.toBe(computeTaskKey("m", "b", { x: 1 }));
    expect(computeTaskKey("n", "b", { x: 1 })).not.toBe(computeTaskKey("n", "c", { x: 1 }));
    expect(computeTaskKey("n", "b", { x: 1 })).not.toBe(computeTaskKey("n", "b", { x: 2 }));
    expect(computeTaskKey("n", null, { x: 1 })).not.toBe(computeTaskKey("n", "", { x: 1 }) + "x");
  });
});

describe("dependsOn gates admission (sc-7-5)", () => {
  it("defers a task whose dependency has not committed, naming the unmet ids", () => {
    const planner = createFrontierPlanner();
    const b = branch("c-2", ["src/b.ts"], ["c-1"]);
    const decision = planner.plan([b], new Set(), 8);

    expect(decision.admit).toEqual([]);
    expect(decision.defer).toHaveLength(1);
    expect(decision.defer[0].reason).toBe("dependsOn");
    expect(decision.defer[0].blockedBy).toEqual(["c-1"]);
  });

  it("admits the same task once the dependency is in the committed set", () => {
    const planner = createFrontierPlanner();
    const b = branch("c-2", ["src/b.ts"], ["c-1"]);
    const decision = planner.plan([b], new Set(["c-1"]), 8);

    expect(decision.admit.map((t) => t.contractId)).toEqual(["c-2"]);
    expect(decision.defer).toEqual([]);
  });

  it("reports EVERY unmet dependency, sorted, not just the first", () => {
    const planner = createFrontierPlanner();
    const b = branch("c-9", [], ["c-3", "c-1", "c-2"]);
    const decision = planner.plan([b], new Set(["c-2"]), 8);
    expect(decision.defer[0].blockedBy).toEqual(["c-1", "c-3"]);
  });

  it("gates on dependsOn even at cap 1, where no conflict rule applies", () => {
    const planner = createFrontierPlanner();
    const decision = planner.plan([branch("c-2", ["src/b.ts"], ["c-1"])], new Set(), 1);
    expect(decision.admit).toEqual([]);
    expect(decision.defer[0].reason).toBe("dependsOn");
  });

  it("checks dependsOn BEFORE the cap, so a blocked task is not mislabelled backpressure", () => {
    const planner = createFrontierPlanner();
    // `a` sorts first and fills the cap; `b` would be capped, but it is also blocked.
    const decision = planner.plan(
      [branch("c-1", ["src/a.ts"]), branch("c-2", ["src/b.ts"], ["never-committed"])],
      new Set(),
      1,
    );
    expect(decision.admit.map((t) => t.contractId)).toEqual(["c-1"]);
    expect(decision.defer.map((d) => d.reason)).toEqual(["dependsOn"]);
  });
});

describe("file-set intersection serializes branches (sc-7-5)", () => {
  it("defers the second of two branches that share a declared file", () => {
    const planner = createFrontierPlanner();
    const decision = planner.plan(
      [branch("c-1", ["src/shared.ts", "src/a.ts"]), branch("c-2", ["src/b.ts", "src/shared.ts"])],
      new Set(),
      8,
    );

    expect(decision.admit.map((t) => t.contractId)).toEqual(["c-1"]);
    expect(decision.defer).toHaveLength(1);
    expect(decision.defer[0].reason).toBe("fileConflict");
    // BOTH contract ids: the deferred branch is the task, the blocker is named.
    expect(decision.defer[0].task.contractId).toBe("c-2");
    expect(decision.defer[0].blockedBy).toEqual(["c-1"]);
    expect(decision.defer[0].files).toEqual(["src/shared.ts"]);
  });

  it("admits both when the file sets are genuinely disjoint", () => {
    const planner = createFrontierPlanner();
    const decision = planner.plan(
      [branch("c-1", ["src/a.ts"]), branch("c-2", ["src/b.ts"])],
      new Set(),
      8,
    );
    expect(decision.admit.map((t) => t.contractId)).toEqual(["c-1", "c-2"]);
    expect(decision.defer).toEqual([]);
  });

  it("treats an undeclared file set as conflicting with everything", () => {
    const planner = createFrontierPlanner();
    const decision = planner.plan([branch("c-1", ["src/a.ts"]), branch("c-2", [])], new Set(), 8);

    expect(decision.admit.map((t) => t.contractId)).toEqual(["c-1"]);
    expect(decision.defer[0].reason).toBe("fileConflict");
    expect(decision.defer[0].files).toEqual([]);
  });

  it("conflicts symmetrically: an undeclared set already admitted blocks a declared one", () => {
    const planner = createFrontierPlanner();
    // "c-0" sorts first and declares nothing, so it claims everything.
    const decision = planner.plan([branch("c-0", []), branch("c-1", ["src/a.ts"])], new Set(), 8);
    expect(decision.admit.map((t) => t.contractId)).toEqual(["c-0"]);
    expect(decision.defer[0].reason).toBe("fileConflict");
  });

  it("does not serialize on files at cap 1, because nothing runs concurrently there", () => {
    const planner = createFrontierPlanner();
    const decision = planner.plan(
      [branch("c-1", ["src/shared.ts"]), branch("c-2", ["src/shared.ts"])],
      new Set(),
      1,
    );
    expect(decision.admit.map((t) => t.contractId)).toEqual(["c-1"]);
    expect(decision.defer.map((d) => d.reason)).toEqual(["concurrencyCap"]);
  });

  it("keeps admitting past a conflicting branch when a later one is disjoint", () => {
    const planner = createFrontierPlanner();
    const decision = planner.plan(
      [
        branch("c-1", ["src/shared.ts"]),
        branch("c-2", ["src/shared.ts"]),
        branch("c-3", ["src/other.ts"]),
      ],
      new Set(),
      8,
    );
    expect(decision.admit.map((t) => t.contractId)).toEqual(["c-1", "c-3"]);
    expect(decision.defer.map((d) => d.task.contractId)).toEqual(["c-2"]);
  });
});

describe("concurrency cap", () => {
  it("admits exactly `cap` tasks and defers the rest as backpressure", () => {
    const planner = createFrontierPlanner();
    const tasks = ["c-1", "c-2", "c-3", "c-4"].map((id, i) => branch(id, [`src/${String(i)}.ts`]));
    const decision = planner.plan(tasks, new Set(), 2);

    expect(decision.admit).toHaveLength(2);
    expect(decision.defer.map((d) => d.reason)).toEqual(["concurrencyCap", "concurrencyCap"]);
    expect(decision.defer[0].blockedBy).toEqual(["c-1", "c-2"]);
  });

  it("reads a cap below 1 as 1 rather than admitting nothing and deadlocking", () => {
    const planner = createFrontierPlanner();
    expect(planner.plan([task({ nodeId: "n" })], new Set(), 0).admit).toHaveLength(1);
    expect(planner.plan([task({ nodeId: "n" })], new Set(), -4).admit).toHaveLength(1);
  });
});

describe("determinism of admission", () => {
  it("admits the same tasks in the same order however the frontier arrived", () => {
    const planner = createFrontierPlanner();
    const frontier = [
      branch("c-3", ["src/c.ts"]),
      branch("c-1", ["src/a.ts"]),
      branch("c-2", ["src/b.ts"]),
    ];
    const forwards = planner.plan(frontier, new Set(), 8);
    const backwards = planner.plan([...frontier].reverse(), new Set(), 8);
    expect(backwards.admit.map((t) => t.taskKey)).toEqual(forwards.admit.map((t) => t.taskKey));
    expect(forwards.admit.map((t) => t.contractId)).toEqual(["c-1", "c-2", "c-3"]);
  });

  it("orders by nodeId, then branchKey, then taskKey", () => {
    const planner = createFrontierPlanner();
    const decision = planner.plan(
      [
        task({ nodeId: "zeta", branchKey: "a", files: ["src/z.ts"] }),
        task({ nodeId: "alpha", branchKey: "b", files: ["src/b.ts"] }),
        task({ nodeId: "alpha", branchKey: "a", files: ["src/a.ts"] }),
      ],
      new Set(),
      8,
    );
    expect(decision.admit.map((t) => `${t.nodeId}/${t.branchKey ?? "-"}`)).toEqual([
      "alpha/a",
      "alpha/b",
      "zeta/a",
    ]);
  });

  it("never throws on a fully blocked frontier — it returns an empty admit list", () => {
    const planner = createFrontierPlanner();
    const decision = planner.plan([branch("c-1", [], ["missing"])], new Set(), 8);
    expect(decision.admit).toEqual([]);
    expect(decision.defer).toHaveLength(1);
  });
});

describe("the reason set is closed", () => {
  it("names exactly the three admission reasons the trace can record", () => {
    expect([...ADMISSION_REASONS]).toEqual(["dependsOn", "fileConflict", "concurrencyCap"]);
  });
});
