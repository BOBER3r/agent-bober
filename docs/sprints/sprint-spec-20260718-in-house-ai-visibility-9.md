# ScrapeThrottle — filesystem proxy ledger + per-engine rate window

**Contract:** sprint-spec-20260718-in-house-ai-visibility-9  ·  **Spec:** spec-20260718-in-house-ai-visibility  ·  **Completed:** 2026-07-18

## What this sprint added

The gated scrape arm (lands Sprint 10) meters a **different** cost than the grounded-API
spine: **proxy USD**, plus a **per-engine rate window** that keeps a stealth scraper polite.
This sprint delivers the enforcement primitive for both — a new **`ScrapeThrottle`** with its
**own** filesystem ledger at `.bober/seo/scrape-throttle-ledger.json`, deliberately **separate
from** and **never cross-reconciled with** the `SeoQuotaGovernor`'s USD ledger
(`.bober/seo/quota-ledger.json`). This is the **two-independent-ledgers cost model** the arch
calls for: the scrape arm books `$0` to the governor and tracks its real proxy spend here, so
the two budgets are capped independently and neither can see the other's spend. `ScrapeThrottle`
copies the governor's proven concurrency discipline verbatim — the **path-generic**
`withLedgerLock` per-path mutex reused from `quota-ledger.ts` (so this ledger gets its own
serialization chain), **read-fresh-inside-the-lock**, **atomic temp-file + rename** writes, and
**fail-closed-on-corrupt** — but keeps its own per-engine `{ windowStart, count, proxyUsdSpent }`
shape and its own clock. It is delivered **in isolation**: nothing wires it into a scrape
provider yet (Sprint 10), it adds no config-schema field (caps come from the constructor), and
it imports nothing from `quota-governor.ts`.

## Public surface

All in the new `src/seo/scrape-throttle.ts` (not yet re-exported from `src/seo/index.ts` — an
internal primitive until Sprint 10 wires it):

- `class ScrapeThrottle` (`src/seo/scrape-throttle.ts:106`) — constructor
  `(ledgerPath: string, limits: ScrapeThrottleLimits, now?: () => string)`. The `now` clock is
  an **injected `() => ISO string`** (mirrors `DamcrawlerCrawlEngine.now`), defaulting to
  `() => new Date().toISOString()` — **never `Date.now()` directly** for the window, so
  rate-window tests drive the boundary deterministically.
- `ScrapeThrottle.acquire(engine)` (`:120`) → `Promise<ThrottleDecision>` — decides **and
  consumes** a rate slot in one read-modify-write under the per-path mutex. Returns
  `{ proceed: true }` within the window and proxy budget; `{ proceed: false, reason:
  "proxy-budget" }` once cumulative `proxyUsdSpent >= maxProxyUsd`; `{ proceed: false, reason:
  "rate-window" }` once `count + 1 > maxPerWindow`. **Proxy-budget is checked before the rate
  window.** Writes the ledger **only on the granting branch** — a refusal has **no side effect**
  (mirrors `SeoQuotaGovernor.admit()`). A fixed window resets (`windowStart`/`count`) once
  `now - windowStart >= windowMs`.
- `ScrapeThrottle.recordProxyCost(engine, usd)` (`:162`) → `Promise<void>` — the governor's
  `record()` twin. Accrues completed proxy spend under the same per-path mutex + read-fresh +
  atomic write, so concurrent calls sharing the ledger **never lose an update**. **Guards
  NaN/negative/zero** (a bad value can never corrupt or reduce the running total) and **heals a
  corrupt ledger back to `{}`** (corruption blocks `acquire`, not `recordProxyCost`).
- `type ThrottleDecision` (`:54`) — `{ proceed: true } | { proceed: false; reason: "rate-window"
  | "proxy-budget" }`. Note the discriminant is **`proceed`**, not `allowed` (per contract
  sc-9-1).
- `type ScrapeThrottleLimits` (`:57`) — `{ maxPerWindow: number; windowMs: number; maxProxyUsd:
  number }`. Caps are **constructor-injected** — no config-schema field this sprint (isolation).
- `type ScrapeProxyLedger` (`:49`) — the persisted shape, keyed by engine string:
  `{ [engine]: { windowStart: number; count: number; proxyUsdSpent: number } }`.

## How to use / how it fits

```ts
const throttle = new ScrapeThrottle(
  ".bober/seo/scrape-throttle-ledger.json",
  { maxPerWindow: 10, windowMs: 60_000, maxProxyUsd: 5 },
);

const decision = await throttle.acquire("google");   // { proceed: true } | { proceed: false, reason }
if (decision.proceed) {
  // ... perform the proxied scrape ...
  await throttle.recordProxyCost("google", 0.003);    // book the real proxy spend
}
```

`acquire` is the **pre-scrape gate** (rate + budget) and `recordProxyCost` is the
**post-scrape accrual**. The two-ledger split means the scrape arm's `estCostUsdPerPrompt`
stays `$0` against the `SeoQuotaGovernor` (whose USD ceiling gates only the grounded-API
spine), while proxy dollars accrue against `maxProxyUsd` here. Ledger persistence + mutex +
atomic-write discipline is intentionally identical to `SeoQuotaGovernor` so behaviour under
concurrency and corruption is already-understood.

## Notes for maintainers

- **Delivered in isolation — no arm is wired yet.** No scrape provider constructs or calls
  `ScrapeThrottle`; the `ai-visibility-scrape` egress axis still composes no provider. The
  scrape-arm wiring is **Sprint 10**. Public API (`acquire`/`recordProxyCost`,
  `ThrottleDecision.proceed`) was frozen this sprint precisely so Sprint 10 can wire it.
- **The two ledgers are deliberately independent — do not reconcile them.** Reconciling proxy
  USD into the governor ledger is an explicit nonGoal. The independence is verified in both
  directions: `$50` of proxy spend leaves a co-located `governor.spentUsd()` at `0` and never
  creates the governor ledger file, and a corrupt governor ledger does not block a throttle
  `acquire` on its own path.
- **Fail-closed asymmetry is intentional.** A corrupt/unreadable ledger makes `acquire` deny
  (`reason: "proxy-budget"`, mirroring the governor's Infinity-on-corrupt refuse) **without
  writing**, but `recordProxyCost` *heals* corruption back to `{}` before accruing — mirroring
  `SeoQuotaGovernor.record()`. A **missing** ledger (first run / offline) is a fresh `{}`, i.e.
  **allow**, and is explicitly **not** treated as corrupt.
- **Never sync fs, never `Date.now()` for the window.** `node:fs/promises` only; the clock is
  injected for determinism (both nonGoals of this contract).

## Scope

One commit — `0ff510a` — two **new** files, +353/−0: `src/seo/scrape-throttle.ts` (the throttle
+ ledger helpers; reuses `withLedgerLock` from `quota-ledger.ts`, imports nothing from
`quota-governor.ts`) and `src/seo/scrape-throttle.test.ts` (12 tests: rate-window
grant/deny/reset, denied-writes-nothing, per-engine independence, concurrent-no-lost-update at
100/100 both single-instance and dual-instance sharing one ledger, NaN/negative guard,
corrupt-fail-closed, corrupt-heals-on-record, missing-is-not-corrupt, and bidirectional governor
independence). All 5 required criteria (sc-9-1..9-5) passed on **iteration 1**; typecheck/build
clean, eslint 0 errors; full suite **4892 passed | 1 skipped | 0 failed** (+12 new, 0
regressions, governor suite 14/14 green). No new dependency.
