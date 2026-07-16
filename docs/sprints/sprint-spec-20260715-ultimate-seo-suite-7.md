# Quota governor + persisted concurrent-safe ledger

**Contract:** sprint-spec-20260715-ultimate-seo-suite-7  ·  **Spec:** spec-20260715-ultimate-seo-suite  ·  **Completed:** 2026-07-16

## What this sprint added

The **cost/quota safety layer** that will gate the live GSC and DataForSEO adapters (wired in sprints 8-9, **not** here). Two additive files landed: (1) `src/seo/quota-ledger.ts` — pure persistence + keying helpers for `.bober/seo/quota-ledger.json` (atomic temp+rename writes, a module-scoped per-path mutex, and an ENOENT-vs-corrupt read that distinguishes *first-run/offline* from *fail-closed*); and (2) `src/seo/quota-governor.ts` — `SeoQuotaGovernor`, a never-throwing gate that models the GSC rate/daily caps **per-site AND per-user separately** plus the DataForSEO USD budget, backed by that shared persisted ledger so **concurrent runs share one ceiling**. `admit()` is synchronous, never throws, and mutates nothing on either outcome; only `record()` — called by the caller *after* a real successful API round-trip — advances any counter. The barrel `src/seo/index.ts` additively re-exports the governor and its types. No adapter, analyzer, CLI, or hub wiring yet; this sprint proves the gate and the concurrent-safe ledger against unit tests only.

## Public surface

- `SeoQuotaGovernor` (`src/seo/quota-governor.ts:76`) — the quota gate. Private constructor; built via the static factory below. Holds three in-memory rolling-window maps (site/user search-analytics + site url-inspection) and a persisted-ledger snapshot.
- `SeoQuotaGovernor.load(ledgerPath, config)` (`src/seo/quota-governor.ts:89`) — async factory. Reads the ledger at `ledgerPath` and pins `maxUsd = config.seo?.budget?.maxUsd ?? null` (`null`/absent = uncapped). A `"corrupt"` ledger read propagates into the instance so it fails closed.
- `SeoQuotaGovernor.admit(req): QuotaDecision` (`src/seo/quota-governor.ts:100`) — **synchronous, never throws, no side effect on either branch.** Returns `{ admit: true }` or `{ admit: false, reason }`. Any unexpected internal error is caught and fails closed to `{ admit: false, reason: "budget-exceeded" }`.
- `SeoQuotaGovernor.record(req, actualCostUsd): Promise<void>` (`src/seo/quota-governor.ts:154`) — async. Called only after `admit()` returned `true` **and** the real API call succeeded. Advances this instance's in-memory rate window and the shared persisted ledger via the atomic, mutex-serialized read-modify-write. Guards `NaN`/negative/non-positive cost and rows so counters never corrupt.
- `SeoQuotaGovernor.spentUsd(): number` (`src/seo/quota-governor.ts:193`) — cumulative persisted USD spend across all recorded days; `+Infinity` when the ledger is corrupt (at-ceiling).
- `QuotaRequest` (`src/seo/quota-governor.ts:52`) — one gated request: `source` (`"gsc" | "dataforseo"`), `scope` (`{ siteUrl?, userId? }`), optional `capability` (`SeoCapability`; GSC defaults to `"search-analytics"`), `estRows`, `estCostUsd`.
- `QuotaRefusalReason` (`src/seo/quota-governor.ts:64`) — `"rate-window" | "daily-rows" | "url-inspection-cap" | "budget-exceeded"`.
- `QuotaDecision` (`src/seo/quota-governor.ts:66`) — `{ admit: true } | { admit: false; reason: QuotaRefusalReason }`.
- `readLedger(path)` (`src/seo/quota-ledger.ts:52`) — ENOENT ⇒ fresh `{}` (offline/first-run, **not** corrupt); existing-but-unreadable or unparseable ⇒ `"corrupt"` sentinel.
- `writeLedgerAtomic(path, ledger)` (`src/seo/quota-ledger.ts:73`) — `ensureDir` + unique temp file (`.pid.ts.rand.tmp`, mode `0o600`) + POSIX `rename`, so a crash mid-write can never leave a torn file.
- `withLedgerLock(path, fn)` (`src/seo/quota-ledger.ts:98`) — the module-scoped per-`resolve(path)` promise-chain mutex; chains onto the prior run whether it resolved or rejected so one failure never wedges the chain.
- `dateKey(now)` / `scopeKey(scope)` (`src/seo/quota-ledger.ts:34,39`) — `YYYY-MM-DD` daily key and the composite `${siteUrl}|${userId}` scope key.
- Barrel `src/seo/index.ts:22-23` — additively re-exports `SeoQuotaGovernor` and the `QuotaRequest`/`QuotaDecision`/`QuotaRefusalReason` types. The ledger shape itself is the Sprint-1 `SeoQuotaLedger` (`src/seo/types.ts:114`), unchanged.

