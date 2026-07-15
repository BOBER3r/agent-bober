# Sprint Briefing: Widen the vulnerability taxonomy + add structured finding metadata + fix hub collision

**Contract:** sprint-spec-20260714-security-auditor-per-stack-skills-1
**Generated:** 2026-07-14T00:00:00Z

This sprint is a PURE-ADDITIVE typed foundation. Every change must leave existing behavior byte-identical when the new fields/classes are absent. There is exactly ONE unavoidable behavior change: the hub Finding title format (sc-1-4), which breaks two exact-title assertions you MUST update — see Pitfalls §9.

---

## 1. Target Files

### src/orchestrator/security-audit-types.ts (modify)

The union (widen it) and SecurityFinding (add 5 optional fields). Import stays type-only.

**Current (lines 1, 9-25):**
```typescript
import type { ReviewResult, ReviewFinding } from "./code-reviewer-agent.js";  // line 1 — KEEP type-only

// ── Vulnerability taxonomy ────────────────────────────────────────────
export type VulnClass =                       // lines 9-15 — the LOCKED existing 6, preserve verbatim
  | "injection"
  | "authn-authz"
  | "secret-handling"
  | "input-validation"
  | "path-traversal"
  | "privilege-escalation";

// ── Wrapper types over the LOCKED ReviewResult/ReviewFinding ──────────
export interface SecurityFinding extends ReviewFinding {   // lines 23-25 — KEEP `extends ReviewFinding`
  vulnClass?: VulnClass;
}
```

**What to do:**
- Append the new union members after `"privilege-escalation"` (sc-1-1 minimum set): `"race-condition"`, `"money-integrity"`, `"ssrf"`, `"xss"`, `"insecure-randomness"`, `"crypto-weakness"`, `"deserialization"`, `"supply-chain"`, `"idor-bola"`, `"denial-of-service"`, `"audit-logging"`.
- Add three type aliases (new `// ── ` section) BEFORE `SecurityFinding`:
  - `FindingSeverity = "critical" | "high" | "medium" | "low" | "info"`
  - `FindingConfidence = "confirmed" | "firm" | "tentative"`
  - `TaintPath` interface `{ source: string; sink: string; sanitizerPresent: boolean }` (contract sc-1-2 field name is `taint?: {source,sink,sanitizerPresent}`).
- Add the 5 optional fields to `SecurityFinding` (ALL optional, so no existing constructor breaks): `cwe?: string`, `severity?: FindingSeverity`, `confidence?: FindingConfidence`, `taint?: TaintPath`, `signatureId?: string`.

**Imports this file uses:** `ReviewResult, ReviewFinding` (type-only) from `./code-reviewer-agent.js`.
**Imported by:** `stack-knowledge.ts:6`, `security-scanners.ts:4`, `security-hub.ts:23`, `security-auditor-agent.ts:5`, `security-gate.ts`, `security-audit.ts (cli)`, `pipeline.ts`, plus the 4 `.test.ts` files.
**Test file:** `src/orchestrator/security-audit-types.test.ts` (exists).

---

### src/orchestrator/stack-knowledge.ts (modify)

Only the `ALL_VULN_CLASSES` array changes. It must stay in lockstep with the union.

**Current (lines 38-45):**
```typescript
export const ALL_VULN_CLASSES: VulnClass[] = [
  "injection",
  "authn-authz",
  "secret-handling",
  "input-validation",
  "path-traversal",
  "privilege-escalation",
];
```

**What to do:** append the SAME 11 new members in the SAME order you added to the union. The stale comment at line 34 (`security-audit-types.ts:9-15`) can be left or refreshed — cosmetic only. Do NOT touch `detectStack`, `extractSecurityExcerpt`, or `resolveStackSecurityContext`.

**Test file:** `src/orchestrator/stack-knowledge.test.ts` (exists) — its `ctx.taxonomy).toEqual(ALL_VULN_CLASSES)` assertions (lines 64, 111, 127) stay GREEN because `taxonomy` is a copy of `ALL_VULN_CLASSES` regardless of length.

---

### src/orchestrator/security-scanners.ts (modify)

Extend the `inferVulnClass` regex ladder additively. Keep the `isVulnClass` guard and the "undefined rather than a wrong guess" contract.

