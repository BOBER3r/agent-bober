# Labelled vulnerable/safe benchmark corpus + deterministic measurement harness (verified, not asserted)

**Contract:** sprint-spec-20260714-security-auditor-per-stack-skills-9  ·  **Spec:** spec-20260714-security-auditor-per-stack-skills  ·  **Completed:** 2026-07-14

## What this sprint added

This sprint makes the finder→verifier pipeline's detection quality **measured, not asserted** — the realization of architecture success criterion #3. Sprint 8 built the adversarial verifier and *argued* it reduces false positives without losing detections; sprint 9 delivers the artifacts that let that claim be **recomputed and regression-guarded in CI**: a small, labelled, grounded corpus of vulnerable/safe code fixtures across the money/credential/injection/supply-chain/access-control classes, plus a pure, deterministic harness that runs a finder-only path versus a finder+verifier path over the corpus and reports two metrics per stage — **recall** on the vulnerable set (detection retained) and **false-positive block rate** on the safe set (nuisance blocks).

The corpus lives entirely in one JSON file as **inline code strings**, deliberately never as compilable `.ts`/`.sol` fixture files, so intentionally-vulnerable snippets (string-interpolated SQL, `exec()` on a shell string, an unguarded `fetch()`, a JWT verify that accepts `alg: "none"`) can ship under `src/` without breaking `npm run build`/`npm run lint`. The harness is a leaf measurement module — **purely additive, not wired into `runSecurityAudit` or the gate** (a nonGoal was explicitly "not a new blocking gate"): its only consumer is its own test. That test drives `measure()` with deterministic injected fakes and independently recomputes the false-positive reduction, so the pipeline's central promise is now a green assertion rather than prose.

## Public surface

**New corpus** (`src/orchestrator/security-knowledge/benchmark/fixtures/manifest.json`):

- A top-level JSON array of **13 vulnerable + 13 safe** labelled `BenchmarkCase` entries (26 total), each `{id, expected, stack, signatureId?, vulnClass?, code}`. The `code` field is an **inline string** drawn verbatim from a shipped `skills/bober.security-*/SKILL.md` signature's `**Unsafe:**`/`**Safe:**` block — never a reference to an external file. Vulnerable/safe cases are authored in pairs. Class coverage: iGaming money-integrity (TOCTOU double-spend, client-supplied odds, negative stake), dex-backend (withdrawal TOCTOU race, token decimals, hot-wallet key in env, unvalidated withdrawal amount), injection (SQLi, command injection, SSRF), access-control (BOLA), authn-authz (JWT `alg:none`), and supply-chain (malicious `postinstall`).
- [`fixtures/README.md`](../../src/orchestrator/security-knowledge/benchmark/fixtures/README.md) documents the `BenchmarkCase` label schema, **why the fixtures are inline JSON rather than compiled files**, the grounding rule + its one scanner-only exception, the class-coverage table, and both the offline (CI) path and the optional local real-provider run.

**New harness** (`src/orchestrator/security-knowledge/benchmark/harness.ts`):

- `measure(corpus, finderFn, verifierFn)` (`harness.ts:49`, exported) — the **pure** measurement function. Given a corpus and an injected finder + verifier, it computes `{finderOnly, finderPlusVerifier}`, each a `StageMetrics {recall, fpBlockRate}`. **No fs, no network, no `Math.random`, no `new Date()`/`Date.now()`** — deterministic by construction (the eval grep-verified the absence of `Math.random`/`Date`, and a test asserts repeated calls return identical results).
- `BenchmarkCase` (`harness.ts:14`, exported) — one labelled case; mirrors a `manifest.json` entry. `signatureId`/`vulnClass` are only meaningful for `expected:"vulnerable"`; `signatureId` is omitted for scanner-only classes (supply-chain).
- `FinderFn` (`harness.ts:27`, exported) — injected finder: `(c) => boolean` (does this case get flagged **critical**?). Pluggable so CI uses a fake.
- `VerifierFn` (`harness.ts:34`, exported) — injected verifier: `(c, finderCritical) => boolean`. **Downgrade-only** by contract, mirroring `VerifierResult` semantics from `security-verifier-agent.ts` — it may only turn `true`→`false` (drop/downgrade a finder critical), never `false`→`true`.
- `StageMetrics` (`harness.ts:36`) / `MeasureResult` (`harness.ts:43`) — `recall` = vulnerable cases flagged critical / total vulnerable (higher is better); `fpBlockRate` = safe cases flagged critical / total safe (lower is better).

## How to use / how it fits

The harness's only consumer is `harness.test.ts`, which drives it two ways:

