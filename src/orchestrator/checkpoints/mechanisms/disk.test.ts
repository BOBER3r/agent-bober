/**
 * Colocated unit tests for DiskCheckpointMechanism.
 *
 * Placed at src/orchestrator/checkpoints/mechanisms/disk.test.ts per the
 * COLOCATION HARD CONSTRAINT in Sprint 9 briefing — NOT in tests/orchestrator/.
 * This preserves the colocated:separate test ratio (colocated >= separate).
 *
 * Sprint 9: s9-c7 covers all 7 branches:
 *   (a) approve flow
 *   (b) reject flow with feedback
 *   (c) edit flow with editDelta
 *   (d) timeout flow — returns { approved: false, feedback: 'TIMEOUT' }
 *   (e) no leaked timers across 10 parallel checkpoints
 *   (f) 100ms write budget (perf benchmark — s9-c6)
 *   (g) race handling (last-write-wins)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { DiskCheckpointMechanism } from "./disk.js";
import type { CheckpointId } from "../types.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-disk-cp-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Helper: write a resolution marker ────────────────────────────────────────

async function writeApproved(
  dir: string,
  checkpointId: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await writeFile(
    join(dir, `${checkpointId}.approved.json`),
    JSON.stringify({ approvedAt: new Date().toISOString(), approverId: "test-user", ...extra }) +
      "\n",
    "utf-8",
  );
}

async function writeRejected(
  dir: string,
  checkpointId: string,
  feedback: string,
): Promise<void> {
  await writeFile(
    join(dir, `${checkpointId}.rejected.json`),
    JSON.stringify({ rejectedAt: new Date().toISOString(), rejecterId: "test-user", feedback }) +
      "\n",
    "utf-8",
  );
}

// ── (a) Approve flow ─────────────────────────────────────────────────────────

describe("DiskCheckpointMechanism — approve flow (s9-c7a)", () => {
  it("returns { approved: true } when .approved.json appears", async () => {
    const m = new DiskCheckpointMechanism(tmpDir, { pollMs: 10 });
    const id = "post-research" as CheckpointId;

    // Write the approval marker shortly after request() starts polling.
    const timer = setTimeout(async () => {
      await writeApproved(tmpDir, id);
    }, 30);

    const outcome = await m.request(id, { type: "research-doc", path: ".bober/research/x.md" });

    clearTimeout(timer);

    expect(outcome).toEqual({ approved: true });
  });

  it("deletes pending file after approval", async () => {
    const m = new DiskCheckpointMechanism(tmpDir, { pollMs: 10 });
    const id = "post-plan" as CheckpointId;

    setTimeout(async () => {
      await writeApproved(tmpDir, id);
    }, 30);

    await m.request(id, {});

    // Pending file must be deleted.
    const pendingPath = join(tmpDir, `${id}.pending.json`);
    let existed = false;
    try {
      await access(pendingPath, constants.R_OK);
      existed = true;
    } catch {
      // expected — file should be deleted
    }
    expect(existed).toBe(false);
  });
});

// ── (b) Reject flow with feedback ────────────────────────────────────────────

describe("DiskCheckpointMechanism — reject flow (s9-c7b)", () => {
  it("returns { approved: false, feedback } when .rejected.json appears", async () => {
    const m = new DiskCheckpointMechanism(tmpDir, { pollMs: 10 });
    const id = "post-sprint-contract" as CheckpointId;

    setTimeout(async () => {
      await writeRejected(tmpDir, id, "needs more detail");
    }, 30);

    const outcome = await m.request(id, { type: "sprint-contract" });

    expect(outcome).toEqual({ approved: false, feedback: "needs more detail" });
  });

  it("deletes pending file after rejection", async () => {
    const m = new DiskCheckpointMechanism(tmpDir, { pollMs: 10 });
    const id = "pre-curator" as CheckpointId;

    setTimeout(async () => {
      await writeRejected(tmpDir, id, "feedback text");
    }, 30);

    await m.request(id, {});

    const pendingPath = join(tmpDir, `${id}.pending.json`);
    let existed = false;
    try {
      await access(pendingPath, constants.R_OK);
      existed = true;
    } catch {
      // expected — file should be deleted
    }
    expect(existed).toBe(false);
  });
});

// ── (c) Edit flow with editDelta ─────────────────────────────────────────────

describe("DiskCheckpointMechanism — edit flow (s9-c7c)", () => {
  it("returns { approved: true, editDelta } when .approved.json has editDelta", async () => {
    const m = new DiskCheckpointMechanism(tmpDir, { pollMs: 10 });
    const id = "post-research" as CheckpointId;

    setTimeout(async () => {
      await writeApproved(tmpDir, id, { editDelta: "updated research content" });
    }, 30);

    const outcome = await m.request(id, { type: "research-doc" });

    expect(outcome).toEqual({ approved: true, editDelta: "updated research content" });
  });
});

// ── (d) Timeout flow ─────────────────────────────────────────────────────────

describe("DiskCheckpointMechanism — timeout flow (s9-c7d)", () => {
  it("returns { approved: false, feedback: 'TIMEOUT' } when timeout is exceeded", async () => {
    // Use a very short timeout (1ms) so the test doesn't wait.
    const m = new DiskCheckpointMechanism(tmpDir, { pollMs: 5, timeoutMs: 1 });
    const id = "post-plan" as CheckpointId;

    const outcome = await m.request(id, { type: "plan" });

    expect(outcome).toEqual({ approved: false, feedback: "TIMEOUT" });
  });

  it("writes a .timeout.json marker file on timeout", async () => {
    const m = new DiskCheckpointMechanism(tmpDir, { pollMs: 5, timeoutMs: 1 });
    const id = "end-of-pipeline" as CheckpointId;

    await m.request(id, {});

    const timeoutPath = join(tmpDir, `${id}.timeout.json`);
    const raw = await readFile(timeoutPath, "utf-8");
    const parsed = JSON.parse(raw) as { checkpointId: string; timedOutAt: string };
    expect(parsed.checkpointId).toBe(id);
    expect(typeof parsed.timedOutAt).toBe("string");
  });

  it("caps timeout at 7 days regardless of configured timeoutMs", async () => {
    const MAX_7_DAYS = 7 * 24 * 60 * 60 * 1000;
    let capturedTimeout = 0;

    // Inject a fake clock that advances enough to trigger the 7-day cap.
    let callCount = 0;
    const fakeClock = (): number => {
      callCount++;
      // First call: requestedAt — return 0.
      // Subsequent calls: pretend 8 days have passed to exceed 7-day cap.
      if (callCount <= 3) return 0;
      capturedTimeout = MAX_7_DAYS + 1;
      return capturedTimeout;
    };

    const m = new DiskCheckpointMechanism(
      tmpDir,
      { pollMs: 5, timeoutMs: 999 * 24 * 60 * 60 * 1000 }, // try to set 999 days
      fakeClock,
    );
    const id = "post-sprint" as CheckpointId;

    const outcome = await m.request(id, {});
    expect(outcome).toEqual({ approved: false, feedback: "TIMEOUT" });
  });
});

// ── (e) No leaked timers ─────────────────────────────────────────────────────

describe("DiskCheckpointMechanism — timer cleanup (s9-c7e)", () => {
  it("does not leak timers across 10 parallel checkpoints", async () => {
    const m = new DiskCheckpointMechanism(tmpDir, { pollMs: 10 });

    // Use unique checkpoint-like ids
    const uniqueIds = Array.from({ length: 10 }, (_, i) => `post-research-${i}` as CheckpointId);

    const before =
      (
        process.getActiveResourcesInfo?.().filter((r) => r === "Timeout") ?? []
      ).length;

    // Start all 10 requests concurrently, then write approved markers after a short delay.
    // This ensures the mechanism has written its pending file before we write approved.
    const requestPromises = uniqueIds.map((id) => m.request(id, {}));

    // Write approved markers after the mechanism has had time to write pending files.
    setTimeout(async () => {
      for (const id of uniqueIds) {
        await writeApproved(tmpDir, id);
      }
    }, 25);

    await Promise.all(requestPromises);

    const after =
      (
        process.getActiveResourcesInfo?.().filter((r) => r === "Timeout") ?? []
      ).length;

    // No net increase in Timeout handles.
    expect(after).toBeLessThanOrEqual(before);
  }, 10_000);
});

// ── (f) 100ms write budget (s9-c6) ───────────────────────────────────────────

describe("DiskCheckpointMechanism — 100ms write budget (s9-c6)", () => {
  it("write phase completes in <100ms even for large artifacts", async () => {
    // pollMs is set large so the test controls resolution via pre-written marker.
    const m = new DiskCheckpointMechanism(tmpDir, { pollMs: 100 });
    const id = "post-plan" as CheckpointId;

    // Large artifact — the 5MB fullContent must be IGNORED by summarizeArtifact.
    const hugeArtifact = {
      type: "plan",
      path: ".bober/plan.json",
      summary: "8-sprint plan",
      lines: 200,
      fullContent: "a".repeat(5_000_000), // 5MB blob that should be dropped
    };

    const start = performance.now();

    // Race the write against the 100ms budget.
    const pendingPath = join(tmpDir, `${id}.pending.json`);

    // Start the mechanism (it will write pending then start polling).
    const requestPromise = m.request(id, hugeArtifact);

    // Wait for the pending file to appear (write phase complete).
    let elapsed = 0;
    while (!existsSync(pendingPath)) {
      await new Promise<void>((r) => setTimeout(r, 0));
      elapsed = performance.now() - start;
      if (elapsed > 200) break; // safety break — don't hang the test suite
    }

    expect(elapsed).toBeLessThan(100);

    // Also verify the pending file does NOT contain the 5MB fullContent.
    // Sprint 11: rendered summary lives in `prompt`; `artifact` is now a type-only stub.
    const raw = await readFile(pendingPath, "utf-8");
    const parsed = JSON.parse(raw) as { artifact: Record<string, unknown>; prompt: string };
    // The 5MB blob must NOT appear in prompt (renderer is pure — ignores unknown fields).
    expect(parsed.prompt).not.toContain("aaaaa");
    // artifact stub holds only the type field.
    expect(parsed.artifact["type"]).toBe("plan");
    // prompt is a non-empty string from the renderer (markdown or JSON fence).
    expect(typeof parsed.prompt).toBe("string");
    expect(parsed.prompt.length).toBeGreaterThan(0);

    // Resolve to clean up.
    await writeApproved(tmpDir, id);
    await requestPromise;
  });
});

// ── (g) Race handling (last-write-wins) ──────────────────────────────────────

describe("DiskCheckpointMechanism — race handling (s9-c7g)", () => {
  it("resolves to approved when both .approved.json and .rejected.json exist", async () => {
    const m = new DiskCheckpointMechanism(tmpDir, { pollMs: 10 });
    const id = "post-research" as CheckpointId;

    // Write both markers concurrently after the mechanism starts polling.
    // Both markers appear at the same time — approved is checked first.
    setTimeout(async () => {
      await writeApproved(tmpDir, id);
      await writeRejected(tmpDir, id, "this should be ignored");
    }, 25);

    const outcome = await m.request(id, {});

    // approved.json is checked first — so outcome should be approved.
    expect(outcome).toEqual({ approved: true });
  });

  it("cleans up stale markers from a prior run at the start of request()", async () => {
    // Pre-write stale markers from a hypothetical prior run.
    await writeFile(
      join(tmpDir, "post-plan.approved.json"),
      JSON.stringify({ approvedAt: "stale", approverId: "old" }) + "\n",
      "utf-8",
    );

    const m = new DiskCheckpointMechanism(tmpDir, { pollMs: 10, timeoutMs: 1 });

    // Request should NOT resolve from the stale marker (it gets deleted at start).
    const outcome = await m.request("post-plan" as CheckpointId, {});

    // Should timeout since we cleaned up stale and no new marker appeared.
    expect(outcome).toEqual({ approved: false, feedback: "TIMEOUT" });
  });
});
