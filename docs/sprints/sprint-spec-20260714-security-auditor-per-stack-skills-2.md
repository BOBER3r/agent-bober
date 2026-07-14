# Signature type + skill-file authoring format + total parser + generic security skill

**Contract:** sprint-spec-20260714-security-auditor-per-stack-skills-2  ·  **Spec:** spec-20260714-security-auditor-per-stack-skills  ·  **Completed:** 2026-07-14

## What this sprint added

The **authoring-format foundation** for per-stack security knowledge: an on-disk format for hand-written vulnerability signatures and the total parser that reads it. Three things landed together and are meant to be read as one executable spec: (1) the `SecuritySignature` type plus the `SecurityStackId` union (`src/orchestrator/security-knowledge/signature.ts`); (2) `SecuritySignatureParser` (`parser.ts`) — a **pure, total** parser that splits a security skill file's post-frontmatter body on `### ` headings, validates each block, and drops malformed blocks without ever throwing; and (3) the first per-stack skill file, `skills/bober.security-generic/SKILL.md`, authored as **14 discrete signature blocks** covering generic OWASP/CWE classes. Nothing is wired into `runSecurityAudit` yet — the parser and skill file are dormant data plumbing that later sprints (the index/selector in sprint 5) will consume. The generic skill file and the parser are each the executable spec of the other's format.

## Public surface

- `SecurityStackId` (`src/orchestrator/security-knowledge/signature.ts:10`) — the eight stack identifiers a signature can belong to: `'solidity' | 'anchor' | 'react' | 'node' | 'payments' | 'igaming' | 'dex-backend' | 'generic'`. `generic` is the shared library every other stack skill supplements.
- `SecuritySignature` (`src/orchestrator/security-knowledge/signature.ts:27`) — one parsed vulnerable/safe signature: `{ stackId, signatureId, title, cwe: string | null, severity: FindingSeverity, vulnClass: VulnClass, invariant, unsafeExample, safeExample, keywords: string[], skillRef }`. Shape is quoted verbatim from the architecture; the parser is its only producer. `FindingSeverity` and `VulnClass` are imported **type-only** from the sprint-1 `security-audit-types.ts`.
- `SecuritySignatureParser.parse(stackId, skillMarkdown, skillRelPath)` (`src/orchestrator/security-knowledge/parser.ts:142`) — returns `SecuritySignature[]`. Pure (no fs, no mutation of inputs) and total (never throws; drops any malformed block and returns the parseable subset). `skillRelPath` is stored on each record's `skillRef` for provenance.
- `skills/bober.security-generic/SKILL.md` — the first per-stack security signature library, a **data file** (not a workflow skill) read as raw markdown by the parser. Parses to 14 well-formed signatures.

## The signature-block authoring format

A security skill file is standard skill frontmatter (`name` / `description`), a `## Signature Block Format` section documenting the schema once, and a `## Signatures` section of discrete blocks. Each **block** is a level-3 heading whose text is the `signatureId`, followed by labelled fields and two fenced code examples:

```markdown
### <signatureId>
- **Title:** <human-readable title>
- **CWE:** CWE-xx            (optional — omit the line entirely for cwe: null)
- **Severity:** critical|high|medium|low|info
- **VulnClass:** <a VulnClass union member, verbatim>
- **Invariant:** <the safety invariant this signature protects>
- **Keywords:** comma, separated, keywords

**Unsafe:**
```ts
<vulnerable example>
```

**Safe:**
```ts
<fixed example>
```
```

**Required fields** — a block is dropped (silently, never a fatal error) unless it has all of: a non-empty `signatureId` (the heading text), a `Title`, a `Severity` that is one of the five `FindingSeverity` values, a `VulnClass` that is a verbatim member of the `ALL_VULN_CLASSES` union, a non-empty `**Unsafe:**` fenced example, and a non-empty `**Safe:**` fenced example. `CWE`, `Invariant`, and `Keywords` are optional — a missing `CWE` line yields `cwe: null`, a missing `Keywords` line yields `[]`.

