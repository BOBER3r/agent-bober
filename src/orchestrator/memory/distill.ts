/**
 * PURE deterministic distillation of sprint history into LessonEntry records.
 *
 * PURE — must not import from ../providers; no network, no Date.now(), no side effects.
 * createdAt is stamped at PERSIST TIME by the CLI handler, not here.
 * lessonId is a sha256 content-hash of category+tags+sourceEntryRefs — never derived from time.
 */

import { createHash } from "node:crypto";

import type { HistoryEntry } from "../../state/history.js";
import type { SprintContract } from "../../contracts/sprint-contract.js";
import type { LessonEntry } from "../../state/memory.js";

// ── Constants ───────────────────────────────────────────────────────

/** Sprints whose iterationHistory.length is >= this are flagged as high-churn. */
const ITERATION_THRESHOLD = 3;

/** createdAt sentinel used internally so distill() returns LessonEntry-shaped objects.
 *  The CLI handler MUST overwrite this with the real wall-clock ISO string before
 *  calling appendLesson — this value is intentionally invalid as a real timestamp
 *  so that if it ever leaks to persistence it will fail LessonEntrySchema validation. */
const SENTINEL_CREATED_AT = "1970-01-01T00:00:00.000Z";

// ── Types ────────────────────────────────────────────────────────────

/** Internal accumulator for a failure signature group. */
interface FailureGroup {
  category: string;
  tags: string[];
  summary: string;
  sourceEntryRefs: Set<string>;
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Derive a deterministic 16-char hex lessonId from the failure signature.
 * Sorts tags and refs before hashing so ordering does not affect the id.
 */
function lessonIdFromSignature(
  category: string,
  tags: string[],
  refs: string[],
): string {
  const canonical = JSON.stringify({
    category,
    tags: [...tags].sort(),
    refs: [...refs].sort(),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** Map occurrence count to severity band. */
function severityFor(occurrences: number): "info" | "warn" | "high" {
  if (occurrences >= 5) return "high";
  if (occurrences >= 3) return "warn";
  return "info";
}

/**
 * Build a deterministic stable reference for a HistoryEntry.
 * Prefers sprintId; falls back to a composite of phase:event:timestamp.
 */
function entryRef(entry: HistoryEntry): string {
  if (entry.sprintId) {
    return `${entry.sprintId}:${entry.phase}:${entry.event}`;
  }
  return `${entry.phase}:${entry.event}:${entry.timestamp}`;
}

// ── Core ─────────────────────────────────────────────────────────────

/**
 * Pure, side-effect-free distillation of sprint history into LessonEntry records.
 *
 * Derives lessons from structured fields only:
 *   1. History entries with phase="failed" — grouped by event string.
 *   2. History entries whose details.criterionId (or details.verificationMethod) signals
 *      a repeated failing eval strategy — grouped by verificationMethod.
 *   3. Contracts whose iterationHistory.length >= ITERATION_THRESHOLD — grouped as high-churn.
 *
 * The returned array is sorted by lessonId for byte-identical output across calls.
 * The `createdAt` field is set to SENTINEL_CREATED_AT — the CLI handler MUST
 * replace it with the real wall-clock ISO string before persisting.
 */
export function distill(
  history: HistoryEntry[],
  contracts: SprintContract[],
): LessonEntry[] {
  // Key → accumulator map; key is "category:tag0:tag1..."  (canonical)
  const groups = new Map<string, FailureGroup>();

  function upsertGroup(
    category: string,
    tags: string[],
    summary: string,
    ref: string,
  ): void {
    const sortedTags = [...tags].sort();
    const key = `${category}|${sortedTags.join(",")}`;
    let group = groups.get(key);
    if (!group) {
      group = { category, tags: sortedTags, summary, sourceEntryRefs: new Set() };
      groups.set(key, group);
    }
    group.sourceEntryRefs.add(ref);
  }

  // ── 1. Phase=failed history entries ────────────────────────────────
  for (const entry of history) {
    if (entry.phase === "failed") {
      const category = "sprint-failed";
      const tags = ["phase:failed", `event:${entry.event}`];
      const summary = `Sprint repeatedly failed during phase '${entry.phase}': event '${entry.event}'`;
      upsertGroup(category, tags, summary, entryRef(entry));
    }
  }

  // ── 2. Repeated failing eval strategies from history details ────────
  for (const entry of history) {
    // Look for details.verificationMethod (set by eval result events)
    const vm = entry.details["verificationMethod"];
    const criterionId = entry.details["criterionId"];
    const result = entry.details["result"];

    if (
      typeof vm === "string" &&
      vm.length > 0 &&
      result === "fail"
    ) {
      const category = `eval-fail:${vm}`;
      const tags = [
        `verificationMethod:${vm}`,
        ...(typeof criterionId === "string" ? [`criterionId:${criterionId}`] : []),
      ];
      const summary = `Repeated eval failure using verification method '${vm}'${typeof criterionId === "string" ? ` on criterion '${criterionId}'` : ""}`;
      upsertGroup(category, tags, summary, entryRef(entry));
    }

    // Also handle phase=evaluating + event=eval_failed
    if (
      entry.phase === "evaluating" &&
      entry.event === "eval_failed"
    ) {
      const failedCriterionId = entry.details["criterionId"];
      const method = entry.details["verificationMethod"] ?? "unknown";
      const category = `eval-fail:${String(method)}`;
      const tags = [
        `verificationMethod:${String(method)}`,
        ...(typeof failedCriterionId === "string" ? [`criterionId:${failedCriterionId}`] : []),
      ];
      const summary = `Repeated eval failure during evaluating phase${typeof failedCriterionId === "string" ? ` for criterion '${failedCriterionId}'` : ""}`;
      upsertGroup(category, tags, summary, entryRef(entry));
    }
  }

  // ── 3. High-churn sprints (iterationHistory.length >= threshold) ────
  for (const contract of contracts) {
    if (contract.iterationHistory.length >= ITERATION_THRESHOLD) {
      const category = "high-churn-sprint";
      const tags = [
        "phase:rework",
        `sprintId:${contract.contractId}`,
      ];
      const summary = `Sprint '${contract.contractId}' required ${contract.iterationHistory.length} iterations (threshold: ${ITERATION_THRESHOLD})`;
      const ref = `${contract.contractId}:iteration-history`;
      upsertGroup(category, tags, summary, ref);
    }
  }

  // ── Build LessonEntry array ──────────────────────────────────────────
  const lessons: LessonEntry[] = [];

  for (const group of groups.values()) {
    const refs = [...group.sourceEntryRefs].sort();
    // Enforce non-empty sourceEntryRefs (schema invariant)
    if (refs.length === 0) continue;

    const occurrences = refs.length;
    const lessonId = lessonIdFromSignature(group.category, group.tags, refs);
    const severity = severityFor(occurrences);

    lessons.push({
      lessonId,
      createdAt: SENTINEL_CREATED_AT,
      category: group.category,
      tags: group.tags,
      summary: group.summary,
      occurrences,
      severity,
      sourceEntryRefs: refs,
    });
  }

  // Sort by lessonId for deterministic, byte-identical output
  lessons.sort((a, b) => a.lessonId.localeCompare(b.lessonId));

  return lessons;
}
