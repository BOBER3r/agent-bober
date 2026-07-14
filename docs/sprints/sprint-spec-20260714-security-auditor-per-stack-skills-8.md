# Adversarial finder->verifier stage (fresh, contract-free, downgrade-only, fail-closed)

**Contract:** sprint-spec-20260714-security-auditor-per-stack-skills-8  ·  **Spec:** spec-20260714-security-auditor-per-stack-skills  ·  **Completed:** 2026-07-14

## What this sprint added

This sprint adds the **false-positive control that makes higher recall safe**: a second, adversarial read-only LLM stage — the **verifier** — that runs immediately after the security auditor (the "finder") inside the same gate time-box. Where the finder's job is to *find* vulnerabilities, the verifier's job is to *refute* them. It is spawned in a **fresh, isolated context** fed **only** the finder's `critical`+`important` findings and the relevant diff hunks — **never** the sprint contract, its success criteria, or any "already passed" evaluation framing. That omission is the whole point: a favorably-worded contract ("here's what this sprint set out to build") is sycophancy bait that measurably makes a reviewer wave real issues through, so the verifier is deliberately never shown it. It is told to **disprove** each finding, and it may only ever move a finding **down** — confirm (keep), downgrade (`critical`→`important`), or drop — **never** promote, add, or manufacture a clean pass.

The stage is **strictly fail-closed**. Any parse-failure, provider error, refusal, or abort resolves `ran:false`, and the fold **keeps the finder's findings completely unchanged** — a broken or ambiguous verification never silently weakens a block. The verdict is derived on the (possibly verifier-folded) review via the **unchanged** `deriveVerdict`. The whole stage is **default-off** (`config.security.verifier`, ADR-2/ADR-6): a config that omits `verifier` is byte-identical to sprint 7. This is the **keystone** of the pentest-grade upgrade — because every false positive is a hard sprint block, a stage that provably only *reduces* false positives (never adds them) is what lets the earlier sprints' widened taxonomy, per-stack signatures, real-diff, and supply-chain axis push recall up without turning the gate into a nuisance.

## Public surface

**New agent prompt** (`agents/bober-security-verifier.md`):

- `bober-security-verifier` — a read-only subagent (`Read`/`Grep`/`Glob` only — **no `Bash`/`Write`/`Edit`**, `model: opus`) whose task is **refutation**. Its prompt explicitly states it is *never* given the sprint contract or any "already reviewed" framing and must distrust any such framing if it appears. It emits a **JSON array** of per-finding verdicts (`{index, verdict: "confirmed"|"downgraded"|"disproved", confidence, reason}`) — deliberately NOT the finder's `ReviewResult` object shape — and is told a truncated/prose-wrapped/object response is treated as a verification *failure* (criticals kept), so it must never confuse "everything confirmed" with a malformed reply.

**New orchestrator stage** (`src/orchestrator/security-verifier-agent.ts`):

- `runSecurityVerifier` (`security-verifier-agent.ts:59`) — the default `SecurityVerifier`. Its `verify({findings, diff, projectRoot, config, signal})` runs its own `runAgenticLoop` with the **same read-only `curator` toolset** the finder uses (no new `AgentRole`) and the verifier prompt, returning a `VerifierResult`.
- `VerifierResult` (`security-verifier-agent.ts:30`) — `{verified: SecurityFinding[], downgraded: SecurityFinding[], dropped: SecurityFinding[], ran: boolean}`. `ran:false` is the fail-closed sentinel (finder criticals kept).
- `SecurityVerifier` / `VerifyParams` (`security-verifier-agent.ts:53`/`:41`) — the injectable seam (mirrors `SecurityDiffProvider`) and its param shape. `diff` is the **same `AuditDiff`** the finder saw (`undefined` in estimated-files mode); `signal` is the caller-owned time-box.
- `parseVerifierResult(text, inputFindings)` (`security-verifier-agent.ts:232`, exported) — the fail-closed parser. It is the **mirror image** of the auditor's parser (same direct→fence→bracket-slice ladder) but **requires a JSON array**; a stray object, truncated JSON, or garbage is `ran:false`. A finding present in `inputFindings` but never addressed by a matched, recognized verdict entry **defaults to `verified`** — an unaddressed finding is never silently dropped. Verdict entries resolve back to the **same finding object reference** by `index` → `signatureId` → `path`+`line`.

**New config** (`src/config/schema.ts:281`):

- `config.security.verifier` — **optional** object `{ enabled: boolean (default false), model: ModelChoice (default "opus"), maxTurns: int≥1 (default 10) }`. `.optional()` with **no outer default**, so omitting it materializes no key at all — the same byte-identity guarantee as `diff`/`supplyChain`/`egress`. `maxTurns` defaults **lower** than the finder's (10 vs 20): refutation needs fewer turns than the original audit.

**New fold** (`src/orchestrator/security-auditor-agent.ts`):

