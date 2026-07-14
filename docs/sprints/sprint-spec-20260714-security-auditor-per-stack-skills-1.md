# Widen the vulnerability taxonomy + add structured finding metadata + fix hub collision

**Contract:** sprint-spec-20260714-security-auditor-per-stack-skills-1  ·  **Spec:** spec-20260714-security-auditor-per-stack-skills  ·  **Completed:** 2026-07-14

## What this sprint added

The **typed foundation** for the per-stack security-auditor upgrade (arch-20260714-security-auditor-per-stack-skills). Three additive changes and one bug fix landed, all **behavior-preserving when the new fields/classes are absent**: (1) the `VulnClass` taxonomy widened from 6 classes to **17** (adds `race-condition`, `money-integrity`, `ssrf`, `xss`, `insecure-randomness`, `crypto-weakness`, `deserialization`, `supply-chain`, `idor-bola`, `denial-of-service`, `audit-logging`), kept in lockstep with `ALL_VULN_CLASSES`; (2) `SecurityFinding` gained five **optional** structured-metadata fields (`cwe`, `severity`, `confidence`, `taint`, `signatureId`) while still `extends ReviewFinding` and never redefining a locked field; (3) `inferVulnClass` extended to map rule/check ids for the new classes with a dedicated `xss` branch; and (4) the hub-Finding id collision **G10** fixed by folding a per-finding discriminator into the stable title. No signature type, parser, skill files, selector, or scanners yet — those are later sprints.

## Public surface

- `VulnClass` (`src/orchestrator/security-audit-types.ts:9`) — the vulnerability-taxonomy union, now 17 members (the original 6 preserved verbatim plus 11 new classes).
- `FindingSeverity` (`src/orchestrator/security-audit-types.ts:31`) — `'critical' | 'high' | 'medium' | 'low' | 'info'`. A finding's own severity is advisory metadata; it never overrides the `critical[]`-blocks bucket rule.
- `FindingConfidence` (`src/orchestrator/security-audit-types.ts:34`) — `'confirmed' | 'firm' | 'tentative'`.
- `TaintPath` (`src/orchestrator/security-audit-types.ts:37`) — `{ source: string; sink: string; sanitizerPresent: boolean }`, a traced source-to-sink path backing a finding.
- `SecurityFinding` (`src/orchestrator/security-audit-types.ts:50`) — still `extends ReviewFinding`; now carries `vulnClass?`, `cwe?`, `severity?: FindingSeverity`, `confidence?: FindingConfidence`, `taint?: TaintPath`, `signatureId?` — **all optional**.
- `ALL_VULN_CLASSES` (`src/orchestrator/stack-knowledge.ts:40`) — the runtime array of every `VulnClass`; a lockstep test in `security-audit-types.test.ts` asserts it deep-equals the union membership so the two never drift.
- `inferVulnClass(checkId)` (`src/orchestrator/security-scanners.ts:90`) — maps scanner rule/check ids to a `VulnClass` via an additive keyword-regex ladder; still returns `undefined` (never a forced wrong class) when nothing matches.
- `mapAuditToFindings` / `mapBucket` (`src/orchestrator/security-hub.ts:139`, `:85`) — the hub-Finding title now embeds a discriminator (`security-hub.ts:96`, `:100`); new metadata rides existing tags (`cwe:`, `severity:`, `confidence:`, `sig:`).

## How to use / how it fits

This is pure typed plumbing that the rest of the spec builds on — nothing new runs on its own. Two consumer-visible effects:

- **Richer findings.** An auditor or scanner may now attach CWE ids, a severity/confidence rating, a taint path, and a stable `signatureId` to a `SecurityFinding`. Because every field is optional, existing code that constructs a `SecurityFinding` with only `vulnClass` is unaffected.
- **Collision-free hub emission (G10 fix).** The hub Finding `id` is derived from `domain|title|kind`. Previously the title was `[security] <vulnClass> at <path>:<line>`, so two **different** vulnerabilities of the same `vulnClass` at the same `path:line` hashed to the **same** id and silently overwrote each other. The title now inserts a discriminator — `[security] <vulnClass> #<discriminator> at <path>:<line>` — where the discriminator prefers `signatureId`, then `cwe`, then falls back to a short stable `sha256` of the finding's own `description`. Content-derived, so an identical retry (same description) still dedups to one row, while two distinct findings diverge into two rows.

## Notes for maintainers

- **`ReviewResult`/`ReviewFinding` stay locked and type-only.** `security-audit-types.ts` imports them with `import type` and never redefines them; `SecurityFinding` only ever **adds** optional fields on top. Do not add a value import or widen a locked field.
- **Taxonomy lockstep is enforced by test, not convention.** Any future edit to `VulnClass` must update `ALL_VULN_CLASSES` in the same change or the deep-equal lockstep assertion in `security-audit-types.test.ts` fails.
- **A finding's `severity` field never drives the gate.** `deriveVerdict` and the critical-bucket veto are unchanged this sprint; severity/confidence are descriptive metadata surfaced as hub tags, not a second blocking axis.
- **`hub/finding.ts` (the hub `Finding` Zod schema) is untouched.** The new metadata is carried on the existing `tags[]` (`cwe:`/`severity:`/`confidence:`/`sig:`) rather than as new schema fields.
- **Iteration 2 fixed the `xss` mapping.** Iteration 1 folded `xss` into the `injection` branch; commit `f64b9f5` split `xss` (matching `\bxss\b|cross-site-scripting`) into its own branch so `inferVulnClass` returns `xss` for cross-site-scripting rule ids (sc-1-3).

## Scope

Two commits — `d66351a` (widen taxonomy + structured metadata + G10 title discriminator) and `f64b9f5` (split the `xss` branch in `inferVulnClass`) — touching exactly the estimated files: `security-audit-types.ts`, `stack-knowledge.ts`, `security-scanners.ts`, `security-hub.ts` and their collocated tests. No source outside `src/orchestrator/` changed; `hub/finding.ts`, `code-reviewer-agent.ts`, and `bober.config.json` untouched. All 5 required criteria (sc-1-1..1-5) passed on iteration 2; full suite **4070 green**.
