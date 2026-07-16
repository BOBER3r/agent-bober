/**
 * Persisted quota ledger — pure persistence + keying helpers, no quota
 * decision logic (that lives in `quota-governor.ts`).
 *
 * Layout: `.bober/seo/quota-ledger.json`.
 *
 * Every write is atomic via temp-file + rename (mirrors
 * `src/incident/timeline.ts:86-92` atomicWriteJson / `src/state/run-state.ts:41-52`).
 *
 * Concurrent read-modify-write calls to the SAME resolved path are serialized
 * via a module-scoped per-path promise-chain mutex (mirrors
 * `src/telemetry/emit.ts:57,85-86`) so two `SeoQuotaGovernor` instances
 * sharing a ledger path never lose an update.
 *
 * Fail-closed discrimination: a MISSING ledger (ENOENT) is a fresh, empty
 * ledger (offline / first-run => allow). An EXISTING-but-unparseable or
 * unreadable ledger is the `"corrupt"` sentinel (fail-closed => at-ceiling).
 * This is deliberately NOT the blanket catch used by `readRunState`
 * (`src/state/run-state.ts:61-68`), which collapses both cases to `null`.
 *
 * Sprint 7 — spec-20260715-ultimate-seo-suite.
 */

import { readFile, writeFile, rename } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";

import { ensureDir } from "../utils/fs.js";
import type { SeoQuotaLedger } from "./types.js";

// ── Keying helpers ───────────────────────────────────────────────────

/** `YYYY-MM-DD` date key; daily counters reset on this boundary. */
export function dateKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Composite per-site/per-user scope key (`${siteUrl}|${userId}`). */
export function scopeKey(scope: { siteUrl?: string; userId?: string }): string {
  return `${scope.siteUrl ?? ""}|${scope.userId ?? ""}`;
}

// ── Read ─────────────────────────────────────────────────────────────

/**
 * Read the ledger from disk.
 *
 * - Missing file (ENOENT) => fresh empty ledger `{}` (offline/first-run, NOT corrupt).
 * - Existing-but-unreadable (permissions, etc.) or unparseable JSON => `"corrupt"`
 *   sentinel so the caller can fail closed (treat spend as at-ceiling).
 */
export async function readLedger(path: string): Promise<SeoQuotaLedger | "corrupt"> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return {};
    return "corrupt";
  }
  try {
    return JSON.parse(raw) as SeoQuotaLedger;
  } catch {
    return "corrupt";
  }
}

// ── Write ────────────────────────────────────────────────────────────

/**
 * Atomically overwrite the ledger: write a unique temp file, then rename
 * (POSIX-atomic) so a crash mid-write can never leave a torn/corrupt file.
 */
export async function writeLedgerAtomic(path: string, ledger: SeoQuotaLedger): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(ledger, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  await rename(tmp, path);
}

// ── Per-path mutex ───────────────────────────────────────────────────

/**
 * Module-scoped chain of promises, one per resolved ledger path. ALL
 * `SeoQuotaGovernor` instances that share a ledger path serialize their
 * read-modify-write through this SAME chain, which is what guarantees
 * `record()` never loses a concurrent update (sc-7-3).
 */
const ledgerChains = new Map<string, Promise<void>>();

/**
 * Run `fn` exclusively with respect to any other `withLedgerLock` call on
 * the same resolved path. Chains onto the previous run regardless of
 * whether it resolved or rejected, so one failure never wedges the chain.
 */
export async function withLedgerLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(path);
  const prev = ledgerChains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  ledgerChains.set(
    key,
    run.then(
      () => {},
      () => {},
    ),
  );
  return run;
}
