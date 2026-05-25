/**
 * Colocated unit tests for the list-approvals command.
 *
 * Placed at src/cli/commands/list-approvals.test.ts per the COLOCATION HARD CONSTRAINT —
 * NOT in tests/cli/. Preserves the colocated:separate test ratio.
 *
 * Sprint 9: s9-c7g — list-approvals CLI command tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatAge } from "./list-approvals.js";

let tmpRoot: string;
let approvalsDir: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "bober-list-approvals-"));
  approvalsDir = join(tmpRoot, ".bober", "approvals");
  await mkdir(approvalsDir, { recursive: true });
  process.exitCode = undefined;
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
  process.exitCode = undefined;
});

// ── formatAge ─────────────────────────────────────────────────────────────────

describe("formatAge", () => {
  it("formats seconds", () => {
    expect(formatAge(30_000)).toBe("30s");
  });

  it("formats minutes", () => {
    expect(formatAge(5 * 60_000)).toBe("5m");
  });

  it("formats hours and minutes", () => {
    expect(formatAge(2 * 3_600_000 + 15 * 60_000)).toBe("2h 15m");
  });

  it("formats days and hours", () => {
    expect(formatAge(3 * 86_400_000 + 2 * 3_600_000)).toBe("3d 2h");
  });

  it("formats zero age as 0s", () => {
    expect(formatAge(0)).toBe("0s");
  });

  it("formats exactly one minute", () => {
    expect(formatAge(60_000)).toBe("1m");
  });
});

// ── listPending state helper ──────────────────────────────────────────────────

describe("listPending — state helper (s9-c7g)", () => {
  it("returns empty array when approvals directory does not exist", async () => {
    const { listPending } = await import("../../state/approval-state.js");
    const nonExistentRoot = join(tmpRoot, "no-such-dir");
    const result = await listPending(nonExistentRoot);
    expect(result).toEqual([]);
  });

  it("returns all pending markers", async () => {
    const { listPending } = await import("../../state/approval-state.js");

    const now = new Date().toISOString();
    const marker1 = {
      checkpointId: "post-research",
      artifact: { type: "research-doc" },
      prompt: "Research artifact ready.",
      requestedAt: now,
      timeoutAt: now,
    };
    const marker2 = {
      checkpointId: "post-plan",
      artifact: { type: "plan" },
      prompt: "Plan ready.",
      requestedAt: now,
      timeoutAt: now,
    };

    await writeFile(
      join(approvalsDir, "post-research.pending.json"),
      JSON.stringify(marker1) + "\n",
      "utf-8",
    );
    await writeFile(
      join(approvalsDir, "post-plan.pending.json"),
      JSON.stringify(marker2) + "\n",
      "utf-8",
    );

    // Add a non-pending file that should be ignored.
    await writeFile(
      join(approvalsDir, "post-research.approved.json"),
      JSON.stringify({ approvedAt: now, approverId: "alice" }) + "\n",
      "utf-8",
    );

    const result = await listPending(tmpRoot);
    expect(result).toHaveLength(2);
    const ids = result.map((r) => r.checkpointId).sort();
    expect(ids).toEqual(["post-plan", "post-research"]);
  });

  it("skips corrupted JSON files gracefully", async () => {
    const { listPending } = await import("../../state/approval-state.js");

    // Write one valid + one corrupted.
    const now = new Date().toISOString();
    await writeFile(
      join(approvalsDir, "post-research.pending.json"),
      JSON.stringify({
        checkpointId: "post-research",
        artifact: {},
        prompt: "p",
        requestedAt: now,
        timeoutAt: now,
      }) + "\n",
      "utf-8",
    );
    await writeFile(
      join(approvalsDir, "corrupted.pending.json"),
      "{ invalid json !!!",
      "utf-8",
    );

    const result = await listPending(tmpRoot);
    expect(result).toHaveLength(1);
    expect(result[0]?.checkpointId).toBe("post-research");
  });
});

// ── Output format ─────────────────────────────────────────────────────────────

describe("list-approvals — output format", () => {
  it("formatAge + pending data renders a parseable table row", () => {
    const requestedAt = new Date(Date.now() - 2 * 3_600_000 - 15 * 60_000).toISOString();
    const ageMs = Date.now() - Date.parse(requestedAt);
    const row = `${"post-research".padEnd(48)} ${formatAge(ageMs).padEnd(10)} Research artifact ready.`;
    expect(row).toContain("post-research");
    expect(row).toContain("2h");
    expect(row).toContain("Research artifact ready.");
  });
});
