# ADR-5: CLI coexistence — distinct `fleet expand-deep` sibling subcommand

**Decision:** Expose the robust engine as a NEW distinct sibling subcommand `fleet expand-deep <goal>` attached to the `fleet` parent (mirroring `registerFleetExpandSubcommand` / `registerWorktreeCommand`), keeping `fleet expand <goal>` byte-unchanged.

**Context:** The robust two-call engine must be reachable from the existing fleet CLI without altering the single-shot `fleet expand` path. We must decide how an operator opts into robust mode: a flag on the existing action, implicit auto-escalation, or a separate subcommand.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| (1) Flag on `fleet expand` (`--deep`/`--plan`) | one command to learn; no new registration | overloads one action with two engines; risks byte-drift in the locked `fleet expand` default path and option-parsing block |
| (2) Auto-escalation (run single-shot, detect degenerate/low-child result, auto-run deep) | zero new surface; "just works" | implicit behavior change to `fleet expand`; hides extra LLM-call cost; makes single-shot non-deterministic from the operator's view |
| (3) Distinct sibling subcommand `fleet expand-deep` (chosen) | explicit opt-in; leaves `fleet expand` byte-identical; mirrors the proven parent+child registration pattern | two near-identical subcommands to keep in sync |

**Rationale:** The CP1 constraint "both modes selectable, single-shot byte-unchanged, robust = explicit opt-in" eliminates options 1 and 2: a flag (1) must edit the byte-locked `fleet expand` action and its option block, breaking byte-identity; auto-escalation (2) changes `fleet expand`'s default behavior and hides extra LLM-call cost, the opposite of explicit opt-in. Only a distinct sibling subcommand (3) leaves `fleet expand` byte-identical while making robust mode an explicit, separately-invoked command.

**Consequences:** `registerFleetExpandDeepSubcommand(fleet)` is appended after `registerFleetExpandSubcommand(fleet)` inside `registerFleetCommand` (`src/fleet/index.ts:~345`); no existing line is changed and the same option set as `expand` is offered. Operators reach robust mode only via `fleet expand-deep <goal>`; `fleet expand <goal>` continues to behave exactly as in Phase 2.

**Risk:** Two near-identical subcommands and their actions can drift in option handling or write/spawn logic over time. Mitigation — `runFleetExpandDeep` mirrors `runFleetExpand` step-for-step and shares all reused machinery (`createClient`, atomic-write block, `--yes` gate), differing only in calling `decomposeGoalDeep`; a byte/diff assertion guards the locked `fleet`/`fleet expand` spans.
