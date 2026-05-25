/**
 * Unit tests for EventStreamManager.
 *
 * Uses a FakeServer with vi.fn() to assert on notification calls.
 * Tests construct EventStreamManager directly (NOT via initEventStream) for
 * isolation — each test gets a fresh instance.
 */

import { mkdtemp, rm, mkdir, appendFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { vi } from "vitest";

import { EventStreamManager } from "./event-stream.js";

// ── FakeServer ──────────────────────────────────────────────────────

interface FakeServer {
  notification: ReturnType<typeof vi.fn>;
}

function makeFakeServer(): FakeServer {
  return { notification: vi.fn().mockResolvedValue(undefined) };
}

// ── Test fixtures ────────────────────────────────────────────────────

let tmpDir: string;
let boberDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-events-test-"));
  boberDir = join(tmpDir, ".bober");
  await mkdir(boberDir, { recursive: true });
  // Pre-create history.jsonl so fs.watch targets the file directly (not the parent dir).
  // This avoids a race between parent-dir watch setup and the first appendFile.
  await writeFile(join(boberDir, "history.jsonl"), "");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Helper to wait for async file-watch callbacks ────────────────────

function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll until condition is true or timeout expires. */
async function waitUntil(
  condition: () => boolean,
  timeoutMs = 2000,
  pollMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await waitMs(pollMs);
  }
}

// ── Test scenario 1: Deliver a bober/events notification for matching runId ─

