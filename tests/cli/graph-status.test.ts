/**
 * sc-7-5 (sprint 7): `agent-bober graph status` backend-status readout.
 *
 * Augments the existing `graph status` action (graph.ts:242-316) with the
 * active backend id, its version, and whether it was chosen by explicit
 * config or auto-detection. This test drives the REAL resolveGraphBackend +
 * binaryForBackend + GenericPrereqCheck + TokensaveCli through a mocked
 * execa transport for BOTH backends: an explicit code-review-graph config
 * (selectedBy: "config") and a backend-less config (auto-detect finds
 * tokensave first, per KNOWN_BACKENDS preference order).
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { Command } from "commander";

// ── Static mocks ──────────────────────────────────────────────────────

vi.mock("execa", () => ({ execa: vi.fn() }));

import { execa } from "execa";

vi.mock("../../src/utils/fs.js", () => ({
  findProjectRoot: vi.fn().mockResolvedValue("/fake/project"),
  fileExists: vi.fn().mockResolvedValue(false),
  ensureDir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/config/loader.js", () => ({ loadConfig: vi.fn() }));

import { loadConfig } from "../../src/config/loader.js";

function readManifestMock(overrides: Record<string, unknown> = {}) {
  return vi.fn().mockResolvedValue({
    schemaVersion: 1,
    tokensaveVersion: "",
    backend: "tokensave",
    backendVersion: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastSyncAt: "2026-01-01T00:00:00.000Z",
    indexedFileCount: 0,
    languageTier: "core",
    lastSyncedHeadSha: null,
    pendingFiles: [],
    ...overrides,
  });
}

const artifactStoreState: { readManifest: ReturnType<typeof vi.fn> } = {
  readManifest: readManifestMock(),
};

vi.mock("../../src/graph/artifact-store.js", () => ({
  GraphArtifactStore: vi.fn().mockImplementation(() => ({
    ensureLayout: vi.fn().mockResolvedValue(undefined),
    readManifest: (...args: unknown[]) => artifactStoreState.readManifest(...args),
    writeManifest: vi.fn().mockResolvedValue(undefined),
    staleness: vi.fn().mockResolvedValue({ stale: false }),
  })),
}));

// ── Helpers ─────────────────────────────────────────────────────────────

function captureStdio(): { stdout: string[]; restore: () => void } {
  const stdout: string[] = [];
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((msg) => {
    stdout.push(typeof msg === "string" ? msg : msg.toString());
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return {
    stdout,
    restore: () => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

/** Generic execa mock: handles `--version` probes and `status --json` for
 *  both backends, keyed by the binary passed as the first execa argument. */
function mockExecaGeneric(opts: {
  versionStdout: string;
  statusStdoutByBinary: Record<string, string>;
}): void {
  (execa as unknown as Mock).mockImplementation(async (bin: string, args: string[]) => {
    if (args[0] === "--version") {
      return { exitCode: 0, stdout: opts.versionStdout, stderr: "", failed: false, timedOut: false, all: "" };
    }
    if (args[0] === "status") {
      const stdout = opts.statusStdoutByBinary[bin] ?? "{}";
      return { exitCode: 0, stdout, stderr: "", failed: false, timedOut: false, all: stdout };
    }
    return { exitCode: 0, stdout: "", stderr: "", failed: false, timedOut: false, all: "" };
  });
}

beforeEach(() => {
  (execa as unknown as Mock).mockReset();
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = undefined;
});

describe("graph status backend-status readout (sc-7-5)", () => {
  it("code-review-graph explicitly configured: prints Engine/Version/Selected-by = config", async () => {
    (loadConfig as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      graph: {
        enabled: true,
        backend: "code-review-graph",
        manifestPath: ".bober/graph/manifest.json",
        syncTimeoutMs: 2_000,
      },
    });
    artifactStoreState.readManifest = readManifestMock({
      backend: "code-review-graph",
      backendVersion: "2.3.7",
      indexedFileCount: 12,
    });
    mockExecaGeneric({
      versionStdout: "2.3.7\n",
      statusStdoutByBinary: {
        "code-review-graph": JSON.stringify({ files: 12, nodes: 40, edges: 60, languages: ["python"] }),
      },
    });

    const { restore, stdout } = captureStdio();
    try {
      const { registerGraphCommand } = await import("../../src/cli/commands/graph.js");
      const prog = new Command();
      prog.exitOverride();
      registerGraphCommand(prog);
      await prog.parseAsync(["node", "test", "graph", "status"]);

      const out = stdout.join("");
      expect(out).toContain("Backend:         code-review-graph\n");
      expect(out).toContain("Version:         2.3.7\n");
      expect(out).toContain("Selected by:     config\n");
    } finally {
      restore();
    }
  });

  it("no explicit backend: auto-detect resolves tokensave (preference order), Selected-by = auto-detect", async () => {
    (loadConfig as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      graph: {
        enabled: true,
        manifestPath: ".bober/graph/manifest.json",
        syncTimeoutMs: 2_000,
      },
    });
    artifactStoreState.readManifest = readManifestMock({
      backend: "tokensave",
      backendVersion: "6.1.1",
      tokensaveVersion: "6.1.1",
      indexedFileCount: 30,
    });
    mockExecaGeneric({
      versionStdout: "6.1.1\n",
      statusStdoutByBinary: {
        tokensave: JSON.stringify({ file_count: 30, node_count: 100 }),
      },
    });

    const { restore, stdout } = captureStdio();
    try {
      const { registerGraphCommand } = await import("../../src/cli/commands/graph.js");
      const prog = new Command();
      prog.exitOverride();
      registerGraphCommand(prog);
      await prog.parseAsync(["node", "test", "graph", "status"]);

      const out = stdout.join("");
      expect(out).toContain("Backend:         tokensave\n");
      expect(out).toContain("Version:         6.1.1\n");
      expect(out).toContain("Selected by:     auto-detect\n");
    } finally {
      restore();
    }
  });

  it("--json output includes backend/backendVersion/selectedBy as additive fields", async () => {
    (loadConfig as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      graph: {
        enabled: true,
        backend: "code-review-graph",
        manifestPath: ".bober/graph/manifest.json",
        syncTimeoutMs: 2_000,
      },
    });
    artifactStoreState.readManifest = readManifestMock({
      backend: "code-review-graph",
      backendVersion: "2.3.7",
      indexedFileCount: 12,
    });
    mockExecaGeneric({
      versionStdout: "2.3.7\n",
      statusStdoutByBinary: {
        "code-review-graph": JSON.stringify({ files: 12, nodes: 40, edges: 60, languages: ["python"] }),
      },
    });

    const { restore, stdout } = captureStdio();
    try {
      const { registerGraphCommand } = await import("../../src/cli/commands/graph.js");
      const prog = new Command();
      prog.exitOverride();
      registerGraphCommand(prog);
      await prog.parseAsync(["node", "test", "graph", "status", "--json"]);

      const parsed = JSON.parse(stdout.join("")) as {
        backend: string;
        backendVersion: string;
        selectedBy: string;
        indexedFileCount: number;
      };
      expect(parsed.backend).toBe("code-review-graph");
      expect(parsed.backendVersion).toBe("2.3.7");
      expect(parsed.selectedBy).toBe("config");
    } finally {
      restore();
    }
  });
});
