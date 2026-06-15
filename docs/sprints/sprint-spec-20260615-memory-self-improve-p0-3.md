# Lesson hygiene — occurrence-weighted ranking, decay & conflict-quarantine

**Contract:** sprint-spec-20260615-memory-self-improve-p0-3  ·  **Spec:** spec-20260615-memory-self-improve-p0  ·  **Completed:** 2026-06-15

## What this sprint added

Closes the **monotonic-growth gap** in the distilled lessons store. Two changes:
(1) `retrieveRelevantLessons` ranking now factors **occurrences** as a tiebreaker, so a
more-often-seen lesson wins when two lessons have equal token overlap — token overlap stays
dominant, so the empty-on-no-match invariant (C1) is unchanged. (2) A new **pure hygiene
pass** (`pruneLessons`) partitions lessons into `{ kept, quarantined }` by a deterministic
**decay** score (occurrences + recency) *and* deterministic **conflict detection** (two
lessons sharing a contradiction key with opposing keep/avoid polarity → BOTH quarantined),
exposed as `bober memory prune`. Quarantine **never deletes** a per-lesson `.md` file — it
moves the literal `INDEX.md` line into `QUARANTINE.md` with provenance, so nothing is ever
destroyed. As with the rest of the memory layer, the clock is **injected**: the hygiene
module reads no wall-clock and the CLI stamps `now` at the handler boundary.

## Public surface

- `pruneLessons(records, { now, minOccurrences?, maxAgeMs? }): { kept, quarantined }` (`src/orchestrator/memory/hygiene.ts:127`) — PURE partition. Phase 1 quarantines deterministically contradictory pairs; Phase 2 quarantines below-`minOccurrences` (default 2) lessons that are also stale (older than `maxAgeMs`, default 30 days, or with no `createdAt` → treated as maximally stale). Both output arrays sorted by `lessonId` ASC for byte-stable output. Never reads the clock — `now` is required and injected.
- `interface PrunableLesson extends LessonIndexRecord { createdAt?: string }` (`src/orchestrator/memory/hygiene.ts:34`) — a `LessonIndexRecord` enriched with the recency proxy the CLI loads from the per-lesson `.md` file. `createdAt` may be absent.
- `interface PruneOptions` (`src/orchestrator/memory/hygiene.ts:39`) — `{ now: string; minOccurrences?: number; maxAgeMs?: number }`.
- `interface PruneResult` (`src/orchestrator/memory/hygiene.ts:54`) — `{ kept: PrunableLesson[]; quarantined: PrunableLesson[] }`.
- `const THIRTY_DAYS_MS` (`src/orchestrator/memory/hygiene.ts:25`) — default decay age threshold (30 days in ms).
- `quarantinePath(projectRoot, namespace?): string` (`src/state/memory.ts:44`) — resolves `<memoryDir>/QUARANTINE.md`, mirroring `indexPath`.
- `rewriteIndexForQuarantine(projectRoot, quarantinedIds, reason, now, namespace?): Promise<void>` (`src/state/memory.ts:66`) — line-level rewrite: moves matching `INDEX.md` lines (matched by the lessonId, the line's second token) into `QUARANTINE.md` with a deterministic provenance block `<!-- quarantined: <reason> @ <now> -->`, rewrites `INDEX.md` without them, and **never touches** per-lesson `<lessonId>.md` files. No-op when `INDEX.md` is absent or nothing matches.
- CLI `bober memory prune` (`src/cli/commands/memory.ts:211`) — loads the bounded index, enriches each record with `createdAt` (via `loadLesson`; a missing file leaves `createdAt` undefined), stamps `now` at the boundary, runs `pruneLessons`, then `rewriteIndexForQuarantine`. Prints `pruned: <kept> kept, <quarantined> quarantined` plus the `QUARANTINE.md` path and a list of retained per-lesson `.md` paths. Empty/absent `INDEX.md` → friendly `No lessons found. Nothing to prune.` Never throws (sets `process.exitCode = 1` on error).

## How to use / how it fits

Run prune after a batch of distills to keep `INDEX.md` from growing forever:

```bash
bober memory prune
# pruned: 1 kept, 3 quarantined
# quarantined lessons written to: .bober/memory/QUARANTINE.md
# per-lesson .md files retained at: .bober/memory/
```

The pure pass operates on whatever fields each record carries; the CLI is the only place
that reads the per-lesson files and the clock:

```ts
import { pruneLessons } from "./orchestrator/memory/hygiene.js";
import { rewriteIndexForQuarantine } from "./state/memory.js";

const now = new Date().toISOString();               // clock read OUTSIDE the pure pass
const { kept, quarantined } = pruneLessons(enriched, { now });
const ids = new Set(quarantined.map((r) => r.lessonId));
await rewriteIndexForQuarantine(projectRoot, ids, "prune", now, ns);
// INDEX.md shrinks; QUARANTINE.md gains the moved lines + provenance; per-lesson .md files untouched.
```

This is the third sprint of `spec-20260615-memory-self-improve-p0`. It operates on the
**lessons** store (the one the planner reads via `retrieveRelevantLessons`), complementing
Sprints 1–2 which built the separate semantic-**facts** store. Prune is a manual,
explicit step — there is no auto-prune at distill or plan time.

## Notes for maintainers

- **Quarantine is reversible by design.** `rewriteIndexForQuarantine` moves the **literal**
  `INDEX.md` line (byte-exact) and never deletes the `<lessonId>.md`, so a mistaken prune can
  be undone by moving the line back. Keep this invariant — `bober memory show <id>` still works
  after quarantine.
- **`createdAt` absent = maximally stale.** A low-occurrence lesson with no recoverable
  `createdAt` (missing per-lesson file) decays immediately. This is a deliberate,
  conservative choice: prefer to quarantine an unknown-age low-occurrence lesson rather than
  keep it forever. Conflict-quarantine, by contrast, does **not** depend on age.
- **Conflict polarity is a tag convention.** A contradiction fires only when two lessons share
  `categoryRoot + discriminatorTag` (the contradiction key) *and* carry opposing polarity tags
  drawn from the fixed `KEEP_MARKERS` (`keep`/`stable`/`pass`/`trusted`) vs `AVOID_MARKERS`
  (`avoid`/`fragile`/`fail`/`untrusted`) sets. `neutral`-polarity lessons never trigger a
  conflict on their own. High-occurrence lessons are still conflict-quarantined (occurrences
  only protect against *decay*, not conflict).
- **The CLI logs one `reason` per run (`"prune"`).** `pruneLessons` distinguishes decay vs
  conflict internally, but the CLI currently stamps a single provenance reason for the whole
  batch. Per-lesson reason tagging in `QUARANTINE.md` is a possible follow-up (noted in the
  CLI source).
- **Purity discipline mirrors `distill.ts` / `reconcile.ts`.** `hygiene.ts` has zero
  `Date.now()` / `new Date(` — it only `Date.parse`es the injected `now` and `createdAt`
  strings. Do not read the clock inside the module.
