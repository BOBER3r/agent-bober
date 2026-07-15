# Sprint Briefing: Author the web/backend security skill files (node, payments, react)

**Contract:** sprint-spec-20260714-security-auditor-per-stack-skills-4
**Generated:** 2026-07-14T18:00:00Z

> This is the **same content-authoring task as sprint 3** (commit f19a4bf), different stacks. Three new
> `SKILL.md` files (all `create`) in the exact sprint-2/3 signature-block format, plus **modifying** the
> existing `skill-files.test.ts` (created by sprint 3) to enumerate all 8 stacks. No TypeScript runtime changes.
> The highest-value parts of this briefing are **Section 5 (per-stack worksheets)**, the verbatim 17-member
> **VulnClass union in Section 3**, and the **`bober.security-audit` glob landmine in Sections 6 & 9**. Read those.

---

## 1. Target Files

Three skill files are **create** (verified missing: `skills/bober.security-node/`, `.../security-payments/`,
`.../security-react/` do not exist). The test file is **modify** (exists from sprint 3 with 4 `CASES` entries).

### skills/bober.security-node/SKILL.md (create) — >= 10 blocks (author 12 for margin)
### skills/bober.security-payments/SKILL.md (create) — >= 8 blocks (author 10 for margin)
### skills/bober.security-react/SKILL.md (create) — >= 6 blocks (author 7-8 for margin)

**Directory pattern:** each skill is a directory `skills/bober.security-<stack>/` containing a single `SKILL.md`
(confirmed by `ls`: existing `bober.security-{anchor,audit,dex-backend,generic,igaming,solidity}`). Create the 3
new dirs. **stackId per file** (must match `SecurityStackId` in `signature.ts:10-18`): `"node"`, `"payments"`,
`"react"` — all three are legal members of that union.

**Most similar existing file (the exact template to copy):** `skills/bober.security-igaming/SKILL.md`
(authored last sprint, format verified verbatim in Section 2 below). Copy its frontmatter shape, its
`## Signature Block Format` doc section, and its `## Signatures` block layout. `skills/bober.security-generic/SKILL.md`
is an equally valid template.

### src/orchestrator/security-knowledge/skill-files.test.ts (MODIFY — already exists)

Currently a table test over **4** `FileCase` entries (solidity, anchor, igaming, dex-backend). This sprint must:
1. Add **3 new `FileCase` entries** (node minBlocks 10, payments 8, react 6) to the `CASES` array.
2. Add the **exact-8 enumeration test** (sc-4-5) — see Section 6, including the `bober.security-audit` landmine.
The existing zero-drop / uniqueness / money-loss-id / "never uses access-control" tests loop over `CASES`, so
they automatically extend to the 3 new files once the entries are added.

---

## 2. Patterns to Follow (verbatim from the real igaming file)

### Pattern A — Frontmatter (copy shape, change name+description)
**Source:** `skills/bober.security-igaming/SKILL.md`, lines 1-4 (quoted verbatim):
```md
---
name: bober.security-igaming
description: "iGaming/betting backend security signature library. Not a workflow skill -- a data file of discrete vulnerable/safe code signature blocks read by SecuritySignatureParser. Covers TOCTOU balance double-spend, ..."
---
```
**Rule:** Each new file opens with a `---` fenced frontmatter block carrying `name: bober.security-<stack>` and a
one-line `description`. `parseFrontmatter` (`src/vault/frontmatter.ts:53`) strips this before the parser splits on
`### `. The opening `---` is mandatory and must have a closing `---`, or the whole file (frontmatter included) is
treated as body.

### Pattern B — Doc sections stay at level-2 (`##`), NEVER level-3 (`###`)
**Source:** `skills/bober.security-igaming/SKILL.md`, lines 6-36 — an intro paragraph, then `## Signature Block
Format` (reusable verbatim; it contains no `### ` line), then `## Signatures`. The parser splits the whole
post-frontmatter body on `/^### /m` (`parser.ts:146`). Any line starting with `### ` — in prose, a doc heading,
OR inside a fenced code example — starts a new "block". Keep every doc heading at `##`.

