# ADR-3: RefusalDetector as a separate deterministic sibling to RedFlagDetector; GuardrailContext stays empty

**Decision:** Non-emergency content-policy refusals are detected by a new pure/synchronous `RefusalDetector` class (sibling to `RedFlagDetector`), surfaced via `MedicalGuardrails.evaluate` as `{ kind:"refuse" }` with fixed never-model-generated reason text, and `GuardrailContext` remains the empty placeholder.

**Context:** The `{kind:"refuse"}` verdict and `"refuse"` audit event already exist but are never emitted (`src/medical/guardrails.ts:94-97`). Refusals must be deterministic and pre-LLM (research REFUTED the in-line LLM policy filter), and must escalate differently from emergencies (decline + see-a-clinician, not a 911/988 hotline).

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A: separate `RefusalDetector` class + empty `GuardrailContext` | Single responsibility per detector; refuse vs short-circuit semantics stay distinct; own `patternsetVersion` for audit; mirrors `RedFlagDetector` (`src/medical/red-flag.ts:195-212`) | One more small class |
| B: fold refusal rules into `RedFlagDetector` | Fewer classes | Conflates two verdict kinds + two escalation messages in one detector; muddies the versioned patternset and the 988-vs-911 ordering logic (`src/medical/red-flag.ts:48-53`) |
| C: add fields to `GuardrailContext` to drive refusal | Future context-aware rules | No current rule needs context — the prompt string suffices (approved assumption #8); speculative, contradicts the empty-placeholder design (`src/medical/types.ts:20-22`) |

**Rationale:** The determinism constraint (pre-LLM, deterministic refusal) and the `RedFlagDetector` single-responsibility precedent eliminate B's conflation; approved assumption #8 (prompt string suffices) eliminates C — so `RefusalDetector` is a standalone detector and `GuardrailContext` stays empty.

**Consequences:** `evaluate()` runs `RedFlagDetector` first (short-circuit wins over refuse), then `RefusalDetector`; a match returns `{ kind:"refuse", rule: ruleId, reason: <fixed text> }`; `MedicalSopEngine.run` gains a refuse branch mirroring the consent-refuse path (`src/medical/engine.ts:217-248`) writing event `"refuse"` with `ruleId` + `patternsetVersion` only (no prompt text). `GuardrailContext` is untouched.

**Risk:** Conservative phrase matching may miss novel phrasings of a prescription/dosing request (false negative), which then fall through to the normal abstaining path rather than an explicit refusal — the same accepted-risk posture as `RedFlagDetector` (base ADR-2); mitigated by a versioned, reviewable patternset, never by an LLM filter.
