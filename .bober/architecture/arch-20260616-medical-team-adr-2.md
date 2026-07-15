# ADR-2: Red-Flag Gate as a Pre-LLM Deterministic Component

**Decision:** Implement emergency/crisis detection as a deterministic, 0-LLM `RedFlagDetector` that runs inside `GuardrailSet.evaluate()` BEFORE any LLM call, not as an LLM classifier.

**Context:** Acute prompts (cardiac, stroke, anaphylaxis, suicidal ideation) must escalate (911/988) immediately and reliably. An LLM classifier introduces latency, a network/model dependency, and non-determinism on the highest-stakes path.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| Deterministic local pattern detector | 0 LLM calls; offline; identical output every run; auditable rule that fired | Pattern maintenance; possible misses on novel phrasing |
| LLM red-flag classifier | Better paraphrase coverage | Adds latency; needs a model (egress risk); non-deterministic; can be prompt-injected |

**Rationale:** CP1 hard constraint "emergency red-flag detection short-circuits with 0 LLM calls (local deterministic check)" and "refusals CODE-ENFORCED not prompt-only" forbid placing the highest-stakes decision behind a model; an LLM classifier cannot satisfy the 0-LLM-calls clause, so it is eliminated.

**Consequences:** `RedFlagDetector.detect()` is pure/synchronous and runs first; `GuardrailVerdict.short-circuit` returns a canned escalation with zero downstream calls; `RedFlagDetector` carries a `patternsetVersion` recorded in the audit log.

**Risk:** If a genuine emergency is phrased outside the pattern set, the detector returns `none` and the prompt proceeds to normal (still guardrailed) handling rather than escalating; mitigated by a conservative, regularly-reviewed pattern set with versioning.
