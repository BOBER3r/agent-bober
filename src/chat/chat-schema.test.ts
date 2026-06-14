import { describe, it, expect } from "vitest";

import { ChatSectionSchema } from "../config/schema.js";

describe("ChatSectionSchema (sc-1-4)", () => {
  it("parses a DeepSeek override config successfully", () => {
    const result = ChatSectionSchema.safeParse({
      model: "deepseek-chat",
      provider: "deepseek",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model).toBe("deepseek-chat");
      expect(result.data.provider).toBe("deepseek");
    }
  });

  it("defaults to opus model when no model is provided", () => {
    const result = ChatSectionSchema.safeParse({});

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model).toBe("opus");
    }
  });

  it("accepts optional endpoint and providerConfig", () => {
    const result = ChatSectionSchema.safeParse({
      model: "opus",
      provider: "anthropic",
      endpoint: "https://api.anthropic.com",
      providerConfig: { apiKey: "test-key" },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.endpoint).toBe("https://api.anthropic.com");
    }
  });

  it("parses a full BoberConfig with chat field", async () => {
    const { BoberConfigSchema } = await import("../config/schema.js");

    // A minimal valid config with the new chat section
    const raw = {
      project: { name: "test", mode: "brownfield" },
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
      sprint: { maxSprints: 10, requireContracts: true, sprintSize: "small" },
      pipeline: {
        maxIterations: 20,
        maxCheckpointIterations: 3,
        requireApproval: true,
        contextReset: "always",
        researchPhase: true,
        architectPhase: false,
        mode: "autopilot",
        checkpointOverrides: {},
        approvalTimeoutMs: 86400000,
        prPollMs: 30000,
        allowAutopilotRiskyActions: false,
        eventQueueBound: 1000,
        worktreeRoot: ".bober/worktrees",
        cleanupWorktreeOnSuccess: true,
        engine: "ts",
      },
      commands: {},
      chat: { model: "deepseek-chat", provider: "deepseek" },
    };

    const result = BoberConfigSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.chat?.model).toBe("deepseek-chat");
      expect(result.data.chat?.provider).toBe("deepseek");
    }
  });
});
