# Wire the fail-closed SecurityAuditGate into the pipeline

**Contract:** sprint-spec-20260712-security-audit-agent-team-3  ·  **Spec:** spec-20260712-security-audit-agent-team  ·  **Completed:** 2026-07-12

## What this sprint added

**The veto.** Sprint 2's callable `runSecurityAudit` core now has an entry point: a **fail-closed
`SecurityAuditGate`** (`evaluateSecurityGate`) wired **additively** into `runSprintCycle` at the **top**
of the `if (evaluation.passed)` branch — **before** the sprint is marked `passed`, before the
`sprint-passed` history event, and before the advisory code-reviewer's post-pass slot (ADR-2, ADR-6).
On a critical finding, a `Promise.race` timeout, an unparseable audit, or any thrown audit error the
gate **blocks**: no `sprint-passed`, a `security-audit-blocked` history event, the rendered findings fed
into the **next generator iteration's feedback** via the same channel evaluator feedback uses (ADR-5),
and deferral to the **existing** retry / `maxIterations` tail — the code-reviewer and documenter never
run on a blocked round. A clean audit records a `security-audit-clean` event and falls through
untouched. When `config.security` is **absent or `enabled !== true`** (the common case) the entire
branch is skipped and the pipeline is **byte-identical** to before. The `pipeline.ts` change is
additive-only (**98+/0-**); the code-reviewer/documenter stages are untouched (line numbers shifted
only).

## Public surface

- `evaluateSecurityGate(input)` (`src/orchestrator/security-gate.ts:72`) — `async (SecurityGateInput) →
  Promise<SecurityGateVerdict>`. **Never throws.** Disabled short-circuit returns
  `{blocked:false, reason:'disabled'}` **without invoking the audit at all**
  (`config.security?.enabled !== true`). Otherwise it wraps `runSecurityAudit` in a `Promise.race`
  time-box (`config.security.timeoutMs`): a race timeout → `{blocked:true, reason:'timeout'}`; any other
  rejection → `{blocked:true, reason:'audit-error'}`; `result.parsed === false` → `{blocked:true,
  reason:'audit-error', result}` (checked **before** `result.verdict` so a parse failure is never
  mistaken for a genuine critical finding); `result.verdict === 'blocked'` → `{blocked:true,
  reason:'critical-finding', result}`; else `{blocked:false, reason:'clean', result}`. A best-effort
  `saveSecurityAudit` is wrapped in its own try/catch and **can never flip the already-computed
  verdict** (sc-3-6).
- `renderSecurityFeedback(verdict)` (`src/orchestrator/security-gate.ts:141`) — **pure** exported
  function, `(SecurityGateVerdict) → string[]`. Returns `[]` for a non-blocked verdict; a single generic
  message when there is no `result` to enumerate (`timeout` / rejected `audit-error` resolve no result);
  otherwise a summary line plus one line per critical finding phrased for a **fixer** (`[CRITICAL]
  <vulnClass>: <description> at <path>:<line> — remediate by …`), capped to `MAX_RENDERED_FINDINGS` (20).
- `SecurityGateVerdict` (`src/orchestrator/security-gate.ts:40`) — `{ blocked: boolean; reason:
  SecurityGateReason; result?: SecurityAuditResult }`.
- `SecurityGateReason` (`src/orchestrator/security-gate.ts:33`) — `'critical-finding' | 'timeout' |
  'audit-error' | 'clean' | 'disabled'`.
- `SecurityGateInput` (`src/orchestrator/security-gate.ts:26`) — `{ contract: SprintContract; evaluation:
  EvaluationRunResult; projectRoot: string; config: BoberConfig }`.
- **History events (new).** The pipeline now appends two event kinds (free-form `appendHistory`, no
  schema migration): `security-audit-blocked` (`src/orchestrator/pipeline.ts:482`, phase `rework`,
  `details: { reason, critical: N, findings: [{ path, line, vulnClass? }] }` — findings capped to 20)
  and `security-audit-clean` (`src/orchestrator/pipeline.ts:526`, phase `complete`, `details: {
  reason }`). Both are appended **only** when `config.security.enabled === true`.

## How to use / how it fits

The gate is invoked **only** from inside `runSprintCycle`; there is no new CLI or public entry point in
this sprint (the standalone `bober security-audit` command lands in sprint 4). To exercise it, opt into
the `security` section:

