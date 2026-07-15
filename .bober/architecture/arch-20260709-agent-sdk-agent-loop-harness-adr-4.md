# ADR-4: Budget-Exceeded Is a Graceful In-Loop Stop, Not a Thrown Error

**Decision:** When the USD ceiling is reached, `runAgenticLoop` breaks and returns a partial `AgenticLoopResult` with `stopReason: "budget_exceeded"`; it never throws `BudgetExceededError` and never calls `assertWithinBudget`.

**Context:** The ceiling must halt spend without destabilizing runs. The throw-versus-graceful-return choice decides whether hitting the ceiling crashes an in-flight sprint.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| Throw `BudgetExceededError` | Fail-fast; single unmissable signal | `runGenerator` at `pipeline.ts:329` has NO surrounding try/catch — the throw escapes uncaught and crashes the run mid-sprint |
| Graceful break + stopReason | Reuses the established `max_turns_exceeded` convention (`:406`); preserves partial work; caller decides via `success` | Callers ignoring `stopReason` see only a truncated result — acceptable, since no caller reads it today |

**Rationale:** The additive-only / byte-identical-when-absent constraint forbids introducing an uncaught throw into a path with no catcher (verified at `pipeline.ts:329`), so enforcement must mirror the existing graceful `max_turns_exceeded` return.

**Consequences:** Enforcement lives inside the loop; no caller needs a try/catch; role adapters route budget-truncated partials through the normal success/retry path; `assertWithinBudget` / `BudgetExceededError` remain available for the workflow interpreter's pre-dispatch use.

**Risk:** A future caller branching on `success` while assuming a full result could mis-commit a truncated partial; mitigated by adapters treating `"budget_exceeded"` as `success: false` wherever completeness matters.
