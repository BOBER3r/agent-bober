// ── approval-reader.test.ts ───────────────────────────────────────────
//
// Tests for ApprovalReader (sc-2-4):
// - Two markers (one with runId, one without) => both returned.
// - Corrupted JSON in approvals dir => skipped silently.
// - Missing .bober/approvals dir => [].

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApprovalReader } from "./approval-reader.js";
import type { PendingMarker } from "../state/approval-state.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-approval-reader-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeMarker(
  o?: Partial<{
    checkpointId: string;
    runId: string;
    prompt: string;
    requestedAt: string;
  }>,
): PendingMarker {
  const now = new Date().toISOString();
  return {
    checkpointId: "cp-1",
    artifact: { type: "research-doc" },
    prompt: "Approve this",
    requestedAt: now,
    timeoutAt: now,
    ...o,
  };
}

async function injectPending(root: string, m: PendingMarker): Promise<void> {
  const dir = join(root, ".bober", "approvals");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${m.checkpointId}.pending.json`),
    JSON.stringify(m, null, 2),
    "utf-8",
  );
}

describe("ApprovalReader (sc-2-4)", () => {
  it("returns both markers when one has runId and one does not", async () => {
    const markerWithRunId = makeMarker({ checkpointId: "cp-with-run", runId: "run-42" });
    const markerNoRunId = makeMarker({ checkpointId: "cp-no-run" });

    await injectPending(tmpDir, markerWithRunId);
    await injectPending(tmpDir, markerNoRunId);

    const reader = new ApprovalReader(tmpDir);
    const results = await reader.read();

    expect(results).toHaveLength(2);
    const ids = results.map((m) => m.checkpointId);
    expect(ids).toContain("cp-with-run");
    expect(ids).toContain("cp-no-run");

    const withRun = results.find((m) => m.checkpointId === "cp-with-run");
    expect(withRun?.runId).toBe("run-42");

    const noRun = results.find((m) => m.checkpointId === "cp-no-run");
    expect(noRun?.runId).toBeUndefined();
  });

  it("skips corrupted JSON files silently", async () => {
    const goodMarker = makeMarker({ checkpointId: "cp-good", runId: "run-good" });
    await injectPending(tmpDir, goodMarker);

    // Inject a corrupted file alongside the valid one
    const dir = join(tmpDir, ".bober", "approvals");
    await writeFile(join(dir, "cp-corrupt.pending.json"), "not valid json{{{{", "utf-8");

    const reader = new ApprovalReader(tmpDir);
    const results = await reader.read();

    // Only the valid marker returned; corrupt file skipped
    expect(results).toHaveLength(1);
    expect(results[0]?.checkpointId).toBe("cp-good");
  });

  it("returns [] when .bober/approvals dir does not exist", async () => {
    // No approvals dir created
    const reader = new ApprovalReader(tmpDir);
    const results = await reader.read();
    expect(results).toEqual([]);
  });
});