- `runSecurityAudit` grows one additive seam (`security-auditor-agent.ts:258`) after the finder parse and **before** `deriveVerdict`: when `parsed && config.security.verifier?.enabled === true`, it calls the (injected or default) verifier with `finderReview.critical`+`important` and the shared `auditDiff`, then folds the result. `SecurityAuditDeps` gains a last-positional `verifier?` (callers stay byte-compatible).
- `foldVerifierResult(finderReview, v)` (`security-auditor-agent.ts:335`, internal) — the **downgrade-only, fail-closed** fold. `v.ran === false` ⇒ returns `finderReview` unchanged. On success: `verified` stay put, `downgraded` move `critical`→`important`, `dropped` are removed; `minor` and `approvedAreas` pass through **byte-untouched**. The new `critical` set is therefore always a strict **subset** of the finder's — nothing is ever promoted or added. Matches by **object identity** against the finder's own arrays.

## How it fits

The pipeline is now a two-stage **finder → verifier** flow, both inside the gate's single `Promise.race` time-box:

1. The **finder** (`bober-security-auditor`) runs as before and produces a `ReviewResult` with `critical`/`important`/`minor`/`approvedAreas` buckets.
2. If `security.verifier.enabled`, the **verifier** runs sequentially (data dependency — its input *is* the finder's output, so they never run concurrently). It gets a fresh context with **only** `critical`+`important` and the diff hunks — never `minor`, never `approvedAreas` (so an approved area can never be re-opened), never the contract.
3. `foldVerifierResult` applies the downgrade-only verdicts, and the **unchanged** `deriveVerdict` derives `pass`/`blocked` on the folded review.

The net effect, proven by the sprint's demonstrative test: a finder `critical` the verifier **disproves** stops blocking (verdict flips `blocked`→`pass` for that case), while a genuine `critical` the verifier **confirms** still blocks. With `verifier` absent, none of this executes and the audit is single-stage byte-identical to sprint 7.

## Notes for maintainers

- **Fail-closed is the invariant, not a nicety.** Seven failure modes all resolve to `ran:false` ⇒ finder criticals kept: unparseable output, a JSON *object* instead of an *array*, a truncated array, a provider throw, an `aborted`/`error` stop reason, a `refused` completion, and a finding left unaddressed by any recognized verdict (that one defaults to `verified`). Do not add a code path that turns any of these into a downgrade/drop — that would let a broken verification weaken a real block.
- **The contract is provably absent — keep it that way.** `buildVerifierUserMessage` deliberately excludes everything `buildUserMessage` folds in for the finder (no `# Sprint Contract`, no `# Evaluation Result (Already Passed)`, no priors). A test captures the verifier's user message and asserts the contract's `title`/`description`/`successCriteria` never appear. If you ever thread more context into the verifier prompt, do not reintroduce the contract or any "already passed" framing — that is the sycophancy strip.
- **Downgrade-only is enforced structurally, not just by prompt.** Even if the LLM tried to promote a finding, `parseVerifierResult` only recognizes `confirmed`/`downgraded`/`disproved`, and `foldVerifierResult` can only ever produce a `critical` subset. The prompt asks for refutation; the fold makes promotion *impossible*.
- **The AbortController wording is per-substage, not literally shared.** The contract said "share ONE AbortController"; the implementation gives the verifier its own controller keyed to the same `security.timeoutMs`, matching the pre-existing per-substage idiom (diff provider, scanners) — and the gate's **outer** `Promise.race` bounds total duration regardless. The evaluator flagged this as functionally harmless (low-priority quality note), not a defect.
- **Object identity matters for the fold.** The verifier is fed, and returns, the **same** `SecurityFinding` object references, so the fold's `Set` membership check is exact. `resolveFindingRef` must keep resolving entries back to the input array (by `index`/`signatureId`/`path`+`line`) rather than reconstructing findings.
- **This closes the spec's core feature set.** Only the benchmark corpus (sprint 9) and the dogfood/docs close-out remain; every major recall/precision feature (taxonomy, per-stack signatures, retrieval pipeline, real diff, supply-chain axis, and now the verifier) is built.

## Scope

One commit — `9acf265` (`bober(sprint-8): adversarial finder->verifier stage (fresh, contract-free, downgrade-only, fail-closed)`). Adds `agents/bober-security-verifier.md` and `src/orchestrator/security-verifier-agent.ts` (+ `.test.ts`); adds the `security.verifier` optional object to `src/config/schema.ts` (+ test); adds the verifier seam + `foldVerifierResult` to `src/orchestrator/security-auditor-agent.ts` (+ test). 1207 insertions / 9 deletions across 7 files. `deriveVerdict` is byte-unchanged. All 6 required criteria (sc-8-1..8-6) passed on iteration 1 — contract provably absent, fail-closed on all failure modes, downgrade-only (`approvedAreas`/`minor` never re-opened), default-off byte-identical, and FP-reduction proven in both directions. Typecheck, build, lint, and the full suite (321 files / **4263 tests**) green.
