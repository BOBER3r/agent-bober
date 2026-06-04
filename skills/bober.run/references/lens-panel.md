# Lens Panel — Canonical Protocol Reference

This document is the single source of truth for native panel orchestration in agent-bober.
It embeds the four canonical lens focus fragments verbatim from
`src/orchestrator/eval-lenses.ts` (the `LENS_CATALOG` literal) and documents the
split fan-out, majority-vote/fail-closed reconciliation, and the `lensVerdicts` output shape.

---

## Lens Focus Fragments

The following fragments are the exact strings returned by `resolveLensFocus(lens)` for each
built-in lens. They MUST remain byte-for-byte identical to the corresponding entries in
`LENS_CATALOG` — the drift gate (`src/orchestrator/lens-panel-parity.test.ts`) enforces this.

### correctness

```
Focus on whether the implementation actually satisfies each success criterion verbatim. Check that all required behaviours exist, all edge cases are handled, and the contract's definitionOfDone is met.
```

### security

```
Focus on injection vulnerabilities, authentication and authorisation gaps, secret handling, unsafe input validation, and any path traversal or privilege escalation risks.
```

### regression

```
Focus on whether previously working behaviour still works after the changes. Verify that pre-existing tests pass, that no public API or config interface was broken, and that the sprint diff does not silently remove functionality.
```

### quality

```
Focus on principles violations, dead code, misleading naming, smells, duplicated logic, and whether the implementation follows the project's established patterns and conventions.
```

---

## Native Panel Protocol

### Split Fan-out

When the native panel is active, the orchestrator spawns evaluators in two passes:

1. **Deterministic evaluator (one instance):** runs the configured strategy suite exactly once
   (build, typecheck, lint, unit-test, playwright, api-check, etc.). This produces the
   deterministic verdict — objective, tool-based checks that do not depend on lens focus.

2. **Qualitative evaluators (one per configured lens):** each evaluator receives the same
   sprint diff and context but is instructed to judge the contract's success criteria
   exclusively through its lens focus fragment. The strategy suite is **not** re-run for
   these evaluators — they perform qualitative assessment only, using the results already
   collected by the deterministic evaluator as supporting context.

This split ensures strategies execute once (no duplicate CI cost) while each lens evaluates
the diff independently.

### Reconciliation — Majority Vote, Fail-Closed

The lens verdicts are reconciled by `reconcile()` in
`src/orchestrator/workflow/reconciler.ts` using the following semantics:

- **Inputs:** the array of per-lens `EvalResult` objects (`lensVerdicts`).
- **Require non-empty:** an empty array throws `"reconcile: lensVerdicts must be non-empty"`.
- **Vote count:** `passCount` = number of lenses where `passed === true`;
  `failCount` = total − passCount.
- **Verdict:** `passed = passCount > failCount` (strict majority).
  - **Fail-closed on tie:** when `passCount === failCount` the panel verdict is `false`.
- **Details:** union of all failing lens details, de-duplicated by `(criterion, message)` key.
- **Feedback:** failing lenses' feedback joined with `\n`; `"All lenses passed."` when all pass.
- **Summary:** `"Panel verdict: ${passCount}/${n} lenses passed"`.
- **Score:** `Math.round((100 * passCount) / n)`.
- **Evaluator tag:** `evaluator = "panel"`.
- **Timestamp:** echoed verbatim from the input argument (pure function, ADR-4).

### Combine

The final sprint verdict combines both passes:

```
final.passed = deterministic.passed && reconciled.passed
```

Both must pass for the sprint to be accepted.

### lensVerdicts Output Shape

After reconciliation the orchestrator writes a `lensVerdicts` array into the saved
`EvalResult` JSON and sets `evaluator = "panel"`. The array shape is:

```ts
lensVerdicts: Array<{
  lens: string;    // e.g. "correctness", "security", "regression", "quality"
  passed: boolean; // individual lens verdict
  summary: string; // per-lens summary from the qualitative evaluator
}>
```

This field is optional and backward-compatible: eval results produced before the panel
feature (or by non-panel evaluators) simply omit it.
