import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetCoordinator } from "./coordinator.js";
import { SharedBlackboard } from "./shared-blackboard.js";
import type { Scaffolder, Runner } from "./coordinator.js";
import type { ScaffoldResult } from "./scaffolder.js";
import type { ChildSpawnResult } from "./runner.js";
import type { FleetManifest } from "./manifest.js";

// ── Fake helpers ──────────────────────────────────────────────────────

function makeScaffolder(overrides?: Partial<Scaffolder>): Scaffolder {
  return {
    async scaffold(_root: string, child: { folder: string }): Promise<ScaffoldResult> {
      return {
        folder: child.folder,
        absPath: "/tmp/" + child.folder,
        configWritten: true,
        gitInitialized: true,
      };
    },
    ...overrides,
  };
}

function makeRunner(overrides?: Partial<Runner>): Runner {
  return {
    async run(spec: { cwd: string; task: string; timeoutMs?: number }): Promise<ChildSpawnResult> {
      return { cwd: spec.cwd, exitCode: 0, stdout: "", stderr: "" };
    },
    ...overrides,
  };
}

function makeManifest(
  children: Array<{ folder: string; task: string }>,
  concurrency = 3,
  blackboard?: FleetManifest["blackboard"],
): FleetManifest {
  return { rootDir: ".", concurrency, children, ...(blackboard ? { blackboard } : {}) };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("FleetCoordinator", () => {
  it("execute() returns ChildExecution[] aligned to input order (sc-3-4)", async () => {
    const children = [
      { folder: "a", task: "task-a" },
      { folder: "b", task: "task-b" },
      { folder: "c", task: "task-c" },
    ];
    const coord = new FleetCoordinator({ scaffolder: makeScaffolder(), runner: makeRunner() });
    const results = await coord.execute(makeManifest(children));

    expect(results).toHaveLength(3);
    expect(results.map((r) => r.folder)).toEqual(["a", "b", "c"]);
    expect(results[0].scaffold.folder).toBe("a");
    expect(results[1].scaffold.folder).toBe("b");
    expect(results[2].scaffold.folder).toBe("c");
  });

  it("peak concurrency never exceeds cap and more than cap children ran (sc-3-5)", async () => {
    let live = 0;
    let peak = 0;
    let totalRan = 0;

    const tick = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 5));

    const fakeRunner: Runner = {
      async run(spec: { cwd: string; task: string; timeoutMs?: number }): Promise<ChildSpawnResult> {
        live++;
        peak = Math.max(peak, live);
        totalRan++;
        await tick(); // hold the slot so overlap is observable
        live--;
        return { cwd: spec.cwd, exitCode: 0, stdout: "", stderr: "" };
      },
    };

    const coord = new FleetCoordinator({ scaffolder: makeScaffolder(), runner: fakeRunner });
    const manifest = makeManifest(
      Array.from({ length: 6 }, (_, i) => ({ folder: "c" + String(i), task: "t" })),
      2,
    );

    const results = await coord.execute(manifest);

    expect(results).toHaveLength(6);
    expect(peak).toBeLessThanOrEqual(2);
    expect(totalRan).toBe(6); // all ran
    expect(peak).toBeGreaterThan(1); // proves true overlap, not serialized
  });

  it("one child runner throwing does not abort the batch; every sibling resolves (sc-3-6)", async () => {
    const fakeRunner: Runner = {
      async run(spec: { cwd: string; task: string }): Promise<ChildSpawnResult> {
        if (spec.task === "BOOM") throw new Error("kaboom");
        return { cwd: spec.cwd, exitCode: 0, stdout: "", stderr: "" };
      },
    };

    const coord = new FleetCoordinator({ scaffolder: makeScaffolder(), runner: fakeRunner });
    const manifest = makeManifest([
      { folder: "a", task: "ok" },
      { folder: "b", task: "BOOM" },
      { folder: "c", task: "ok" },
    ]);

    // Must NOT reject:
    const results = await coord.execute(manifest);

    expect(results).toHaveLength(3);
    // index alignment preserved
    expect(results.map((r) => r.folder)).toEqual(["a", "b", "c"]);

    // the throwing child still produced a ChildExecution with an error captured
    const b = results[1];
    expect(b.spawn).toBeUndefined();
    expect(b.scaffold.error).toContain("kaboom");
  });

  it("one child scaffolder throwing does not abort the batch; every sibling resolves (sc-3-6 variant)", async () => {
    const fakeScaffolder: Scaffolder = {
      async scaffold(_root: string, child: { folder: string }): Promise<ScaffoldResult> {
        if (child.folder === "boom") throw new Error("scaffold exploded");
        return {
          folder: child.folder,
          absPath: "/tmp/" + child.folder,
          configWritten: true,
          gitInitialized: true,
        };
      },
    };

    const coord = new FleetCoordinator({ scaffolder: fakeScaffolder, runner: makeRunner() });
    const manifest = makeManifest([
      { folder: "x", task: "ok" },
      { folder: "boom", task: "t" },
      { folder: "y", task: "ok" },
    ]);

    // Must NOT reject:
    const results = await coord.execute(manifest);

    expect(results).toHaveLength(3);
    expect(results.map((r) => r.folder)).toEqual(["x", "boom", "y"]);

    const boom = results[1];
    expect(boom.spawn).toBeUndefined();
    expect(boom.scaffold.error).toContain("scaffold exploded");
  });

  it("scaffold.error causes spawn to be skipped; child is still returned (sc-3-6 scaffold-error path)", async () => {
    const fakeScaffolder: Scaffolder = {
      async scaffold(_root: string, child: { folder: string }): Promise<ScaffoldResult> {
        return {
          folder: child.folder,
          absPath: "/tmp/" + child.folder,
          configWritten: false,
          gitInitialized: false,
          error: "mkdir failed: permission denied",
        };
      },
    };

    let runCalled = false;
    const fakeRunner: Runner = {
      async run(spec: { cwd: string }): Promise<ChildSpawnResult> {
        runCalled = true;
        return { cwd: spec.cwd, exitCode: 0, stdout: "", stderr: "" };
      },
    };

    const coord = new FleetCoordinator({ scaffolder: fakeScaffolder, runner: fakeRunner });
    const results = await coord.execute(makeManifest([{ folder: "err", task: "t" }]));

    expect(results).toHaveLength(1);
    expect(results[0].spawn).toBeUndefined();
    expect(results[0].scaffold.error).toBe("mkdir failed: permission denied");
    expect(runCalled).toBe(false);
  });
});

