/**
 * sc-7-3 (sprint 7): `agent-bober impact <target>` through the
 * code-review-graph backend.
 *
 * impact.ts already resolves the backend via resolveGraphBackend +
 * binaryForBackend (Sprint 3); this test proves it actually EXERCISES a
 * non-tokensave backend end-to-end (mocked transport, real GraphClient /
 * resolveGraphBackend / CodeReviewGraphBackend), i.e. the underlying MCP
 * calls use the cr-graph tool catalog (get_impact_radius_tool /
 * query_graph_tool), not tokensave_impact / tokensave_test_map.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";

// ── Hoisted shared mock state ──────────────────────────────────────────

const hoisted = vi.hoisted(() => ({
  findProjectRootMock: vi.fn(),
  mcpCalls: [] as Array<{ tool: string; params: unknown }>,
  mcpConstructions: [] as Array<{ binary: string; serveArgs: string[] }>,
}));

// Minimal cr-graph get_impact_radius_tool / query_graph_tool(tests_for)
// shaped responses (see tests/graph/fixtures/cr-graph/ for the full captures
// this mirrors).
const CR_IMPACT_RESULT = {
  status: "ok",
  changed_files: ["src/math_utils.py"],
  changed_nodes: [
    {
      id: 4,
      kind: "File",
      name: "/repo/src/math_utils.py",
      qualified_name: "/repo/src/math_utils.py",
      file_path: "/repo/src/math_utils.py",
      line_start: 1,
      is_test: false,
    },
  ],
  impacted_nodes: [
    {
      id: 10,
      kind: "Function",
      name: "run",
      qualified_name: "/repo/src/main.py::run",
      file_path: "/repo/src/main.py",
      line_start: 2,
      is_test: false,
    },
  ],
};

const CR_TESTS_FOR_RESULT = {
  status: "ok",
  pattern: "tests_for",
  results: [
    {
      id: 11,
      kind: "Test",
      name: "test_multiply",
      qualified_name: "/repo/tests/test_math_utils.py::test_multiply",
      file_path: "/repo/tests/test_math_utils.py",
      line_start: 6,
      is_test: true,
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
    readManifest: vi.fn().mockResolvedValue(null),
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
        call: vi.fn().mockImplementation(async (tool: string, params: unknown) => {
          hoisted.mcpCalls.push({ tool, params });
          if (tool === "get_impact_radius_tool") return CR_IMPACT_RESULT;
          if (tool === "query_graph_tool") return CR_TESTS_FOR_RESULT;
          return { results: [] };
        }),
        childPid: 4343,
      };
    }),
}));

import { loadConfig } from "../../src/config/loader.js";

function crGraphConfig() {
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
    },
  };
}

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "bober-impact-cr-graph-"));
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

describe("agent-bober impact through the code-review-graph backend (sc-7-3)", () => {
  it("calls the cr-graph tool catalog (get_impact_radius_tool + query_graph_tool), not tokensave_impact/tokensave_test_map", async () => {
    const { registerImpactCommand } = await import("../../src/cli/commands/impact.js");
    const prog = new Command();
    prog.exitOverride();
    registerImpactCommand(prog);

    await prog.parseAsync(["node", "test", "impact", "src/math_utils.py::multiply"]);

    expect(process.exitCode).toBeUndefined();

    const tools = hoisted.mcpCalls.map((c) => c.tool).sort();
    expect(tools).toEqual(["get_impact_radius_tool", "query_graph_tool"]);
    expect(tools).not.toContain("tokensave_impact");
    expect(tools).not.toContain("tokensave_test_map");

    // Report written under .bober/graph/impact/
    const impactDir = join(tmp, ".bober", "graph", "impact");
    const files = await readdir(impactDir);
    expect(files.length).toBe(1);
    const report = await readFile(join(impactDir, files[0]!), "utf-8");
    expect(report).toContain("# Impact: src/math_utils.py::multiply");
  });
});
