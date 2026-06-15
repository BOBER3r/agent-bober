/**
 * PURE deterministic lesson hygiene: decay-based pruning + conflict quarantine.
 *
 * PURE — the clock is never read here; `now` is injected by the CLI handler
 * (mirrors reconcileFact's { now } pattern at reconcile.ts:54). Operates
 * ONLY on the fields each record carries; the CLI assembles recency input (createdAt)
 * by reading per-lesson files and passing it in via PrunableLesson.createdAt.
 *
 * Conflict detection: DETERMINISTIC — two lessons sharing the same contradiction key
 * (category root + discriminator tag) with opposing polarity markers are BOTH moved
 * to quarantine. No LLM.
 *
 * Decay: lessons below `minOccurrences` that are also older than `maxAgeMs` are
 * quarantined. Missing createdAt is treated as "maximally stale" (decays immediately
 * when occurrences are below threshold), which is conservative and documented here
 * as a deliberate choice — prefer to quarantine an unknown-age low-occurrence lesson
 * rather than silently keep it forever.
 */

import type { LessonIndexRecord } from "../../state/memory.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** Default age threshold for decay: 30 days in milliseconds. */
export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Polarity markers for conflict detection (keep vs. avoid). */
const KEEP_MARKERS = new Set(["keep", "stable", "pass", "trusted"]);
const AVOID_MARKERS = new Set(["avoid", "fragile", "fail", "untrusted"]);

// ── Types ────────────────────────────────────────────────────────────────────

/** A LessonIndexRecord enriched with CLI-derived recency proxy (ISO createdAt). */
export interface PrunableLesson extends LessonIndexRecord {
  /** ISO 8601 createdAt, assembled by the CLI from the per-lesson .md file. May be absent. */
  createdAt?: string;
}

export interface PruneOptions {
  /** Injected ISO wall-clock — NEVER read inside this module. */
  now: string;
  /**
   * Lessons with occurrences strictly below this value AND older than maxAgeMs
   * are quarantined as decayed. Default: 2.
   */
  minOccurrences?: number;
  /**
   * Age threshold in milliseconds. A lesson is considered stale when
   * (now - createdAt) > maxAgeMs. Default: 30 days.
   */
  maxAgeMs?: number;
}