### Pattern C — A single signature block (the unit you author ~30 times) — VERBATIM
**Source:** `skills/bober.security-igaming/SKILL.md`, lines 141-162 (the `igaming.missing-webhook-hmac` block —
directly relevant to the payments file), quoted verbatim:
```md
### igaming.missing-webhook-hmac
- **Title:** Missing/incorrect provider webhook HMAC + timestamp verification
- **CWE:** CWE-345
- **Severity:** critical
- **VulnClass:** authn-authz
- **Invariant:** A webhook payload is only processed after its HMAC signature over the raw request body is verified with a constant-time comparison and its timestamp is checked against replay drift.
- **Keywords:** webhook, HMAC, timingSafeEqual, raw-body, timestamp

**Unsafe:**
```ts
app.post("/webhook", (req, res) => { applySettlement(req.body); }); // body trusted, unsigned
```

**Safe:**
```ts
const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers["x-signature"])) ||
    Date.now() - Number(req.headers["x-timestamp"]) > MAX_SKEW_MS) {
  return res.status(401).end();
}
applySettlement(req.body);
```
```
**Rule:** heading = `### <signatureId>`; then the six `- **Field:**` lines (CWE optional, omit line for
`cwe: null`); then `**Unsafe:**` + a fenced ` ```ts ` block; then `**Safe:**` + a fenced ` ```ts ` block. A block
missing Title, a valid VulnClass, a valid Severity, or a non-empty Unsafe/Safe example is **silently dropped**
(`parser.ts:100-113`). Dropped block = failed sprint. Keep examples short (grounding, not a tutorial).

### Pattern D — Field label regex (author labels EXACTLY, case-sensitive)
**Source:** `parser.ts:55`:
```ts
const LABEL_RE = /^-\s+\*\*(Title|CWE|Severity|VulnClass|Invariant|Keywords):\*\*\s*(.*)$/;
```
**Rule:** Labels must be exactly `Title`, `CWE`, `Severity`, `VulnClass`, `Invariant`, `Keywords`, each as
`- **Label:** value`. `**VulnClass:**`, not `**Vuln Class:**` or `**vulnclass:**`. Line is `trim()`-ed before
matching, so leading indentation is fine.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `SecuritySignatureParser.parse` | `src/orchestrator/security-knowledge/parser.ts:142` | `(stackId: SecurityStackId, skillMarkdown: string, skillRelPath: string): SecuritySignature[]` | The ONLY consumer of the files you author. Pure, total, never throws, drops malformed blocks. Use it in the test. |
| `ALL_VULN_CLASSES` | `src/orchestrator/stack-knowledge.ts:40` | `VulnClass[]` (17 members) | The allowlist every `VulnClass` field is validated against. Already imported by the test. |
| `isVulnClass` (internal) | `src/orchestrator/security-knowledge/parser.ts:41` | `(value: string) => value is VulnClass` | How the parser validates `**VulnClass:**` — a value not in `ALL_VULN_CLASSES` drops the block. |
| `parseFrontmatter` | `src/vault/frontmatter.ts:53` | `(raw: string) => { frontmatter, body }` | Strips the `---...---` header before the split. Already imported by the test for the zero-drop count. |
| `SecuritySignature` (type) | `src/orchestrator/security-knowledge/signature.ts:27` | interface | The record shape the parser emits (`stackId, signatureId, title, cwe, severity, vulnClass, invariant, unsafeExample, safeExample, keywords, skillRef`). |
| `SecurityStackId` (type) | `src/orchestrator/security-knowledge/signature.ts:10` | union | The 8 legal stack ids incl. `"node" "payments" "react" "generic"`. |
| `readdir` | `node:fs/promises` | `(path|URL) => Promise<string[]>` | Used in existing tests (`src/chat/chat-session-approval.test.ts:503`, `src/research/job-store.ts:73`). Use it for the sc-4-5 enumeration. |
| `glob` | `"glob"` (v11, package.json dep) | `import { glob } from "glob"` | Also available (used in `src/vault/note-io.ts:16`) if you prefer glob over readdir. `readdir` is simpler here. |

