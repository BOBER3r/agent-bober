/**
 * Unit tests for bober_reject_checkpoint tool.
 */

import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { registerRejectCheckpointTool } from "./reject-checkpoint.js";
import { getTool } from "./registry.js";
import { savePending, type PendingMarker, type RejectedMarker } from "../../state/approval-state.js";

// ── Fixtures ──────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-reject-cp-test-"));
  registerRejectCheckpointTool();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────

function makePending(overrides?: Partial<PendingMarker>): PendingMarker {
  return {
    checkpointId: "test-cp",
    artifact: { type: "research-doc" },
    prompt: "Review this",
    requestedAt: new Date().toISOString(),
    timeoutAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("bober_reject_checkpoint", () => {
  it("is registered with the correct name", () => {
    expect(getTool("bober_reject_checkpoint")).toBeDefined();
  });

  it("returns soft-error JSON for relative projectPath", async () => {
    const tool = getTool("bober_reject_checkpoint")!;
    const result = JSON.parse(
      await tool.handler({
        checkpointId: "cp-1",
        feedback: "bad idea",
        projectPath: "./relative",
      }),
    );
    expect(result.error).toBe("projectPath must be absolute");
  });

  it("returns soft-error JSON for empty checkpointId", async () => {
    const tool = getTool("bober_reject_checkpoint")!;
    const result = JSON.parse(
      await tool.handler({ checkpointId: "", feedback: "some feedback" }),
    );
    expect(result.error).toMatch(/checkpointId is required/);
  });

  it("returns soft-error JSON for empty feedback", async () => {
    const tool = getTool("bober_reject_checkpoint")!;
    const result = JSON.parse(
      await tool.handler({ checkpointId: "cp-1", feedback: "" }),
    );
    expect(result.error).toMatch(/feedback is required/);
  });

  it("returns soft-error JSON for whitespace-only feedback", async () => {
    const tool = getTool("bober_reject_checkpoint")!;
    const result = JSON.parse(
      await tool.handler({ checkpointId: "cp-1", feedback: "   " }),
    );
    expect(result.error).toMatch(/feedback is required/);
  });

  it("returns soft-error JSON when no pending checkpoint exists", async () => {
    const tool = getTool("bober_reject_checkpoint")!;
    const result = JSON.parse(
      await tool.handler({
        checkpointId: "does-not-exist",
        feedback: "bad plan",
        projectPath: tmpDir,
      }),
    );
    expect(result.error).toMatch(/No pending checkpoint found/);
  });

  it("writes .rejected.json and returns { rejectedAt, checkpointId }", async () => {
    const marker = makePending({ checkpointId: "to-reject" });
    await savePending(tmpDir, marker);

    const tool = getTool("bober_reject_checkpoint")!;
    const result = JSON.parse(
      await tool.handler({
        checkpointId: "to-reject",
        feedback: "Not ready yet",
        projectPath: tmpDir,
      }),
    );

    expect(result.checkpointId).toBe("to-reject");
    expect(typeof result.rejectedAt).toBe("string");
    expect(new Date(result.rejectedAt).getTime()).not.toBeNaN();
  });

  it("rejected.json has same shape as CLI-written marker (rejectedAt, rejecterId, feedback)", async () => {
    const marker = makePending({ checkpointId: "shape-test" });
    await savePending(tmpDir, marker);

    const tool = getTool("bober_reject_checkpoint")!;
    await tool.handler({
      checkpointId: "shape-test",
      feedback: "Need more research first",
      projectPath: tmpDir,
    });

    const rejectedPath = join(tmpDir, ".bober", "approvals", "shape-test.rejected.json");
    const raw = await readFile(rejectedPath, "utf-8");
    const saved = JSON.parse(raw) as RejectedMarker;

    expect(typeof saved.rejectedAt).toBe("string");
    expect(typeof saved.rejecterId).toBe("string");
    expect(saved.rejecterId.length).toBeGreaterThan(0);
    expect(saved.feedback).toBe("Need more research first");
  });
});