// ── executeRounds tests ───────────────────────────────────────────────

describe("FleetCoordinator.executeRounds", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-coordinator-rounds-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("sc-3-3: scaffold called once per child; runner called once per round per child (maxRounds=3)", async () => {
    const dbPath = join(tmpDir, "facts-sc-3-3.db");
    const now = new Date().toISOString();
    const bb = await SharedBlackboard.open({ dbPath, namespace: "ns-sc-3-3", maxRounds: 3 });

    const scaffoldCalls: string[] = [];
    const runCalls: string[] = [];
    // Track total runner calls to derive the current round (2 children per round)
    let totalRunCalls = 0;

    const scaffolder: Scaffolder = {
      async scaffold(
        _root: string,
        child: { folder: string },
        _bbArg?: { dbPath: string; namespace: string; maxRounds: number },
      ): Promise<ScaffoldResult> {
        scaffoldCalls.push(child.folder);
        return { folder: child.folder, absPath: "/tmp/" + child.folder, configWritten: true, gitInitialized: true };
      },
    };
    const runner: Runner = {
      async run(spec: { cwd: string; task: string }): Promise<ChildSpawnResult> {
        runCalls.push(spec.cwd);
        totalRunCalls++;
        // Publish a distinct finding on each runner call so count grows every round
        bb.publish(
          { childFolder: spec.task, round: Math.min(totalRunCalls, 3), payload: `finding-${String(totalRunCalls)}` },
          now,
        );
        return { cwd: spec.cwd, exitCode: 0, stdout: "", stderr: "" };
      },
    };

    const coord = new FleetCoordinator({ scaffolder, runner });
    const children = [
      { folder: "a", task: "task-a" },
      { folder: "b", task: "task-b" },
    ];
    const manifest = makeManifest(children, 2, { namespace: "ns-sc-3-3", maxRounds: 3 });

    const { executions: results, roundsRun } = await coord.executeRounds(manifest, bb, { maxRounds: 3, dbPath });
    bb.close();

    // scaffold called ONCE per child (2 children × 1 = 2)
    expect(scaffoldCalls).toHaveLength(2);
    // runner called once per child per round (2 children × 3 rounds = 6)
    expect(runCalls).toHaveLength(6);
    expect(results).toHaveLength(2);
    // full run, no early-stop → roundsRun equals maxRounds
    expect(roundsRun).toBe(3);
  });

  it("sc-3-4: early-stop — round 2 adds zero new findings → loop runs exactly 2 rounds", async () => {
    const scaffoldCalls: string[] = [];
    const runCalls: string[] = [];

    const scaffolder: Scaffolder = {
      async scaffold(
        _root: string,
        child: { folder: string },
        _bb?: { dbPath: string; namespace: string; maxRounds: number },
      ): Promise<ScaffoldResult> {
        scaffoldCalls.push(child.folder);
        return { folder: child.folder, absPath: "/tmp/" + child.folder, configWritten: true, gitInitialized: true };
      },
    };

    const dbPath = join(tmpDir, "early-stop-facts.db");
    const now = new Date().toISOString();
    const bb = await SharedBlackboard.open({ dbPath, namespace: "ns-early-stop", maxRounds: 3 });

    // Track which round we're in by counting runner calls per child
    let runnerCallCount = 0;
    const numChildren = 2;

    const runner: Runner = {
      async run(spec: { cwd: string; task: string }): Promise<ChildSpawnResult> {
        runCalls.push(spec.cwd);
        runnerCallCount++;
        const currentRound = Math.ceil(runnerCallCount / numChildren);
        // Only publish in round 1 (not round 2) so early-stop fires after round 2
        if (currentRound === 1) {
          bb.publish({ childFolder: spec.cwd, round: 1, payload: "finding-round1" }, now);
        }
        return { cwd: spec.cwd, exitCode: 0, stdout: "", stderr: "" };
      },
    };

    const coord = new FleetCoordinator({ scaffolder, runner });
    const children = [
      { folder: "x", task: "task-x" },
      { folder: "y", task: "task-y" },
    ];
    const manifest = makeManifest(children, 2, { namespace: "ns-early-stop", maxRounds: 3 });

    const { roundsRun } = await coord.executeRounds(manifest, bb, { maxRounds: 3, dbPath });
    bb.close();

    // Should have run exactly 2 rounds: round 1 added findings, round 2 added none → early-stop
    // 2 children × 2 rounds = 4 runner calls
    expect(runCalls).toHaveLength(4);
    // scaffold called once per child
    expect(scaffoldCalls).toHaveLength(2);
    // early-stop fires after round 2, so roundsRun === 2 (NOT maxRounds=3)
    expect(roundsRun).toBe(2);
  });

  it("sc-3-5: no-blackboard manifest → execute() runs ONE mapBounded pass, no blackboard opened", async () => {
    const scaffoldCalls: string[] = [];
    const runCalls: string[] = [];

    const scaffolder: Scaffolder = {
      async scaffold(
        _root: string,
        child: { folder: string },
      ): Promise<ScaffoldResult> {
        scaffoldCalls.push(child.folder);
        return { folder: child.folder, absPath: "/tmp/" + child.folder, configWritten: true, gitInitialized: true };
      },
    };
    const runner: Runner = {
      async run(spec: { cwd: string; task: string }): Promise<ChildSpawnResult> {
        runCalls.push(spec.cwd);
        return { cwd: spec.cwd, exitCode: 0, stdout: "", stderr: "" };
      },
    };

    const coord = new FleetCoordinator({ scaffolder, runner });
    // No blackboard field on manifest
    const manifest = makeManifest([
      { folder: "p", task: "task-p" },
      { folder: "q", task: "task-q" },
    ]);

    const results = await coord.execute(manifest);

    // Single pass: each child scaffold and run called exactly once
    expect(scaffoldCalls).toHaveLength(2);
    expect(runCalls).toHaveLength(2);
    expect(results).toHaveLength(2);
  });

  it("sc-3-7: failing child inside executeRounds does not throw; report still built with error as data", async () => {
    const scaffolder: Scaffolder = {
      async scaffold(
        _root: string,
        child: { folder: string },
      ): Promise<ScaffoldResult> {
        return { folder: child.folder, absPath: "/tmp/" + child.folder, configWritten: true, gitInitialized: true };
      },
    };
    const runner: Runner = {
      async run(spec: { cwd: string; task: string }): Promise<ChildSpawnResult> {
        if (spec.task === "BOOM") throw new Error("child exploded");
        return { cwd: spec.cwd, exitCode: 0, stdout: "", stderr: "" };
      },
    };

    const dbPath = join(tmpDir, "failing-child-facts.db");
    const bb = await SharedBlackboard.open({ dbPath, namespace: "ns-fail", maxRounds: 3 });

    const coord = new FleetCoordinator({ scaffolder, runner });
    const manifest = makeManifest(
      [
        { folder: "ok", task: "task-ok" },
        { folder: "fail", task: "BOOM" },
      ],
      2,
      { namespace: "ns-fail", maxRounds: 1 },
    );

    // Must NOT reject
    const { executions: results, roundsRun } = await coord.executeRounds(manifest, bb, { maxRounds: 1, dbPath });
    bb.close();

    expect(results).toHaveLength(2);
    expect(roundsRun).toBe(1);
    // The failing child carries error as data, not a throw
    const failResult = results.find((r) => r.folder === "fail");
    expect(failResult?.spawn).toBeUndefined();
    expect(failResult?.scaffold.error).toContain("child exploded");
    // The good child still completed
    const okResult = results.find((r) => r.folder === "ok");
    expect(okResult?.spawn).toBeDefined();
  });
});
