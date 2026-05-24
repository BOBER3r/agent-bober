import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ── Mocks ─────────────────────────────────────────────────────────────

// Mock the MCP client so we never spawn a real subprocess
vi.mock("../../src/graph/mcp-client.js", () => {
  const MockMcpClient = vi.fn().mockImplementation(() => ({
    childPid: 99999,
    health: vi.fn().mockReturnValue("ready"),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    call: vi.fn().mockResolvedValue({}),
  }));
  return { TokensaveMcpClient: MockMcpClient };
});

// Mock the prereq check so we can control pass/fail
vi.mock("../../src/graph/prereq.js", () => {
  const MockPrereq = vi.fn().mockImplementation(() => ({
    check: vi.fn().mockResolvedValue({ ok: true, version: "6.0.0-beta.1" }),
  }));
  return { TokensavePrereqCheck: MockPrereq };
});

import { TokensavePrereqCheck } from "../../src/graph/prereq.js";
import { TokensaveMcpClient } from "../../src/graph/mcp-client.js";

// ── Helpers ────────────────────────────────────────────────────────────

function makeConfig(graphEnabled: boolean) {
  return {
    project: { name: "test", mode: "brownfield" },
    planner: { model: "claude-opus-4-5", maxTurns: 5, maxTokens: 4096 },
    generator: { model: "claude-sonnet-4-6", maxTurnsPerSprint: 20 },
    evaluator: { maxIterations: 3, strategies: [] },
    sprint: { maxSprints: 10 },
    pipeline: { skipArchitect: true, skipResearch: true },
    commands: {},
    graph: graphEnabled
      ? {
          enabled: true,
          tokensavePath: "tokensave",
          autoSync: false,
          languageTier: "core" as const,
          manifestPath: ".bober/graph/manifest.json",
          syncTimeoutMs: 2_000,
          queryTimeoutMs: 5_000,
          debounceMs: 750,
          hookQueueMax: 50,
          maxEngineRssMb: 512,
        }
      : undefined,
  } as unknown as import("../../src/config/schema.js").BoberConfig;
}

let tmp: string;

beforeEach(async () => {
  vi.clearAllMocks();
  // Reset mocks to default (pass) state each test
  (TokensavePrereqCheck as unknown as Mock).mockImplementation(() => ({
    check: vi.fn().mockResolvedValue({ ok: true, version: "6.0.0-beta.1" }),
  }));
  (TokensaveMcpClient as unknown as Mock).mockImplementation(() => ({
    childPid: 99999,
    health: vi.fn().mockReturnValue("ready"),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    call: vi.fn().mockResolvedValue({}),
  }));
  tmp = await mkdtemp(join(tmpdir(), "bober-lifecycle-"));
});

afterEach(async () => {
  // Reset singleton after each test
  const { graphPipelineLifecycle } = await import("../../src/graph/pipeline-lifecycle.js");
  (graphPipelineLifecycle as unknown as { _reset: () => void })._reset();

  await rm(tmp, { recursive: true, force: true });
});

// ── Tests: no-op when disabled ──────────────────────────────────────────

describe("GraphPipelineLifecycle — graph.enabled=false", () => {
  it("start() is a no-op — engineHealth() returns 'disabled'", async () => {
    const { graphPipelineLifecycle } = await import("../../src/graph/pipeline-lifecycle.js");
    await graphPipelineLifecycle.start(tmp, makeConfig(false));
    expect(graphPipelineLifecycle.engineHealth()).toBe("disabled");
  });

  it("start() does not spawn any subprocess when disabled", async () => {
    const { graphPipelineLifecycle } = await import("../../src/graph/pipeline-lifecycle.js");
    await graphPipelineLifecycle.start(tmp, makeConfig(false));
    expect(TokensaveMcpClient).not.toHaveBeenCalled();
  });

  it("start() does not write a PID file when disabled", async () => {
    const { graphPipelineLifecycle } = await import("../../src/graph/pipeline-lifecycle.js");
    await graphPipelineLifecycle.start(tmp, makeConfig(false));
    const pidPath = resolve(tmp, ".bober/graph/.serve.pid");
    const { fileExists } = await import("../../src/utils/fs.js");
    expect(await fileExists(pidPath)).toBe(false);
  });

  it("second start() call after disabled start is a no-op (idempotent)", async () => {
    const { graphPipelineLifecycle } = await import("../../src/graph/pipeline-lifecycle.js");
    await graphPipelineLifecycle.start(tmp, makeConfig(false));
    await graphPipelineLifecycle.start(tmp, makeConfig(false));
    expect(graphPipelineLifecycle.engineHealth()).toBe("disabled");
  });
});

// ── Tests: prereq failure ────────────────────────────────────────────────

describe("GraphPipelineLifecycle — prereq failure", () => {
  it("start() throws structured error when prereq fails", async () => {
    (TokensavePrereqCheck as unknown as Mock).mockImplementation(() => ({
      check: vi.fn().mockResolvedValue({
        ok: false,
        reason: "MISSING",
        hint: "brew install aovestdipaperino/tap/tokensave",
      }),
    }));

    const { graphPipelineLifecycle } = await import("../../src/graph/pipeline-lifecycle.js");
    await expect(
      graphPipelineLifecycle.start(tmp, makeConfig(true)),
    ).rejects.toThrow(/Graph prereq failed.*MISSING/);
  });

  it("does not spawn MCP client when prereq fails", async () => {
    (TokensavePrereqCheck as unknown as Mock).mockImplementation(() => ({
      check: vi.fn().mockResolvedValue({
        ok: false,
        reason: "INCOMPATIBLE",
        hint: "tokensave 5.0 is incompatible; required range: >=6.0.0-beta.1 <7.0.0",
      }),
    }));

    const { graphPipelineLifecycle } = await import("../../src/graph/pipeline-lifecycle.js");
    await graphPipelineLifecycle.start(tmp, makeConfig(true)).catch(() => {});
    expect(TokensaveMcpClient).not.toHaveBeenCalled();
  });
});

