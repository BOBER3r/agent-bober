import { describe, it, expect, vi } from "vitest";

// Silence logger output (resolveRoleProviders logs info lines per call).
vi.mock("../utils/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

import { loadTeam } from "../teams/registry.js";
import { buildMedicalTeam } from "./team.js";
import { resolveRoleProviders } from "../config/role-providers.js";
import { resolveEngineName } from "../orchestrator/workflow/selector.js";
import { createDefaultConfig, TeamConfigSchema, BoberConfigSchema } from "../config/schema.js";
import type { GuardrailSet } from "./types.js";

// ── sc-1-6: loadTeam('medical') fields ─────────────────────────────

describe("loadTeam('medical') — built-in medical team (sc-1-6)", () => {
  it("returns id 'medical'", () => {
    const config = createDefaultConfig("test", "greenfield");
    const team = loadTeam(config, "medical");
    expect(team.id).toBe("medical");
  });

  it("returns pipelineShape === 'medical-sop'", () => {
    const config = createDefaultConfig("test", "greenfield");
    const team = loadTeam(config, "medical");
    expect(team.pipelineShape).toBe("medical-sop");
  });

  it("returns a non-undefined guardrails object (sc-1-6)", () => {
    const config = createDefaultConfig("test", "greenfield");
    const team = loadTeam(config, "medical");
    expect(team.guardrails).not.toBeUndefined();
  });

  it("guardrails object exposes rulesetVersion (string) and evaluate (function)", () => {
    const config = createDefaultConfig("test", "greenfield");
    const team = loadTeam(config, "medical");
    const guardrails = team.guardrails as GuardrailSet;
    expect(typeof guardrails.rulesetVersion).toBe("string");
    expect(typeof guardrails.evaluate).toBe("function");
  });

  it("guardrails.evaluate returns { kind: 'allow' } for a benign prompt", () => {
    const config = createDefaultConfig("test", "greenfield");
    const team = loadTeam(config, "medical");
    const guardrails = team.guardrails as GuardrailSet;
    const verdict = guardrails.evaluate("what is blood pressure?", {});
    expect(verdict.kind).toBe("allow");
  });

  it("has memoryNamespace 'medical'", () => {
    const config = createDefaultConfig("test", "greenfield");
    const team = loadTeam(config, "medical");
    expect(team.memoryNamespace).toBe("medical");
  });

  it("has displayName 'Medical team'", () => {
    const config = createDefaultConfig("test", "greenfield");
    const team = loadTeam(config, "medical");
    expect(team.displayName).toBe("Medical team");
  });

  it("has 7 role descriptors", () => {
    const config = createDefaultConfig("test", "greenfield");
    const team = loadTeam(config, "medical");
    expect(team.roles).toHaveLength(7);
  });

  it("includes resolved providers from resolveRoleProviders (same as programming team)", () => {
    const config = createDefaultConfig("test", "greenfield");
    const team = loadTeam(config, "medical");
    vi.clearAllMocks();
    expect(team.providers).toEqual(resolveRoleProviders(config));
  });
});

// ── sc-1-7: regression — programming team unchanged ─────────────────

describe("loadTeam() regression — programming team byte-identical (sc-1-7)", () => {
  it("no-id call still returns the programming team", () => {
    const config = createDefaultConfig("test", "greenfield");
    const team = loadTeam(config);
    expect(team.id).toBe("programming");
  });

  it("programming team providers deep-equal resolveRoleProviders(config)", () => {
    const config = createDefaultConfig("test", "greenfield");
    const team = loadTeam(config);
    vi.clearAllMocks();
    expect(team.providers).toEqual(resolveRoleProviders(config));
  });

  it("programming team pipelineShape === resolveEngineName(config)", () => {
    const config = createDefaultConfig("test", "greenfield");
    const team = loadTeam(config);
    vi.clearAllMocks();
    expect(team.pipelineShape).toBe(resolveEngineName(config));
  });

  it("programming team memoryNamespace is ''", () => {
    const config = createDefaultConfig("test", "greenfield");
    const team = loadTeam(config);
    expect(team.memoryNamespace).toBe("");
  });
});

// ── sc-1-4: Zod enum widening verification ──────────────────────────

describe("TeamConfigSchema / BoberConfigSchema — 'medical-sop' pipelineShape (sc-1-4)", () => {
  it("TeamConfigSchema accepts pipelineShape 'medical-sop'", () => {
    const result = TeamConfigSchema.safeParse({ pipelineShape: "medical-sop" });
    expect(result.success).toBe(true);
  });

  it("TeamConfigSchema rejects pipelineShape 'bogus'", () => {
    const result = TeamConfigSchema.safeParse({ pipelineShape: "bogus" });
    expect(result.success).toBe(false);
  });

  it("PipelineSectionSchema accepts engine 'medical-sop' (second Zod enum widened)", () => {
    const result = BoberConfigSchema.safeParse({
      project: { name: "t", mode: "greenfield" },
      planner: {},
      generator: {},
      evaluator: { strategies: [] },
      sprint: {},
      pipeline: { engine: "medical-sop" },
      commands: {},
    });
    expect(result.success).toBe(true);
  });

  it("buildMedicalTeam returns pipelineShape 'medical-sop'", () => {
    const config = createDefaultConfig("test", "greenfield");
    const team = buildMedicalTeam(config);
    expect(team.pipelineShape).toBe("medical-sop");
  });
});
