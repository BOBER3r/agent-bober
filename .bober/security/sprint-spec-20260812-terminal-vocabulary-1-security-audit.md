# Security Audit — sprint-spec-20260812-terminal-vocabulary-1

Timestamp: 2026-08-12T16:40:00Z
Scope: `git diff 4aef5ea..HEAD` (commits 7af1119, f07d3f3)
Verdict: **PASS** — 0 critical, 0 important, 2 minor.

## Central risk, and why it is disproven

The plausible failure for a control-flow-vocabulary change is a widened gate treating unfinished work as done. Evidence against:

- The only status-driven skip gate (`src/orchestrator/workflow/interpreter.ts:102-103`, fed by resume-cursor) already used the identical passed-OR-completed rule before the change — pinned by the unmodified `resume-cursor.test.ts:77-91`.
- Sprint *selection* still uses the separate, untouched `PENDING_STATUSES` set (`src/mcp/tools/sprint.ts:32-40`), so no unfinished sprint can be skipped by this change.
- `failed` is explicitly excluded from the settled set, asserted across all nine enum members.
- The only writer of `"completed"` (`src/pge/nodes/sprint-review.ts:203`) sets it strictly on success.

The four migrated readers that genuinely widen (`passed` → `passed|completed`) feed `handoff.sprintHistory` or a progress.md counter — not an authorization or gating decision.

## Minor findings

### 1. `ReadonlySet` is a compile-time-only guarantee (low, firm)
`SETTLED_CONTRACT_STATUSES` / `TERMINAL_CONTRACT_STATUSES` (`src/contracts/sprint-contract.ts:69,85`) are declared `ReadonlySet` but are ordinary runtime `Set`s, now on the public API (`src/index.ts:31-32`). In-process code can cast and `.add()`. Incremental risk over the pre-existing in-process trust assumption is ~0 (such code could equally monkey-patch the predicate), and there is no external trigger. Note the source comment at `sprint-contract.ts:80-83` ("cannot silently diverge") holds at module-init time only — TERMINAL is built by spread, so a post-init mutation of SETTLED would diverge them.

### 2. Unbounded `sprintHistory` growth (low, firm) — denial-of-service by taxonomy only
On any corpus written by the graph engine the settled list was previously EMPTY (`sprint-corpus.test.ts:62-71` pins zero `"passed"` contracts) and now resolves to the whole settled corpus — 209 here. That list is passed wholesale as `handoff.sprintHistory` into a live LLM call in both eval readers with **no compaction**: `mcp/tools/sprint.ts` applies `summarizeOlderSprints(handoff, 3)`, the two eval paths apply nothing, and `summarizeOlderSprints` itself keeps one entry per contract retaining the full description (`context-handoff.ts:170-172`), so it bounds nothing asymptotically. Effect is prompt/token growth proportional to project age. No new trust boundary is crossed and no external actor can force it.

## Approved areas

- `sprint-contract.ts:69-118` — fail-closed by construction; `Set.has()` returns false for unknown strings; TERMINAL derived from SETTLED rather than re-listed.
- `sprint-contract.test.ts:203-249` — partition asserted over all nine enum members plus an explicit "failed is terminal but not settled" witness.
- `sprint.ts:32-40` — work selection unaffected.
- `resume-cursor.ts:22-24` — semantically unchanged.
- `history.ts:194-199` — the "Failed" row correctly kept separate, avoiding a double-count.
- `sprint-state.ts:113-147` — every status the predicate sees is Zod-validated on load; malformed files skipped, so the predicate is never fed an arbitrary string.
- `status-vocabulary.invariant.test.ts:58-128` — roots derived from `import.meta.url`, fixed literal joins, `readdir({withFileTypes})` reports symlinks as symlinks so the walk cannot be redirected outside `src/`; pure core driven in-memory, no scratch files.
- `sprint-corpus.test.ts:31,73-92` — `REPO_ROOT` from `import.meta.url`, hardcoded repo-relative literals only.
- `index.ts:31-36` — four pure predicates/constants; nothing credential-bearing or I/O-capable added to the barrel.
