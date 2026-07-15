# ADR-4: Partial-sync atomicity via idempotent resume on content-derived dedup, not a cross-batch transaction

**Decision:** A WHOOP sync is NOT wrapped in a single end-to-end transaction across pages/collections; instead each `writeBatch` is atomic (per-batch better-sqlite3 transaction) and a failed sync is recovered by re-running it, relying on `INSERT OR IGNORE` over the content-derived SHA-256 dedup key to make the operation idempotent.

**Context:** A sync spans multiple paginated pages across four collections (recovery/sleep/cycle/workout). A network/429/token failure can occur mid-pagination. The existing store commits per batch (`src/medical/health-store.ts:163-174`); wrapping an entire multi-request network sync in one DB transaction is impractical (long-held lock across network I/O), so the question is how to avoid corruption or double-counting on resume.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A: idempotent resume on content-derived dedup (re-run the whole window) | No new state; uses existing `INSERT OR IGNORE` (`src/medical/health-store.ts:155-175`); committed batches always valid; no long-held DB lock across network | Re-pulls already-synced pages on resume (extra API calls within the 10k/day budget) |
| B: single cross-batch DB transaction for the whole sync | All-or-nothing | Holds a write lock across all network round-trips; a slow/large sync blocks the DB; contradicts the per-batch backpressure design (`src/medical/ingestion.ts:22-31`) |
| C: persisted per-collection sync cursor/checkpoint | Resume skips already-synced pages | New persistent state + invalidation logic; premature for an on-demand single-user sync; adds a corruption surface of its own |

**Rationale:** The "never fail-open / must not partially corrupt the store" constraint plus the existing per-batch-atomic + content-derived-dedup design make Option A correct without new machinery; the streaming/backpressure design (`writeBatch` awaited per bounded batch) rules out B's whole-sync lock, and the single-user on-demand scope rules out C's checkpoint state as premature (YAGNI).

**Consequences:** A failed sync leaves committed batches intact and is fully recovered by re-running `whoop sync` with the same window; `newRows` on a resumed run reflects only genuinely-new records; no checkpoint file is added. The cost is re-fetching overlapping pages, bounded by the 10k/day limit.

**Risk:** If the synced window is very large and failures are frequent, repeated full-window re-pulls could approach the 10k/day cap — mitigated by the `--since` flag narrowing the window; if this becomes real, Option C (a sync cursor) is the documented next step.