## The pinned caps (research §4 — exact numbers, not approximations)

Modeled verbatim from the architecture/research S4 figures (`src/seo/quota-governor.ts:43-47`):

- **GSC Search Analytics** — `GSC_QPM = 1,200`: **1,200 QPM per-site AND 1,200 QPM per-user**, enforced as **two independent rolling one-minute windows** (a request needs headroom in both). `GSC_ROWS_PER_DAY = 50,000` rows/day per search type.
- **GSC URL Inspection** — `GSC_URL_INSPECT_PER_DAY = 2,000` queries/day/property and `GSC_URL_INSPECT_QPM = 600` QPM (its own separate site rolling window).
- **DataForSEO** — no fixed cap; `estCostUsd` is booked against `config.seo.budget.maxUsd` in `admit()` and `actualCostUsd` accrues in `record()`. `null`/absent budget = **uncapped** (the USD check is skipped entirely), mirroring `src/orchestrator/workflow/budget.ts`.
- `WINDOW_MS = 60,000` — the rolling one-minute QPM window applied to every rate check.

`admit()` evaluates these in order: (1) in-memory rolling QPM window(s) → `rate-window`; (2) persisted daily caps (url-inspection ⇒ `url-inspection-cap`, else `daily-rows`); (3) USD budget ⇒ `budget-exceeded`. `estRows` drives the daily-row **or** the url-inspection counter depending on the effective capability.

## The concurrency guarantee (no lost updates)

The persisted ledger is the cross-process ceiling, and it stays consistent under concurrent writers via two mechanisms working together:

- **Atomic writes** — `writeLedgerAtomic` writes a uniquely-named temp file then `rename`s it over the target (POSIX-atomic), so a reader never sees a half-written ledger and a crash never tears the file.
- **A module-scoped per-path mutex** — `withLedgerLock` keys a promise-chain on `resolve(path)`, so **every** `SeoQuotaGovernor` instance pointed at the same resolved ledger path serializes its read-modify-write through the **same** chain. `record()` reads the ledger *fresh from disk inside the lock*, applies its delta, and writes — so interleaved `record()` calls compose instead of clobbering.

This is proven by the **100-concurrent-writes test**: two governors sharing one ledger path fire 100 interleaved `record()` calls and the final combined spend equals exactly 100 (zero lost updates). A companion test asserts no leftover `.tmp` file remains after the atomic writes.

## The fail-closed semantics

- **Corrupt / unreadable ledger ⇒ at-ceiling.** `readLedger` returns the `"corrupt"` sentinel for an existing-but-unparseable/unreadable file. The governor then reads `spentUsd()`, `rowsToday()`, and `urlInspectionsToday()` back as `+Infinity`, so any **costed** request touching those counters is refused. (Verified fail-closed for the budget check *and* both GSC daily counters.)
- **Missing ledger (ENOENT) ⇒ fresh-allow.** A missing file is a fresh empty `{}` — the offline/first-run path admits normally. This deliberately does **not** collapse ENOENT and corruption to one case (unlike `readRunState`, which returns `null` for both).
- **`record()` heals; `admit()` fails closed.** Corruption blocks admission, but `record()` reads fresh inside the lock and treats a `"corrupt"` read as `{}` before writing — so a subsequent successful `record()` overwrites the bad file with a valid one. Corruption is a gate, not a permanent wedge.
- **Offline never creates the ledger.** An `admit()`-only path (no `record()` call) performs zero writes, so a purely offline run never materializes `.bober/seo/quota-ledger.json`.

