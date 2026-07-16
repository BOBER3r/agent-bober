# DataForSEO adapter — the second live `SeoDataSource`, completing the data plane (serp-provider axis, real USD cost booking)

**Contract:** sprint-spec-20260715-ultimate-seo-suite-9  ·  **Spec:** spec-20260715-ultimate-seo-suite  ·  **Completed:** 2026-07-16

## What this sprint added

The **second live-network data source** of the SEO suite, and the one that **completes the data plane** (offline `LocalExportSource` + `GscAdapter` + `DataForSeoAdapter` now cover all five capabilities across three sources). One new file lands: `src/seo/sources/dataforseo-adapter.ts` — `DataForSeoAdapter`, a live `SeoDataSource` that serves `serp` + `keywords` + `backlinks` from the real DataForSEO v3 API **behind the `"serp-provider"` egress axis**, with the same **ADR-5 in-adapter gate** (`assertAllowed("serp-provider")` then `governor.admit(...)` as the literal first two statements of every socket-opening method) that `GscAdapter` established in Sprint 8. `searchAnalytics`/`urlInspection` are not DataForSEO capabilities and return `{ kind: "disabled" }` unconditionally (GSC serves those). The **load-bearing new behavior** over the GSC clone is **real-money USD cost booking**: DataForSEO is pay-as-you-go, so every serving method computes a real USD cost from the research §4 price ladder, pre-empts it in `admit()`, books the **actual** USD via `governor.record()` **only after a successful round-trip**, and stamps `provenance.costUsd`. The barrel `src/seo/index.ts` additively re-exports `DataForSeoAdapter` (+1 line). No analyzer, runner, CLI, or hub wiring; no new dependencies.

## Public surface

- `DataForSeoAdapter` (`src/seo/sources/dataforseo-adapter.ts:158`) — the live DataForSEO `SeoDataSource`. Constructor: `new DataForSeoAdapter(egress, governor, http?, getBasicAuth?)` — `egress: SeoEgressGuard` and `governor: SeoQuotaGovernor` are required; `http` defaults to `defaultHttpClient`; `getBasicAuth` defaults to base64-encoding `${DATAFORSEO_LOGIN}:${DATAFORSEO_PASSWORD}` from `process.env` into an HTTP Basic credential (tests inject a fake `HttpClient` and stub the credential so CI opens no socket).
- `DataForSeoAdapter.capabilities()` (`dataforseo-adapter.ts:176`) — returns exactly `["serp", "keywords", "backlinks"]`.
- `DataForSeoAdapter.serp(q)` (`dataforseo-adapter.ts:186`) — POSTs to `serp/google/organic/live/advanced`; books the fixed per-task SERP price for `q.priority` (default `"standard"`); records the exact same USD it estimated (fixed-price task). Returns `{ kind: "data", rows, provenance }` or `{ kind: "abstain", reason }` — never throws.
- `DataForSeoAdapter.keywords(q)` (`dataforseo-adapter.ts:241`) — POSTs to `dataforseo_labs/google/keyword_ideas/live`; books `KEYWORDS_TASK_USD` (a documented placeholder — see maintainer notes). Never throws.
- `DataForSeoAdapter.backlinks(q)` (`dataforseo-adapter.ts:294`) — POSTs to `backlinks/backlinks/live`; `admit()` pre-empts the worst-case `$0.02 + q.limit × $0.00003`, but `record()`/`provenance.costUsd` use the **actual returned row count** (`$0.02 + rows.length × $0.00003`). Never throws.
- `DataForSeoAdapter.searchAnalytics` / `.urlInspection` (`dataforseo-adapter.ts:345,349`) — unconditional `{ kind: "disabled" }` (not DataForSEO capabilities; GSC serves them).
- `parseSerp` / `parseKeywords` / `parseBacklinks` (`dataforseo-adapter.ts:99,113,133`) — pure, total parsers that walk the DataForSEO v3 `tasks[0].result[0].items[]` envelope (`firstResultItems`, `:84`); any shape mismatch degrades to `[]` (never throws).
- Barrel `src/seo/index.ts` — additively re-exports `DataForSeoAdapter`.

