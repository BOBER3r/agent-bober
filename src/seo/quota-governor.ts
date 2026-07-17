/**
 * SeoQuotaGovernor — the cost/quota safety layer gating the live GSC and
 * DataForSEO adapters (spec-20260715-ultimate-seo-suite, Sprint 7; wired
 * into adapters in sprints 8-9, NOT this sprint).
 *
 * `admit(req)` is SYNCHRONOUS, NEVER throws, and has NO side effect on
 * either outcome (refuse or admit) — only `record()`, called by the caller
 * AFTER a real successful API round-trip, advances any counter (in-memory
 * rate-window timestamps or the persisted ledger). This mirrors the
 * `SeoEgressGuard` guard-class shape (`src/seo/egress.ts:19-57`).
 *
 * Two kinds of state:
 *  - In-memory rolling QPM windows (per-instance, ephemeral, NOT persisted;
 *    reset on process restart — acceptable because the hard daily/USD
 *    ceilings below are what must survive across processes).
 *  - The persisted `.bober/seo/quota-ledger.json` (daily rows / URL
 *    inspections / USD spend), read via `quota-ledger.ts` and shared by
 *    every `SeoQuotaGovernor` instance pointed at the same path through the
 *    module-scoped per-path mutex in `withLedgerLock` — this is what makes
 *    `record()` never lose a concurrent update (sc-7-3).
 *
 * Fail-closed: an unreadable/corrupt ledger is treated as at-ceiling for
 * every persisted counter (rows/URL-inspections/spend read back as
 * `Infinity`), so any COSTED request touching that counter is refused
 * (sc-7-4). A MISSING ledger (first run / offline) is a fresh `{}` — allow.
 *
 * Pinned caps (research §4, exact numbers — DO NOT approximate):
 *  - GSC Search Analytics: 1,200 QPM per-site AND 1,200 QPM per-user
 *    (two independent rolling windows), 50,000 rows/day per search type.
 *  - GSC URL Inspection: 2,000 queries/day/property, 600 QPM.
 *  - DataForSEO: caller-supplied `estCostUsd`/actual cost booked against
 *    `config.seo.budget.maxUsd` (`null`/absent = uncapped, mirrors
 *    `src/orchestrator/workflow/budget.ts:99-104,148-150`).
 */

import type { BoberConfig } from "../config/schema.js";
import type { SeoCapability } from "./data-source.js";
import type { SeoQuotaLedger } from "./types.js";
import { dateKey, scopeKey, readLedger, writeLedgerAtomic, withLedgerLock } from "./quota-ledger.js";

// -- Pinned caps (research §4) -------------------------------------------

const GSC_QPM = 1_200; // Search Analytics: 1,200 QPM, per-site AND per-user (separate windows).
const GSC_ROWS_PER_DAY = 50_000; // Search Analytics: 50,000 rows/day per search type.
const GSC_URL_INSPECT_PER_DAY = 2_000; // URL Inspection: 2,000 queries/day/property.
const GSC_URL_INSPECT_QPM = 600; // URL Inspection: 600 QPM.
const WINDOW_MS = 60_000; // Rolling one-minute QPM window.

// -- Public types ---------------------------------------------------------

/** One gated request. `capability` defaults to `"search-analytics"` for `source: "gsc"` when omitted. */
export type QuotaRequest = {
  // "ai-visibility" widened in spec-20260717-seo-improver-builder Sprint 5 —
  // additive only; admit()/record() only special-case "gsc", so
  // "ai-visibility" (like "dataforseo") naturally takes the USD-only branch
  // below (no GSC daily-rows/rate-window cap applies).
  source: "gsc" | "dataforseo" | "ai-visibility";
  /** GSC caps are modeled per-site AND per-user separately (research §4) — supply what you have. */
  scope: { siteUrl?: string; userId?: string };
  /** Which GSC/DataForSEO capability this call exercises; required to pick daily-rows vs url-inspection-cap. */
  capability?: SeoCapability;
  /** Rows this call will consume against the daily row / URL-inspection ceiling. 0 for calls that consume none. */
  estRows: number;
  /** Estimated USD cost, booked against `config.seo.budget.maxUsd` in `admit()`. 0 for free (GSC) calls. */
  estCostUsd: number;
};

