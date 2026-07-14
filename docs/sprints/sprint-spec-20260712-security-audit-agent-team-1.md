# Add security config section, audit result types, and .bober/security store

**Contract:** sprint-spec-20260712-security-audit-agent-team-1  ·  **Spec:** spec-20260712-security-audit-agent-team  ·  **Completed:** 2026-07-12

## What this sprint added

The **typed foundation** for the forthcoming stack-aware security auditor (`bober-security-auditor`
role, see `arch-20260712-security-audit-agent-team`). Three additive, self-contained pieces landed —
**no auditor, gate, CLI, scanner, or hub emission yet** (those are sprints 2-6): (1) an **opt-in,
default-off** `SecuritySectionSchema` wired as an **optional** key on `BoberConfigSchema`, so any config
that omits `security` parses **byte-identically** to before (no key injected, no defaults materialized);
(2) wrapper types — `VulnClass`, `SecurityFinding`, `SecurityAuditResult`, and a pure `deriveVerdict()` —
that sit **on top of** the **locked** `ReviewResult`/`ReviewFinding` shapes (imported type-only, never
redefined); and (3) a `.bober/security/` markdown store (`saveSecurityAudit`/`readSecurityAudit`/
`listSecurityAudits`) kept **separate** from the advisory reviewer's `.bober/reviews/` per ADR-3. All
locked files (`code-reviewer-agent.ts`, `review-state.ts`, `bober.config.json`) have **zero diff**.

## Public surface

- `SecuritySectionSchema` / `SecuritySection` (`src/config/schema.ts:210`, `:229`) — the opt-in security
  config section. Fields: `enabled` (default `false`), `failClosed` (default `true`), `timeoutMs`
  (default `300000`), `model` (`ModelChoiceSchema`, default `"opus"`), `maxTurns` (default `20`),
  optional `provider`/`endpoint`/`providerConfig`, optional `budget` (reuses `BudgetSectionSchema`),
  `scanners` (`z.array(EvalStrategySchema)`, default `[]`), `standaloneBlockOn` (`z.enum(['critical',
  'important'])`, default `'critical'`) and `hub` (`z.boolean()`, default `true`). `standaloneBlockOn`
  and `hub` are declared **now** but consumed by later sprints (the standalone CLI gate and hub
  emission) to avoid re-touching this schema three times.
- `security: SecuritySectionSchema.optional()` on `BoberConfigSchema` (`src/config/schema.ts:633`) —
  **`.optional()` with no top-level default**, so an absent `security` section stays absent (byte-identity
  invariant). **Not** added to `createDefaultConfig` or any preset.
- `VulnClass` (`src/orchestrator/security-audit-types.ts:9`) — a coarse vulnerability taxonomy union:
  `'injection' | 'authn-authz' | 'secret-handling' | 'input-validation' | 'path-traversal' |
  'privilege-escalation'`.
- `SecurityFinding` (`src/orchestrator/security-audit-types.ts:23`) — `extends ReviewFinding` with one
  **optional** `vulnClass?: VulnClass` tag; never overrides a `ReviewFinding` field.
- `SecurityAuditResult` (`src/orchestrator/security-audit-types.ts:32`) — `{ review: ReviewResult; stack:
  string; scannerRan: boolean; parsed: boolean; verdict: 'pass' | 'blocked' }`. `review.critical[]` is the
  blocking signal; `verdict` is derived, never set independently.
- `deriveVerdict(review: ReviewResult): 'pass' | 'blocked'` (`src/orchestrator/security-audit-types.ts:52`)
  — **pure** function, exported for reuse by the core/gate/CLI in later sprints. Returns `'blocked'`
  **iff** `review.critical.length > 0`; important-only or minor-only findings never block.
- `saveSecurityAudit(projectRoot, contractId, result)` / `readSecurityAudit(projectRoot, contractId)` /
  `listSecurityAudits(projectRoot)` (`src/state/security-audit-state.ts:29`, `:45`, `:62`) — the
  `.bober/security/<contractId>-security-audit.md` store. `save` renders markdown by reusing the existing
  `renderReviewMarkdown(result.review)` (no new renderer); `read` of a missing id returns **`null`
  without throwing**; `list` returns the saved contract ids (filenames stripped of the
  `-security-audit.md` suffix), sorted. Async `node:fs/promises` only, `ensureDir` before write.

## How to use / how it fits

This sprint is **pure plumbing** — nothing runs it yet. It establishes the shapes the later sprints
consume:

- `deriveVerdict` is the single source of the pass/blocked decision the fail-closed gate (sprint 4) and
  the standalone `bober security-audit` CLI will call.
- `SecurityAuditResult.review` deliberately **wraps** the locked `ReviewResult` so audits reuse the
  reviewer's `critical`/`important`/`minor` buckets and its markdown renderer — the auditor emits the
  same finding shape as the advisory reviewer, but with a blocking verdict and an optional `vulnClass`.
- The store writes to `.bober/security/`, **not** `.bober/reviews/` (ADR-3), so the advisory reviewer's
  artifact is never clobbered — both writers run on every passing sprint once the auditor lands.

Minimal verdict usage:

```ts
import { deriveVerdict } from "agent-bober/dist/orchestrator/security-audit-types.js";

deriveVerdict({ critical: [], important: [f], minor: [] }); // => "pass"  (important never blocks)
deriveVerdict({ critical: [f], important: [], minor: [] }); // => "blocked"
```

## Notes for maintainers

- **Locked types are imported type-only.** `security-audit-types.ts:1` uses `import type { ReviewResult,
  ReviewFinding } from "./code-reviewer-agent.js"` — do not add a value import or redefine these shapes;
  the code-reviewer is the owner and stays advisory/unchanged.
- **Byte-identity is a hard invariant.** The section is `.optional()` with **no** top-level default and is
  **not** in `createDefaultConfig`; sc-1-2 is proven by a **deep-equal** parse test against the repo's real
  `bober.config.json` (before/after) plus `Object.hasOwn(parsed, 'security') === false` on fixtures — not
  by an absence assertion alone. Keep any future edit to this section behind the same test.
- **`standaloneBlockOn` and `hub` are placeholders for later sprints.** They are present in the schema now
  (sprints 4 and 6 consume them) but nothing reads them yet — do not assume behavior from their presence.
- **Store not in the barrel.** `saveSecurityAudit`/`readSecurityAudit`/`listSecurityAudits` are
  intentionally **not** re-exported from `src/state/index.ts` (no consumer yet) — a later sprint adds the
  barrel export when it wires the auditor. The store follows `review-state.ts` structurally (async fs,
  `ensureDir`, temp-dir tests, no fs mocks).
- **Store separation is deliberate (ADR-3).** `.bober/security/` exists to avoid the
  `<contractId>-review.md` filename collision with the locked advisory reviewer. A future consumer must not
  assume all review artifacts live under `.bober/reviews/`.

## Scope

Three commits — `f76ee2e` (types), `fc20eae` (schema), `4ae188f` (store) — touching exactly the estimated
files: new `src/orchestrator/security-audit-types.ts` (+ test), `src/config/schema.ts` (+ test), new
`src/state/security-audit-state.ts` (+ test). `bober.config.json`, `code-reviewer-agent.ts`, and
`review-state.ts` untouched (verified via `git diff --stat`). +26 tests; full suite **3903 → 3929**. All 5
required criteria (sc-1-1..1-5) passed iteration 1.