**Current (lines 74-107):**
```typescript
function isVulnClass(value: string): value is VulnClass {          // lines 74-76 — DO NOT CHANGE
  return (ALL_VULN_CLASSES as string[]).includes(value);
}

function inferVulnClass(checkId: string): VulnClass | undefined {  // lines 90-107
  const id = checkId.toLowerCase();

  const candidate: string | undefined =
    /sql-?injection|sqli|command-injection|code-injection|\bxss\b|\binjection\b/.test(id)
      ? "injection"
      : /path-traversal|directory-traversal/.test(id)
        ? "path-traversal"
        : /hardcoded|secret|credential|api-key/.test(id)
          ? "secret-handling"
          : /tx-origin|access-control|\bauth\b|authn|authz|authentication|authorization|privilege/.test(id)
            ? "authn-authz"
            : /unvalidated|input-validation|missing-validation|sanitiz/.test(id)
              ? "input-validation"
              : undefined;

  return candidate !== undefined && isVulnClass(candidate) ? candidate : undefined;
}
```

**What to do:** insert additional ternary rungs (BEFORE the final `: undefined`) for the new classes per sc-1-3. Suggested mappings (keep them specific so nothing forces a wrong class):
- `/\brace\b|toctou|time-of-check/` → `"race-condition"`
- `/\bssrf\b|server-side-request/` → `"ssrf"`  (NOTE: `\bxss\b` already maps to `"injection"` in rung 1 — leave XSS there OR add an explicit `xss` rung, but do not let an `ssrf` regex accidentally catch `xss`)
- `/weak-random|insecure-random|predictable-random/` → `"insecure-randomness"`
- `/\bmd5\b|\bsha1\b|weak-crypto|weak-hash|weak-cipher/` → `"crypto-weakness"`
- `/deserial|unmarshal|pickle/` → `"deserialization"`
- `/\bidor\b|\bbola\b|broken-object-level/` → `"idor-bola"`
- `/\bdos\b|denial-of-service|resource-exhaustion/` → `"denial-of-service"`
- (money-integrity / supply-chain / audit-logging have no obvious scanner-id keyword — leaving them unmapped is CORRECT; a forced wrong class is worse than `undefined`.)

Keep the final `return candidate !== undefined && isVulnClass(candidate) ? candidate : undefined;` line — the `isVulnClass` guard is the safety net that keeps the return type sound.

**Contract caution (sc-1-3):** "reentrancy -> (not forced)". Do NOT add a reentrancy rung — slither's `reentrancy-eth` must keep returning `undefined` (asserted at `security-scanners.test.ts:51`).

**Test file:** `src/orchestrator/security-scanners.test.ts` (exists) — existing `vulnClass` assertions (lines 51, 61, 94, 100) MUST stay green; only ADD table rows for the new mappings.

---

### src/orchestrator/security-hub.ts (modify — the G10 collision fix)

**Current `deriveFindingId` (lines 39-41) — id is `sha256(domain|title|kind)`:**
```typescript
function deriveFindingId(domain: string, title: string, kind: string): string {
  return createHash("sha256").update(`${domain}|${title}|${kind}`).digest("hex").slice(0, 16);
}
```
`createHash` is ALREADY imported at line 21 — reuse it; do NOT add an import.

**Current `mapBucket` (lines 82-109) — the title (line 86) is the collision surface:**
```typescript
return findings.map((finding) => {
  const primaryEvidence = finding.evidence[0];
  const path = primaryEvidence?.path ?? "unknown";
  const line = primaryEvidence?.line ?? 0;
  const title = `[security] ${finding.vulnClass ?? "vulnerability"} at ${path}:${line}`;  // line 86 — CHANGE THIS

  const evidence: string[] = [
    finding.description,
    ...finding.evidence.map((e) => `${e.path}:${e.line} — ${e.snippet}`),
  ];

  return {
    id: deriveFindingId("security", title, "risk"),      // id is derived from title → title drives dedup
    domain: "security",
    title,
    kind: "risk",
    urgency,
    severity,
    evidence,
    surfacedAt: now,
    tags: [                                               // lines 102-106 — add cwe:/severity:/confidence:/sig: here
      "security",
      ...(finding.vulnClass ? [`vuln:${finding.vulnClass}`] : []),
      `stack:${stack}`,
    ],
    status: "open",
  };
});
```

