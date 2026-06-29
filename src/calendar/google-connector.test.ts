/**
 * Google Calendar connector unit tests — sc-3-2 / sc-3-3 / sc-3-4 / sc-3-5 / sc-3-6.
 *
 * ALL adapter calls use an injected stub — no live OAuth, no real subprocess,
 * no network in CI (contract non-goal).
 */

import { describe, it, expect, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { BoberConfig } from "../config/schema.js";
import type { Finding } from "./types.js";
import type { ToolDescriptor } from "../mcp/external-client.js";
import { CalendarEgressGuard } from "./calendar-egress.js";
import {
  createGoogleConnector,
  sanitizeCalendarError,
  type GoogleCalendarToolAdapter,
} from "./google-connector.js";
import { planSlots } from "./slotter.js";
import type { SlotConstraints } from "./types.js";

// ── Helpers ───────────────────────────────────────────────────────────

function makeAllowGuard(): CalendarEgressGuard {
  return CalendarEgressGuard.fromConfig({
    calendar: { egress: { cloudCalendar: true }, connector: "google" },
  } as unknown as BoberConfig);
}

function makeDenyGuard(): CalendarEgressGuard {
  return CalendarEgressGuard.fromConfig({
    calendar: { egress: { cloudCalendar: false }, connector: "ics" },
  } as unknown as BoberConfig);
}

function makeAdapter(callToolResponse: unknown = {}): GoogleCalendarToolAdapter & {
  listTools: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
} {
  return {
    listTools: vi.fn<[], Promise<ToolDescriptor[]>>().mockResolvedValue([]),
    callTool: vi.fn<[string, unknown], Promise<unknown>>().mockResolvedValue(
      callToolResponse,
    ),
  };
}

/** Minimal valid Finding. */
function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "f1",
    domain: "medical",
    title: "FULL SECRET TITLE — should never reach cloud",
    kind: "action",
    urgency: 3,
    severity: 3,
    evidence: ["LDL 190 mg/dL", "fasting glucose 115 mg/dL"],
    surfacedAt: "2026-06-29T00:00:00.000Z",
    tags: ["medical", "lipids"],
    estDurationMin: 30,
    calendarSafeTitle: "Wellness block",
    status: "open",
    ...overrides,
  };
}

// ── sc-3-3: axis-off refusal — zero adapter calls ─────────────────────

describe("sc-3-3: axis-off path refuses before adapter", () => {
  it("refuses writeEvents with a message naming calendar.egress.cloudCalendar", async () => {
    const adapter = makeAdapter();
    const conn = createGoogleConnector({
      adapter,
      egress: makeDenyGuard(),
      token: "t",
      findings: [],
    });
    await expect(conn.writeEvents([])).rejects.toThrow(
      /calendar\.egress\.cloudCalendar/,
    );
  });

  it("never calls adapter.callTool when axis is off (writeEvents)", async () => {
    const adapter = makeAdapter();
    const conn = createGoogleConnector({
      adapter,
      egress: makeDenyGuard(),
      token: "t",
      findings: [],
    });
    await expect(conn.writeEvents([])).rejects.toThrow();
    expect(adapter.callTool).not.toHaveBeenCalled();
  });

  it("never calls adapter.listTools when axis is off (writeEvents)", async () => {
    const adapter = makeAdapter();
    const conn = createGoogleConnector({
      adapter,
      egress: makeDenyGuard(),
      token: "t",
      findings: [],
    });
    await expect(conn.writeEvents([])).rejects.toThrow();
    expect(adapter.listTools).not.toHaveBeenCalled();
  });

  it("refuses readFreeBusy with a message naming calendar.egress.cloudCalendar", async () => {
    const adapter = makeAdapter();
    const conn = createGoogleConnector({
      adapter,
      egress: makeDenyGuard(),
      token: "t",
      findings: [],
    });
    await expect(
      conn.readFreeBusy({ windowStartIso: "2026-06-30T00:00:00Z", windowEndIso: "2026-07-07T00:00:00Z" }),
    ).rejects.toThrow(/calendar\.egress\.cloudCalendar/);
  });

  it("never calls adapter.callTool when axis is off (readFreeBusy)", async () => {
    const adapter = makeAdapter();
    const conn = createGoogleConnector({
      adapter,
      egress: makeDenyGuard(),
      token: "t",
      findings: [],
    });
    await expect(
      conn.readFreeBusy({ windowStartIso: "2026-06-30T00:00:00Z", windowEndIso: "2026-07-07T00:00:00Z" }),
    ).rejects.toThrow();
    expect(adapter.callTool).not.toHaveBeenCalled();
  });

  it("refuses when token is undefined (axis on, no token)", async () => {
    const adapter = makeAdapter();
    const conn = createGoogleConnector({
      adapter,
      egress: makeAllowGuard(),
      token: undefined,
      findings: [],
    });
    await expect(conn.writeEvents([])).rejects.toThrow(/token absent/i);
    expect(adapter.callTool).not.toHaveBeenCalled();
  });

  it("refusal message for absent token suggests .ics fallback", async () => {
    const adapter = makeAdapter();
    const conn = createGoogleConnector({
      adapter,
      egress: makeAllowGuard(),
      token: undefined,
      findings: [],
    });
    await expect(conn.writeEvents([])).rejects.toThrow(/\.ics/);
  });
});

