/**
 * reindex — reconcile-at-ingest index builder over VaultNote frontmatter.
 *
 * Walks a set of parsed VaultNotes, skips notes whose frontmatter.status is
 * SUPERSEDED_STATUS, maps surviving notes to FactInput records via noteToFacts,
 * and writes each fact through writeFact (the sanctioned reconcile-at-ingest path).
 *
 * PURE w.r.t. clock: accepts `now` as an injected ISO string — never calls
 * Date.now() or new Date() internally.
 *
 * bober: no judge is wired by default; ambiguous-key collisions fall back to
 *        deterministic ADD (reconcile.ts:93-96). Wire a judge via opts.judge
 *        if LLM-assisted conflict resolution is needed in a future sprint.
 */

import type { VaultNote } from "./types.js";
import type { FactStore, ReconcileAction } from "../state/facts.js";
import { writeFact } from "../state/facts.js";
import type { FactJudge } from "../orchestrator/memory/fact-judge.js";
import { noteToFacts } from "./index-map.js";
import { SUPERSEDED_STATUS } from "./conventions.js";

// ── Sprint 5 convergence: SUPERSEDED_STATUS is canonical in conventions.ts ───
export { SUPERSEDED_STATUS };

// ── Types ────────────────────────────────────────────────────────────────────

/** Summary of a reindex pass over a set of notes. */
export interface ReindexSummary {
  /** Number of notes actually indexed (excludes superseded notes). */
  notesParsed: number;
  /** Facts written for the first time (ReconcileAction === "add"). */
  factsAdded: number;
  /**
   * Facts whose value changed — prior row is superseded (ReconcileAction === "update").
   * Named "superseded" in the summary because update = supersede the prior fact.
   */
  factsSuperseded: number;
  /** Facts with an identical value already active — no write (ReconcileAction === "noop"). */
  factsNoop: number;
}

// ── Implementation ───────────────────────────────────────────────────────────

/**
 * Walk `notes`, skip superseded ones, map each surviving note's frontmatter to
 * FactInput records, and write them through `writeFact` (never store.insertFact).
 *
 * Returns a tally of actions taken across all facts in all indexed notes.
 *
 * @param store  Target FactStore — use new FactStore(':memory:') in tests.
 * @param notes  Parsed VaultNotes from Sprint-1 parseNote / note-io.
 * @param opts.scope        Fact scope label (e.g. "medical", "finance").
 * @param opts.now          Injected ISO-8601 wall-clock string; stamped on every
 *                          new FactInput as tValid and tCreated.
 * @param opts.sourceRunId  Optional run provenance tag; null when absent.
 * @param opts.judge        Optional LLM judge for ambiguous collisions; absent
 *                          = deterministic ADD fallback (reconcile.ts:93-96).
 */
export async function reindexNotes(
  store: FactStore,
  notes: VaultNote[],
  opts: {
    scope: string;
    now: string;
    sourceRunId?: string | null;
    judge?: FactJudge;
  },
): Promise<ReindexSummary> {
  const summary: ReindexSummary = {
    notesParsed: 0,
    factsAdded: 0,
    factsSuperseded: 0,
    factsNoop: 0,
  };

  for (const note of notes) {
    // Skip superseded notes — they contribute no active facts to the index.
    if (note.frontmatter.status === SUPERSEDED_STATUS) continue;

    summary.notesParsed++;
    const inputs = noteToFacts(note, {
      scope: opts.scope,
      now: opts.now,
      sourceRunId: opts.sourceRunId,
    });

    for (const input of inputs) {
      const action: ReconcileAction = await writeFact(store, input, {
        judge: opts.judge,
        now: opts.now,
      });

      if (action === "add") summary.factsAdded++;
      else if (action === "update") summary.factsSuperseded++;
      else if (action === "noop") summary.factsNoop++;
      // "delete" only occurs if judge returns delete; not counted in summary shape.
    }
  }

  return summary;
}
