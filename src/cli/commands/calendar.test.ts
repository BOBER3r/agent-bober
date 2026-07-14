import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCalendarPlan } from "./calendar.js";
import type { Finding, BusyInterval } from "../../calendar/types.js";

// ── Test fixtures ─────────────────────────────────────────────────────

const FIXTURE_FINDING_30: Finding = {
  id: "cal-test-30",
  domain: "coding",
  title: "Short task for calendar test",
  kind: "action",
  urgency: 5,
  severity: 4,
  evidence: ["evidence"],
  surfacedAt: "2026-06-29T00:00:00.000Z",
  tags: [],
  estDurationMin: 30,
  calendarSafeTitle: "Short task (safe)",
  status: "open",
};

const FIXTURE_FINDING_60: Finding = {
  id: "cal-test-60",
  domain: "coding",
  title: "Medium task for calendar test",
  kind: "action",
  urgency: 4,
  severity: 3,
  evidence: ["evidence B"],
  surfacedAt: "2026-06-29T00:00:00.000Z",
  tags: [],
  estDurationMin: 60,
  status: "open",
};

const FIXTURE_FINDINGS: Finding[] = [FIXTURE_FINDING_30, FIXTURE_FINDING_60];
const FIXTURE_BUSY: BusyInterval[] = [];

/** nowIso anchors the planning window to a deterministic value for assertions. */
const NOW_ISO = "2026-06-29T08:00:00.000Z";

// ── Helpers ───────────────────────────────────────────────────────────

const PROJECT_ROOT = "/tmp/bober-calendar-test";

// ── sc-1-6: runCalendarPlan extracted-core with injected deps ─────────

describe("runCalendarPlan — extracted core (sc-1-6)", () => {
  let stdoutChunks: string[];
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutChunks = [];
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    // Reset process.exitCode before each test (mirrors medical.test.ts pattern)
    process.exitCode = 0;
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    process.exitCode = 0;
  });

  it("prints ISO start, ISO end, and title for each scheduled finding", async () => {
    await runCalendarPlan(
      PROJECT_ROOT,
      { dryRun: true, findings: "/fake/findings.json", freebusy: "/fake/freebusy.json" },
      {
        readFindings: async () => FIXTURE_FINDINGS,
        readFreeBusy: async () => FIXTURE_BUSY,
        nowIso: NOW_ISO,
      },
    );

    const out = stdoutChunks.join("");

    // Each scheduled item must show ISO start and end — both start with "2026-06-29T"
    expect(out).toContain("2026-06-29T");

    // Titles are present in the output
    expect(out).toContain(FIXTURE_FINDING_30.calendarSafeTitle ?? FIXTURE_FINDING_30.title);
    expect(out).toContain(FIXTURE_FINDING_60.title);

    // Should exit cleanly
    expect(process.exitCode).toBe(0);
  });

  it("outputs the ISO start-end range in [start → end] format", async () => {
    await runCalendarPlan(
      PROJECT_ROOT,
      { dryRun: true, findings: "/fake/findings.json" },
      {
        readFindings: async () => [FIXTURE_FINDING_30],
        readFreeBusy: async () => [],
        nowIso: NOW_ISO,
      },
    );

    const out = stdoutChunks.join("");

    // ISO start: NOW_ISO itself (first slot in window starting at nowIso)
    expect(out).toContain(NOW_ISO);
    // ISO end: 30 min after NOW_ISO = 2026-06-29T08:30:00.000Z
    expect(out).toContain("2026-06-29T08:30:00.000Z");
  });

  it("prints dry-run notice when --dry-run is set", async () => {
    await runCalendarPlan(
      PROJECT_ROOT,
      { dryRun: true, findings: "/fake/findings.json" },
      {
        readFindings: async () => FIXTURE_FINDINGS,
        readFreeBusy: async () => FIXTURE_BUSY,
        nowIso: NOW_ISO,
      },
    );

    const out = stdoutChunks.join("");
    expect(out).toContain("dry-run");
  });

  it("reports no calendar write path — calendar.ts does not import writeFile or writeJson", async () => {
    // Source-scan: the calendar command must not have any file-write imports
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");

    const dir = dirname(fileURLToPath(import.meta.url));
    const src = await readFile(join(dir, "calendar.ts"), "utf8");

    expect(src).not.toMatch(/\bwriteFile\b/);
    expect(src).not.toMatch(/\bwriteJson\b/);
    expect(src).not.toMatch(/\bappendFile\b/);
  });

  it("sets process.exitCode = 1 and writes to stderr when --findings is missing", async () => {
    const stderrChunks: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    await runCalendarPlan(
      PROJECT_ROOT,
      { dryRun: true },
      { nowIso: NOW_ISO },
    );

    stderrSpy.mockRestore();
    expect(process.exitCode).toBe(1);
    expect(stderrChunks.join("")).toContain("--findings");
  });

  it("sets process.exitCode = 1 and writes to stderr when readFindings throws", async () => {
    const stderrChunks: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    await runCalendarPlan(
      PROJECT_ROOT,
      { dryRun: true, findings: "/fake/findings.json" },
      {
        readFindings: async () => { throw new Error("file not found"); },
        nowIso: NOW_ISO,
      },
    );

    stderrSpy.mockRestore();
    expect(process.exitCode).toBe(1);
    expect(stderrChunks.join("")).toContain("file not found");
  });

  it("handles empty findings array without error", async () => {
    await runCalendarPlan(
      PROJECT_ROOT,
      { dryRun: true, findings: "/fake/findings.json" },
      {
        readFindings: async () => [],
        nowIso: NOW_ISO,
      },
    );

    const out = stdoutChunks.join("");
    expect(out).toContain("No findings");
    expect(process.exitCode).toBe(0);
  });
});

