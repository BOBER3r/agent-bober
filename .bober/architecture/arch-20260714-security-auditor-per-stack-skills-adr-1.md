# ADR-1: Hybrid Per-Stack Security Knowledge — Skill Files + Typed Retrieval Index + Staged Verifier

**Decision:** Author per-stack security knowledge as human-editable `skills/bober.security-<stack>/SKILL.md` files composed of discrete labelled signature blocks, index them behind a typed retrieval layer that carries `cwe`/`severity`/`vulnClass`/`invariant` and performs top-K selection, and feed selected signatures to a two-stage finder→verifier audit.

**Context:** The auditor ships strong fail-closed orchestration but near-zero security knowledge: a one-sentence generic checklist (eval-lenses.ts:7-8), a 6-class taxonomy (security-audit-types.ts:9-15), no supply-chain coverage, and a stack resolver where 2 of 3 stacks inject non-security filler (stack-knowledge.ts:124-144). Money-handling (iGaming/DEX) customers need real reentrancy/money-logic/supply-chain detection with low false-positive load.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A. In-place prose (checklist in LENS_CATALOG + same-agent 2nd pass) | Smallest diff; no new files | Re-commits monolithic-checklist anti-pattern (research:187); same-agent pass inherits sprint-contract framing so sycophancy survives (research:186); no typed metadata |
| B. Skill files only (prose-blob whole-section injection, no typed index) | Human-editable markdown; reuses extractSecurityExcerpt | Whole-section blob injection (stack-knowledge.ts:140); no cwe/severity/vulnClass metadata; not benchmark-testable; no top-K |
| C. Typed code registry only (const signatures, no skill files) | Typed retrieval + unit-testable | NOT human-editable — violates the user amendment; no on-disk authoring surface |
| **Hybrid B⊕C (chosen)** | Human-editable skill files AS the authoring surface + typed index over them (top-K, structured metadata) + fresh-context verifier | Two moving parts (parser + index); malformed blocks must be tolerated |

**Rationale:** The user amendment mandates human-editable skill files, eliminating C-only. SOTA finding that long checklists degrade performance and favour retrieval-style selection (research:187) eliminates A's prose and B's whole-file injection. The structured `cwe`/`severity`/`vulnClass`/`taint` metadata requirement eliminates B-only. The fail-closed gate × false-positive-load constraint (every FP is a forced generator retry, pipeline.ts:466) eliminates A's same-agent second pass, which cannot strip the contract framing at security-auditor-agent.ts:206-208. Only the Hybrid satisfies all four.

**Consequences:** New `skills/bober.security-<stack>/SKILL.md` for 7 stacks + generic become canonical; a `SecuritySignatureParser` + `SecurityKnowledgeIndex` derive typed signatures per process; the finder consumes top-K signatures and a verifier stage re-checks its criticals in a contract-free context. Config stays additive/default-off (schema.ts:205-206).

**Risk:** If authors write malformed signature blocks, the typed index silently under-covers a stack. Mitigation: the parser is total (drops malformed blocks, never throws) and every stack keeps a generic-signature floor, so coverage degrades rather than failing closed on parse.
