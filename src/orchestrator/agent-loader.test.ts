/**
 * Co-located smoke tests for src/orchestrator/agent-loader.ts.
 *
 * Tests: clearAgentCache, assembleSystemPrompt returns decorated prompt
 * when ctx is enabled+ready, and returns base prompt unchanged otherwise.
 * Full integration tests live at tests/graph/prompts.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// fileExists returns true so resolveAgentPath succeeds; readFile returns mock content.
vi.mock("../utils/fs.js", () => ({
  fileExists: vi.fn().mockResolvedValue(true),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actual = await importOriginal<Record<string, any>>();
  return {
    ...actual,
    // Inline string — vi.mock factory is hoisted; top-level vars are not accessible.
    readFile: vi.fn().mockResolvedValue(
      "---\nname: test-agent\ndescription: Test agent\n---\nBase system prompt content.",
    ),
  };
});

import { assembleSystemPrompt, clearAgentCache } from "./agent-loader.js";

describe("agent-loader — assembleSystemPrompt", () => {
  beforeEach(() => {
    clearAgentCache();
  });

  it("returns decorated prompt when graphEnabled=true and engineHealth=ready for curator", async () => {
    const result = await assembleSystemPrompt(
      "curator",
      "bober-curator",
      "/fake/root",
      { graphEnabled: true, engineHealth: "ready" },
    );
    // Should end with the curator gated fragment (appended after separator)
    expect(result).toContain("\n\n---\n\n");
    expect(result).toContain("graph_search");
    expect(result).toContain("ALL exploration");
  });

  it("returns base prompt unchanged when graphEnabled=false", async () => {
    const result = await assembleSystemPrompt(
      "curator",
      "bober-curator",
      "/fake/root",
      { graphEnabled: false, engineHealth: "ready" },
    );
    expect(result).toBe("Base system prompt content.");
  });

  it("returns base prompt unchanged for planner (disabled mode)", async () => {
    const result = await assembleSystemPrompt(
      "planner",
      "bober-planner",
      "/fake/root",
      { graphEnabled: true, engineHealth: "ready" },
    );
    expect(result).toBe("Base system prompt content.");
  });
});
