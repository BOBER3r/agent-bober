# ADR-1: Security auditing as one stack-aware role with a fail-closed gate, not per-stack agents

**Decision:** Add security auditing as a single `bober-security-auditor` role driving one `runSecurityAudit()` core — reused by an in-pipeline fail-closed gate and a standalone audit skill — with stack expertise injected via existing skills and findings organised by the existing security-lens vulnerability taxonomy; NOT as per-stack agents and NOT as an evaluator-panel lens.

**Context:** Pipeline output managing real customer funds ships with only an advisory, never-blocking code-reviewer (`code-reviewer-agent.ts:41-45`). A blocking, stack-aware security check is needed in two modes (in-pipeline gate + on-demand deep audit) without regressing the byte-identical-when-unconfigured invariant. The product owner asked whether to divide security agents by stack — this ADR resolves that division axis.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A: Evaluator `security` lens / `command` scanner strategy | Zero new agent; reuses panel + `EvalStrategy.required`; free vulnerability-class taxonomy | Panel `reconcile()` is strict-majority with NO veto — a lone security fail is outvoted; scanner strategy needs unbuilt binaries and misses business-logic/access-control vulns; no standalone deep-audit mode |
| B (chosen): One stack-aware auditor role, one core, two entry points, fail-closed gate | Mirrors proven code-reviewer dual-entry; new stack = new skill not new agent; explicit own-veto blocks on one critical finding; additive/provider-agnostic | Single judgment call per audit; new attachment point before the sprint-passed commit |
| C: Per-stack auditor fleet (Solidity/Solana/Node/web) | Deepest per-stack specialisation; parallel via fleet substrate | N agents emit a parallel per-stack taxonomy; duplicates the skill mechanism; N-1 auditors dead weight per run; needs a bespoke veto atop majority reconcile |

**Rationale:** The 'critical finding prevents sprint-passed' success criterion under the DOMINANT false-negative-cost constraint eliminates A — `reconcile()` (`workflow/reconciler.ts`) computes `passed = passCount > failCount` with no veto. The 'no parallel taxonomy' locked dependency, reinforced by the per-role roster in `agents/*.md`, eliminates C. B satisfies both plus the byte-identical-when-unconfigured HARD constraint via the code-reviewer's one-core-two-entry precedent.

**Consequences:** New `bober-security-auditor` agent + `runSecurityAudit()` core; pipeline gains a fail-closed gate attached between the `evaluation.passed` check and the `sprint-passed` commit (`pipeline.ts:434-437`), distinct from the advisory reviewer's post-pass slot (`:466`); a standalone skill + command reuse the same core; stack coverage grows by adding skills, not agents; findings reuse `ReviewResult`/`ReviewFinding`.

**Risk:** If the injected stack skill lacks a vulnerability class present in the code (e.g., a Solana-specific issue absent from `bober.anchor`), the single auditor may miss it — a false negative on funds. Mitigation: pair the gate with `required` scanner `command` strategies as a deterministic pre-filter and treat skill checklists as the versioned coverage contract.
