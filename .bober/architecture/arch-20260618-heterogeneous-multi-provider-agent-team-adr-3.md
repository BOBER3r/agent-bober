# ADR-3: Shared Blackboard via One WAL-Mode facts.db, Bounded to <=3 Rounds

**Decision:** Siblings exchange findings through ONE shared `facts.db` opened in WAL mode at a shared path, capped at a hard `BLACKBOARD_MAX_ROUNDS=3`.

**Context:** Children are isolated OS processes in separate cwds (`src/fleet/runner.ts:95`); the head receives only `{exitCode, stdout, stderr}`, so cross-agent state must be shared on-disk. FactStore is single-process better-sqlite3 opened WITHOUT WAL (`src/state/facts.ts:140`), and prior research found free unbounded discussion fails to converge.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A: Reuse existing FactStore as-is (no WAL) | Zero new infra | No WAL -> concurrent sibling writes block/corrupt (`src/state/facts.ts:140`); single-process assumption violated |
| B (chosen): One facts.db with PRAGMA WAL + busy_timeout, bounded <=3 rounds | Reuses FactRecord shape; WAL allows concurrent readers/one writer; bounded convergence | Adds a PRAGMA + round-cap enforcement; WAL sidecar files to checkpoint |
| C: Message queue / external broker per fleet | Purpose-built for concurrency | New external dependency; violates on-disk-only + additive constraints; operational weight |

**Rationale:** Constraint "FactStore opened WITHOUT WAL, single-process" (`src/state/facts.ts:140`) eliminates Option A under concurrent siblings. Constraint "shared state must be on-disk" + "ADDITIVE" eliminates Option C's external broker. Option B sets `journal_mode=WAL; busy_timeout=5000` on `open` and checkpoints on `close`. Constraint "bounded capped-round exchange, NOT free discussion" sets the hard cap: `publish` throws when `round > maxRounds` (<=3).

**Consequences:** Findings are `FactRecord` rows (scope=namespace, subject=childFolder, predicate="finding"). Exchange is eventually-consistent best-effort within 3 rounds; convergence remains the head's job.

**Risk:** If a child crashes mid-write, the WAL may need checkpoint recovery on next open. Mitigation: `busy_timeout=5000` plus `close` checkpoint; a partial finding is tolerable because synthesis is best-effort over whatever findings exist.
