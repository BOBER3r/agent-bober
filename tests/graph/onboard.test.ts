/**
 * sc-7-2 (sprint 7): `agent-bober onboard` through the code-review-graph
 * backend.
 *
 * onboard.ts already resolves the backend via resolveGraphBackend +
 * binaryForBackend (Sprint 3); this test proves the surface actually
 * EXERCISES a non-tokensave backend end-to-end (mocked transport, real
 * GraphClient/resolveGraphBackend/CodeReviewGraphBackend/OnboardingComposer),
 * and that the onboard version line is sourced from manifest.backendVersion
 * (the sc-7-2 fix), not a tokensave-specific field.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";

// ── Hoisted shared mock state ──────────────────────────────────────────

const hoisted = vi.hoisted(() => ({
  findProjectRootMock: vi.fn(),
  mcpCalls: [] as Array<{ tool: string; params: unknown }>,
  mcpConstructions: [] as Array<{ binary: string; serveArgs: string[] }>,
}));

// A minimal cr-graph semantic_search_nodes_tool-shaped response, reused for
// every search() call onboard.ts makes (hotspots/dead-code/circular/
// largest/module-api) since the mocked transport ignores query params.
const CR_SEARCH_RESULT = {
  status: "ok",
  results: [
    {
      name: "add",
      qualified_name: "/repo/src/math_utils.py::add",
      kind: "Function",
      file_path: "/repo/src/math_utils.py",
      line_start: 1,
      line_end: 1,
      score: 0.5,
      signature: "def add((a, b))",
    },
  ],
};

// ── Static mocks ────────────────────────────────────────────────────────

vi.mock("../../src/config/loader.js", () => ({ loadConfig: vi.fn() }));

vi.mock("../../src/utils/fs.js", () => ({
  findProjectRoot: hoisted.findProjectRootMock,
  fileExists: vi.fn().mockResolvedValue(false),
  ensureDir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/graph/prereq.js", () => ({
  GenericPrereqCheck: vi.fn().mockImplementation(() => ({
    check: vi.fn().mockResolvedValue({ ok: true, version: "2.3.7" }),
  })),
}));

vi.mock("../../src/graph/artifact-store.js", () => ({
  GraphArtifactStore: vi.fn().mockImplementation(() => ({
    ensureLayout: vi.fn().mockResolvedValue(undefined),
    readManifest: vi.fn().mockResolvedValue({
      schemaVersion: 1,
      // tokensaveVersion deliberately EMPTY — proves the version line comes
      // from backendVersion, not this legacy field (the sc-7-2 fix).
      tokensaveVersion: "",
      backend: "code-review-graph",
      backendVersion: "2.3.7",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastSyncAt: "2026-01-01T00:00:00.000Z",
      indexedFileCount: 2,
      languageTier: "core",
      lastSyncedHeadSha: null,
      pendingFiles: [],
    }),
    writeManifest: vi.fn().mockResolvedValue(undefined),
    staleness: vi.fn().mockResolvedValue({ stale: false }),
  })),
}));

vi.mock("../../src/graph/mcp-client.js", () => ({
  TokensaveMcpClient: vi
    .fn()
    .mockImplementation((_root: string, _cfg: unknown, _incidents: unknown, processSpec: { binary: string; serveArgs: string[] }) => {
      hoisted.mcpConstructions.push(processSpec);
      return {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        health: vi.fn().mockReturnValue("ready"),
        call: vi.fn().mockImplementation(async (tool: string) => {
          hoisted.mcpCalls.push({ tool, params: undefined });
          if (tool === "semantic_search_nodes_tool") return CR_SEARCH_RESULT;
          return { results: [] };
        }),
        childPid: 4242,
      };
    }),
}));

import { loadConfig } from "../../src/config/loader.js";

function crGraphConfig(overrides: Record<string, unknown> = {}) {
  return {
    graph: {
      enabled: true,
      backend: "code-review-graph",
      autoSync: false,
      languageTier: "core",
      manifestPath: ".bober/graph/manifest.json",
      syncTimeoutMs: 2_000,
      queryTimeoutMs: 5_000,
      debounceMs: 500,
      hookQueueMax: 10,
      maxEngineRssMb: 512,
      exposeOnExternalMcp: true,
      ...overrides,
    },
  };
}

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "bober-onboard-cr-graph-"));
  hoisted.findProjectRootMock.mockReset().mockResolvedValue(tmp);
  hoisted.mcpCalls.length = 0;
  hoisted.mcpConstructions.length = 0;
  (loadConfig as unknown as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(crGraphConfig());
  process.exitCode = undefined;
});

afterEach(async () => {
  process.exitCode = undefined;
  await rm(tmp, { recursive: true, force: true });
});

describe("agent-bober onboard through the code-review-graph backend (sc-7-2)", () => {
  it("writes all 5 onboarding artifacts and sources the version line from manifest.backendVersion", async () => {
    const { registerOnboardCommand } = await import("../../src/cli/commands/onboard.js");
    const prog = new Command();
    prog.exitOverride();
    registerOnboardCommand(prog);

    await prog.parseAsync(["node", "test", "onboard"]);

    expect(process.exitCode).toBeUndefined();

    // All 5 markdown artifacts written to .bober/onboarding/
    const outputDir = join(tmp, ".bober", "onboarding");
    const files = (await readdir(outputDir)).sort();
    expect(files).toEqual(
      [
        "README.md",
        "architecture-overview.md",
        "communities.md",
        "hotspots.md",
        "knowledge-gaps.md",
      ].sort(),
    );

    // Version line sourced from backendVersion (2.3.7), NOT the empty
    // legacy tokensaveVersion field (onboard.ts:141 fix).
    const readme = await readFile(join(outputDir, "README.md"), "utf-8");
    expect(readme).toContain("agent-bober graph v2.3.7");

    // The mocked transport was actually exercised via the cr-graph tool name
    // (not tokensave_search) — proves onboard operates through the resolved
    // cr-graph backend, not a hardcoded tokensave client.
    expect(hoisted.mcpCalls.length).toBe(5);
    expect(hoisted.mcpCalls.every((c) => c.tool === "semantic_search_nodes_tool")).toBe(true);
  });

  it("threads graph.codeReviewGraphPath into the serve subprocess's ProcessSpec (MEDIUM follow-up)", async () => {
    (loadConfig as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      crGraphConfig({ codeReviewGraphPath: "/custom/bin/code-review-graph" }),
    );

    const { registerOnboardCommand } = await import("../../src/cli/commands/onboard.js");
    const prog = new Command();
    prog.exitOverride();
    registerOnboardCommand(prog);

    await prog.parseAsync(["node", "test", "onboard"]);

    expect(process.exitCode).toBeUndefined();
    expect(hoisted.mcpConstructions.length).toBe(1);
    expect(hoisted.mcpConstructions[0]).toEqual({
      binary: "/custom/bin/code-review-graph",
      serveArgs: ["serve"],
    });
  });
});
