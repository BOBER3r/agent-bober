/** Local-first RFC 5545 (.ics) connector — materializes a plan to disk with ZERO network egress. */

import { writeFile } from "node:fs/promises";
import { readBusyIntervalsFromFile } from "./finding-source.js";
import type { BusyInterval, PlanItem } from "./types.js";
import type { CalendarConnector, FreeBusyWindow, WriteResult } from "./connector.js";

// ── ISO → RFC 5545 UTC basic-format ───────────────────────────────────

/** "2026-06-29T08:30:00.000Z" → "20260629T083000Z" (deterministic, no locale). */
function toIcsUtc(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

// ── RFC 5545 TEXT escaping (3.3.11) ───────────────────────────────────

/** Escape backslash FIRST, then newline, comma, semicolon. */
function escapeText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

// ── VEVENT / VCALENDAR serialization ──────────────────────────────────

const CRLF = "\r\n";

function serializePlan(items: PlanItem[], dtstampIso: string): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//agent-bober//calendar-planner//EN",
  ];
  const dtstamp = toIcsUtc(dtstampIso);
  for (const item of items) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${item.findingId}@agent-bober`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART:${toIcsUtc(item.startIso)}`,
      `DTEND:${toIcsUtc(item.endIso)}`,
      `SUMMARY:${escapeText(item.title)}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join(CRLF) + CRLF; // trailing CRLF per spec
}

// ── Connector ─────────────────────────────────────────────────────────

export interface IcsConnectorOptions {
  /** Absolute path the .ics file is written to. */
  outPath: string;
  /** Optional local free/busy JSON file (BusyInterval[]). */
  freeBusyPath?: string;
  /** Injectable clock for DTSTAMP determinism (default: new Date().toISOString()). */
  nowIso?: string;
}

export function createIcsConnector(opts: IcsConnectorOptions): CalendarConnector {
  return {
    name: "ics",
    async readFreeBusy(_window: FreeBusyWindow): Promise<BusyInterval[]> {
      if (opts.freeBusyPath === undefined) return [];
      return readBusyIntervalsFromFile(opts.freeBusyPath); // node:fs/promises only
    },
    async writeEvents(items: PlanItem[]): Promise<WriteResult> {
      const ics = serializePlan(items, opts.nowIso ?? new Date().toISOString());
      await writeFile(opts.outPath, ics, "utf-8");
      return { writtenCount: items.length, target: opts.outPath };
    },
  };
}