## The cost-safety invariant (the load-bearing new behavior — book only on success, zero on failure)

Unlike GSC (which is free, `estCostUsd: 0`), DataForSEO charges real money per task, so this adapter adds a strict money-safety discipline on top of the reused ADR-5 gate:

1. **`admit()` pre-empts the worst-case USD.** The estimated cost is passed as `estCostUsd` so the governor's budget ceiling refuses a call that would overspend **before** any socket opens (SERP/keywords use a fixed per-task price; backlinks uses `q.limit` as the worst case).
2. **`governor.record()` is called strictly AFTER `res.ok`.** The actual USD is booked only once a successful round-trip is confirmed. For SERP the actual equals the estimate (fixed-price task); for backlinks the actual is **recomputed from the rows actually returned**, not the worst-case estimate.
3. **`provenance.costUsd` stamps the actual charge.** Every `{ kind: "data" }` outcome carries `{ source: "dataforseo", retrievedAt, costUsd }`.
4. **A 402/429/5xx (or any thrown/parse error) books ZERO.** A non-`ok` response maps to `{ kind: "abstain", reason: "dataforseo-http-<status>" }` and any network/parse error to `abstain{source-error}` — both **before** any `record()` call, so **nothing is ever booked for a failed request**. DataForSEO did not charge, so neither does the ledger. The method never throws to the caller.

The price ladder is pinned from research §4 (`dataforseo-adapter.ts:62-79`): SERP `standard $0.0006` / `priority $0.0012` / `live $0.002` per task; backlinks `$0.02/req + $0.00003/row`. With the axis OFF (or a governor budget refusal), a network-spy `HttpClient` records zero fetch calls and `spentUsd()` stays unchanged, while the method still resolves `abstain`.

## How to enable / how it fits

`DataForSeoAdapter` is inert until **both** the egress axis and credentials are provided, and (for real spend control) a budget is set:

1. **Turn on the axis.** Set `seo.egress.serp-provider = true` in `bober.config.json` (default `false`; omitting the `seo` section leaves the whole suite byte-identical to before). This is the hard barrier — with it off, every DataForSEO call abstains at zero network and zero spend.
2. **Provide credentials.** Export `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD` (base64-encoded into an HTTP Basic `Authorization` header at request time), or inject a custom `getBasicAuth` in the constructor.
3. **Set a budget (recommended, since this costs real money).** Set `seo.budget.maxUsd` so the `SeoQuotaGovernor` refuses calls that would overspend (`null`/absent = uncapped). The governor's `spentUsd()` sums the shared, concurrency-safe `.bober/seo/quota-ledger.json`.

Intended call shape:

```ts
import { DataForSeoAdapter, SeoQuotaGovernor } from "./seo/index.js";
import { SeoEgressGuard } from "./seo/egress.js";

const egress = SeoEgressGuard.fromConfig(config);
const governor = await SeoQuotaGovernor.load(".bober/seo/quota-ledger.json", config);
const dfs = new DataForSeoAdapter(egress, governor); // http + Basic auth default to prod (fetch + DATAFORSEO_LOGIN/PASSWORD)

const out = await dfs.serp({ keyword: "best crm", location: "United States", priority: "standard" });
if (out.kind === "data") {
  // out.rows: SerpRow[]; out.provenance = { source: "dataforseo", retrievedAt, costUsd: 0.0006 }
} // else out.kind === "abstain" (axis off, budget refused, or 402/429/5xx/parse error) — never a throw, and ZERO booked on failure
```

