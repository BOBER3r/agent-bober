# ADR-2: Fail-closed security gate — veto on critical findings and timeouts

**Decision:** The in-pipeline `SecurityAuditGate` blocks the `sprint-passed` commit on any finding in the critical bucket AND fails closed (blocks) on timeout or audit error, inverting the code-reviewer's fail-open, never-block posture.

**Context:** Pipeline output can manage real customer funds, yet the only post-evaluation audit (`code-reviewer-agent.ts:41-45`) is advisory and never blocks. The gate is the one component with veto power, so its timeout and severity semantics decide whether a missed vulnerability ships.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A: Fail-open on timeout, advisory only (mirror code-reviewer at `pipeline.ts:476-482`) | Byte-identical wrapper reuse; no new blocking path | A timeout OR a genuine critical vuln lets fund-losing code pass — no veto exists |
| B: Fail-closed on timeout, block on any critical finding (selected) | Missed/hung audit blocks instead of passing; satisfies 'critical finding prevents sprint-passed' | A hung or misconfigured auditor halts otherwise-passing sprints |
| C: Block on critical AND important, fail-closed | Strictest coverage | Important-bucket findings are advisory-grade — over-broad veto stalls the pipeline on noise |

**Rationale:** The dominant false-negative-cost constraint (missed vulnerability = fund loss) and the required fail-closed posture (as in `src/medical/`) eliminate Option A. The success criterion 'critical finding prevents sprint-passed' scopes the veto to the critical bucket, eliminating Option C's over-veto. Backward compatibility holds because the gate is opt-in default-off (`SecuritySectionSchema.enabled=false`).

**Consequences:** A gated block is added between the `evaluation.passed` check and the `sprint-passed` history event (`pipeline.ts:434-456`); when enabled and a critical finding or timeout occurs, the sprint is not marked passed, a `security-audit-blocked` history event is written, and the run defers to the existing retry/maxIterations path. When disabled, the block is never constructed.

**Risk:** A false-positive critical finding blocks a correct sprint (developer friction); if the auditor model is persistently misconfigured, every enabled sprint fails closed and the pipeline stalls until config is corrected.
