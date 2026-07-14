import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { Command } from "commander";
import { runFleet, registerFleetCommand } from "./index.js";
import { FleetCoordinator } from "./coordinator.js";
import type { OutcomeAggregator } from "./aggregator.js";
import type { ChildExecution, ChildOutcome } from "./types.js";
import type { FleetManifest } from "./manifest.js";
import type { Scaffolder, Runner } from "./coordinator.js";
import type { ScaffoldResult } from "./scaffolder.js";
import type { ChildSpawnResult } from "./runner.js";

// ── Fake helpers ──────────────────────────────────────────────────────

/** Builds a canned ChildExecution (no real spawn) */
function fakeExecution(folder: string): ChildExecution {
  return {
    folder,
    scaffold: { folder, absPath: "/tmp/" + folder, configWritten: true, gitInitialized: true },
    spawn: { cwd: "/tmp/" + folder, exitCode: 0, stdout: "", stderr: "" },
  };
}

/** Builds a canned ChildOutcome */
function fakeOutcome(folder: string, status: ChildOutcome["status"]): ChildOutcome {
  return { folder, status, source: "exit-code" };
}

/** Creates a fake coordinator that returns canned executions and records calls */
function makeFakeCoordinator(executions: ChildExecution[]): {
  coord: FleetCoordinator;
  calls: FleetManifest[];
} {
  const calls: FleetManifest[] = [];
  const coord = {
    async execute(manifest: FleetManifest): Promise<ChildExecution[]> {
      calls.push(manifest);
      return executions;
    },
  } as unknown as FleetCoordinator;
  return { coord, calls };
}

/** Creates a fake aggregator returning a fixed outcome list */
function makeFakeAggregator(outcomes: ChildOutcome[]): OutcomeAggregator {
  let idx = 0;
  return {
    async aggregate(_exec: ChildExecution): Promise<ChildOutcome> {
      return outcomes[idx++] ?? { folder: "unknown", status: "other", source: "exit-code" };
    },
  } as unknown as OutcomeAggregator;
}

// ── Fixture manifest writer ───────────────────────────────────────────

