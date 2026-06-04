import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../utils/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

import { logger } from "../../utils/logger.js";
import { resolveEngineName } from "./selector.js";
import type { BoberConfig } from "../../config/schema.js";

// ── Helpers ────────────────────────────────────────────────────────

function makeConfig(pipeline: Partial<BoberConfig["pipeline"]>): BoberConfig {
  return {
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
      ...pipeline,
    },
  } as BoberConfig;
}

// ── resolveEngineName branch tests ────────────────────────────────

describe("resolveEngineName", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 'ts' when engine is 'ts' (default)", () => {
    const config = makeConfig({ engine: "ts" });
    expect(resolveEngineName(config)).toBe("ts");
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("returns 'skill' verbatim when engine is 'skill'", () => {
    const config = makeConfig({ engine: "skill" });
    expect(resolveEngineName(config)).toBe("skill");
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("returns 'ts' (downgrade) when engine='workflow' and probe is ineligible", () => {
    const config = makeConfig({ engine: "workflow", mode: "autopilot" });
    expect(resolveEngineName(config)).toBe("ts");
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it("returns 'ts' (downgrade) when engine='workflow' and mode='careful'", () => {
    // mode='careful' triggers downgrade regardless of eligibility
    const config = makeConfig({ engine: "workflow", mode: "careful" });
    expect(resolveEngineName(config)).toBe("ts");
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it("logs exactly one downgrade line on workflow→ts path (ineligible)", () => {
    const config = makeConfig({ engine: "workflow" });
    resolveEngineName(config);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it("does not log when engine='ts'", () => {
    const config = makeConfig({ engine: "ts" });
    resolveEngineName(config);
    expect(logger.info).not.toHaveBeenCalled();
  });
});
