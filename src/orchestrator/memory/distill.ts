/**
 * PURE deterministic distillation of sprint outcomes into LessonEntry records.
 *
 * PURE — must not import from ../providers; no network, no Date.now(), no side effects,
 * no filesystem access. createdAt is stamped at PERSIST TIME by the CLI handler, not here.
 * lessonId is a sha256 content-hash of category+tags+sourceEntryRefs — never derived from time.
 *
 * IMPORTANT — this distills from the data shapes the REAL pipeline actually produces, NOT
 * an invented vocabulary. The three signals are:
 *   (a) recurring failed-criterion categories  — from eval results' criteriaResults[].result==="fail",
 *       grouped by the criterion's verificationMethod (resolved from the owning contract).
 *   (b) repeated failing eval strategies        — from eval results' strategyResults[].result==="fail",
 *       grouped by strategy name.
 *   (c) sprints that needed rework              — from contract.iterationHistory entries whose
 *       result==="fail" (real shape: { iteration, evalId, result }), reinforced by history
 *       entries with phase==="rework" && event==="evaluation-failed".
 *
 * The eval-result inputs are read LENIENTLY (see DistillableEval) because the on-disk
 * .bober/eval-results/*.json files and the compiled EvalResultSchema use different shapes;
 * every field is optional and defensively narrowed.
 */

import { createHash } from "node:crypto";

import type { HistoryEntry } from "../../state/history.js";
import type { SprintContract } from "../../contracts/sprint-contract.js";
import type { LessonEntry } from "../../state/memory.js";

// ── Constants ───────────────────────────────────────────────────────

/** A sprint with at least this many failed iterations is flagged as needing rework. */
const REWORK_THRESHOLD = 1;

/** createdAt sentinel used internally so distill() returns LessonEntry-shaped objects.
 *  The CLI handler MUST overwrite this with the real wall-clock ISO string before
 *  calling appendLesson — this value is intentionally an epoch so that if it ever
 *  leaks to persistence it is obviously a placeholder. */
const SENTINEL_CREATED_AT = "1970-01-01T00:00:00.000Z";

// ── Types ────────────────────────────────────────────────────────────

/**
 * Lenient, structurally-typed view of an eval result for distillation.
 *
 * Unifies BOTH the on-disk .bober/eval-results/*.json shape
 * ({ overallResult, strategyResults, criteriaResults }) AND the compiled
 * EvalResultSchema shape ({ passed, criteriaResults }). Every field is optional;
 * distill never assumes a field is present.
 */
export interface DistillableEval {
  evalId?: string;
  contractId?: string;
  iteration?: number;
  /** on-disk variant: "pass" | "fail" */
  overallResult?: string;
  /** compiled-schema variant */
  passed?: boolean;
  criteriaResults?: Array<{
    criterionId?: string;
    result?: string;
    verificationMethod?: string;
  }>;
  strategyResults?: Array<{
    strategy?: string;
    result?: string;
  }>;
}

