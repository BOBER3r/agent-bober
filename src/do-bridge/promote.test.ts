import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runPromotionGate } from "./promote.js";
import type { PromotionPlan } from "./types.js";

// ── Fixtures ──────────────────────────────────────────────────────────

const T = "2026-06-28T00:00:00.000Z";
const PLAN: PromotionPlan = { kind: "bober-run", task: "fix the CI build" };

// ── Helpers ───────────────────────────────────────────────────────────

/** Ensure a path does NOT exist (ENOENT → pass, otherwise rethrow). */
async function expectMissing(path: string): Promise<void> {
  try {
    await access(path);
    throw new Error(`Expected ${path} to be absent, but it exists`);
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") throw err;
  }
}

// ── --yes path ────────────────────────────────────────────────────────

describe("runPromotionGate — --yes auto-approve", () => {
  it("returns approved=true without calling confirm()", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bober-gate-"));
    try {
      let confirmCalled = false;
      const outcome = await runPromotionGate({
        projectRoot: tmpDir,
        findingId: "abc123",
        plan: PLAN,
        yes: true,
        isTTY: false,
        confirm: async () => { confirmCalled = true; return true; },
        now: () => T,
      });

      expect(outcome.approved).toBe(true);
      expect(confirmCalled).toBe(false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("writes .approved.json and removes .pending.json (--yes)", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bober-gate-"));
    try {
      await runPromotionGate({
        projectRoot: tmpDir,
        findingId: "fid1",
        plan: PLAN,
        yes: true,
        isTTY: false,
        confirm: async () => true,
        now: () => T,
      });

      const approvalsDir = join(tmpDir, ".bober", "approvals");
      // .approved.json exists
      await access(join(approvalsDir, "promote-fid1.approved.json"));
      // .pending.json removed
      await expectMissing(join(approvalsDir, "promote-fid1.pending.json"));
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── TTY confirm=true ──────────────────────────────────────────────────

describe("runPromotionGate — TTY approve", () => {
  it("calls confirm() once and returns approved=true", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bober-gate-"));
    try {
      let confirmCalls = 0;
      const outcome = await runPromotionGate({
        projectRoot: tmpDir,
        findingId: "tty1",
        plan: PLAN,
        yes: false,
        isTTY: true,
        confirm: async () => { confirmCalls++; return true; },
        now: () => T,
      });

      expect(outcome.approved).toBe(true);
      expect(confirmCalls).toBe(1);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("writes .approved.json and removes .pending.json on TTY approve", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bober-gate-"));
    try {
      await runPromotionGate({
        projectRoot: tmpDir,
        findingId: "ttyapprove",
        plan: PLAN,
        yes: false,
        isTTY: true,
        confirm: async () => true,
        now: () => T,
      });

      const approvalsDir = join(tmpDir, ".bober", "approvals");
      await access(join(approvalsDir, "promote-ttyapprove.approved.json"));
      await expectMissing(join(approvalsDir, "promote-ttyapprove.pending.json"));
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── TTY confirm=false (reject) ────────────────────────────────────────

describe("runPromotionGate — TTY reject", () => {
  it("returns approved=false when confirm returns false", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bober-gate-"));
    try {
      const outcome = await runPromotionGate({
        projectRoot: tmpDir,
        findingId: "ttyreject",
        plan: PLAN,
        yes: false,
        isTTY: true,
        confirm: async () => false,
        now: () => T,
      });

      expect(outcome.approved).toBe(false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("writes .rejected.json and removes .pending.json on TTY reject", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bober-gate-"));
    try {
      await runPromotionGate({
        projectRoot: tmpDir,
        findingId: "ttyrej2",
        plan: PLAN,
        yes: false,
        isTTY: true,
        confirm: async () => false,
        now: () => T,
      });

      const approvalsDir = join(tmpDir, ".bober", "approvals");
      await access(join(approvalsDir, "promote-ttyrej2.rejected.json"));
      await expectMissing(join(approvalsDir, "promote-ttyrej2.pending.json"));
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── Non-TTY poll: external approve ───────────────────────────────────

describe("runPromotionGate — non-TTY poll", () => {
  it("resolves approved=true when .approved.json appears externally", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bober-gate-poll-"));
    try {
      const checkpointId = "promote-polltest";
      const approvalsDir = join(tmpDir, ".bober", "approvals");

      // Start the gate (non-TTY, small poll for fast test)
      const gatePromise = runPromotionGate({
        projectRoot: tmpDir,
        findingId: "polltest",
        plan: PLAN,
        yes: false,
        isTTY: false,
        confirm: async () => false, // not called in non-TTY
        now: () => T,
        pollMs: 20,
        timeoutMs: 10_000,
      });

      // Write the approved marker externally after a short delay
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      await mkdir(approvalsDir, { recursive: true });
      await writeFile(
        join(approvalsDir, `${checkpointId}.approved.json`),
        JSON.stringify({ approvedAt: T, approverId: "external" }),
        "utf-8",
      );

      const outcome = await gatePromise;
      expect(outcome.approved).toBe(true);

      // Pending marker should be removed
      await expectMissing(join(approvalsDir, `${checkpointId}.pending.json`));
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves approved=false on timeout", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "bober-gate-timeout-"));
    try {
      const outcome = await runPromotionGate({
        projectRoot: tmpDir,
        findingId: "timeout1",
        plan: PLAN,
        yes: false,
        isTTY: false,
        confirm: async () => true,
        now: () => T,
        pollMs: 10,
        timeoutMs: 25, // very short timeout
      });

      expect(outcome.approved).toBe(false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
