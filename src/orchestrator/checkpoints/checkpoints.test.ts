/**
 * Colocated with src/orchestrator/checkpoints/ per the project convention:
 * src/orchestrator/agent-loader.test.ts, model-resolver.test.ts, and
 * code-reviewer-agent.test.ts all live next to the modules they test.
 * The contract's expectedChanges names tests/orchestrator/checkpoints.test.ts
 * but the project's dominant test-colocation pattern (Sprint 5 scanner
 * regression precedent) demands this location.
 */

import { describe, it, expect } from "vitest";
import {
  registerCheckpointMechanism,
  getCheckpointMechanism,
  CHECKPOINT_SITES,
  type CheckpointMechanism,
} from "./index.js";

describe("checkpoints — noop mechanism (s7-c5a)", () => {
  it("returns {approved: true} for every CheckpointId", async () => {
    const noop = getCheckpointMechanism("noop");
    for (const site of CHECKPOINT_SITES) {
      const outcome = await noop.request(site.id, { /* opaque */ });
      expect(outcome).toEqual({ approved: true });
    }
  });
});

describe("checkpoints — registry (s7-c2, s7-c5b, s7-c5c)", () => {
  it("resolves the noop mechanism by name", () => {
    const noop = getCheckpointMechanism("noop");
    expect(typeof noop.request).toBe("function");
  });

  it("throws a clear error for unknown mechanism names", () => {
    expect(() => getCheckpointMechanism("does-not-exist")).toThrow(/does-not-exist/);
    expect(() => getCheckpointMechanism("does-not-exist")).toThrow(/noop/);
  });

  it("allows registering a new mechanism at runtime", async () => {
    const stub: CheckpointMechanism = {
      request: async () => ({ approved: true }),
    };
    registerCheckpointMechanism("sprint-7-test-mechanism", stub);
    expect(getCheckpointMechanism("sprint-7-test-mechanism")).toBe(stub);
  });
});
