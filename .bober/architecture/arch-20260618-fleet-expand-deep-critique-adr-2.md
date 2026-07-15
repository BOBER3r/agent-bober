# ADR-2: Opt-in `critique` field on DecomposeDeepInput preserves byte-identical Phase-3 default

**Decision:** Thread the critic as a single optional `critique?: boolean` on DecomposeDeepInput (decomposer-deep.ts:81-88) plus a single `--critique` flag, so absent/false runs the unchanged plan→expand→return path.

**Context:** Checkpoint-1 HARD constraint 2 requires the `--critique`-absent run to be byte-identical to Phase 3; constraint 4 (LOCK2) requires a boolean flag on the existing subcommand, not a sibling command.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A: optional field + flag spread into arg object | One field; falsy ⇒ identical sequence; spread keeps arg object byte-identical; no sibling | One new conditional branch in decomposeGoalDeep |
| B: sibling fn + `expand-deep-critique` command | Zero edits to existing call sites | Violates LOCK2; duplicates plan→expand; invites drift |
| C: always-run critic gate | No flag plumbing | Violates LOCK2; default path no longer byte-identical (constraint 2) |

**Rationale:** Constraint 2 eliminates C (an unconditional critic changes the default chat sequence); constraint 4 (LOCK2) eliminates B (sibling forbidden); A's spread `...(opts.critique?{critique:true}:{})` makes the decompose arg object structurally identical when the flag is absent.

**Consequences:** DecomposeDeepInput and FleetExpandDeepOptions each gain one optional field; one `.option()` line is added; runFleetExpandDeep steps 1,3,4,5,6 are untouched; a regression test asserts the decompose arg equals the Phase-3 object when `--critique` is absent.

**Risk:** If a future edit reads `opts.critique` outside the guarded spread, the default path silently diverges — mitigated by a byte-identity regression test pinned to the Phase-3 call sequence and written bytes.