async function writeManifest(dir: string, manifest: unknown): Promise<string> {
  const p = join(dir, "fleet.json");
  await writeFile(p, JSON.stringify(manifest), "utf-8");
  return p;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("runFleet end-to-end with injected fakes (sc-4-6)", () => {
  let tmpDir: string;
  let savedKey: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-fleet-"));
    // Provide a key so credential check passes
    savedKey = process.env["DEEPSEEK_API_KEY"];
    process.env["DEEPSEEK_API_KEY"] = "fake-key-for-test";
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    if (savedKey !== undefined) {
      process.env["DEEPSEEK_API_KEY"] = savedKey;
    } else {
      delete process.env["DEEPSEEK_API_KEY"];
    }
  });

  it("returns a PortfolioReport with correct counts", async () => {
    const manifestPath = await writeManifest(tmpDir, {
      rootDir: tmpDir,
      concurrency: 2,
      children: [
        { folder: "a", task: "task-a" },
        { folder: "b", task: "task-b" },
        { folder: "c", task: "task-c" },
      ],
    });

    const executions = [
      fakeExecution("a"),
      fakeExecution("b"),
      fakeExecution("c"),
    ];
    const outcomes = [
      fakeOutcome("a", "completed"),
      fakeOutcome("b", "failed"),
      fakeOutcome("c", "completed"),
    ];

    const { coord, calls } = makeFakeCoordinator(executions);
    const aggr = makeFakeAggregator(outcomes);

    const report = await runFleet(manifestPath, {}, { coordinator: coord, aggregator: aggr });

    expect(report.total).toBe(3);
    expect(report.completed).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.other).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("writes fleet-report.json to <rootDir>/.bober", async () => {
    const manifestPath = await writeManifest(tmpDir, {
      rootDir: tmpDir,
      concurrency: 1,
      children: [{ folder: "x", task: "t" }],
    });

    const { coord } = makeFakeCoordinator([fakeExecution("x")]);
    const aggr = makeFakeAggregator([fakeOutcome("x", "completed")]);

    await runFleet(manifestPath, {}, { coordinator: coord, aggregator: aggr });

    const raw = await readFile(join(tmpDir, ".bober", "fleet-report.json"), "utf-8");
    const parsed = JSON.parse(raw) as { total: number; completed: number };
    expect(parsed.total).toBe(1);
    expect(parsed.completed).toBe(1);
  });

  it("--concurrency override takes effect on the manifest passed to coordinator", async () => {
    const manifestPath = await writeManifest(tmpDir, {
      rootDir: tmpDir,
      concurrency: 1,
      children: [{ folder: "p", task: "t" }],
    });

    const { coord, calls } = makeFakeCoordinator([fakeExecution("p")]);
    const aggr = makeFakeAggregator([fakeOutcome("p", "completed")]);

    await runFleet(manifestPath, { concurrency: 5 }, { coordinator: coord, aggregator: aggr });

    expect(calls[0]?.concurrency).toBe(5);
  });

  it("--rootDir override takes effect on the manifest passed to coordinator and write", async () => {
    const altDir = await mkdtemp(join(tmpdir(), "bober-fleet-alt-"));
    try {
      const manifestPath = await writeManifest(tmpDir, {
        rootDir: tmpDir,
        concurrency: 1,
        children: [{ folder: "q", task: "t" }],
      });

      const { coord, calls } = makeFakeCoordinator([fakeExecution("q")]);
      const aggr = makeFakeAggregator([fakeOutcome("q", "completed")]);

      await runFleet(manifestPath, { rootDir: altDir }, { coordinator: coord, aggregator: aggr });

      // The coordinator received the overridden rootDir
      expect(calls[0]?.rootDir).toBe(altDir);
      // The report was written to the altDir
      const raw = await readFile(join(altDir, ".bober", "fleet-report.json"), "utf-8");
      expect(() => JSON.parse(raw)).not.toThrow();
    } finally {
      await rm(altDir, { recursive: true, force: true });
    }
  });
});

describe("runFleet credential fail-fast (sc-4-7)", () => {
  let tmpDir: string;
  let savedKey: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-fleet-cred-"));
    savedKey = process.env["DEEPSEEK_API_KEY"];
    delete process.env["DEEPSEEK_API_KEY"];
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    if (savedKey !== undefined) {
      process.env["DEEPSEEK_API_KEY"] = savedKey;
    } else {
      delete process.env["DEEPSEEK_API_KEY"];
    }
  });

  it("throws before any spawn when DeepSeek key is missing", async () => {
    const manifestPath = await writeManifest(tmpDir, {
      rootDir: tmpDir,
      concurrency: 1,
      // children use default buildChildConfig → DeepSeek provider
      children: [{ folder: "child-a", task: "build something" }],
    });

    let executeCalled = false;
    const fakeCoord = {
      async execute(_m: FleetManifest): Promise<ChildExecution[]> {
        executeCalled = true;
        return [];
      },
    } as unknown as FleetCoordinator;

    await expect(runFleet(manifestPath, {}, { coordinator: fakeCoord })).rejects.toThrow(
      /DEEPSEEK_API_KEY/,
    );

    expect(executeCalled).toBe(false);
  });

  it("proceeds when DEEPSEEK_API_KEY is set in env", async () => {
    process.env["DEEPSEEK_API_KEY"] = "test-key-123";

    const manifestPath = await writeManifest(tmpDir, {
      rootDir: tmpDir,
      concurrency: 1,
      children: [{ folder: "child-b", task: "build something" }],
    });

    let executeCalled = false;
    const fakeCoord = {
      async execute(_m: FleetManifest): Promise<ChildExecution[]> {
        executeCalled = true;
        return [fakeExecution("child-b")];
      },
    } as unknown as FleetCoordinator;

    const aggr = makeFakeAggregator([fakeOutcome("child-b", "completed")]);

    const report = await runFleet(manifestPath, {}, { coordinator: fakeCoord, aggregator: aggr });

    expect(executeCalled).toBe(true);
    expect(report.total).toBe(1);
  });
});

