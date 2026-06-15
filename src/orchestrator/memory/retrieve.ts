/**
 * PURE deterministic, INDEX-ONLY retrieval of relevant lessons for the planner.
 *
 * Reads only the bounded .bober/memory/INDEX.md (via loadLessonIndex) — never history.jsonl,
 * never per-lesson files. Scoring is deterministic lowercased token overlap; ties break on lessonId.
 *
 * PURE — no network, no Date.now(), no side effects. All fs access flows through loadLessonIndex.
 */

import { loadLessonIndex } from "../../state/memory.js";
import type { LessonIndexRecord } from "../../state/memory.js";

// ── Constants ───────────────────────────────────────────────────────

/** Default number of lessons to return. */
const DEFAULT_TOP_K = 5;

/** Default character budget for the serialized planner block. */
const DEFAULT_CHAR_BUDGET = 1200;

/** Maximum records to load from the index before scoring (bounded read). */
const INDEX_LOAD_LIMIT = 200;

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Tokenize a string into lowercase alphanumeric tokens.
 * Splits on any non-alphanumeric character and filters empty tokens.
 */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * Score a LessonIndexRecord against a set of lowercased keyword tokens.
 * Counts shared tokens across tags, category, and summarySnippet.
 * Returns 0 if there is no overlap (caller should filter these out).
 */
function scoreRecord(
  record: LessonIndexRecord,
  keywordTokens: Set<string>,
): number {
  if (keywordTokens.size === 0) return 0;

  const recordTokens = new Set<string>([
    ...tokenize(record.category),
    ...record.tags.flatMap(tokenize),
    ...tokenize(record.summarySnippet),
  ]);

  let count = 0;
  for (const token of keywordTokens) {
    if (recordTokens.has(token)) {
      count++;
    }
  }
  return count;
}

// ── Core ─────────────────────────────────────────────────────────────

/**
 * Load and rank at most `topK` lessons from the bounded index that are relevant
 * to the given `keywords`.
 *
 * Scoring is deterministic token-overlap between the lowercased keyword tokens
 * and each record's tags + category + summarySnippet. Ties break by lessonId
 * (ASC lexicographic) for byte-stable output.
 *
 * A non-matching keyword set (no overlap with any record) yields an empty result.
 *
 * @param projectRoot - Absolute path to the project root containing .bober/
 * @param keywords    - Keywords derived from the feature title/description
 * @param options     - topK cap (default 5) and optional charBudget (ignored here; passed to serializer)
 * @returns At most topK records sorted by relevance (descending), then lessonId (ascending)
 */
export async function retrieveRelevantLessons(
  projectRoot: string,
  keywords: string[],
  {
    topK = DEFAULT_TOP_K,
    charBudget: _charBudget,
    namespace,
  }: { topK?: number; charBudget?: number; namespace?: string } = {},
): Promise<LessonIndexRecord[]> {
  const records = await loadLessonIndex(projectRoot, { limit: INDEX_LOAD_LIMIT }, namespace);

  const keywordTokens = new Set(keywords.flatMap(tokenize));

  const scored = records
    .map((r) => ({ r, score: scoreRecord(r, keywordTokens) }))
    .filter((x) => x.score > 0); // C1: non-matching keyword -> empty

  // Sort: score DESC, then lessonId ASC for stable tiebreak
  scored.sort(
    (a, b) => b.score - a.score || a.r.lessonId.localeCompare(b.r.lessonId),
  );

  return scored.slice(0, topK).map((x) => x.r);
}

/**
 * Render a compact planner context block from an array of LessonIndexRecord values.
 *
 * Each lesson becomes one line:
 *   [<category>/<severity>] (x<occurrences>) tags: <t1,t2,...> — <summarySnippet>
 *
 * The block is prefixed with a header line and truncated to `charBudget` characters
 * (hard slice) so the planner always receives a predictably-bounded string.
 *
 * @param records     - Already-ranked records (from retrieveRelevantLessons)
 * @param options     - charBudget: hard character limit (default DEFAULT_CHAR_BUDGET)
 * @returns Compact string block, at most charBudget characters
 */
export function serializeLessonsForPlanner(
  records: LessonIndexRecord[],
  { charBudget = DEFAULT_CHAR_BUDGET }: { charBudget?: number } = {},
): string {
  if (records.length === 0) {
    return "";
  }

  const lines = [
    "## Lessons from past sprints (bounded memory index)",
    "",
    ...records.map(
      (r) =>
        `- [${r.category}/${r.severity}] (x${r.occurrences}) tags: ${r.tags.join(",")} — ${r.summarySnippet}`,
    ),
    "",
  ];

  const block = lines.join("\n");

  // Hard truncation to charBudget (C3 guarantee)
  return block.slice(0, charBudget);
}