**What to do (generatorNotes[4]):**
1. Compute a discriminator that (a) DIFFERS between two different vulns at the same `vulnClass`+`path`:`line`, and (b) is IDENTICAL across retries of the same finding. Use `finding.signatureId ?? finding.cwe ?? <stable-line-hash>`, where `<stable-line-hash>` is a short deterministic hash of the finding's own stable content — the DESCRIPTION is the field that distinguishes two different vulns at the same location:
   ```typescript
   const discriminator =
     finding.signatureId ??
     finding.cwe ??
     createHash("sha256").update(finding.description).digest("hex").slice(0, 8);
   const title = `[security] ${finding.vulnClass ?? "vulnerability"} #${discriminator} at ${path}:${line}`;
   ```
   Rationale: two DIFFERENT vulns → different `description` → different hash → different title → different id (collision fixed). SAME finding retried → same `description` → same hash → same id (dedup preserved, sc-6-3 stays green). Insert `#${discriminator}` BEFORE ` at ${path}:${line}` exactly as generatorNotes[4] specifies.
2. Extend the `tags` array to append, WHEN PRESENT ONLY (so no-metadata findings keep their exact 3-tag shape): `...(finding.cwe ? [\`cwe:${finding.cwe}\`] : [])`, `...(finding.severity ? [\`severity:${finding.severity}\`] : [])`, `...(finding.confidence ? [\`confidence:${finding.confidence}\`] : [])`, `...(finding.signatureId ? [\`sig:${finding.signatureId}\`] : [])`. Pick a stable order and keep it.

Do NOT touch `mapAuditToFindings` (121-133), `emitSecurityFindings` (146-159), or the severity constants (56-59).

**Test file:** `src/orchestrator/security-hub.test.ts` (exists) — see Pitfalls §9; TWO exact-title assertions must be updated and ONE collision test must be ADDED.

---

## 2. Patterns to Follow

### Optional field spread (never emit an absent key)
**Source:** `src/orchestrator/security-scanners.ts`, lines 180 & 229
```typescript
...(inferVulnClass(check) !== undefined ? { vulnClass: inferVulnClass(check) } : {}),
```
**Rule:** conditionally-present object keys use the `...(cond ? { k: v } : {})` spread so an absent value produces NO key (keeps deep-equal parity). Mirror this for the new tags in `mapBucket`.

### Type-only import discipline (ESLint consistent-type-imports)
**Source:** `src/orchestrator/security-audit-types.ts:1`, `security-hub.ts:22-24`
```typescript
import type { ReviewResult, ReviewFinding } from "./code-reviewer-agent.js";
import type { Finding } from "../hub/finding.js";
import type { SecurityAuditResult, SecurityFinding } from "./security-audit-types.js";
```
**Rule:** every types-only import MUST be `import type`, and every relative import MUST carry a `.js` extension (principles.md:27,35). `FindingSeverity`/`FindingConfidence`/`TaintPath` you add are types — any file importing them must use `import type`.

### Unicode box-drawing section headers
**Source:** `src/orchestrator/security-audit-types.ts:3,17` (and every file in this module)
```typescript
// ── Vulnerability taxonomy ────────────────────────────────────────────
```
**Rule:** organize new blocks with `// ── Name ─────` headers using the U+2500 box char `─` (principles.md:32). Add one for the new severity/confidence/taint aliases.

### Value guard bridging string → union
**Source:** `src/orchestrator/security-scanners.ts:74-76` (identical copy at `security-auditor-agent.ts:347-349`)
```typescript
function isVulnClass(value: string): value is VulnClass {
  return (ALL_VULN_CLASSES as string[]).includes(value);
}
```
**Rule:** narrowing an untrusted string to `VulnClass` goes through `isVulnClass` (backed by `ALL_VULN_CLASSES`). Because both `isVulnClass` copies and `inferVulnClass`'s final guard read `ALL_VULN_CLASSES`, simply widening that array + the union automatically lets the new classes flow through — no guard edits needed.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `deriveFindingId` | `src/orchestrator/security-hub.ts:39` | `(domain, title, kind): string` | sha256(domain\|title\|kind) → 16-hex id. Reuse; do NOT add a second hasher. |
| `createHash` | imported at `security-hub.ts:21` from `node:crypto` | `(alg): Hash` | Already in scope — use for the `<stable-line-hash>` discriminator. |
| `isVulnClass` | `security-scanners.ts:74`, `security-auditor-agent.ts:347` | `(value: string): value is VulnClass` | String→union guard, ALL_VULN_CLASSES-backed. Auto-covers new classes. |
| `inferVulnClass` | `security-scanners.ts:90` | `(checkId: string): VulnClass \| undefined` | Keyword ladder — EXTEND, don't replace. |
| `ALL_VULN_CLASSES` | `stack-knowledge.ts:38` | `VulnClass[]` | Runtime mirror of the union. The single lockstep source. |
| `deriveVerdict` | `security-audit-types.ts:52` | `(review: ReviewResult): "pass"\|"blocked"` | Verdict from `critical.length`. nonGoals[1] — DO NOT touch. |
| `mapAuditToFindings` | `security-hub.ts:121` | `(result, now): Finding[]` | Bucket→Finding mapper. Don't touch; only `mapBucket` (its helper) changes. |
| `parseSecurityFindingArray` | `security-auditor-agent.ts:351` | `(raw: unknown): SecurityFinding[]` | LLM-JSON → SecurityFinding[]; already spreads `vulnClass` via `isVulnClass`. Do NOT touch for this sprint. |
| `FindingSchema` | `src/hub/finding.ts:10` | Zod object | LOCKED hub schema — nonGoals[4], DO NOT edit. |