export type QuotaRefusalReason = "rate-window" | "daily-rows" | "url-inspection-cap" | "budget-exceeded";

export type QuotaDecision = { admit: true } | { admit: false; reason: QuotaRefusalReason };

// -- Governor ---------------------------------------------------------------

/**
 * bober: in-memory rolling-window arrays keyed by site/user string; fine at
 *        the QPM scale this governs (a handful of timestamps per key per
 *        minute) — swap for a proper token-bucket structure if the number
 *        of distinct sites/users governed by one process ever gets large.
 */
export class SeoQuotaGovernor {
  /** In-memory-only; NOT persisted. Populated exclusively by `record()`. */
  private readonly searchAnalyticsSiteWindows = new Map<string, number[]>();
  private readonly searchAnalyticsUserWindows = new Map<string, number[]>();
  private readonly urlInspectionSiteWindows = new Map<string, number[]>();

  private constructor(
    private readonly ledgerPath: string,
    private readonly maxUsd: number | null,
    private ledger: SeoQuotaLedger | "corrupt",
  ) {}

  /** Load a governor bound to `ledgerPath`, reading its current state and `config.seo.budget.maxUsd`. */
  static async load(ledgerPath: string, config: BoberConfig): Promise<SeoQuotaGovernor> {
    const maxUsd = config.seo?.budget?.maxUsd ?? null; // null/absent = uncapped
    const ledger = await readLedger(ledgerPath); // "corrupt" sentinel propagates fail-closed
    return new SeoQuotaGovernor(ledgerPath, maxUsd, ledger);
  }

  /**
   * Decide whether `req` may proceed. SYNCHRONOUS, NEVER throws, and has
   * NO side effect on either branch — callers must call `record()`
   * themselves after a real successful API round-trip.
   */
  admit(req: QuotaRequest): QuotaDecision {
    try {
      const capability = effectiveCapability(req);

      // 1. Rolling QPM window(s) — in-memory, ephemeral, advanced only by record().
      if (req.source === "gsc") {
        if (capability === "url-inspection") {
          if (!this.hasWindowHeadroom(this.urlInspectionSiteWindows, req.scope.siteUrl ?? "", GSC_URL_INSPECT_QPM)) {
            return { admit: false, reason: "rate-window" };
          }
        } else {
          if (!this.hasWindowHeadroom(this.searchAnalyticsSiteWindows, req.scope.siteUrl ?? "", GSC_QPM)) {
            return { admit: false, reason: "rate-window" };
          }
          if (!this.hasWindowHeadroom(this.searchAnalyticsUserWindows, req.scope.userId ?? "", GSC_QPM)) {
            return { admit: false, reason: "rate-window" };
          }
        }
      }

      // 2. Persisted daily caps — fail-closed to Infinity when the ledger is corrupt.
      if (req.source === "gsc") {
        const sk = scopeKey(req.scope);
        if (capability === "url-inspection") {
          if (this.urlInspectionsToday(sk) + req.estRows > GSC_URL_INSPECT_PER_DAY) {
            return { admit: false, reason: "url-inspection-cap" };
          }
        } else {
          if (this.rowsToday(sk) + req.estRows > GSC_ROWS_PER_DAY) {
            return { admit: false, reason: "daily-rows" };
          }
        }
      }

      // 3. USD budget — skipped entirely when uncapped (maxUsd === null).
      if (this.maxUsd !== null && this.spentUsd() + req.estCostUsd > this.maxUsd) {
        return { admit: false, reason: "budget-exceeded" };
      }

      return { admit: true };
    } catch {
      // Defensive: admit() must never throw. Any unexpected failure fails closed.
      return { admit: false, reason: "budget-exceeded" };
    }
  }

