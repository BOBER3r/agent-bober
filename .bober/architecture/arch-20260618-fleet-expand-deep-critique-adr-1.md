# ADR-1: Critique/refine loop structure — boolean critic, reused runExpandStage re-expand, accept-best-on-exhaustion

**Decision:** Structure the `--critique` loop as a fresh boolean `approve|reject`+free-text critic call, re-expanding rejected manifests by feeding feedback into a fresh runExpandStage (decomposer-deep.ts:280-315), bounded by CRITIQUE_MAX_ROUNDS and a closed-form DEEP_CRITIQUE_MAX_TOTAL_CALLS, accepting the best manifest on exhaustion (never throwing).

**Context:** A shape-valid-but-degenerate manifest (2 children for a 12-area outline) passes validateManifest (decomposer.ts:95-155). LOCK1 (fresh critic) and LOCK2 (--critique flag) are fixed; the open axis is verdict shape, re-expand mechanism, budget form, and exhaustion behavior.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A: boolean verdict + reuse runExpandStage + accept-best | Smallest parse surface, mirrors validateManifest; reuses runExpandStage; closed-form budget assertable via ScriptedClient.calls; never throws | Boolean+free-text feedback is coarser steering than graded scores |
| B: per-dimension rubric scores + threshold | Graded rank, tunable bar | Wider numeric Zod surface inflates coercion; threshold is an unanchored magic number |
| C: judge-and-revise single call | Lowest calls per round | Violates fresh-critic spirit (LOCK1); critic must satisfy children-only contract |

**Rationale:** The Checkpoint-1 explicit-constant budget constraint favors A's smallest closed form; LOCK1 (fresh critic) eliminates C; B's threshold is a magic number with no Checkpoint-1 figure to anchor it and widens the jsonObjectMode-only parse surface.

**Consequences:** runCritiqueLoop wraps EXPAND output below decomposeGoalDeep and above the unchanged validateManifest gate; re-expand calls existing runExpandStage with feedback-augmented goal; the no-flag path keeps an identical chat sequence, atomic write, and printed output; a CRITIQUE_MAX_ROUNDS constant plus a co-located budget test are added.

**Risk:** If boolean free-text feedback is too coarse to steer re-expansion, a worst-case all-reject run exhausts the budget and accept-best writes a still-marginal manifest — mitigated because accept-best is structurally valid and write-and-stop leaves the human as final gate; the path degrades to Phase-3 behavior, never below it.
