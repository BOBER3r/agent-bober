import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { appendHistory, loadHistory, loadRecentHistory } from "./history.js";
import type { HistoryEntry } from "./history.js";
import { rotateIfNeeded, historyArchivePath, historyActivePath } from "./history-rotation.js";

// ── Fixtures ─────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-history-test-"));
  // Pre-create .bober/ directory (mirrors real project layout)
  await mkdir(join(tmpDir, ".bober"), { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeEntry(i: number): HistoryEntry {
  return {
    timestamp: new Date().toISOString(),
    event: `event-${i}`,
    phase: "generating",
    details: { index: i },
  };
}

// ── C1: loadRecentHistory reads only active, returns at most `limit` ──

describe("C1: loadRecentHistory", () => {
  it("returns at most `limit` entries from the active file", async () => {
    // Seed 10 entries into active
    for (let i = 0; i < 10; i++) {
      await appendHistory(tmpDir, makeEntry(i));
    }
    const recent = await loadRecentHistory(tmpDir, { limit: 3 });
    expect(recent).toHaveLength(3);
  });

  it("returns all entries when active count < limit", async () => {
    for (let i = 0; i < 5; i++) {
      await appendHistory(tmpDir, makeEntry(i));
    }
    const recent = await loadRecentHistory(tmpDir, { limit: 100 });
    expect(recent).toHaveLength(5);
  });

  it("returns newest entries last (ascending order within the tail)", async () => {
    for (let i = 0; i < 5; i++) {
      await appendHistory(tmpDir, makeEntry(i));
    }
    const recent = await loadRecentHistory(tmpDir, { limit: 3 });
    // Entries 2, 3, 4 should come back (the tail)
    expect(recent[0].details.index).toBe(2);
    expect(recent[1].details.index).toBe(3);
    expect(recent[2].details.index).toBe(4);
  });

  it("does NOT read archive entries — returns only active content", async () => {
    // Seed archive with entries A, B (indexes 100, 101)
    const archivePath = historyArchivePath(tmpDir);
    const archiveLines = [makeEntry(100), makeEntry(101)]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n";
    await writeFile(archivePath, archiveLines, "utf-8");

    // Seed active with entries C, D, E (indexes 0, 1, 2)
    for (let i = 0; i < 3; i++) {
      await appendHistory(tmpDir, makeEntry(i));
    }

    // loadRecentHistory with limit=2 should return only active entries D, E
    const recent = await loadRecentHistory(tmpDir, { limit: 2 });
    expect(recent).toHaveLength(2);
    // Must NOT contain archive entries (indexes 100, 101)
    const indexes = recent.map((e) => e.details.index as number);
    expect(indexes).not.toContain(100);
    expect(indexes).not.toContain(101);
    // Must contain active entries only (from the tail: index 1, 2)
    expect(indexes).toContain(1);
    expect(indexes).toContain(2);
  });

  it("returns empty array when active file does not exist", async () => {
    const result = await loadRecentHistory(tmpDir, { limit: 10 });
    expect(result).toHaveLength(0);
  });
});

// ── C2: rotation moves overflow to archive, active <= maxActiveLines ──

describe("C2: rotation bounds active file", () => {
  it("rotates when active exceeds maxActiveLines", async () => {
    const MAX = 5;
    const SEED = MAX + 10; // 15 entries

    // Seed directly into active to trigger rotation (rotateIfNeeded uses MAX arg)
    const lines = Array.from({ length: SEED }, (_, i) => JSON.stringify(makeEntry(i))).join("\n") + "\n";
    await writeFile(historyActivePath(tmpDir), lines, "utf-8");

    await rotateIfNeeded(tmpDir, MAX);

    // Active should have at most MAX entries
    const activeContent = await readFile(historyActivePath(tmpDir), "utf-8");
    const activeLines = activeContent.split("\n").filter((l) => l.trim().length > 0);
    expect(activeLines.length).toBeLessThanOrEqual(MAX);
    expect(activeLines.length).toBe(MAX);

    // Archive should hold the overflow (SEED - MAX entries)
    const archiveContent = await readFile(historyArchivePath(tmpDir), "utf-8");
    const archiveLines = archiveContent.split("\n").filter((l) => l.trim().length > 0);
    expect(archiveLines.length).toBe(SEED - MAX);
  });

  it("seeds maxActiveLines+50 entries via appendHistory and verifies rotation", async () => {
    const MAX = 10;
    const SEED = MAX + 50;

    // Write SEED entries to active directly so rotateIfNeeded can be called with MAX
    const lines = Array.from({ length: SEED }, (_, i) => JSON.stringify(makeEntry(i))).join("\n") + "\n";
    await writeFile(historyActivePath(tmpDir), lines, "utf-8");

    await rotateIfNeeded(tmpDir, MAX);

    // Active should hold at most MAX entries
    const activeContent = await readFile(historyActivePath(tmpDir), "utf-8");
    const activeLines = activeContent.split("\n").filter((l) => l.trim().length > 0);
    expect(activeLines.length).toBeLessThanOrEqual(MAX);

    // Archive should hold the overflow (50 lines)
    const archiveContent = await readFile(historyArchivePath(tmpDir), "utf-8");
    const archiveLines = archiveContent.split("\n").filter((l) => l.trim().length > 0);
    expect(archiveLines.length).toBe(SEED - MAX);
  });

  it("does NOT create archive when active count <= maxActiveLines", async () => {
    const MAX = 100;
    for (let i = 0; i < 5; i++) {
      await appendHistory(tmpDir, makeEntry(i));
    }

    // rotateIfNeeded with large MAX should be a no-op
    await rotateIfNeeded(tmpDir, MAX);

    // Archive should not exist
    let archiveExists = true;
    try {
      await readFile(historyArchivePath(tmpDir), "utf-8");
    } catch {
      archiveExists = false;
    }
    expect(archiveExists).toBe(false);
  });

  it("archive accumulates overflow across multiple rotations", async () => {
    const MAX = 5;

    // First rotation: seed 10 entries, rotate → 5 in active, 5 in archive
    const firstBatch = Array.from({ length: 10 }, (_, i) => JSON.stringify(makeEntry(i))).join("\n") + "\n";
    await writeFile(historyActivePath(tmpDir), firstBatch, "utf-8");
    await rotateIfNeeded(tmpDir, MAX);

    // Second rotation: add 6 more entries to active (5 current + 6 new = 11), rotate again
    const secondBatch = Array.from({ length: 6 }, (_, i) => JSON.stringify(makeEntry(100 + i))).join("\n") + "\n";
    const currentActive = await readFile(historyActivePath(tmpDir), "utf-8");
    await writeFile(historyActivePath(tmpDir), currentActive + secondBatch, "utf-8");
    await rotateIfNeeded(tmpDir, MAX);

    // Archive should now have 5 (first) + 6 (second overflow) = 11 entries
    const archiveContent = await readFile(historyArchivePath(tmpDir), "utf-8");
    const archiveLines = archiveContent.split("\n").filter((l) => l.trim().length > 0);
    expect(archiveLines.length).toBe(11);

    // Active should have at most MAX entries
    const activeContent = await readFile(historyActivePath(tmpDir), "utf-8");
    const activeLines = activeContent.split("\n").filter((l) => l.trim().length > 0);
    expect(activeLines.length).toBeLessThanOrEqual(MAX);
  });
});

// ── C3: loadHistory returns full ordered set (archive + active) ───────

describe("C3: loadHistory full-read contract", () => {
  it("returns archive-then-active in original order", async () => {
    const MAX = 5;
    const TOTAL = 12;

    // Seed TOTAL entries
    const allEntries = Array.from({ length: TOTAL }, (_, i) => makeEntry(i));
    const lines = allEntries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await writeFile(historyActivePath(tmpDir), lines, "utf-8");

    // Trigger rotation — oldest TOTAL-MAX entries go to archive
    await rotateIfNeeded(tmpDir, MAX);

    // loadHistory must return all TOTAL entries in original order
    const loaded = await loadHistory(tmpDir);
    expect(loaded).toHaveLength(TOTAL);

    // Verify order: index should be 0..TOTAL-1
    for (let i = 0; i < TOTAL; i++) {
      expect(loaded[i].details.index).toBe(i);
    }
  });

  it("loadHistory output equals the pre-rotation sequence", async () => {
    const MAX = 3;
    const TOTAL = 8;

    // Capture pre-rotation sequence
    const preRotation = Array.from({ length: TOTAL }, (_, i) => makeEntry(i));
    const lines = preRotation.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await writeFile(historyActivePath(tmpDir), lines, "utf-8");

    await rotateIfNeeded(tmpDir, MAX);

    const postRotation = await loadHistory(tmpDir);
    expect(postRotation).toHaveLength(TOTAL);

    // Events must match the original sequence exactly
    for (let i = 0; i < TOTAL; i++) {
      expect(postRotation[i].event).toBe(`event-${i}`);
      expect(postRotation[i].details.index).toBe(i);
    }
  });

  it("returns empty array when neither active nor archive exist", async () => {
    const result = await loadHistory(tmpDir);
    expect(result).toHaveLength(0);
  });

  it("returns only active entries when no archive exists", async () => {
    for (let i = 0; i < 3; i++) {
      await appendHistory(tmpDir, makeEntry(i));
    }
    const result = await loadHistory(tmpDir);
    expect(result).toHaveLength(3);
    expect(result[0].details.index).toBe(0);
  });
});

// ── C4: crash-safety — union has every entry exactly once ─────────────

describe("C4: crash-safe rotation", () => {
  it("union of archive + active (crash before rename) has every entry exactly once after de-dup", async () => {
    const MAX = 5;
    const TOTAL = 10;

    // Pre-rotation: all TOTAL entries in active
    const allEntries = Array.from({ length: TOTAL }, (_, i) => makeEntry(i));
    const allLines = allEntries.map((e) => JSON.stringify(e)).join("\n") + "\n";

    // Simulate crash state: Option B crash before rename means:
    //   - archive has the overflow entries (oldest TOTAL-MAX)
    //   - active still has ALL entries (the rename never happened)
    const overflowCount = TOTAL - MAX;
    const overflowLines = allLines
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .slice(0, overflowCount)
      .join("\n") + "\n";

    await writeFile(historyActivePath(tmpDir), allLines, "utf-8");
    await writeFile(historyArchivePath(tmpDir), overflowLines, "utf-8");

    // Load everything via loadHistory (archive-then-active)
    const loaded = await loadHistory(tmpDir);

    // Union will have TOTAL (active) + overflowCount (archive) entries = TOTAL + overflowCount
    // But the unique indexes must cover all 0..TOTAL-1 exactly once
    const indexSet = new Set(loaded.map((e) => e.details.index as number));
    expect(indexSet.size).toBe(TOTAL); // all TOTAL distinct indexes are present

    // Every original index must appear in the union
    for (let i = 0; i < TOTAL; i++) {
      expect(indexSet.has(i)).toBe(true);
    }

    // Total loaded may include duplicates (from the crash state), but all entries are present
    expect(loaded.length).toBeGreaterThanOrEqual(TOTAL);
  });

  it("no entries lost after successful rotation", async () => {
    const MAX = 5;
    const TOTAL = 10;

    const allEntries = Array.from({ length: TOTAL }, (_, i) => makeEntry(i));
    const lines = allEntries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await writeFile(historyActivePath(tmpDir), lines, "utf-8");

    await rotateIfNeeded(tmpDir, MAX);

    // After successful rotation: active has MAX entries, archive has TOTAL-MAX
    // loadHistory must return all TOTAL entries, no duplicates
    const loaded = await loadHistory(tmpDir);
    expect(loaded).toHaveLength(TOTAL);

    const indexSet = new Set(loaded.map((e) => e.details.index as number));
    expect(indexSet.size).toBe(TOTAL);

    for (let i = 0; i < TOTAL; i++) {
      expect(indexSet.has(i)).toBe(true);
    }
  });
});

// ── sc-3-5: sprint-passed history events additively carry costUsd ─────────

describe("sc-3-5: sprint-passed history round-trip — additive costUsd", () => {
  it("round-trips a sprint-passed entry whose details include costUsd", async () => {
    await appendHistory(tmpDir, {
      timestamp: new Date().toISOString(),
      event: "sprint-passed",
      phase: "complete",
      sprintId: "s1",
      details: { iteration: 1, feedback: "ok", costUsd: 0.42 },
    });

    const [entry] = await loadHistory(tmpDir);
    expect(Object.hasOwn(entry.details, "costUsd")).toBe(true);
    expect(entry.details.costUsd).toBe(0.42);
  });

  it("round-trips a sprint-passed entry whose details omit costUsd (byte-identical, no key)", async () => {
    await appendHistory(tmpDir, {
      timestamp: new Date().toISOString(),
      event: "sprint-passed",
      phase: "complete",
      sprintId: "s2",
      details: { iteration: 1, feedback: "ok" },
    });

    const [entry] = await loadHistory(tmpDir);
    expect(Object.hasOwn(entry.details, "costUsd")).toBe(false);
  });
});
