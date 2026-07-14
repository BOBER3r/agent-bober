/** The single calendar abstraction both the .ics (Sprint 2) and Google (Sprint 3) connectors implement. */

import type { BusyInterval, PlanItem } from "./types.js";

// ── Connector contract ────────────────────────────────────────────────

/** The free/busy lookup window (subset of SlotConstraints — see types.ts:57). */
export interface FreeBusyWindow {
  windowStartIso: string;
  windowEndIso: string;
}

/** Outcome of writeEvents — what was written and where. */
export interface WriteResult {
  writtenCount: number;
  target: string;
}

/**
 * A calendar backend. The slotter/CLI depend ONLY on this interface so a second
 * connector can be added in Sprint 3 without touching the slotter (DoD).
 */
export interface CalendarConnector {
  readonly name: string;
  readFreeBusy(window: FreeBusyWindow): Promise<BusyInterval[]>;
  writeEvents(items: PlanItem[]): Promise<WriteResult>;
}