/** Internal accumulator for a failure-signature group. */
interface FailureGroup {
  category: string;
  tags: string[];
  summary: string;
  sourceEntryRefs: Set<string>;
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Narrow an unknown value to a string-keyed record. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

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

// ── Core ─────────────────────────────────────────────────────────────

/**
 * Pure, side-effect-free distillation of sprint outcomes into LessonEntry records.
 *
 * Derives lessons from structured fields only (see file header for the three signals).
 * The returned array is sorted by lessonId for byte-identical output across calls.
 * The `createdAt` field is set to SENTINEL_CREATED_AT — the CLI handler MUST
 * replace it with the real wall-clock ISO string before persisting.
 */
export function distill(
  history: HistoryEntry[],
  contracts: SprintContract[],
  evalResults: DistillableEval[] = [],
): LessonEntry[] {
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

  // Lookup: contractId -> (criterionId -> verificationMethod), resolved from the contract.
  const vmByContractCriterion = new Map<string, Map<string, string>>();
  for (const c of contracts) {
    const m = new Map<string, string>();
    for (const sc of c.successCriteria ?? []) {
      if (sc.criterionId && sc.verificationMethod) {
        m.set(sc.criterionId, sc.verificationMethod);
      }
    }
    vmByContractCriterion.set(c.contractId, m);
  }

  // ── (a) failed-criterion categories & (b) failing eval strategies ──────
  for (const ev of evalResults) {
    const evRef = ev.evalId ?? ev.contractId ?? "unknown-eval";

    // (b) repeated failing eval strategies (only present in the richer on-disk shape).
    for (const s of ev.strategyResults ?? []) {
      if (s?.result === "fail" && typeof s.strategy === "string" && s.strategy.length > 0) {
        const category = `eval-strategy-failure:${s.strategy}`;
        const tags = [`strategy:${s.strategy}`];
        const summary = `Eval strategy '${s.strategy}' failed across sprints — recurring failing gate`;
        upsertGroup(category, tags, summary, evRef);
      }
    }

    // (a) recurring failed-criterion categories, grouped by the criterion's verificationMethod.
    for (const cr of ev.criteriaResults ?? []) {
      if (cr?.result === "fail" && typeof cr.criterionId === "string" && cr.criterionId.length > 0) {
        const resolvedVm =
          (ev.contractId && vmByContractCriterion.get(ev.contractId)?.get(cr.criterionId)) ||
          cr.verificationMethod ||
          "unknown";
        const category = `failed-criterion:${resolvedVm}`;
        const tags = [`verificationMethod:${resolvedVm}`];
        const summary = `Success criteria verified by '${resolvedVm}' failed across sprints`;
        upsertGroup(category, tags, summary, `${evRef}:${cr.criterionId}`);
      }
    }
  }

  // ── (c) sprints that needed rework (from contract iterationHistory) ──────
  // Track which sprints we already counted from iterationHistory so the history
  // fallback below does not double-count the same sprint.
  const sprintsCountedFromContracts = new Set<string>();
  for (const contract of contracts) {
    const iters = Array.isArray(contract.iterationHistory)
      ? contract.iterationHistory
      : [];
    const failedRefs: string[] = [];
    for (const it of iters) {
      if (isRecord(it) && it["result"] === "fail") {
        const n = typeof it["iteration"] === "number" ? it["iteration"] : "?";
        failedRefs.push(`${contract.contractId}:iteration-${n}`);
      }
    }
    if (failedRefs.length >= REWORK_THRESHOLD) {
      sprintsCountedFromContracts.add(contract.contractId);
      const tags = ["phase:rework", `sprintId:${contract.contractId}`];
      const summary = `Sprint '${contract.contractId}' needed ${failedRefs.length} rework iteration(s) before passing`;
      for (const ref of failedRefs) {
        upsertGroup("sprint-rework", tags, summary, ref);
      }
    }
  }

  // ── (c, fallback) rework signal straight from history events ────────────
  // The real pipeline writes { event:"evaluation-failed", phase:"rework", sprintId, details:{iteration} }.
  // Only used for sprints not already accounted for via iterationHistory (avoids double-count).
  for (const entry of history) {
    if (entry.phase === "rework" && entry.event === "evaluation-failed") {
      const sid = entry.sprintId ?? "unknown";
      if (sprintsCountedFromContracts.has(sid)) continue;
      const iter = entry.details["iteration"];
      const refSuffix = typeof iter === "number" ? `iteration-${iter}` : entry.timestamp;
      const tags = ["phase:rework", `sprintId:${sid}`];
      const summary = `Sprint '${sid}' had a failed evaluation requiring rework`;
      upsertGroup("sprint-rework", tags, summary, `${sid}:${refSuffix}`);
    }
  }

  // ── Build LessonEntry array ──────────────────────────────────────────
  const lessons: LessonEntry[] = [];

  for (const group of groups.values()) {
    const refs = [...group.sourceEntryRefs].sort();
    // Enforce non-empty sourceEntryRefs (schema invariant).
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

  // Sort by lessonId for deterministic, byte-identical output.
  lessons.sort((a, b) => a.lessonId.localeCompare(b.lessonId));

  return lessons;
}
