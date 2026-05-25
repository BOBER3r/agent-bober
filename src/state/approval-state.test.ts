/**
 * Unit tests for src/state/approval-state.ts
 *
 * Focused on the new listPendingApprovals helper (cockpit-row shape).
 * The existing listPending (full-marker shape) is tested in
 * src/cli/commands/list-approvals.test.ts.
 */

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  listPendingApprovals,
  savePending,
  type PendingMarker,
} from "./approval-state.js";

// ── Fixture ───────────────────────────────────────────────────────────

let tmpRoot: string;
let approvalsDir: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "bober-approval-state-test-"));
  approvalsDir = join(tmpRoot, ".bober", "approvals");
  await mkdir(approvalsDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────

function makePendingMarker(overrides?: Partial<PendingMarker>): PendingMarker {
  const now = new Date().toISOString();
  return {
    checkpointId: "test-checkpoint",
    artifact: { type: "research-doc" },
    prompt: "Please approve this change",
    requestedAt: now,
    timeoutAt: now,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("listPendingApprovals", () => {
  it("returns [] when the approvals directory does not exist", async () => {
    // Use a fresh tmpDir with no .bober/approvals subdirectory
    const emptyRoot = await mkdtemp(join(tmpdir(), "bober-empty-"));
    try {
      const result = await listPendingApprovals(emptyRoot);
      expect(result).toEqual([]);
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });

  it("returns [] when there are no pending files", async () => {
    const result = await listPendingApprovals(tmpRoot);
    expect(result).toEqual([]);
  });

  it("returns cockpit-row shape for a single pending marker", async () => {
    const marker = makePendingMarker({
      checkpointId: "post-research",
      prompt: "Review the research doc",
      requestedAt: new Date(Date.now() - 5000).toISOString(),
    });
    await savePending(tmpRoot, marker);

    const rows = await listPendingApprovals(tmpRoot);
    expect(rows).toHaveLength(1);
    expect(rows[0].checkpointId).toBe("post-research");
    expect(rows[0].prompt).toBe("Review the research doc");
    expect(typeof rows[0].ageMs).toBe("number");
    expect(rows[0].ageMs).toBeGreaterThan(0);
  });

  it("returns ageMs computed from requestedAt", async () => {
    const requestedAt = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
    const marker = makePendingMarker({ checkpointId: "age-test", requestedAt });
    await savePending(tmpRoot, marker);

    const rows = await listPendingApprovals(tmpRoot);
    expect(rows).toHaveLength(1);
    // Should be close to 60000ms — allow some test execution slack
    expect(rows[0].ageMs).toBeGreaterThan(59_000);
    expect(rows[0].ageMs).toBeLessThan(70_000);
  });

  it("returns multiple rows when multiple pending files exist", async () => {
    const markers = [
      makePendingMarker({ checkpointId: "cp-1", prompt: "First checkpoint" }),
      makePendingMarker({ checkpointId: "cp-2", prompt: "Second checkpoint" }),
      makePendingMarker({ checkpointId: "cp-3", prompt: "Third checkpoint" }),
    ];
    for (const m of markers) {
      await savePending(tmpRoot, m);
    }

    const rows = await listPendingApprovals(tmpRoot);
    expect(rows).toHaveLength(3);
    const ids = rows.map((r) => r.checkpointId).sort();
    expect(ids).toEqual(["cp-1", "cp-2", "cp-3"]);
  });

  it("skips corrupted JSON files silently", async () => {
    const marker = makePendingMarker({ checkpointId: "valid-cp" });
    await savePending(tmpRoot, marker);

    // Write a corrupted file
    await writeFile(
      join(approvalsDir, "corrupt.pending.json"),
      "{ INVALID JSON {{",
      "utf-8",
    );

    const rows = await listPendingApprovals(tmpRoot);
    expect(rows).toHaveLength(1);
    expect(rows[0].checkpointId).toBe("valid-cp");
  });

  it("only reads .pending.json files (ignores .approved.json and .rejected.json)", async () => {
    const marker = makePendingMarker({ checkpointId: "the-pending" });
    await savePending(tmpRoot, marker);

    // Write resolved markers that should NOT appear in the list
    await writeFile(
      join(approvalsDir, "old-cp.approved.json"),
      JSON.stringify({ approvedAt: new Date().toISOString(), approverId: "alice" }),
      "utf-8",
    );
    await writeFile(
      join(approvalsDir, "bad-cp.rejected.json"),
      JSON.stringify({ rejectedAt: new Date().toISOString(), rejecterId: "bob", feedback: "no" }),
      "utf-8",
    );

    const rows = await listPendingApprovals(tmpRoot);
    expect(rows).toHaveLength(1);
    expect(rows[0].checkpointId).toBe("the-pending");
  });

  it("row shape has exactly { checkpointId, ageMs, prompt } keys", async () => {
    const marker = makePendingMarker({ checkpointId: "shape-test" });
    await savePending(tmpRoot, marker);

    const rows = await listPendingApprovals(tmpRoot);
    expect(rows).toHaveLength(1);
    const keys = Object.keys(rows[0]).sort();
    expect(keys).toEqual(["ageMs", "checkpointId", "prompt"]);
  });
});
