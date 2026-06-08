import { describe, it, expect } from "vitest";
import { FleetCoordinator } from "./coordinator.js";
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

function makeManifest(children: Array<{ folder: string; task: string }>, concurrency = 3): FleetManifest {
  return { rootDir: ".", concurrency, children };
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
