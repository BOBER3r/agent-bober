# Security benchmark corpus (`manifest.json`)

A small, **labelled**, **grounded** corpus of vulnerable/safe code fixtures used by
`../harness.ts` (`measure()`) and `../harness.test.ts` to make detection quality
**measured, not asserted** (architecture success criterion #3,
`spec-20260714-security-auditor-per-stack-skills`, sprint 9).

## Why inline JSON, not `.ts`/`.js` fixture files

`npm run build` (`tsc`) compiles everything under `src/**/*` and `npm run lint`
(`eslint src/**/*.ts`) lints it. Several of these fixtures are *intentionally*
vulnerable (SQL built by string interpolation, `exec()` with a shell string,
`fetch()` with no SSRF guard, a JWT verify that accepts `alg: "none"`, ...). If those
snippets existed as real `.ts` files under `src/`, they would fail typecheck/lint and
break `npm run build`/`npm run lint` (sc-9-5). So every snippet is an **inline string**
in the `code` field of a `BenchmarkCase` entry here — JSON is data, never
compiled or linted.

## Label schema

Each entry in the top-level array is:

```ts
interface BenchmarkCase {
  id: string;                     // stable, unique within the corpus
  expected: "vulnerable" | "safe";
  stack: SecurityStackId;         // "igaming" | "dex-backend" | "node" | ... (signature.ts)
  signatureId?: string;           // only for expected:"vulnerable"; omitted for scanner-only classes
  vulnClass?: VulnClass;          // only for expected:"vulnerable"
  code: string;                   // the illustrative snippet, inline — never a file reference
}
```

`expected:"safe"` entries carry no `signatureId`/`vulnClass` — the label-grounding
test only cross-checks vulnerable cases.

## Grounding

Every `expected:"vulnerable"` fixture's `code` is drawn **verbatim** from a shipped
`skills/bober.security-*/SKILL.md` signature's `**Unsafe:**`/`**Safe:**` block, and its
`signatureId`+`vulnClass` are cross-checked in `harness.test.ts` against the parsed
`SecurityKnowledgeIndex` (the same index the real auditor uses). This is what "grounded"
means: the corpus is not arbitrary code, it is a direct, verifiable materialization of
the knowledge the security-auditor agent team already ships.

**One exception:** the supply-chain class (`vuln-supplychain-postinstall`) has **no
shipped skill signature** — `vulnClass: "supply-chain"` findings are emitted by the
deterministic scanner (`../supply-chain-inspector.ts`), not by an LLM auditor reading a
skill file. That fixture omits `signatureId` entirely and is instead grounded against
the `ALL_VULN_CLASSES` runtime union (`../../stack-knowledge.ts`) — the label-grounding
test has two arms for exactly this reason.

## Class coverage (13 vulnerable / 13 safe pairs)

| Class | Vulnerable case ids | Signature |
|---|---|---|
| iGaming money-integrity (TOCTOU) | `vuln-igaming-toctou` | `igaming.toctou-balance-double-spend` |
| iGaming money-integrity (client-odds) | `vuln-igaming-client-odds` | `igaming.client-supplied-odds` |
| iGaming money-integrity (negative stake) | `vuln-igaming-negative-stake` | `igaming.negative-zero-stake` |
| dex-backend (withdrawal race) | `vuln-dex-withdrawal-race` | `dex.withdrawal-toctou-race` |
| dex-backend (decimals) | `vuln-dex-decimals` | `dex.token-decimals-mismatch` |
| dex-backend (hot-wallet key) | `vuln-dex-hotwallet-key` | `dex.hot-wallet-key-in-env` |
| dex-backend (withdrawal amount) | `vuln-dex-withdrawal-amount` | `dex.unvalidated-withdrawal-amount` |
| injection (SQLi) | `vuln-node-sqli` | `node.sql-injection` |
| injection (command) | `vuln-node-command-injection` | `node.command-injection` |
| injection/ssrf (SSRF) | `vuln-node-ssrf` | `node.ssrf-outbound-fetch` |
| access-control (BOLA) | `vuln-node-bola` | `node.bola-missing-ownership` |
| authn-authz (JWT alg:none) | `vuln-node-jwt-alg-none` | `node.jwt-alg-none` |
| supply-chain (malicious postinstall) | `vuln-supplychain-postinstall` | *(none — scanner-emitted)* |

This is a **small, representative** set (nonGoals: "do not author an exhaustive
corpus"), not exhaustive coverage of every shipped signature.

## The offline (CI) path

`harness.test.ts`'s required tests drive `measure()` with **injected deterministic
fakes** (`finderFake`/`verifierFake`) — no LLM call, no network, no `Math.random`, no
`new Date()`. This is the only path CI runs. `npm test` / `npx vitest run` exercises it
directly; no environment variable or provider key is needed.

## The optional local real-provider run (not run in CI)

`harness.test.ts` has a `describe.skip(...)` block documenting how a future local run
could wire the real `runSecurityAudit` (`../../security-auditor-agent.ts`) and
`runSecurityVerifier` (`../../security-verifier-agent.ts`) into `FinderFn`/`VerifierFn`
closures instead of the fakes, by adapting each `BenchmarkCase.code` into a minimal
`AuditDiff` (one changed file, one hunk containing `code`) and reading
`review.critical.length > 0` as the finder verdict / `VerifierResult.dropped` as a
verifier downgrade. This requires a configured LLM provider API key
(`bober.config.json` provider config) and is **never** un-skipped in this repo — it is
here purely as a documented seam for a manual, ad hoc measurement run against a live
model, per contract assumption "the real runSecurityAudit/runSecurityVerifier satisfy
those [injectable] shapes."
