# Self-Improvement Memory Guide

agent-bober's memory system closes the feedback arc between sprint outcomes and future
planning decisions. Past failures are distilled into a bounded lessons index that the
planner reads at plan time — so recurring failure patterns inform new sprint contracts
without exposing the planner to unbounded raw history.

**Scope:** This guide describes the three-stage pipeline from raw history to planner
context, explains the explicit prohibition on reading raw history directly, and provides
a manual A/B procedure for measuring whether the memory system produces tighter sprint
contracts.

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
  `src/state/memory.ts`, which opens exclusively `.bober/memory/INDEX.md`. It never
  opens `history.jsonl`, `history.archive.jsonl`, or per-lesson `.md` files.
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

## Configuration Notes

The `topK` and `charBudget` parameters are call-site options, not persisted config
fields. Sensible defaults (`DEFAULT_TOP_K = 5`, `DEFAULT_CHAR_BUDGET = 1200`) are
defined as constants in `src/orchestrator/memory/retrieve.ts`. If a future project
needs different defaults, a `memory: { charBudget }` section in `bober.config.json`
can be added — this is intentionally deferred until the need is demonstrated.
