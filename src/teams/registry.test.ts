import { describe, it, expect, vi } from "vitest";
import { loadTeam } from "./registry.js";
import { resolveRoleProviders } from "../config/role-providers.js";
import { resolveEngineName } from "../orchestrator/workflow/selector.js";
import { createDefaultConfig, BoberConfigSchema, TeamConfigSchema } from "../config/schema.js";
import type { BoberConfig } from "../config/schema.js";

// Silence logger output during tests (resolveRoleProviders logs 7 lines per call).
vi.mock("../utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── sc-1-4: programming team (default) ──────────────────────────────

describe("loadTeam — programming team (sc-1-4)", () => {
  it("returns id 'programming' with resolved providers/engine and '' memoryNamespace (no teamId)", () => {
    const config = createDefaultConfig("test", "greenfield");
    const team = loadTeam(config);
    expect(team.id).toBe("programming");
    expect(team.providers).toEqual(resolveRoleProviders(config));
    expect(team.pipelineShape).toBe(resolveEngineName(config));
    expect(team.memoryNamespace).toBe("");
  });

  it("returns the same team when teamId is explicitly 'programming'", () => {
    const config = createDefaultConfig("test", "greenfield");
    const team = loadTeam(config, "programming");
    expect(team.id).toBe("programming");
    expect(team.memoryNamespace).toBe("");
    expect(team.providers).toEqual(resolveRoleProviders(config));
    expect(team.pipelineShape).toBe(resolveEngineName(config));
  });

  it("includes all 7 role descriptors", () => {
    const config = createDefaultConfig("test", "greenfield");
    const team = loadTeam(config);
    expect(team.roles).toHaveLength(7);
    const names = team.roles.map((r) => r.name);
    expect(names).toContain("planner");
    expect(names).toContain("researcher");
    expect(names).toContain("chat");
    expect(names).toContain("curator");
    expect(names).toContain("generator");
    expect(names).toContain("evaluator");
    expect(names).toContain("codeReview");
  });
});

// ── sc-1-5: schema parses with and without teams/defaultTeam ─────────

describe("BoberConfigSchema / TeamConfigSchema (sc-1-5)", () => {
  it("parses a config with teams + defaultTeam (sc-1-5)", () => {
    const result = BoberConfigSchema.safeParse({
      project: { name: "t", mode: "greenfield" },
      planner: {},
      generator: {},
      evaluator: { strategies: [] },
      sprint: {},
      pipeline: {},
      commands: {},
      teams: {
        docs: {
          memoryNamespace: "docs",
          pipelineShape: "ts",
          providers: { generator: "deepseek" },
        },
      },
      defaultTeam: "programming",
    });
    expect(result.success).toBe(true);
  });

  it("parses a config WITHOUT teams/defaultTeam (back-compat)", () => {
    const result = BoberConfigSchema.safeParse({
      project: { name: "t", mode: "greenfield" },
      planner: {},
      generator: {},
      evaluator: { strategies: [] },
      sprint: {},
      pipeline: {},
      commands: {},
    });
    expect(result.success).toBe(true);
  });

  it("TeamConfigSchema accepts all-optional fields", () => {
    expect(TeamConfigSchema.safeParse({}).success).toBe(true);
    expect(
      TeamConfigSchema.safeParse({
        displayName: "Docs",
        memoryNamespace: "docs",
        pipelineShape: "ts",
        providers: { generator: "deepseek" },
        guardrails: { someRule: true },
      }).success,
    ).toBe(true);
  });

  it("TeamConfigSchema rejects memoryNamespace with path separators", () => {
    expect(
      TeamConfigSchema.safeParse({ memoryNamespace: "a/b" }).success,
    ).toBe(false);
    expect(
      TeamConfigSchema.safeParse({ memoryNamespace: "../escape" }).success,
    ).toBe(false);
  });

  it("createDefaultConfig emits no teams or defaultTeam fields (back-compat)", () => {
    const config = createDefaultConfig("test", "greenfield");
    expect(config.teams).toBeUndefined();
    expect(config.defaultTeam).toBeUndefined();
  });
});

// ── sc-1-6: declared team with partial provider override ──────────────

describe("loadTeam — declared team with override (sc-1-6)", () => {
  it("merges partial provider override over resolved defaults", () => {
    const base = createDefaultConfig("t", "greenfield");
    const config: BoberConfig = {
      ...base,
      teams: {
        docs: {
          memoryNamespace: "docs",
          providers: { generator: "deepseek" },
        },
      },
    };
    const team = loadTeam(config, "docs");
    // overridden role
    expect(team.providers.generator).toBe("deepseek");
    // unspecified roles keep the resolved default
    expect(team.providers.planner).toBe(resolveRoleProviders(base).planner);
    expect(team.providers.evaluator).toBe(resolveRoleProviders(base).evaluator);
    // memoryNamespace from entry
    expect(team.memoryNamespace).toBe("docs");
  });

  it("defaults memoryNamespace to teamId when entry omits it", () => {
    const base = createDefaultConfig("t", "greenfield");
    const config: BoberConfig = {
      ...base,
      teams: { myteam: { displayName: "My Team" } },
    };
    const team = loadTeam(config, "myteam");
    expect(team.memoryNamespace).toBe("myteam");
    expect(team.displayName).toBe("My Team");
  });

  it("defaults pipelineShape to resolveEngineName when entry omits it", () => {
    const base = createDefaultConfig("t", "greenfield");
    const config: BoberConfig = {
      ...base,
      teams: { myteam: {} },
    };
    const team = loadTeam(config, "myteam");
    expect(team.pipelineShape).toBe(resolveEngineName(base));
  });
});

// ── sc-1-7: unknown team id throws ───────────────────────────────────

describe("loadTeam — unknown team id (sc-1-7)", () => {
  it("throws an Error whose message names the missing team id", () => {
    const config = createDefaultConfig("test", "greenfield");
    expect(() => loadTeam(config, "nope")).toThrow(/nope/);
  });

  it("error message also references config.teams", () => {
    const config = createDefaultConfig("test", "greenfield");
    expect(() => loadTeam(config, "my-missing-team")).toThrow(/my-missing-team/);
  });
});