Directories reviewed for reusable helpers: `src/orchestrator/` (security-*), `src/hub/`, `src/utils/`, `src/state/`. No hashing/normalization helper beyond `deriveFindingId`/`createHash` applies — reuse those, do not add new ones.

---

## 4. Prior Sprint Output

No prior sprints in this spec (`dependsOn: []`). This sprint builds on the ALREADY-SHIPPED spec-20260712-security-audit-agent-team module. The types you extend were authored there:
- `VulnClass`/`SecurityFinding`/`deriveVerdict` — `security-audit-types.ts`
- `ALL_VULN_CLASSES` — `stack-knowledge.ts`
- `inferVulnClass`/parsers — `security-scanners.ts`
- `mapAuditToFindings`/`emitSecurityFindings` — `security-hub.ts`
- LOCKED `ReviewFinding`/`ReviewResult` — `code-reviewer-agent.ts:17-37`
- LOCKED `FindingSchema` — `hub/finding.ts:10-25`

**Connection:** you WIDEN the taxonomy and ADD optional metadata without redefining any locked shape, and fix the G10 hub-id collision. Later sprints (signature type, parser, skill files, selector, verifier) are explicitly OUT OF SCOPE (nonGoals[0], outOfScope).

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`, 48 lines — all four apply)
- **Section comments** (line 32): `// ── Name ──────` unicode box headers.
- **Type imports** (line 35): `consistent-type-imports` enforced — `import type { ... }`.
- **ESM + .js** (line 27): all relative imports end in `.js`.
- **No sync fs** (line 42): `node:fs/promises` only — irrelevant to this sprint (no fs added) but do not introduce any.
- **Lint** (line 19): zero ESLint errors is a hard gate (`no-explicit-any` warns, unused vars error unless `_`-prefixed).