describe("runFleet ToolRoleGuard fail-fast (sc-3-6)", () => {
  let tmpDir: string;
  let savedKey: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-fleet-guard-"));
    // Set DEEPSEEK_API_KEY so credential check does NOT throw first —
    // assertManifest runs BEFORE validateManifestCredentials, but set it for
    // completeness and to keep test isolation clean.
    savedKey = process.env["DEEPSEEK_API_KEY"];
    process.env["DEEPSEEK_API_KEY"] = "fake-key-for-guard-test";
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    if (savedKey !== undefined) {
      process.env["DEEPSEEK_API_KEY"] = savedKey;
    } else {
      delete process.env["DEEPSEEK_API_KEY"];
    }
  });

  it("throws before any spawn when a child sets claude-code on the generator tool role", async () => {
    const manifestPath = await writeManifest(tmpDir, {
      rootDir: tmpDir,
      concurrency: 1,
      children: [
        {
          folder: "bad-tool-role-child",
          task: "build something",
          config: { generator: { model: "sonnet", provider: "claude-code" } },
        },
      ],
    });

    const { coord, calls } = makeFakeCoordinator([]);

    await expect(runFleet(manifestPath, {}, { coordinator: coord })).rejects.toThrow(/generator/);
    // coordinator.execute must NOT have been called — guard fires pre-spawn
    expect(calls).toHaveLength(0);
  });

  it("does not throw for a clean manifest (byte-identical no-flag path)", async () => {
    const manifestPath = await writeManifest(tmpDir, {
      rootDir: tmpDir,
      concurrency: 1,
      children: [{ folder: "clean-child", task: "clean task" }],
    });

    const { coord } = makeFakeCoordinator([fakeExecution("clean-child")]);
    const aggr = makeFakeAggregator([fakeOutcome("clean-child", "completed")]);

    await expect(
      runFleet(manifestPath, {}, { coordinator: coord, aggregator: aggr }),
    ).resolves.toBeDefined();
  });
});

describe("registerFleetCommand (sc-4-8)", () => {
  it("registers a 'fleet' command with --concurrency and --root options", () => {
    const program = new Command();
    registerFleetCommand(program);

    const fleet = program.commands.find((c) => c.name() === "fleet");
    expect(fleet).toBeDefined();

    const optNames = fleet!.options.map((o) => o.long);
    expect(optNames).toContain("--concurrency");
    expect(optNames).toContain("--root");
  });

  it("fleet command accepts a positional manifest argument", () => {
    const program = new Command();
    registerFleetCommand(program);

    const fleet = program.commands.find((c) => c.name() === "fleet");
    expect(fleet).toBeDefined();
    // Commander registers positional args via usage string
    expect(fleet!.usage()).toContain("manifest");
  });
});

// ── sc-3-5: no-blackboard → single execute, no SharedBlackboard opened ──

describe("runFleet no-blackboard single-pass (sc-3-5)", () => {
  let tmpDir: string;
  let savedKey: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-fleet-nobb-"));
    savedKey = process.env["DEEPSEEK_API_KEY"];
    process.env["DEEPSEEK_API_KEY"] = "fake-key-for-test";
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    if (savedKey !== undefined) {
      process.env["DEEPSEEK_API_KEY"] = savedKey;
    } else {
      delete process.env["DEEPSEEK_API_KEY"];
    }
  });

  it("no-blackboard manifest → execute() called once, executeRounds NOT called, no facts.db created", async () => {
    const manifestPath = join(tmpDir, "fleet.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        rootDir: tmpDir,
        concurrency: 1,
        children: [{ folder: "nobb-child", task: "test-task" }],
        // No blackboard field
      }),
      "utf-8",
    );

    let executeCalled = 0;
    let executeRoundsCalled = 0;

    const fakeCoord = {
      async execute(_manifest: FleetManifest): Promise<ChildExecution[]> {
        executeCalled++;
        return [
          {
            folder: "nobb-child",
            scaffold: {
              folder: "nobb-child",
              absPath: join(tmpDir, "nobb-child"),
              configWritten: true,
              gitInitialized: true,
            },
            spawn: { cwd: join(tmpDir, "nobb-child"), exitCode: 0, stdout: "", stderr: "" },
          },
        ];
      },
      async executeRounds(_manifest: FleetManifest): Promise<{ executions: ChildExecution[]; roundsRun: number }> {
        executeRoundsCalled++;
        return { executions: [], roundsRun: 0 };
      },
    } as unknown as FleetCoordinator;

    const aggr = {
      async aggregate(exec: ChildExecution): Promise<ChildOutcome> {
        return { folder: exec.folder, status: "completed", source: "exit-code" };
      },
    } as unknown as OutcomeAggregator;

    await runFleet(manifestPath, {}, { coordinator: fakeCoord, aggregator: aggr });

    // Single execute pass, no executeRounds
    expect(executeCalled).toBe(1);
    expect(executeRoundsCalled).toBe(0);

    // No facts.db should have been created
    const expectedDbPath = join(tmpDir, ".bober", "memory");
    let dbDirExists = false;
    try {
      await access(expectedDbPath);
      dbDirExists = true;
    } catch {
      // directory does not exist — expected
    }
    expect(dbDirExists).toBe(false);
  });
});