// ── Tests: happy path ───────────────────────────────────────────────────

describe("GraphPipelineLifecycle — enabled and prereq passes", () => {
  it("start() spawns MCP client and engineHealth() returns 'ready'", async () => {
    const { graphPipelineLifecycle } = await import("../../src/graph/pipeline-lifecycle.js");
    await graphPipelineLifecycle.start(tmp, makeConfig(true));
    expect(TokensaveMcpClient).toHaveBeenCalledOnce();
    expect(graphPipelineLifecycle.engineHealth()).toBe("ready");
  });

  it("start() writes a PID file with correct shape", async () => {
    const { graphPipelineLifecycle } = await import("../../src/graph/pipeline-lifecycle.js");
    await graphPipelineLifecycle.start(tmp, makeConfig(true));

    const pidPath = resolve(tmp, ".bober/graph/.serve.pid");
    const { readJson } = await import("../../src/utils/fs.js");
    const data = await readJson<{ pid: number; startedAt: string; projectRoot: string }>(pidPath);

    expect(typeof data.pid).toBe("number");
    expect(typeof data.startedAt).toBe("string");
    expect(data.projectRoot).toBe(tmp);
  });

  it("stop() removes the PID file", async () => {
    const { graphPipelineLifecycle } = await import("../../src/graph/pipeline-lifecycle.js");
    await graphPipelineLifecycle.start(tmp, makeConfig(true));
    await graphPipelineLifecycle.stop();

    const pidPath = resolve(tmp, ".bober/graph/.serve.pid");
    const { fileExists } = await import("../../src/utils/fs.js");
    expect(await fileExists(pidPath)).toBe(false);
  });

  it("stop() is idempotent — calling twice does not throw", async () => {
    const { graphPipelineLifecycle } = await import("../../src/graph/pipeline-lifecycle.js");
    await graphPipelineLifecycle.start(tmp, makeConfig(true));
    await graphPipelineLifecycle.stop();
    await expect(graphPipelineLifecycle.stop()).resolves.toBeUndefined();
  });

  it("start() is idempotent — second call is a no-op", async () => {
    const { graphPipelineLifecycle } = await import("../../src/graph/pipeline-lifecycle.js");
    await graphPipelineLifecycle.start(tmp, makeConfig(true));
    await graphPipelineLifecycle.start(tmp, makeConfig(true)); // should not spawn again
    expect(TokensaveMcpClient).toHaveBeenCalledOnce();
  });
});

// ── Tests: PID file orphan cleanup ──────────────────────────────────────

describe("GraphPipelineLifecycle — PID file orphan cleanup", () => {
  it("tolerates a stale PID file for a dead process (non-existent PID)", async () => {
    // Write a fake PID file pointing to a non-existent PID
    const pidPath = resolve(tmp, ".bober/graph/.serve.pid");
    const { ensureDir, writeJson } = await import("../../src/utils/fs.js");
    await ensureDir(resolve(tmp, ".bober/graph"));
    await writeJson(pidPath, { pid: 999999999, startedAt: "2026-01-01T00:00:00Z", projectRoot: tmp });

    const { graphPipelineLifecycle } = await import("../../src/graph/pipeline-lifecycle.js");
    // Should not throw
    await expect(graphPipelineLifecycle.start(tmp, makeConfig(true))).resolves.toBeUndefined();

    // PID file should be replaced with the new one
    const { readJson } = await import("../../src/utils/fs.js");
    const data = await readJson<{ pid: number }>(pidPath);
    expect(data.pid).toBe(99999); // from mock
  });

  it("tolerates a malformed PID file", async () => {
    const pidPath = resolve(tmp, ".bober/graph/.serve.pid");
    const { ensureDir } = await import("../../src/utils/fs.js");
    await ensureDir(resolve(tmp, ".bober/graph"));
    await writeFile(pidPath, "{ not valid json }", "utf-8");

    const { graphPipelineLifecycle } = await import("../../src/graph/pipeline-lifecycle.js");
    await expect(graphPipelineLifecycle.start(tmp, makeConfig(true))).resolves.toBeUndefined();
  });
});

// ── Tests: singleton guarantee ───────────────────────────────────────────

describe("GraphPipelineLifecycle — singleton", () => {
  it("module exports the same object on every import", async () => {
    const mod1 = await import("../../src/graph/pipeline-lifecycle.js");
    const mod2 = await import("../../src/graph/pipeline-lifecycle.js");
    expect(mod1.graphPipelineLifecycle).toBe(mod2.graphPipelineLifecycle);
  });

  it("two start() calls from different import sites spawn only one child", async () => {
    const mod1 = await import("../../src/graph/pipeline-lifecycle.js");
    const mod2 = await import("../../src/graph/pipeline-lifecycle.js");

    await mod1.graphPipelineLifecycle.start(tmp, makeConfig(true));
    await mod2.graphPipelineLifecycle.start(tmp, makeConfig(true)); // no-op

    expect(TokensaveMcpClient).toHaveBeenCalledOnce();
  });
});
