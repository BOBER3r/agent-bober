# ADR-3: Persist security audits to a separate `.bober/security/` store

**Decision:** Security audit artifacts are written to a new `.bober/security/<contractId>-security-audit.md` store via a dedicated `SecurityAuditStore`, mirroring `src/state/review-state.ts` rather than reusing `.bober/reviews/`.

**Context:** The audit must leave a human-readable, cited-findings artifact as the financial fail-closed record. The advisory code-reviewer already owns `.bober/reviews/<contractId>-review.md` (`review-state.ts:12-15`) and stays running unchanged, so both writers are active on every passing sprint.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A: Reuse `.bober/reviews/` + `saveReview` | Zero new module; reuses the existing writer | Collides on the `<contractId>-review.md` filename with the locked advisory reviewer — last-writer-wins clobber; conflates advisory and blocking provenance |
| B: New `.bober/security/` store (selected) | No filename collision; separable fail-closed audit trail; filesystem-state-only honored | ~40 lines of thin store code near-duplicating review-state.ts |
| C: History-only, no markdown | No new file store | Loses the cited-findings artifact required by success criteria; history rotation can evict the record |

**Rationale:** The locked constraint 'code-reviewer stays advisory / ReviewResult shapes locked' plus 'filesystem state only' require a separate writer — Option A's shared filename clobbers the advisory reviewer's artifact. Option C fails the 'structured cited findings' success criterion.

**Consequences:** A new `src/state/security-audit-state.ts` exposes `saveSecurityAudit`/`readSecurityAudit`/`listSecurityAudits`; markdown produced by reusing `renderReviewMarkdown(result.review)` — no new renderer.

**Risk:** A future consumer assuming all review artifacts live under `.bober/reviews/` would miss security audits; low — no such consumer exists in the current tree.