// ── sc-3-6: blackboard manifest → path injected, db dir created, rounds run ──

describe("runFleet blackboard path (sc-3-6)", () => {
  let tmpDir: string;
  let savedKey: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-fleet-bb-"));
    savedKey = process.env["DEEPSEEK_API_KEY"];
    process.env["DEEPSEEK_API_KEY"] = "fake-key-for-test";
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    if (savedKey !== undefined) {
      process.env["DEEPSEEK_API_KEY"] = savedKey;
    } else {
      delete process.env["DEEPSEEK_API_KEY"];
    }
  });

  it("blackboard manifest → resolveBlackboardPath computed, db dir created, child config carries fleet section", async () => {
    const namespace = "test-ns";
    const manifestPath = join(tmpDir, "fleet.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        rootDir: tmpDir,
        concurrency: 1,
        children: [{ folder: "bb-child", task: "test-task" }],
        blackboard: { namespace, maxRounds: 2 },
      }),
      "utf-8",
    );

    // Capture the 3rd scaffold arg to verify dbPath injection
    const scaffoldArgs: Array<{ dbPath: string; namespace: string; maxRounds: number } | undefined> = [];

    const scaffolder: Scaffolder = {
      async scaffold(
        _root: string,
        child: { folder: string },
        bbArg?: { dbPath: string; namespace: string; maxRounds: number },
      ): Promise<ScaffoldResult> {
        scaffoldArgs.push(bbArg);
        return {
          folder: child.folder,
          absPath: join(tmpDir, child.folder),
          configWritten: true,
          gitInitialized: true,
        };
      },
    };

    const runner: Runner = {
      async run(spec: { cwd: string; task: string }): Promise<ChildSpawnResult> {
        return { cwd: spec.cwd, exitCode: 0, stdout: "", stderr: "" };
      },
    };

    const coord = new FleetCoordinator({ scaffolder, runner });

    const aggr = {
      async aggregate(exec: ChildExecution): Promise<ChildOutcome> {
        return { folder: exec.folder, status: "completed", source: "exit-code" };
      },
    } as unknown as OutcomeAggregator;

    await runFleet(manifestPath, {}, { coordinator: coord, aggregator: aggr });

    // Verify the expected dbPath matches resolveBlackboardPath
    const expectedDbPath = join(resolve(tmpDir), ".bober", "memory", namespace, "facts.db");

    // db dir must have been created
    const dbDir = dirname(expectedDbPath);
    let dbDirExists = false;
    try {
      await access(dbDir);
      dbDirExists = true;
    } catch {
      // directory not found — will fail the assertion below
    }
    expect(dbDirExists).toBe(true);

    // scaffold received the blackboard arg with the correct absolute dbPath
    expect(scaffoldArgs).toHaveLength(1);
    expect(scaffoldArgs[0]).toBeDefined();
    expect(scaffoldArgs[0]?.dbPath).toBe(expectedDbPath);
    expect(scaffoldArgs[0]?.namespace).toBe(namespace);
    expect(scaffoldArgs[0]?.maxRounds).toBe(2);
  });
});

