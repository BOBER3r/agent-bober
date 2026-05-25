---
name: migration-timeout
classification: emergency
applicableSymptoms:
  - database migration timing out
  - migration hanging
  - db migration stuck
  - alembic timeout
  - flyway hung
  - liquibase blocked
  - migration not completing
  - schema change stuck
prerequisites:
  - database read access (pg_stat_activity or equivalent for your DB)
  - ability to query running transactions (DBA or equivalent privilege)
  - access to migration tool logs (alembic / flyway / liquibase / custom runner)
  - rollback plan documented before execution (REQUIRED for emergency classification)
---

## Step 1: Identify the hung migration
blastRadius: safe

precondition-check:
  - Migration runner process is still active OR timeout error is visible in logs
  - Migration tool name known (alembic / flyway / liquibase / custom)

execute:
  - Query migration tool logs for the last applied step and current pending step
  - Record migration name, expected duration, and how long it has been running

postcondition-check:
  - Hung migration name and run duration recorded in observations.jsonl
  - The specific migration file identified (e.g., V42__add_index_on_orders.sql)

## Step 2: Check for blocking locks or long-running transactions
blastRadius: safe

precondition-check:
  - Database connection string available (from environment or bober.config.json)
  - Migration identified from Step 1

execute:
  - For PostgreSQL: query pg_stat_activity for long-running queries blocking the migration table or target table
  - For MySQL: query INFORMATION_SCHEMA.INNODB_TRX or SHOW PROCESSLIST
  - For SQLite: check for lock files (.db-wal, .db-shm, open file handles)
  - Record blocking process IDs, query text, and duration

postcondition-check:
  - Blocking transaction list recorded in observations.jsonl (or 'no blockers found' confirmed)
  - If blockers found: blocking PID(s) and query text documented

## Step 3: Classify — abort-safe vs abort-unsafe
blastRadius: safe

precondition-check:
  - Migration step identified from Step 1
  - Blocking lock status known from Step 2

execute:
  - Classify the migration as abort-safe or abort-unsafe:
    - abort-safe: migration is a DDL-only add (ADD COLUMN with default, CREATE INDEX CONCURRENTLY, CREATE TABLE)
    - abort-safe: no data has been written yet (migration is blocked before first DML)
    - abort-unsafe: migration has started writing data (INSERT/UPDATE/DELETE executed partially)
    - abort-unsafe: migration involves a multi-step write that cannot be left half-applied
  - Record classification and reasoning in observations.jsonl

postcondition-check:
  - Classification recorded as 'abort-safe' or 'abort-unsafe' with reasoning
  - If abort-unsafe: rollback path explicitly documented before proceeding

## Step 4: Decide kill-or-wait
blastRadius: risky

precondition-check:
  - Classification from Step 3 available
  - If abort-unsafe: rollback path reviewed and documented in observations.jsonl
  - Operator approval obtained (this step is risky — changes database state)

execute:
  - If abort-safe AND blocking locks found from Step 2: terminate the blocking session (kill PID or equivalent)
  - If abort-safe AND no blockers: extend timeout or re-run the migration
  - If abort-unsafe AND migration has been running > 2x expected duration: escalate via checkpoint; do NOT kill without explicit operator approval
  - If abort-unsafe AND operator approves abort: signal the migration runner to abort cleanly; do NOT use SIGKILL immediately

postcondition-check:
  - If kill executed: blocking session no longer appears in pg_stat_activity / SHOW PROCESSLIST
  - If migration re-run triggered: migration runner shows active execution in logs
  - If escalated: checkpoint entry created with full evidence (migration name, duration, classification)

rollback:
  - If kill of blocking session causes migration to fail: re-run the migration from the beginning (it is abort-safe by precondition)
  - If migration aborted mid-write (abort-unsafe path): execute rollback migration if provided; otherwise escalate immediately

## Step 5: Verify migration outcome and database integrity
blastRadius: safe

precondition-check:
  - Step 4 completed (kill, re-run, or escalation)
  - Migration runner accessible

execute:
  - Query migration tool for current applied state (should show migration as applied or failed, not stuck)
  - Verify the target table/index exists (or does not exist if migration was aborted)
  - Check for orphaned partial writes if migration was abort-unsafe and killed: run integrity checks on affected table
  - Record outcome in observations.jsonl

postcondition-check:
  - Migration state is not 'stuck' — it is either 'applied', 'aborted', or 'pending-for-retry'
  - If 'applied': target schema change confirmed present in database schema
  - If 'aborted': no partial writes remain (integrity check passed or escalated if failed)
  - Outcome recorded in observations.jsonl with final migration state

## Step 6: Record rollback path if killed mid-write
blastRadius: risky

precondition-check:
  - Migration was abort-unsafe AND was killed mid-write (Step 4 abort-unsafe path)
  - Partial write confirmed or suspected from Step 5

execute:
  - Execute the compensating/rollback migration to undo partial writes
  - Verify rollback migration completes cleanly

postcondition-check:
  - Rollback migration applied successfully
  - Target table in pre-migration state confirmed by schema inspection
  - No partial data in affected rows

rollback:
  - If rollback migration also fails: escalate immediately via checkpoint with full state; mark incident as critical; do NOT attempt further automated recovery