**Utilities reviewed:** `src/orchestrator/security-knowledge/` (parser, signature), `src/orchestrator/`
(security-audit-types, stack-knowledge), `src/vault/frontmatter.ts`, node:fs/promises `readdir`, `glob` v11.
No new utility is needed — pure markdown authoring + extending one existing test.

### CRITICAL — the EXACT VulnClass union (verbatim members, `security-audit-types.ts:9-26` — re-verified this sprint)
The union has **exactly 17 members**. Every `- **VulnClass:**` value MUST be one of these, spelled verbatim:
```
 1. injection            7. race-condition      13. deserialization
 2. authn-authz          8. money-integrity     14. supply-chain
 3. secret-handling      9. ssrf                15. idor-bola
 4. input-validation    10. xss                 16. denial-of-service
 5. path-traversal      11. insecure-randomness 17. audit-logging
 6. privilege-escalation 12. crypto-weakness
```
**`access-control` is NOT a member** (it drops any block using it — this was the #1 predicted failure in sprint 3,
and the test at `skill-files.test.ts:114` explicitly guards against it). For BOLA/BOPLA use `idor-bola`; for
missing role gates / broken auth use `authn-authz`; for unprotected-initializer-style takeover use
`privilege-escalation`. Never write `access-control`, `access_control`, `broken-access-control`, or `authz`.

---

## 4. Prior Sprint Output

### Sprint 2 (commit 22c8739): SecuritySignatureParser + bober.security-generic
Created `src/orchestrator/security-knowledge/parser.ts` + `signature.ts` + `parser.test.ts` +
`skills/bober.security-generic/SKILL.md` (14 blocks). Format + parser are frozen.

### Sprint 3 (commit f19a4bf): 4 money/crypto skill files + skill-files.test.ts
Created `skills/bober.security-{solidity,anchor,igaming,dex-backend}/SKILL.md` and
`src/orchestrator/security-knowledge/skill-files.test.ts` (the 4-entry `CASES` table you now extend).
**Connection to this sprint:** author node/payments/react in the **identical** format; parsed by the **same**
`SecuritySignatureParser.parse`. Add 3 `FileCase` rows + the exact-8 enumeration test to the same test file.

---

## 5. Signature Content Per Stack (the authoring worksheet)

Sourced from `.bober/research/research-20260714-security-auditor-pentest-deep-upgrade-research.md`:
Section A (OWASP/injection, lines 145-151) for node + react XSS; Section B (iGaming money-loss, lines 153-162) and
Section C off-chain (line 167) for payments. **Every `vulnClass` below is a verified member of the 17-member union
in Section 3** — none is `access-control`. Severity: direct-fund-loss / auth-bypass → `critical`, else `high`.
Where a cell shows `(omit)`, omit the `- **CWE:**` line entirely (yields `cwe: null`). The unsafe/safe columns are
*ideas* — author a minimal `ts` example for each. Keep `signatureId`s stack-prefixed (`node.*`, `payments.*`,
`react.*`) and unique within the file.

