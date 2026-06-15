# Fail→pass contrast extractor in distill

**Contract:** sprint-spec-20260615-memory-self-improve-p0-4  ·  **Spec:** spec-20260615-memory-self-improve-p0  ·  **Completed:** 2026-06-15

## What this sprint added

Mines a signal the generator↔evaluator retry loop previously **discarded**: when a sprint
fails one or more evaluations and then later passes, that fail→pass flip is the moment the
fix landed. The pure `distill()` now carries a **fourth signal (d)** that scans each
contract's `iterationHistory` for at least one `result==="fail"` **followed (in iteration
order) by** a `result==="pass"`, and emits a new `fix-contrast:<contractId>` lesson capturing
the sprint provenance and exactly which iterations flipped. Signal (d) is purely additive — it
sits alongside the existing (a) failed-criterion, (b) failing-strategy, and (c) sprint-rework
signals and reuses the same `upsertGroup` / `lessonIdFromSignature` machinery, so the new
lessons are content-hashed and byte-stable like the rest. Purity is preserved: no
`../providers` import, no `Date.now()` / `new Date(`, no fs or network — `createdAt` stays
`SENTINEL_CREATED_AT` and the CLI stamps the real clock at persist time.

## Public surface

No new exported symbol — the change is internal to the existing pure `distill()`. The new
**lesson shape** it can now emit is the observable surface:

- `distill(history, contracts, evalResults?)` (`src/orchestrator/memory/distill.ts:121`) — gains signal (d); the function signature is unchanged.
- Lesson category `fix-contrast:<contractId>` (`src/orchestrator/memory/distill.ts:236`) — one lesson per sprint that flipped fail→pass.
  - **tags:** `["phase:fix-contrast", "sprintId:<contractId>"]` (`distill.ts:237`).
  - **summary:** `Sprint '<contractId>' flipped from fail to pass after N iteration(s)` (`distill.ts:238`).
  - **sourceEntryRefs:** `<contractId>:iteration-<n>` for each failing iteration **and** the first passing iteration after them (`distill.ts:239-242`).

## How to use / how it fits

There is no new CLI surface. The existing `bober memory distill` handler picks up signal (d)
for free — over a history/contracts set containing a fail→pass sprint, the new
`fix-contrast:<id>` lesson appears in `INDEX.md` and `bober memory list` alongside the
`sprint-rework` lesson the same fixture produces:

```bash
bober memory distill   # distilled N lessons (... new)
bober memory list      # now shows e.g. fix-contrast:sprint-test-flip
```

The transition rule is strict and order-sensitive:

| `iterationHistory` results | fix-contrast lesson? |
|----------------------------|----------------------|
| `[fail, fail, pass]`       | **yes** — refs iteration-1, -2 (fail) + iteration-3 (pass) |
| `[pass]` (first-iteration pass) | no |
| `[fail, fail]` (never passed)   | no |
| `[pass, fail]` (pass before fail, no later pass) | no |

The scan breaks at the **first** pass after a fail (that is the flip point), so only the
failing iterations up to the flip and that single passing iteration are cited.

## Notes for maintainers

- **A sprint that reworked then passed now yields TWO lessons.** A `[fail, …, pass]` history
  legitimately fires both signal (c) `sprint-rework` and signal (d) `fix-contrast:<id>` — they
  are different categories with different `sourceEntryRefs`, so they are distinct lessons, not a
  double-count. This is why two pre-existing assertions in `distill.test.ts` were updated (the
  fixture's `[fail, pass]` contract now produces five lessons instead of four, and the
  2-arg-call case now includes the `fix-contrast:sprint-real-1` category). The behavior of
  signals (a)/(b)/(c) is unchanged.
- **Strategy/criterion-flip enrichment was intentionally omitted.** The contract permitted
  enriching tags with which eval strategy/criterion flipped fail→pass when the linked
  `DistillableEval` records are available, but that was left out to keep signal (d) minimal and
  deterministic. The category/tags are keyed by `contractId` only. Adding flip-strategy
  enrichment later is a clean, additive follow-up.
- **Determinism is load-bearing.** Output stays sorted by `lessonId` and byte-identical across
  repeated calls on identical input — keep any future change to this block free of clock/fs/
  provider access, matching the file-header purity contract.
