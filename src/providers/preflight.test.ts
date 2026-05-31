import { describe, it, expect, vi, afterEach } from "vitest";
import { preflightOpenaiPeer, usesOpenaiFamily, OPENAI_PEER_HINT } from "./preflight.js";
import type { BoberConfig } from "../config/schema.js";

// Suppress logger.warn output in tests to keep output clean
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

// ── usesOpenaiFamily ─────────────────────────────────────────────────────────

describe("usesOpenaiFamily", () => {
  it("returns true when generator uses a deepseek shorthand", () => {
    const config = {
      generator: { model: "deepseek-v4-pro" },
    } as Partial<BoberConfig>;
    expect(usesOpenaiFamily(config)).toBe(true);
  });

  it("returns true when generator uses deepseek-v4-flash shorthand", () => {
    const config = {
      generator: { model: "deepseek-v4-flash" },
    } as Partial<BoberConfig>;
    expect(usesOpenaiFamily(config)).toBe(true);
  });

  it("returns true when generator uses bare deepseek shorthand", () => {
    const config = {
      generator: { model: "deepseek" },
    } as Partial<BoberConfig>;
    expect(usesOpenaiFamily(config)).toBe(true);
  });

  it("returns true when generator uses gpt-4.1 (resolves to openai)", () => {
    const config = {
      generator: { model: "gpt-4.1" },
    } as Partial<BoberConfig>;
    expect(usesOpenaiFamily(config)).toBe(true);
  });

  it("returns true when planner uses o3 (resolves to openai)", () => {
    const config = {
      planner: { model: "o3" },
    } as Partial<BoberConfig>;
    expect(usesOpenaiFamily(config)).toBe(true);
  });

  it("returns true when an explicit provider openai-compat is set", () => {
    const config = {
      generator: { model: "some-model", provider: "openai-compat" },
    } as Partial<BoberConfig>;
    expect(usesOpenaiFamily(config)).toBe(true);
  });

  it("returns false for anthropic-only config (opus/sonnet shorthands)", () => {
    const config = {
      planner: { model: "opus" },
      generator: { model: "sonnet" },
      evaluator: { model: "sonnet" },
    } as Partial<BoberConfig>;
    expect(usesOpenaiFamily(config)).toBe(false);
  });

  it("returns false for empty config", () => {
    expect(usesOpenaiFamily({})).toBe(false);
  });
});

// ── preflightOpenaiPeer ───────────────────────────────────────────────────────

describe("preflightOpenaiPeer", () => {
  // sc-3-2: openai-family role + openai absent => hint containing 'npm install openai'
  it("sc-3-2: returns hint for deepseek-v4-pro role when openai is absent", async () => {
    const config = {
      generator: { model: "deepseek-v4-pro" },
    } as Partial<BoberConfig>;
    const hint = await preflightOpenaiPeer(
      config,
      () => Promise.reject(new Error("Cannot find module 'openai'")),
    );
    expect(hint).not.toBeNull();
    expect(hint).toContain("npm install openai");
  });

  it("sc-3-2: returns hint for explicit openai provider + gpt-4.1 when openai is absent", async () => {
    const config = {
      generator: { model: "gpt-4.1" },
    } as Partial<BoberConfig>;
    const hint = await preflightOpenaiPeer(
      config,
      () => Promise.reject(new Error("not found")),
    );
    expect(hint).not.toBeNull();
    expect(hint).toContain("npm install openai");
  });

  it("sc-3-2: returned hint equals OPENAI_PEER_HINT constant", async () => {
    const config = {
      generator: { model: "deepseek" },
    } as Partial<BoberConfig>;
    const hint = await preflightOpenaiPeer(
      config,
      () => Promise.reject(new Error("absent")),
    );
    expect(hint).toBe(OPENAI_PEER_HINT);
  });

  it("sc-3-2: hint is emitted via logger.warn when openai is absent", async () => {
    const { logger } = await import("../utils/logger.js");
    const config = {
      evaluator: { model: "deepseek-v4-flash" },
    } as Partial<BoberConfig>;
    await preflightOpenaiPeer(
      config,
      () => Promise.reject(new Error("absent")),
    );
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining("npm install openai"),
    );
  });

  // sc-3-3: openai-family role + openai installed => no hint
  it("sc-3-3: returns null when openai is installed (importer resolves)", async () => {
    const config = {
      generator: { model: "deepseek-v4-pro" },
    } as Partial<BoberConfig>;
    const hint = await preflightOpenaiPeer(
      config,
      () => Promise.resolve({ default: class {} }),
    );
    expect(hint).toBeNull();
  });

  it("sc-3-3: emits no logger.warn when openai is installed", async () => {
    const { logger } = await import("../utils/logger.js");
    const config = {
      generator: { model: "gpt-4.1" },
    } as Partial<BoberConfig>;
    await preflightOpenaiPeer(
      config,
      () => Promise.resolve({ default: class {} }),
    );
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });

  // sc-3-4: anthropic-only config + openai absent => no hint
  it("sc-3-4: returns null for anthropic-only config even when openai is absent", async () => {
    const config = {
      planner: { model: "opus" },
      generator: { model: "sonnet" },
      evaluator: { model: "sonnet" },
    } as Partial<BoberConfig>;
    const hint = await preflightOpenaiPeer(
      config,
      () => Promise.reject(new Error("absent")),
    );
    expect(hint).toBeNull();
  });

  it("sc-3-4: does not call importer for anthropic-only config (short-circuits)", async () => {
    const importer = vi.fn().mockRejectedValue(new Error("absent"));
    const config = {
      planner: { model: "opus" },
      generator: { model: "sonnet" },
    } as Partial<BoberConfig>;
    await preflightOpenaiPeer(config, importer);
    expect(importer).not.toHaveBeenCalled();
  });

  it("sc-3-4: emits no logger.warn for anthropic-only config", async () => {
    const { logger } = await import("../utils/logger.js");
    const config = {
      planner: { model: "opus" },
      generator: { model: "sonnet" },
      evaluator: { model: "sonnet" },
    } as Partial<BoberConfig>;
    await preflightOpenaiPeer(
      config,
      () => Promise.reject(new Error("absent")),
    );
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });

  // Edge case: empty config
  it("returns null for completely empty config", async () => {
    const hint = await preflightOpenaiPeer(
      {},
      () => Promise.reject(new Error("absent")),
    );
    expect(hint).toBeNull();
  });

  // Never throws
  it("does not throw even when importer rejects", async () => {
    const config = {
      generator: { model: "deepseek-v4-pro" },
    } as Partial<BoberConfig>;
    await expect(
      preflightOpenaiPeer(
        config,
        () => Promise.reject(new Error("critical error")),
      ),
    ).resolves.not.toThrow();
  });
});