### node (author >= 10; 12 listed — Section A lines 147-150)
| signatureId | Title | cwe | vulnClass | unsafe → safe idea | keywords |
|---|---|---|---|---|---|
| node.sql-injection | SQL injection via string concatenation / template literal | CWE-89 | injection | `db.query("... WHERE id=" + req.query.id)` → parameterized `$1` placeholder | sql, query, concat, template-literal, parameterized |
| node.orm-raw-escape-hatch | ORM raw escape hatch (.raw/.literal/$queryRawUnsafe/$where) | CWE-89 | injection | `prisma.$queryRawUnsafe("..." + input)` / knex `.raw` with interp → `$queryRaw` tagged template / bound params | ORM, raw, $queryRawUnsafe, literal, $where, prisma, knex |
| node.command-injection | OS command injection via exec / shell:true | CWE-78 | injection | `exec("convert " + req.body.file)` / `spawn(cmd,{shell:true})` → `execFile(bin,[args])` no shell | exec, child_process, shell, execFile, command |
| node.path-traversal | Path traversal (path.join/resolve, no boundary assert) | CWE-22 | path-traversal | `fs.readFile(path.join(base, req.params.name))` → resolve + assert `startsWith(base)` | path.join, path.resolve, traversal, ../, boundary |
| node.ssrf-outbound-fetch | SSRF via unvalidated outbound fetch/axios (metadata/RFC1918) | CWE-918 | ssrf | `fetch(req.body.url)` reaches 169.254.169.254 / RFC1918 → allowlist host + block internal ranges at connect | ssrf, fetch, axios, 169.254.169.254, RFC1918, metadata |
| node.bola-missing-ownership | BOLA: object id → DB lookup with no owner predicate | CWE-639 | idor-bola | `getDoc(req.params.id)` returns any user's row → `WHERE id=$1 AND owner_id=$2` (session user) | BOLA, IDOR, ownerId, object id, authorization |
| node.mass-assignment-bopla | BOPLA / mass assignment (Model.update(req.body)) | CWE-915 | idor-bola | `User.update(req.body)` lets client set `isAdmin` → explicit allowlist of updatable fields | mass assignment, BOPLA, req.body, allowlist, isAdmin |
| node.bfla-admin-no-role-gate | BFLA: admin/privileged route with no role gate | CWE-862 | authn-authz | `app.post('/admin/...', handler)` no role check → `requireRole('admin')` middleware | BFLA, admin route, role, requireRole, authorization |
| node.insecure-deserialization | Insecure deserialization of untrusted input | CWE-502 | deserialization | `serialize.unserialize(req.body)` / `yaml.load(untrusted)` → `JSON.parse` / `yaml.load` safe schema | deserialization, unserialize, yaml.load, node-serialize, gadget |
| node.vm-not-a-sandbox | `vm`/`new Function`/`eval` on tainted input (vm is not a sandbox) | CWE-94 | injection | `new vm.Script(req.body.code).runInNewContext()` / `eval(input)` → never eval untrusted; real sandbox/worker + allowlist | vm, vm2, new Function, eval, runInNewContext, sandbox |
| node.secrets-hardcoded-logged | Hard-coded or logged secrets | CWE-798 | secret-handling | `const key='sk_live_...'` / `logger.info(apiKey)` → env/secret manager, redact in logs | secret, API key, hardcoded, logger, redact, .env |
| node.jwt-alg-none | JWT alg:none / weak secret / session fixation | CWE-347 | authn-authz | `jwt.verify(t, key, {algorithms:['none']})` or shared weak secret → pin strong alg + strong secret + rotate session id on login | JWT, alg none, algorithms, session fixation, verify |

Note: `node.jwt-alg-none` may alternatively use `crypto-weakness` for the alg:none angle specifically; `authn-authz`
is the recommended single pick (matches the igaming webhook precedent and keeps the broken-auth family cohesive).
`node.mass-assignment-bopla` may alternatively use `input-validation`; `idor-bola` is the recommended pick
(BOPLA is the API3:2023 object-property authorization class). Either is a valid union member — pick one and be
consistent.