### Architecture Decisions
Referenced (not required reading for this sprint): `.bober/architecture/arch-20260712-security-audit-agent-team-architecture.md` (the shipped module's ADRs). No NEW architecture doc governs this sprint.

### Other Docs
Repo config `bober.config.json` has `"security": { "enabled": true, "scanners": [] }` (lines 75-78) — this is the LIVE config that sc-1-5's deep-equal paired-parse must prove byte-identical before/after.

---

## 6. Testing Patterns

### Unit Test Pattern
**Source:** `src/orchestrator/security-audit-types.test.ts` (whole file) and `security-hub.test.ts`
```typescript
import { describe, it, expect } from "vitest";
import type { ReviewResult } from "./code-reviewer-agent.js";
import { deriveVerdict, type SecurityFinding, type SecurityAuditResult } from "./security-audit-types.js";

const baseReview: ReviewResult = {
  reviewId: "r", contractId: "c", specId: "s", timestamp: "2026-01-01T00:00:00.000Z",
  summary: "", critical: [], important: [], minor: [], approvedAreas: [],
};

describe("SecurityFinding", () => {
  it("allows a valid vulnClass value", () => {
    const finding: SecurityFinding = {
      description: "SQL injection via string concat",
      evidence: [{ path: "src/db.ts", line: 10, snippet: "query(`SELECT ${x}`)" }],
      vulnClass: "injection",
    };
    expect(finding.vulnClass).toBe("injection");
  });
});
```
**Runner:** vitest. **Assertion style:** `expect(...).toBe/.toEqual/.not.toThrow`. **Mock approach:** `vi.fn`/`vi.spyOn` (see `security-scanners.test.ts:120`, `security-hub.test.ts:175`) — none needed for the pure-type/pure-function work here. **File naming:** `<name>.test.ts` **co-located** next to source.

### Table-test pattern (for sc-1-3 inferVulnClass and sc-1-1 lockstep)
**Source:** `src/orchestrator/security-audit-types.test.ts:22-37` (`it.each`)
```typescript
it.each<[ReviewResult["critical"], ReviewResult["important"], "pass" | "blocked"]>([
  [[], [], "pass"],
  [[{ description: "SQL injection", evidence: [] }], [], "blocked"],
])("critical=%j important=%j -> %s", (critical, important, expected) => {
  const review: ReviewResult = { ...baseReview, critical, important };
  expect(deriveVerdict(review)).toBe(expected);
});
```
`inferVulnClass` is module-private (not exported). To table-test it (sc-1-3) WITHOUT exporting it, drive it through the exported `parseSemgrepOutput`/`parseSlitherOutput` — pass a fixture-shaped object whose `check_id`/`check` contains the keyword and assert the resulting `finding.vulnClass`. Existing rows to mirror: `semgrep-sample.json` → `injection`/`secret-handling` (`security-scanners.test.ts:94,100`); slither `tx-origin` → `authn-authz` (`:61`), `reentrancy-eth` → `undefined` (`:51`). Example new row:
```typescript
const f = parseSemgrepOutput({ results: [{ check_id: "generic.ssrf.rule", path: "a.ts", start: { line: 1 }, extra: {} }] });
expect(f[0].vulnClass).toBe("ssrf");
```

### sc-1-1 lockstep test (union ⇄ ALL_VULN_CLASSES, no drift)
Use a `Record<VulnClass, true>` so TypeScript FORCES every union member to be listed (compile-time exhaustiveness), then assert runtime set-equality against `ALL_VULN_CLASSES`:
```typescript
import { ALL_VULN_CLASSES } from "./stack-knowledge.js";
import type { VulnClass } from "./security-audit-types.js";

const PRESENCE: Record<VulnClass, true> = {
  injection: true, "authn-authz": true, /* …every member… */ "audit-logging": true,
}; // omitting any union member = TS error here (drift caught at compile time)

it("ALL_VULN_CLASSES stays in lockstep with the VulnClass union", () => {
  expect([...ALL_VULN_CLASSES].sort()).toEqual(Object.keys(PRESENCE).sort());
  expect(new Set(ALL_VULN_CLASSES).size).toBe(ALL_VULN_CLASSES.length); // no dupes
});
```
Put this in `security-audit-types.test.ts` (imports `ALL_VULN_CLASSES` from stack-knowledge) or `stack-knowledge.test.ts` — either is fine; the contract only requires the assertion to exist.

### Config byte-identity (sc-1-5 paired-parse)
**Source pattern:** `src/config/schema.test.ts` parses with `BoberConfigSchema.safeParse(...)` and `.parse(...)` then `expect(...).toEqual(...)`. For this sprint, prove the real repo config is untouched by your type changes:
```typescript
import { readFile } from "node:fs/promises";
import { BoberConfigSchema } from "../config/schema.js";
const raw = JSON.parse(await readFile(new URL("../../bober.config.json", import.meta.url), "utf-8"));
expect(BoberConfigSchema.parse(raw)).toEqual(BoberConfigSchema.parse(raw));
```
(Your changes touch NO config schema, so this is really a guard that nothing leaked into config parsing. `security` block is `{ enabled: true, scanners: [] }` at config lines 75-78.)

### E2E Test Pattern
Not applicable — no Playwright/`e2e/` for this backend-CLI sprint. All verification is vitest unit + build + typecheck + lint.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/orchestrator/security-hub.test.ts` | `mapBucket` title format | **HIGH** | Two exact-title `toBe(...)` assertions (lines 117, 140) WILL fail — must update to the new `#<disc>` format. See §9. |
| `src/orchestrator/security-auditor-agent.ts:347-364` | `VulnClass`, `isVulnClass`, `ALL_VULN_CLASSES` | LOW | `isVulnClass` auto-accepts new classes (reads ALL_VULN_CLASSES) — no code change; just verify it still compiles. |
| `src/orchestrator/security-scanners.ts:74` | `ALL_VULN_CLASSES` | LOW | its own `isVulnClass` + `inferVulnClass` final guard auto-widen. |
| `src/orchestrator/stack-knowledge.test.ts:64,111,127` | `ALL_VULN_CLASSES` | LOW | `taxonomy).toEqual(ALL_VULN_CLASSES)` — stays green (taxonomy is a copy). |
| `security-gate.ts`, `cli/commands/security-audit.ts`, `pipeline.ts` | `SecurityFinding`, `mapAuditToFindings`, `emitSecurityFindings` | LOW | Consume the widened types via structural typing; optional fields don't break them. Verify build. |
| `security-audit-types.test.ts` | `SecurityFinding`, `VulnClass`, `deriveVerdict` | LOW | Existing shape tests still valid; ADD new-field + lockstep tests. |

### Existing Tests That Must Still Pass
- `security-audit-types.test.ts` (6 tests) — `deriveVerdict` + SecurityFinding shape; adding optional fields keeps all green.
- `security-scanners.test.ts` (12 tests) — vulnClass assertions at lines 51/61/94/100 must stay exactly as-is; only ADD rows.
- `security-hub.test.ts` (12 tests) — dedup/idempotency tests (127-134, 214-259) stay green (id still content-stable); the two exact-title tests (117, 140) MUST be edited; tags test (124) stays green (criticalFinding carries no new metadata → no new tags).
- `stack-knowledge.test.ts` — taxonomy-equality tests stay green.
- `security-auditor-agent.test.ts` (45 tests) + `security-gate.test.ts` (23) + `cli/commands/security-audit.test.ts` (39) — must all remain green (they exercise the consumers).

### Features That Could Be Affected
- **Priority-hub emission** (`security-gate.ts:172`, `security-audit.ts:206`) — shares `mapAuditToFindings`→`mapBucket`. Verify a critical/important finding still emits and dedups; the new `#<disc>` title changes ids but the dedup CONTRACT (same finding → one row) must hold (sc-6-3 tests prove it).
- **Live security dogfood** — `bober.config.json` has `security.enabled: true`, so this module runs on every future sprint; a broken build blocks the whole pipeline. Byte-identity of the config parse is sc-1-5.

### Recommended Regression Checks (run after implementation)
1. `npx vitest run src/orchestrator/security-audit-types.test.ts src/orchestrator/stack-knowledge.test.ts src/orchestrator/security-scanners.test.ts src/orchestrator/security-hub.test.ts src/orchestrator/security-auditor-agent.test.ts src/orchestrator/security-gate.test.ts src/cli/commands/security-audit.test.ts` — the full security suite green.
2. `npx vitest run` — FULL suite, zero regressions (sc-1-5).
3. `npm run build` and typecheck — must pass (sc-1-5).
4. `npx eslint src/orchestrator/security-audit-types.ts src/orchestrator/stack-knowledge.ts src/orchestrator/security-scanners.ts src/orchestrator/security-hub.ts` (+ the touched test files) — zero errors.
5. Grep guard (evaluatorNotes sc-1-2): `grep -n "import type.*Review\(Finding\|Result\)" src/orchestrator/security-audit-types.ts` must show the type-only import, and `SecurityFinding` must still read `extends ReviewFinding`.

---

## 8. Implementation Sequence

1. **security-audit-types.ts** — widen the `VulnClass` union (+11 members); add `FindingSeverity`/`FindingConfidence`/`TaintPath` aliases in a new `// ── ` section; add the 5 optional fields to `SecurityFinding`; keep `extends ReviewFinding` and the type-only import.
   - Verify: `npx tsc --noEmit` compiles; `SecurityFinding` still extends ReviewFinding.
2. **stack-knowledge.ts** — append the SAME 11 members to `ALL_VULN_CLASSES` in the same order.
   - Verify: array length == union member count; `stack-knowledge.test.ts` still green.
3. **security-audit-types.test.ts** — add: (a) the `Record<VulnClass, true>` lockstep test (sc-1-1), (b) a test constructing a SecurityFinding with each new optional field and asserting it round-trips, (c) confirm all 5 fields are omittable.
   - Verify: new tests pass; existing 6 unchanged.
4. **security-scanners.ts** — extend `inferVulnClass`'s ternary ladder with the new rungs (NO reentrancy rung); keep the final `isVulnClass` guard line.
   - Verify: `security-scanners.test.ts` existing rows green.
5. **security-scanners.test.ts** — add table rows driving `parseSemgrepOutput`/`parseSlitherOutput` for the new keyword→class mappings, plus an "unknown id → undefined" row.
   - Verify: new rows pass; lines 51/61/94/100 untouched and green.
6. **security-hub.ts** — in `mapBucket`: compute `discriminator = signatureId ?? cwe ?? sha256(description).slice(0,8)`; insert `#${discriminator}` into the title BEFORE ` at ${path}:${line}`; append `cwe:`/`severity:`/`confidence:`/`sig:` tags only when present. Reuse the line-21 `createHash` import.
   - Verify: id still stable across retries; distinct descriptions → distinct ids.
7. **security-hub.test.ts** — UPDATE the two exact-title assertions (117, 140) to the new format; ADD the sc-1-4 collision test (two findings, same vulnClass+path+line, different `signatureId` → two distinct ids; same finding twice → one id); optionally assert the new tags appear when metadata present.
   - Verify: whole file green.
8. **Full verification** — `npm run build`, typecheck, `npx vitest run` (full suite), `npx eslint` on all changed files, and the sc-1-5 config paired-parse deep-equal.

---

## 9. Pitfalls & Warnings

- **THE title change breaks two existing assertions — this is expected, update them (do NOT treat as a reason to skip the discriminator).** `security-hub.test.ts:117` asserts `toBe("[security] injection at src/db.ts:88")` and `:140` asserts `toBe("[security] vulnerability at unknown:0")`. After the fix these become e.g. `"[security] injection #<8hex> at src/db.ts:88"`. Because the discriminator for the no-metadata fixtures is a `sha256(description).slice(0,8)`, compute the expected value in the test (`createHash("sha256").update(criticalFinding.description).digest("hex").slice(0,8)`) rather than hard-coding a magic string, OR assert with `toContain("[security] injection")` + `toMatch(/#\w+ at src\/db\.ts:88$/)`. sc-1-5's "existing tests pass unchanged" means the SUITE stays green, not that these two lines are byte-frozen (they are in `estimatedFiles`).
- **The tags assertion at `security-hub.test.ts:124` (`toEqual(["security","vuln:injection","stack:node"])`) must stay green.** Only add cwe:/severity:/confidence:/sig: tags WHEN the field is present. The `criticalFinding` fixture (lines 66-70) has none, so its tag array must remain exactly those 3 — use the `...(cond ? [tag] : [])` spread.
- **Do NOT add a reentrancy → any-class rung to `inferVulnClass`.** `security-scanners.test.ts:51` asserts `reentrancy-eth` stays `undefined`; sc-1-3 says reentrancy is "(not forced)". Forcing a wrong class is worse than `undefined`.
- **`xss` already maps to `injection` in rung 1** (`/\bxss\b/` at line 94). sc-1-1 adds `"xss"` as its own union member, but sc-1-3 does NOT require remapping the existing `xss→injection` scanner heuristic. Leave rung 1 as-is unless you add an EARLIER explicit `xss` rung — and if you do, make sure no existing test expected `xss`→`injection` (none do today, but re-run scanners tests). Keep the change minimal.
- **Keep the union and `ALL_VULN_CLASSES` in the SAME ORDER.** The lockstep test uses set-equality so order won't fail it, but matching order keeps diffs reviewable and prevents accidental omission.
- **All 5 new SecurityFinding fields MUST be optional (`?:`).** A required field would break every existing `SecurityFinding` literal (parsers at `security-scanners.ts:176,225,249`; `parseSecurityFindingArray`; every test fixture) and blow up the build.
- **Do NOT edit `hub/finding.ts` (nonGoals[4]), `deriveVerdict` (nonGoals[1]), or `ReviewFinding`/`ReviewResult` (nonGoals[2]).** New metadata rides EXISTING hub fields (title + tags + evidence), never new schema fields — `FindingSchema` at `hub/finding.ts:10-25` is locked and validated in `security-hub.test.ts:98`.
- **Import discipline:** `FindingSeverity`/`FindingConfidence`/`TaintPath` are types — any cross-file use needs `import type` (ESLint `consistent-type-imports` is a hard gate). Within `security-audit-types.ts` they are same-file, so no import needed.
- **`inferVulnClass` is module-private** — don't export it just to test it (YAGNI); drive it through the exported parsers as the existing tests already do.
