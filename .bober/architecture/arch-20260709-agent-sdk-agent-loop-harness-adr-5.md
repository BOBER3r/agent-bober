# ADR-5: Refusal Is Fail-Closed for Write-Capable Roles, Fail-Open Surfacing for Read-Only Roles

**Decision:** On a provider refusal, `runAgenticLoop` returns `refused: true` / `stopReason: "refusal"` (never throws); write-capable roles (generator, curator) map `refused` → `success: false`, while read-only/advisory roles (research, code-reviewer) surface the refusal text without failing the run.

**Context:** A refusal is silently returned as a normal completion (loop `:301`). It must not be recorded as a passing sprint, but roles differ: a refused write is a failure whereas a refused advisory answer can be legitimate.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| Loop throws on refusal | Impossible to ignore | Uncaught at `pipeline.ts:329` → crash; over-reacts for advisory roles |
| Uniform fail-open flag | Simplest | Generator refusal after a partial write stays `success: true` at `generator-agent.ts:260` → empty sprint committed as a pass |
| Per-role handling | Prevents false-pass commits; preserves legitimate advisory refusals; no throw | Each write-capable adapter must read the flag — a small, localized change |

**Rationale:** The additive-only constraint plus the success criterion that refusal must never be recorded as a pass eliminate the uniform fail-open flag, and the no-catcher fact from ADR-4 eliminates throwing.

**Consequences:** `parseGeneratorResult` gains a `refused` guard that returns `success: false` before the `filesWritten` check; read-only roles pass `finalText` through unchanged; the return-not-throw contract is preserved.

**Risk:** A new write-capable role that forgets to read `refused` reverts to false-pass; mitigated by documenting `refused` as a must-check field on the shared `AgenticLoopResult` for any role that commits work.
