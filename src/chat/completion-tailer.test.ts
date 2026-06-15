// ── completion-tailer.test.ts ────────────────────────────────────────────
//
// Tests for CompletionTailer: byte-cursor tailing, rotation-safety, dedupe.
// Uses real temp dirs — no fs mocks (principles.md:44).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFile, mkdir, writeFile, readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CompletionTailer } from "./completion-tailer.js";

// ── Helpers ────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-tailer-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Ensure .bober/ dir and return path to history.jsonl. */
async function setupHistoryDir(): Promise<string> {
  const boberDir = join(tmpDir, ".bober");
  await mkdir(boberDir, { recursive: true });
  return join(boberDir, "history.jsonl");
}

/** Serialise a JSONL line. */
const line = (obj: object): string => JSON.stringify(obj) + "\n";

/** A valid pipeline-complete history line. */
function completeLine(
  opts: {
    timestamp?: string;
    phase?: "complete" | "failed";
    completed?: number;
    failed?: number;
    durationMs?: number;
  } = {},
): string {
  return line({
    timestamp: opts.timestamp ?? "2026-06-14T00:00:00.000Z",
    event: "pipeline-complete",
    phase: opts.phase ?? "complete",
    details: {
      completed: opts.completed ?? 1,
      failed: opts.failed ?? 0,
      durationMs: opts.durationMs ?? 1000,
    },
  });
}

/** A non-completion history line. */
function phaseStartLine(timestamp?: string): string {
  return line({
    timestamp: timestamp ?? "2026-06-14T00:00:01.000Z",
    event: "phase-start",
    phase: "generating",
    details: {},
  });
}

/** Write a .completed.json marker for a runId. */
async function writeMarker(runId: string): Promise<void> {
  const runsDir = join(tmpDir, ".bober", "runs");
  await mkdir(runsDir, { recursive: true });
  const markerPath = join(runsDir, `${runId}.completed.json`);
  await writeFile(
    markerPath,
    JSON.stringify({ runId, completedAt: "2026-06-14T00:00:05.000Z" }, null, 2) + "\n",
    "utf-8",
  );
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("CompletionTailer — sc-3-8: missing history file", () => {
  it("returns empty array and does not throw when history.jsonl is absent", async () => {
    // No .bober/ dir at all
    const tailer = new CompletionTailer(tmpDir, "s1");
    const events = await tailer.poll();
    expect(events).toEqual([]);
  });
});

describe("CompletionTailer — sc-3-4: basic poll filters correctly", () => {
  it("returns exactly one CompletionEvent for a pipeline-complete line", async () => {
    const histPath = await setupHistoryDir();

    // Write one complete + one non-complete line
    await appendFile(histPath, completeLine(), "utf-8");
    await appendFile(histPath, phaseStartLine(), "utf-8");

    const tailer = new CompletionTailer(tmpDir, "s1");
    const events = await tailer.poll();

    expect(events).toHaveLength(1);
    expect(events[0]!.phase).toBe("complete");
    expect(events[0]!.completed).toBe(1);
    expect(events[0]!.failed).toBe(0);
    expect(events[0]!.durationMs).toBe(1000);
  });

  it("advances cursor so a second poll returns zero events", async () => {
    const histPath = await setupHistoryDir();
    await appendFile(histPath, completeLine(), "utf-8");

    const tailer = new CompletionTailer(tmpDir, "s1");
    await tailer.poll(); // first poll consumes the line
    const events2 = await tailer.poll();
    expect(events2).toHaveLength(0);
  });
});

describe("CompletionTailer — sc-3-5: rotation/shrink detection", () => {
  it("resets cursor when file size shrinks and returns only unseen completions", async () => {
    const histPath = await setupHistoryDir();

    // Write a first completion and a marker for its runId
    await appendFile(histPath, completeLine({ durationMs: 111 }), "utf-8");
    await writeMarker("run-aaa");

    const tailer = new CompletionTailer(tmpDir, "s1");
    const first = await tailer.poll();
    // first poll: one event (run-aaa via marker)
    expect(first).toHaveLength(1);
    const seenRunId = first[0]!.runId; // "run-aaa" (from marker)
    expect(seenRunId).toBe("run-aaa");

    // Simulate rotation: overwrite with SHORTER content (a DIFFERENT completion)
    await writeMarker("run-bbb");
    await writeFile(
      histPath,
      completeLine({ timestamp: "2026-06-14T01:00:00.000Z", phase: "failed", durationMs: 50 }),
      "utf-8",
    );

    const second = await tailer.poll();
    // Must reset cursor (size < old cursor), re-scan, but dedupe run-aaa.
    // run-bbb is unseen → one event.
    expect(second).toHaveLength(1);
    expect(second[0]!.phase).toBe("failed");
    expect(second[0]!.runId).toBe("run-bbb");
  });

  it("does not duplicate events already seen when re-scanning from 0", async () => {
    const histPath = await setupHistoryDir();

    await appendFile(histPath, completeLine({ durationMs: 200 }), "utf-8");
    await writeMarker("run-x");

    const tailer = new CompletionTailer(tmpDir, "s1");
    await tailer.poll(); // sees run-x

    // Rotation: overwrite with content that is SHORTER and repeats same event
    await writeFile(histPath, completeLine({ durationMs: 200 }), "utf-8");

    const second = await tailer.poll();
    // run-x already in seenRunIds — must not be returned again
    expect(second).toHaveLength(0);
  });
});

describe("CompletionTailer — sc-3-6: dedupe across session restart", () => {
  it("does not re-emit a completion after a fresh tailer instance reads the cursor", async () => {
    const histPath = await setupHistoryDir();

    await appendFile(histPath, completeLine(), "utf-8");
    await writeMarker("run-persist");

    // First tailer instance polls and persists cursor + seenRunIds
    const tailer1 = new CompletionTailer(tmpDir, "session-abc");
    const first = await tailer1.poll();
    expect(first).toHaveLength(1);
    expect(first[0]!.runId).toBe("run-persist");

    // Second tailer instance (simulates REPL restart) reads same cursor file
    const tailer2 = new CompletionTailer(tmpDir, "session-abc");
    const second = await tailer2.poll();
    expect(second).toHaveLength(0);
  });

  it("cursor.json persists byteCursor and seenRunIds on disk", async () => {
    const histPath = await setupHistoryDir();
    await appendFile(histPath, completeLine(), "utf-8");
    await writeMarker("run-z");

    const tailer = new CompletionTailer(tmpDir, "s-persist");
    await tailer.poll();

    const cursorPath = join(tmpDir, ".bober", "chat", "s-persist.cursor.json");
    const raw = JSON.parse(await readFile(cursorPath, "utf-8")) as {
      byteCursor: number;
      seenRunIds: string[];
    };
    expect(raw.byteCursor).toBeGreaterThan(0);
    expect(raw.seenRunIds).toContain("run-z");
  });
});

describe("CompletionTailer — marker fallback", () => {
  it("assigns runId from .completed.json marker when line has none", async () => {
    const histPath = await setupHistoryDir();
    // pipeline-complete line has no runId in details
    await appendFile(histPath, completeLine(), "utf-8");
    await writeMarker("run-from-marker");

    const tailer = new CompletionTailer(tmpDir, "s-marker");
    const events = await tailer.poll();

    expect(events).toHaveLength(1);
    expect(events[0]!.runId).toBe("run-from-marker");
  });
});
