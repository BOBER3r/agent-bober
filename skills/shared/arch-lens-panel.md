# Arch Lens Panel — Canonical Protocol Reference

This document is the single source of truth for native architect panel orchestration in agent-bober.
It embeds the six canonical arch lens focus fragments verbatim from
`src/orchestrator/arch-lenses.ts` (the `ARCH_LENS_CATALOG` literal) and documents the
CP2 synthesis panel and CP5 reconcile panel protocols.
The drift gate (`src/orchestrator/arch-lens-panel-parity.test.ts`) enforces byte-exact parity.

---

## Lens Focus Fragments

The following fragments are the exact strings returned by `resolveArchLensFocus(lens)` for each
built-in arch lens. They MUST remain byte-for-byte identical to the corresponding entries in
`ARCH_LENS_CATALOG` — the drift gate (`src/orchestrator/arch-lens-panel-parity.test.ts`) enforces this.

### scalability

```
Focus on whether the proposed architecture can handle projected load growth. Evaluate horizontal and vertical scaling paths, bottlenecks, stateful vs stateless components, and whether partitioning or sharding strategies are available when needed.
```

### security

```
Focus on the threat surface introduced by this architecture. Evaluate trust boundaries, data flows across zones, authentication and authorisation enforcement points, secrets management, and exposure of internal services.
```

### cost

```
Focus on the total cost of ownership implied by this architecture. Evaluate compute, storage, and egress costs at projected scale, licensing or SaaS subscription expenses, and the operational overhead of running, monitoring, and scaling the system.
```

### operability

```
Focus on how easy it will be to operate this architecture in production. Evaluate observability (metrics, logs, traces), deployment complexity, rollout and rollback procedures, on-call burden, and the blast radius of common failure modes.
```

### maintainability

```
Focus on how easy it will be to change and extend this architecture over time. Evaluate coupling between components, clarity of boundaries, documentation needs, onboarding friction for new contributors, and the risk of accruing technical debt.
```

### reversibility

```
Focus on how difficult or costly it would be to undo or replace this architectural decision. Evaluate lock-in to vendors or proprietary technologies, data migration complexity, and whether a strangler-fig or incremental migration path exists if the approach needs to change.
```

---

## Native Architect Panel Protocol

### CP2 Synthesis Panel

At Checkpoint 2 (candidate generation + scoring), the orchestrator runs the synthesis panel:

1. **Generate candidates:** The architect produces 2–3 candidate approaches that satisfy the
   Checkpoint 1 constraints.

2. **Lens scorer fan-out (one per lens):** The orchestrator spawns one scorer subagent per
   configured arch lens (scalability, security, cost, operability, maintainability, reversibility),
   bounded by `maxConcurrent`. Each scorer receives the same candidate set and is instructed to
   score the candidates exclusively through its lens focus fragment (the exact string returned by
   `resolveArchLensFocus(lens)` from `src/orchestrator/arch-lenses.ts`).

3. **Synthesis:** `synthesize()` in `src/orchestrator/synthesizer.ts` aggregates the per-lens
   scores and produces a ranked winner with dissent. The highest-scoring approach across lenses
   becomes the recommended architecture; any lens that preferred a different candidate is recorded
   as a dissenting voice in the synthesis output.

### CP5 Reconcile Panel

At Checkpoint 5 (review pass), the orchestrator runs the reconcile panel:

1. **Lens reviewer fan-out (one per lens):** The orchestrator spawns one reviewer subagent per
   configured arch lens. Each reviewer receives the assembled architecture document and ADRs, and
   is instructed to produce a PASS/FAIL verdict exclusively through its lens focus fragment.

2. **Reconciliation — fail-closed on tie:** `reconcile()` in
   `src/orchestrator/workflow/reconciler.ts` aggregates the per-lens verdicts using the following
   semantics:

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

### lensVerdicts Output Shape

After reconciliation the orchestrator writes a `lensVerdicts` array into the saved result.
The array shape is:

```ts
lensVerdicts: Array<{
  lens: string;    // e.g. "scalability", "security", "cost", "operability", "maintainability", "reversibility"
  passed: boolean; // individual lens verdict
  summary: string; // per-lens summary from the scorer or reviewer subagent
}>
```

This field is optional and backward-compatible: results produced before the panel feature
(or by non-panel architect runs) simply omit it.
