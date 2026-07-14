# Money/crypto per-stack security skill files: solidity, anchor, igaming, dex-backend

**Contract:** sprint-spec-20260714-security-auditor-per-stack-skills-3  ·  **Spec:** spec-20260714-security-auditor-per-stack-skills  ·  **Completed:** 2026-07-14

## What this sprint added

The four highest-value per-stack **security signature libraries** — the money-handling stacks the customer cares about most — authored in the sprint-2 block format and sourced from `research-20260714`. Each is a `skills/bober.security-<stack>/SKILL.md` data file (not a workflow skill) of discrete labelled vulnerable/safe signature blocks that `SecuritySignatureParser.parse()` turns into typed `SecuritySignature[]` records:

- **`bober.security-solidity`** — 12 on-chain EVM contract signatures (reentrancy, spot-price oracle manipulation, access control, initializers, unchecked arithmetic, ERC-4626 inflation, unsafe ERC20, `tx.origin`, slippage/deadline, DoS loops, signature replay).
- **`bober.security-anchor`** — 7 Solana/Anchor program signatures (account constraints, the unchecked-sysvar-loader class that was the Wormhole root cause, signer/owner checks, PDA seed collisions, `init_if_needed` re-init, unverified CPI).
- **`bober.security-igaming`** — 12 iGaming/betting-backend signatures (TOCTOU balance double-spend, idempotency, client-supplied odds, negative stake, float money, webhook HMAC, seamless-wallet rollback abuse, non-CSPRNG outcomes, client-side outcome trust, client-only limits, bonus/wagering abuse, settlement replay).
- **`bober.security-dex-backend`** — 12 crypto-exchange **off-chain** custody/backend signatures (withdrawal TOCTOU race, withdrawal idempotency, 2FA/whitelist cooldown, deposit confirmations, token decimals, float token amounts, hot-wallet key custody, KMS-signer authz gate, SIWE replay, price circuit breaker, unsigned webhook, unvalidated amount).

Content is **research-sourced, not invented**: signatures reference real exploit classes (the Wormhole $326M unchecked-sysvar-loader, the Crypto.com 2FA-bypass withdrawal class, GLI-19 RNG certification for iGaming outcomes). Nothing is wired into `runSecurityAudit` yet — like the sprint-2 generic library, these files are dormant data plumbing that the sprint-5 index/selector will consume.

## Public surface

These are **data files**, not code — their "public surface" is the set of stable `signatureId`s each file exposes to the parser (retrieval keys the sprint-5 selector will match against).

- `skills/bober.security-solidity/SKILL.md` — **12** blocks: `solidity.reentrancy-single-function`, `solidity.reentrancy-readonly`, `solidity.spot-price-oracle-flashloan` (`:87`), `solidity.missing-onlyowner`, `solidity.unprotected-initializer`, `solidity.unchecked-arithmetic`, `solidity.erc4626-inflation` (`:173`), `solidity.unsafe-erc20`, `solidity.txorigin-auth`, `solidity.missing-slippage-deadline`, `solidity.dos-unbounded-loop`, `solidity.signature-replay`.
- `skills/bober.security-anchor/SKILL.md` — **7** blocks: `anchor.missing-account-constraints`, `anchor.unchecked-sysvar-loader` (`:59`, Wormhole root cause), `anchor.missing-signer-check`, `anchor.pda-seed-collision`, `anchor.init-if-needed-reinit`, `anchor.cpi-unverified-program`, `anchor.missing-owner-check`.
- `skills/bober.security-igaming/SKILL.md` — **12** blocks: `igaming.toctou-balance-double-spend` (`:38`), `igaming.non-atomic-idempotency`, `igaming.client-supplied-odds`, `igaming.negative-zero-stake`, `igaming.float-money`, `igaming.missing-webhook-hmac`, `igaming.seamless-wallet-orphan-rollback`, `igaming.non-csprng-outcome` (`:187`, GLI-19), `igaming.client-side-outcome`, `igaming.limits-client-only`, `igaming.bonus-wagering-abuse`, `igaming.settlement-replay`.
- `skills/bober.security-dex-backend/SKILL.md` — **12** blocks: `dex.withdrawal-toctou-race` (`:40`), `dex.missing-withdrawal-idempotency`, `dex.missing-2fa-cooldown` (`:88`, Crypto.com-style), `dex.deposit-no-confirmations`, `dex.token-decimals-mismatch` (`:135`), `dex.float-token-amounts`, `dex.hot-wallet-key-in-env` (`:174`), `dex.kms-signer-no-authz-gate`, `dex.siwe-replay` (`:217`), `dex.missing-price-circuit-breaker`, `dex.webhook-no-signature`, `dex.unvalidated-withdrawal-amount`.
- `src/orchestrator/security-knowledge/skill-files.test.ts` — the real-asset table test that parses all four files, asserts each parses to its exact authored block count with **zero dropped blocks**, checks every `vulnClass ∈ ALL_VULN_CLASSES`, asserts unique `signatureId`s and the money-loss ids per file, and includes a dedicated guard that no block uses the non-union `'access-control'` class (the specific mistake that would silently drop a block).

