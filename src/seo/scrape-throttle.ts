/**
 * ScrapeThrottle — per-engine scrape rate window + proxy-USD ledger,
 * SEPARATE from the governor USD ledger, SAME mutex + atomic-write +
 * fail-closed discipline as `SeoQuotaGovernor` (spec-20260718-in-house-
 * ai-visibility, Sprint 9; arch ScrapeThrottle §208-220 / ADR-3).
 *
 * The scrape arm's `estCostUsdPerPrompt` is booked as $0 to the
 * `SeoQuotaGovernor` — its real proxy cost is tracked HERE, in an
 * independent, independently-capped filesystem ledger keyed by engine
 * string at `.bober/seo/scrape-throttle-ledger.json` (a DISTINCT path
 * from `.bober/seo/quota-ledger.json`). The two ledgers are never
 * cross-reconciled (arch §320).
 *
 * `acquire(engine)` both DECIDES and CONSUMES a rate slot in one
 * read-modify-write under the shared per-path mutex (`withLedgerLock`,
 * reused from `quota-ledger.ts` — path-generic, so this ledger gets its
 * own serialization chain and cannot interfere with the governor's).
 * It writes ONLY on the granting branch — a refusal has no side effect,
 * mirroring `SeoQuotaGovernor.admit()`.
 *
 * `recordProxyCost(engine, usd)` is the governor's `record()` twin:
 * heals a corrupt ledger back to `{}`, accrues a NaN/negative-guarded
 * USD amount, and writes atomically (temp-file + rename) so a crash
 * mid-write never leaves a torn file.
 *
 * Fail-closed: a corrupt/unreadable ledger makes `acquire` treat proxy
 * spend as `+Infinity` (mirrors the governor's Infinity-on-corrupt
 * refuse) and deny with `reason: "proxy-budget"`. A MISSING ledger
 * (first run) is a fresh `{}` — allow.
 *
 * The clock is INJECTED (`() => ISO string`, mirrors
 * `DamcrawlerCrawlEngine.now`), never `Date.now()` — deterministic
 * rate-window tests drive it across the window boundary explicitly.
 *
 * ISOLATED sprint: no scrape-provider wiring (Sprint 10), no config-
 * schema field (caps come from the constructor), no egress coupling.
 */

import { readFile, writeFile, rename } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

import { ensureDir } from "../utils/fs.js";
import { withLedgerLock } from "./quota-ledger.js";

// -- Public types -----------------------------------------------------------

/** Persisted at `.bober/seo/scrape-throttle-ledger.json` — keyed by engine string. */
export type ScrapeProxyLedger = {
  [engine: string]: { windowStart: number; count: number; proxyUsdSpent: number };
};

/** `acquire()` decision. Note `proceed`, NOT `allowed` — per contract sc-9-1. */
export type ThrottleDecision = { proceed: true } | { proceed: false; reason: "rate-window" | "proxy-budget" };

/** Caps injected via constructor — no config-schema field this sprint (isolation). */
export type ScrapeThrottleLimits = {
  /** Max `acquire()` grants per rolling fixed window, per engine. */
  maxPerWindow: number;
  /** Fixed-window length in milliseconds. */
  windowMs: number;
  /** Max cumulative `proxyUsdSpent` per engine before `acquire` denies. */
  maxProxyUsd: number;
};

// -- Persistence helpers (mirror quota-ledger.ts, own shape) ----------------

/**
 * Read the scrape-throttle ledger from disk.
 *
 * - Missing file (ENOENT) => fresh empty ledger `{}` (offline/first-run, NOT corrupt).
 * - Existing-but-unreadable or unparseable JSON => `"corrupt"` sentinel so the
 *   caller can fail closed (treat proxy spend as at-ceiling).
 */
async function readScrapeLedger(path: string): Promise<ScrapeProxyLedger | "corrupt"> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return {};
    return "corrupt";
  }
  try {
    return JSON.parse(raw) as ScrapeProxyLedger;
  } catch {
    return "corrupt";
  }
}

/**
 * Atomically overwrite the scrape-throttle ledger: write a unique temp file,
 * then rename (POSIX-atomic) so a crash mid-write can never leave a torn file.
 */
async function writeScrapeLedgerAtomic(path: string, ledger: ScrapeProxyLedger): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(ledger, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  await rename(tmp, path);
}

// -- Throttle -----------------------------------------------------------------

export class ScrapeThrottle {
  constructor(
    private readonly ledgerPath: string,
    private readonly limits: ScrapeThrottleLimits,
    // Injected clock (ISO string, mirrors DamcrawlerCrawlEngine.now) — NEVER Date.now().
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * Decide whether `engine` may scrape now, consuming a rate slot on grant.
   * Read-modify-write under the per-path mutex; writes ONLY on the granting
   * branch (a refusal has no side effect on the ledger, mirroring
   * `SeoQuotaGovernor.admit()`/`record()` no-write-on-refuse).
   */
  async acquire(engine: string): Promise<ThrottleDecision> {
    return withLedgerLock(this.ledgerPath, async () => {
      const fresh = await readScrapeLedger(this.ledgerPath); // read fresh from disk INSIDE the lock

      if (fresh === "corrupt") {
        // Fail-closed: mirror the governor's Infinity-on-corrupt spend, which
        // trips the budget check rather than the rate-window check.
        return { proceed: false, reason: "proxy-budget" } as const;
      }

      const nowMs = new Date(this.now()).getTime();
      const existing = fresh[engine];
      const row = existing ? { ...existing } : { windowStart: nowMs, count: 0, proxyUsdSpent: 0 };

      // Fixed-window reset: once the window has elapsed, start a fresh one.
      if (nowMs - row.windowStart >= this.limits.windowMs) {
        row.windowStart = nowMs;
        row.count = 0;
      }

      if (row.proxyUsdSpent >= this.limits.maxProxyUsd) {
        return { proceed: false, reason: "proxy-budget" } as const;
      }
      if (row.count + 1 > this.limits.maxPerWindow) {
        return { proceed: false, reason: "rate-window" } as const;
      }

      row.count += 1;
      const ledger: ScrapeProxyLedger = { ...fresh, [engine]: row };
      await writeScrapeLedgerAtomic(this.ledgerPath, ledger);
      return { proceed: true } as const;
    });
  }

  /**
   * Persist completed proxy spend for `engine`. Heals a corrupt ledger back
   * to `{}` (corruption blocks `acquire`, not `recordProxyCost` — mirrors
   * `SeoQuotaGovernor.record()`). Guards NaN/negative/zero cost so a bad
   * value can never corrupt or reduce the running total. Concurrent calls
   * sharing `ledgerPath` never lose an update (per-path mutex + read-fresh-
   * inside-lock + atomic write).
   */
  async recordProxyCost(engine: string, usd: number): Promise<void> {
    await withLedgerLock(this.ledgerPath, async () => {
      const fresh = await readScrapeLedger(this.ledgerPath); // read fresh from disk INSIDE the lock
      const ledger: ScrapeProxyLedger = fresh === "corrupt" ? {} : fresh; // record() heals; corruption blocks acquire, not recordProxyCost
      const nowMs = new Date(this.now()).getTime();
      const row = (ledger[engine] ??= { windowStart: nowMs, count: 0, proxyUsdSpent: 0 });

      // Guard NaN/negative/zero cost (mirrors quota-governor.ts:180-182) — never corrupt proxyUsdSpent.
      if (Number.isFinite(usd) && usd > 0) {
        row.proxyUsdSpent += usd;
      }

      await writeScrapeLedgerAtomic(this.ledgerPath, ledger);
    });
  }
}
