/**
 * Regression tests for sc-3-6 (sprint-3 iteration 2 retry), updated for
 * Sprint 4 (sc-4-3).
 *
 * src/cli/commands/graph.ts's init/sync/status handlers each resolve a
 * GraphBackend via resolveGraphBackend() for the prereq check, then MUST
 * construct TokensaveCli from that SAME resolved backend — not a hardcoded
 * tokensave. With graph.backend explicitly set to "code-review-graph", all
 * three commands must construct TokensaveCli with the cr-graph backend +
 * binary.
 *
 * As of Sprint 4, CodeReviewGraphBackend.cliMap() is REAL (init->build,
 * sync->update, status->status --json), so init/sync/status now actually
 * spawn `code-review-graph <verb>` (execa mocked below with real captured
 * output samples) instead of surfacing the Sprint-3 stub's NOT_IMPL error.
 *
 * We wrap the REAL TokensaveCli class (via vi.importActual) with a spy that
 * records constructor args, so behavior stays real while we can assert
 * exactly which backend/binary each site passed in AND which argv execa
 * received.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { Command } from "commander";

// ── Static mocks ──────────────────────────────────────────────────────────

vi.mock("execa", () => ({ execa: vi.fn() }));

import { execa } from "execa";

function mockExeca(value: Record<string, unknown>): void {
  (execa as unknown as Mock).mockResolvedValue({
    exitCode: 0,
    stdout: "",
    stderr: "",
    failed: false,
    timedOut: false,
    all: "",
    ...value,
  });
}

vi.mock("../../src/utils/fs.js", () => ({
  findProjectRoot: vi.fn().mockResolvedValue("/fake/project"),
  fileExists: vi.fn().mockResolvedValue(false),
  ensureDir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/graph/prereq.js", () => ({
  GenericPrereqCheck: vi.fn().mockImplementation(() => ({
    check: vi.fn().mockResolvedValue({ ok: true, version: "1.0.0" }),
  })),
}));

vi.mock("../../src/graph/artifact-store.js", () => ({
  GraphArtifactStore: vi.fn().mockImplementation(() => ({
    ensureLayout: vi.fn().mockResolvedValue(undefined),
    readManifest: vi.fn().mockResolvedValue(null),
    writeManifest: vi.fn().mockResolvedValue(undefined),
    staleness: vi.fn().mockResolvedValue({ stale: false }),
  })),
}));

// Real resolveGraphBackend/binaryForBackend + real CodeReviewGraphBackend and
// TokensaveBackend — no mocking here. With graph.backend explicitly set,
// resolveGraphBackend short-circuits with NO probe, so this is deterministic
// without touching the real filesystem/PATH.

// Wrap the REAL TokensaveCli with a constructor-arg-recording spy.
vi.mock("../../src/graph/cli.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../src/graph/cli.js")>("../../src/graph/cli.js");
  class SpyCli extends actual.TokensaveCli {
    static calls: unknown[][] = [];
    constructor(...args: ConstructorParameters<typeof actual.TokensaveCli>) {
      super(...args);
      SpyCli.calls.push(args);
    }
  }
  return { ...actual, TokensaveCli: SpyCli };
});

import { TokensaveCli } from "../../src/graph/cli.js";
import { loadConfig } from "../../src/config/loader.js";

vi.mock("../../src/config/loader.js", () => ({
  loadConfig: vi.fn(),
}));

function crGraphConfig() {
  return {
    graph: {
      enabled: true,
      backend: "code-review-graph",
      languageTier: "core",
      manifestPath: ".bober/graph/manifest.json",
      syncTimeoutMs: 2_000,
    },
  };
}

type SpyCliClass = { calls: unknown[][] };

function captureStdio(): {
  stdout: string[];
  stderr: string[];
  restore: () => void;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((msg) => {
    stdout.push(typeof msg === "string" ? msg : msg.toString());
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((msg) => {
    stderr.push(typeof msg === "string" ? msg : msg.toString());
    return true;
  });
  return {
    stdout,
    stderr,
    restore: () => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

beforeEach(() => {
  (TokensaveCli as unknown as SpyCliClass).calls = [];
  (loadConfig as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(crGraphConfig());
  (execa as unknown as Mock).mockReset();
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = undefined;
});

describe("graph commands — cr-graph backend selected (sc-3-6 regression, cliMap real as of Sprint 4)", () => {
  it("graph init constructs TokensaveCli from the RESOLVED cr-graph backend AND runs 'code-review-graph build'", async () => {
    mockExeca({ exitCode: 0, stdout: "Full build: 2 files, 8 nodes, 15 edges (postprocess=full)" });
    const { restore } = captureStdio();
    try {
      const { registerGraphCommand } = await import("../../src/cli/commands/graph.js");
      const prog = new Command();
      prog.exitOverride();
      registerGraphCommand(prog);
      await prog.parseAsync(["node", "test", "graph", "init"]).catch(() => {});

      const calls = (TokensaveCli as unknown as SpyCliClass).calls;
      expect(calls.length).toBe(1);
      const [, , binaryArg, backendArg] = calls[0];
      expect(binaryArg).toBe("code-review-graph");
      expect((backendArg as { id: string }).id).toBe("code-review-graph");

      // cliMap is real as of Sprint 4 — init now spawns the actual build verb.
      expect(execa).toHaveBeenCalledWith(
        "code-review-graph",
        ["build"],
        expect.any(Object),
      );
      expect(process.exitCode).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("graph sync constructs TokensaveCli from the RESOLVED cr-graph backend AND runs 'code-review-graph update'", async () => {
    const syncOutput = "Incremental: 1 files updated, 4 nodes, 9 edges (postprocess=full)";
    mockExeca({ exitCode: 0, stdout: syncOutput, all: syncOutput });
    const { restore } = captureStdio();
    try {
      const { registerGraphCommand } = await import("../../src/cli/commands/graph.js");
      const prog = new Command();
      prog.exitOverride();
      registerGraphCommand(prog);
      await prog.parseAsync(["node", "test", "graph", "sync"]).catch(() => {});

      const calls = (TokensaveCli as unknown as SpyCliClass).calls;
      expect(calls.length).toBe(1);
      const [, , binaryArg, backendArg] = calls[0];
      expect(binaryArg).toBe("code-review-graph");
      expect((backendArg as { id: string }).id).toBe("code-review-graph");

      // cliMap is real as of Sprint 4 — sync now spawns the actual update verb.
      expect(execa).toHaveBeenCalledWith(
        "code-review-graph",
        ["update", "."],
        expect.any(Object),
      );
      expect(process.exitCode).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("graph status constructs TokensaveCli from the RESOLVED cr-graph backend AND runs 'code-review-graph status --json'", async () => {
    mockExeca({
      exitCode: 0,
      stdout: JSON.stringify({ nodes: 8, edges: 15, files: 2, languages: ["python"] }),
    });
    const { restore } = captureStdio();
    try {
      const { registerGraphCommand } = await import("../../src/cli/commands/graph.js");
      const prog = new Command();
      prog.exitOverride();
      registerGraphCommand(prog);
      await prog.parseAsync(["node", "test", "graph", "status", "--json"]).catch(() => {});

      const calls = (TokensaveCli as unknown as SpyCliClass).calls;
      expect(calls.length).toBe(1);
      const [, storeArg, binaryArg, backendArg] = calls[0];
      expect(storeArg).toBeNull();
      expect(binaryArg).toBe("code-review-graph");
      expect((backendArg as { id: string }).id).toBe("code-review-graph");

      // cliMap is real as of Sprint 4 — status now spawns the actual status verb.
      expect(execa).toHaveBeenCalledWith(
        "code-review-graph",
        ["status", "--json"],
        expect.any(Object),
      );
    } finally {
      restore();
    }
  });
});