  /**
   * Persist a completed call. Only ever called AFTER `admit()` returned
   * `{ admit: true }` and the real API call succeeded. Advances the
   * in-memory rate window for this instance and the shared persisted
   * ledger via the atomic, mutex-serialized read-modify-write in
   * `quota-ledger.ts` — concurrent `record()` calls across governor
   * instances sharing `ledgerPath` never lose an update (sc-7-3).
   */
  async record(req: QuotaRequest, actualCostUsd: number): Promise<void> {
    const capability = effectiveCapability(req);
    const now = Date.now();

    if (req.source === "gsc") {
      if (capability === "url-inspection") {
        this.pushTimestamp(this.urlInspectionSiteWindows, req.scope.siteUrl ?? "", now);
      } else {
        this.pushTimestamp(this.searchAnalyticsSiteWindows, req.scope.siteUrl ?? "", now);
        this.pushTimestamp(this.searchAnalyticsUserWindows, req.scope.userId ?? "", now);
      }
    }

    await withLedgerLock(this.ledgerPath, async () => {
      const fresh = await readLedger(this.ledgerPath); // read fresh from disk INSIDE the lock
      const ledger: SeoQuotaLedger = fresh === "corrupt" ? {} : fresh; // record() heals; corruption blocks admit, not record
      const dk = dateKey(new Date());
      const sk = scopeKey(req.scope);
      const day = (ledger[dk] ??= { spentUsd: 0, scopes: {} });
      const scope = (day.scopes[sk] ??= { rowsToday: 0, urlInspectionsToday: 0 });

      // Guard NaN/negative cost (mirrors budget.ts:65-68) — never corrupt spentUsd.
      if (Number.isFinite(actualCostUsd) && actualCostUsd > 0) {
        day.spentUsd += actualCostUsd;
      }
      if (req.source === "gsc" && Number.isFinite(req.estRows) && req.estRows > 0) {
        if (capability === "url-inspection") {
          scope.urlInspectionsToday += req.estRows;
        } else {
          scope.rowsToday += req.estRows;
        }
      }

      await writeLedgerAtomic(this.ledgerPath, ledger);
      this.ledger = ledger; // refresh this instance's in-memory snapshot
    });
  }

  /** Cumulative persisted USD spend across all recorded days. `+Infinity` when the ledger is corrupt (at-ceiling). */
  spentUsd(): number {
    if (this.ledger === "corrupt") return Number.POSITIVE_INFINITY;
    return Object.values(this.ledger).reduce((sum, day) => sum + day.spentUsd, 0);
  }

  // -- Ledger read helpers (fail-closed to Infinity when corrupt) --------

  private rowsToday(sk: string): number {
    if (this.ledger === "corrupt") return Number.POSITIVE_INFINITY;
    return this.ledger[dateKey(new Date())]?.scopes[sk]?.rowsToday ?? 0;
  }

  private urlInspectionsToday(sk: string): number {
    if (this.ledger === "corrupt") return Number.POSITIVE_INFINITY;
    return this.ledger[dateKey(new Date())]?.scopes[sk]?.urlInspectionsToday ?? 0;
  }

  // -- In-memory rolling-window helpers ------------------------------------

  /** True when admitting one more call at `key` keeps the trailing `WINDOW_MS` count within `cap`. Read-only — no mutation. */
  private hasWindowHeadroom(windows: Map<string, number[]>, key: string, cap: number): boolean {
    const now = Date.now();
    const timestamps = windows.get(key) ?? [];
    const active = timestamps.filter((t) => now - t < WINDOW_MS);
    return active.length + 1 <= cap;
  }

  /** Advance the window for `key`: prune stale entries and append `now`. Only called from `record()`. */
  private pushTimestamp(windows: Map<string, number[]>, key: string, now: number): void {
    const active = (windows.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
    active.push(now);
    windows.set(key, active);
  }
}

// -- Internal --------------------------------------------------------------

/** GSC requests default to `"search-analytics"` when `capability` is omitted; DataForSEO requests have no GSC-specific default. */
function effectiveCapability(req: QuotaRequest): SeoCapability | undefined {
  if (req.capability) return req.capability;
  return req.source === "gsc" ? "search-analytics" : undefined;
}
