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
   `spec-20260615-memory-self-improve-p0` (Sprint 1), given **reconcile-on-write**
   (dedupe + supersede) in Sprint 2, and — as of **Sprint 5** — **auto-produced** from the
   project's manifests at run/chat startup and **retrieved into the planner's context**. See
   [Semantic Facts Store](#semantic-facts-store) below. Both stores now feed planning.

> **Phase 3 complete.** As of `spec-20260615-memory-self-improve-p0` (all 5 sprints landed,
> 2026-06-15), the memory layer has **two complementary stores, both feeding the planner**:
> **durable bi-temporal facts** (structured `(scope, subject, predicate, value)` assertions —
> auto-produced from the project's manifests at run/chat startup, reconciled idempotently on
> write, retrieved into planner context scope-isolated and char-budgeted) and **hygienic
> distilled lessons** (synthesized failure-pattern snippets — distilled from history,
> occurrence-weighted on retrieval, pruned/quarantined to fight monotonic growth). Producing
> facts uses **no LLM**; the only LLM in the facts layer is reconcile's normalized-key ambiguity
> branch.

**Scope:** This guide describes the three-stage lessons pipeline from raw history to planner
context, explains the explicit prohibition on reading raw history directly, provides a
manual A/B procedure for measuring whether the memory system produces tighter sprint
contracts, documents the semantic facts store (storage, reconcile, auto-production, and
retrieval into planning), and — for **Phase 5** — the off-by-default replay regression
harness that makes self-improvement safe to enable (see
[Replay Regression Harness](#replay-regression-harness-phase-5)).

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
- **Deterministic, occurrence-weighted ranking.** Lessons are ranked by lowercased token
  overlap between the feature keywords and each record's `tags`, `category`, and
  `summarySnippet` (the **dominant** key). When overlap scores tie, the lesson with **higher
  `occurrences`** ranks first — a more-often-seen failure pattern outweighs an equally-relevant
  rarer one (`spec-20260615-memory-self-improve-p0`, Sprint 3). The final tiebreak is `lessonId`
  (ASC lexicographic) for byte-stable output. Token overlap stays dominant, so a non-matching
  keyword set still yields an empty result (C1).
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
bober memory prune       # quarantine stale/conflicting lessons (see Lesson Hygiene below)
```

The distiller (`src/orchestrator/memory/distill.ts`) groups history entries by failure
signature and writes one `<lessonId>.md` file per lesson group plus a compact `INDEX.md`
line. It is a **pure** function (no LLM, no clock, no fs, no `../providers` import); the CLI
stamps `createdAt` at persist time and output is sorted by `lessonId` for byte-stable runs.
It derives lessons from **four signals**:

- **(a) recurring failed-criterion categories** — from eval `criteriaResults[].result==="fail"`,
  grouped by the criterion's `verificationMethod`.
- **(b) repeated failing eval strategies** — from eval `strategyResults[].result==="fail"`,
  grouped by strategy name.
- **(c) sprints that needed rework** — from `contract.iterationHistory` entries whose
  `result==="fail"` (reinforced by `phase==="rework"` history events).
- **(d) fail→pass contrast** (`spec-20260615-memory-self-improve-p0`, Sprint 4) — mines the
  signal the generator↔evaluator retry loop otherwise discards. For each contract it scans
  `iterationHistory` for at least one `result==="fail"` **followed (in iteration order) by** a
  `result==="pass"` and emits a `fix-contrast:<contractId>` lesson with tags
  `["phase:fix-contrast", "sprintId:<contractId>"]` and a summary `Sprint '<id>' flipped from
  fail to pass after N iteration(s)`. Its `sourceEntryRefs` cite each failing iteration
  (`<contractId>:iteration-<n>`) **and** the first passing iteration after them. The rule is
  strict and order-sensitive: a **first-iteration pass**, an **all-fail** history, and a
  **pass-before-fail** (with no later pass) are **not** transitions and produce no lesson. The
  scan stops at the first pass after a fail (the flip point). Like the other signals it is
  deterministic and reuses the same content-hashed `upsertGroup` grouping. A sprint that
  reworked then passed legitimately yields **both** a `(c) sprint-rework` and a `(d)
  fix-contrast` lesson — different categories, different refs, not a double-count.

---

## Lesson Hygiene: Prune & Quarantine

`bober memory distill` only ever **adds** to `INDEX.md` — without a counterweight the index
grows monotonically and accumulates stale, low-signal, or contradictory lessons. `bober memory
prune` (`spec-20260615-memory-self-improve-p0`, Sprint 3) is that counterweight: a manual,
explicit hygiene pass that moves low-value and conflicting lessons out of `INDEX.md` into a
`QUARANTINE.md` sidecar — **never deleting** anything.

```bash
bober memory prune
# pruned: 1 kept, 3 quarantined
# quarantined lessons written to: .bober/memory/QUARANTINE.md
# per-lesson .md files retained at: .bober/memory/
```

### What gets quarantined

The decision is made by a **pure** function — `pruneLessons(records, { now, minOccurrences?,
maxAgeMs? })` in `src/orchestrator/memory/hygiene.ts` — that partitions records into
`{ kept, quarantined }` in two deterministic phases:

1. **Conflict detection (first).** Two lessons that share the same **contradiction key**
   (`categoryRoot` + a discriminator tag such as `sprintId:` / `strategy:` /
   `verificationMethod:`) but carry **opposing polarity** markers — one `keep`-marked
   (`keep`/`stable`/`pass`/`trusted`), one `avoid`-marked (`avoid`/`fragile`/`fail`/`untrusted`)
   — are **BOTH** quarantined. This is deterministic; there is no LLM. Conflict-quarantine does
   **not** depend on age or occurrences (a high-occurrence lesson is still quarantined if it
   contradicts another).
2. **Decay (second, for the survivors).** A lesson with `occurrences` strictly below
   `minOccurrences` (default 2) that is **also stale** — older than `maxAgeMs` (default 30 days),
   or with no recoverable `createdAt` — is quarantined. A missing `createdAt` is treated as
   *maximally stale*: a low-occurrence lesson whose per-lesson file can't be read decays
   immediately. This is a conservative, documented choice — prefer quarantining an
   unknown-age, low-occurrence lesson over keeping it forever.

### Lifecycle: never delete

Quarantine is a **move, not a delete**, and is reversible:

- `rewriteIndexForQuarantine(projectRoot, quarantinedIds, reason, now, namespace?)`
  (`src/state/memory.ts`) reads `INDEX.md`, moves the **literal** lines whose lessonId is
  quarantined into `QUARANTINE.md` (resolved by `quarantinePath`, the `QUARANTINE.md` sibling of
  `indexPath`), and rewrites `INDEX.md` without them. The moved block is prefixed with a
  deterministic provenance comment: `<!-- quarantined: <reason> @ <now> -->`.
- The per-lesson `<lessonId>.md` files are **never touched** — `bober memory show <id>` still
  works after a prune, and a mistaken quarantine can be undone by moving the `INDEX.md` line back.
- `retrieveRelevantLessons` reads only `INDEX.md`, so quarantined lessons immediately stop
  reaching the planner — but the record itself is preserved for inspection.

### Purity and the clock

Like `distill.ts` and the facts `reconcile.ts`, `hygiene.ts` **never reads the wall-clock**:
`now` is a required, injected parameter and only `now`/`createdAt` strings are `Date.parse`d.
The CLI handler is the only place that reads the clock (`new Date().toISOString()` at the
boundary) and the only place that reads the per-lesson `.md` files to assemble each record's
`createdAt` recency proxy. The handler follows the same no-throw discipline as the other
`bober memory` subcommands (sets `process.exitCode = 1` on error); an empty or absent `INDEX.md`
prints a friendly `No lessons found. Nothing to prune.` and creates no `QUARANTINE.md`.

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
provenance, and temporal columns. As of **Sprint 5** the store is no longer write-only: facts
are **auto-produced** from the project's manifests at run/chat startup (see
[Auto-producing project facts](#auto-producing-project-facts-sprint-5)) and **retrieved into the
planner's context** (see [Retrieving facts into planner context](#retrieving-facts-into-planner-context-sprint-5)).

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

### Auto-producing project facts (Sprint 5)

Sprint 5 makes facts populate themselves — no manual `bober facts add` needed. A **pure,
deterministic detector** reads the project's manifests/config and emits project facts, and a
thin IO caller writes them through the reconcile path at the start of every run and chat
session.

- **The pure detector** is `detectProjectFacts(inputs, scope="")`
  (`src/orchestrator/memory/fact-detector.ts`). It takes **already-parsed** inputs
  (`{ packageJson, boberConfig?, lockfiles? }`) and returns `FactDraft[]` — **no fs read, no
  `Date`, no LLM**, mirroring `distill.ts`. `FactDraft` is `Omit<FactInput, "tValid" | "tCreated">`
  (the caller stamps the clock). Detection rules are fixed-order and deterministic:

  | Source | Fact |
  |--------|------|
  | `package.json` `scripts.test` (if a string) | `project/testCommand` |
  | `package.json` `scripts.build` (if a string) | `project/buildCommand` |
  | first lockfile present, order `npm > yarn > pnpm` (`package-lock.json` / `yarn.lock` / `pnpm-lock.yaml`) | `project/packageManager` (`npm`/`yarn`/`pnpm`) |
  | first dep/devDep found, order `next > react > vue` | `project/framework` (`next`/`react`/`vue`) |

  Drafts carry `confidence: 1`, `sourceRunId: null`, and `scope=""` (default/programming team).
  Nothing detectable → `[]`.

- **The thin IO caller** is `seedProjectFacts(projectRoot, namespace?)` — the **only** function
  in the module that touches the filesystem or the clock. It reads `package.json` +
  `bober.config.json` (missing/unparseable → `null`, which is normal) and lockfile presence,
  calls the pure detector, stamps a single `new Date().toISOString()` at the boundary, then
  writes each draft via `writeFact` (so reconcile dedupes/supersedes — re-running is idempotent,
  one active row per predicate). It never throws for missing files.

- **Wiring is additive and guarded.** `seedProjectFacts` is invoked near the start of
  `runPipeline` (`src/orchestrator/pipeline.ts`, after `loadTeam`, before `engine.run`) inside a
  `try/catch` that `logger.warn`s and continues, and in `ChatSession.start()`
  (`src/chat/chat-session.ts`, after the banner, before the input loop) inside a silent
  `try/catch`. **A facts failure can never abort a run or a chat session.** The namespace is
  derived from the active team (`team.memoryNamespace`), so facts land in the same per-team
  `facts.db` the lessons `INDEX.md` uses.

- **No LLM on the produce path.** `seedProjectFacts` runs only the deterministic
  `add`/`update`/`noop` reconcile branches — the LLM `FactJudge` is **not** wired in. The only
  LLM surface in the whole facts layer remains the reconcile ambiguity branch from Sprint 2.

### Retrieving facts into planner context (Sprint 5)

Facts feed planning through a retrieval pair that mirrors the lessons path
(`src/orchestrator/memory/fact-retrieve.ts`):

- `retrieveRelevantFacts(projectRoot, scope, keywords, { topK?, namespace? })` opens the store
  **once**, reads scope-isolated active facts, then ranks them purely in memory. **Scope
  isolation is enforced at the SQL layer** by `FactStore.getActiveFacts(scope)`
  (`WHERE scope = ? AND t_invalidated IS NULL`) — facts in scope A **never** surface when
  querying scope B, and only active (non-invalidated) rows are considered. Ranking is
  deterministic token-overlap between the lowercased keyword tokens and each record's
  subject + predicate + value (score DESC, then `id` ASC byte-stable tiebreak). When `keywords`
  is empty or nothing overlaps, the result is **empty** (same behaviour as the lessons retriever).
- `serializeFactsForContext(records, { charBudget? })` renders a compact block — a
  `## Project facts (durable semantic memory)` header plus one `- subject/predicate: value` line
  per fact — and applies a **hard `charBudget` slice** so the output length is guaranteed
  `≤ charBudget` (`charBudget: 0 →` `""`, empty input → `""`). Defaults: `DEFAULT_TOP_K = 5`,
  `DEFAULT_CHAR_BUDGET = 1200`.
- **Injection into the planner** happens in `runPlanner`
  (`src/orchestrator/planner-agent.ts`): it derives keywords from the user prompt, calls
  `retrieveRelevantFacts(projectRoot, "", keywords, { topK: 5 })`, and appends
  `serializeFactsForContext(facts, { charBudget: 1200 })` to the planner `userMessage` alongside
  the existing Project Context / research / architecture sections — all inside a `try/catch`, so
  a retrieval failure never blocks planning.

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

---

## Replay Regression Harness (Phase 5)

Phase 5 (`spec-20260615-self-improve-p1-p2`) makes self-improvement **safe to enable** by
freezing a corpus of golden eval outcomes that future changes can be diffed against. As of
**Sprint 1** only the **storage foundation** has landed: a frozen replay corpus plus an
off-by-default config section. The regression gate that *acts* on the corpus, the evaluator
guards, and the GEPA evolve loop are **deferred to Sprints 2–4** (see
[Roadmap](#replay-roadmap-sprints-2-4) below).

> **Off by default.** Everything in this section is inert until later sprints wire the gates
> that read the `selfImprove` flags. Capturing and inspecting the corpus today has **zero**
> effect on a pipeline run.

### The replay corpus

```
.bober/replay/replay.db          ← SQLite baseline index (table replay_cases)
.bober/replay/cases/<caseId>.json ← immutable per-case fixture (one per captured eval result)
```

`ReplayStore` (`src/orchestrator/selfimprove/replay-store.ts`) clones the `FactStore`
discipline exactly: `better-sqlite3` behind a swappable class, `CREATE TABLE IF NOT EXISTS`
in the constructor, every statement parameterized with `?` (no string interpolation), and
**no clock read inside the class** — every timestamp is a caller parameter, so the store is
`:memory:`-testable and deterministic. The `replay_cases` row is
`(case_id, contract_id, iteration, baseline_verdict, diff_digest, eval_details_json, t_captured)`
with `case_id` as the primary key.

`caseId` is a deterministic content hash —
`sha256(`${contractId}|${iteration}|${diffDigest}`).slice(0,16)`, mirroring `factId`
(`src/state/facts.ts:58`). `tCaptured` is intentionally **excluded** from the hash, so the id
is stable across recaptures and only changes when `diffDigest` changes.

### `bober replay` CLI

The CLI (`src/cli/commands/replay.ts`, registered as `registerReplayCommand` in
`src/cli/index.ts`) follows the `bober facts` / `bober memory` conventions: `chalk` output and
handlers that **never throw** — on error they set `process.exitCode = 1` and return. All three
subcommands accept `--replay-dir <dir>` (default `.bober/replay`).

```bash
# Ingest every .bober/eval-results/eval-*.json into immutable fixtures + the baseline DB.
# Per file: baselineVerdict = passed ? 'pass' : 'fail',
#           diffDigest = sha256(JSON.stringify(results)).slice(0,32)  (real git diff not re-derivable post-hoc),
#           tCaptured stamped at the handler boundary (NEVER inside the store).
# Invalid-JSON or field-missing files are skipped with a warning, not crashed.
bober replay capture

# Print one row per captured case (id, contract, iteration, verdict, captured-at)
bober replay list

# Print one case with provenance (contractId, iteration, baselineVerdict, diffDigest,
# tCaptured, source fixture path). Unknown id → friendly message + exitCode 1.
bober replay show <caseId>
```

`replay show` prints the fixture path (`.bober/replay/cases/<id>.json`); the fixture's JSON
body additionally carries `sourceFile` (the original eval-result path) for full provenance.

### `selfImprove` config section (off by default)

`SelfImproveSectionSchema` (`src/config/schema.ts`) is wired into `BoberConfigSchema` as
`selfImprove: SelfImproveSectionSchema.optional()`, mirroring the evaluator section. A config
that omits `selfImprove` loads without throwing.

```jsonc
// bober.config.json — all flags default to false; the section is optional.
"selfImprove": {
  "deterministicGate":    false,  // Sprint 3 — evaluator guard (not yet wired)
  "rubricIsolation":      false,  // Sprint 3 — evaluator guard (not yet wired)
  "requireCitedArtifact": false,  // Sprint 3 — evaluator guard (not yet wired)
  "replayDir":            ".bober/replay"
}
```

Only `replayDir` has any effect today (it locates the corpus). The three boolean guards exist
so the schema is forward-stable, but nothing reads them until Sprint 3 lands.

<a id="replay-roadmap-sprints-2-4"></a>
### Roadmap (Sprints 2–4)

| Sprint | Adds |
|--------|------|
| 2 | `replay run` — re-evaluate captured cases and **compare to baseline** (the actual regression gate) |
| 3 | Evaluator guards behind `deterministicGate` / `rubricIsolation` / `requireCitedArtifact` |
| 4 | GEPA evolve loop |
