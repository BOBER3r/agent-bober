/**
 * Unit tests for bober_list_pending_approvals tool.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { registerListPendingApprovalsTool } from "./list-pending-approvals.js";
import { getTool } from "./registry.js";
import { savePending, type PendingMarker } from "../../state/approval-state.js";

// ── Fixtures ──────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-list-pending-approvals-test-"));
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

describe("bober_list_pending_approvals", () => {
  it("is registered with the correct name", () => {
    expect(getTool("bober_list_pending_approvals")).toBeDefined();
  });

  it("returns soft-error JSON for relative projectPath", async () => {
    const tool = getTool("bober_list_pending_approvals")!;
    const result = JSON.parse(await tool.handler({ projectPath: "./relative/path" }));
    expect(result.error).toBe("projectPath must be absolute");
  });

  it("returns empty array when no pending checkpoints exist", async () => {
    const tool = getTool("bober_list_pending_approvals")!;
    const result = JSON.parse(await tool.handler({ projectPath: tmpDir }));
    expect(result).toEqual([]);
  });

  it("returns cockpit-row array for existing pending checkpoints", async () => {
    const marker = makePending({ checkpointId: "my-cp", prompt: "Please review" });
    await savePending(tmpDir, marker);

    const tool = getTool("bober_list_pending_approvals")!;
    const result = JSON.parse(await tool.handler({ projectPath: tmpDir }));
    expect(result).toHaveLength(1);
    expect(result[0].checkpointId).toBe("my-cp");
    expect(result[0].prompt).toBe("Please review");
    expect(typeof result[0].ageMs).toBe("number");
  });

  it("defaults to cwd when projectPath is omitted (no error thrown)", async () => {
    // We can't easily test cwd behavior but we can verify it doesn't throw
    const tool = getTool("bober_list_pending_approvals")!;
    // Should return an array (even if empty from cwd)
    const raw = await tool.handler({});
    const result = JSON.parse(raw);
    expect(Array.isArray(result)).toBe(true);
  });

  it("returns multiple rows when multiple pending checkpoints exist", async () => {
    await savePending(tmpDir, makePending({ checkpointId: "cp-a", prompt: "First" }));
    await savePending(tmpDir, makePending({ checkpointId: "cp-b", prompt: "Second" }));

    const tool = getTool("bober_list_pending_approvals")!;
    const result = JSON.parse(await tool.handler({ projectPath: tmpDir }));
    expect(result).toHaveLength(2);
    const ids = result.map((r: { checkpointId: string }) => r.checkpointId).sort();
    expect(ids).toEqual(["cp-a", "cp-b"]);
  });
});
