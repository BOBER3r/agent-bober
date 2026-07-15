# ADR-6: A security-blocked sprint skips the documenter

**Decision:** When the gate blocks, the documenter stage (`pipeline.ts:513-547`) does not run for that round.

**Context:** The documenter runs INSIDE the `evaluation.passed` block, AFTER the `sprint-passed` history event (`pipeline.ts:510-547`). Placing the gate before `sprint-passed` means control never reaches the documenter on a block. The question is whether to add an explicit documenter-on-block path anyway.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A: Skip documenter on block (natural placement, selected) | Docs never describe vulnerable/blocked code as done; zero new wiring | No sprint-doc record of the block beyond the history event + `.bober/security/` markdown |
| B: Run documenter anyway | A doc exists for every round | Documents unshipped, vulnerable code as complete — actively misleading; wastes an LLM call on code about to change |

**Rationale:** Locked Checkpoint-1 constraint — the documenter documents a PASSED sprint (`schema.ts:201-214`); a blocked sprint is by definition not passed. The `security-audit-blocked` history event plus the persisted audit markdown already record the block, so no explicit documenter-on-block path is warranted.

**Consequences:** Documentation is produced only for sprints that pass BOTH the evaluator and the security gate. The `.bober/security/<contractId>-security-audit.md` file is the human-readable record for blocked rounds.

**Risk:** If an operator relies on per-sprint docs as the only audit trail, a blocked sprint appears "undocumented"; the history event and security markdown mitigate this, but tooling that scrapes only sprint docs would miss it.