### payments (author >= 8; 10 listed — Section B lines 154-158 + Section C line 167)
| signatureId | Title | cwe | vulnClass | unsafe → safe idea | keywords |
|---|---|---|---|---|---|
| payments.webhook-missing-hmac | PSP webhook processed without HMAC signature verification | CWE-345 | authn-authz | `app.post('/psp/webhook', h)` trusts unsigned body → verify HMAC over raw body before processing | webhook, HMAC, PSP, raw-body, signature, verify |
| payments.webhook-nonconstant-compare | Webhook signature compared non-constant-time / no timestamp | CWE-208 | crypto-weakness | `sig === expected` (`==`) + no timestamp → `crypto.timingSafeEqual` + signed-timestamp replay window | timingSafeEqual, timing attack, ===, timestamp, replay |
| payments.missing-idempotency-key | Missing/non-atomic idempotency key on a money endpoint | CWE-362 | race-condition | check-then-insert on charge key not atomic → unique idempotency key + `INSERT ... ON CONFLICT DO NOTHING` | idempotency, idempotency-key, atomic, unique, upsert |
| payments.duplicate-credit-webhook-replay | Duplicate credit on PSP webhook replay (no event dedup) | CWE-799 | money-integrity | same `payment_intent.succeeded` credits twice on retry → dedup on provider event id (unique constraint) | webhook, replay, dedup, provider-event, double-credit |
| payments.refund-chargeback-abuse | Refund/chargeback abuse (over-refund, double refund, post-chargeback) | CWE-840 | money-integrity | `refund(req.body.amount)` no cap → refund <= captured-minus-already-refunded; block after chargeback | refund, chargeback, over-refund, double refund, dispute |
| payments.float-money-currency-mismatch | Float money / currency-conversion mismatch | CWE-681 | money-integrity | `total += price*0.1` float / add USD to EUR → integer minor units + explicit currency, no cross-currency add | float, minor units, currency, Decimal, rounding, cents |
| payments.withdraw-different-method | Withdrawal to a method different from the funding source | CWE-840 | money-integrity | payout to arbitrary account != deposit method → restrict withdrawal to verified original funding instrument | withdrawal, payout, funding source, cash-out, method |
| payments.missing-withdrawal-approval-threshold | Large withdrawal with no approval threshold / dual control | CWE-862 | authn-authz | any-size withdrawal auto-approved → threshold gate + dual-control/manual review above limit | withdrawal, approval, threshold, dual control, four-eyes |
| payments.client-supplied-amount | Trusting client-supplied price/amount at charge | CWE-602 | money-integrity | `charge(req.body.amount)` client sets price → charge server-side catalog/order amount | amount, price, tampering, client-supplied, server-side |
| payments.unvalidated-refund-amount | Negative/oversized refund amount not validated | CWE-20 | money-integrity | `refund(req.body.amount)` negative/oversized → require integer `0 < amount <= captured` | refund, negative, validation, amount, bound |

Note: `payments.webhook-missing-hmac` may alternatively use `crypto-weakness`; `authn-authz` is recommended (it
matches the verbatim `igaming.missing-webhook-hmac` precedent at `security-igaming/SKILL.md:145`). The two webhook
rows are intentionally split (missing-signature = authn-authz; weak-compare = crypto-weakness) so both suggested
classes are represented. `payments.missing-idempotency-key` uses `race-condition` to match the
`igaming.non-atomic-idempotency` precedent (`security-igaming/SKILL.md:67`).

### react (author >= 6; 7 listed + 1 optional — Section A lines 149-150)
| signatureId | Title | cwe | vulnClass | unsafe → safe idea | keywords |
|---|---|---|---|---|---|
| react.dangerously-set-inner-html | XSS via dangerouslySetInnerHTML with variable input | CWE-79 | xss | `<div dangerouslySetInnerHTML={{__html: userBio}} />` → render as text / DOMPurify.sanitize | dangerouslySetInnerHTML, XSS, __html, DOMPurify, sanitize |
| react.raw-innerhtml-documentwrite | XSS via innerHTML / document.write with variable input | CWE-79 | xss | `el.innerHTML = params.q` / `document.write(input)` → `textContent` / sanitized render | innerHTML, document.write, XSS, textContent, DOM |
| react.secret-in-client-bundle | Secret / API key committed into the client bundle | CWE-798 | secret-handling | `const KEY='sk_live_...'` / `process.env.API_SECRET` referenced client-side → server-only proxy, never ship secret | API key, client bundle, secret, process.env, REACT_APP |
| react.client-trusted-authz | Security decision trusted client-side (must be server-side) | CWE-602 | authn-authz | `{user.isAdmin && <AdminPanel/>}` as the only gate → server enforces authorization on every request | client-side, isAdmin, authorization, trust boundary, server |
| react.unsafe-href-redirect | Unsafe href / open redirect (javascript: / attacker-controlled) | CWE-601 | input-validation | `<a href={userUrl}>` allows `javascript:` / `location=params.next` → allowlist scheme + same-origin/allowlist redirect | href, javascript:, open redirect, location, next, allowlist |
| react.postmessage-no-origin | postMessage handler without origin check | CWE-346 | input-validation | `window.onmessage=e=>run(e.data)` no `e.origin` check → verify `e.origin` against allowlist before use | postMessage, message event, origin, onmessage, allowlist |
| react.prototype-pollution-deepmerge | Prototype pollution via client deep-merge of untrusted input | CWE-1321 | input-validation | `deepMerge(state, JSON.parse(untrusted))` pollutes `__proto__` → guard `__proto__`/`constructor` keys / null-proto | prototype pollution, __proto__, deep merge, constructor, JSON.parse |
| react.token-in-localstorage (OPTIONAL 8th) | Auth token stored in localStorage (XSS-exfiltratable) | CWE-922 | secret-handling | `localStorage.setItem('jwt',token)` → httpOnly cookie, token not reachable by JS | localStorage, JWT, token, httpOnly, XSS exfiltration |

