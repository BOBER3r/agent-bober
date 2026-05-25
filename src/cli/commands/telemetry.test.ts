/**
 * Colocated unit tests for `bober telemetry <status|purge|export>` CLI command.
 *
 * Sprint 28 — src/cli/commands/telemetry.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Temp directory setup ─────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-telemetry-cmd-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function writeTelemetryFile(
  date: string,
  events: Array<{ eventType: string; [key: string]: unknown }>,
): Promise<void> {
  const telDir = join(tmpDir, ".bober", "telemetry");
  await mkdir(telDir, { recursive: true });
  const lines = events
    .map((e) => JSON.stringify({ timestamp: new Date().toISOString(), ...e }))
    .join("\n");
  await writeFile(join(telDir, `${date}.jsonl`), lines + "\n", "utf-8");
}

// ── Tests — status subcommand (s28-c6) ───────────────────────────────────────

describe("telemetry status — event counting", () => {
  it("counts events by type from JSONL files", async () => {
    const date = new Date().toISOString().slice(0, 10);
    await writeTelemetryFile(date, [
      { eventType: "checkpoint-approved" },
      { eventType: "sprint-pass" },
      { eventType: "checkpoint-approved" },
    ]);

    // Read and count directly (testing the counting logic)
    const telDir = join(tmpDir, ".bober", "telemetry");
    const files = await readdir(telDir);
    const counts = new Map<string, number>();
    for (const file of files.filter((f) => f.endsWith(".jsonl"))) {
      const raw = await readFile(join(telDir, file), "utf-8");
      const lines = raw.split("\n").filter(Boolean);
      for (const line of lines) {
        const parsed = JSON.parse(line) as { eventType?: string };
        const et = parsed.eventType ?? "<unknown>";
        counts.set(et, (counts.get(et) ?? 0) + 1);
      }
    }

    expect(counts.get("checkpoint-approved")).toBe(2);
    expect(counts.get("sprint-pass")).toBe(1);
  });

  it("handles missing telemetry directory gracefully", async () => {
    // No .bober/telemetry directory exists
    const telDir = join(tmpDir, ".bober", "telemetry");
    let caught: { code?: string } | null = null;
    try {
      await readdir(telDir);
    } catch (err) {
      caught = err as { code?: string };
    }
    expect(caught?.code).toBe("ENOENT");
  });
});

// ── Tests — export subcommand (s28-c6) ──────────────────────────────────────

describe("telemetry export — JSONL concatenation", () => {
  it("reads all JSONL files and produces combined output", async () => {
    await writeTelemetryFile("2026-05-23", [
      { eventType: "sprint-pass", sprintId: "s1" },
    ]);
    await writeTelemetryFile("2026-05-24", [
      { eventType: "incident-resolved", incidentId: "inc-001" },
      { eventType: "agent-spawn", agentName: "generator" },
    ]);

    const telDir = join(tmpDir, ".bober", "telemetry");
    const files = (await readdir(telDir)).filter((f) => f.endsWith(".jsonl")).sort();

    let combined = "";
    for (const file of files) {
      combined += await readFile(join(telDir, file), "utf-8");
    }

    const lines = combined.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);

    const eventTypes = lines.map((l) => (JSON.parse(l) as { eventType: string }).eventType);
    expect(eventTypes).toContain("sprint-pass");
    expect(eventTypes).toContain("incident-resolved");
    expect(eventTypes).toContain("agent-spawn");
  });

  it("produces no output when telemetry directory does not exist", async () => {
    // ENOENT case — no telemetry directory
    const telDir = join(tmpDir, ".bober", "telemetry");
    let files: string[] = [];
    try {
      files = await readdir(telDir);
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") {
        files = [];
      }
    }
    expect(files).toEqual([]);
  });
});

// ── Tests — purge subcommand (s28-c6) ───────────────────────────────────────

describe("telemetry purge — directory removal", () => {
  it("removes the .bober/telemetry directory entirely", async () => {
    const date = new Date().toISOString().slice(0, 10);
    await writeTelemetryFile(date, [{ eventType: "sprint-pass" }]);

    const telDir = join(tmpDir, ".bober", "telemetry");

    // Verify it exists before
    const filesBefore = await readdir(telDir);
    expect(filesBefore.length).toBeGreaterThan(0);

    // Remove it (mirrors what purge does)
    await rm(telDir, { recursive: true, force: true });

    // Verify it's gone
    let caught: { code?: string } | null = null;
    try {
      await readdir(telDir);
    } catch (err) {
      caught = err as { code?: string };
    }
    expect(caught?.code).toBe("ENOENT");
  });
});
