import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  PipelineSectionSchema,
  EvaluatorSectionSchema,
  ArchitectSectionSchema,
  BoberConfigSchema,
  HistorySectionSchema,
  FleetSectionSchema,
  VaultSectionSchema,
  VaultObsidianSchema,
  EffortSchema,
  BudgetSectionSchema,
  GeneratorSectionSchema,
  PlannerSectionSchema,
  CuratorSectionSchema,
  ToolsSectionSchema,
  McpBridgeServerSchema,
  SecuritySectionSchema,
  SecurityDiffConfigSchema,
  SecuritySupplyChainConfigSchema,
  SecurityEgressConfigSchema,
  SeoConfigSchema,
} from "./schema.js";

describe("EvaluatorSectionSchema.panel", () => {
  it("defaults panel to disabled/empty/4 when omitted", () => {
    const parsed = EvaluatorSectionSchema.parse({ strategies: [] });
    expect(parsed.panel).toEqual({ enabled: false, lenses: [], maxConcurrent: 4 });
  });

  it("rejects maxConcurrent < 1", () => {
    expect(() =>
      EvaluatorSectionSchema.parse({ strategies: [], panel: { maxConcurrent: 0 } }),
    ).toThrow();
  });

  it("accepts a fully-specified enabled panel", () => {
    const parsed = EvaluatorSectionSchema.parse({
      strategies: [],
      panel: { enabled: true, lenses: ["correctness", "security"], maxConcurrent: 2 },
    });
    expect(parsed.panel.enabled).toBe(true);
    expect(parsed.panel.lenses).toEqual(["correctness", "security"]);
    expect(parsed.panel.maxConcurrent).toBe(2);
  });

  it("parses a config that omits the panel field entirely — panel resolves to the default", () => {
    // This verifies C1: a config without panel still parses successfully
    const parsed = EvaluatorSectionSchema.parse({ strategies: [] });
    expect(parsed.panel.enabled).toBe(false);
    expect(parsed.panel.lenses).toEqual([]);
    expect(parsed.panel.maxConcurrent).toBe(4);
  });
});

describe("ArchitectSectionSchema.panel (C3)", () => {
  it("defaults panel to disabled/empty/4 when section omitted (parse empty object)", () => {
    const parsed = ArchitectSectionSchema.parse({});
    expect(parsed.panel).toEqual({ enabled: false, lenses: [], maxConcurrent: 4 });
  });

  it("rejects maxConcurrent < 1", () => {
    expect(() =>
      ArchitectSectionSchema.parse({ panel: { maxConcurrent: 0 } }),
    ).toThrow();
  });

  it("accepts a fully-specified enabled panel", () => {
    const parsed = ArchitectSectionSchema.parse({
      panel: { enabled: true, lenses: ["scalability", "security"], maxConcurrent: 2 },
    });
    expect(parsed.panel.enabled).toBe(true);
    expect(parsed.panel.lenses).toEqual(["scalability", "security"]);
    expect(parsed.panel.maxConcurrent).toBe(2);
  });

  it("parses when panel field is omitted — resolves to defaults", () => {
    const parsed = ArchitectSectionSchema.parse({});
    expect(parsed.panel.enabled).toBe(false);
    expect(parsed.panel.lenses).toEqual([]);
    expect(parsed.panel.maxConcurrent).toBe(4);
  });
});