```jsonc
// bober.config.json — opt-in, default-off
"security": {
  "enabled": true,          // the gate does nothing unless this is exactly `true`
  "failClosed": true,
  "timeoutMs": 300000,
  "model": "opus"
}
```

With `enabled: true`, on every sprint that passes evaluation the pipeline runs the auditor over the
contract's files. The control flow at `src/orchestrator/pipeline.ts:453`:

1. `evaluateSecurityGate(...)` — never throws.
2. **Blocked** → log, write the rendered findings onto `currentContract.evaluatorFeedback`, persist the
   contract, append `security-audit-blocked`, stash the feedback in `pendingSecurityFeedback`, then
   **mirror the eval-failed retry tail**: emit `sprint-fail-retry` telemetry and `continue` when
   iterations remain, or set status `needs-rework` and return at `maxIterations`. Control **never**
   reaches the `passed` block, so code-review and documenter do not run.
3. On the next iteration, `pendingSecurityFeedback` is drained into `evalFeedbackParts`
   (`src/orchestrator/pipeline.ts:286`) — the **same** channel evaluator feedback flows through — so the
   generator sees the security findings as actionable retry guidance.
4. **Clean** → append `security-audit-clean` and fall through to the existing `passed` →
   code-review → documenter flow exactly as before.

When `security` is absent/disabled the gate contributes **no statement, no history event, and no timing
dependency** — proven by a frozen-clock **deep-equal** paired-run test over both the full result object
and the complete `appendHistory` call array (sc-3-4).

## Notes for maintainers

- **This is the only sprint that edits `pipeline.ts`.** The diff is surgical and additive-only
  (98+/0-); the blocked path deliberately **mirrors** the eval-failed retry tail rather than inventing a
  new loop. The code-reviewer stage, its time-box, and its post-pass position are **locked** (nonGoals)
  and untouched.
- **No auto-commit-revert on block.** The generator's auto-commit is intentionally left in place — a
  block routes findings into the retry, which regenerates; the pipeline never fights the commit
  (architecture risk decision, nonGoals).
- **Veto scope is `critical` only.** The gate reads `result.verdict` / `review.critical`, **never**
  `review.important`. Important-bucket findings do not block (ADR-2).
- **Documented narrowing cast (advisory).** Both `security-gate.ts:158` and the `pipeline.ts` history
  builder narrow `review.critical` with `as SecurityFinding[]` to read the optional `vulnClass` — safe
  today (the auditor always constructs `review.critical` from `SecurityFinding` objects) but **not**
  compiler-verified, because `SecurityAuditResult.review` is typed as the locked `ReviewResult`. This is
  a deliberate choice to avoid touching the locked types; the evaluator flagged it as a low advisory
  (awareness only).
- **Two low advisories left as-is (not fixed).** The evaluator noted (1) the finding-cap `20` is a magic
  number duplicated between the unexported `MAX_RENDERED_FINDINGS` in `security-gate.ts:128` and the
  inline `.slice(0, 20)` in `pipeline.ts:490` — exporting/importing the constant would de-dup it; and
  (2) the security `needs-rework` return at `pipeline.ts:516` includes `generatorResult` while the
  eval-failed mirror omits it — a harmless shape divergence. Both are quality nits, not correctness
  issues.
- **Still not wired (later sprints).** The standalone `bober security-audit` CLI (sprint 4), the
  deterministic scanner pre-filter (sprint 5), and hub Finding emission (sprint 6) are out of scope
  here; the `security.standaloneBlockOn` / `security.hub` / `security.scanners` config keys remain
  declared-but-unconsumed until then.

## Scope

Iteration 1 (single commit) — `e60422c` — created exactly the estimated files: new
`src/orchestrator/security-gate.ts` (+ `security-gate.test.ts`, 16 tests table-testing all five verdict
reasons incl. a fake-timer timeout and the `parsed:false → audit-error` elevation) and additive changes
to `src/orchestrator/pipeline.ts` (+ new `pipeline.test.ts`, 4 tests: clean round, blocked round,
feedback routing, and the frozen-clock byte-identity paired run). `code-reviewer-agent.ts`,
`documenter-agent.ts`, `bober.config.json`, and `package.json` are untouched. Full suite **3960 → 3980**
green (+20). All 7 required criteria (sc-3-1..3-7) passed iteration 1.
