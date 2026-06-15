// ── approval-cursor.test.ts ───────────────────────────────────────────
//
// Tests for ApprovalCursor (sc-2-6):
// - filterNew returns a marker on first call, then [] for the same key.
// - Missing cursor file tolerated (returns all as fresh).
// - Two markers with different requestedAt are distinct keys.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApprovalCursor, markerKey } from "./approval-cursor.js";
import type { PendingMarker } from "../state/approval-state.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-approval-cursor-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeMarker(
  checkpointId: string,
  requestedAt: string,
  runId?: string,
): PendingMarker {
  return {
    checkpointId,
    runId,
    artifact: { type: "research-doc" },
    prompt: `Approve checkpoint ${checkpointId}`,
    requestedAt,
    timeoutAt: requestedAt,
  };
}

describe("markerKey", () => {
  it("produces ${checkpointId}@${requestedAt}", () => {
    const m = makeMarker("cp-1", "2026-06-15T00:00:00.000Z");
    expect(markerKey(m)).toBe("cp-1@2026-06-15T00:00:00.000Z");
  });

  it("two markers with different requestedAt have distinct keys", () => {
    const m1 = makeMarker("cp-1", "2026-06-15T00:00:00.000Z");
    const m2 = makeMarker("cp-1", "2026-06-15T01:00:00.000Z");
    expect(markerKey(m1)).not.toBe(markerKey(m2));
  });
});

describe("ApprovalCursor (sc-2-6)", () => {
  it("returns marker on first filterNew call, then [] on second", async () => {
    const cursor = new ApprovalCursor(tmpDir, "sess-1");
    const m = makeMarker("cp-A", "2026-06-15T00:00:00.000Z", "run-1");

    const first = await cursor.filterNew([m]);
    expect(first).toHaveLength(1);
    expect(first[0]?.checkpointId).toBe("cp-A");

    const second = await cursor.filterNew([m]);
    expect(second).toHaveLength(0);
  });

  it("tolerates missing cursor file (no .bober/chat dir) — returns markers as fresh", async () => {
    // No .bober/chat dir created — must not throw
    const cursor = new ApprovalCursor(tmpDir, "sess-missing");
    const m = makeMarker("cp-B", "2026-06-15T00:00:00.000Z");

    const result = await cursor.filterNew([m]);
    expect(result).toHaveLength(1);
  });

  it("creates cursor file on first write and persists across instances", async () => {
    const m = makeMarker("cp-C", "2026-06-15T00:00:00.000Z", "run-C");

    // First instance announces it
    const cursor1 = new ApprovalCursor(tmpDir, "sess-persist");
    await cursor1.filterNew([m]);

    // Second instance (same sessionId) must see it as already announced
    const cursor2 = new ApprovalCursor(tmpDir, "sess-persist");
    const result = await cursor2.filterNew([m]);
    expect(result).toHaveLength(0);
  });

  it("two markers with different requestedAt are treated as distinct keys", async () => {
    const cursor = new ApprovalCursor(tmpDir, "sess-distinct");
    const m1 = makeMarker("cp-1", "2026-06-15T00:00:00.000Z");
    const m2 = makeMarker("cp-1", "2026-06-15T01:00:00.000Z"); // same checkpointId, later requestedAt

    const first = await cursor.filterNew([m1]);
    expect(first).toHaveLength(1);

    // m2 has a different key so it is fresh even though checkpointId matches
    const second = await cursor.filterNew([m2]);
    expect(second).toHaveLength(1);
    expect(second[0]?.requestedAt).toBe("2026-06-15T01:00:00.000Z");
  });

  it("correctly tracks multiple markers with independent seen state", async () => {
    const cursor = new ApprovalCursor(tmpDir, "sess-multi");
    const m1 = makeMarker("cp-1", "2026-06-15T00:00:00.000Z");
    const m2 = makeMarker("cp-2", "2026-06-15T00:00:00.000Z");

    // Announce m1 first
    await cursor.filterNew([m1]);

    // m2 should still be fresh; m1 should not re-appear
    const result = await cursor.filterNew([m1, m2]);
    expect(result).toHaveLength(1);
    expect(result[0]?.checkpointId).toBe("cp-2");
  });

  it("sessions are isolated — different sessionIds do not share seen state", async () => {
    const m = makeMarker("cp-shared", "2026-06-15T00:00:00.000Z");

    const cursor1 = new ApprovalCursor(tmpDir, "sess-A");
    const cursor2 = new ApprovalCursor(tmpDir, "sess-B");

    await cursor1.filterNew([m]);

    // sess-B has its own file and should still see the marker as fresh
    const result = await cursor2.filterNew([m]);
    expect(result).toHaveLength(1);
  });
});