1. **The offline CI path (`sc-9-2`/`sc-9-3`) — the measured FP-reduction result.** The test injects a deterministic `finderFake` (flags critical iff the case is vulnerable **or** in a fixed two-element false-positive safe subset — `safe-node-ssrf`, `safe-igaming-toctou`) and a `verifierFake` (downgrade-only: it disproves exactly that FP subset and confirms every genuine vulnerable case). Over the corpus the harness reports:

   | Stage | recall | fpBlockRate |
   |---|---|---|
   | finder-only | 1 | 2/13 |
   | finder + verifier | 1 | 0 |

   The test asserts `finderPlusVerifier.fpBlockRate < finderOnly.fpBlockRate` (strict reduction) **and** `finderPlusVerifier.recall >= finderOnly.recall` (detection retained). This is the measured realization of architecture success criterion #3: the verifier provably removes false-positive blocks without dropping a real detection.

2. **Two-arm label grounding (`sc-9-4`).** Every vulnerable fixture is cross-checked so the corpus is grounded in the shipped knowledge, not arbitrary code. **Arm 1** (signature-backed classes): the test loads the real `SecurityKnowledgeIndex` from `skills/` and asserts each vulnerable case's `signatureId` exists in the parsed index and that the shipped signature's `vulnClass` matches the case's label. **Arm 2** (scanner-only classes): the supply-chain fixture (`vuln-supplychain-postinstall`) has **no shipped skill signature** — `supply-chain` findings are emitted by the deterministic `supply-chain-inspector.ts` scanner, not an LLM reading a skill — so it omits `signatureId` and is instead grounded against the `ALL_VULN_CLASSES` runtime union (`stack-knowledge.ts`). A dedicated test pins that this one case omits `signatureId` and carries `vulnClass: "supply-chain"`.

An optional local real-provider run is documented but **never un-skipped in this repo**: a `describe.skip` block (gated on `BOBER_BENCHMARK_LIVE=1`) records how a manual run could wire the real `runSecurityAudit`/`runSecurityVerifier` into `FinderFn`/`VerifierFn` by adapting each `BenchmarkCase.code` into a minimal one-file `AuditDiff` and reading `review.critical.length > 0` as the finder verdict / `VerifierResult.dropped` as a verifier downgrade. That path needs a configured provider key; CI never touches it.

## Notes for maintainers

- **Fixtures are inline JSON on purpose.** Do not "promote" a vulnerable snippet to a real `.ts`/`.sol` file under `src/` for readability — `tsc`/`eslint` would fail on the intentionally-broken code and break the build gate (`sc-9-5`). JSON is data, never compiled or linted; keep the `code` field a string.
- **The harness must stay pure.** No `Math.random`, no `Date`, no fs/network. The determinism test (`measure` called twice returns `.toEqual`) and the eval's grep guard both enforce this; a nondeterministic harness would make the FP-reduction assertion flaky and worthless.
- **This is a measurement, not a gate.** The harness is deliberately not imported by `runSecurityAudit`, the pipeline gate, or the CLI (nonGoal: "do not gate the pipeline on benchmark thresholds"). It is a regression guard + few-shot exemplar source. Do not wire benchmark thresholds into the sprint gate without a new spec.
- **The corpus doubles as a regression guard for signature edits.** Because Arm 1 cross-checks every vulnerable label against the live parsed index, deleting or renaming a shipped `signatureId` (or changing its `vulnClass`) that a fixture references will fail the grounding test — a deliberate tripwire. If you intentionally retire a signature, update its fixture in the same change.
- **`vulnFn`/`safe` counts are `>= 12`, delivered as 13/13.** The contract required at least 12 of each; the shipped corpus is 13 vulnerable + 13 safe pairs. Keep them paired when adding cases.
- **Only the sprint-10 dogfood/docs close-out remains.** With this sprint, every feature of the pentest-grade upgrade (widened taxonomy, per-stack signatures, retrieval pipeline, real diff, supply-chain axis, finder→verifier, and now the measurement harness) is built. Sprint 10 is the dogfood-enablement + documentation close-out.

## Scope

One commit — `5537086` (`bober(sprint-9): benchmark corpus + deterministic measurement harness (verified not asserted)`). Adds `src/orchestrator/security-knowledge/benchmark/harness.ts` (+ `.test.ts`), `benchmark/fixtures/manifest.json`, and `benchmark/fixtures/README.md`. 474 insertions across 4 files, **purely additive** — no existing source/test/config touched, nothing wired into the pipeline. All 5 required criteria (sc-9-1..9-5) passed on iteration 1: corpus counts + class coverage, deterministic pure harness, independently-recomputed FP-reduction (`fpBlockRate` 2/13→0, `recall` 1→1), two-arm label grounding against the real index, and offline CI with the real-provider run documented-but-skipped. Typecheck, build, lint, and the full suite (322 files / **4270 tests** + 1 intentional skip) green.
