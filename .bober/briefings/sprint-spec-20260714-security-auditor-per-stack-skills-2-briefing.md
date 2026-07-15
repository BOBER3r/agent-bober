# Sprint Briefing: Signature type + skill-file authoring format + total parser + generic security skill

**Contract:** sprint-spec-20260714-security-auditor-per-stack-skills-2
**Generated:** 2026-07-14T13:58:00Z

> Deliverables: `src/orchestrator/security-knowledge/signature.ts` (types),
> `src/orchestrator/security-knowledge/parser.ts` (pure/total parser),
> `src/orchestrator/security-knowledge/parser.test.ts` (tests vs the REAL file),
> `skills/bober.security-generic/SKILL.md` (>=12 discrete signature blocks).
> NO runtime audit behavior changes this sprint (nonGoals).

---

## 1. Target Files

### src/orchestrator/security-knowledge/signature.ts (create)

**Directory pattern:** New module dir. Sibling modules live directly in `src/orchestrator/`
(e.g. `security-audit-types.ts`, `security-scanners.ts`, `stack-knowledge.ts`). This is the
FIRST file under `security-knowledge/`. Use kebab-case filenames and `.js` extension on all
relative imports (ESM/NodeNext — see every import in the codebase, e.g.
`security-scanners.ts:4` `from "./security-audit-types.js"`).

**Most similar existing file:** `src/orchestrator/security-audit-types.ts` — same idea (a
small types-only module with `export type`/`export interface` and a doc comment per type).

**Exact types to define (sc-2-1 is verbatim about the shape):**
```ts
import type { VulnClass, FindingSeverity } from "../security-audit-types.js";

/** The eight security-stack identifiers a signature can belong to. */
export type SecurityStackId =
  | "solidity"
  | "anchor"
  | "react"
  | "node"
  | "payments"
  | "igaming"
  | "dex-backend"
  | "generic";

/** One parsed vulnerable/safe signature from a security skill file. */
export interface SecuritySignature {
  stackId: SecurityStackId;
  signatureId: string;
  title: string;
  cwe: string | null;          // e.g. "CWE-89"; null when the block omits it
  severity: FindingSeverity;   // "critical"|"high"|"medium"|"low"|"info"
  vulnClass: VulnClass;        // MUST be a member of the widened union
  invariant: string;
  unsafeExample: string;
  safeExample: string;
  keywords: string[];
  skillRef: string;            // the skillRelPath passed to parse()
}
```

**Note:** Import `VulnClass`/`FindingSeverity` **type-only** (`import type`) — they are the
sprint-1 widened types. Do NOT redefine them.

---

### src/orchestrator/security-knowledge/parser.ts (create)

**Most similar existing file (THE precedent to mirror):** `src/orchestrator/security-scanners.ts`
`parseSlitherOutput` (lines 144-201) and `parseSemgrepOutput` (lines 214-250). The contract
explicitly says "mirrors parseSlitherOutput defensive narrowing at security-scanners.ts:128".

**What to build:** `SecuritySignatureParser.parse(stackId, skillMarkdown, skillRelPath): SecuritySignature[]`.
Contract wording (generatorNotes) allows either a class with a static `parse` or an object —
recommend exporting an object literal `export const SecuritySignatureParser = { parse(...) {...} }`
plus optionally a bare `export function parseSecuritySignatures(...)`. Keep it PURE: `parse`
takes markdown TEXT, never touches `fs` (fs lives in the future index — sprint 5, nonGoal here).

**Structure template (skeleton — dependency order inside the file):**
```ts
import type { VulnClass, FindingSeverity } from "../security-audit-types.js";
import { ALL_VULN_CLASSES } from "../stack-knowledge.js";
import type { SecuritySignature, SecurityStackId } from "./signature.js";

// narrowing helpers (mirror security-scanners.ts:74-76 isVulnClass)
function isVulnClass(v: string): v is VulnClass { return (ALL_VULN_CLASSES as string[]).includes(v); }
const SEVERITIES = ["critical","high","medium","low","info"] as const;
function isSeverity(v: string): v is FindingSeverity { return (SEVERITIES as readonly string[]).includes(v); }

// 1. split markdown into blocks by a stable delimiter (recommend "### " headings)
// 2. for each block: extract labelled fields + fenced code -> build partial record
// 3. drop the block if a REQUIRED field (signatureId/title/vulnClass) is missing or invalid
// 4. never throw; return the parseable subset
export const SecuritySignatureParser = {
  parse(stackId: SecurityStackId, skillMarkdown: string, skillRelPath: string): SecuritySignature[] { /* ... */ },
};
```

