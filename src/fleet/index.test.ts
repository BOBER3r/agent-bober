import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { runFleet, registerFleetCommand } from "./index.js";
import type { FleetCoordinator } from "./coordinator.js";
import type { OutcomeAggregator } from "./aggregator.js";
import type { ChildExecution, ChildOutcome } from "./types.js";
import type { FleetManifest } from "./manifest.js";

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