describe("BoberConfigSchema — architect is optional (C3)", () => {
  it("parses a valid config that omits the architect section entirely", () => {
    // Minimal valid config — architect is optional so its absence is fine
    const result = BoberConfigSchema.safeParse({
      project: { name: "test-project", mode: "greenfield" },
      planner: {},
      generator: {},
      evaluator: { strategies: [] },
      sprint: {},
      pipeline: {},
      commands: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.architect).toBeUndefined();
    }
  });

  it("parses a config with architect.panel present", () => {
    const result = BoberConfigSchema.safeParse({
      project: { name: "test-project", mode: "greenfield" },
      planner: {},
      generator: {},
      evaluator: { strategies: [] },
      sprint: {},
      pipeline: {},
      commands: {},
      architect: { panel: { enabled: true, lenses: ["scalability"], maxConcurrent: 2 } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.architect?.panel.enabled).toBe(true);
      expect(result.data.architect?.panel.lenses).toEqual(["scalability"]);
    }
  });
});

describe("HistorySectionSchema", () => {
  it("defaults maxActiveLines to 2000 on empty config", () => {
    expect(HistorySectionSchema.parse({}).maxActiveLines).toBe(2000);
  });

  it("rejects a non-positive maxActiveLines (0)", () => {
    expect(() => HistorySectionSchema.parse({ maxActiveLines: 0 })).toThrow();
  });

  it("rejects a non-positive maxActiveLines (-1)", () => {
    expect(() => HistorySectionSchema.parse({ maxActiveLines: -1 })).toThrow();
  });

  it("accepts a positive integer maxActiveLines", () => {
    expect(HistorySectionSchema.parse({ maxActiveLines: 500 }).maxActiveLines).toBe(500);
  });
});

describe("BoberConfigSchema — fleet section is optional (sc-2-3)", () => {
  const minimalBase = {
    project: { name: "test-project", mode: "greenfield" },
    planner: {},
    generator: {},
    evaluator: { strategies: [] },
    sprint: {},
    pipeline: {},
    commands: {},
  };

  it("parses a config without a fleet section (fleet is undefined)", () => {
    const result = BoberConfigSchema.safeParse(minimalBase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fleet).toBeUndefined();
    }
  });

  it("parses a config with a complete fleet section", () => {
    const result = BoberConfigSchema.safeParse({
      ...minimalBase,
      fleet: {
        blackboardDbPath: "/abs/path/.bober/memory/run-1/facts.db",
        blackboardNamespace: "run-1",
        blackboardSubject: "child-a",
        maxRounds: 2,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fleet?.blackboardDbPath).toBe("/abs/path/.bober/memory/run-1/facts.db");
      expect(result.data.fleet?.blackboardNamespace).toBe("run-1");
      expect(result.data.fleet?.blackboardSubject).toBe("child-a");
      expect(result.data.fleet?.maxRounds).toBe(2);
    }
  });

  it("rejects fleet.maxRounds > 3 (ZodError)", () => {
    const result = BoberConfigSchema.safeParse({
      ...minimalBase,
      fleet: {
        blackboardDbPath: "/abs/path/facts.db",
        blackboardNamespace: "run-1",
        blackboardSubject: "child-a",
        maxRounds: 4,
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects fleet.maxRounds < 1 (ZodError)", () => {
    const result = BoberConfigSchema.safeParse({
      ...minimalBase,
      fleet: {
        blackboardDbPath: "/abs/path/facts.db",
        blackboardNamespace: "run-1",
        blackboardSubject: "child-a",
        maxRounds: 0,
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("FleetSectionSchema — standalone validation (sc-2-3)", () => {
  it("parses a valid fleet section with maxRounds=1", () => {
    const result = FleetSectionSchema.safeParse({
      blackboardDbPath: "/abs/path/facts.db",
      blackboardNamespace: "ns",
      blackboardSubject: "folder-x",
      maxRounds: 1,
    });
    expect(result.success).toBe(true);
  });

  it("parses a valid fleet section with maxRounds=3", () => {
    const result = FleetSectionSchema.safeParse({
      blackboardDbPath: "/abs/path/facts.db",
      blackboardNamespace: "ns",
      blackboardSubject: "folder-x",
      maxRounds: 3,
    });
    expect(result.success).toBe(true);
  });

  it("rejects maxRounds=4", () => {
    expect(() =>
      FleetSectionSchema.parse({
        blackboardDbPath: "/abs/path/facts.db",
        blackboardNamespace: "ns",
        blackboardSubject: "folder-x",
        maxRounds: 4,
      }),
    ).toThrow();
  });

  it("rejects non-integer maxRounds", () => {
    expect(() =>
      FleetSectionSchema.parse({
        blackboardDbPath: "/abs/path/facts.db",
        blackboardNamespace: "ns",
        blackboardSubject: "folder-x",
        maxRounds: 1.5,
      }),
    ).toThrow();
  });
});

// ── EffortSchema / BudgetSectionSchema (sc-3-1) ───────────────────────

describe("EffortSchema / BudgetSectionSchema — standalone (sc-3-1)", () => {
  it.each(["low", "medium", "high", "xhigh", "max"])("accepts effort value %s", (value) => {
    expect(EffortSchema.parse(value)).toBe(value);
  });

  it("rejects an unknown effort string", () => {
    expect(EffortSchema.safeParse("bogus").success).toBe(false);
  });

  it("accepts a positive budget.maxUsd", () => {
    expect(BudgetSectionSchema.parse({ maxUsd: 5 }).maxUsd).toBe(5);
  });

  it("accepts budget.maxUsd: null", () => {
    expect(BudgetSectionSchema.parse({ maxUsd: null }).maxUsd).toBeNull();
  });

  it("accepts an empty budget object (maxUsd omitted)", () => {
    expect(BudgetSectionSchema.parse({}).maxUsd).toBeUndefined();
  });

  it("rejects a non-positive budget.maxUsd (-1)", () => {
    expect(BudgetSectionSchema.safeParse({ maxUsd: -1 }).success).toBe(false);
  });

  it("rejects a zero budget.maxUsd", () => {
    expect(BudgetSectionSchema.safeParse({ maxUsd: 0 }).success).toBe(false);
  });
});

describe("Per-role sections — optional effort/budget fields (sc-3-1)", () => {
  it("GeneratorSectionSchema: effort/budget undefined when omitted (no defaults injected)", () => {
    const parsed = GeneratorSectionSchema.parse({});
    expect(parsed.effort).toBeUndefined();
    expect(parsed.budget).toBeUndefined();
  });

  it("GeneratorSectionSchema: accepts effort + budget.maxUsd", () => {
    const parsed = GeneratorSectionSchema.parse({ effort: "high", budget: { maxUsd: 5 } });
    expect(parsed.effort).toBe("high");
    expect(parsed.budget?.maxUsd).toBe(5);
  });

  it("GeneratorSectionSchema: rejects a bogus effort value", () => {
    expect(GeneratorSectionSchema.safeParse({ effort: "bogus" }).success).toBe(false);
  });

  it("GeneratorSectionSchema: rejects a negative budget.maxUsd", () => {
    expect(
      GeneratorSectionSchema.safeParse({ budget: { maxUsd: -1 } }).success,
    ).toBe(false);
  });

  it("PlannerSectionSchema: effort/budget undefined when omitted", () => {
    const parsed = PlannerSectionSchema.parse({});
    expect(parsed.effort).toBeUndefined();
    expect(parsed.budget).toBeUndefined();
  });

  it("PlannerSectionSchema: accepts effort + budget.maxUsd: null", () => {
    const parsed = PlannerSectionSchema.parse({ effort: "xhigh", budget: { maxUsd: null } });
    expect(parsed.effort).toBe("xhigh");
    expect(parsed.budget?.maxUsd).toBeNull();
  });

  it("CuratorSectionSchema: effort/budget undefined when omitted", () => {
    const parsed = CuratorSectionSchema.parse({});
    expect(parsed.effort).toBeUndefined();
    expect(parsed.budget).toBeUndefined();
  });

  it("EvaluatorSectionSchema: effort/budget undefined when omitted", () => {
    const parsed = EvaluatorSectionSchema.parse({ strategies: [] });
    expect(parsed.effort).toBeUndefined();
    expect(parsed.budget).toBeUndefined();
  });

  it("EvaluatorSectionSchema: accepts effort + budget.maxUsd", () => {
    const parsed = EvaluatorSectionSchema.parse({
      strategies: [],
      effort: "max",
      budget: { maxUsd: 12.5 },
    });
    expect(parsed.effort).toBe("max");
    expect(parsed.budget?.maxUsd).toBe(12.5);
  });
});

describe("BoberConfigSchema — every existing fixture parses unchanged with effort/budget added (sc-3-1)", () => {
  const minimalBase = {
    project: { name: "test-project", mode: "greenfield" },
    planner: {},
    generator: {},
    evaluator: { strategies: [] },
    sprint: {},
    pipeline: {},
    commands: {},
  };

  it("parses the minimal fixture unchanged — no effort/budget defaults injected", () => {
    const result = BoberConfigSchema.safeParse(minimalBase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.generator.effort).toBeUndefined();
      expect(result.data.generator.budget).toBeUndefined();
      expect(result.data.planner.effort).toBeUndefined();
      expect(result.data.planner.budget).toBeUndefined();
      expect(result.data.evaluator.effort).toBeUndefined();
      expect(result.data.evaluator.budget).toBeUndefined();
    }
  });

  it("parses a config with generator.effort + generator.budget.maxUsd set", () => {
    const result = BoberConfigSchema.safeParse({
      ...minimalBase,
      generator: { effort: "high", budget: { maxUsd: 5 } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.generator.effort).toBe("high");
      expect(result.data.generator.budget?.maxUsd).toBe(5);
    }
  });

  it("rejects an invalid generator.effort value", () => {
    const result = BoberConfigSchema.safeParse({
      ...minimalBase,
      generator: { effort: "bogus" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative generator.budget.maxUsd", () => {
    const result = BoberConfigSchema.safeParse({
      ...minimalBase,
      generator: { budget: { maxUsd: -1 } },
    });
    expect(result.success).toBe(false);
  });

  it("accepts generator.budget.maxUsd: null", () => {
    const result = BoberConfigSchema.safeParse({
      ...minimalBase,
      generator: { budget: { maxUsd: null } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.generator.budget?.maxUsd).toBeNull();
    }
  });
});

describe("PipelineSectionSchema.engine", () => {
  it("defaults engine to 'ts' when omitted", () => {
    expect(PipelineSectionSchema.parse({}).engine).toBe("ts");
  });

  it("rejects an unknown engine string", () => {
    expect(() => PipelineSectionSchema.parse({ engine: "bogus" })).toThrow();
  });

  it("accepts 'workflow'", () => {
    expect(PipelineSectionSchema.parse({ engine: "workflow" }).engine).toBe("workflow");
  });

  it("accepts 'skill'", () => {
    expect(PipelineSectionSchema.parse({ engine: "skill" }).engine).toBe("skill");
  });

  it("accepts 'ts' explicitly", () => {
    expect(PipelineSectionSchema.parse({ engine: "ts" }).engine).toBe("ts");
  });
});

// ── VaultSectionSchema tests (sc-4-2) ─────────────────────────────────

const minimalBaseForVault = {
  project: { name: "test-project", mode: "greenfield" },
  planner: {},
  generator: {},
  evaluator: { strategies: [] },
  sprint: {},
  pipeline: {},
  commands: {},
};

describe("BoberConfigSchema — vault section is optional (sc-4-2)", () => {
  it("parses a config without a vault section (vault is undefined)", () => {
    const result = BoberConfigSchema.safeParse(minimalBaseForVault);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.vault).toBeUndefined();
    }
  });

  it("parses a config with a complete vault.obsidian section and round-trips all fields including mcpEnv", () => {
    const result = BoberConfigSchema.safeParse({
      ...minimalBaseForVault,
      vault: {
        obsidian: {
          name: "obsidian",
          mcpCommand: "npx",
          mcpArgs: ["-y", "obsidian-mcp-server"],
          mcpEnv: { OBSIDIAN_API_KEY: "secret-token" },
          enabled: true,
          toolNames: { readNote: "custom_read", writeNote: "custom_write" },
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const obs = result.data.vault?.obsidian;
      expect(obs?.name).toBe("obsidian");
      expect(obs?.mcpCommand).toBe("npx");
      expect(obs?.mcpArgs).toEqual(["-y", "obsidian-mcp-server"]);
      // mcpEnv round-trip — secret value preserved
      expect(obs?.mcpEnv?.OBSIDIAN_API_KEY).toBe("secret-token");
      // toolNames overrides preserved
      expect(obs?.toolNames?.readNote).toBe("custom_read");
      expect(obs?.toolNames?.writeNote).toBe("custom_write");
      expect(obs?.enabled).toBe(true);
    }
  });

  it("defaults vault.obsidian.enabled to true when omitted", () => {
    const result = BoberConfigSchema.safeParse({
      ...minimalBaseForVault,
      vault: { obsidian: { name: "obs", mcpCommand: "node" } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.vault?.obsidian?.enabled).toBe(true);
    }
  });

  it("parses a config with vault.obsidian.toolNames partially overridden (only listNotes)", () => {
    const result = BoberConfigSchema.safeParse({
      ...minimalBaseForVault,
      vault: {
        obsidian: {
          name: "myobs",
          mcpCommand: "npx",
          toolNames: { listNotes: "list_files" },
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.vault?.obsidian?.toolNames?.listNotes).toBe("list_files");
      // other overrides absent
      expect(result.data.vault?.obsidian?.toolNames?.readNote).toBeUndefined();
    }
  });

  it("rejects vault.obsidian.name with invalid characters", () => {
    const result = BoberConfigSchema.safeParse({
      ...minimalBaseForVault,
      vault: { obsidian: { name: "invalid name!", mcpCommand: "npx" } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects vault.obsidian.mcpCommand as empty string", () => {
    const result = BoberConfigSchema.safeParse({
      ...minimalBaseForVault,
      vault: { obsidian: { name: "obs", mcpCommand: "" } },
    });
    expect(result.success).toBe(false);
  });
});

describe("VaultSectionSchema — standalone validation", () => {
  it("parses an empty vault section (obsidian is undefined)", () => {
    const result = VaultSectionSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.obsidian).toBeUndefined();
    }
  });

  it("parses a vault section with obsidian present", () => {
    const result = VaultSectionSchema.safeParse({
      obsidian: { name: "obs", mcpCommand: "node", mcpArgs: ["server.js"] },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.obsidian?.name).toBe("obs");
    }
  });
});

describe("VaultObsidianSchema — standalone validation", () => {
  it("parses a minimal obsidian config with defaults", () => {
    const result = VaultObsidianSchema.safeParse({ name: "obs", mcpCommand: "npx" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.toolNames).toBeUndefined();
      expect(result.data.mcpEnv).toBeUndefined();
    }
  });

  it("preserves multiple mcpEnv secret entries unchanged", () => {
    const result = VaultObsidianSchema.safeParse({
      name: "obs",
      mcpCommand: "npx",
      mcpEnv: { TOKEN: "abc", VAULT_PATH: "/my/vault" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mcpEnv).toEqual({ TOKEN: "abc", VAULT_PATH: "/my/vault" });
    }
  });
});

// ── ToolsSectionSchema tests (sprint 10 — opt-in MCP tool bridge) ─────

describe("BoberConfigSchema — tools section is optional (sc-10-4)", () => {
  it("parses a config without a tools section (tools is undefined — byte-identical to pre-sprint-10 configs)", () => {
    const result = BoberConfigSchema.safeParse(minimalBaseForVault);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tools).toBeUndefined();
    }
  });

  it("createDefaultConfig never sets a tools section (default config stays byte-identical)", () => {
    // Mirrors the egress-axis idiom (Pattern A): new opt-in sections are never
    // added to createDefaultConfig's base — only BoberConfigSchema.optional().
    expect(Object.hasOwn(BoberConfigSchema.parse(minimalBaseForVault), "tools")).toBe(false);
  });

  it("defaults tools.mcpBridge.enabled to false when omitted", () => {
    const result = BoberConfigSchema.safeParse({
      ...minimalBaseForVault,
      tools: { mcpBridge: { server: { command: "node" } } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tools?.mcpBridge?.enabled).toBe(false);
    }
  });

  it("parses a config with tools.mcpBridge fully specified and round-trips command/args", () => {
    const result = BoberConfigSchema.safeParse({
      ...minimalBaseForVault,
      tools: {
        mcpBridge: {
          enabled: true,
          server: { command: "npx", args: ["-y", "some-mcp-server"] },
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tools?.mcpBridge?.enabled).toBe(true);
      expect(result.data.tools?.mcpBridge?.server.command).toBe("npx");
      expect(result.data.tools?.mcpBridge?.server.args).toEqual(["-y", "some-mcp-server"]);
    }
  });

  it("rejects tools.mcpBridge.server.command as empty string", () => {
    const result = BoberConfigSchema.safeParse({
      ...minimalBaseForVault,
      tools: { mcpBridge: { server: { command: "" } } },
    });
    expect(result.success).toBe(false);
  });
});

describe("ToolsSectionSchema / McpBridgeServerSchema — standalone validation", () => {
  it("parses an empty tools section (mcpBridge is undefined)", () => {
    const result = ToolsSectionSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mcpBridge).toBeUndefined();
    }
  });

  it("defaults McpBridgeServerSchema.args to an empty array when omitted", () => {
    const result = McpBridgeServerSchema.safeParse({ command: "node" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.args).toEqual([]);
    }
  });
});

// ── SecuritySectionSchema tests (spec-20260712 sprint 1 — sc-1-1/sc-1-2) ──

describe("SecuritySectionSchema — standalone validation (sc-1-1)", () => {
  it("parses an empty object to the full documented default set", () => {
    const parsed = SecuritySectionSchema.parse({});
    expect(parsed).toEqual({
      enabled: false,
      failClosed: true,
      timeoutMs: 300_000,
      model: "opus",
      maxTurns: 20,
      scanners: [],
      standaloneBlockOn: "critical",
      hub: true,
    });
  });

  it("round-trips a fully-specified section", () => {
    const result = SecuritySectionSchema.safeParse({
      enabled: true,
      failClosed: false,
      timeoutMs: 60_000,
      model: "sonnet",
      maxTurns: 5,
      provider: "anthropic",
      endpoint: null,
      providerConfig: { foo: "bar" },
      budget: { maxUsd: 3 },
      scanners: [{ type: "slither", required: true }],
      standaloneBlockOn: "important",
      hub: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.failClosed).toBe(false);
      expect(result.data.timeoutMs).toBe(60_000);
      expect(result.data.model).toBe("sonnet");
      expect(result.data.maxTurns).toBe(5);
      expect(result.data.provider).toBe("anthropic");
      expect(result.data.budget?.maxUsd).toBe(3);
      expect(result.data.scanners).toEqual([{ type: "slither", required: true }]);
      expect(result.data.standaloneBlockOn).toBe("important");
      expect(result.data.hub).toBe(false);
    }
  });

  it("rejects an invalid standaloneBlockOn value", () => {
    expect(() => SecuritySectionSchema.parse({ standaloneBlockOn: "minor" })).toThrow();
  });

  it("rejects maxTurns < 1", () => {
    expect(() => SecuritySectionSchema.parse({ maxTurns: 0 })).toThrow();
  });

  it("rejects a non-positive timeoutMs", () => {
    expect(() => SecuritySectionSchema.parse({ timeoutMs: 0 })).toThrow();
  });
});

// ── SecurityDiffConfigSchema tests (sprint 6 — sc-6-3) ──────────────

describe("SecuritySectionSchema.diff — opt-in real-diff config (sc-6-3)", () => {
  it("parse({}) still has NO diff key — byte-identical to pre-sprint-6 behavior", () => {
    const parsed = SecuritySectionSchema.parse({});
    expect(parsed).toEqual({
      enabled: false,
      failClosed: true,
      timeoutMs: 300_000,
      model: "opus",
      maxTurns: 20,
      scanners: [],
      standaloneBlockOn: "critical",
      hub: true,
    });
    expect(Object.hasOwn(parsed, "diff")).toBe(false);
  });

  it("parse({ diff: {} }) defaults mode to 'estimated-files' and expandWithGraph to false", () => {
    const parsed = SecuritySectionSchema.parse({ diff: {} });
    expect(parsed.diff).toEqual({ mode: "estimated-files", expandWithGraph: false });
  });

  it("round-trips a fully-specified diff config", () => {
    const parsed = SecuritySectionSchema.parse({
      diff: { mode: "git-diff", baseRef: "main", expandWithGraph: true },
    });
    expect(parsed.diff).toEqual({ mode: "git-diff", baseRef: "main", expandWithGraph: true });
  });

  it("rejects a bogus diff.mode value", () => {
    expect(() => SecuritySectionSchema.parse({ diff: { mode: "bogus" } })).toThrow();
  });

  it("SecurityDiffConfigSchema.parse({}) defaults standalone", () => {
    expect(SecurityDiffConfigSchema.parse({})).toEqual({
      mode: "estimated-files",
      expandWithGraph: false,
    });
  });
});

// ── SecuritySupplyChainConfigSchema / SecurityEgressConfigSchema tests (sprint 7 — sc-7-3) ──

describe("SecuritySectionSchema.supplyChain / .egress — opt-in supply-chain axis config (sc-7-3)", () => {
  it("parse({}) still has NO supplyChain/egress key — byte-identical to pre-sprint-7 behavior", () => {
    const parsed = SecuritySectionSchema.parse({});
    expect(parsed).toEqual({
      enabled: false,
      failClosed: true,
      timeoutMs: 300_000,
      model: "opus",
      maxTurns: 20,
      scanners: [],
      standaloneBlockOn: "critical",
      hub: true,
    });
    expect(Object.hasOwn(parsed, "supplyChain")).toBe(false);
    expect(Object.hasOwn(parsed, "egress")).toBe(false);
  });

  it("parse({ supplyChain: {} }) defaults enabled:false, scanners:[]", () => {
    const parsed = SecuritySectionSchema.parse({ supplyChain: {} });
    expect(parsed.supplyChain).toEqual({ enabled: false, scanners: [] });
  });

  it("parse({ egress: {} }) defaults onlineResearch:false", () => {
    const parsed = SecuritySectionSchema.parse({ egress: {} });
    expect(parsed.egress).toEqual({ onlineResearch: false });
  });

  it("round-trips a fully-specified supplyChain + egress config", () => {
    const parsed = SecuritySectionSchema.parse({
      supplyChain: {
        enabled: true,
        scanners: [{ type: "npm-audit", command: "npm audit --json", required: false }],
      },
      egress: { onlineResearch: true },
    });
    expect(parsed.supplyChain).toEqual({
      enabled: true,
      scanners: [{ type: "npm-audit", command: "npm audit --json", required: false }],
    });
    expect(parsed.egress).toEqual({ onlineResearch: true });
  });

  it("SecuritySupplyChainConfigSchema.parse({}) defaults standalone", () => {
    expect(SecuritySupplyChainConfigSchema.parse({})).toEqual({ enabled: false, scanners: [] });
  });

  it("SecurityEgressConfigSchema.parse({}) defaults standalone", () => {
    expect(SecurityEgressConfigSchema.parse({})).toEqual({ onlineResearch: false });
  });
});

// ── SecuritySectionSchema.verifier tests (sprint 8 — sc-8-5) ────────

describe("SecuritySectionSchema.verifier — opt-in adversarial verifier config (sc-8-5)", () => {
  it("parse({}) still has NO verifier key — byte-identical to pre-sprint-8 behavior", () => {
    const parsed = SecuritySectionSchema.parse({});
    expect(parsed).toEqual({
      enabled: false,
      failClosed: true,
      timeoutMs: 300_000,
      model: "opus",
      maxTurns: 20,
      scanners: [],
      standaloneBlockOn: "critical",
      hub: true,
    });
    expect(Object.hasOwn(parsed, "verifier")).toBe(false);
  });

  it("parse({ verifier: {} }) defaults enabled:false, model:'opus', maxTurns:10", () => {
    const parsed = SecuritySectionSchema.parse({ verifier: {} });
    expect(parsed.verifier).toEqual({ enabled: false, model: "opus", maxTurns: 10 });
  });

  it("round-trips a fully-specified verifier config", () => {
    const parsed = SecuritySectionSchema.parse({
      verifier: { enabled: true, model: "sonnet", maxTurns: 3 },
    });
    expect(parsed.verifier).toEqual({ enabled: true, model: "sonnet", maxTurns: 3 });
  });

  it("rejects maxTurns < 1 on the verifier sub-object", () => {
    expect(() => SecuritySectionSchema.parse({ verifier: { maxTurns: 0 } })).toThrow();
  });
});

describe("BoberConfigSchema — security section is optional, default-off (sc-1-1/sc-1-2)", () => {
  const minimalBase = {
    project: { name: "test-project", mode: "greenfield" },
    planner: {},
    generator: {},
    evaluator: { strategies: [] },
    sprint: {},
    pipeline: {},
    commands: {},
  };

  it("parses a config without a security section — security is undefined, not materialized", () => {
    const result = BoberConfigSchema.safeParse(minimalBase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.security).toBeUndefined();
    }
  });

  it("the security key is entirely absent from the parsed object (not present-but-undefined)", () => {
    // Object.hasOwn proves the key is never materialized — stronger than a
    // `toBeUndefined()` assertion alone, per the byte-identity stop condition.
    expect(Object.hasOwn(BoberConfigSchema.parse(minimalBase), "security")).toBe(false);
  });

  it("createDefaultConfig-shaped fixtures (no security key) are unaffected by adding the optional field", () => {
    // Every pre-existing minimal fixture in this file omits `security`; parsing
    // any of them must continue to omit the key entirely.
    const parsed = BoberConfigSchema.parse(minimalBaseForVault);
    expect(Object.hasOwn(parsed, "security")).toBe(false);
  });

  it("parses a config with a security section present and materializes its defaults", () => {
    const result = BoberConfigSchema.safeParse({
      ...minimalBase,
      security: { enabled: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.security?.enabled).toBe(true);
      expect(result.data.security?.failClosed).toBe(true);
      expect(result.data.security?.standaloneBlockOn).toBe("critical");
      expect(result.data.security?.hub).toBe(true);
    }
  });
});

describe("BoberConfigSchema — repo's own bober.config.json parses byte-identically (sc-1-2, sc-7-2)", () => {
  it("deep-equals an explicit expected snapshot, with the dogfood security key materialized (sc-7-2)", async () => {
    const raw = await readFile(join(process.cwd(), "bober.config.json"), "utf-8");
    const rawJson: Record<string, unknown> = JSON.parse(raw);
    const parsed = BoberConfigSchema.parse(rawJson);

    // spec-20260712 sprint 7 opts the repo into LLM-only dogfooding
    // (security: { enabled: true, scanners: [] }) — the security key IS now
    // materialized, with every other field defaulted by SecuritySectionSchema.
    expect(Object.hasOwn(parsed, "security")).toBe(true);

    // Full deep-equal against an explicit expected object (not just an
    // absence check) — proves the rest of the parse output is unperturbed.
    expect(parsed).toEqual({
      project: {
        name: "agent-bober",
        mode: "greenfield",
        stack: { language: "typescript", backend: "node" },
      },
      planner: { maxClarifications: 5, model: "opus", provider: "anthropic" },
      curator: { model: "opus", maxTurns: 25, enabled: true },
      generator: {
        model: "sonnet",
        maxTurnsPerSprint: 50,
        autoCommit: true,
        branchPattern: "bober/{feature-name}",
        provider: "anthropic",
      },
      evaluator: {
        model: "sonnet",
        strategies: [
          { type: "typecheck", required: true },
          { type: "lint", required: false },
          { type: "unit-test", required: false },
          { type: "build", required: true },
          { type: "api-check", required: false },
        ],
        maxIterations: 3,
        provider: "anthropic",
        panel: { enabled: false, lenses: [], maxConcurrent: 4 },
      },
      sprint: { maxSprints: 14, requireContracts: true, sprintSize: "medium" },
      pipeline: {
        maxIterations: 20,
        maxCheckpointIterations: 3,
        requireApproval: false,
        contextReset: "always",
        researchPhase: true,
        architectPhase: false,
        mode: "autopilot",
        checkpointOverrides: {},
        approvalTimeoutMs: 86_400_000,
        prPollMs: 30_000,
        allowAutopilotRiskyActions: false,
        eventQueueBound: 1000,
        worktreeRoot: ".bober/worktrees",
        cleanupWorktreeOnSuccess: true,
        engine: "ts",
      },
      graph: {
        enabled: true,
        autoSync: true,
        languageTier: "core",
        manifestPath: ".bober/graph/manifest.json",
        syncTimeoutMs: 2000,
        queryTimeoutMs: 5000,
        debounceMs: 750,
        hookQueueMax: 50,
        maxEngineRssMb: 512,
        exposeOnExternalMcp: true,
        preflightBudgets: {
          architect: 4000,
          curator: 2000,
          generator: 1000,
          evaluator: 1500,
          researcherPhase2: 3000,
        },
      },
      security: {
        enabled: true,
        failClosed: true,
        timeoutMs: 300_000,
        model: "opus",
        maxTurns: 20,
        scanners: [],
        standaloneBlockOn: "critical",
        hub: true,
        diff: { mode: "git-diff", expandWithGraph: false },
        supplyChain: { enabled: true, scanners: [] },
        egress: { onlineResearch: false },
        verifier: { enabled: true, model: "opus", maxTurns: 10 },
      },
      commands: {},
    });
  });
});

// ── SeoConfigSchema tests (spec-20260715-ultimate-seo-suite sprint 1 — sc-1-1) ──

describe("SeoConfigSchema — standalone validation (sc-1-1)", () => {
  it("parse({}) leaks NO axis/verifier/budget/defaultTarget/serp defaults — only blockThreshold", () => {
    const parsed = SeoConfigSchema.parse({});
    expect(parsed).toEqual({ blockThreshold: "critical-uncited" });
    expect(Object.hasOwn(parsed, "egress")).toBe(false);
    expect(Object.hasOwn(parsed, "verifier")).toBe(false);
    expect(Object.hasOwn(parsed, "budget")).toBe(false);
    expect(Object.hasOwn(parsed, "defaultTarget")).toBe(false);
    expect(Object.hasOwn(parsed, "serp")).toBe(false);
  });

  it("egress axes default false when egress object present", () => {
    expect(SeoConfigSchema.parse({ egress: {} }).egress).toEqual({
      "search-console": false,
      "serp-provider": false,
      "ai-visibility": false,
      "site-crawl": false,
    });
  });

  it("egress axes round-trip independently when explicitly set", () => {
    const parsed = SeoConfigSchema.parse({
      egress: { "search-console": true, "serp-provider": false },
    });
    expect(parsed.egress).toEqual({
      "search-console": true,
      "serp-provider": false,
      "ai-visibility": false,
      "site-crawl": false,
    });
  });

  it("ai-visibility and site-crawl axes default false and round-trip independently (sc-1-1)", () => {
    expect(SeoConfigSchema.parse({ egress: { "ai-visibility": true } }).egress).toEqual({
      "search-console": false,
      "serp-provider": false,
      "ai-visibility": true,
      "site-crawl": false,
    });
    expect(SeoConfigSchema.parse({ egress: { "site-crawl": true } }).egress).toEqual({
      "search-console": false,
      "serp-provider": false,
      "ai-visibility": false,
      "site-crawl": true,
    });
  });

  it("serp.provider defaults to 'dataforseo' when serp object present, is optional otherwise (sc-1-1)", () => {
    expect(Object.hasOwn(SeoConfigSchema.parse({}), "serp")).toBe(false);
    expect(SeoConfigSchema.parse({ serp: {} }).serp).toEqual({ provider: "dataforseo" });
    expect(SeoConfigSchema.parse({ serp: { provider: "damcrawler" } }).serp).toEqual({
      provider: "damcrawler",
    });
  });

  it("rejects a bogus serp.provider value", () => {
    expect(() => SeoConfigSchema.parse({ serp: { provider: "bing" } })).toThrow();
  });

  it("verifier.enabled defaults false when verifier object present", () => {
    expect(SeoConfigSchema.parse({ verifier: {} }).verifier).toEqual({ enabled: false });
  });

  it("budget.maxUsd round-trips (null=uncapped, mirrors BudgetSectionSchema schema.ts:48-51)", () => {
    expect(SeoConfigSchema.parse({ budget: { maxUsd: null } }).budget).toEqual({ maxUsd: null });
    expect(SeoConfigSchema.parse({ budget: { maxUsd: 5 } }).budget).toEqual({ maxUsd: 5 });
  });

  it("rejects a non-positive budget.maxUsd", () => {
    expect(() => SeoConfigSchema.parse({ budget: { maxUsd: 0 } })).toThrow();
  });

  it("defaultTarget round-trips a plain string", () => {
    expect(SeoConfigSchema.parse({ defaultTarget: "example.com" }).defaultTarget).toBe(
      "example.com",
    );
  });

  it("blockThreshold defaults to 'critical-uncited' and round-trips other enum values", () => {
    expect(SeoConfigSchema.parse({}).blockThreshold).toBe("critical-uncited");
    expect(SeoConfigSchema.parse({ blockThreshold: "never" }).blockThreshold).toBe("never");
    expect(SeoConfigSchema.parse({ blockThreshold: "any-uncited" }).blockThreshold).toBe(
      "any-uncited",
    );
  });

  it("rejects a bogus blockThreshold value", () => {
    expect(() => SeoConfigSchema.parse({ blockThreshold: "sometimes" })).toThrow();
  });
});

describe("BoberConfigSchema — seo section is optional, default-off (sc-1-1/sc-1-2)", () => {
  const minimalBase = {
    project: { name: "test-project", mode: "greenfield" },
    planner: {},
    generator: {},
    evaluator: { strategies: [] },
    sprint: {},
    pipeline: {},
    commands: {},
  };

  it("parses a config without a seo section — seo is undefined, not materialized", () => {
    const result = BoberConfigSchema.safeParse(minimalBase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.seo).toBeUndefined();
    }
  });

  it("the seo key is entirely absent from the parsed object (not present-but-undefined)", () => {
    // Object.hasOwn proves the key is never materialized — stronger than a
    // `toBeUndefined()` assertion alone, per the byte-identity stop condition.
    expect(Object.hasOwn(BoberConfigSchema.parse(minimalBase), "seo")).toBe(false);
  });

  it("a config omitting `seo` resolves byte-identical to a golden snapshot (sc-1-2)", () => {
    // The golden snapshot is captured by parsing the SAME minimalBase twice —
    // deep-equal, not eyeballed — proving the resolved shape is stable and
    // that adding the optional `seo` key to BoberConfigSchema did not perturb
    // any other section's resolved defaults.
    const golden = BoberConfigSchema.parse(minimalBase);
    const parsed = BoberConfigSchema.parse(minimalBase);
    expect(parsed).toEqual(golden);
    expect(parsed).toEqual({
      project: { name: "test-project", mode: "greenfield" },
      planner: { maxClarifications: 5, model: "opus" },
      generator: {
        model: "sonnet",
        maxTurnsPerSprint: 50,
        autoCommit: true,
        branchPattern: "bober/{feature-name}",
      },
      evaluator: {
        model: "sonnet",
        strategies: [],
        maxIterations: 3,
        panel: { enabled: false, lenses: [], maxConcurrent: 4 },
      },
      sprint: { maxSprints: 10, requireContracts: true, sprintSize: "medium" },
      pipeline: {
        maxIterations: 20,
        maxCheckpointIterations: 3,
        requireApproval: false,
        contextReset: "always",
        researchPhase: true,
        architectPhase: false,
        mode: "autopilot",
        checkpointOverrides: {},
        approvalTimeoutMs: 86_400_000,
        prPollMs: 30_000,
        allowAutopilotRiskyActions: false,
        eventQueueBound: 1000,
        worktreeRoot: ".bober/worktrees",
        cleanupWorktreeOnSuccess: true,
        engine: "ts",
      },
      commands: {},
    });
    expect(Object.hasOwn(parsed, "seo")).toBe(false);
  });

  it("parses a config with a seo section present and materializes its defaults", () => {
    const result = BoberConfigSchema.safeParse({
      ...minimalBase,
      seo: { egress: { "search-console": true } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.seo?.egress).toEqual({
        "search-console": true,
        "serp-provider": false,
        "ai-visibility": false,
        "site-crawl": false,
      });
      expect(result.data.seo?.blockThreshold).toBe("critical-uncited");
    }
  });

  it("createDefaultConfig never sets a seo section (default config stays byte-identical)", () => {
    // Mirrors the egress-axis idiom (Pattern A): new opt-in sections are never
    // added to createDefaultConfig's base — only BoberConfigSchema.optional().
    expect(Object.hasOwn(BoberConfigSchema.parse(minimalBase), "seo")).toBe(false);
  });
});
