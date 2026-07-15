# ADR-3: Verdict parse surface mirrors validateOutline; coercion budget closed-form and fail-open

**Decision:** validateVerdict returns `{ok:true,verdict}|{ok:false,error}` using the same tolerant JSON extraction as validateOutline (decomposer-deep.ts:107-155); the critic-with-parse-retry wrapper loops at most `(1+CRITIQUE_PARSE_MAX_RETRIES)` calls and on parse exhaustion fails OPEN (treats the verdict as approve).

**Context:** Constraint 5 mandates `jsonObjectMode:true` and never responseSchema (types.ts:183), so critic output is only syntactically-valid JSON and must be tolerantly extracted then Zod-validated; constraint 1 requires an explicit-constant budget; the backstop is human write-and-stop (index.ts:355-363).

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A: mirror validateOutline union + bounded parse-retry, fail-open | Consistent with decomposer-deep.ts:107-155; never throws; closed budget; unparseable critic cannot block backstop | A persistently broken critic silently degrades to Phase-3 with no gate |
| B: responseSchema to force shape | No parse-retry needed | Violates LOCK5; DeepSeek 400-rejects responseSchema |
| C: throw on unparseable | Loud failure | Violates write-and-stop backstop; discards a valid manifest; risks unbounded retry |

**Rationale:** Constraint 5 eliminates B; constraint 1 plus the write-and-stop backstop eliminate C (throwing on a critic glitch discards a structurally-valid manifest the human could still catch); A counts exactly `(1+CRITIQUE_PARSE_MAX_RETRIES)` calls per round into DEEP_CRITIQUE_MAX_TOTAL_CALLS=8.

**Consequences:** DEEP_CRITIQUE_MAX_TOTAL_CALLS=8 is pinned by a budget-audit test (mirroring decomposer-deep.test.ts:76-80) and a call-ceiling test (mirroring decomposer-deep.test.ts:267-275).

**Risk:** If the critic consistently emits unparseable output, the gate silently no-ops (fail-open) and degenerate manifests pass to human review as in Phase 3 — mitigated by logging each parse failure so the no-op is observable; human write-and-stop remains the guaranteed defense.
