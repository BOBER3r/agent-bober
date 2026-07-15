# ADR-5: Blocked security gate feeds findings to the generator as retry feedback

**Decision:** On a security block, thread the `SecurityFinding` evidence (path, line, snippet, vulnClass) into the generator's next-iteration handoff via `currentContract.evaluatorFeedback` / `evalFeedbackParts`, rather than blocking opaquely.

**Context:** ADR-2 defers a blocked sprint to the existing retry/maxIterations loop (`pipeline.ts:588-597`) but does not say whether the generator learns WHY it was blocked. The retry loop already feeds evaluator feedback to the generator (`pipeline.ts:250-274`, `evalFeedbackParts`), so a channel exists.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A: Inject findings into `evalFeedbackParts` (selected) | Generator gets an actionable fix target; reuses the existing feedback channel; converges in fewer rounds | Slightly larger handoff; findings must be phrased for a fixer, not an auditor |
| B: Opaque block (status only, no feedback) | Zero new wiring | Generator regenerates blind, re-introduces the same vuln, burns maxIterations, reaches needs-rework and ships nothing |

**Rationale:** The DOMINANT Checkpoint-1 constraint is false-negative cost in a fund-managing domain; a block that cannot converge just becomes needs-rework and ships nothing, so actionable remediation feedback is required. The retry channel already exists, making injection additive.

**Consequences:** Security findings render into the same feedback list the evaluators use; the generator sees `[CRITICAL] <vulnClass>: <desc> at path:line`. A new `renderSecurityFeedback` maps `SecurityFinding` to feedback lines.

**Risk:** If the generator "fixes" by suppressing the finding (deleting the flagged path) rather than remediating, a later gate round could pass on incomplete functionality; the evaluator, which runs first each round, guards against that regression.