Note: `react.unsafe-href-redirect` and `react.prototype-pollution-deepmerge` each have a second valid class
(`xss` for `javascript:` URIs; `deserialization` for prototype pollution). The recommended single pick is
`input-validation` for both (open-redirect = CWE-601 input-validation; prototype pollution = untrusted-input
merge). Rows 1+2 both satisfy the sc-4-3 XSS requirement; authoring both gives a margin above the >=6 minimum.

---

## 6. Testing Patterns

### Extending the existing table test (already the model — `skill-files.test.ts:21-66`)
Add 3 entries to the `CASES: FileCase[]` array. Copy the exact shape of an existing entry
(`skill-files.test.ts:21-33`):
```ts
{
  stackId: "node",
  relPath: "skills/bober.security-node/SKILL.md",
  minBlocks: 10,
  expectedIdsOrKeywords: [
    "node.sql-injection",
    "node.command-injection",
    "node.bola-missing-ownership",
    "node.ssrf-outbound-fetch",
  ],
},
// ...payments (minBlocks 8): payments.webhook-missing-hmac, payments.missing-idempotency-key,
//    payments.duplicate-credit-webhook-replay, payments.withdraw-different-method
// ...react   (minBlocks 6): react.dangerously-set-inner-html, react.secret-in-client-bundle,
//    react.client-trusted-authz, react.postmessage-no-origin
```
The existing per-case tests (`skill-files.test.ts:71-110`) already assert: zero-drop
(`signatures.length === parseFrontmatter(md).body.split(/^### /m).length - 1`), min block count, valid vulnClass
(`ALL_VULN_CLASSES.toContain`), valid severity, non-empty unsafe/safe, `stackId`, `skillRef`, unique ids, and the
expected-id spot-check. Adding the 3 entries extends all of them for free.

### The sc-4-5 exact-8 enumeration test — WITH THE GLOB LANDMINE
sc-4-5 requires a **single test that enumerates `skills/bober.security-*/SKILL.md` and asserts EXACTLY the 8
expected stack files exist**: `solidity, anchor, react, node, payments, igaming, dex-backend, generic`.

