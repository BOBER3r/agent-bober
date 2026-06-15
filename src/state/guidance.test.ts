// ── guidance.test.ts ──────────────────────────────────────────────────
//
// Tests for the runId-keyed guidance channel.
// Covers sc-4-4 (append + unknown-run + path-traversal) and sc-4-5 (drain/redrain).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  safeSegment,
  hasRunDir,
  appendGuidance,
  drainGuidance,
} from "./guidance.js";

// ── Fixtures ──────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-guidance-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── safeSegment ───────────────────────────────────────────────────────

describe("safeSegment", () => {
  it("accepts a normal alphanumeric runId", () => {
    expect(safeSegment("run-abc123")).toBe(true);
  });

  it("accepts runId with hyphens and underscores", () => {
    expect(safeSegment("run_2026-01-01")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(safeSegment("")).toBe(false);
  });

  it("rejects runId containing '/'", () => {
    expect(safeSegment("run/evil")).toBe(false);
  });

  it("rejects runId containing '\\'", () => {
    expect(safeSegment("run\\evil")).toBe(false);
  });

  it("rejects runId containing '..'", () => {
    expect(safeSegment("../evil")).toBe(false);
  });

  it("rejects runId starting with '.'", () => {
    expect(safeSegment(".hidden")).toBe(false);
  });

  it("rejects absolute path", () => {
    expect(safeSegment("/etc/passwd")).toBe(false);
  });
});

// ── hasRunDir ─────────────────────────────────────────────────────────

describe("hasRunDir", () => {
  it("returns false for a run dir that does not exist", async () => {
    const exists = await hasRunDir(tmpDir, "run-nonexistent");
    expect(exists).toBe(false);
  });

  it("returns true once the run dir is created", async () => {
    const dir = join(tmpDir, ".bober", "runs", "run-exists");
    await mkdir(dir, { recursive: true });
    const exists = await hasRunDir(tmpDir, "run-exists");
    expect(exists).toBe(true);
  });
});

// ── appendGuidance (sc-4-4) ───────────────────────────────────────────

describe("appendGuidance — sc-4-4", () => {
  it("appends a valid guidance entry to guidance.jsonl for a known run dir", async () => {
    // Create the run dir first (simulating an existing run)
    const runId = "run-known";
    await mkdir(join(tmpDir, ".bober", "runs", runId), { recursive: true });

    await appendGuidance(tmpDir, runId, "prefer Zod over yup");

    const raw = await readFile(
      join(tmpDir, ".bober", "runs", runId, "guidance.jsonl"),
      "utf-8",
    );
    const entry = JSON.parse(raw.trim()) as { ts: string; text: string; consumed: boolean };
    expect(entry.text).toBe("prefer Zod over yup");
    expect(entry.consumed).toBe(false);
    expect(typeof entry.ts).toBe("string");
  });

  it("rejects runId '../evil' and writes nothing outside .bober/runs (sc-4-4 security)", async () => {
    await expect(appendGuidance(tmpDir, "../evil", "malicious")).rejects.toThrow(
      /Invalid runId/,
    );
    // Ensure nothing was written at the escaped path
    let fileAtEscapedPath: string | null = null;
    try {
      fileAtEscapedPath = await readFile(join(tmpDir, "..", "evil", "guidance.jsonl"), "utf-8");
    } catch {
      // Expected — file should not exist
    }
    expect(fileAtEscapedPath).toBeNull();
  });

  it("rejects runId containing '/' and writes nothing", async () => {
    await expect(appendGuidance(tmpDir, "run/evil", "x")).rejects.toThrow(/Invalid runId/);
  });

  it("appends multiple entries in order", async () => {
    const runId = "run-multi";
    await mkdir(join(tmpDir, ".bober", "runs", runId), { recursive: true });

    await appendGuidance(tmpDir, runId, "first guidance");
    await appendGuidance(tmpDir, runId, "second guidance");

    const raw = await readFile(
      join(tmpDir, ".bober", "runs", runId, "guidance.jsonl"),
      "utf-8",
    );
    const lines = raw.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as { text: string };
    const second = JSON.parse(lines[1]!) as { text: string };
    expect(first.text).toBe("first guidance");
    expect(second.text).toBe("second guidance");
  });
});

// ── drainGuidance (sc-4-5) ────────────────────────────────────────────

describe("drainGuidance — sc-4-5", () => {
  it("returns [] when no guidance file exists (never-throw, missing file)", async () => {
    const result = await drainGuidance(tmpDir, "run-no-file");
    expect(result).toEqual([]);
  });

  it("drain returns both texts in order, second drain returns []", async () => {
    const runId = "run-drain";
    await mkdir(join(tmpDir, ".bober", "runs", runId), { recursive: true });

    await appendGuidance(tmpDir, runId, "first");
    await appendGuidance(tmpDir, runId, "second");

    // First drain: should return both unconsumed texts
    const first = await drainGuidance(tmpDir, runId);
    expect(first).toEqual(["first", "second"]);

    // Second drain: all entries now consumed — returns []
    const second = await drainGuidance(tmpDir, runId);
    expect(second).toEqual([]);
  });

  it("marks all entries consumed in the file after drain", async () => {
    const runId = "run-mark-consumed";
    await mkdir(join(tmpDir, ".bober", "runs", runId), { recursive: true });

    await appendGuidance(tmpDir, runId, "check consumed flag");

    await drainGuidance(tmpDir, runId);

    const raw = await readFile(
      join(tmpDir, ".bober", "runs", runId, "guidance.jsonl"),
      "utf-8",
    );
    const lines = raw.trim().split("\n").filter(Boolean);
    for (const line of lines) {
      const entry = JSON.parse(line) as { consumed: boolean };
      expect(entry.consumed).toBe(true);
    }
  });

  it("drain of already-consumed entries returns [] without error", async () => {
    const runId = "run-already-consumed";
    await mkdir(join(tmpDir, ".bober", "runs", runId), { recursive: true });

    await appendGuidance(tmpDir, runId, "already consumed text");

    // First drain
    await drainGuidance(tmpDir, runId);

    // Second drain — should be empty, not throw
    const result = await drainGuidance(tmpDir, runId);
    expect(result).toEqual([]);
  });

  it("drain on an empty guidance.jsonl returns []", async () => {
    const runId = "run-empty-file";
    await mkdir(join(tmpDir, ".bober", "runs", runId), { recursive: true });
    // Create an empty guidance.jsonl
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(tmpDir, ".bober", "runs", runId, "guidance.jsonl"), "", "utf-8");

    const result = await drainGuidance(tmpDir, runId);
    expect(result).toEqual([]);
  });
});
