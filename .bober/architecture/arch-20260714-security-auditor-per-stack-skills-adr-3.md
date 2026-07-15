# ADR-3: Human-Authored Signature Skill Files with a Typed Retrieval Index

**Decision:** Store per-stack security signatures as discrete labelled blocks inside `skills/bober.security-<stack>/SKILL.md` (7 stacks + generic) and expose them through a typed `SecurityKnowledgeIndex` (`SecuritySignatureParser` → `SecuritySignature[]` → `SecuritySignatureSelector.select`), rather than as prose or as a code-only const table.

**Context:** The stack resolver maps only 3 stacks and, for 2 of them, `extractSecurityExcerpt` returns a non-security head excerpt (stack-knowledge.ts:124-144) — gap G3. Money-handling stacks (solidity, anchor, payments, igaming, dex-backend) have zero real signatures, and the selection layer needs structured `cwe`/`severity`/`vulnClass`/`invariant` to do top-K and to tag findings.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A. Prose in LENS_CATALOG | Zero new files; simplest | Monolithic-checklist anti-pattern (research:187); no per-signature metadata; not testable |
| B. Typed const registry only (no skill files) | Typed + unit-testable | NOT human-editable — violates user amendment; no on-disk authoring surface |
| **C. Skill files + typed index (chosen)** | Human-editable markdown authoring AND typed top-K retrieval with metadata; fixes G3 with real fragments | Needs a total parser; author markdown drift risk |

**Rationale:** The user amendment eliminates B (const-only is not human-editable). SOTA retrieval-over-checklist guidance (research:187) eliminates A's prose blob. The G3 constraint — each of 7 stacks must resolve to a REAL security fragment, not the head-excerpt fallback (stack-knowledge.ts:124-144) — is met only when authored skill blocks are parsed into typed signatures and selected, which is exactly option C.

**Consequences:** `resolveStackSecurityContext` replaces the stack-knowledge path (stack-knowledge.ts:185); `SecurityStackRegistry` extends `STACK_SKILL_MAP` from 3 → 7 + generic; the index is a per-process memoised cache (see ADR-7); every stack test asserts a non-fallback fragment.

**Risk:** A malformed or renamed signature block silently drops from a stack's coverage. Mitigation: the parser is pure and total (drops malformed blocks, never throws), a missing skill file yields `[]` not an exception, and every stack retains a generic-signature floor so `promptFragment` is never empty.
