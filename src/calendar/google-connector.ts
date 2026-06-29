/**
 * Google Calendar connector — implements CalendarConnector via external MCP subprocess.
 *
 * SECURITY NOTICES:
 * - Requires calendar.egress.cloudCalendar: true (fail-closed; default false).
 * - Requires a provisioned 0600 token sidecar (.bober/calendar/google-token.json).
 * - ONLY finding.calendarSafeTitle (or the generic "Focus block") leaves the device.
 *   NEVER use PlanItem.title — it falls back to the full Finding.title (see slotter.ts:209).
 * - Errors are sanitized: KEY=VALUE env assignments are redacted before throw.
 *
 * UNATTENDED / CRON WARNING:
 * Hosted OAuth is UNFIT for unattended or cron-scheduled runs because tokens expire
 * and interactive re-authorization is required. For scheduled use, choose the local
 * .ics fallback: `bober calendar plan --export-ics` (Sprint 2, zero-egress).
 *
 * The GoogleCalendarToolAdapter interface is the injection surface — ExternalMcpServer
 * satisfies it structurally in production; tests inject a stub (no live OAuth/network in CI).
 */

import { z } from "zod";
import type { Finding, BusyInterval, PlanItem } from "./types.js";
import type { CalendarConnector, FreeBusyWindow, WriteResult } from "./connector.js";
import type { CalendarEgressGuard } from "./calendar-egress.js";
import type { ToolDescriptor } from "../mcp/external-client.js";

// ── Injection surface ─────────────────────────────────────────────────

/**
 * Minimal adapter interface the Google connector requires.
 * ExternalMcpServer satisfies this structurally; tests inject a hand-rolled stub.
 */
export interface GoogleCalendarToolAdapter {
  listTools(): Promise<ToolDescriptor[]>;
  callTool(name: string, args: unknown): Promise<unknown>;
}

// ── Error sanitization (replicates external-client.ts:69) ─────────────

/**
 * Strip KEY=VALUE env assignments so tokens never surface in error messages.
 * Replicated inline — do NOT import from src/hub (calendar avoids cross-spec coupling;
 * see types.ts:7-11). Matches src/mcp/external-client.ts:69 exactly.
 */
export function sanitizeCalendarError(msg: string): string {
  return msg.replace(/\b[A-Z_][A-Z0-9_]*=\S+/g, "[redacted]");
}

// ── BusyInterval Zod schema (for runtime parse of adapter response) ────

const BusyIntervalSchema = z.object({
  startIso: z.string(),
  endIso: z.string(),
});

// ── Internal helpers ──────────────────────────────────────────────────

/** Generic placeholder title used when a finding has no calendarSafeTitle. */
const PLACEHOLDER_TITLE = "Focus block";

/** Default tool names; overridable via opts for server-specific naming. */
const DEFAULT_FREE_BUSY_TOOL = "google_calendar_get_free_busy";
const DEFAULT_WRITE_EVENT_TOOL = "google_calendar_create_event";

/**
 * Parse the callTool result — tolerates both the SDK envelope shape
 * { content: [{ text: "..." }] } and a raw JSON string / array.
 * Mirrors src/vault/mcp-adapter.ts:94-101.
 */
function extractText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  const envelope = raw as { content?: Array<{ text?: string }> };
  if (Array.isArray(envelope.content) && envelope.content[0]?.text != null) {
    return envelope.content[0].text as string;
  }
  // Fallback: JSON-serialise and let the caller parse
  return JSON.stringify(raw);
}

// ── Factory ───────────────────────────────────────────────────────────

export interface GoogleConnectorOptions {
  /** Injected MCP adapter — stub in tests, ExternalMcpServer in production. */
  adapter: GoogleCalendarToolAdapter;
  /** Egress guard constructed from BoberConfig. */
  egress: CalendarEgressGuard;
  /**
   * OAuth token read from the 0600 sidecar.
   * When undefined the connector refuses with a clear message + .ics suggestion.
   */
  token: string | undefined;
  /**
   * Source findings — the ONLY source of truth for calendarSafeTitle.
   * NEVER use PlanItem.title for cloud event summaries.
   */
  findings: Finding[];
  /** Override the free/busy tool name (default: google_calendar_get_free_busy). */
  freeBusyTool?: string;
  /** Override the write-event tool name (default: google_calendar_create_event). */
  writeEventTool?: string;
}

/**
 * Create a Google Calendar connector implementing CalendarConnector.
 *
 * The returned object is structurally interchangeable with createIcsConnector
 * (both satisfy CalendarConnector) so callers can swap connectors behind the
 * same interface (DoD sc-3-2).
 */
export function createGoogleConnector(opts: GoogleConnectorOptions): CalendarConnector {
  // Build safe-title lookup ONCE: findingId -> calendarSafeTitle (may be undefined).
  // This is the ONLY safe source for event summaries — do NOT use PlanItem.title.
  const safeTitleById = new Map<string, string | undefined>(
    opts.findings.map((f) => [f.id, f.calendarSafeTitle]),
  );

  const freeBusyToolName = opts.freeBusyTool ?? DEFAULT_FREE_BUSY_TOOL;
  const writeEventToolName = opts.writeEventTool ?? DEFAULT_WRITE_EVENT_TOOL;

  /**
   * Shared guard: egress check + token-present check.
   * MUST be called at the TOP of each public method, BEFORE any adapter call.
   * sc-3-3: when the axis is off, assertCloudCalendarAllowed() throws and the
   * adapter's listTools/callTool methods are never reached.
   */
  function guard(): void {
    opts.egress.assertCloudCalendarAllowed(); // throws naming calendar.egress.cloudCalendar
    if (opts.token === undefined) {
      throw new Error(
        "Google Calendar token absent — provision the 0600 sidecar at " +
          ".bober/calendar/google-token.json, or use the local .ics fallback " +
          "(`bober calendar plan --export-ics`) for unattended/cron runs.",
      );
    }
  }

  return {
    name: "google",

    async readFreeBusy(window: FreeBusyWindow): Promise<BusyInterval[]> {
      guard(); // BEFORE any adapter call (sc-3-3)
      try {
        const raw = await opts.adapter.callTool(freeBusyToolName, {
          timeMin: window.windowStartIso,
          timeMax: window.windowEndIso,
        });
        const text = extractText(raw);
        // Parse and validate against BusyInterval shape
        const parsed = JSON.parse(text) as unknown;
        const intervals = z.array(BusyIntervalSchema).parse(parsed);
        return intervals;
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        throw new Error(`google free/busy failed: ${sanitizeCalendarError(m)}`, { cause: err }); // sc-3-6
      }
    },

    async writeEvents(items: PlanItem[]): Promise<WriteResult> {
      guard(); // BEFORE any adapter call (sc-3-3)
      let written = 0;
      try {
        for (const item of items) {
          // sc-3-4: ONLY calendarSafeTitle from the findings map may leave the device.
          // Never item.title — slotter sets it to calendarSafeTitle ?? finding.title,
          // so it may contain the full sensitive title.
          const summary =
            safeTitleById.get(item.findingId) ??
            item.calendarSafeTitle ??
            PLACEHOLDER_TITLE;

          await opts.adapter.callTool(writeEventToolName, {
            summary, // the ONLY field that originates from Finding; no evidence/tags/full-title
            start: item.startIso,
            end: item.endIso,
          });
          written++;
        }
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        throw new Error(`google write failed: ${sanitizeCalendarError(m)}`, { cause: err }); // sc-3-6
      }
      return { writtenCount: written, target: "google" };
    },
  };
}