// ── sc-3-4: safe-title mapping — privacy core ─────────────────────────

describe("sc-3-4: writeEvents sends calendarSafeTitle, never full title or evidence", () => {
  it("event summary equals finding.calendarSafeTitle", async () => {
    const adapter = makeAdapter();
    const finding = makeFinding();
    const conn = createGoogleConnector({
      adapter,
      egress: makeAllowGuard(),
      token: "t",
      findings: [finding],
    });
    await conn.writeEvents([
      { findingId: "f1", title: "FULL SECRET TITLE — should never reach cloud", startIso: "2026-06-30T09:00:00Z", endIso: "2026-06-30T09:30:00Z" },
    ]);
    const [, payload] = adapter.callTool.mock.calls[0]!;
    expect((payload as { summary: string }).summary).toBe("Wellness block");
  });

  it("serialized payload excludes the full finding title", async () => {
    const adapter = makeAdapter();
    const finding = makeFinding();
    const conn = createGoogleConnector({
      adapter,
      egress: makeAllowGuard(),
      token: "t",
      findings: [finding],
    });
    await conn.writeEvents([
      { findingId: "f1", title: "FULL SECRET TITLE — should never reach cloud", startIso: "2026-06-30T09:00:00Z", endIso: "2026-06-30T09:30:00Z" },
    ]);
    const [, payload] = adapter.callTool.mock.calls[0]!;
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("FULL SECRET TITLE");
  });

  it("serialized payload excludes evidence strings", async () => {
    const adapter = makeAdapter();
    const finding = makeFinding();
    const conn = createGoogleConnector({
      adapter,
      egress: makeAllowGuard(),
      token: "t",
      findings: [finding],
    });
    await conn.writeEvents([
      { findingId: "f1", title: "FULL SECRET TITLE — should never reach cloud", startIso: "2026-06-30T09:00:00Z", endIso: "2026-06-30T09:30:00Z" },
    ]);
    const [, payload] = adapter.callTool.mock.calls[0]!;
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("LDL 190 mg/dL");
    expect(serialized).not.toContain("fasting glucose 115 mg/dL");
  });

  it("serialized payload excludes tags", async () => {
    const adapter = makeAdapter();
    const finding = makeFinding();
    const conn = createGoogleConnector({
      adapter,
      egress: makeAllowGuard(),
      token: "t",
      findings: [finding],
    });
    await conn.writeEvents([
      { findingId: "f1", title: "FULL SECRET TITLE — should never reach cloud", startIso: "2026-06-30T09:00:00Z", endIso: "2026-06-30T09:30:00Z" },
    ]);
    const [, payload] = adapter.callTool.mock.calls[0]!;
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("lipids");
  });

  it("falls back to 'Focus block' when finding has no calendarSafeTitle", async () => {
    const adapter = makeAdapter();
    const finding = makeFinding({ calendarSafeTitle: undefined });
    const conn = createGoogleConnector({
      adapter,
      egress: makeAllowGuard(),
      token: "t",
      findings: [finding],
    });
    await conn.writeEvents([
      { findingId: "f1", title: "FULL SECRET TITLE", startIso: "2026-06-30T09:00:00Z", endIso: "2026-06-30T09:30:00Z" },
    ]);
    const [, payload] = adapter.callTool.mock.calls[0]!;
    expect((payload as { summary: string }).summary).toBe("Focus block");
  });

  it("falls back to 'Focus block' when finding is not in the map", async () => {
    const adapter = makeAdapter();
    const conn = createGoogleConnector({
      adapter,
      egress: makeAllowGuard(),
      token: "t",
      findings: [], // no findings in map
    });
    await conn.writeEvents([
      { findingId: "unknown-id", title: "FULL SECRET TITLE", startIso: "2026-06-30T09:00:00Z", endIso: "2026-06-30T09:30:00Z" },
    ]);
    const [, payload] = adapter.callTool.mock.calls[0]!;
    expect((payload as { summary: string }).summary).toBe("Focus block");
  });

  it("writeEvents returns WriteResult with writtenCount and target='google'", async () => {
    const adapter = makeAdapter();
    const finding = makeFinding();
    const conn = createGoogleConnector({
      adapter,
      egress: makeAllowGuard(),
      token: "t",
      findings: [finding],
    });
    const result = await conn.writeEvents([
      { findingId: "f1", title: "FULL SECRET TITLE", startIso: "2026-06-30T09:00:00Z", endIso: "2026-06-30T09:30:00Z" },
    ]);
    expect(result.writtenCount).toBe(1);
    expect(result.target).toBe("google");
  });
});

