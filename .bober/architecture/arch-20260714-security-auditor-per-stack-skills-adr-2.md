# ADR-2: Finder→Verifier Adversarial Stage in a Fresh, Contract-Free Context

**Decision:** After the finder produces a review, run a second `runSecurityVerifier` agentic loop that receives only the finder's `critical` + `important` findings (never the sprint contract, never `approvedAreas`), is prompted to DISPROVE each finding, and may only downgrade or drop — it can never upgrade or add.

**Context:** Under `config.security.enabled`, a blocked verdict feeds `renderSecurityFeedback` into the generator's next retry, so every false-positive critical is a hard forced retry (pipeline.ts:466). A single-pass loop (security-auditor-agent.ts:48) that also sees the sprint contract inherits its framing (security-auditor-agent.ts:206-208) and rubber-stamps its own findings (research:186).

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A. Same-agent second pass | No new prompt/role; cheapest | Inherits contract framing (security-auditor-agent.ts:206-208); sycophancy survives (research:186); no independent judgement |
| B. Confidence-threshold filter (drop tentative) | Deterministic; zero LLM cost | Blind heuristic; drops real criticals and keeps confident false positives; no reasoning |
| **C. Fresh contract-free verifier, downgrade-only (chosen)** | Independent adversarial judgement strips framing; ~50% FP cut (research:181); fail-closed on failure | Second LLM stage inside the time-box; adds a role/prompt |

**Rationale:** The fail-closed × FP-load constraint makes false-positive control a correctness requirement, not a nicety. Option A cannot strip the contract framing at security-auditor-agent.ts:206-208 that produces the sycophancy; Option B has no reasoning to distinguish a real reentrancy sink from a lookalike. A fresh contract-free verifier is the only option that independently disproves findings; research:181 measures ~50% FP reduction for this shape.

**Consequences:** A new `bober-security-verifier` prompt + `SecurityVerifierStage` reuse the read-only curator toolset (security-auditor-agent.ts:62-68). The finder's criticals are folded through `verified`/`downgraded`/`dropped`; `minor` + `approvedAreas` pass through untouched; `deriveVerdict` runs on the VERIFIED review.

**Risk:** The verifier over-prunes a genuine critical, letting a money-loss bug ship. Mitigation: downgrade-only semantics plus fail-closed `ran:false ⇒ finder criticals KEPT` mean a verifier failure can never yield a clean pass — the system is eventually-stricter, never eventually-looser.
