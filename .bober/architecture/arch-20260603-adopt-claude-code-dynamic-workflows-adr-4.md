# ADR-4: Evaluator Panel Reconciliation as a Pure Reducer, Shared Host+Script

**Decision:** `EvaluatorPanelReconciler.reconcile` is a pure, side-effect-free majority-vote reducer over `EvalResult[]` (`eval-result.ts:60`), authored to run both in the TS host and as a pure-JS port inside the script.

**Context:** The workflow-unique adversarial/lensed evaluator panel produces one `EvalResult` per lens; these must be reconciled into a single canonical `EvalResult` deterministically, inside a pure-JS script that cannot call `Date.now`.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| Pure reducer shared host+script | Deterministic; runs inside script retry loop; no extra agent | Pure-JS port and TS copy can drift |
| Reconcile only in host after script returns raw lenses | Single reconciler copy | Script retry loop cannot branch on verdict without a host round-trip |
| Extra bober-evaluator agent reconciles | No port to maintain | Burns an agent vs 16/1000 caps; non-deterministic; slower |

**Rationale:** Checkpoint-1 "16 concurrent / 1000 total agent caps" plus "deterministic background" eliminate the reconciler-agent. Checkpoint-1 "pure-JS NO `Date.now`" is satisfied by a pure reducer with a caller-injected timestamp, letting the same code run in the script retry loop.

**Consequences:** `reconcile(sprintId, round, lensVerdicts) => EvalResult` produces `evaluator: "panel"`; the timestamp is supplied by the caller (host stamps on flush). The script retry loop branches on `reconcile().passed` without a host round-trip.

**Risk:** The pure-JS port and the TS copy drift, so a sprint passes under the workflow engine but fails under the TS engine for identical lenses — mitigated by `EngineConformanceHarness` asserting identical reconciled verdicts across engines for fixture lens sets.
