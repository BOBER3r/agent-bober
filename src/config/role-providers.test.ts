import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveRoleProviders } from "./role-providers.js";
import { logger } from "../utils/logger.js";
import type { BoberConfig } from "./schema.js";

// Suppress and spy on logger output in tests
vi.mock("../utils/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
  },
}));

afterEach(() => {
  vi.clearAllMocks();
});

// ── sc-5-1: Tool role with per-role override is NOT redirected ───────────────

describe("sc-5-1: tool role with per-role non-claude-code override resolves correctly", () => {
  it("generator with explicit provider=anthropic resolves to anthropic (not claude-code)", () => {
    // All roles default to claude-code via planner provider; generator overrides to anthropic
    const config = {
      planner: { model: "opus", provider: "claude-code" },
      generator: { model: "sonnet", provider: "anthropic" },
      evaluator: { model: "sonnet", provider: "claude-code", strategies: [] },
      curator: { model: "opus", provider: "claude-code" },
      codeReview: { model: "sonnet", provider: "claude-code" },
    } as BoberConfig;

    const result = resolveRoleProviders(config);

    // generator has explicit anthropic override — must resolve to anthropic
    expect(result.generator).toBe("anthropic");
  });

  it("evaluator with claude-code and generator with openai: evaluator falls back to openai (when planner also on claude-code)", () => {
    // All roles on claude-code except generator which is openai.
    // Fallback scan order: planner (claude-code), researcher (claude-code), chat (claude-code),
    // curator (absent → resolves to anthropic by default — but wait, we force curator to claude-code).
    // Let's make curator also claude-code so the first non-claude-code is generator (openai).
    const config = {
      planner: { model: "opus", provider: "claude-code" },
      generator: { model: "gpt-4.1", provider: "openai" },
      evaluator: { model: "sonnet", provider: "claude-code", strategies: [] },
      curator: { model: "opus", provider: "claude-code" },
      codeReview: { model: "sonnet", provider: "claude-code" },
      chat: { model: "opus", provider: "claude-code" },
    } as BoberConfig;

    const result = resolveRoleProviders(config);

    // generator=openai provides the fallback target (first non-claude-code in scan order)
    expect(result.generator).toBe("openai");
    // evaluator was claude-code → redirected to fallback (openai)
    expect(result.evaluator).toBe("openai");
  });
});

// ── sc-5-2: Tool role stuck on claude-code with no alternative → throws ──────

describe("sc-5-2: tool role stuck on claude-code with no alternative throws naming the role", () => {
  it("throws when every role uses claude-code and names the first offending tool role", () => {
    // Must include chat (prompt role) as claude-code too; otherwise absent chat defaults
    // to anthropic and becomes the fallback, preventing the throw.
    const config = {
      planner: { model: "opus", provider: "claude-code" },
      generator: { model: "sonnet", provider: "claude-code" },
      evaluator: { model: "sonnet", provider: "claude-code", strategies: [] },
      curator: { model: "opus", provider: "claude-code" },
      codeReview: { model: "sonnet", provider: "claude-code" },
      chat: { model: "opus", provider: "claude-code" },
    } as BoberConfig;

    // The first tool role iterated is "curator"; the error must name it (or any tool role)
    expect(() => resolveRoleProviders(config)).toThrow(/curator|generator|evaluator|codeReview/);
  });

  it("throw message states claude-code cannot drive tools", () => {
    // Must set ALL roles (including optional curator/codeReview and chat) to claude-code,
    // otherwise an absent optional section resolves to "anthropic" via the model default
    // and becomes the fallback, preventing the throw.
    const config = {
      planner: { model: "opus", provider: "claude-code" },
      generator: { model: "sonnet", provider: "claude-code" },
      evaluator: { model: "sonnet", provider: "claude-code", strategies: [] },
      curator: { model: "opus", provider: "claude-code" },
      codeReview: { model: "sonnet", provider: "claude-code" },
      chat: { model: "opus", provider: "claude-code" },
    } as BoberConfig;

    expect(() => resolveRoleProviders(config)).toThrow(/claude-code/);
  });

  it("throw message names a tool role (curator is first tool role in iteration order)", () => {
    // TOOL_ROLES iteration order: curator, generator, evaluator, codeReview.
    // First tool role iterated is "curator"; it throws naming "curator".
    const config = {
      planner: { model: "opus", provider: "claude-code" },
      generator: { model: "sonnet", provider: "claude-code" },
      evaluator: { model: "sonnet", provider: "claude-code", strategies: [] },
      curator: { model: "opus", provider: "claude-code" },
      codeReview: { model: "sonnet", provider: "claude-code" },
      chat: { model: "opus", provider: "claude-code" },
    } as BoberConfig;

    expect(() => resolveRoleProviders(config)).toThrow(/curator/);
  });
});

