import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { runFleetExpandDeep, registerFleetCommand } from "./index.js";
import { FleetManifestSchema } from "./manifest.js";
import type { FleetManifest } from "./manifest.js";
import type { LLMClient } from "../providers/types.js";
import type { decomposeGoalDeep } from "./decomposer-deep.js";
import type { runFleet } from "./index.js";
import type { createClient } from "../providers/factory.js";

// ── Type aliases ──────────────────────────────────────────────────────

type DecomposeDeepFn = typeof decomposeGoalDeep;
type RunFleetFn = typeof runFleet;
type CreateClientFn = typeof createClient;

// ── Fake helpers ──────────────────────────────────────────────────────

/** A minimal children-only manifest returned by the fake decomposer */
const FAKE_CHILDREN: FleetManifest["children"] = [
  { folder: "api-server", task: "Build a REST API server with Express" },
  { folder: "web-frontend", task: "Build a React frontend application" },
];

/** Fake decomposeGoalDeep that returns a known FleetManifest without any LLM call */
function makeFakeDecomposeDeep(
  children: FleetManifest["children"] = FAKE_CHILDREN,
): DecomposeDeepFn {
  return async (_input) => ({
    rootDir: ".",
    concurrency: 3,
    children,
  });
}

/** Fake LLMClient that never makes real network calls */
const fakeLLMClient: LLMClient = {
  async chat(_params) {
    return {
      text: '{"children":[{"folder":"a","task":"t"}]}',
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  },
};

/** Fake createClient that returns the fakeLLMClient without hitting any API */
function makeFakeClientBuilder(): CreateClientFn {
  return (_provider, _endpoint, _providerConfig, _model, _role) => fakeLLMClient;
}

/** Fake createClient that throws a credential error (simulates missing key) */
function makeFakeClientBuilderThrowing(): CreateClientFn {
  return (_provider, _endpoint, _providerConfig, _model, _role) => {
    throw new Error(
      "FleetDecomposer is configured to use DeepSeek but DEEPSEEK_API_KEY is not set.",
    );
  };
}

// ── Tests: write-and-stop (sc-2-4) ───────────────────────────────────

describe("runFleetExpandDeep write-and-stop (sc-2-4)", () => {
  let tmpDir: string;
  let savedKey: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-expand-deep-"));
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

  it("writes a FleetManifestSchema-valid manifest to outPath and does not call runFleet (default no --yes)", async () => {
    const outPath = join(tmpDir, "fleet-expand.json");
    const runFleetSpy = vi.fn();

    await runFleetExpandDeep(
      "Build a full-stack e-commerce platform",
      { out: outPath, root: tmpDir },
      {
        decomposeDeep: makeFakeDecomposeDeep(),
        runFleet: runFleetSpy as unknown as RunFleetFn,
        createClient: makeFakeClientBuilder(),
      },
    );

    // File must exist and be a valid FleetManifest
    const raw = await readFile(outPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    expect(FleetManifestSchema.safeParse(parsed).success).toBe(true);

    // Must have the expected shape
    expect(parsed).toMatchObject({
      rootDir: tmpDir,
      concurrency: 3,
      children: expect.arrayContaining([
        expect.objectContaining({ folder: "api-server" }),
        expect.objectContaining({ folder: "web-frontend" }),
      ]),
    });

    // runFleet must NOT be called without --yes
    expect(runFleetSpy).not.toHaveBeenCalled();
  });

  it("uses default outPath <root>/.bober/fleet-expand.json when --out is not set", async () => {
    const runFleetSpy = vi.fn();

    await runFleetExpandDeep(
      "Build something",
      { root: tmpDir },
      {
        decomposeDeep: makeFakeDecomposeDeep(),
        runFleet: runFleetSpy as unknown as RunFleetFn,
        createClient: makeFakeClientBuilder(),
      },
    );

    const expectedPath = join(tmpDir, ".bober", "fleet-expand.json");
    const raw = await readFile(expectedPath, "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(runFleetSpy).not.toHaveBeenCalled();
  });

  it("applies --concurrency option to the written manifest", async () => {
    const outPath = join(tmpDir, "fleet-expand.json");

    await runFleetExpandDeep(
      "Build something",
      { out: outPath, root: tmpDir, concurrency: "5" },
      {
        decomposeDeep: makeFakeDecomposeDeep(),
        runFleet: vi.fn() as unknown as RunFleetFn,
        createClient: makeFakeClientBuilder(),
      },
    );

    const raw = await readFile(outPath, "utf-8");
    const parsed = JSON.parse(raw) as { concurrency: number };
    expect(parsed.concurrency).toBe(5);
  });
});

// ── Tests: --yes gate (sc-2-5) ────────────────────────────────────────

describe("runFleetExpandDeep --yes gate (sc-2-5)", () => {
  let tmpDir: string;
  let savedKey: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-expand-deep-yes-"));
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

  it("calls runFleet exactly once with outPath when --yes is set", async () => {
    const outPath = join(tmpDir, "fleet-expand.json");
    const fakeReport = { total: 2, completed: 2, failed: 0, other: 0 };
    const runFleetSpy = vi.fn().mockResolvedValue(fakeReport);

    await runFleetExpandDeep(
      "Build a platform",
      { out: outPath, root: tmpDir, yes: true },
      {
        decomposeDeep: makeFakeDecomposeDeep(),
        runFleet: runFleetSpy as unknown as RunFleetFn,
        createClient: makeFakeClientBuilder(),
      },
    );

    // runFleet must be called exactly once
    expect(runFleetSpy).toHaveBeenCalledTimes(1);
    // It must be called with outPath (the written manifest path)
    expect(runFleetSpy).toHaveBeenCalledWith(outPath);

    // The file must be written BEFORE runFleet was called — verify it exists
    const raw = await readFile(outPath, "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("does not call runFleet without --yes", async () => {
    const outPath = join(tmpDir, "fleet-expand.json");
    const runFleetSpy = vi.fn();

    await runFleetExpandDeep(
      "Build a platform",
      { out: outPath, root: tmpDir },
      {
        decomposeDeep: makeFakeDecomposeDeep(),
        runFleet: runFleetSpy as unknown as RunFleetFn,
        createClient: makeFakeClientBuilder(),
      },
    );

    expect(runFleetSpy).not.toHaveBeenCalled();
  });

  it("calls runFleet AFTER the file is written (file must exist before runFleet executes)", async () => {
    const outPath = join(tmpDir, "fleet-expand.json");
    let fileExistedWhenRunFleetCalled = false;

    const runFleetSpy = vi.fn().mockImplementation(async (_path: string) => {
      // At this point the file should already exist
      try {
        await access(outPath);
        fileExistedWhenRunFleetCalled = true;
      } catch {
        fileExistedWhenRunFleetCalled = false;
      }
      return { total: 1, completed: 1, failed: 0, other: 0 };
    });

    await runFleetExpandDeep(
      "Build something",
      { out: outPath, root: tmpDir, yes: true },
      {
        decomposeDeep: makeFakeDecomposeDeep(),
        runFleet: runFleetSpy as unknown as RunFleetFn,
        createClient: makeFakeClientBuilder(),
      },
    );

    expect(fileExistedWhenRunFleetCalled).toBe(true);
  });
});

// ── Tests: credential fail-fast (sc-2-6) ─────────────────────────────

describe("runFleetExpandDeep credential fail-fast (sc-2-6)", () => {
  let tmpDir: string;
  let savedKey: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-expand-deep-cred-"));
    savedKey = process.env["DEEPSEEK_API_KEY"];
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    if (savedKey !== undefined) {
      process.env["DEEPSEEK_API_KEY"] = savedKey;
    } else {
      delete process.env["DEEPSEEK_API_KEY"];
    }
  });

  it("rejects with a credential error and does NOT write any manifest file", async () => {
    delete process.env["DEEPSEEK_API_KEY"];
    const outPath = join(tmpDir, "fleet-expand.json");
    const runFleetSpy = vi.fn();

    await expect(
      runFleetExpandDeep(
        "Build something",
        { out: outPath, root: tmpDir },
        {
          decomposeDeep: makeFakeDecomposeDeep(),
          runFleet: runFleetSpy as unknown as RunFleetFn,
          createClient: makeFakeClientBuilderThrowing(),
        },
      ),
    ).rejects.toThrow(/DEEPSEEK_API_KEY/);

    // The file must NOT have been written
    await expect(access(outPath)).rejects.toThrow();

    // runFleet must NOT have been called
    expect(runFleetSpy).not.toHaveBeenCalled();
  });

  it("the error comes from the client build (before decomposeGoalDeep and before any write)", async () => {
    delete process.env["DEEPSEEK_API_KEY"];
    const outPath = join(tmpDir, "fleet-expand.json");
    let decomposeCalled = false;

    const trackingDecompose: DecomposeDeepFn = async (...args) => {
      decomposeCalled = true;
      return makeFakeDecomposeDeep()(...args);
    };

    await expect(
      runFleetExpandDeep(
        "Build something",
        { out: outPath },
        {
          decomposeDeep: trackingDecompose,
          runFleet: vi.fn() as unknown as RunFleetFn,
          createClient: makeFakeClientBuilderThrowing(),
        },
      ),
    ).rejects.toThrow();

    // decomposeGoalDeep must NOT have been called (error happened in createClient first)
    expect(decomposeCalled).toBe(false);
  });
});

// ── Tests: decompose failure (sc-2-7) ─────────────────────────────────

describe("runFleetExpandDeep decompose failure (sc-2-7)", () => {
  let tmpDir: string;
  let savedKey: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-expand-deep-decomp-"));
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

  it("propagates decomposeDeep error, writes NO file, and never calls runFleet", async () => {
    const outPath = join(tmpDir, "fleet-expand.json");
    const throwingDecompose: DecomposeDeepFn = async () => {
      throw new Error("deep expand failed after 2 attempts");
    };
    const runFleetSpy = vi.fn();

    await expect(
      runFleetExpandDeep(
        "Build something",
        { out: outPath, root: tmpDir },
        {
          decomposeDeep: throwingDecompose,
          runFleet: runFleetSpy as unknown as RunFleetFn,
          createClient: makeFakeClientBuilder(),
        },
      ),
    ).rejects.toThrow(/deep expand failed/);

    // No file written
    await expect(access(outPath)).rejects.toThrow();
    // runFleet never called
    expect(runFleetSpy).not.toHaveBeenCalled();
  });
});

// ── Tests: overwrite notice and --out redirect (sc-2-8) ───────────────

describe("runFleetExpandDeep overwrite notice and --out redirect (sc-2-8)", () => {
  let tmpDir: string;
  let savedKey: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-expand-deep-overwrite-"));
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
    vi.restoreAllMocks();
  });

  it("overwrites a pre-existing manifest atomically and logs an overwrite notice", async () => {
    const outPath = join(tmpDir, "fleet-expand.json");

    // First write — creates the file
    await runFleetExpandDeep(
      "First goal",
      { out: outPath, root: tmpDir },
      {
        decomposeDeep: makeFakeDecomposeDeep([{ folder: "first", task: "first task" }]),
        runFleet: vi.fn() as unknown as RunFleetFn,
        createClient: makeFakeClientBuilder(),
      },
    );

    const consoleSpy = vi.spyOn(console, "log");

    // Second write — should overwrite and print a notice
    await runFleetExpandDeep(
      "Second goal",
      { out: outPath, root: tmpDir },
      {
        decomposeDeep: makeFakeDecomposeDeep([{ folder: "second", task: "second task" }]),
        runFleet: vi.fn() as unknown as RunFleetFn,
        createClient: makeFakeClientBuilder(),
      },
    );

    // The file should now contain the second manifest
    const raw = await readFile(outPath, "utf-8");
    const parsed = JSON.parse(raw) as FleetManifest;
    expect(parsed.children[0]?.folder).toBe("second");

    // An overwrite notice must have been printed naming the path
    const logCalls = consoleSpy.mock.calls.flat().join("\n");
    expect(logCalls).toContain(outPath);
    expect(logCalls.toLowerCase()).toMatch(/overwrite|overwritten/);
  });

  it("--out redirects the write away from the default path", async () => {
    const customOut = join(tmpDir, "custom-manifest.json");
    const defaultPath = join(tmpDir, ".bober", "fleet-expand.json");

    await runFleetExpandDeep(
      "Build something",
      { out: customOut, root: tmpDir },
      {
        decomposeDeep: makeFakeDecomposeDeep(),
        runFleet: vi.fn() as unknown as RunFleetFn,
        createClient: makeFakeClientBuilder(),
      },
    );

    // Custom path must exist
    const raw = await readFile(customOut, "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();

    // Default path must NOT exist
    await expect(access(defaultPath)).rejects.toThrow();
  });
});

// ── Tests: Commander registration (sc-2-8) ────────────────────────────

describe("registerFleetCommand — expand-deep subcommand registration and byte-lock (sc-2-8)", () => {
  it("registers 'expand-deep' as a child subcommand of 'fleet'", () => {
    const program = new Command();
    registerFleetCommand(program);

    const fleet = program.commands.find((c) => c.name() === "fleet");
    expect(fleet).toBeDefined();

    const subNames = fleet!.commands.map((c) => c.name());
    expect(subNames).toContain("expand-deep");
  });

  it("byte-lock: 'expand' child is still present after adding expand-deep", () => {
    const program = new Command();
    registerFleetCommand(program);

    const fleet = program.commands.find((c) => c.name() === "fleet");
    expect(fleet).toBeDefined();

    const subNames = fleet!.commands.map((c) => c.name());
    expect(subNames).toContain("expand");
  });

  it("byte-lock: fleet <manifest> positional is still intact", () => {
    const program = new Command();
    registerFleetCommand(program);

    const fleet = program.commands.find((c) => c.name() === "fleet");
    expect(fleet).toBeDefined();
    expect(fleet!.usage()).toContain("manifest");
  });

  it("byte-lock: fleet command still has --concurrency and --root options", () => {
    const program = new Command();
    registerFleetCommand(program);

    const fleet = program.commands.find((c) => c.name() === "fleet");
    expect(fleet).toBeDefined();

    const fleetOpts = fleet!.options.map((o) => o.long);
    expect(fleetOpts).toContain("--concurrency");
    expect(fleetOpts).toContain("--root");
  });

  it("expand-deep has the same option set as expand (all 7 options)", () => {
    const program = new Command();
    registerFleetCommand(program);

    const fleet = program.commands.find((c) => c.name() === "fleet");
    expect(fleet).toBeDefined();

    const deep = fleet!.commands.find((c) => c.name() === "expand-deep");
    expect(deep).toBeDefined();

    const deepOpts = deep!.options.map((o) => o.long);
    for (const o of [
      "--count",
      "--provider",
      "--model",
      "--root",
      "--concurrency",
      "--out",
      "--yes",
    ]) {
      expect(deepOpts).toContain(o);
    }
  });

  it("expand subcommand still has all its options after expand-deep is added", () => {
    const program = new Command();
    registerFleetCommand(program);

    const fleet = program.commands.find((c) => c.name() === "fleet");
    const expand = fleet!.commands.find((c) => c.name() === "expand");
    expect(expand).toBeDefined();

    const optNames = expand!.options.map((o) => o.long);
    expect(optNames).toContain("--count");
    expect(optNames).toContain("--provider");
    expect(optNames).toContain("--model");
    expect(optNames).toContain("--root");
    expect(optNames).toContain("--concurrency");
    expect(optNames).toContain("--out");
    expect(optNames).toContain("--yes");
  });
});
