# Self-Improvement Memory Guide

agent-bober's memory system closes the feedback arc between sprint outcomes and future
planning decisions. Past failures are distilled into a bounded lessons index that the
planner reads at plan time — so recurring failure patterns inform new sprint contracts
without exposing the planner to unbounded raw history.

The memory substrate has **two stores**, both living under `.bober/memory/` and both
namespaced per team by the same `memoryDir` rule:

1. **Lessons** — a distilled, file-based index (`INDEX.md` + per-lesson `.md` files),
   described in the bulk of this guide. This is the store the planner reads today.
2. **Semantic facts** — a bi-temporal SQLite store (`facts.db`) of structured
   `(scope, subject, predicate, value)` assertions, introduced by
   `spec-20260615-memory-self-improve-p0` (Sprint 1) and given **reconcile-on-write**
   (dedupe + supersede) in Sprint 2. See [Semantic Facts Store](#semantic-facts-store)
   below. **Not yet wired into planning** — it is the storage foundation for later sprints.

**Scope:** This guide describes the three-stage lessons pipeline from raw history to planner
context, explains the explicit prohibition on reading raw history directly, provides a
manual A/B procedure for measuring whether the memory system produces tighter sprint
contracts, and documents the semantic facts store.

---

## The Close-the-Arc Flow

```
Sprint execution
      │
      ▼
.bober/history.jsonl        ← append-only log of all sprint events
      │                       (Sprint 1: scale-safe rotation, max 2000 active lines;
      │                        older entries archived to history.archive.jsonl)
      │
  bober memory distill       ← explicit CLI command (Sprint 3)
      │                         src/cli/commands/memory.ts
      │                         calls src/orchestrator/memory/distill.ts
      │
      ▼
.bober/memory/INDEX.md      ← compact, bounded index of distilled lessons
                               (Sprint 2: src/state/memory.ts)
                               format: one line per lesson —
                               - <lessonId> [category/severity] (xN) tags: t1,t2 — <snippet>
      │
  retrieveRelevantLessons()  ← called by the planner at plan time (Sprint 4)
      │                         src/orchestrator/memory/retrieve.ts
      │                         reads ONLY INDEX.md via loadLessonIndex()
      │
      ▼
Planner context              ← topK-capped, charBudget-truncated lessons block
                               injected into sprint contract generation
```

### Key invariants

- **Index-only access.** `retrieveRelevantLessons` calls `loadLessonIndex` from
  `src/state/memory.ts`, which opens exclusively the namespace's `INDEX.md` (the default
  `.bober/memory/INDEX.md`; see [Per-Team Namespacing](#per-team-namespacing) below). It
  never opens `history.jsonl`, `history.archive.jsonl`, or per-lesson `.md` files.
- **Explicit distill step.** The planner consumes whatever `bober memory distill` last
  wrote. There is no auto-distill at plan time — this is a deliberate safety boundary.
- **Deterministic ranking.** Lessons are ranked by lowercased token overlap between
  the feature keywords and each record's `tags`, `category`, and `summarySnippet`.
  Ties break on `lessonId` (ASC lexicographic) for byte-stable output.
- **Hard caps.** The caller passes `{ topK }` to bound the number of returned lessons
  and an optional `charBudget` (default: 1200 characters) to the serializer. Both are
  enforced before the block reaches the planner.

---

## Distilling Lessons from History

Run the distill command after a batch of sprints to update the index:

```bash
npx agent-bober memory distill
# or via the CLI shorthand:
bober memory distill
```

Inspect the current index with:

```bash
bober memory list        # list all lessons in INDEX.md
bober memory show <id>   # show a full lesson file
```

The distiller (`src/orchestrator/memory/distill.ts`) groups history entries by failure
signature (phase=failed events, repeated eval-fail strategies, high-churn sprints) and
writes one `<lessonId>.md` file per lesson group plus a compact `INDEX.md` line.

---

## History.jsonl Prohibition

The planner MUST NOT read `.bober/history.jsonl` directly. The raw history file is:

- **Unbounded.** It grows with every sprint event. Reading it in the planner scales
  linearly with project age and can exceed context limits.
- **Unstructured for planning purposes.** Raw history contains every intermediate event;
  the distilled index contains only lessons — synthesized failure patterns.

Both `skills/bober.plan/SKILL.md` (Step 2, item 6) and `agents/bober-planner.md`
(Phase 1, item 5) contain an explicit prohibition. The retrieval path enforces this
by construction: `retrieveRelevantLessons` only calls `loadLessonIndex`, which opens
only `INDEX.md`.

---

## Manual A/B Measure: findPrecisionIssues

The primary observable signal that the memory system improves planning quality is the
reduction in **contract precision issues** — detected by the `findPrecisionIssues`
function at `src/contracts/sprint-contract.ts:242`:

```ts
export function findPrecisionIssues(contract: SprintContract): ContractPrecisionIssue[]
```

`findPrecisionIssues` scans all string fields of a `SprintContract` for banned vague
phrases (e.g., "works correctly", "looks good", "behaves properly") and returns an
array of `ContractPrecisionIssue` objects — one per violation. Fewer violations means
tighter contracts.

### A/B Procedure (manual)

This is a manual comparison procedure. There is no automated A/B harness — the
evaluator cannot run this automatically because it requires two separate planning
sessions.

**Setup:**

1. Choose a feature request of moderate complexity that you have not yet planned.
2. Ensure `bober memory distill` has been run recently so `INDEX.md` is populated.

**Run A — with memory (memory present):**

```bash
# Verify INDEX.md exists and has content
cat .bober/memory/INDEX.md

# Plan the feature (planner will call retrieveRelevantLessons internally)
npx agent-bober plan "<feature description>"

# Save the generated contract IDs, then count precision issues for each
node -e "
  const { loadContract } = require('./dist/contracts/sprint-contract.js');
  const { findPrecisionIssues } = require('./dist/contracts/sprint-contract.js');
  // load each contract and call findPrecisionIssues(contract)
"
```

**Run B — without memory (memory absent):**

```bash
# Temporarily move the index aside
mv .bober/memory/INDEX.md .bober/memory/INDEX.md.bak

# Plan the same feature again (planner gets no lessons — empty index)
npx agent-bober plan "<same feature description>"

# Count precision issues for each new contract
# ... same node snippet as above

# Restore the index
mv .bober/memory/INDEX.md.bak .bober/memory/INDEX.md
```

**Metric:**

Compare the **total count of `findPrecisionIssues` results** across all contracts
generated in Run A versus Run B.

| Condition        | findPrecisionIssues count |
|-----------------|--------------------------|
| With memory (A) | (lower expected)         |
| Without memory (B) | (higher baseline)     |

**Expected direction: FEWER precision issues when memory is present.** The planner
learns from past lessons (e.g., a lesson "eval-fail:unit-test — criteria too vague")
and writes more specific success criteria, reducing banned-phrase violations.

A single data point is not conclusive. Run the procedure across three or more
independent features and average the issue counts before drawing conclusions.

---

## Per-Team Namespacing

The lessons store is **namespaced per team** (`spec-20260615-team-abstraction`, Sprint 2).
Each persistence function — `memoryDir`, `lessonPath`, `indexPath`, `appendLesson`,
`loadLessonIndex`, `loadLesson` (`src/state/memory.ts`), and `retrieveRelevantLessons`
(`src/orchestrator/memory/retrieve.ts`) — accepts an optional trailing `namespace`
argument. The mapping rule is centralized in `memoryDir(projectRoot, namespace?)`:

| `namespace` value | resolved directory |
|-------------------|--------------------|
| `undefined`, `""`, or `"programming"` | `.bober/memory/` (the default path, no subdir) |
| any other value (e.g. `"teamA"`) | `.bober/memory/<namespace>/` |

Each namespace has its **own bounded `INDEX.md`** (`.bober/memory/<ns>/INDEX.md`), so
teams' lessons are fully isolated in both directions. The default / `programming` team
keeps the existing `.bober/memory/` path — pre-existing lessons stay visible and there is
**no migration** into a `programming/` subdir. Namespace values are constrained to
`^[a-z0-9_-]+$` by the team config schema, so the path helpers do no traversal
sanitization of their own.

Callers derive the namespace from the active team rather than passing it by hand: the
`bober memory` CLI resolves it via a non-fatal `loadConfig` + `loadTeam(config).memoryNamespace`
helper, and the chat session threads `ChatSessionOptions.memoryNamespace` into
`buildMemoryDistill`. Both default to the current `.bober/memory/` path when no team /
config is present. Selecting a non-default team from the command line (`--team`) is not yet
wired — memory commands operate on the default team's namespace only.

---

## Configuration Notes

The `topK` and `charBudget` parameters are call-site options, not persisted config
fields. Sensible defaults (`DEFAULT_TOP_K = 5`, `DEFAULT_CHAR_BUDGET = 1200`) are
defined as constants in `src/orchestrator/memory/retrieve.ts`. If a future project
needs different defaults, a `memory: { charBudget }` section in `bober.config.json`
can be added — this is intentionally deferred until the need is demonstrated.

---

## Semantic Facts Store

Alongside the distilled lessons index, the memory layer has a **bi-temporal SQLite
semantic-facts store** (`spec-20260615-memory-self-improve-p0`, Sprint 1). Where lessons
are synthesized prose snippets, facts are **structured assertions** —
`(scope, subject, predicate, value)` rows with a confidence score, optional source-run
provenance, and temporal columns — that later sprints will produce, reconcile, and feed
back into planning. This sprint lands only the store and a manual CLI; **nothing reads
`facts.db` automatically yet.**

```
.bober/memory/facts.db        ← bi-temporal SQLite store (default / programming scope)
.bober/memory/<ns>/facts.db   ← per-team namespace (same memoryDir rule as INDEX.md)
        │
        ├─ table semantic_facts(id, scope, subject, predicate, value, confidence,
        │                        source_run_id, t_valid, t_invalid, t_created, t_invalidated)
        ├─ idx_facts_sp(scope, subject, predicate)
        └─ idx_facts_active(scope, t_invalidated)
```

### Storage model

- **The store is `src/state/facts.ts`** — a `FactStore` class wrapping `better-sqlite3`.
  The driver is hidden behind the class so it can be swapped for the built-in
  `node:sqlite` once `engines.node` is raised to `>=22.5`; callers must depend on the
  `FactStore` method shape, not the driver.
- **Bi-temporal, never destructive.** Invalidation is a **soft-delete** that stamps
  `t_invalidated` — rows are never deleted. An *active* fact is `t_invalidated IS NULL`;
  `getActiveFacts` returns only those, while `getFact(id)` returns a fact regardless of
  invalidation status (so history stays inspectable). The two ways a row gets closed
  differ in which temporal fields they set: the `bober facts invalidate` CLI calls
  `invalidateFact(id, tInvalidated)`, which stamps **only** `t_invalidated` (record-time)
  and leaves `t_invalid` `NULL`; a Sprint-2 **supersede** (see
  [Reconcile-on-write](#reconcile-on-write-dedupe--supersede) below) calls
  `supersedeFact(id, tInvalidated, tInvalid)`, which stamps **both** `t_invalidated` and
  `t_invalid` (the valid-time / world-time upper bound = the superseding fact's `tValid`).
  So a superseded row carries a non-`NULL` `t_invalid`; a hand-invalidated row does not.
- **Deterministic ids.** A fact id is `sha256(\`${scope}|${subject}|${predicate}|${value}|${tCreated}\`).slice(0,16)`
  (`factId`, mirroring `lessonIdFromSignature`). `insertFact` is an upsert
  (`INSERT OR REPLACE`), so re-inserting an identical fact with the same `tCreated`
  overwrites the same row instead of duplicating — built for idempotent producers.
- **The store never reads the clock.** Every timestamp (`tValid`, `tCreated`,
  `tInvalidated`) is a caller parameter; the CLI stamps `new Date().toISOString()` at the
  handler boundary. This is the same purity discipline as `distill.ts`.
- **Per-team namespacing** reuses `memoryDir(projectRoot, namespace)`: the DB lives at
  `.bober/memory/facts.db` for the default / `programming` scope and
  `.bober/memory/<ns>/facts.db` for any other namespace — identical to the lessons
  `INDEX.md` mapping in [Per-Team Namespacing](#per-team-namespacing) above. Within a DB,
  the `scope` column is the per-team isolation axis for queries.

### Reconcile-on-write (dedupe + supersede)

Sprint 2 routes every fact write through a **reconcile** step — `reconcileFact` and its thin
`writeFact` wrapper (`src/orchestrator/memory/reconcile.ts`, re-exported from
`src/state/facts.ts`) — instead of a raw `insertFact`. Reconcile decides, deterministically
where it can, what to do with an incoming fact and returns a `ReconcileAction`
(`'add' | 'update' | 'delete' | 'noop'`):

```
incoming fact ──▶ getActiveFacts(scope, subject, predicate)   ← exact key, active only
        │
        ├─ exact match, SAME value          → NOOP   (no write, no second row)
        ├─ exact match, DIFFERENT value     → UPDATE (supersedeFact(old) + insertFact(incoming))
        └─ NO exact match
              │
              ├─ normalized (subject,predicate) collides with an active fact?
              │       ├─ collision + judge provided → judge.resolve(incoming, candidate)
              │       │                                 → add | update | delete | noop
              │       └─ collision + NO judge        → deterministic ADD fallback
              └─ no collision                        → ADD
```

Key properties:

- **The exact-match path has NO LLM.** `noop` (identical value), `update` (changed value →
  supersede), and a fresh `add` all run with no judge and no network. The clock is **injected**
  (`{ now }`) — `reconcileFact` never reads it, mirroring the store's purity discipline. This is
  why `bober facts add` is reproducible.
- **Supersession is invalidate-then-insert.** On a changed value, reconcile calls
  `supersedeFact(old.id, now, incoming.tValid)` — closing **both** `t_invalidated`
  (record-time) and `t_invalid` (world-time end) on the old row — then `insertFact(incoming)`.
  Exactly one active fact remains; the old row persists with both closure fields set so history
  stays inspectable. The new row carries the **incoming** fact's confidence.
- **NOOP writes nothing.** A second write of an identical `(scope, subject, predicate, value)`
  returns `'noop'` and creates no second row.
- **The LLM `FactJudge` is consulted ONLY on a deterministic ambiguity** — a *normalized*
  subject+predicate collision (lowercased, non-alphanumerics stripped) with an active fact when
  no exact match exists. The judge (`src/orchestrator/memory/fact-judge.ts`,
  `createLLMFactJudge()` via `createClient`) is the **only** LLM surface in the reconcile layer
  and is **injected** — it is never wired into `bober facts add`.
- **`'add'` is the safe fallback everywhere.** A collision with no judge falls back to `add`;
  the `LLMFactJudge` returns `'add'` on any thrown error, parse failure, or unrecognized action
  (and under `BOBER_TEST_DETERMINISTIC=1`). The judge can merge or drop a fact but can never
  silently corrupt the store — the worst case is a duplicate active fact.
- **Reconciliation gates on *active* facts only.** An incoming value equal to an already-
  invalidated prior fact still `add`s; `getActiveFacts` is the only thing reconcile reads.
  A judge `'delete'` supersedes the candidate and inserts nothing.

### `bober facts` CLI

The CLI (`src/cli/commands/facts.ts`, registered as `registerFactsCommand` in
`src/cli/index.ts`) follows the `bober memory` conventions: it resolves the namespace from
the active team via a non-fatal `loadConfig` + `loadTeam(config).memoryNamespace`, prints
with `chalk`, and **never throws** — on error it sets `process.exitCode = 1` and returns.

`bober facts add` routes through `writeFact` (Sprint 2) — with **no judge** wired, so only the
deterministic `add` / `update` / `noop` branches run — and prints **action-aware** output:
green `Added fact` on a fresh add, yellow `Superseded — prior fact invalidated.` when a changed
value replaces an active one, and gray `Fact unchanged (identical value already active).` on a
NOOP. So re-adding a changed value now supersedes rather than duplicating.

```bash
# Add a fact (t_created / t_valid stamped at the handler boundary, not in the store).
# Routed through writeFact → dedupe/supersede reconciliation runs (no judge).
bober facts add --scope programming --subject project --predicate testCommand --value vitest
bober facts add --scope programming --subject project --predicate testCommand --value jest    # Superseded — prior fact invalidated.
bober facts add --scope programming --subject project --predicate testCommand --value jest    # Fact unchanged (identical value already active).

# List active (non-invalidated) facts, optionally filtered by --subject / --predicate
bober facts list

# Inspect one fact with full provenance + temporal fields (works after invalidation)
bober facts show <id>

# Soft-delete: drops from `list`, but `show` still returns it
bober facts invalidate <id>
```

As with `bober memory`, selecting a non-default team from the command line is not yet
wired — the facts commands operate on the default team's namespace.

### Note on project principles

`.bober/principles.md` currently states "**No database**" and "All mutable state … is
stored as JSON files in `.bober/`". The facts store is a **deliberate, scoped exception**:
it is the project's first relational store, and `better-sqlite3` is the first native
runtime dependency. The store is synchronous by design (a transactional DB driver, not a
`node:fs` bulk read), which is not the case the "no synchronous filesystem ops" principle
targets. These principles likely warrant a caveat acknowledging the facts store; that edit
is left for a maintainer to make deliberately rather than rewritten here.