export interface PruneResult {
  /** Lessons retained in INDEX.md. Sorted by lessonId ASC for byte-stability. */
  kept: PrunableLesson[];
  /** Lessons to be moved to QUARANTINE.md. Sorted by lessonId ASC for byte-stability. */
  quarantined: PrunableLesson[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Derive the category root from a category string (substring before the first ":").
 * e.g. "eval-strategy-failure:unit-test" → "eval-strategy-failure"
 *      "sprint-rework" → "sprint-rework"
 */
function categoryRoot(category: string): string {
  const idx = category.indexOf(":");
  return idx === -1 ? category : category.slice(0, idx);
}

/**
 * Extract the first discriminator tag from a tag list.
 * Priority: sprintId: > strategy: > verificationMethod:
 * Falls back to the first tag present, or empty string.
 */
function discriminatorTag(tags: string[]): string {
  for (const prefix of ["sprintId:", "strategy:", "verificationMethod:"]) {
    const found = tags.find((t) => t.startsWith(prefix));
    if (found !== undefined) return found;
  }
  return tags[0] ?? "";
}

/**
 * Extract the polarity marker from a tag list.
 * Returns "keep", "avoid", or "neutral" based on the first matching tag.
 */
function polarityOf(tags: string[]): "keep" | "avoid" | "neutral" {
  for (const tag of tags) {
    const bare = tag.toLowerCase();
    if (KEEP_MARKERS.has(bare)) return "keep";
    if (AVOID_MARKERS.has(bare)) return "avoid";
  }
  return "neutral";
}

/**
 * Build the contradiction key for conflict detection.
 * Two records with the same key and opposing polarity (keep vs. avoid) are conflicts.
 */
function contradictionKey(record: PrunableLesson): string {
  return `${categoryRoot(record.category)}|${discriminatorTag(record.tags)}`;
}

// ── Core ─────────────────────────────────────────────────────────────────────

/**
 * Partition lessons into kept vs. quarantined.
 *
 * Phase 1 (conflict detection): identifies deterministically contradictory pairs.
 *   A pair is contradictory when both records share the same contradiction key
 *   (category root + discriminator tag) AND carry opposing polarity markers
 *   (one "keep"-marked, one "avoid"-marked). BOTH are quarantined.
 *
 * Phase 2 (decay): for remaining records, quarantines those below `minOccurrences`
 *   that are also stale (createdAt older than maxAgeMs, or createdAt absent).
 *
 * Both output arrays are sorted by lessonId ASC for byte-identical repeated runs.
 *
 * @param records - Enriched lesson records (with optional createdAt from CLI)
 * @param opts.now - ISO 8601 wall-clock, injected — never read inside
 * @param opts.minOccurrences - Below-threshold occurrence count (default 2)
 * @param opts.maxAgeMs - Staleness threshold in ms (default 30 days)
 */
export function pruneLessons(
  records: PrunableLesson[],
  { now, minOccurrences = 2, maxAgeMs = THIRTY_DAYS_MS }: PruneOptions,
): PruneResult {
  const nowMs = Date.parse(now);

  // ── Phase 1: conflict detection ─────────────────────────────────────────
  // Group by contradiction key, collecting polarity.
  const byKey = new Map<string, { keeps: PrunableLesson[]; avoids: PrunableLesson[] }>();

  for (const rec of records) {
    const key = contradictionKey(rec);
    let bucket = byKey.get(key);
    if (bucket === undefined) {
      bucket = { keeps: [], avoids: [] };
      byKey.set(key, bucket);
    }
    const polarity = polarityOf(rec.tags);
    if (polarity === "keep") {
      bucket.keeps.push(rec);
    } else if (polarity === "avoid") {
      bucket.avoids.push(rec);
    }
    // "neutral" polarity: the record is bucketed but will not trigger a conflict on its own
  }

  // A conflict fires when a key has BOTH keep-marked AND avoid-marked records.
  const conflictIds = new Set<string>();
  for (const [, bucket] of byKey) {
    if (bucket.keeps.length > 0 && bucket.avoids.length > 0) {
      for (const r of [...bucket.keeps, ...bucket.avoids]) {
        conflictIds.add(r.lessonId);
      }
    }
  }

  // ── Phase 2: decay ───────────────────────────────────────────────────────
  const decayIds = new Set<string>();
  for (const rec of records) {
    if (conflictIds.has(rec.lessonId)) continue; // already quarantined by conflict
    if (rec.occurrences >= minOccurrences) continue; // well-established, keep

    // Below minOccurrences: quarantine if stale (or no age info → maximally stale).
    if (rec.createdAt === undefined) {
      // No age info = unknown = treat as maximally stale → quarantine
      decayIds.add(rec.lessonId);
      continue;
    }
    const ageMs = nowMs - Date.parse(rec.createdAt);
    if (ageMs > maxAgeMs) {
      decayIds.add(rec.lessonId);
    }
  }

  // ── Partition ────────────────────────────────────────────────────────────
  const quarantinedSet = new Set([...conflictIds, ...decayIds]);

  const kept: PrunableLesson[] = [];
  const quarantined: PrunableLesson[] = [];

  for (const rec of records) {
    if (quarantinedSet.has(rec.lessonId)) {
      quarantined.push(rec);
    } else {
      kept.push(rec);
    }
  }

  // Sort both arrays by lessonId for deterministic, byte-identical output.
  kept.sort((a, b) => a.lessonId.localeCompare(b.lessonId));
  quarantined.sort((a, b) => a.lessonId.localeCompare(b.lessonId));

  return { kept, quarantined };
}
