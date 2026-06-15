/**
 * PURE deterministic, STORE-ONLY retrieval of relevant project facts for the planner.
 *
 * Opens the FactStore once, reads active facts for the requested scope, then
 * performs all ranking in memory (pure). Mirrors the retrieve.ts pattern for lessons.
 *
 * PURE beyond the single store open/read/close — no network, no Date.now(), no LLM.
 */

import { FactStore, factsDbPath, ensureFactsDir } from "../../state/facts.js";
import type { FactRecord } from "../../state/facts.js";

// ── Constants ─────────────────────────────────────────────────────────

/** Default number of facts to return. */
const DEFAULT_TOP_K = 5;

/** Default character budget for the serialized planner block. */
const DEFAULT_CHAR_BUDGET = 1200;

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Tokenize a string into lowercase alphanumeric tokens.
 * COPIED verbatim from retrieve.ts:30-35 (not exported there).
 * Splits on any non-alphanumeric character and filters empty tokens.
 */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * Score a FactRecord against a set of lowercased keyword tokens.
 * Counts shared tokens across subject, predicate, and value.
 * Returns 0 if there is no overlap.
 */
function scoreFact(record: FactRecord, keywordTokens: Set<string>): number {
  if (keywordTokens.size === 0) return 0;

  const recordTokens = new Set<string>([
    ...tokenize(record.subject),
    ...tokenize(record.predicate),
    ...tokenize(record.value),
  ]);

  let count = 0;
  for (const t of keywordTokens) {
    if (recordTokens.has(t)) {
      count++;
    }
  }
  return count;
}

// ── Core ──────────────────────────────────────────────────────────────

/**
 * Load and rank at most `topK` active facts from the store that are relevant
 * to the given `keywords` and `scope`.
 *
 * ONE store open/read/close, then pure ranking. Scope isolation is enforced by
 * the SQL WHERE clause in FactStore.getActiveFacts(scope) — facts in scope A
 * NEVER surface when querying scope B.
 *
 * Scoring: deterministic token-overlap between lowercased keyword tokens and
 * each record's subject + predicate + value tokens.
 * Sort: score DESC, then id ASC (byte-stable tiebreak, mirrors retrieve.ts:103).
 *
 * Design note: when keywords is empty, keywordTokens.size === 0, scoreFact
 * returns 0 for all records, and the score > 0 filter yields an empty result.
 * This matches retrieve.ts behaviour. Project facts are few and always written
 * with known predicates, so callers should pass relevant keywords (e.g. from
 * the user prompt) to surface them.
 *
 * @param projectRoot - Absolute path to the project root containing .bober/
 * @param scope       - Fact scope (e.g. "" for default/programming team)
 * @param keywords    - Keywords to rank against (e.g. from the user prompt)
 * @param options     - topK cap and optional namespace (selects DB file location)
 */
export async function retrieveRelevantFacts(
  projectRoot: string,
  scope: string,
  keywords: string[],
  {
    topK = DEFAULT_TOP_K,
    namespace,
  }: { topK?: number; namespace?: string } = {},
): Promise<FactRecord[]> {
  await ensureFactsDir(projectRoot, namespace);
  const store = new FactStore(factsDbPath(projectRoot, namespace));
  try {
    // Scope-isolated by SQL WHERE scope = ? AND t_invalidated IS NULL
    const records = store.getActiveFacts(scope);
    const keywordTokens = new Set(keywords.flatMap(tokenize));

    const scored = records
      .map((r) => ({ r, score: scoreFact(r, keywordTokens) }))
      .filter((x) => x.score > 0); // non-matching keyword → empty (mirrors retrieve.ts:96)

    // Sort: score DESC, then id ASC (byte-stable final tiebreak)
    scored.sort(
      (a, b) =>
        b.score - a.score ||                      // 1. token overlap (DOMINANT)
        a.r.id.localeCompare(b.r.id),             // 2. byte-stable final tiebreak
    );

    return scored.slice(0, topK).map((x) => x.r);
  } finally {
    store.close();
  }
}

/**
 * Render a compact planner context block from an array of FactRecord values.
 *
 * Mirrors serializeLessonsForPlanner (retrieve.ts:122-144):
 *   - Empty input → ""
 *   - Header line + one "- subject/predicate: value" line per fact
 *   - Hard charBudget slice (output length is GUARANTEED ≤ charBudget)
 *
 * @param records    - Already-ranked records (from retrieveRelevantFacts)
 * @param options    - charBudget: hard character limit (default DEFAULT_CHAR_BUDGET)
 * @returns Compact string block, at most charBudget characters
 */
export function serializeFactsForContext(
  records: FactRecord[],
  { charBudget = DEFAULT_CHAR_BUDGET }: { charBudget?: number } = {},
): string {
  if (records.length === 0) {
    return "";
  }

  const lines = [
    "## Project facts (durable semantic memory)",
    "",
    ...records.map((r) => `- ${r.subject}/${r.predicate}: ${r.value}`),
    "",
  ];

  const block = lines.join("\n");

  // Hard truncation to charBudget (sc-5-5 guarantee — never exceed budget)
  return block.slice(0, charBudget);
}