// ── sc-3-5: readFreeBusy feeds planSlots end-to-end ──────────────────

describe("sc-3-5: readFreeBusy → planSlots produces ProposedPlan", () => {
  it("readFreeBusy returns BusyInterval[] from stub adapter", async () => {
    const busyIntervals = [
      { startIso: "2026-06-30T09:00:00.000Z", endIso: "2026-06-30T10:00:00.000Z" },
    ];
    const adapter = makeAdapter({
      content: [{ text: JSON.stringify(busyIntervals) }],
    });
    const conn = createGoogleConnector({
      adapter,
      egress: makeAllowGuard(),
      token: "t",
      findings: [],
    });
    const result = await conn.readFreeBusy({
      windowStartIso: "2026-06-30T08:00:00.000Z",
      windowEndIso: "2026-06-30T18:00:00.000Z",
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.startIso).toBe("2026-06-30T09:00:00.000Z");
    expect(result[0]!.endIso).toBe("2026-06-30T10:00:00.000Z");
  });

  it("readFreeBusy returns empty array when adapter returns []", async () => {
    const adapter = makeAdapter({ content: [{ text: "[]" }] });
    const conn = createGoogleConnector({
      adapter,
      egress: makeAllowGuard(),
      token: "t",
      findings: [],
    });
    const result = await conn.readFreeBusy({
      windowStartIso: "2026-06-30T08:00:00.000Z",
      windowEndIso: "2026-06-30T18:00:00.000Z",
    });
    expect(result).toHaveLength(0);
  });

  it("readFreeBusy result feeds planSlots to produce a ProposedPlan", async () => {
    const busyIntervals = [
      { startIso: "2026-06-30T09:00:00.000Z", endIso: "2026-06-30T10:00:00.000Z" },
    ];
    const adapter = makeAdapter({
      content: [{ text: JSON.stringify(busyIntervals) }],
    });
    const findings: Finding[] = [
      makeFinding({
        id: "f1",
        estDurationMin: 30,
        surfacedAt: "2026-06-29T00:00:00.000Z",
      }),
    ];
    const conn = createGoogleConnector({
      adapter,
      egress: makeAllowGuard(),
      token: "t",
      findings,
    });
    const busy = await conn.readFreeBusy({
      windowStartIso: "2026-06-30T08:00:00.000Z",
      windowEndIso: "2026-06-30T18:00:00.000Z",
    });
    const constraints: SlotConstraints = {
      windowStartIso: "2026-06-30T08:00:00.000Z",
      windowEndIso: "2026-06-30T18:00:00.000Z",
    };
    const plan = planSlots(findings, busy, constraints);
    // The finding fits in the 8:00-9:00 free slot (before the busy block)
    expect(plan.scheduled.length + plan.unscheduled.length).toBe(findings.length);
    expect(plan.scheduled.length).toBeGreaterThanOrEqual(1);
  });

  it("readFreeBusy parses a raw JSON string (non-envelope) adapter response", async () => {
    const busyIntervals = [
      { startIso: "2026-06-30T11:00:00.000Z", endIso: "2026-06-30T12:00:00.000Z" },
    ];
    // Adapter returns a raw string (not the SDK content-envelope)
    const adapter = makeAdapter(JSON.stringify(busyIntervals));
    const conn = createGoogleConnector({
      adapter,
      egress: makeAllowGuard(),
      token: "t",
      findings: [],
    });
    const result = await conn.readFreeBusy({
      windowStartIso: "2026-06-30T08:00:00.000Z",
      windowEndIso: "2026-06-30T18:00:00.000Z",
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.startIso).toBe("2026-06-30T11:00:00.000Z");
  });
});

// ── sc-3-6: error sanitization ────────────────────────────────────────

describe("sc-3-6: error sanitization — tokens never in thrown messages", () => {
  it("sanitizeCalendarError redacts KEY=VALUE env assignments", () => {
    const msg = "GOOGLE_TOKEN=supersecret_value failed: 500";
    const sanitized = sanitizeCalendarError(msg);
    expect(sanitized).not.toContain("supersecret_value");
    expect(sanitized).toContain("[redacted]");
  });

  it("sanitizeCalendarError is idempotent on a message with no KEY=VALUE", () => {
    const msg = "connection refused: localhost:8080";
    expect(sanitizeCalendarError(msg)).toBe(msg);
  });

  it("writeEvents rethrows sanitized error when adapter.callTool rejects", async () => {
    const adapter = makeAdapter();
    (adapter.callTool as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("GOOGLE_TOKEN=supersecret_token_value 500 Internal Server Error"),
    );
    const conn = createGoogleConnector({
      adapter,
      egress: makeAllowGuard(),
      token: "t",
      findings: [makeFinding()],
    });
    let thrownMsg = "";
    try {
      await conn.writeEvents([
        { findingId: "f1", title: "x", startIso: "2026-06-30T09:00:00Z", endIso: "2026-06-30T09:30:00Z" },
      ]);
    } catch (e) {
      thrownMsg = e instanceof Error ? e.message : String(e);
    }
    expect(thrownMsg).not.toContain("supersecret_token_value");
    expect(thrownMsg).toContain("[redacted]");
  });

  it("readFreeBusy rethrows sanitized error when adapter.callTool rejects", async () => {
    const adapter = makeAdapter();
    (adapter.callTool as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("API_KEY=another_secret_key_value network timeout"),
    );
    const conn = createGoogleConnector({
      adapter,
      egress: makeAllowGuard(),
      token: "t",
      findings: [],
    });
    let thrownMsg = "";
    try {
      await conn.readFreeBusy({
        windowStartIso: "2026-06-30T08:00:00Z",
        windowEndIso: "2026-06-30T18:00:00Z",
      });
    } catch (e) {
      thrownMsg = e instanceof Error ? e.message : String(e);
    }
    expect(thrownMsg).not.toContain("another_secret_key_value");
    expect(thrownMsg).toContain("[redacted]");
  });
});

// ── sc-3-6: source/doc scan — unattended OAuth caveat ────────────────

describe("sc-3-6: unattended-OAuth caveat present in source and docs", () => {
  it("google-connector.ts source mentions unattended and cron", async () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = await readFile(join(dir, "google-connector.ts"), "utf8");
    expect(src).toMatch(/unattended/i);
    expect(src).toMatch(/cron/i);
  });

  it("google-connector.ts source mentions .ics fallback", async () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = await readFile(join(dir, "google-connector.ts"), "utf8");
    expect(src).toMatch(/\.ics/);
  });

  it("docs/calendar.md mentions unattended runs", async () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const docsPath = join(dir, "../../docs/calendar.md");
    const doc = await readFile(docsPath, "utf8");
    expect(doc).toMatch(/unattended/i);
  });

  it("docs/calendar.md mentions cron", async () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const docsPath = join(dir, "../../docs/calendar.md");
    const doc = await readFile(docsPath, "utf8");
    expect(doc).toMatch(/cron/i);
  });

  it("docs/calendar.md recommends the .ics fallback", async () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const docsPath = join(dir, "../../docs/calendar.md");
    const doc = await readFile(docsPath, "utf8");
    expect(doc).toMatch(/\.ics/);
  });
});

// ── name property ─────────────────────────────────────────────────────

describe("connector name", () => {
  it("name is 'google'", () => {
    const conn = createGoogleConnector({
      adapter: makeAdapter(),
      egress: makeAllowGuard(),
      token: "t",
      findings: [],
    });
    expect(conn.name).toBe("google");
  });
});