`DataForSeoAdapter` is a **peer `SeoDataSource` implementation** (ADR-2) beside `GscAdapter` (Sprint 8) and the offline `LocalExportSource` (Sprint 6). It clears both front-door guards from earlier sprints — the `SeoEgressGuard` (Sprint 1, *is this axis allowed at all*) and the `SeoQuotaGovernor` (Sprint 7, *do we have budget/quota headroom*) — before touching the network, and reuses the provider-agnostic injectable `HttpClient` / `defaultHttpClient` fetch-confinement seam (`src/seo/adapters/http.ts`, Sprint 8) so the real global `fetch` is referenced nowhere in this file. **With this adapter online, the data plane is complete** — offline (`LocalExportSource`) + GSC + DataForSEO cover all five `SeoCapability` members; the remaining sprints (analyzer, CLI, hub emitter) consume this seam rather than add sources to it.

## Notes for maintainers

- **`KEYWORDS_TASK_USD` is a documented assumption, not a pinned research number.** Research §4 prices only SERP and backlinks, not the `keyword_ideas` endpoint. The adapter uses `$0.0006` (the standard-SERP price) as a placeholder, flagged by a `bober:` comment at `dataforseo-adapter.ts:73-79`. Revisit and re-pin if/when a real DataForSEO keywords price is confirmed.
- **The book-only-on-success order is load-bearing and evaluator-checked.** `governor.record()` must remain strictly after the `res.ok` success check so a 402/429/5xx never books spend. Do not hoist the `record()` call above the response check.
- **The two-gate preamble order is inherited verbatim from `GscAdapter` (ADR-5).** `assertAllowed("serp-provider")` then `governor.admit(...)` must stay the **first two statements** of any socket-opening method; the egress `throw` is caught and converted to `abstain{egress-serp-provider-disabled}` without opening a socket.
- **`record()` books actuals, `admit()` pre-empts worst-case** — matching GSC. Backlinks admits with `q.limit` (worst case) but records `rows.length × $0.00003 + $0.02`; keep this split so the budget ledger reflects real spend, not the estimate.
- **No credential store / rotation here (deliberate).** The HTTP Basic credential is injected fully-formed via `getBasicAuth` (default: base64 of the two env vars). Add rotation only when a credential store is wired in a later sprint.
- **Parsers are total and fail-closed.** `parseSerp`/`parseKeywords`/`parseBacklinks` (and the shared `firstResultItems` envelope walker) return `[]` on any shape mismatch; a parse of an unexpected shape yields empty rows, not a throw.
- **Fixtures only — no live call in tests.** Verified against `src/seo/__fixtures__/dataforseo/serp.json`, `keywords.json`, and `backlinks.json` (3 rows, exercising the per-row backlinks cost `$0.02009`); a live API call in CI is a hard nonGoal. Keep the global-`fetch` reference confined to `adapters/http.ts` so the grep/scan confinement test stays green. Ahrefs/Semrush are explicitly out of scope.
- **Not wired into the analyzer/CLI/hub yet.** No `hub/finding.ts` import; egress/governor/data-source/local-export/parser/retriever/skills untouched; no new dependencies. `DataForSeoAdapter` fetches typed rows; turning those into findings is a later sprint.

## Scope

One commit — `3566d4e` — creating `src/seo/sources/dataforseo-adapter.ts` (352 lines: `DataForSeoAdapter` + the three total parsers + the shared envelope walker), `src/seo/sources/dataforseo-adapter.test.ts` (339 lines, 18 tests: axis-off zero-network + zero-book ×4, cost booked on success with `spentUsd` advancing exact ×4, budget-exceeded zero-socket ×2, 402/429/5xx/thrown-transport → abstain + zero-book ×4, the two `disabled` arms ×2, fetch confinement ×2), and three recorded DataForSEO fixtures under `src/seo/__fixtures__/dataforseo/`, plus an additive barrel edit to `src/seo/index.ts` (+1 line). No GSC/analyzer/runner/CLI/hub change; no Ahrefs/Semrush; no `hub/finding.ts` import; gsc/http/egress/governor/data-source/local-export/parser/retriever/skills untouched; no new dependencies. All 5 required criteria (sc-9-1..9-5) passed on **iteration 1**; full suite **4402 passed | 1 skipped | 0 failed** (DataForSEO 18 + GSC 14 tests). **This completes the SEO data plane** (offline + GSC + DataForSEO).
