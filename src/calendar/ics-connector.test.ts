import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createIcsConnector } from "./ics-connector.js";
import type { PlanItem } from "./types.js";

// ── Test fixtures ─────────────────────────────────────────────────────

const ITEMS: PlanItem[] = [
  {
    findingId: "f-1",
    title: "Task A, with comma",
    startIso: "2026-06-29T08:30:00.000Z",
    endIso: "2026-06-29T09:00:00.000Z",
  },
  {
    findingId: "f-2",
    title: "Task B",
    startIso: "2026-06-29T10:00:00.000Z",
    endIso: "2026-06-29T11:00:00.000Z",
  },
];

const NOW_ISO = "2026-06-29T08:00:00.000Z";

// ── Temp dir lifecycle ────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-ics-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── sc-2-3: generation — VCALENDAR structure with two VEVENTs ─────────

describe("sc-2-3: ics connector VCALENDAR generation", () => {
  it("writes a VCALENDAR with one VEVENT per item in UTC Z form", async () => {
    const out = join(tmpDir, "plan.ics");
    const connector = createIcsConnector({ outPath: out, nowIso: NOW_ISO });
    const res = await connector.writeEvents(ITEMS);

    expect(res.writtenCount).toBe(2);
    expect(res.target).toBe(out);

    const ics = await readFile(out, "utf8");
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
    expect((ics.match(/BEGIN:VEVENT/g) ?? []).length).toBe(2);
    expect((ics.match(/END:VEVENT/g) ?? []).length).toBe(2);
    expect(ics).toMatch(/DTSTART:20260629T083000Z/);
    expect(ics).toMatch(/DTEND:20260629T090000Z/);
    expect(ics).toContain("VERSION:2.0");
    expect(ics).toContain("PRODID:-//agent-bober//calendar-planner//EN");
  });

  it("uses CRLF line endings per RFC 5545", async () => {
    const out = join(tmpDir, "crlf.ics");
    await createIcsConnector({ outPath: out, nowIso: NOW_ISO }).writeEvents(ITEMS);
    const raw = await readFile(out, "utf8");
    expect(raw).toContain("\r\n");
    // Every non-empty line pair is CRLF-separated
    expect(raw.endsWith("\r\n")).toBe(true);
  });

  it("includes DTSTAMP in UTC Z form from nowIso", async () => {
    const out = join(tmpDir, "dtstamp.ics");
    await createIcsConnector({ outPath: out, nowIso: NOW_ISO }).writeEvents(ITEMS);
    const ics = await readFile(out, "utf8");
    expect(ics).toContain("DTSTAMP:20260629T080000Z");
  });

  it("writes zero VEVENTs for an empty items array", async () => {
    const out = join(tmpDir, "empty.ics");
    const res = await createIcsConnector({ outPath: out, nowIso: NOW_ISO }).writeEvents([]);
    expect(res.writtenCount).toBe(0);
    const ics = await readFile(out, "utf8");
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics).not.toContain("BEGIN:VEVENT");
  });
});

// ── sc-2-4: round-trip — parse back DTSTART, DTEND, SUMMARY ──────────

describe("sc-2-4: round-trip — DTSTART/DTEND/SUMMARY match source items", () => {
  it("round-trips DTSTART/DTEND/SUMMARY back to the source items", async () => {
    const out = join(tmpDir, "roundtrip.ics");
    await createIcsConnector({ outPath: out }).writeEvents(ITEMS);
    const ics = await readFile(out, "utf8");

    const starts = [...ics.matchAll(/DTSTART:(\d{8}T\d{6}Z)/g)].map((m) => m[1]);
    const ends = [...ics.matchAll(/DTEND:(\d{8}T\d{6}Z)/g)].map((m) => m[1]);
    const summaries = [...ics.matchAll(/SUMMARY:(.+)/g)].map((m) => m[1]?.trimEnd());

    // Item 0: startIso → DTSTART
    expect(starts[0]).toBe("20260629T083000Z");
    expect(ends[0]).toBe("20260629T090000Z");
    // Item 1: startIso → DTSTART
    expect(starts[1]).toBe("20260629T100000Z");
    expect(ends[1]).toBe("20260629T110000Z");

    // SUMMARY: commas escaped to "\,"
    expect(summaries[0]).toBe("Task A\\, with comma");
    expect(summaries[1]).toBe("Task B");
  });

  it("escapes semicolons in SUMMARY", async () => {
    const out = join(tmpDir, "semi.ics");
    const items: PlanItem[] = [
      {
        findingId: "f-semi",
        title: "Task; semicolon",
        startIso: "2026-06-29T08:00:00.000Z",
        endIso: "2026-06-29T09:00:00.000Z",
      },
    ];
    await createIcsConnector({ outPath: out, nowIso: NOW_ISO }).writeEvents(items);
    const ics = await readFile(out, "utf8");
    expect(ics).toContain("SUMMARY:Task\\; semicolon");
  });
});

// ── sc-2-5: no-egress boundary scan ──────────────────────────────────

describe("sc-2-5: ics-connector.ts no-egress boundary", () => {
  it("imports no http/https/fetch and no external-client, reads only node:fs/promises", async () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = await readFile(join(dir, "ics-connector.ts"), "utf8");

    expect(src).not.toMatch(/node:http\b/);
    expect(src).not.toMatch(/node:https\b/);
    expect(src).not.toMatch(/\bfetch\b/);
    expect(src).not.toMatch(/external-client/);
    expect(src).not.toMatch(/child_process|execa/);
    // Positive assertion: it DOES use node:fs/promises.
    expect(src).toMatch(/node:fs\/promises/);
  });
});