// ── sc-4-4: blackboard run → fleet-synthesis.json written + fleet-report.json unchanged ──

describe("runFleet synthesis file written on blackboard run (sc-4-4)", () => {
  let tmpDir: string;
  let savedKey: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-fleet-syn-"));
    savedKey = process.env["DEEPSEEK_API_KEY"];
    process.env["DEEPSEEK_API_KEY"] = "fake-key-for-test";
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    if (savedKey !== undefined) {
      process.env["DEEPSEEK_API_KEY"] = savedKey;
    } else {
      delete process.env["DEEPSEEK_API_KEY"];
    }
  });

  it("blackboard run writes fleet-synthesis.json with rounds+childResults+findings AND fleet-report.json unchanged", async () => {
    const namespace = "syn-ns";
    const manifestPath = join(tmpDir, "fleet.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        rootDir: tmpDir,
        concurrency: 1,
        children: [{ folder: "syn-child", task: "syn-task" }],
        blackboard: { namespace, maxRounds: 2 },
      }),
      "utf-8",
    );

    const scaffolder: Scaffolder = {
      async scaffold(
        _root: string,
        child: { folder: string },
        _bbArg?: { dbPath: string; namespace: string; maxRounds: number },
      ): Promise<ScaffoldResult> {
        return {
          folder: child.folder,
          absPath: join(tmpDir, child.folder),
          configWritten: true,
          gitInitialized: true,
        };
      },
    };

    const runner: Runner = {
      async run(spec: { cwd: string; task: string }): Promise<ChildSpawnResult> {
        return { cwd: spec.cwd, exitCode: 0, stdout: "", stderr: "" };
      },
    };

    const coord = new FleetCoordinator({ scaffolder, runner });

    const aggr = {
      async aggregate(exec: ChildExecution): Promise<ChildOutcome> {
        return { folder: exec.folder, status: "completed", source: "exit-code" };
      },
    } as unknown as OutcomeAggregator;

    await runFleet(manifestPath, {}, { coordinator: coord, aggregator: aggr });

    // fleet-synthesis.json must exist and have the expected shape
    const synRaw = await readFile(join(tmpDir, ".bober", "fleet-synthesis.json"), "utf-8");
    const syn = JSON.parse(synRaw) as { rounds: unknown; childResults: unknown; findings: unknown };
    expect(syn).toHaveProperty("rounds");
    expect(syn).toHaveProperty("childResults");
    expect(Array.isArray(syn.findings)).toBe(true);
    expect(typeof syn.rounds).toBe("number");

    // fleet-report.json must still be written and shape unchanged
    const repRaw = await readFile(join(tmpDir, ".bober", "fleet-report.json"), "utf-8");
    const rep = JSON.parse(repRaw) as { total: number; completed: number };
    expect(rep).toMatchObject({ total: 1, completed: 1 });
  });
});

// ── sc-1-4/sc-1-5: blackboard early-stop run → synthesis.rounds and report.rounds are real count ──

