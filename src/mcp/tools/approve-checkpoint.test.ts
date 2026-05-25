/**
 * Unit tests for bober_approve_checkpoint tool.
 *
 * Includes a mixed-mode CLI ↔ MCP test: write a pending approval, list
 * it via bober_list_pending_approvals, approve via bober_approve_checkpoint,
 * then verify the .approved.json file on disk has the correct payload shape.
 */

import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { registerApproveCheckpointTool } from "./approve-checkpoint.js";
import { registerListPendingApprovalsTool } from "./list-pending-approvals.js";
import { getTool } from "./registry.js";
import { savePending, type PendingMarker, type ApprovedMarker } from "../../state/approval-state.js";

// ── Fixtures ──────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-approve-cp-test-"));
  registerApproveCheckpointTool();
  registerListPendingApprovalsTool();
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

describe("bober_approve_checkpoint", () => {
  it("is registered with the correct name", () => {
    expect(getTool("bober_approve_checkpoint")).toBeDefined();
  });

  it("returns soft-error JSON for relative projectPath", async () => {
    const tool = getTool("bober_approve_checkpoint")!;
    const result = JSON.parse(
      await tool.handler({ checkpointId: "cp-1", projectPath: "./relative" }),
    );
    expect(result.error).toBe("projectPath must be absolute");
  });

  it("returns soft-error JSON for empty checkpointId", async () => {
    const tool = getTool("bober_approve_checkpoint")!;
    const result = JSON.parse(await tool.handler({ checkpointId: "" }));
    expect(result.error).toMatch(/checkpointId is required/);
  });

  it("returns soft-error JSON when no pending checkpoint exists", async () => {
    const tool = getTool("bober_approve_checkpoint")!;
    const result = JSON.parse(
      await tool.handler({ checkpointId: "does-not-exist", projectPath: tmpDir }),
    );
    expect(result.error).toMatch(/No pending checkpoint found/);
  });

  it("writes .approved.json and returns { approvedAt, checkpointId }", async () => {
    const marker = makePending({ checkpointId: "my-approval" });
    await savePending(tmpDir, marker);

    const tool = getTool("bober_approve_checkpoint")!;
    const result = JSON.parse(
      await tool.handler({ checkpointId: "my-approval", projectPath: tmpDir }),
    );

    expect(result.checkpointId).toBe("my-approval");
    expect(typeof result.approvedAt).toBe("string");
    expect(new Date(result.approvedAt).getTime()).not.toBeNaN();
  });

  it("approved.json has same shape as CLI-written marker (approvedAt, approverId)", async () => {
    const marker = makePending({ checkpointId: "shape-test" });
    await savePending(tmpDir, marker);

    const tool = getTool("bober_approve_checkpoint")!;
    await tool.handler({ checkpointId: "shape-test", projectPath: tmpDir });

    const approvedPath = join(tmpDir, ".bober", "approvals", "shape-test.approved.json");
    const raw = await readFile(approvedPath, "utf-8");
    const saved = JSON.parse(raw) as ApprovedMarker;

    expect(typeof saved.approvedAt).toBe("string");
    expect(typeof saved.approverId).toBe("string");
    expect(saved.approverId.length).toBeGreaterThan(0);
  });

  it("includes editDelta in .approved.json when provided", async () => {
    const marker = makePending({ checkpointId: "delta-test" });
    await savePending(tmpDir, marker);

    const tool = getTool("bober_approve_checkpoint")!;
    await tool.handler({
      checkpointId: "delta-test",
      projectPath: tmpDir,
      editDelta: { replace: "new content" },
    });

    const approvedPath = join(tmpDir, ".bober", "approvals", "delta-test.approved.json");
    const raw = await readFile(approvedPath, "utf-8");
    const saved = JSON.parse(raw) as ApprovedMarker & { editDelta?: unknown };
    expect(saved.editDelta).toEqual({ replace: "new content" });
  });

  it("mixed-mode: list pending → approve via MCP → .approved.json on disk", async () => {
    // Write a pending approval (simulating the careful-flow agent)
    const marker = makePending({ checkpointId: "mixed-mode-cp", prompt: "Ship it?" });
    await savePending(tmpDir, marker);

    // List it via bober_list_pending_approvals — should appear
    const listTool = getTool("bober_list_pending_approvals")!;
    const listResult = JSON.parse(await listTool.handler({ projectPath: tmpDir }));
    expect(listResult).toHaveLength(1);
    expect(listResult[0].checkpointId).toBe("mixed-mode-cp");

    // Approve via bober_approve_checkpoint
    const approveTool = getTool("bober_approve_checkpoint")!;
    const approveResult = JSON.parse(
      await approveTool.handler({ checkpointId: "mixed-mode-cp", projectPath: tmpDir }),
    );
    expect(approveResult.checkpointId).toBe("mixed-mode-cp");
    expect(typeof approveResult.approvedAt).toBe("string");

    // Verify .approved.json exists with correct shape
    const approvedPath = join(tmpDir, ".bober", "approvals", "mixed-mode-cp.approved.json");
    const raw = await readFile(approvedPath, "utf-8");
    const saved = JSON.parse(raw) as ApprovedMarker;
    expect(typeof saved.approvedAt).toBe("string");
    expect(typeof saved.approverId).toBe("string");
    // editDelta should NOT be present since we didn't pass one
    expect("editDelta" in saved).toBe(false);
  });
});
