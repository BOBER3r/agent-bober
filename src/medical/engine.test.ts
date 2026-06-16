import { describe, it, expect, vi, beforeEach } from "vitest";

// Silence logger output (resolveRoleProviders logs info lines on team load).
vi.mock("../utils/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

// Mock eligibility so tests are deterministic.
vi.mock("../orchestrator/workflow/eligibility.js", () => ({
  isWorkflowEligible: vi.fn(() => false),
}));

import { MedicalSopEngine } from "./engine.js";
import { selectPipelineEngineForTeam, selectPipelineEngine } from "../orchestrator/workflow/selector.js";
import { buildMedicalTeam } from "./team.js";
import { createDefaultConfig } from "../config/schema.js";
import { TsPipelineEngine } from "../orchestrator/workflow/ts-engine.js";
import type { PipelineResult } from "../orchestrator/pipeline.js";

// ── sc-1-4: MedicalSopEngine.name ──────────────────────────────────

describe("MedicalSopEngine — name and interface (sc-1-4, sc-1-5)", () => {
  it("has name === 'medical-sop'", () => {
    const engine = new MedicalSopEngine();
    expect(engine.name).toBe("medical-sop");
  });

  it("satisfies the PipelineEngine interface (has run method)", () => {
    const engine = new MedicalSopEngine();
    expect(typeof engine.run).toBe("function");
  });
});

// ── sc-1-5: selectPipelineEngineForTeam returns MedicalSopEngine ────

describe("selectPipelineEngineForTeam — medical team (sc-1-5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a MedicalSopEngine instance for the built-in medical team", () => {
    const config = createDefaultConfig("test", "greenfield");
    const team = buildMedicalTeam(config);
    vi.clearAllMocks();

    const engine = selectPipelineEngineForTeam(team, config);
    expect(engine).toBeInstanceOf(MedicalSopEngine);
    expect(engine.name).toBe("medical-sop");
  });

  it("selectPipelineEngine for engine 'ts' still returns TsPipelineEngine (regression, sc-1-7)", () => {
    const config = createDefaultConfig("test", "greenfield");
    vi.clearAllMocks();

    const engine = selectPipelineEngine(config);
    expect(engine).toBeInstanceOf(TsPipelineEngine);
    expect(engine.name).toBe("ts");
  });
});

// ── stub run() resolves to a valid PipelineResult ──────────────────

describe("MedicalSopEngine.run — stub result shape", () => {
  it("resolves to a PipelineResult with success=true and required fields", async () => {
    const engine = new MedicalSopEngine();
    const config = createDefaultConfig("test", "greenfield");
    vi.clearAllMocks();

    const result: PipelineResult = await engine.run("test prompt", "/tmp", config);

    expect(result.success).toBe(true);
    expect(result.spec).toBeDefined();
    expect(result.spec.title).toBeTruthy();
    expect(Array.isArray(result.completedSprints)).toBe(true);
    expect(Array.isArray(result.failedSprints)).toBe(true);
    expect(typeof result.duration).toBe("number");
  });
});