describe("runFleet blackboard early-stop → synthesis.rounds and report.rounds === executed count", () => {
  let tmpDir: string;
  let savedKey: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-fleet-earlycount-"));
    savedKey = process.env["DEEPSEEK_API_KEY"];
    process.env["DEEPSEEK_API_KEY"] = "fake-key-for-test";
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    if (savedKey !== undefined) {
      process.env["DEEPSEEK_API_KEY"] = savedKey;
    } else {
      delete process.env["DEEPSEEK_API_KEY"];
    }
  });

  it("early-stop at round 2 of maxRounds=3 → synthesis.rounds===2 AND report.rounds===2", async () => {
    // A runner that never publishes findings causes the blackboard count to stay at 0.
    // Early-stop condition: r > 1 && count === prevCount. prevCount starts at 0 (empty bb).
    // Round 1 runs → count=0, prevCount set to 0.
    // Round 2 runs → count=0 === prevCount=0 → break. roundsRun === 2 (NOT maxRounds=3).
    const namespace = "earlycount-ns";
    const manifestPath = join(tmpDir, "fleet.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        rootDir: tmpDir,
        concurrency: 1,
        children: [{ folder: "ec-child", task: "ec-task" }],
        blackboard: { namespace, maxRounds: 3 },
      }),
      "utf-8",
    );

    const scaffolder: Scaffolder = {
      async scaffold(
        _root: string,
        child: { folder: string },
        _bbArg?: { dbPath: string; namespace: string; maxRounds: number },
      ): Promise<ScaffoldResult> {
        return {
          folder: child.folder,
          absPath: join(tmpDir, child.folder),
          configWritten: true,
          gitInitialized: true,
        };
      },
    };

    // Runner never publishes to the blackboard → early-stop fires after round 2
    const runner: Runner = {
      async run(spec: { cwd: string; task: string; timeoutMs?: number }): Promise<ChildSpawnResult> {
        return { cwd: spec.cwd, exitCode: 0, stdout: "", stderr: "" };
      },
    };

    const coord = new FleetCoordinator({ scaffolder, runner });
    const aggr = {
      async aggregate(exec: ChildExecution): Promise<ChildOutcome> {
        return { folder: exec.folder, status: "completed", source: "exit-code" };
      },
    } as unknown as OutcomeAggregator;

    await runFleet(manifestPath, {}, { coordinator: coord, aggregator: aggr });

    // fleet-synthesis.json.rounds must equal the REAL early-stop round (2, not maxRounds=3)
    const synRaw = await readFile(join(tmpDir, ".bober", "fleet-synthesis.json"), "utf-8");
    const syn = JSON.parse(synRaw) as { rounds: number; childResults: unknown; findings: unknown };
    expect(syn.rounds).toBe(2);

    // fleet-report.json.rounds must also equal 2
    const repRaw = await readFile(join(tmpDir, ".bober", "fleet-report.json"), "utf-8");
    const rep = JSON.parse(repRaw) as { total: number; rounds: number };
    expect(rep.rounds).toBe(2);
  });
});

// ── sc-4-6: no-blackboard run → fleet-synthesis.json ABSENT (byte-identical) ──

describe("runFleet synthesis file absent on no-blackboard run (sc-4-6 byte-identical)", () => {
  let tmpDir: string;
  let savedKey: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-fleet-nobb-syn-"));
    savedKey = process.env["DEEPSEEK_API_KEY"];
    process.env["DEEPSEEK_API_KEY"] = "fake-key-for-test";
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    if (savedKey !== undefined) {
      process.env["DEEPSEEK_API_KEY"] = savedKey;
    } else {
      delete process.env["DEEPSEEK_API_KEY"];
    }
  });

  it("no-blackboard run → fleet-synthesis.json NOT created; fleet-report.json IS written", async () => {
    const manifestPath = join(tmpDir, "fleet.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        rootDir: tmpDir,
        concurrency: 1,
        children: [{ folder: "nobb-syn-child", task: "test-task" }],
        // No blackboard field
      }),
      "utf-8",
    );

    const { coord } = makeFakeCoordinator([fakeExecution("nobb-syn-child")]);
    const aggr = makeFakeAggregator([fakeOutcome("nobb-syn-child", "completed")]);

    await runFleet(manifestPath, {}, { coordinator: coord, aggregator: aggr });

    // fleet-synthesis.json must NOT exist
    let synthExists = false;
    try {
      await access(join(tmpDir, ".bober", "fleet-synthesis.json"));
      synthExists = true;
    } catch {
      // does not exist — expected
    }
    expect(synthExists).toBe(false);

    // fleet-report.json IS written (unchanged behavior)
    const repRaw = await readFile(join(tmpDir, ".bober", "fleet-report.json"), "utf-8");
    const rep = JSON.parse(repRaw) as Record<string, unknown>;
    expect(rep["total"]).toBe(1);
    // byte-identical: no-blackboard report must NOT have a rounds key
    expect("rounds" in rep).toBe(false);
  });
});
