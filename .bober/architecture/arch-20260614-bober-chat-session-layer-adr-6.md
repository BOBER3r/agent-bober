# ADR-6: Per-Turn Roster via readRunStatesFromDisk, Never RunManager.load()

**Decision:** Read the run roster each turn with the non-reconciling `readRunStatesFromDisk(projectRoot)` (run-state.ts:110), NEVER `RunManager.load()`.

**Context:** The session must show a live roster every turn without owning run lifecycle. `RunManager.load()` destructively reconciles any `running` state to `failed` (run-manager.ts:251-256) on the assumption that an in-memory process should be backing it — but the session's workers are detached children with no in-memory backing.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A. readRunStatesFromDisk (pure reader) | Non-destructive; shows true `running` state of detached children | None for read-only use |
| B. RunManager.load() | Reuses the manager's loader | Reconciles `running`→`failed` (run-manager.ts:251-256), corrupting the roster of live detached workers |

**Rationale:** Checkpoint-1 success criterion "roster read from disk via the non-reconciling reader each turn, never from LLM context" and the requirement that "a worker completion surfaced in a subsequent turn" eliminate B: `RunManager.load()` would flip every live detached worker to `failed` (run-manager.ts:251-256), so completions could never surface correctly. Only `readRunStatesFromDisk` preserves the true `running` status.

**Consequences:** `RosterReader.read()` delegates to `readRunStatesFromDisk(projectRoot)`. A collocated unit test asserts the roster path never invokes `RunManager.load()` and preserves a `running` state across a read.

**Risk:** If a future refactor routes roster reads through `RunManager.load()`, live workers silently appear `failed`. The unit guard test is the standing mitigation; if it is removed, the regression returns.