**Recommended block format (you author BOTH sides, so pick something trivially parseable):**
- Split on lines matching `/^### /m`. The heading text after `### ` = `signatureId`.
- Inside each block, labelled lines like `- **Title:** ...`, `- **CWE:** CWE-89`,
  `- **Severity:** high`, `- **VulnClass:** injection`, `- **Invariant:** ...`,
  `- **Keywords:** raw, query, concat`.
- Two fenced code blocks tagged for unsafe/safe. Recommend explicit markers the parser keys
  off (e.g. a line `**Unsafe:**` then a ```` ```ts ```` fence, then `**Safe:**` then a fence),
  OR label the fence info-string. Whatever you choose, the generic SKILL.md and the parser
  must agree — they are the executable spec of the format together.

**Defensive-narrowing rules to copy from parseSlitherOutput (security-scanners.ts:144-201):**
- Guard input type first: `if (typeof skillMarkdown !== "string") return [];`
- `typeof x === "string"` before use; default/skip on mismatch (see lines 160-162, 227-228).
- Build a findings array in a loop, `continue`/skip on malformed items (lines 156-158, 167-168).
- Return `[]` (empty), NEVER throw, on any structural mismatch (lines 145, 149, 152, 219).
- Only push a record when required fields are present & valid (analogue of lines 192-197).
- Drop required-field-missing blocks: no `signatureId` (empty heading), no `title`, or a
  `vulnClass` that fails `isVulnClass` → skip that block. `cwe` is nullable → default `null`.
  `severity` invalid/absent → either skip (safer) or default; contract requires each authored
  block to HAVE a valid severity, so treat missing/invalid severity in a real block as malformed.

---

### src/orchestrator/security-knowledge/parser.test.ts (create)

**Most similar existing test (real-asset convention):** `src/orchestrator/lens-panel-parity.test.ts:11-14`
reads a real skill file via `new URL(..., import.meta.url)`. Use the SAME approach. From
`src/orchestrator/security-knowledge/` the repo root is **three** levels up:
```ts
import { readFile } from "node:fs/promises";
const md = await readFile(
  new URL("../../../skills/bober.security-generic/SKILL.md", import.meta.url),
  "utf-8",
);
```
(The lens test is at `src/orchestrator/` so it uses `../../`; you are one dir deeper → `../../../`.)

**Runner/assertion precedent:** `security-audit-types.test.ts:1` → `import { describe, it, expect } from "vitest"`.

---

### skills/bober.security-generic/SKILL.md (create)

**Directory pattern:** Skill files live at `skills/<name>/SKILL.md`. Existing security-family
dir is `skills/bober.security-audit/` (that is the AUDIT WORKFLOW skill — DO NOT confuse it
with this per-stack signature skill). The per-stack naming is `bober.security-<stack>`
(architecture). `skills/bober.security-generic/` does NOT exist yet (verified).

**Frontmatter precedent:** `skills/bober.solidity/SKILL.md:1-9` and `skills/bober.react/SKILL.md:1-4`:
```markdown
---
name: bober.security-generic
description: "..."
---
```
`name` + `description` are the only required keys (react uses just those two). `argument-hint`
and `handoffs` are optional and not needed for a signature-library skill.

**Required structure (sc-2-3):** frontmatter → a `## Signature Block Format` section that
documents the schema ONCE (this is the in-file format doc the parser's comment references,
sc-2-2) → a `## Signatures` section with >=12 `### <signatureId>` blocks.

---

## 2. Patterns to Follow

### Defensive narrowing / never-throw parser (THE core pattern)
**Source:** `src/orchestrator/security-scanners.ts`, lines 144-201
```ts
export function parseSlitherOutput(json: unknown): SecurityFinding[] {
  if (!json || typeof json !== "object" || Array.isArray(json)) return [];   // guard input
  const root = json as Record<string, unknown>;
  const results = root.results;
  if (!results || typeof results !== "object" || Array.isArray(results)) return [];
  const detectors = (results as Record<string, unknown>).detectors;
  if (!Array.isArray(detectors)) return [];
  const findings: SecurityFinding[] = [];
  for (const detector of detectors) {
    if (!detector || typeof detector !== "object") continue;                 // skip malformed
    const d = detector as Record<string, unknown>;
    const check = typeof d.check === "string" ? d.check : "unknown-check";   // typeof-guard each field
    // ...
    findings.push({ /* ... */ });
  }
  return findings;                                                           // partial subset, never throws
}
```
**Rule:** Guard the input type, `typeof`-guard every field, `continue` past malformed blocks,
accumulate the valid ones, `return []` on any structural mismatch — NEVER throw.

### is-member type guard against ALL_VULN_CLASSES
**Source:** `src/orchestrator/security-scanners.ts`, lines 74-76
```ts
function isVulnClass(value: string): value is VulnClass {
  return (ALL_VULN_CLASSES as string[]).includes(value);
}
```
**Rule:** Validate a parsed `vulnClass` string against `ALL_VULN_CLASSES` (exported from
`stack-knowledge.ts:40`) before accepting the block — do the same for `severity`.

### Read a real skill asset in a test
**Source:** `src/orchestrator/lens-panel-parity.test.ts`, lines 10-18
```ts
it("embeds every resolveLensFocus fragment verbatim", async () => {
  const md = await readFile(new URL("../../skills/shared/lens-panel.md", import.meta.url), "utf-8");
  for (const lens of BUILT_IN_LENSES) expect(md).toContain(resolveLensFocus(lens));
});
```
**Rule:** Tests read the ACTUAL on-disk file via `new URL(relPath, import.meta.url)`, not an
inline fixture (repo convention — "test against real assets", per generatorNotes[4]/evaluatorNotes).

### Compile-time exhaustiveness gate (optional, strong)
**Source:** `src/orchestrator/security-audit-types.test.ts`, lines 106-130
A `Record<VulnClass, true> PRESENCE` object forces TS to list every union member; the runtime
`expect([...ALL_VULN_CLASSES].sort()).toEqual(Object.keys(PRESENCE).sort())` catches drift.
**Rule:** You can reuse this idea to assert every `SecurityStackId` is covered if useful, but
it is not required by the success criteria.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `VulnClass` (17-member union) | `src/orchestrator/security-audit-types.ts:9-26` | `type` | The widened vuln taxonomy — `vulnClass` field references it. |
| `FindingSeverity` | `src/orchestrator/security-audit-types.ts:31` | `type = "critical"\|"high"\|"medium"\|"low"\|"info"` | Severity union — `severity` field references it. |
| `ALL_VULN_CLASSES` | `src/orchestrator/stack-knowledge.ts:40-58` | `VulnClass[]` | Runtime array of every VulnClass — use to validate parsed vulnClass strings. |
| `parseSlitherOutput` | `src/orchestrator/security-scanners.ts:144` | `(json: unknown) => SecurityFinding[]` | THE defensive-narrowing precedent to mirror. |
| `parseSemgrepOutput` | `src/orchestrator/security-scanners.ts:214` | `(json: unknown) => SecurityFinding[]` | Second never-throw parser example. |
| `isVulnClass` | `src/orchestrator/security-scanners.ts:74` | `(v: string) => v is VulnClass` | Pattern for the membership guard (it's private there — write your own or lift it; do NOT import a non-exported symbol). |
| `parseFrontmatter` | `src/vault/frontmatter.ts:53` | `(raw: string) => { frontmatter: Record<string,unknown>; body: string }` | TOTAL frontmatter splitter — returns `{frontmatter:{}, body:raw}` when there's no/unclosed `---`, never throws. Use to strip the SKILL.md frontmatter and parse signature blocks from `.body`. |
| `serializeFrontmatter` | `src/vault/frontmatter.ts:145` | `(fm, body) => string` | Inverse (writing notes) — not needed here, listed so you don't reinvent it. |

Utilities reviewed: `src/utils/` (fs.ts, git.ts, logger.ts) holds no string/markdown-block
parser — the parser is pure and must NOT log, so `logger` is irrelevant here. There is no
`lib/`, `helpers/`, or `shared/` code dir. The ONE reusable helper is `parseFrontmatter`
(`src/vault/frontmatter.ts:53`, above): use it to split the SKILL.md `---` frontmatter from the
body so your block parser runs on `.body`. There is NO existing signature-block/markdown-section
parser — splitting `### ` blocks into structured records is net-new.

---

## 4. Prior Sprint Output

### Sprint 1 (commits d66351a, f64b9f5): Widened taxonomy + finding metadata
**Modified:** `src/orchestrator/security-audit-types.ts` — now exports:
- `VulnClass` widened to **17** members (lines 9-26): `injection`, `authn-authz`,
  `secret-handling`, `input-validation`, `path-traversal`, `privilege-escalation`,
  `race-condition`, `money-integrity`, `ssrf`, `xss`, `insecure-randomness`, `crypto-weakness`,
  `deserialization`, `supply-chain`, `idor-bola`, `denial-of-service`, `audit-logging`.
- `FindingSeverity = "critical" | "high" | "medium" | "low" | "info"` (line 31).
- `FindingConfidence`, `TaintPath`, and optional `SecurityFinding` fields (cwe/severity/
  confidence/taint/signatureId) — not needed this sprint but confirm they exist.

`ALL_VULN_CLASSES` in `stack-knowledge.ts:40` was kept in lockstep (17 entries).

**Connection to this sprint:** `SecuritySignature.vulnClass` is `VulnClass`; `.severity` is
`FindingSeverity`. Import both **type-only** from `../security-audit-types.js`. Import
`ALL_VULN_CLASSES` (a value) from `../stack-knowledge.js` to validate parsed strings at runtime.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` at repo root was loaded for this briefing, but the operative rule
from generatorNotes/evaluatorNotes is explicit: **tests run against real assets** (read the
actual SKILL.md, not an inline fixture) and **`parse` is pure** (no `fs` inside — the index
does file IO in a later sprint).

### Architecture Decisions
The shape in sc-2-1 is quoted verbatim from
`arch-20260712-security-audit-agent-team-architecture.md` (referenced at `stack-knowledge.ts:17`
and `:33-38`). The SecuritySignature field list in the contract IS the architecture's shape —
follow it exactly, do not add/rename fields.

### Research payload (signature CONTENT source)
`.bober/research/research-20260714-security-auditor-pentest-deep-upgrade-research.md`:
- Section A "OWASP / injection / CWE" (lines 145-151) — CWE Top-25 ids and the highest-signal
  JS/TS greps (line 149) — the raw material for the generic blocks.
- G6 (line 121) is why the taxonomy was widened; the generic file must exercise the new classes.

---

## 6. Testing Patterns

### Unit Test Pattern
**Source:** `src/orchestrator/security-audit-types.test.ts:1` and `lens-panel-parity.test.ts:10-18`
```ts
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { SecuritySignatureParser } from "./parser.js";
import { ALL_VULN_CLASSES } from "../stack-knowledge.js";

describe("SecuritySignatureParser (total, pure)", () => {
  it("parses the real generic skill into >=12 well-formed signatures", async () => {
    const md = await readFile(
      new URL("../../../skills/bober.security-generic/SKILL.md", import.meta.url), "utf-8");
    const sigs = SecuritySignatureParser.parse("generic", md, "skills/bober.security-generic/SKILL.md");
    expect(sigs.length).toBeGreaterThanOrEqual(12);
    for (const s of sigs) {
      expect(ALL_VULN_CLASSES).toContain(s.vulnClass);   // sc-2-4 union membership
      expect(s.unsafeExample.trim()).not.toBe("");        // non-empty examples
      expect(s.safeExample.trim()).not.toBe("");
    }
  });

  it("is total: malformed input never throws, returns the valid subset", () => {
    for (const bad of ["", "### \n(no fields)", "not markdown at all", "### x\n- **Title:** t"]) {
      expect(() => SecuritySignatureParser.parse("generic", bad, "x")).not.toThrow();
    }
    expect(SecuritySignatureParser.parse("generic", "", "x")).toEqual([]);
  });
});
```
**Runner:** vitest (`package.json:16` `"test": "vitest"`, `vitest@^3` at :102).
**Assertion style:** `expect(...)` (BDD).
**Mock approach:** none needed — parser is pure; test the real file + inline malformed strings.
**File naming:** co-located `*.test.ts` (vitest default glob; no vitest.config — defaults apply).
**Location:** co-located next to `parser.ts`.

### E2E Test Pattern
Not applicable — this sprint is pure types + parser + a static markdown asset. No Playwright.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| (none) | new `security-knowledge/*` | low | All three code files are NET-NEW and imported by nothing yet (nonGoal: not wired into `runSecurityAudit`). Zero existing importers. |
| `src/orchestrator/security-audit-types.ts` | you import its types | low | Type-only import; you do not modify it. No break risk. |
| `src/orchestrator/stack-knowledge.ts` | you import `ALL_VULN_CLASSES` | low | Value import, read-only; do not modify. |

This is additive: creating a new module dir and a new skill file cannot regress runtime audit
behavior because nothing calls the new code (verified: `security-knowledge` has no importers).

### Existing Tests That Must Still Pass
- `src/orchestrator/security-audit-types.test.ts` — VulnClass/ALL_VULN_CLASSES lockstep and
  deriveVerdict; unaffected (you don't touch those files) but run it to confirm.
- `src/orchestrator/security-scanners.test.ts` (if present) — the parser precedent; unaffected.
- `src/orchestrator/lens-panel-parity.test.ts` — reads skill files by name; adding a NEW skill
  dir `bober.security-generic/` does not change its fixed `SKILL_DIRS`/`BUILT_IN_LENSES` lists,
  so it stays green. Confirm no parity gate globs ALL of `skills/` (it lists dirs explicitly).
- Any skill-count / skill-manifest test: grep for tests that enumerate `skills/` and assert a
  count — a new skill dir could bump an expected total. Run the full suite (sc-2-5).

### Features That Could Be Affected
- **Security audit pipeline** (`runSecurityAudit`, `resolveStackSecurityContext`) — shares the
  `VulnClass` taxonomy but this sprint does NOT wire the parser in. Verify `security` audit
  tests are byte-unchanged in behavior (they should be — no shared code is modified).

### Recommended Regression Checks
1. `npm run build` — TypeScript compiles (NodeNext `.js` import extensions correct).
2. `npx tsc --noEmit` / `npm run typecheck` (whichever exists) — no type errors.
3. `npx eslint src/orchestrator/security-knowledge/` — zero errors.
4. `npm test` (vitest) — FULL suite green, especially `security-audit-types.test.ts`,
   `lens-panel-parity.test.ts`, and the new `parser.test.ts`.
5. Confirm no diff to `runSecurityAudit`/prompt files (`git status` shows only the 4 new files).

---

## 8. Implementation Sequence

1. **`src/orchestrator/security-knowledge/signature.ts`** — define `SecurityStackId` and
   `SecuritySignature` exactly per sc-2-1; `import type` VulnClass/FindingSeverity.
   - Verify: `npx tsc --noEmit` compiles the new file with no unused-import error.
2. **`skills/bober.security-generic/SKILL.md`** — author frontmatter + `## Signature Block
   Format` doc + `## Signatures` with >=12 `### <signatureId>` blocks (see Section 9 table for
   content). Author it in the EXACT format your parser will read.
   - Verify: at least 12 `### ` headings; every block has Title/CWE/Severity/VulnClass/
     Invariant/Keywords + an unsafe and a safe fenced code block; every VulnClass value is one
     of the 17 union members.
3. **`src/orchestrator/security-knowledge/parser.ts`** — implement the total parser mirroring
   `parseSlitherOutput`. Split on `### `, extract labelled fields + fenced code, validate
   required fields + vulnClass/severity membership, drop malformed blocks, never throw.
   - Verify: manually eyeball that it returns >=12 for the file you just wrote.
4. **`src/orchestrator/security-knowledge/parser.test.ts`** — real-file test (>=12, union
   membership, non-empty examples) + totality test (empty/malformed → no throw, valid subset).
   - Verify: `npx vitest run src/orchestrator/security-knowledge/parser.test.ts` passes.
5. **Full verification** — `npm run build`, typecheck, `npx eslint src/`, `npm test` (full suite).
   - Verify: sc-2-5 — build+typecheck+lint clean, whole suite green, no runtime-audit diff.

---

## 9. Signature Content — the >=12 blocks to author (from research §A, line 149-150)

Author each block with a unique `signatureId`, a `title`, the `CWE`, a `severity`
(FindingSeverity), a `vulnClass` (MUST be a union member — column below is verified against
`security-audit-types.ts:9-26`), an `invariant`, and a one-line unsafe + safe example.

| # | signatureId (suggested) | Title | CWE | vulnClass (union member) | Unsafe → Safe (one-liner) |
|---|---|---|---|---|---|
| 1 | sql-injection | SQL injection via string concat | CWE-89 | `injection` | `db.query("...WHERE id="+req.query.id)` → parameterized `db.query("...WHERE id=$1",[id])` |
| 2 | command-injection | OS command injection | CWE-78 | `injection` | `exec("ping "+host)` / `shell:true` → `execFile("ping",[host])` no shell |
| 3 | path-traversal | Path traversal in file read | CWE-22 | `path-traversal` | `fs.readFile(path.join(base,req.query.f))` → resolve + assert `resolved.startsWith(base)` |
| 4 | ssrf-outbound-fetch | SSRF via unvalidated outbound URL | CWE-918 | `ssrf` | `fetch(req.body.url)` → allowlist host + block RFC1918/169.254.169.254 at connect layer |
| 5 | reflected-xss | XSS via unescaped HTML sink | CWE-79 | `xss` | `el.innerHTML = userInput` / `dangerouslySetInnerHTML` → textContent / escaped/sanitized |
| 6 | hardcoded-secret | Hard-coded credential/API key | CWE-798 | `secret-handling` | `const key = "sk-live-abc123"` → `process.env.API_KEY` from a secrets store |
| 7 | missing-authz-bola | Missing ownership check (BOLA) on id→DB | CWE-639 / CWE-862 | `idor-bola` | `Order.findById(req.params.id)` → add `where ownerId === session.userId` predicate |
| 8 | insecure-deserialization | Unsafe deserialization of tainted data | CWE-502 | `deserialization` | `unserialize(req.body)` / `vm`/`new Function` on input → schema-validated JSON.parse only |
| 9 | weak-randomness | Predictable RNG for security value | CWE-338 | `insecure-randomness` | `Math.random()` token → `crypto.randomBytes(32)` / `crypto.randomUUID()` |
| 10 | prototype-pollution | Prototype pollution via recursive merge | CWE-1321 | `input-validation` | deep-merge of `req.body` → block `__proto__`/`constructor` keys / null-proto + schema |
| 11 | ssti | Server-side template injection | CWE-1336 / CWE-94 | `injection` | `template(userInput)` compiled → precompiled template + data-only context, no eval |
| 12 | log-injection-crlf | CRLF / log injection | CWE-117 / CWE-93 | `audit-logging` | `logger.info("user="+raw)` → strip/encode `\r\n`; structured logging fields |
| 13 | mass-assignment | Mass assignment / BOPLA | CWE-915 | `input-validation` | `User.update(req.body)` → explicit allowlist of updatable fields |
| 14 (opt) | weak-crypto-hash | Weak hash for passwords/integrity | CWE-327 | `crypto-weakness` | `crypto.createHash("md5")` → argon2/bcrypt (pw) or SHA-256 (integrity) |

Rows 1-13 satisfy sc-2-3's explicit class list (SQLi, command-injection, path-traversal, SSRF,
XSS, hardcoded-secret, missing-authz/BOLA, insecure-deserialization, weak-randomness,
prototype-pollution/SSTI [rows 10+11], CRLF/log-injection, mass-assignment) = 13 blocks ≥ the
12 required. Row 14 is a freebie exercising `crypto-weakness`. Keep `cwe` strings like `"CWE-89"`
(use ONE primary CWE per block; the table shows alternatives, pick one).

---

## 10. Pitfalls & Warnings

- **Do NOT wire the parser into `runSecurityAudit` / the auditor prompt** — sc-2-5 + nonGoals[2]
  require zero runtime-audit behavior change. The parser is imported only by its own test.
- **`.js` import extensions are mandatory** (NodeNext ESM). `from "../security-audit-types.js"`,
  `from "./signature.js"`, `from "../stack-knowledge.js"` — omitting `.js` fails the build.
- **`import type` for VulnClass/FindingSeverity** (they're types); **value import** for
  `ALL_VULN_CLASSES` (it's a runtime array). Mixing these up breaks `verbatimModuleSyntax`/lint.
- **`isVulnClass` in security-scanners.ts is NOT exported** — do not import it; write your own
  local guard (2 lines) against `ALL_VULN_CLASSES`.
- **The parser and the SKILL.md are ONE spec** — if you invent a block delimiter the file
  doesn't use, sc-2-4 (>=12 parsed from the real file) fails. Author the file first OR keep them
  in strict sync; the real-file test is the ground truth.
- **`bober.security-audit` already exists** and is the audit *workflow* skill — your new
  `bober.security-generic` is a *signature-library* skill. Different purpose; don't edit the
  existing one.
- **`vulnClass` values must be exact union strings** — e.g. `insecure-randomness` (NOT
  `weak-randomness`), `idor-bola` (NOT `bola`), `secret-handling` (NOT `hardcoded-secret`),
  `deserialization` (NOT `insecure-deserialization`). The block *title* can be human-friendly;
  the `VulnClass` field must be a verbatim member of the 17-value union.
- **Totality means EVERY path returns `[]` or a subset, never throws** — guard `typeof
  skillMarkdown !== "string"`, handle empty string, truncated/unclosed code fences, a `### `
  heading with no fields, and a block with a bogus vulnClass. The evaluator will fuzz these.
- **A skill-count/enumeration test may exist** — adding a skill dir can bump an expected total.
  Run the FULL suite, not just the new test file.
