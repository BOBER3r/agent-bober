/**
 * Regression test for sc-3-6 (sprint-3 iteration 2 retry).
 *
 * GraphPipelineLifecycle.start() resolves a GraphBackend for the transport +
 * prereq check, then must construct the GraphHookHandler's TokensaveCli from
 * that SAME resolved backend — not a hardcoded tokensave. This is a separate
 * file from tests/graph/pipeline-lifecycle.test.ts (which covers start/stop/
 * PID/orphan behavior against a tokensave-shaped stub) so as not to disturb
 * its already-passing assertions; this file exercises the cr-graph-selected
 * branch specifically.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock the MCP client so we never spawn a real subprocess
vi.mock("../../src/graph/mcp-client.js", () => {
  const MockMcpClient = vi.fn().mockImplementation(() => ({
    childPid: 88888,
    health: vi.fn().mockReturnValue("ready"),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    call: vi.fn().mockResolvedValue({}),
  }));
  return { TokensaveMcpClient: MockMcpClient };
});

// Mock the prereq check so it always passes (cr-graph's accept-any-version stub)
vi.mock("../../src/graph/prereq.js", () => {
  const MockPrereq = vi.fn().mockImplementation(() => ({
    check: vi.fn().mockResolvedValue({ ok: true, version: "0.1.0" }),
  }));
  return { GenericPrereqCheck: MockPrereq };
});

// Resolve to the REAL CodeReviewGraphBackend — no probe needed since the test
// config sets graph.backend explicitly (short-circuits detection).
vi.mock("../../src/graph/backends/registry.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/graph/backends/registry.js")>(
    "../../src/graph/backends/registry.js",
  );
  const { CodeReviewGraphBackend } = await import(
    "../../src/graph/backends/code-review-graph-backend.js"
  );
  const crGraph = new CodeReviewGraphBackend();
  return {
    ...actual,
    resolveGraphBackend: vi.fn().mockResolvedValue(crGraph),
    binaryForBackend: vi.fn().mockReturnValue("code-review-graph"),
  };
});

// Wrap the REAL TokensaveCli with a constructor-arg-recording spy so we can
// assert exactly what pipeline-lifecycle.ts passes to the hook-sync CLI,
// while the underlying class stays real (nothing else in start() calls
// init/sync/status, so its stub cliMap() is never actually invoked here).
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

import { GenericPrereqCheck } from "../../src/graph/prereq.js";
import { TokensaveMcpClient } from "../../src/graph/mcp-client.js";
import { TokensaveCli } from "../../src/graph/cli.js";

type SpyCliClass = { calls: unknown[][] };

function makeConfig() {
  return {
    project: { name: "test", mode: "brownfield" },
    planner: { model: "claude-opus-4-5", maxTurns: 5, maxTokens: 4096 },
    generator: { model: "claude-sonnet-4-6", maxTurnsPerSprint: 20 },
    evaluator: { maxIterations: 3, strategies: [] },
    sprint: { maxSprints: 10 },
    pipeline: { skipArchitect: true, skipResearch: true },
    commands: {},
    graph: {
      enabled: true,
      backend: "code-review-graph",
      autoSync: false,
      languageTier: "core" as const,
      manifestPath: ".bober/graph/manifest.json",
      syncTimeoutMs: 2_000,
      queryTimeoutMs: 5_000,
      debounceMs: 750,
      hookQueueMax: 50,
      maxEngineRssMb: 512,
    },
  } as unknown as import("../../src/config/schema.js").BoberConfig;
}

let tmp: string;

beforeEach(async () => {
  vi.clearAllMocks();
  (TokensaveCli as unknown as SpyCliClass).calls = [];
  (GenericPrereqCheck as unknown as Mock).mockImplementation(() => ({
    check: vi.fn().mockResolvedValue({ ok: true, version: "0.1.0" }),
  }));
  (TokensaveMcpClient as unknown as Mock).mockImplementation(() => ({
    childPid: 88888,
    health: vi.fn().mockReturnValue("ready"),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    call: vi.fn().mockResolvedValue({}),
  }));
  tmp = await mkdtemp(join(tmpdir(), "bober-lifecycle-crgraph-"));
});

afterEach(async () => {
  const { graphPipelineLifecycle } = await import("../../src/graph/pipeline-lifecycle.js");
  await graphPipelineLifecycle.stop().catch(() => {});
  (graphPipelineLifecycle as unknown as { _reset: () => void })._reset();
  await rm(tmp, { recursive: true, force: true });
});

describe("GraphPipelineLifecycle — cr-graph backend selected (sc-3-6 regression)", () => {
  it("start() constructs the hook-sync TokensaveCli from the RESOLVED cr-graph backend", async () => {
    const { graphPipelineLifecycle } = await import("../../src/graph/pipeline-lifecycle.js");
    await graphPipelineLifecycle.start(tmp, makeConfig());

    const calls = (TokensaveCli as unknown as SpyCliClass).calls;
    expect(calls.length).toBe(1);
    const [, , binaryArg, backendArg] = calls[0];
    expect(binaryArg).toBe("code-review-graph");
    expect((backendArg as { id: string }).id).toBe("code-review-graph");
  });
});
