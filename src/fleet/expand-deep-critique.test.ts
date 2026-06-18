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

// ── Tests: --critique write-and-stop (sc-2-4) ─────────────────────────

describe("runFleetExpandDeep --critique write-and-stop (sc-2-4)", () => {
  let tmpDir: string;
  let savedKey: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-expand-deep-crit-"));
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

  it("with critique:true writes a FleetManifestSchema-valid manifest and does NOT call runFleet", async () => {
    const outPath = join(tmpDir, "fleet-expand-crit.json");
    const runFleetSpy = vi.fn();

    await runFleetExpandDeep(
      "Build a full-stack e-commerce platform",
      { out: outPath, root: tmpDir, critique: true },
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

    // Must NOT call runFleet without --yes
    expect(runFleetSpy).not.toHaveBeenCalled();
  });
});

// ── Tests: guarded-spread byte-identity threading (sc-2-5) ───────────

describe("runFleetExpandDeep guarded-spread byte-identity (sc-2-5)", () => {
  let tmpDir: string;
  let savedKey: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-expand-deep-bytelock-"));
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

  it("WITHOUT --critique the decompose arg has NO critique key; WITH --critique it receives critique:true", async () => {
    const argsSeen: Array<Record<string, unknown>> = [];
    const recordingDecompose: DecomposeDeepFn = async (input) => {
      argsSeen.push(input as unknown as Record<string, unknown>);
      return { rootDir: ".", concurrency: 3, children: FAKE_CHILDREN };
    };

    // no-flag path
    await runFleetExpandDeep(
      "g",
      { out: join(tmpDir, "a.json"), root: tmpDir },
      {
        decomposeDeep: recordingDecompose,
        runFleet: vi.fn() as unknown as RunFleetFn,
        createClient: makeFakeClientBuilder(),
      },
    );
    // byte-identity: key must be ABSENT (not just undefined)
    expect("critique" in argsSeen[0]!).toBe(false);

    // --critique path
    await runFleetExpandDeep(
      "g",
      { out: join(tmpDir, "b.json"), root: tmpDir, critique: true },
      {
        decomposeDeep: recordingDecompose,
        runFleet: vi.fn() as unknown as RunFleetFn,
        createClient: makeFakeClientBuilder(),
      },
    );
    // flag threaded as critique:true
    expect(argsSeen[1]!["critique"]).toBe(true);
  });

  it("WITHOUT --critique the recordingDecompose is called exactly once with no critique key", async () => {
    const argsSeen: Array<Record<string, unknown>> = [];
    const recordingDecompose: DecomposeDeepFn = async (input) => {
      argsSeen.push(input as unknown as Record<string, unknown>);
      return { rootDir: ".", concurrency: 3, children: FAKE_CHILDREN };
    };

    await runFleetExpandDeep(
      "goal",
      { out: join(tmpDir, "c.json"), root: tmpDir },
      {
        decomposeDeep: recordingDecompose,
        runFleet: vi.fn() as unknown as RunFleetFn,
        createClient: makeFakeClientBuilder(),
      },
    );

    expect(argsSeen).toHaveLength(1);
    expect("critique" in argsSeen[0]!).toBe(false);
  });
});

// ── Tests: command-tree + byte-lock (sc-2-6) ──────────────────────────

describe("registerFleetCommand — --critique flag and byte-lock (sc-2-6)", () => {
  it("expand-deep now exposes --critique alongside the existing 7 options", () => {
    const program = new Command();
    registerFleetCommand(program);
    const fleet = program.commands.find((c) => c.name() === "fleet")!;
    const deep = fleet.commands.find((c) => c.name() === "expand-deep")!;
    const deepOpts = deep.options.map((o) => o.long);
    expect(deepOpts).toContain("--critique");
    for (const o of ["--count", "--provider", "--model", "--root", "--concurrency", "--out", "--yes"]) {
      expect(deepOpts).toContain(o);
    }
  });

  it("byte-lock: fleet <manifest> positional + --concurrency/--root + expand subcommand intact", () => {
    const program = new Command();
    registerFleetCommand(program);
    const fleet = program.commands.find((c) => c.name() === "fleet")!;
    expect(fleet.usage()).toContain("manifest");
    const fleetOpts = fleet.options.map((o) => o.long);
    expect(fleetOpts).toContain("--concurrency");
    expect(fleetOpts).toContain("--root");
    const subNames = fleet.commands.map((c) => c.name());
    expect(subNames).toContain("expand");
    expect(subNames).toContain("expand-deep");
    // LOCK2: no sibling command expand-deep-critique
    expect(subNames).not.toContain("expand-deep-critique");
  });

  it("expand subcommand does NOT gain --critique (critique is expand-deep only)", () => {
    const program = new Command();
    registerFleetCommand(program);
    const fleet = program.commands.find((c) => c.name() === "fleet")!;
    const expand = fleet.commands.find((c) => c.name() === "expand")!;
    const expandOpts = expand.options.map((o) => o.long);
    expect(expandOpts).not.toContain("--critique");
  });
});

// ── Tests: --critique spawn-safety invariants (sc-2-7) ────────────────

describe("runFleetExpandDeep --critique spawn-safety invariants (sc-2-7)", () => {
  let tmpDir: string;
  let savedKey: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-expand-deep-crit-spawn-"));
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

  it("credential fail-fast: with --critique, missing key => no file written, decompose never called", async () => {
    delete process.env["DEEPSEEK_API_KEY"];
    const outPath = join(tmpDir, "fleet-expand-crit.json");
    let decomposeCalled = false;

    const trackingDecompose: DecomposeDeepFn = async (...args) => {
      decomposeCalled = true;
      return makeFakeDecomposeDeep()(...args);
    };

    await expect(
      runFleetExpandDeep(
        "Build something",
        { out: outPath, root: tmpDir, critique: true },
        {
          decomposeDeep: trackingDecompose,
          runFleet: vi.fn() as unknown as RunFleetFn,
          createClient: makeFakeClientBuilderThrowing(),
        },
      ),
    ).rejects.toThrow(/DEEPSEEK_API_KEY/);

    // File must NOT have been written
    await expect(access(outPath)).rejects.toThrow();
    // Decompose must NOT have been called
    expect(decomposeCalled).toBe(false);
  });

  it("with --critique and --yes: runFleet is called exactly once with outPath AFTER file exists", async () => {
    process.env["DEEPSEEK_API_KEY"] = "fake-key-for-test";
    const outPath = join(tmpDir, "fleet-expand-crit-yes.json");
    const fakeReport = { total: 2, completed: 2, failed: 0, other: 0 };
    let fileExistedWhenRunFleetCalled = false;

    const runFleetSpy = vi.fn().mockImplementation(async (_path: string) => {
      try {
        await access(outPath);
        fileExistedWhenRunFleetCalled = true;
      } catch {
        fileExistedWhenRunFleetCalled = false;
      }
      return fakeReport;
    });

    await runFleetExpandDeep(
      "Build a platform",
      { out: outPath, root: tmpDir, critique: true, yes: true },
      {
        decomposeDeep: makeFakeDecomposeDeep(),
        runFleet: runFleetSpy as unknown as RunFleetFn,
        createClient: makeFakeClientBuilder(),
      },
    );

    expect(runFleetSpy).toHaveBeenCalledTimes(1);
    expect(runFleetSpy).toHaveBeenCalledWith(outPath);
    expect(fileExistedWhenRunFleetCalled).toBe(true);
  });

  it("with --critique but WITHOUT --yes: runFleet is NOT called", async () => {
    process.env["DEEPSEEK_API_KEY"] = "fake-key-for-test";
    const outPath = join(tmpDir, "fleet-no-yes-crit.json");
    const runFleetSpy = vi.fn();

    await runFleetExpandDeep(
      "Build a platform",
      { out: outPath, root: tmpDir, critique: true },
      {
        decomposeDeep: makeFakeDecomposeDeep(),
        runFleet: runFleetSpy as unknown as RunFleetFn,
        createClient: makeFakeClientBuilder(),
      },
    );

    expect(runFleetSpy).not.toHaveBeenCalled();
  });
});