## How it fits

The two on-chain stacks and two off-chain stacks split cleanly by surface:

- **`security-solidity`** vs the existing `bober.solidity` dev skill: the new file is signature-block structured and independently parseable — it may cite `bober.solidity`'s `## Security Checklist` but does not duplicate it verbatim (an explicit non-goal). Likewise `security-anchor` is distinct from the general `bober.anchor` dev skill.
- **`security-dex-backend`** deliberately covers the **off-chain custody/backend** surface of an exchange — "where most exchange money is actually stolen" — as distinct from `security-solidity`'s on-chain contract surface. The two are complementary, not overlapping.

Every block's `vulnClass` is drawn from the sprint-1 widened 17-class taxonomy — the money stacks lean on the classes that sprint added: `race-condition` (TOCTOU/reentrancy), `money-integrity` (odds/decimals/inflation/oracle), `insecure-randomness` (non-CSPRNG), `secret-handling` (hot-wallet key), `crypto-weakness` (SIWE/signature replay), alongside `authn-authz`, `privilege-escalation`, and `denial-of-service`. No block uses `access-control` (never a union member).

## Notes for maintainers

- **Known nit — solidity cross-function reentrancy overclaim (non-blocking, deferred).** The `bober.security-solidity` frontmatter `description` advertises reentrancy coverage of "single-function, cross-function, read-only", but the file has dedicated blocks only for **single-function** (`solidity.reentrancy-single-function`) and **read-only** (`solidity.reentrancy-readonly`) — there is no dedicated cross-function-reentrancy signature block. The evaluator flagged this as a low-priority quality nit (iteration 1, `generatorFeedback`), and it does **not** block the sprint. Candidate touch-up for a future sprint or a one-line skill edit: either add a `solidity.reentrancy-cross-function` block or narrow the frontmatter description to the two classes actually present. Not fixed here (docs-only sprint).
- **Adding/editing a signature = editing markdown, not code.** These files share the sprint-2 block format one-for-one; the `## Signature Block Format` section is repeated in each file and must stay in sync with `parser.ts`. A `VulnClass` line naming a class outside `ALL_VULN_CLASSES` is silently **dropped**, not coerced — the zero-drop assertion in `skill-files.test.ts` is the guard that catches it. Widen the sprint-1 taxonomy (and its lockstep test) before authoring against a new class.
- **Still dormant.** This sprint changed no TypeScript runtime behavior: the four files are not referenced by `runSecurityAudit`, the gate, or the CLI. They become live only when the sprint-5 index/selector loads them and feeds the finder. The suite stayed green at **4089**.
- **Non-goals honored.** No node/payments/react skill files (sprint 4), no index/selector/registry or finder wiring (sprint 5), no duplication of `bober.solidity`'s checklist verbatim, and no runtime behavior change.

## Scope

One commit — `f19a4bf` (`bober(sprint-3): author solidity/anchor/igaming/dex-backend security skill files`) — adding exactly five files: the four `skills/bober.security-{solidity,anchor,igaming,dex-backend}/SKILL.md` libraries and `src/orchestrator/security-knowledge/skill-files.test.ts` (1197 insertions, no deletions). All 5 required criteria (sc-3-1..3-5) passed on iteration 1; typecheck, build, lint, and the full suite (315 files / **4089 tests**) green. Zero-drop parse confirmed at 12/7/12/12 blocks with all-union `vulnClass`es.