// ── sc-5-3: planner + researcher on claude-code are always allowed ────────────

describe("sc-5-3: planner and researcher on claude-code are allowed (no throw)", () => {
  it("resolves planner to claude-code when other tool roles have a non-claude-code provider", () => {
    const config = {
      planner: { model: "opus", provider: "claude-code" },
      generator: { model: "sonnet", provider: "anthropic" },
      evaluator: { model: "sonnet", strategies: [] },
    } as BoberConfig;

    const result = resolveRoleProviders(config);

    // planner is a prompt role — kept on claude-code
    expect(result.planner).toBe("claude-code");
  });

  it("resolves researcher to claude-code (researcher shares planner config)", () => {
    const config = {
      planner: { model: "opus", provider: "claude-code" },
      generator: { model: "sonnet", provider: "anthropic" },
      evaluator: { model: "sonnet", strategies: [] },
    } as BoberConfig;

    const result = resolveRoleProviders(config);

    // researcher is prompt-only; shares planner config; claude-code allowed
    expect(result.researcher).toBe("claude-code");
  });

  it("does not throw when planner + researcher are on claude-code but tool roles have alternatives", () => {
    const config = {
      planner: { model: "opus", provider: "claude-code" },
      generator: { model: "sonnet", provider: "anthropic" },
      evaluator: { model: "sonnet", strategies: [] },
    } as BoberConfig;

    expect(() => resolveRoleProviders(config)).not.toThrow();
  });
});

// ── sc-5-4: logger called once per role with role name + resolved provider ────

describe("sc-5-4: logger.info called once per role with role name and resolved provider", () => {
  it("calls logger.info 7 times (once per role, including chat)", () => {
    const config = {
      planner: { model: "opus" },
      generator: { model: "sonnet" },
      evaluator: { model: "sonnet", strategies: [] },
    } as BoberConfig;

    resolveRoleProviders(config);

    expect(vi.mocked(logger.info).mock.calls).toHaveLength(7);
  });

  it("logs the role name in each call", () => {
    const config = {
      planner: { model: "opus" },
      generator: { model: "sonnet" },
      evaluator: { model: "sonnet", strategies: [] },
    } as BoberConfig;

    resolveRoleProviders(config);

    const calls = vi.mocked(logger.info).mock.calls.map((c) => c[0]);
    expect(calls.some((msg) => msg.includes("planner"))).toBe(true);
    expect(calls.some((msg) => msg.includes("researcher"))).toBe(true);
    expect(calls.some((msg) => msg.includes("curator"))).toBe(true);
    expect(calls.some((msg) => msg.includes("generator"))).toBe(true);
    expect(calls.some((msg) => msg.includes("evaluator"))).toBe(true);
    expect(calls.some((msg) => msg.includes("codeReview"))).toBe(true);
    expect(calls.some((msg) => msg.includes("chat"))).toBe(true);
  });

  it("logs the finally-resolved provider (not the raw pre-fallback provider)", () => {
    // generator has claude-code; evaluator has anthropic → generator gets redirected to anthropic
    const config = {
      planner: { model: "opus", provider: "claude-code" },
      generator: { model: "sonnet", provider: "claude-code" },
      evaluator: { model: "sonnet", provider: "anthropic", strategies: [] },
    } as BoberConfig;

    resolveRoleProviders(config);

    const calls = vi.mocked(logger.info).mock.calls.map((c) => c[0] as string);
    const generatorLog = calls.find((msg) => msg.includes("generator"));
    expect(generatorLog).toBeDefined();
    // The finally-resolved provider for generator should be "anthropic" (redirected from claude-code)
    expect(generatorLog).toContain("anthropic");
    expect(generatorLog).not.toContain("claude-code");
  });
});