**LANDMINE (verified by `ls`):** `skills/bober.security-audit/SKILL.md` **exists** and matches
`bober.security-*`. It is the audit *workflow* skill, NOT a signature file, and is NOT a `SecurityStackId`. A naive
glob returns **9** matches (audit + 8 stacks), not 8. The enumeration MUST exclude `audit`. Recommended shape
(readdir is dependency-free and matches the existing test's `import.meta.url` style):
```ts
import { readdir } from "node:fs/promises";

it("enumerates exactly the 8 expected security stack skill files (excludes the audit workflow skill)", async () => {
  const skillsDir = new URL("../../../skills/", import.meta.url);
  const names = await readdir(skillsDir);
  const stacks = names
    .filter((n) => n.startsWith("bober.security-"))
    .map((n) => n.slice("bober.security-".length))
    .filter((n) => n !== "audit"); // audit = the workflow skill, not a signature stack
  const EXPECTED = ["solidity", "anchor", "react", "node", "payments", "igaming", "dex-backend", "generic"];
  expect(new Set(stacks)).toEqual(new Set(EXPECTED));
  // each stack file parses to >= 6 signatures
  for (const stack of EXPECTED) {
    const rel = `skills/bober.security-${stack}/SKILL.md`;
    const md = await readFile(new URL(`../../../${rel}`, import.meta.url), "utf-8");
    const sigs = SecuritySignatureParser.parse(stack as SecurityStackId, md, rel);
    expect(sigs.length).toBeGreaterThanOrEqual(6);
  }
});
```
**Runner:** vitest. **Assertion style:** `expect(...)`. **Mock approach:** none (real-asset). **File naming:**
co-located `*.test.ts`. `generic` IS one of the 8 (it parses to 14, `generic:38+`), `audit` is excluded.
Do NOT confuse `skills/bober.react/` (the React *framework* skill — different directory, no `security-` prefix,
does not match the glob) with the new `skills/bober.security-react/`.

No E2E/Playwright applies.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| (none) | the 3 new SKILL.md files | low | Nothing imports these yet — the index/selector/finder wiring is sprint 5 (nonGoals[1]). Inert data until then. |
| `src/orchestrator/security-knowledge/skill-files.test.ts` | the 3 new SKILL.md + 4 existing + `parser.ts` + `stack-knowledge.ts` | n/a | You edit this test; it must stay green with 7 CASES + the exact-8 enumeration. |

The 3 SKILL.md files are pure data with **no importers this sprint**. Runtime behavior unchanged (nonGoals[2]).
Blast radius = the edited test file only.

### Existing Tests That Must Still Pass
- `src/orchestrator/security-knowledge/skill-files.test.ts` (sprint 3) — you are ADDING to it; the 4 existing
  cases (solidity/anchor/igaming/dex-backend) and the "never uses access-control" guard (`:114`) must stay green.
- `src/orchestrator/security-knowledge/parser.test.ts` — parses the generic file; unaffected (you touch no
  parser/format code). Confirm still green.
- `src/orchestrator/stack-knowledge.test.ts` / `security-audit-types` lockstep — the `ALL_VULN_CLASSES` ↔
  `VulnClass` union assertion. Do NOT touch the union; an authored vulnClass not in it drops only YOUR block while
  these tests stay green (hiding the bug) — the zero-drop assertion is what catches it.
- Full suite must stay green (sc-4-5). Baseline ~4045 (memory: security-audit team build).

### Features That Could Be Affected
- **bober.security-generic (sprint 2) + the 4 sprint-3 stacks** — share the parser + format. You change no shared
  code, so they remain green; the enumeration test now also asserts generic parses to >= 6.
- **STACK_SKILL_MAP / finder wiring (sprint 5, future)** — will consume these files; keep `signatureId`s stable
  and stack-prefixed (`node.*`, `payments.*`, `react.*`).

### Recommended Regression Checks (run after authoring)
1. `npx vitest run src/orchestrator/security-knowledge/` — parser.test.ts + skill-files.test.ts green; each new
   file at/above its min block count with **zero drops**; the exact-8 enumeration passes (audit excluded).
2. `npm run build` — TypeScript compiles (the test edit is the only TS touched).
3. `npm run typecheck` and `npm run lint` (sc-4-5).
4. Full suite: `npm test` — green, no regressions.

---

## 8. Implementation Sequence

Each SKILL.md is independent; the test depends on all three existing.

1. **skills/bober.security-node/SKILL.md** — frontmatter (Pattern A) + `## Signature Block Format` (copy igaming
   verbatim, Pattern B) + `## Signatures` with the 12 node blocks from Section 5.
   - Verify: every `- **VulnClass:**` value is one of the 17 union members (Section 3); no `access-control`.
2. **skills/bober.security-payments/SKILL.md** — same shell + the 10 payments blocks.
   - Verify: webhook-missing-hmac, missing-idempotency-key, duplicate-credit-webhook-replay,
     withdraw-different-method, missing-withdrawal-approval-threshold present; vulnClass ∈ union.
3. **skills/bober.security-react/SKILL.md** — same shell + the 7 react blocks (+ optional 8th).
   - Verify: dangerously-set-inner-html, secret-in-client-bundle, client-trusted-authz, postmessage-no-origin,
     prototype-pollution-deepmerge present; vulnClass ∈ union.
4. **src/orchestrator/security-knowledge/skill-files.test.ts** — add 3 `FileCase` entries + the exact-8
   enumeration test (Section 6, excluding `audit`).
   - Verify: `npx vitest run src/orchestrator/security-knowledge/skill-files.test.ts` green; zero-drop holds for
     all 3 new files; enumeration Set equals the 8 expected.
5. **Run full verification** — `npm run build`, `npm run typecheck`, `npm run lint`, `npm test`.

---

## 9. Pitfalls & Warnings

- **The `bober.security-audit` glob landmine (sc-4-5).** `skills/bober.security-audit/SKILL.md` EXISTS and matches
  `bober.security-*`, so the enumeration sees 9, not 8. The exact-8 test MUST exclude `audit` (Section 6). Forgetting
  this fails sc-4-5 with a set of 9 != 8. Also: `generic` IS one of the expected 8; do not exclude it.
- **`skills/bober.react` (framework skill) is NOT `skills/bober.security-react`.** nonGoals[3] forbids touching the
  framework skill. It has no `security-` prefix, so it does not match the glob — do not create your blocks there,
  and do not enumerate it.
- **`access-control` is NOT a VulnClass union member.** Every block using `**VulnClass:** access-control` is
  silently dropped → sprint fails. Use `idor-bola`, `authn-authz`, or `privilege-escalation`. The test at
  `skill-files.test.ts:114` explicitly asserts no signature uses it. This was the #1 failure in sprint 3.
- **Any line starting with `### ` splits a block** (`parser.ts:146`), INCLUDING inside a fenced code example. If a
  JS/TS example contains a markdown `###` at line-start (e.g. in a comment or template literal), the parser splits
  there and the real block drops. Keep all doc headings at `##`; keep examples free of leading `### `. JS `//`
  comments are safe; a `###` inside one is not.
- **Field labels are case- and spelling-sensitive** (`parser.ts:55`): exactly `Title`, `CWE`, `Severity`,
  `VulnClass`, `Invariant`, `Keywords`, each as `- **Label:** value`. A typo (`**Vuln Class:**`) → field not found
  → block drops on missing VulnClass.
- **A block needs BOTH `**Unsafe:**` and `**Safe:**` fenced blocks with a CLOSED fence** (`parser.ts:85`). Every
  ` ```ts ` must have a matching closing ` ``` `. An unclosed fence returns null → block drops.
- **Severity must be one of** `critical|high|medium|low|info` (`parser.ts:45`). `severe`/`major`/`crit` drop the block.
- **CWE is a free string, not validated.** `CWE-79`, `CWE-918`, `CWE-1321` accepted verbatim. Omit the whole
  `- **CWE:**` line for `cwe: null` (convention, `igaming:166` for a no-CWE block).
- **Frontmatter is mandatory and must open with `---`** or `parseFrontmatter` treats the whole file as body.
- **Do NOT edit** `parser.ts`, `signature.ts`, `security-audit-types.ts`, or `stack-knowledge.ts` — nonGoals[2]
  forbids runtime changes and the VulnClass union is frozen. This sprint is 3 markdown files + one test edit.
- **Zero-drop is the real bar**, not just ">= N". The existing test asserts `parsed.length === rawBlockCount` per
  file — a single malformed block (bad vulnClass, missing field, unclosed fence) fails the count-match even if you
  exceed the minimum. Author exactly the blocks you claim.
- **signatureId uniqueness within a file** — duplicate `### ` headings produce two records with the same id; the
  uniqueness assertion (`skill-files.test.ts:96`) fails. Keep ids distinct and stack-prefixed.
