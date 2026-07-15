# Sprint Briefing: Author the money/crypto security skill files (solidity, anchor, igaming, dex-backend)

**Contract:** sprint-spec-20260714-security-auditor-per-stack-skills-3
**Generated:** 2026-07-14T00:00:00Z

> This is a **content-authoring** sprint. Four new `SKILL.md` files (all `create`) authored as parseable
> signature blocks in the exact sprint-2 format, plus one new test file. No TypeScript runtime changes.
> The single highest-value part of this briefing is **Section 5 (per-stack signature content)** and the
> **`access-control` is NOT a VulnClass** warning in Sections 3 and 9. Read those twice.

---

## 1. Target Files

All four skill files are **create** (verified missing on disk). Each lives in its own directory
`skills/bober.security-<stack>/SKILL.md`. The test file is also **create**.

### skills/bober.security-solidity/SKILL.md (create) — >= 10 blocks
### skills/bober.security-anchor/SKILL.md (create) — >= 6 blocks
### skills/bober.security-igaming/SKILL.md (create) — >= 10 blocks
### skills/bober.security-dex-backend/SKILL.md (create) — >= 10 blocks

**Directory pattern:** each skill is a directory named `bober.<name>` containing a single `SKILL.md`
(confirmed: `skills/bober.security-generic/SKILL.md`, `skills/bober.security-audit/`, `skills/bober.solidity/`).
The generator must create the four new directories.

**Most similar existing file (the exact template to copy):** `skills/bober.security-generic/SKILL.md`
— same signature-library format, same parser, authored last sprint (22c8739). Copy its frontmatter shape,
its `## Signature Block Format` doc section, and its `## Signatures` block layout verbatim.

**stackId per file (used by the test's `parse()` call — must match `SecurityStackId` in `signature.ts:10-18`):**
- `skills/bober.security-solidity/SKILL.md` → `"solidity"`
- `skills/bober.security-anchor/SKILL.md` → `"anchor"`
- `skills/bober.security-igaming/SKILL.md` → `"igaming"`
- `skills/bober.security-dex-backend/SKILL.md` → `"dex-backend"`

### src/orchestrator/security-knowledge/skill-files.test.ts (create)

**Most similar existing file:** `src/orchestrator/security-knowledge/parser.test.ts` — copy its real-asset
pattern (readFile via `new URL(..., import.meta.url)` + `SecuritySignatureParser.parse`). See Section 6.

---

## 2. Patterns to Follow

### Pattern A — Frontmatter (copy verbatim, change name+description)
**Source:** `skills/bober.security-generic/SKILL.md`, lines 1-4
```md
---
name: bober.security-generic
description: "Generic OWASP/CWE security signature library shared across every stack-specific security skill. Not a workflow skill -- a data file of discrete vulnerable/safe code signature blocks read by SecuritySignatureParser. ..."
---
```
**Rule:** Each new file opens with a `---` fenced frontmatter block carrying `name: bober.security-<stack>`
and a one-line `description`. `parseFrontmatter` (`src/vault/frontmatter.ts:53`) strips this before the parser
splits on `### `; if the file does NOT begin with `---`, the whole file (including frontmatter) is treated as
body — so the opening `---` is mandatory and must have a closing `---`.

### Pattern B — The doc sections stay at level-2 (`##`), NEVER level-3 (`###`)
**Source:** `skills/bober.security-generic/SKILL.md`, lines 14-35 (`## Signature Block Format`) and line 36 (`## Signatures`)
```md
## Signature Block Format

Each signature is a level-3 heading (three `#` characters, a space, then the
`signatureId`) followed by labelled fields and two fenced code examples...

Required fields per block:
- The heading text itself is the `signatureId` (must be non-empty).
- `- **Title:** <human-readable title>`
- `- **CWE:** CWE-xx` (optional — omit the line entirely for `cwe: null`)
- `- **Severity:** critical|high|medium|low|info`
- `- **VulnClass:** <a VulnClass union member, verbatim>`
- `- **Invariant:** <the safety invariant this signature protects>`
- `- **Keywords:** comma, separated, keywords`