// ── sc-2-6: --export-ics wires through runCalendarPlan ───────────────

describe("runCalendarPlan — --export-ics (sc-2-6)", () => {
  let tmpDir: string;
  let stdoutChunks: string[];
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-cal-ics-"));
    stdoutChunks = [];
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    process.exitCode = 0;
  });

  afterEach(async () => {
    stdoutSpy.mockRestore();
    process.exitCode = 0;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes a valid VCALENDAR and exits 0 when --export-ics is set (sc-2-6)", async () => {
    const out = join(tmpDir, "out.ics");
    await runCalendarPlan(
      PROJECT_ROOT,
      { findings: "/fake/findings.json", exportIcs: out },
      { readFindings: async () => FIXTURE_FINDINGS, readFreeBusy: async () => [], nowIso: NOW_ISO },
    );
    const ics = await readFile(out, "utf8");
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
    expect(process.exitCode).toBe(0);
  });

  it("prints the writtenCount and path after writing (sc-2-6)", async () => {
    const out = join(tmpDir, "out2.ics");
    await runCalendarPlan(
      PROJECT_ROOT,
      { findings: "/fake/findings.json", exportIcs: out },
      { readFindings: async () => FIXTURE_FINDINGS, readFreeBusy: async () => [], nowIso: NOW_ISO },
    );
    const outText = stdoutChunks.join("");
    expect(outText).toContain("event(s)");
    expect(outText).toContain(out);
  });

  it("--export-ics respects injected makeConnector dep", async () => {
    let capturedItems: unknown[] = [];
    const out = join(tmpDir, "stub.ics");
    await runCalendarPlan(
      PROJECT_ROOT,
      { findings: "/fake/findings.json", exportIcs: out },
      {
        readFindings: async () => FIXTURE_FINDINGS,
        readFreeBusy: async () => [],
        nowIso: NOW_ISO,
        makeConnector: (_outPath) => ({
          name: "stub",
          readFreeBusy: async () => [],
          writeEvents: async (items) => {
            capturedItems = items;
            return { writtenCount: items.length, target: _outPath };
          },
        }),
      },
    );
    expect(capturedItems.length).toBeGreaterThan(0);
    expect(process.exitCode).toBe(0);
  });
});
