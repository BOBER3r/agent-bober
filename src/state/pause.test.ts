// ── pause.test.ts ──────────────────────────────────────────────────────
//
// Tests for src/state/pause.ts: marker CRUD and the cooperative poll gate.
//
// Patterns: temp dirs (no fs mocks per principles.md:44); injected clock
// so tests never sleep real time.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, access } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setPaused, clearPaused, isPaused, waitWhilePaused } from "./pause.js";

// ── Fixtures ──────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-pause-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Helper ────────────────────────────────────────────────────────────

async function makeRunDir(runId: string): Promise<void> {
  await mkdir(join(tmpDir, ".bober", "runs", runId), { recursive: true });
}

// ── setPaused ─────────────────────────────────────────────────────────

describe("setPaused", () => {
  it("creates paused.json with a pausedAt field", async () => {
    const runId = "run-set-paused";
    await makeRunDir(runId);
    await setPaused(tmpDir, runId);

    // File must exist and be readable
    const p = join(tmpDir, ".bober", "runs", runId, "paused.json");
    await expect(access(p, constants.R_OK)).resolves.not.toThrow();
  });

  it("paused.json content contains pausedAt ISO string", async () => {
    const runId = "run-paused-content";
    await makeRunDir(runId);
    const before = Date.now();
    await setPaused(tmpDir, runId);
    const after = Date.now();

    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(join(tmpDir, ".bober", "runs", runId, "paused.json"), "utf-8");
    const parsed = JSON.parse(raw) as { pausedAt: string };
    const ts = new Date(parsed.pausedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("creates the run directory if it does not exist yet", async () => {
    const runId = "run-auto-dir";
    // Do NOT pre-create the directory
    await setPaused(tmpDir, runId);
    const p = join(tmpDir, ".bober", "runs", runId, "paused.json");
    await expect(access(p, constants.R_OK)).resolves.not.toThrow();
  });

  it("throws on unsafe runId (path traversal guard)", async () => {
    await expect(setPaused(tmpDir, "../escape")).rejects.toThrow(/Invalid runId/);
    await expect(setPaused(tmpDir, "")).rejects.toThrow(/Invalid runId/);
    await expect(setPaused(tmpDir, "a/b")).rejects.toThrow(/Invalid runId/);
  });
});

// ── clearPaused ───────────────────────────────────────────────────────

describe("clearPaused", () => {
  it("removes paused.json", async () => {
    const runId = "run-clear";
    await makeRunDir(runId);
    await setPaused(tmpDir, runId);
    expect(await isPaused(tmpDir, runId)).toBe(true);

    await clearPaused(tmpDir, runId);
    expect(await isPaused(tmpDir, runId)).toBe(false);
  });

  it("is a no-op (does not throw) when paused.json does not exist", async () => {
    await expect(clearPaused(tmpDir, "run-no-marker")).resolves.not.toThrow();
  });

  it("is a no-op for unsafe runId (no throw)", async () => {
    await expect(clearPaused(tmpDir, "../escape")).resolves.not.toThrow();
  });
});

// ── isPaused ──────────────────────────────────────────────────────────

describe("isPaused", () => {
  it("returns false when paused.json does not exist", async () => {
    expect(await isPaused(tmpDir, "run-not-paused")).toBe(false);
  });

  it("returns true when paused.json exists", async () => {
    const runId = "run-is-paused";
    await makeRunDir(runId);
    await setPaused(tmpDir, runId);
    expect(await isPaused(tmpDir, runId)).toBe(true);
  });

  it("returns false for unsafe runId (no throw)", async () => {
    expect(await isPaused(tmpDir, "../escape")).toBe(false);
    expect(await isPaused(tmpDir, "")).toBe(false);
  });
});

// ── waitWhilePaused — sc-5-7: no marker → immediate return ───────────

describe("waitWhilePaused — no marker (sc-5-7 additive no-op)", () => {
  it("resolves immediately when paused.json does not exist", async () => {
    let clockCalls = 0;
    const now = (): number => {
      clockCalls++;
      return 0;
    };
    const start = Date.now();
    await waitWhilePaused(tmpDir, "run-no-marker", { now, pollMs: 1, timeoutMs: 5000 });
    const elapsed = Date.now() - start;

    // Must return quickly — no polling
    expect(elapsed).toBeLessThan(1000);
    // now() was NOT called because we resolved on the inline isPaused check
    expect(clockCalls).toBe(0);
  });

  it("resolves immediately for unsafe runId (isPaused returns false)", async () => {
    await expect(
      waitWhilePaused(tmpDir, "../escape", { pollMs: 1, timeoutMs: 100 }),
    ).resolves.not.toThrow();
  });
});

// ── waitWhilePaused — sc-5-5: blocks while paused, advances after clear ─

describe("waitWhilePaused — marker present (sc-5-5)", () => {
  it("blocks while paused.json exists, resolves after timeout fires via injected clock", async () => {
    const runId = "run-wait-blocked";
    await makeRunDir(runId);
    await setPaused(tmpDir, runId);

    // Inject a clock where the 3rd call crosses timeoutMs=5000.
    // 1st call (startedAt): 0; 2nd call (first tick timeout check): 3; 3rd: 6000
    let calls = 0;
    const now = (): number => {
      const values = [0, 3, 6000];
      const v = values[Math.min(calls, values.length - 1)] ?? 6000;
      calls++;
      return v;
    };

    const start = Date.now();
    // Does NOT resolve immediately (marker is present) — resolves via timeout
    await waitWhilePaused(tmpDir, runId, { now, pollMs: 1, timeoutMs: 5000 });
    const elapsed = Date.now() - start;

    // With pollMs=1 the timeout branch fires quickly in wall time
    expect(elapsed).toBeLessThan(2000);
    // now() WAS called (the poll loop ran)
    expect(calls).toBeGreaterThan(0);
  });

  it("resolves after marker is cleared between polls", async () => {
    const runId = "run-wait-clears";
    await makeRunDir(runId);
    await setPaused(tmpDir, runId);

    // Schedule the marker removal in the background so it happens after one poll tick
    const cleanup = setTimeout(() => {
      void clearPaused(tmpDir, runId);
    }, 20);

    const start = Date.now();
    await waitWhilePaused(tmpDir, runId, { pollMs: 10, timeoutMs: 5000 });
    const elapsed = Date.now() - start;
    clearTimeout(cleanup);

    // Must resolve within a short wall-clock window (marker was cleared)
    expect(elapsed).toBeLessThan(3000);
    expect(await isPaused(tmpDir, runId)).toBe(false);
  });
});