describe("EventStreamManager", () => {
  it("delivers a bober/events notification for a matching runId append", async () => {
    const srv = makeFakeServer();
    const mgr = new EventStreamManager(srv as never, tmpDir);

    await mgr.subscribe("run-X");

    const line =
      JSON.stringify({
        timestamp: "2026-05-25T00:00:00Z",
        event: "x",
        phase: "init",
        runId: "run-X",
        details: {},
      }) + "\n";

    await appendFile(join(boberDir, "history.jsonl"), line);

    await waitUntil(() => srv.notification.mock.calls.length > 0);

    expect(srv.notification).toHaveBeenCalled();
    const call = srv.notification.mock.calls[0]![0] as {
      method: string;
      params: { subscriptionId: string; event: unknown };
    };
    expect(call.method).toBe("bober/events");
    expect(call.params.event).toMatchObject({ runId: "run-X" });

    mgr.shutdown();
  });

  // ── Test scenario 2: Overflow / backpressure ──────────────────────

  it("delivers 1000 events and 1 dropped notification with count=1000 when appending 2000 events with a 1000-bound", async () => {
    const srv = makeFakeServer();
    const mgr = new EventStreamManager(srv as never, tmpDir, 1000);
    await mgr.subscribe("run-overflow");

    // Write 2000 lines at once
    const lines: string[] = [];
    for (let i = 0; i < 2000; i++) {
      lines.push(
        JSON.stringify({
          timestamp: `2026-05-25T00:00:00.${String(i).padStart(3, "0")}Z`,
          event: `event-${i}`,
          phase: "planning",
          runId: "run-overflow",
          details: {},
        }),
      );
    }
    await appendFile(join(boberDir, "history.jsonl"), lines.join("\n") + "\n");

    // Wait for fs.watch to fire and flush to complete; poll until dropped notification appears.
    // 5s timeout — the 2000-line write takes significant time to flush under load.
    await waitUntil(() => {
      const cs = srv.notification.mock.calls as Array<[{ method: string }]>;
      return cs.some((c) => c[0].method === "bober/events.dropped");
    }, 5000);

    const calls = srv.notification.mock.calls as Array<
      [{ method: string; params: Record<string, unknown> }]
    >;

    const eventCalls = calls.filter((c) => c[0].method === "bober/events");
    const droppedCalls = calls.filter((c) => c[0].method === "bober/events.dropped");

    expect(eventCalls.length).toBe(1000);
    expect(droppedCalls.length).toBe(1);
    expect(droppedCalls[0]![0].params.dropped).toBe(1000);

    mgr.shutdown();
  });

  // ── Test scenario 3: Skip lines without runId ─────────────────────

  it("does NOT call notification when appending a line without runId", async () => {
    const srv = makeFakeServer();
    const mgr = new EventStreamManager(srv as never, tmpDir);
    await mgr.subscribe("run-X");

    const line =
      JSON.stringify({
        timestamp: "2026-05-25T00:00:00Z",
        event: "no-run-id",
        phase: "init",
        details: {},
      }) + "\n";

    await appendFile(join(boberDir, "history.jsonl"), line);

    // Give the watcher enough time to fire even under load
    await waitMs(400);

    expect(srv.notification).not.toHaveBeenCalled();

    mgr.shutdown();
  });

  // ── Test scenario 4: Skip lines with a different runId ────────────

  it("does NOT call notification when appending a line with runId=Y to a subscription for runId=X", async () => {
    const srv = makeFakeServer();
    const mgr = new EventStreamManager(srv as never, tmpDir);
    await mgr.subscribe("run-X");

    const line =
      JSON.stringify({
        timestamp: "2026-05-25T00:00:00Z",
        event: "other-run",
        phase: "init",
        runId: "run-Y",
        details: {},
      }) + "\n";

    await appendFile(join(boberDir, "history.jsonl"), line);

    // Give the watcher enough time to fire even under load
    await waitMs(400);

    expect(srv.notification).not.toHaveBeenCalled();

    mgr.shutdown();
  });

  // ── Test scenario 5: No notification after unsubscribe ────────────

  it("does NOT call notification after unsubscribe", async () => {
    const srv = makeFakeServer();
    const mgr = new EventStreamManager(srv as never, tmpDir);
    const { subscriptionId } = await mgr.subscribe("run-X");

    mgr.unsubscribe(subscriptionId);

    const line =
      JSON.stringify({
        timestamp: "2026-05-25T00:00:00Z",
        event: "late",
        phase: "init",
        runId: "run-X",
        details: {},
      }) + "\n";

    await appendFile(join(boberDir, "history.jsonl"), line);

    // Give the watcher enough time to fire even under load
    await waitMs(400);

    expect(srv.notification).not.toHaveBeenCalled();

    mgr.shutdown();
  });

  // ── Test scenario 6: Subscribe + unsubscribe 50x — no watcher leak ─

  it("releases all file watchers after subscribe/unsubscribe 50 times", async () => {
    const srv = makeFakeServer();
    const mgr = new EventStreamManager(srv as never, tmpDir);

    for (let i = 0; i < 50; i++) {
      const { subscriptionId } = await mgr.subscribe(`run-${i}`);
      mgr.unsubscribe(subscriptionId);
    }

    // After 50 subscribe/unsubscribe cycles, all file watchers must be closed
    const watchCount = (mgr as unknown as { fileWatches: Map<string, unknown> }).fileWatches.size;
    expect(watchCount).toBe(0);

    mgr.shutdown();
  });

  // ── Test scenario 7: Backfill with `since` timestamp ─────────────

  it("delivers backfill notifications for pre-existing lines with timestamp > since", async () => {
    const srv = makeFakeServer();
    const mgr = new EventStreamManager(srv as never, tmpDir);

    // Write lines BEFORE subscribing
    const lines = [
      // timestamp before since — should NOT be delivered
      JSON.stringify({
        timestamp: "2026-05-24T23:59:59Z",
        event: "old-event",
        phase: "init",
        runId: "run-bf",
        details: {},
      }),
      // timestamp after since — SHOULD be delivered
      JSON.stringify({
        timestamp: "2026-05-25T01:00:00Z",
        event: "new-event",
        phase: "planning",
        runId: "run-bf",
        details: {},
      }),
    ];
    await writeFile(join(boberDir, "history.jsonl"), lines.join("\n") + "\n");

    await mgr.subscribe("run-bf", { since: "2026-05-25T00:00:00Z" });

    // Backfill is synchronous within subscribe(), so no extra wait needed
    // but give event loop a tick to flush
    await waitMs(50);

    const calls = srv.notification.mock.calls as Array<
      [{ method: string; params: { event: { event: string }; subscriptionId: string } }]
    >;
    const eventCalls = calls.filter((c) => c[0].method === "bober/events");

    expect(eventCalls.length).toBe(1);
    expect(eventCalls[0]![0].params.event).toMatchObject({ event: "new-event" });

    mgr.shutdown();
  });

  // ── Extra: runId extracted from details.runId ─────────────────────

  it("delivers notification when runId is nested under details.runId", async () => {
    const srv = makeFakeServer();
    const mgr = new EventStreamManager(srv as never, tmpDir);
    await mgr.subscribe("run-nested");

    const line =
      JSON.stringify({
        timestamp: "2026-05-25T00:00:00Z",
        event: "nested",
        phase: "init",
        details: { runId: "run-nested" },
      }) + "\n";

    await appendFile(join(boberDir, "history.jsonl"), line);

    await waitUntil(() => srv.notification.mock.calls.length > 0);

    expect(srv.notification).toHaveBeenCalled();
    const call = srv.notification.mock.calls[0]![0] as { method: string };
    expect(call.method).toBe("bober/events");

    mgr.shutdown();
  });
});