## How to use / how it fits

The governor is the gate the live adapters (sprints 8-9) must clear before every real API call — it decides, it does **not** fetch. The intended call shape:

```ts
import { SeoQuotaGovernor } from "./seo/index.js";

const gov = await SeoQuotaGovernor.load(".bober/seo/quota-ledger.json", config);

const req = {
  source: "gsc" as const,
  scope: { siteUrl: "https://example.com", userId: "svc-account-1" },
  capability: "search-analytics" as const,
  estRows: 25_000,
  estCostUsd: 0, // GSC is free; DataForSEO would supply an estimate here
};

const decision = gov.admit(req);
if (!decision.admit) return; // decision.reason ∈ rate-window | daily-rows | url-inspection-cap | budget-exceeded

// ... perform the real API call; only on success:
await gov.record(req, /* actualCostUsd */ 0);
```

`admit()` mirrors the `SeoEgressGuard` guard-class shape (`src/seo/egress.ts:19-57`): a synchronous, side-effect-free decision. The two are complementary — the egress guard is the hard *is this axis allowed at all* barrier; the governor is the *do we have quota/budget headroom right now* gate. Both sit in front of the live adapters.

## Notes for maintainers

- **In-memory QPM windows are ephemeral and per-instance; the daily/USD ceilings are persisted.** The rolling-window timestamp maps are NOT written to the ledger and reset on process restart — accepted by design, because the hard cross-process ceilings that must survive are the daily-row / url-inspection / USD counters, and those live in the ledger. Do not "fix" this by persisting windows without a token-bucket rethink.
- **The mutex key is `resolve(path)`.** Two governors only share a ceiling if they resolve to the same absolute path. A relative-vs-absolute mismatch would give them independent chains and reintroduce lost updates — always hand `load()` a stable path.
- **`record()` guards cost/rows.** Only finite, `> 0` `actualCostUsd` accrues to `spentUsd`; only finite, `> 0` `estRows` accrues to the daily/url-inspection counter (mirrors `budget.ts` NaN/negative guarding). Keep this — it is what stops a bad estimate from corrupting the ledger.
- **`effectiveCapability` defaults GSC to `search-analytics`.** A `source: "gsc"` request that omits `capability` is treated as search-analytics (site+user windows, daily-rows). DataForSEO requests have no GSC-specific default and only touch the USD budget.
- **Not wired into any adapter yet (deferred to sprints 8-9).** No `hub/finding.ts` import; parser/retriever/playbook-index/local-export/seam untouched; no new dependencies. The governor gates but does not call any live API (a hard nonGoal of this sprint).
- **The window model is a simple timestamp array per key** (`quota-governor.ts:70-75` note) — fine at the handful-of-timestamps-per-minute scale this governs; swap for a token-bucket if one process ever governs a large number of distinct sites/users.

## Scope

One commit — `b903af1` — creating `src/seo/quota-ledger.ts` (110 lines: keying + `readLedger`/`writeLedgerAtomic`/`withLedgerLock`), `src/seo/quota-governor.ts` (234 lines: `SeoQuotaGovernor` + `QuotaRequest`/`QuotaDecision`/`QuotaRefusalReason`), and `src/seo/quota-governor.test.ts` (315 lines, 14 tests: each refusal reason never-throws + no-side-effect, per-site/per-user window independence, budget + `null`-uncapped, atomic write with no leftover `.tmp`, two-governor 100-concurrent no-lost-update summing to 100, corrupt-ledger fail-closed across all three counters + record() healing, offline never creating the ledger), plus an additive barrel edit to `src/seo/index.ts` (+3 lines). No adapters, analyzer, governor-to-adapter wiring, CLI, or hub emitter; no live API calls; no new dependencies. All 5 required criteria (sc-7-1..7-5) passed on **iteration 1**; full suite **4370 passed | 1 skipped | 0 failed** (`src/seo` 80 passed).
