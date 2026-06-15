/**
 * Unit tests for `bober run --team <id>` CLI flag threading.
 *
 * sc-4-4: loadTeam(config, 'example') returns declared namespace/shape/providers.
 * sc-4-5: --team <id> threads teamId into runPipeline opts; absent --team => undefined.
 *
 * Pattern: vi.mock runPipeline and loadConfig, call runRunCommand directly.
 * No network, no real LLM calls. Uses temp dirs for configExists checks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Stubs ─────────────────────────────────────────────────────────────

// Minimal config with an example team declared as pure data
const minimalConfig = {
  project: { name: "test-project", mode: "brownfield" as const },
  teams: {
    example: {
      displayName: "Example research team",
      memoryNamespace: "example",
      pipelineShape: "ts" as const,
      providers: { chat: "openai" },
    },
  },
};

vi.mock("../../orchestrator/pipeline.js", () => ({
  runPipeline: vi.fn(async () => ({
    success: true,
    duration: 0,
    spec: { title: "t", features: [] },
    completedSprints: [],
    failedSprints: [],
  })),
}));

vi.mock("../../config/loader.js", () => ({
  configExists: vi.fn(async () => true),
  loadConfig: vi.fn(async () => minimalConfig),
}));

// ── Temp directory lifecycle ──────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-run-cmd-"));
  await mkdir(join(tmpDir, ".bober"), { recursive: true });
  await writeFile(
    join(tmpDir, "bober.config.json"),
    JSON.stringify(minimalConfig),
    "utf-8",
  );
  vi.clearAllMocks();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── sc-4-4: loadTeam resolves example team from config data ──────────

describe("sc-4-4 — example team as data (loadTeam)", () => {
  it("loadTeam(config, 'example') returns declared memoryNamespace", async () => {
    const { loadTeam } = await import("../../teams/registry.js");
    const team = loadTeam(minimalConfig as never, "example");
    expect(team.memoryNamespace).toBe("example");
  });

  it("loadTeam(config, 'example') returns declared pipelineShape", async () => {
    const { loadTeam } = await import("../../teams/registry.js");
    const team = loadTeam(minimalConfig as never, "example");
    expect(team.pipelineShape).toBe("ts");
  });

  it("loadTeam(config, 'example') merges declared provider override over defaults", async () => {
    const { loadTeam } = await import("../../teams/registry.js");
    const team = loadTeam(minimalConfig as never, "example");
    expect(team.providers.chat).toBe("openai");
  });

  it("loadTeam(config, undefined) returns programming team with empty memoryNamespace sentinel", async () => {
    const { loadTeam } = await import("../../teams/registry.js");
    const team = loadTeam(minimalConfig as never, undefined);
    expect(team.id).toBe("programming");
    expect(team.memoryNamespace).toBe("");
  });

  it("loadTeam(config, 'unknown') throws a descriptive error", async () => {
    const { loadTeam } = await import("../../teams/registry.js");
    expect(() => loadTeam(minimalConfig as never, "unknown")).toThrow(
      "Unknown team 'unknown'",
    );
  });
});

// ── sc-4-5: --team threads teamId to runPipeline ─────────────────────

describe("sc-4-5 — --team flag propagation through runRunCommand", () => {
  it("with team:'example' passes teamId:'example' to runPipeline", async () => {
    const { runPipeline } = await import("../../orchestrator/pipeline.js");
    const { runRunCommand } = await import("./run.js");

    await runRunCommand("do something", tmpDir, { team: "example" });

    expect(runPipeline).toHaveBeenCalledWith(
      "do something",
      tmpDir,
      expect.anything(),
      expect.objectContaining({ teamId: "example" }),
    );
  });

  it("without --team passes teamId:undefined to runPipeline (programming default)", async () => {
    const { runPipeline } = await import("../../orchestrator/pipeline.js");
    const { runRunCommand } = await import("./run.js");

    await runRunCommand("do something", tmpDir, {});

    const lastCall = (runPipeline as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const opts = lastCall![3] as { teamId?: string };
    expect(opts.teamId).toBeUndefined();
  });

  it("with runId and team passes both to runPipeline", async () => {
    const { runPipeline } = await import("../../orchestrator/pipeline.js");
    const { runRunCommand } = await import("./run.js");

    await runRunCommand("do something", tmpDir, {
      team: "example",
      runId: "run-fixed-001",
    });

    expect(runPipeline).toHaveBeenCalledWith(
      "do something",
      tmpDir,
      expect.anything(),
      expect.objectContaining({ teamId: "example", runId: "run-fixed-001" }),
    );
  });
});
