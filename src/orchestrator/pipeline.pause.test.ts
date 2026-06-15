// ── pipeline.pause.test.ts ─────────────────────────────────────────────
//
// Tests for the Sprint 5 cooperative-pause gate in the pipeline.
//
// Pattern: mirrors pipeline.guidance.test.ts — we test the exported
// waitWhilePaused helper directly rather than driving the full
// runSprintCycle (which calls real LLMs).
//
// sc-5-5: gate blocks while paused.json present, advances after cleared.
// sc-5-7: no marker → single existence check, no extra ticks.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { waitWhilePaused, setPaused, clearPaused, isPaused } from "../state/pause.js";

// ── Fixtures ──────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-pipeline-pause-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── sc-5-7: no marker → immediate resolve (no extra ticks) ───────────

describe("sc-5-7: no marker → additive no-op (single existence check)", () => {
  it("waitWhilePaused resolves immediately when no paused.json exists", async () => {
    let ticks = 0;
    const now = (): number => {
      ticks++;
      return 0;
    };

    const start = Date.now();
    await waitWhilePaused(tmpDir, "run-no-marker-pipeline", { now, pollMs: 1, timeoutMs: 5000 });
    const elapsed = Date.now() - start;

    // Resolved immediately — no ticks scheduled
    expect(elapsed).toBeLessThan(1000);
    // now() was not called because we returned before entering the poll loop
    expect(ticks).toBe(0);
  });

  it("does not block for a run that was never paused", async () => {
    const runId = "run-never-paused";
    await mkdir(join(tmpDir, ".bober", "runs", runId), { recursive: true });

    const start = Date.now();
    await waitWhilePaused(tmpDir, runId, { pollMs: 1, timeoutMs: 5000 });
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

// ── sc-5-5: marker present → gate blocks, advances after cleared ──────

describe("sc-5-5: gate blocks while paused.json exists", () => {
  it("blocks while paused.json present, resolves after timeout via injected clock", async () => {
    const runId = "run-pipeline-paused";
    await mkdir(join(tmpDir, ".bober", "runs", runId), { recursive: true });
    await setPaused(tmpDir, runId);

    // Inject a clock that crosses timeoutMs on the third read
    let clockCalls = 0;
    const now = (): number => {
      const vals = [0, 3, 6000];
      const v = vals[Math.min(clockCalls, vals.length - 1)] ?? 6000;
      clockCalls++;
      return v;
    };

    const start = Date.now();
    await waitWhilePaused(tmpDir, runId, { now, pollMs: 1, timeoutMs: 5000 });
    const elapsed = Date.now() - start;

    // Injected clock → resolves without a real 5000ms sleep
    expect(elapsed).toBeLessThan(2000);
    expect(clockCalls).toBeGreaterThan(0);
    // Marker still exists (timeout did not clear it — gate just resolved)
    expect(await isPaused(tmpDir, runId)).toBe(true);
  });

  it("resolves once the marker is removed (cooperative resume)", async () => {
    const runId = "run-pipeline-resume";
    await mkdir(join(tmpDir, ".bober", "runs", runId), { recursive: true });
    await setPaused(tmpDir, runId);

    // Remove the marker in the background after a short delay
    const cleanup = setTimeout(() => {
      void clearPaused(tmpDir, runId);
    }, 20);

    const start = Date.now();
    await waitWhilePaused(tmpDir, runId, { pollMs: 10, timeoutMs: 10_000 });
    const elapsed = Date.now() - start;
    clearTimeout(cleanup);

    // Gate advanced after the marker was cleared
    expect(elapsed).toBeLessThan(3000);
    expect(await isPaused(tmpDir, runId)).toBe(false);
  });
});

// ── sc-5-7: marker CRUD roundtrip ────────────────────────────────────

describe("sc-5-7: marker state transitions (setPaused / clearPaused / isPaused)", () => {
  it("isPaused returns false before setPaused, true after, false after clearPaused", async () => {
    const runId = "run-state-machine";
    await mkdir(join(tmpDir, ".bober", "runs", runId), { recursive: true });

    expect(await isPaused(tmpDir, runId)).toBe(false);
    await setPaused(tmpDir, runId);
    expect(await isPaused(tmpDir, runId)).toBe(true);
    await clearPaused(tmpDir, runId);
    expect(await isPaused(tmpDir, runId)).toBe(false);
  });
});
