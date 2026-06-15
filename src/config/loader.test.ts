/**
 * Unit tests for loadConfig — focusing on role-provider validation (sc-5-5).
 *
 * These tests use real temp directories (no fs mocking) per the project principle.
 * Logger is mocked to suppress output during tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./loader.js";

// Suppress logger output (role-resolution logs etc.) during tests
vi.mock("../utils/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
  },
}));

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-roleprov-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── sc-5-5 ────────────────────────────────────────────────────────────────────

describe("sc-5-5: loadConfig rejects when a tool role is stuck on claude-code", () => {
  it("rejects with a message naming the offending tool role when all roles use claude-code", async () => {
    // Must include chat (prompt role) as claude-code too; otherwise absent chat defaults
    // to anthropic and becomes the fallback, preventing the throw.
    const config = {
      project: { name: "p", mode: "brownfield" },
      planner: { provider: "claude-code" },
      generator: { provider: "claude-code" },
      evaluator: { strategies: [], provider: "claude-code" },
      curator: { provider: "claude-code" },
      codeReview: { provider: "claude-code" },
      chat: { provider: "claude-code" },
    };

    await writeFile(join(tmpDir, "bober.config.json"), JSON.stringify(config), "utf-8");

    await expect(loadConfig(tmpDir)).rejects.toThrow(
      /generator|curator|evaluator|codeReview/,
    );
  });

  it("rejects because the error message explains claude-code cannot drive tools", async () => {
    // Must set ALL roles including optional curator/codeReview and chat; otherwise an absent
    // optional section resolves to "anthropic" (via model default) and becomes the
    // fallback, preventing the throw.
    const config = {
      project: { name: "p", mode: "brownfield" },
      planner: { provider: "claude-code" },
      generator: { provider: "claude-code" },
      evaluator: { strategies: [], provider: "claude-code" },
      curator: { provider: "claude-code" },
      codeReview: { provider: "claude-code" },
      chat: { provider: "claude-code" },
    };

    await writeFile(join(tmpDir, "bober.config.json"), JSON.stringify(config), "utf-8");

    await expect(loadConfig(tmpDir)).rejects.toThrow(/claude-code/);
  });
});

// ── Normal configs (regression guard) ────────────────────────────────────────

describe("loadConfig normal configs load without throwing", () => {
  it("loads a minimal anthropic config (default, no provider fields)", async () => {
    const config = {
      project: { name: "p", mode: "brownfield" },
      planner: {},
      generator: {},
      evaluator: { strategies: [] },
    };

    await writeFile(join(tmpDir, "bober.config.json"), JSON.stringify(config), "utf-8");

    const cfg = await loadConfig(tmpDir);
    expect(cfg.project.name).toBe("p");
  });

  it("loads when planner uses claude-code but tool roles resolve to anthropic", async () => {
    const config = {
      project: { name: "p", mode: "brownfield" },
      planner: { provider: "claude-code" },
      generator: { provider: "anthropic" },
      evaluator: { strategies: [], provider: "anthropic" },
    };

    await writeFile(join(tmpDir, "bober.config.json"), JSON.stringify(config), "utf-8");

    const cfg = await loadConfig(tmpDir);
    expect(cfg.project.name).toBe("p");
  });
});