## Signatures
```
**Rule:** The parser splits the WHOLE post-frontmatter body on `/^### /m` (`parser.ts:146`). Any line that
starts with `### ` — in prose, in a doc heading, OR inside a fenced code example — starts a new "block". Keep
every doc heading at `##`. Never let a code example contain a line beginning with `### `. (You can reuse the
generic file's `## Signature Block Format` section text verbatim; it contains no `### ` line.)

### Pattern C — A single signature block (this is the unit you author 40+ times)
**Source:** `skills/bober.security-generic/SKILL.md`, lines 38-53 (the `sql-injection` block)
```md
### sql-injection
- **Title:** SQL injection via string concatenation
- **CWE:** CWE-89
- **Severity:** critical
- **VulnClass:** injection
- **Invariant:** User-controlled values never reach a SQL statement as raw string content — always via a parameterized placeholder.
- **Keywords:** sql, query, concat, raw, template-literal

**Unsafe:**
```ts
const rows = await db.query(`SELECT * FROM users WHERE id = ${req.query.id}`);
```

**Safe:**
```ts
const rows = await db.query("SELECT * FROM users WHERE id = $1", [req.query.id]);
```
```
**Rule:** heading = `### <signatureId>`; then the six labelled `- **Field:**` lines (CWE optional); then
`**Unsafe:**` + a fenced ` ```ts ` block; then `**Safe:**` + a fenced ` ```ts ` block. A block missing Title,
a **valid** VulnClass, a valid Severity, or a non-empty Unsafe/Safe fenced example is **silently dropped**
(`parser.ts:100-113`). Dropped block = failed sprint. The fence language can be anything (` ```ts `, ` ```solidity `,
` ```rust `) — the parser only looks for ` ``` ` (`parser.ts:71-88`) — but use ` ```ts ` to match the generic file
and avoid surprises.

### Pattern D — Field label regex (author labels EXACTLY, case-sensitive)
**Source:** `parser.ts:55`
```ts
const LABEL_RE = /^-\s+\*\*(Title|CWE|Severity|VulnClass|Invariant|Keywords):\*\*\s*(.*)$/;
```
**Rule:** Labels must be exactly `Title`, `CWE`, `Severity`, `VulnClass`, `Invariant`, `Keywords`
(capitalized as shown), each as `- **Label:** value`. `**VulnClass:**` not `**Vuln Class:**`,
`**vulnclass:**`, or `**Class:**`. The line is `trim()`-ed before matching, so leading indentation is fine.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `SecuritySignatureParser.parse` | `src/orchestrator/security-knowledge/parser.ts:142` | `(stackId: SecurityStackId, skillMarkdown: string, skillRelPath: string): SecuritySignature[]` | The ONLY consumer of the files you author. Pure, total, never throws, drops malformed blocks. Use it in the test. |
| `ALL_VULN_CLASSES` | `src/orchestrator/stack-knowledge.ts:40` | `VulnClass[]` (17 members) | The allowlist every `VulnClass` field is validated against. Import it in the test to assert membership. |
| `isVulnClass` (internal) | `src/orchestrator/security-knowledge/parser.ts:41` | `(value: string) => value is VulnClass` | How the parser validates `**VulnClass:**` — an authored value not in `ALL_VULN_CLASSES` drops the block. |
| `parseFrontmatter` | `src/vault/frontmatter.ts:53` | `(raw: string) => { frontmatter, body }` | Strips the `---...---` header before the parser splits on `### `. Explains why the opening `---` is mandatory. |
| `SecuritySignature` (type) | `src/orchestrator/security-knowledge/signature.ts:27` | interface | The record shape the parser emits (`stackId, signatureId, title, cwe, severity, vulnClass, invariant, unsafeExample, safeExample, keywords, skillRef`). |
| `SecurityStackId` (type) | `src/orchestrator/security-knowledge/signature.ts:10` | union | The 8 legal stack ids incl. `"solidity" "anchor" "igaming" "dex-backend"`. |

**Utilities reviewed:** `src/orchestrator/security-knowledge/` (parser, signature), `src/orchestrator/`
(security-audit-types, stack-knowledge), `src/vault/frontmatter.ts`. No new utility is needed — this sprint
is pure markdown authoring + one test that reuses `SecuritySignatureParser.parse`.

### CRITICAL — the exact VulnClass union (verbatim members, `security-audit-types.ts:9-26`)
```
injection · authn-authz · secret-handling · input-validation · path-traversal ·
privilege-escalation · race-condition · money-integrity · ssrf · xss ·
insecure-randomness · crypto-weakness · deserialization · supply-chain ·
idor-bola · denial-of-service · audit-logging
```
**`access-control` is NOT a member.** The contract's description and sc-3-2 text literally say
`vulnClass 'access-control'` — **that is wrong and will drop every block that uses it.** For on-chain and
Anchor access-control issues (missing `onlyOwner`, missing account constraints, missing signer check, unchecked
loader), use **`authn-authz`** (missing/incorrect authentication-authorization) or **`privilege-escalation`**
(CPI to unverified program, unprotected initializer that hands over ownership). Never write `access-control`.

---

## 4. Prior Sprint Output

### Sprint 2 (commit 22c8739): SecuritySignatureParser + bober.security-generic
**Created:** `src/orchestrator/security-knowledge/parser.ts` (exports `SecuritySignatureParser`),
`src/orchestrator/security-knowledge/signature.ts` (exports `SecuritySignature`, `SecurityStackId`),
`src/orchestrator/security-knowledge/parser.test.ts`, and `skills/bober.security-generic/SKILL.md` (14 blocks).
**Connection to this sprint:** the four new files are authored in the **identical** format the generic file
established and are parsed by the **same** `SecuritySignatureParser.parse`. Copy the generic file's structure;
do not invent a new format. The `VulnClass`/`Severity` validation and the `### ` split are frozen by sprint 1/2.

---

## 5. Signature Content Per Stack (research-sourced — the authoring worksheet)

Content sourced from `.bober/research/research-20260714-security-auditor-pentest-deep-upgrade-research.md`
Section B (iGaming, lines 153-162) + Section C (DEX/crypto on+off-chain, lines 164-168), and the existing
`skills/bober.solidity/SKILL.md` `## Security Checklist` (lines 399-412). Every `VulnClass` below is a verified
union member. `cwe` uses SWC-/CWE- ids where a clean one applies; where the cell says `(omit)`, omit the
`- **CWE:**` line entirely (yields `cwe: null`). Severity: direct-fund-loss → `critical`, else `high`.
Keywords are retrieval tokens for sprint 5. The unsafe/safe columns are *ideas* — author a minimal `ts`
example for each (short: grounding, not a tutorial).

### solidity (author >= 10; 12 listed — SWC ids from research Section C)
| signatureId | Title | cwe | vulnClass | unsafe → safe idea | keywords |
|---|---|---|---|---|---|
| solidity.reentrancy-single-function | Single-function reentrancy: external call before state update | SWC-107 | race-condition | `call{value}` then `balances[x]=0` → checks-effects-interactions / `nonReentrant` | reentrancy, call, checks-effects-interactions, nonReentrant |
| solidity.reentrancy-readonly | Read-only reentrancy via view during callback | SWC-107 | race-condition | `getReserves()` read mid-callback returns stale price → reentrancy lock / update-before-callback | read-only reentrancy, view, getReserves |
| solidity.spot-price-oracle-flashloan | Spot AMM price used as oracle (flash-loan manipulable) | (omit) | money-integrity | `pair.getReserves()` as price → Chainlink/TWAP + staleness check | oracle, spot price, getReserves, TWAP, flash loan |
| solidity.missing-onlyowner | Missing onlyOwner/role on privileged function | SWC-105 | authn-authz | `function setFee()` public no modifier → `onlyOwner` / AccessControl role | onlyOwner, AccessControl, modifier, privileged |
| solidity.unprotected-initializer | Unprotected initializer / uninitialized proxy (Parity) | CWE-665 | privilege-escalation | `initialize()` callable by anyone → `initializer` modifier + `_disableInitializers()` in ctor | initializer, initialize, proxy, _disableInitializers |
| solidity.unchecked-arithmetic | unchecked{} block underflows a balance | SWC-101 | money-integrity | `unchecked { balance -= amt; }` → drop unchecked / require amt<=balance | unchecked, overflow, underflow, arithmetic |
| solidity.erc4626-inflation | ERC-4626 first-depositor / share-inflation attack | (omit) | money-integrity | shares from empty vault, attacker donates → virtual shares offset / dead-share burn | ERC4626, first depositor, inflation, virtual shares |
| solidity.unsafe-erc20 | Unsafe ERC20 (no SafeERC20 / fee-on-transfer / rebasing) | SWC-104 | money-integrity | `token.transfer(...)` return ignored / assumes amount received → SafeERC20 + measured balance delta | transfer, SafeERC20, fee-on-transfer, rebasing, return value |
| solidity.txorigin-auth | tx.origin used for authorization (phishable) | SWC-115 | authn-authz | `require(tx.origin==owner)` → `require(msg.sender==owner)` | tx.origin, msg.sender, phishing |
| solidity.missing-slippage-deadline | Swap missing amountOutMin / deadline (sandwich) | (omit) | money-integrity | `swap(...,0,block.timestamp)` → caller-supplied amountOutMin + real deadline | amountOutMin, deadline, slippage, swap, sandwich |
| solidity.dos-unbounded-loop | DoS via unbounded loop over growable array | SWC-128 | denial-of-service | `for` over all holders in one tx → pull-over-push / pagination | unbounded loop, gas limit, pull-over-push, DoS |
| solidity.signature-replay | Missing nonce/chainId/EIP-712 domain; ecrecover==0 malleability | SWC-117 | crypto-weakness | `ecrecover(hash,v,r,s)` no domain/nonce → EIP-712 typed data + nonce + `signer!=address(0)` | ecrecover, nonce, chainId, EIP-712, replay, malleability |

### anchor (author >= 6; 7 listed — Wormhole $326M = unchecked loader, research Section C line 166)
| signatureId | Title | cwe | vulnClass | unsafe → safe idea | keywords |
|---|---|---|---|---|---|
| anchor.missing-account-constraints | Missing has_one/owner/is_writable account constraints | CWE-862 | authn-authz | bare `AccountInfo` no constraint → `#[account(mut, has_one = authority)]` typed `Account<'info,T>` | has_one, Account, constraint, owner, mut |
| anchor.unchecked-sysvar-loader | Deprecated unchecked sysvar/instruction loader (Wormhole $326M) | CWE-345 | authn-authz | `load_instruction_at(...)` → `load_instruction_at_checked(...)` / `Sysvar` type | load_instruction_at, load_instruction_at_checked, sysvar, instructions |
| anchor.missing-signer-check | Missing is_signer / Signer authority check | CWE-862 | authn-authz | `authority: AccountInfo` no signer check → `authority: Signer<'info>` / `has_one` | is_signer, Signer, authority, AccountInfo |
| anchor.pda-seed-collision | PDA seed collision / non-unique seeds | (omit) | authn-authz | seeds `[b"vault"]` shared across users → include user pubkey in seeds + bump | seeds, PDA, find_program_address, bump, collision |
| anchor.init-if-needed-reinit | init_if_needed re-initialization overwrite | (omit) | race-condition | `#[account(init_if_needed)]` re-inits state → `init` once / guard already-initialized | init_if_needed, init, reinit, overwrite |
| anchor.cpi-unverified-program | CPI to an unverified program id | CWE-345 | privilege-escalation | `invoke` to caller-passed program → assert `program.key() == token::ID` | CPI, invoke, program_id, cross-program, token::ID |
| anchor.missing-owner-check | Missing account owner check (arbitrary account substitution) | CWE-862 | authn-authz | reads `AccountInfo` data without owner assert → `#[account(owner = crate::ID)]` / typed account | owner, AccountInfo, substitution, arbitrary |

### igaming (author >= 10; 12 listed — research Section B lines 153-162)
| signatureId | Title | cwe | vulnClass | unsafe → safe idea | keywords |
|---|---|---|---|---|---|
| igaming.toctou-balance-double-spend | TOCTOU balance double-spend (read-check-write, no lock) | CWE-362 | race-condition | `SELECT bal; if(bal>=amt) UPDATE` → `UPDATE SET bal=bal-:amt WHERE bal>=:amt` / SELECT FOR UPDATE | balance, FOR UPDATE, TOCTOU, double-spend, atomic |
| igaming.non-atomic-idempotency | Missing/non-atomic idempotency key on deposit/settlement | CWE-362 | race-condition | check-then-insert not atomic → unique idempotency key + upsert on conflict | idempotency, idempotency-key, settlement, unique, upsert |
| igaming.client-supplied-odds | Trusting client-supplied odds/price at bet acceptance | CWE-602 | money-integrity | `payout = req.body.odds * stake` → re-resolve selectionId→server price at acceptance | odds, price, selectionId, payout, re-resolve |
| igaming.negative-zero-stake | Negative/zero stake inverts debit to credit | CWE-20 | money-integrity | `debit(stake)` with `stake<0` → require integer `stake > 0` | stake, negative, amount, validation, <= 0 |
| igaming.float-money | Float money instead of integer minor units / Decimal | CWE-681 | money-integrity | `balance += 0.1` float drift → integer minor units (cents) / Decimal | float, Number, minor units, Decimal, rounding, cents |
| igaming.missing-webhook-hmac | Missing/incorrect provider webhook HMAC + timestamp | CWE-345 | authn-authz | trust webhook body unsigned → `timingSafeEqual(hmac(raw-body), sig)` + signed timestamp | webhook, HMAC, timingSafeEqual, raw-body, timestamp |
| igaming.seamless-wallet-orphan-rollback | Orphan / replayed seamless-wallet rollback credit | (omit) | money-integrity | rollback credits with no matching debit / replayable → composite (providerId,roundId,txId,txType) unique + require matching debit | seamless wallet, rollback, orphan, roundId, txId, dedup |
| igaming.non-csprng-outcome | Math.random() for game outcome (fails GLI-19) | CWE-338 | insecure-randomness | `Math.random()` picks outcome → CSPRNG ≥256-bit seed / certified RNG | Math.random, RNG, CSPRNG, outcome, seed, GLI-19 |
| igaming.client-side-outcome | Client-determined outcome trusted by server | CWE-602 | authn-authz | server accepts `req.body.result` → server computes authoritative outcome | client-side, outcome, server-authoritative, trust boundary |
| igaming.limits-client-only | Deposit-limit / self-exclusion enforced client-side only | CWE-602 | authn-authz | limit checked in UI only → enforce limit/self-exclusion server-side per request | deposit limit, self-exclusion, KYC, client-side, GAMSTOP |
| igaming.bonus-wagering-abuse | Bonus / wagering-requirement bypass (multi-account, self-referral) | CWE-841 | money-integrity | withdraw bonus before wagering met → enforce wagering-requirement + multi-account/self-referral checks | bonus, wagering requirement, multi-account, self-referral |
| igaming.settlement-replay | Replayed settlement/payout webhook without provider-event dedup | (omit) | money-integrity | same settlement processed twice → dedup on provider event id (unique) | settlement, replay, dedup, provider-event, unique |

### dex-backend (author >= 10; 12 listed — research Section C lines 164-168; "off-chain is where most exchange money is stolen")
| signatureId | Title | cwe | vulnClass | unsafe → safe idea | keywords |
|---|---|---|---|---|---|
| dex.withdrawal-toctou-race | Withdrawal TOCTOU race (SELECT-compare-UPDATE, no row lock) | CWE-362 | race-condition | `SELECT bal; UPDATE bal-amt` → `UPDATE SET bal=bal-:amt WHERE bal>=:amt` / SELECT FOR UPDATE | withdrawal, FOR UPDATE, row lock, TOCTOU, balance |
| dex.missing-withdrawal-idempotency | Missing withdrawal idempotency key (double-withdraw on retry) | CWE-362 | race-condition | retried request withdraws twice → unique client idempotency key | idempotency, withdrawal, unique, retry, double-withdraw |
| dex.missing-2fa-cooldown | Missing 2FA / withdrawal-whitelist cooldown (Crypto.com) | (omit) | authn-authz | withdraw to new address instantly → 2FA + address-book cooldown/allowlist | 2FA, withdrawal whitelist, cooldown, allowlist, address-book |
| dex.deposit-no-confirmations | Deposit credited off event-log/webhook w/o outer-tx-success + balanceOf delta + confirmations | CWE-345 | money-integrity | credit on log event alone → require `receipt.status==1` + balanceOf delta + N confirmations | deposit, confirmations, balanceOf, reorg, receipt.status |
| dex.token-decimals-mismatch | Token decimals mismatch (WBTC=8, USDC=6 vs 18) | CWE-682 | money-integrity | assume 18 decimals for USDC → read token.decimals() / parseUnits with correct decimals | decimals, WBTC, USDC, parseUnits, 10^18 |
| dex.float-token-amounts | Float/Number token amounts instead of BigInt | CWE-681 | money-integrity | `amount = Number(wei)` precision loss → BigInt end-to-end | BigInt, Number, float, wei, precision |
| dex.hot-wallet-key-in-env | Hot-wallet private key in env/config/repo | CWE-798 | secret-handling | `PRIVATE_KEY` in .env / source → KMS/HSM-held key, never extractable | private key, PRIVATE_KEY, hot wallet, env, mnemonic, seed phrase |
| dex.kms-signer-no-authz-gate | KMS/HSM signer with no policy/authz gate in front | CWE-862 | authn-authz | any caller can invoke KMS `sign` → policy gate (amount/dest/rate) before signer | KMS, HSM, signer, policy gate, authorization, sign |
| dex.siwe-replay | SIWE/EIP-4361 recover-but-skip-domain/nonce/chainId (replay) | CWE-294 | crypto-weakness | `verifyMessage(sig)` ignores nonce/domain/chainId → validate single-use nonce + domain + chainId + expiry | SIWE, EIP-4361, nonce, domain, chainId, verifyMessage, replay |
| dex.missing-price-circuit-breaker | Missing circuit breaker / sanity bound on price feed | (omit) | money-integrity | use RPC/feed price unbounded → deviation bound + staleness + pause | circuit breaker, price feed, oracle, RPC, sanity, staleness |
| dex.webhook-no-signature | Provider/chain webhook accepted without signature verification | CWE-345 | authn-authz | process webhook body unsigned → verify HMAC/provider signature first | webhook, signature, HMAC, provider callback, verify |
| dex.unvalidated-withdrawal-amount | Negative/zero/oversized withdrawal amount not validated | CWE-20 | money-integrity | `withdraw(req.body.amount)` no bound → require integer `0 < amount <= balance` | amount, negative, validation, balance check, withdrawal |

**Optional solidity extras (already in `skills/bober.solidity/SKILL.md:399-412`, may cite):** storage-collision in
upgradeable proxies (SWC-... / ERC-7201), centralization/single-admin-key. The non-goal forbids copying that
checklist *verbatim* — author these as fresh signature blocks if you want to exceed 10.

---

## 6. Testing Patterns

### Unit Test Pattern (the model to copy)
**Source:** `src/orchestrator/security-knowledge/parser.test.ts:8-33`
```ts
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { SecuritySignatureParser } from "./parser.js";
import { ALL_VULN_CLASSES } from "../stack-knowledge.js";

describe("SecuritySignatureParser — real generic skill file", () => {
  it("parses skills/bober.security-generic/SKILL.md into >=12 well-formed signatures", async () => {
    const md = await readFile(
      new URL("../../../skills/bober.security-generic/SKILL.md", import.meta.url),
      "utf-8",
    );
    const signatures = SecuritySignatureParser.parse("generic", md, "skills/bober.security-generic/SKILL.md");
    expect(signatures.length).toBeGreaterThanOrEqual(12);
    for (const signature of signatures) {
      expect(ALL_VULN_CLASSES).toContain(signature.vulnClass);
      expect(["critical", "high", "medium", "low", "info"]).toContain(signature.severity);
      expect(signature.unsafeExample.trim()).not.toBe("");
      expect(signature.safeExample.trim()).not.toBe("");
    }
  });
});
```
**Runner:** vitest. **Assertion style:** `expect(...)`. **Mock approach:** none — real-asset test reads the
actual file. **File naming:** co-located `*.test.ts` next to source. **Location:** `src/orchestrator/security-knowledge/`.

### What skill-files.test.ts MUST assert (per sc-3-5 + evaluatorNotes)
Author it as a table over the four files. For EACH file:
1. `readFile(new URL("../../../skills/bober.security-<stack>/SKILL.md", import.meta.url), "utf-8")`.
2. `const sigs = SecuritySignatureParser.parse("<stackId>", md, "skills/bober.security-<stack>/SKILL.md")`.
3. `expect(sigs.length).toBeGreaterThanOrEqual(<10|6|10|10>)`.
4. **ZERO dropped blocks** — the load-bearing assertion. Count raw `### ` headings and compare to parsed count:
```ts
import { parseFrontmatter } from "../../vault/frontmatter.js";
const rawBlockCount = parseFrontmatter(md).body.split(/^### /m).length - 1;
expect(sigs.length).toBe(rawBlockCount); // every authored block parsed; nothing silently dropped
```
5. Per signature: `expect(ALL_VULN_CLASSES).toContain(s.vulnClass)`, valid severity, non-empty unsafe/safe,
   `expect(s.stackId).toBe("<stackId>")`, `expect(s.skillRef).toBe("skills/bober.security-<stack>/SKILL.md")`.
6. Spot-check money-loss ids present (evaluatorNotes): assert the id set includes e.g.
   `igaming.toctou-balance-double-spend`, `igaming.client-supplied-odds`, `dex.withdrawal-toctou-race`,
   `dex.token-decimals-mismatch`, `dex.hot-wallet-key-in-env` (or grep their keywords).
7. Assert `signatureId` uniqueness per file (mirror `parser.test.ts:35-43`): `expect(new Set(ids).size).toBe(ids.length)`.

No E2E/Playwright applies to this sprint.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| (none) | the 4 new SKILL.md files | low | Nothing imports these yet — the index/selector/finder wiring is sprint 5 (nonGoals). These files are inert data until then. |
| `src/orchestrator/security-knowledge/skill-files.test.ts` | the 4 new SKILL.md + `parser.ts` + `stack-knowledge.ts` | n/a | New test; must pass. |

The four SKILL.md files are pure data with **no importers this sprint** — the selector/registry that reads them
is explicitly deferred (nonGoals[2], outOfScope). Runtime behavior is unchanged (nonGoals[4]). Blast radius is
the new test file only.

### Existing Tests That Must Still Pass
- `src/orchestrator/security-knowledge/parser.test.ts` — parses the generic file; unaffected, but confirm it
  still passes (you are adding a sibling test, not editing the parser).
- `src/orchestrator/stack-knowledge` / `security-audit-types` lockstep tests — the `ALL_VULN_CLASSES` ↔
  `VulnClass` union assertion (referenced at `stack-knowledge.ts:38`, `:204`). Do NOT touch the union; if you
  author a `vulnClass` value not in it, only YOUR block drops — the union tests stay green and hide the bug.
- Full suite must stay green (sc-3-5). Prior suite baseline ~4045 (memory: security-audit team build).

### Features That Could Be Affected
- **bober.security-generic (sprint 2)** — shares the parser + format. Your new files must not change the parser;
  verify the generic file still parses to >=12 (its test) after your changes (it will — you touch no shared code).
- **STACK_SKILL_MAP / finder wiring (sprint 5, future)** — will consume these files; keep `signatureId`s stable
  and stack-prefixed (`solidity.*`, `anchor.*`, `igaming.*`, `dex.*`) so sprint 5 retrieval is clean.

### Recommended Regression Checks (run after authoring)
1. `npm run build` — TypeScript compiles (the new test is the only TS added).
2. `npx vitest run src/orchestrator/security-knowledge/` — parser.test.ts + skill-files.test.ts both green,
   each file at/above its min block count with zero drops.
3. `npm run typecheck` and `npm run lint` (sc-3-5).
4. Full suite: `npm test` (or the repo's configured runner) — green, no regressions.

---

## 8. Implementation Sequence

Author files in dependency order (each SKILL.md is independent; the test depends on all four existing):

1. **skills/bober.security-solidity/SKILL.md** — frontmatter (Pattern A) + `## Signature Block Format`
   (copy generic verbatim, Pattern B) + `## Signatures` with the 12 solidity blocks from Section 5.
   - Verify: manually confirm every `- **VulnClass:**` value is one of the 17 union members; no `access-control`.
2. **skills/bober.security-anchor/SKILL.md** — same shell + the 7 anchor blocks.
   - Verify: unchecked-sysvar-loader + missing-signer + missing-account-constraints present; vulnClass ∈ union.
3. **skills/bober.security-igaming/SKILL.md** — same shell + the 12 igaming blocks.
   - Verify: toctou-balance-double-spend, client-supplied-odds, non-csprng-outcome, bonus-wagering present.
4. **skills/bober.security-dex-backend/SKILL.md** — same shell + the 12 dex blocks.
   - Verify: withdrawal-toctou-race, token-decimals-mismatch, hot-wallet-key-in-env, siwe-replay present.
5. **src/orchestrator/security-knowledge/skill-files.test.ts** — the four-file table test (Section 6).
   - Verify: `npx vitest run src/orchestrator/security-knowledge/skill-files.test.ts` green; zero-drop assertion
     (`sigs.length === rawBlockCount`) holds for all four.
6. **Run full verification** — `npm run build`, `npm run typecheck`, `npm run lint`, `npm test`.

---

## 9. Pitfalls & Warnings

- **`access-control` is NOT a VulnClass union member.** The contract text says it; the code (`security-audit-types.ts:9-26`)
  disagrees, and the code wins. Every block using `**VulnClass:** access-control` is silently dropped → sprint fails.
  Use `authn-authz` or `privilege-escalation`. This is the #1 predicted failure cause — audit every VulnClass line.
- **Any line starting with `### ` splits a block** (`parser.ts:146`, `body.split(/^### /m)`). This includes lines
  INSIDE a fenced code example. If a solidity/rust example has a line beginning `### `, the parser splits there,
  the real block loses its Safe example, and it drops. Keep doc headings at `##`; keep examples free of leading `### `.
  (Solidity `//` comments and Rust `//` comments are safe; markdown `###` in a comment is not.)
- **Field labels are case- and spelling-sensitive** (`parser.ts:55`): exactly `Title`, `CWE`, `Severity`,
  `VulnClass`, `Invariant`, `Keywords`, each as `- **Label:** value`. A typo (`**Vuln Class:**`) means the field
  is not found → block drops on missing VulnClass.
- **A block needs BOTH `**Unsafe:**` and `**Safe:**` fenced blocks with a CLOSED fence.** An unclosed ``` fence
  returns null (`parser.ts:85`) → block drops. Every ` ```ts ` must have a matching closing ` ``` `.
- **Severity must be one of** `critical|high|medium|low|info` (`parser.ts:45`). `severe`, `major`, `crit` all drop the block.
- **CWE is a free string, not validated.** `SWC-107`, `CWE-362`, `CWE-798` are all accepted verbatim. Omit the
  whole `- **CWE:**` line for `cwe: null` — do NOT write `- **CWE:**` with an empty value expecting null (an
  empty value yields `cwe: null` too, but omitting the line is the documented convention, `generic:23`).
- **Frontmatter is mandatory and must open with `---`.** If the file starts with anything else, `parseFrontmatter`
  treats the whole file as body and your frontmatter lines become garbage prose (harmless to the split, but wrong).
- **Do NOT edit** `parser.ts`, `signature.ts`, `security-audit-types.ts`, or `stack-knowledge.ts` — nonGoals[4]
  forbids runtime changes and the VulnClass union is frozen by sprint 1. This sprint is markdown + one test only.
- **Do NOT copy `skills/bober.solidity/SKILL.md`'s `## Security Checklist` verbatim** (nonGoals[2]) — author fresh
  signature blocks; you may cite it as provenance.
- **Zero-drop is the real bar**, not just ">= N". Author exactly the blocks you claim and make the test assert
  `parsed.length === rawBlockCount`. If you add a 13th malformed block, the count-match assertion catches it.
- **signatureId uniqueness within a file** — duplicate `### ` headings produce two records with the same id; the
  uniqueness assertion (Section 6 step 7) will fail. Keep ids distinct and stack-prefixed.