**Authoring rule — no literal `### ` in prose outside signature blocks.** The parser splits the whole post-frontmatter body on `### ` at line start (`/^### /m`), so every `### ` heading in the body is treated as the start of a signature block. Do not use level-3 headings for section prose inside a signature library file; a stray `### ` will be parsed as a (probably malformed, therefore dropped) signature and silently swallow the text under it until the next heading. Use `##` for structural sections (as the generic file does for `## Signature Block Format` and `## Signatures`).

## The parser's purity / totality contract

`SecuritySignatureParser.parse` mirrors the defensive-narrowing style of `parseSlitherOutput` (`security-scanners.ts`): guard the input type, walk blocks, `continue`/drop past anything malformed, never throw, and return whatever subset is well-formed. Concretely:

- **Pure.** Takes markdown *text* — it does no filesystem access itself (a caller / the future index does the `readFile`) and does not mutate its inputs. A non-string `skillMarkdown` returns `[]`.
- **Total.** Every failure mode degrades to a dropped block, never an exception: a missing `signatureId`/`Title`/`Severity`/`VulnClass`, a `VulnClass` outside the union, a `Severity` outside the five values, or a truncated/unclosed code fence (`extractFencedExample` returns `null` when the marker, opening fence, or closing fence is missing). Frontmatter is stripped first via the shared `parseFrontmatter` helper.

This is verified against the **real** on-disk file (per the repo convention of testing against real assets, not inline fixtures): `parser.test.ts` reads `skills/bober.security-generic/SKILL.md`, asserts ≥12 well-formed signatures with union-member `vulnClass`es and non-empty unsafe/safe examples and unique `signatureId`s, and fuzzes the parser with eight deliberately malformed inputs to assert no throw. The evaluator independently re-parsed the real file (14 signatures, no phantom blocks).

## The generic skill's 14 signatures

`skills/bober.security-generic/SKILL.md` covers, one signature block each: `sql-injection` (CWE-89), `command-injection` (CWE-78), `path-traversal` (CWE-22), `ssrf-outbound-fetch` (CWE-918), `reflected-xss` (CWE-79), `hardcoded-secret` (CWE-798), `missing-authz-bola` (CWE-862), `insecure-deserialization` (CWE-502), `weak-randomness` (CWE-338), `prototype-pollution` (CWE-1321), `ssti` (CWE-94), `log-injection-crlf` (CWE-117), `mass-assignment` (CWE-915), and `weak-crypto-hash` (CWE-327). Each `VulnClass` is drawn from the sprint-1 widened taxonomy (e.g. `injection`, `ssrf`, `xss`, `path-traversal`, `secret-handling`, `idor-bola`, `deserialization`, `insecure-randomness`, `input-validation`, `audit-logging`, `crypto-weakness`).

## Notes for maintainers

- **Adding a signature = editing the markdown, not the code.** The parser is generic over the block format; author new signatures by adding `### ` blocks to a skill file, keeping every required field present. Keep the `## Signature Block Format` section in the file in sync with the parser — they are a single spec and a drift will silently drop blocks.
- **`VulnClass` must be a verbatim union member.** A signature whose `VulnClass` line names a class not in `ALL_VULN_CLASSES` is dropped, not coerced. When adding a new class, widen the sprint-1 taxonomy first (and its lockstep test) before authoring signatures against it.
- **Nothing runs yet.** This sprint changed no runtime audit behavior: the type, parser, and skill file are not referenced by `runSecurityAudit`, the gate, or the CLI. The suite stayed green at **4076** with zero behavior deltas. The index/selector/registry that loads these files and feeds the finder is sprint 5; the other seven stack skill files are sprints 3–4.
- **Non-goals honored.** No other stack skill files, no index/selector/registry/resolver, no finder wiring, no skill-file lint CLI (a documented follow-up candidate), and no prompt or `runSecurityAudit` change.

## Scope

One commit — `22c8739` (`bober(sprint-2): SecuritySignature type + total parser + generic security skill`) — adding exactly four files: `src/orchestrator/security-knowledge/signature.ts`, `parser.ts`, `parser.test.ts`, and `skills/bober.security-generic/SKILL.md` (606 insertions, no deletions). All 5 required criteria (sc-2-1..2-5) passed on iteration 1; typecheck, build, lint, and the full suite (314 files / **4076 tests**) green.
