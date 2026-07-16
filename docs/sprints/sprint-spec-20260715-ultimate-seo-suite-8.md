# GSC adapter — the first live `SeoDataSource` (search-console axis, fixture-tested)

**Contract:** sprint-spec-20260715-ultimate-seo-suite-8  ·  **Spec:** spec-20260715-ultimate-seo-suite  ·  **Completed:** 2026-07-16

## What this sprint added

The **first live-network data source** of the SEO suite. Two additive files landed: (1) `src/seo/adapters/http.ts` — a provider-agnostic injectable `HttpClient` seam whose `defaultHttpClient` is the **sole reference to the global `fetch` anywhere under `src/seo/`** (ADR-5 fetch-confinement); and (2) `src/seo/sources/gsc-adapter.ts` — `GscAdapter`, a live `SeoDataSource` that serves `searchAnalytics` + `urlInspection` from the real Google Search Console API **behind the `"search-console"` egress axis**, with the in-adapter egress+quota gate as the literal first two statements of every socket-opening method. `serp`/`keywords`/`backlinks` are not GSC capabilities and return `{ kind: "disabled" }` unconditionally (DataForSEO serves those in Sprint 9). The barrel `src/seo/index.ts` additively re-exports `GscAdapter` and the `HttpClient` types. This is the **template sprint 9 (DataForSEO) reuses** for the ADR-5 gate discipline and the injectable-transport pattern; no analyzer, runner, CLI, or hub wiring yet.

## Public surface

- `GscAdapter` (`src/seo/sources/gsc-adapter.ts:129`) — the live GSC `SeoDataSource`. Constructor: `new GscAdapter(egress, governor, http?, getAccessToken?)` — `egress: SeoEgressGuard` and `governor: SeoQuotaGovernor` are required; `http` defaults to `defaultHttpClient`; `getAccessToken` defaults to reading `process.env.GSC_OAUTH_TOKEN` (tests inject a fake `HttpClient` and stub the token so CI opens no socket).
- `GscAdapter.capabilities()` (`gsc-adapter.ts:142`) — returns exactly `["search-analytics", "url-inspection"]`.
- `GscAdapter.searchAnalytics(q)` (`gsc-adapter.ts:151`) — POSTs to `webmasters/v3/sites/{siteUrl}/searchAnalytics/query`; hard-caps `rowLimit` at **25,000** regardless of the caller's request; books the per-site scope into the governor and `record()`s the **actual** rows served on success. Returns `{ kind: "data", rows, provenance }` or `{ kind: "abstain", reason }` — never throws.
- `GscAdapter.urlInspection(q)` (`gsc-adapter.ts:208`) — POSTs to `searchconsole.googleapis.com/v1/urlInspection/index:inspect`; inspects exactly one URL per call (`estRows: 1`); an unrecognized response shape yields `abstain{unrecognized-response-shape}`. Never throws.
- `GscAdapter.serp` / `.keywords` / `.backlinks` (`gsc-adapter.ts:256,260,264`) — unconditional `{ kind: "disabled" }` (not GSC capabilities).
- `parseSearchAnalytics(raw, dimensions)` (`gsc-adapter.ts:61`) — pure, total parser; GSC echoes dimensions positionally in `keys[]`, so the caller-supplied `dimensions` order maps each key to its named field. Any shape mismatch degrades to `[]` (never throws).
- `parseUrlInspection(raw, url)` (`gsc-adapter.ts:99`) — pure, total parser of a single `inspectionResult.indexStatusResult`; `[]` on unrecognized shape.
- `HttpClient` (`src/seo/adapters/http.ts:37`) — the injectable transport interface: `request(url, init): Promise<HttpResponse>`.
- `HttpResponse` (`http.ts:23`) / `HttpRequestInit` (`http.ts:30`) — duck-typed `{ ok, status, json() }` and `{ method, headers?, body? }`; deliberately **not** the global `Response`/`RequestInit` types, so tests build fakes without touching the real fetch API.
- `defaultHttpClient` (`http.ts:46`) — the production transport = a thin wrapper over global `fetch`. **The one and only global-fetch reference under `src/seo/`.**
- Barrel `src/seo/index.ts:45-47` — additively re-exports `GscAdapter` and the `HttpClient` / `HttpResponse` / `HttpRequestInit` types.

## The ADR-5 in-adapter gate (the load-bearing invariant — sprint 9 copies this)

Every capability method that would open a socket begins with these **two gates, in order, before any network work** (`gsc-adapter.ts:154-173` for `searchAnalytics`, `:209-227` for `urlInspection`):

1. **Egress gate.** `this.egress.assertAllowed("search-console")` inside a `try`; it **throws** when the axis is off, and the `catch` converts that immediately to `{ kind: "abstain", reason: "egress-search-console-disabled" }` — **without opening a socket** and without ever hoisting the throw to the caller/runner.
2. **Quota gate.** `const decision = this.governor.admit(req)` — synchronous, never throws, no side effect. A refused admission returns `{ kind: "abstain", reason: decision.reason }` before any socket opens.

Only after **both** gates pass may the injected `HttpClient` make a request. Then:

- **`rowLimit` is hard-capped at 25,000** (`GSC_ROW_LIMIT_CAP`, `gsc-adapter.ts:51`): `Math.min(q.rowLimit ?? 25_000, 25_000)` — the cap is what both the admit estimate and the outbound request body use.
- **Per-site scope is threaded into the governor** via `scope: { siteUrl: q.siteUrl }` (per-user when available); `estCostUsd: 0` because GSC Search Analytics and URL Inspection are free.
- **Booking uses worst-case then actuals.** `admit()` pre-empts with the capped `estRows` (worst case); on a successful round-trip, `governor.record({ ...req, estRows: rows.length }, 0)` advances the shared ceiling by the **exact** rows served (URL Inspection records exactly 1).
- **Any live error degrades to abstain, never a throw.** A non-`ok` response maps to `{ kind: "abstain", reason: "gsc-http-<status>" }` (so 429/5xx are `abstain`, not exceptions); any network/parse error caught by the outer `try/catch` maps to `abstain{source-error}`. The evaluator verified `429`/`503`/thrown-transport all `.resolves` to abstain (never `.rejects`).

## The fetch-confinement invariant

`GscAdapter` references the real global `fetch` **nowhere** — it uses only the injected `HttpClient` (`../adapters/http.js`), defaulting to `defaultHttpClient`. `src/seo/adapters/http.ts` is the **single** file under `src/seo/` allowed to name the global `fetch`, so an ESLint boundary (and the test-suite grep/scan) can scope network access to exactly one seam. This mirrors the injectable-transport pattern already used by `src/medical/retrieval/medline-source.ts` and `src/medical/whoop/whoop-client.ts`, generalised to a `{ method, headers, body }` request shape that both GSC and DataForSEO (both plain JSON-over-HTTPS POST APIs) share. The zero-network guarantee is proven directly: with the axis OFF, a network-spy `HttpClient` records `toHaveLength(0)` calls while the method still resolves `abstain`; the same holds on a governor refusal.

## How to enable / how it fits

`GscAdapter` is inert until **both** the egress axis and a token are provided:

1. **Turn on the axis.** Set `seo.egress.search-console = true` in `bober.config.json` (default `false`; omitting the `seo` section leaves the whole suite byte-identical to before). This is the hard barrier — with it off, every GSC call abstains at zero network.
2. **Provide an OAuth bearer token.** Export `GSC_OAUTH_TOKEN` (a fully-formed access token; there is no refresh-grant flow in this sprint — see maintainer notes), or inject a custom `getAccessToken` in the constructor.

Intended call shape:

```ts
import { GscAdapter } from "./seo/index.js";
import { SeoEgressGuard } from "./seo/egress.js";
import { SeoQuotaGovernor } from "./seo/index.js";

const egress = SeoEgressGuard.fromConfig(config);
const governor = await SeoQuotaGovernor.load(".bober/seo/quota-ledger.json", config);
const gsc = new GscAdapter(egress, governor); // http + token default to prod (fetch + GSC_OAUTH_TOKEN)

const out = await gsc.searchAnalytics({
  siteUrl: "https://example.com",
  startDate: "2026-06-01",
  endDate: "2026-06-30",
  dimensions: ["query", "page"],
  rowLimit: 25_000, // capped at 25,000 regardless
});
if (out.kind === "data") {
  // out.rows: SearchAnalyticsRow[]; out.provenance = { source: "gsc", retrievedAt }
} // else out.kind === "abstain" (axis off, quota refused, or HTTP/parse error) — never a throw
```

`GscAdapter` is a **peer `SeoDataSource` implementation** (ADR-2) beside the offline `LocalExportSource` (Sprint 6): swapping a live source in is a new impl, not an analyzer change. It clears both front-door guards from earlier sprints — the `SeoEgressGuard` (Sprint 1, *is this axis allowed at all*) and the `SeoQuotaGovernor` (Sprint 7, *do we have quota/budget headroom*) — before touching the network.

## Notes for maintainers

- **The two-gate preamble order is load-bearing and evaluator-checked.** `assertAllowed("search-console")` then `governor.admit(...)` must remain the **first two statements** of any new socket-opening method. Sprint 9's DataForSEO adapter copies this exact shape (with its own axis + USD cost). Do not reorder, hoist, or wrap the gates behind other work.
- **No OAuth refresh flow here (deliberate).** Unlike `WhoopClient`, the access token is injected fully-formed via `getAccessToken` (default: `process.env.GSC_OAUTH_TOKEN ?? ""`). An expired/empty token surfaces as a GSC `4xx` → `abstain{gsc-http-<status>}`, not a crash. Add a refresh-grant + token store only when a later sprint wires one.
- **`record()` books actuals, `admit()` pre-empts worst-case.** `searchAnalytics` admits with the capped `rowLimit` but records `rows.length`; keep this split so the governor's daily-row ceiling reflects real usage, not the estimate.
- **Parsers are total and fail-closed.** Both `parseSearchAnalytics` and `parseUrlInspection` return `[]` (not throw) on any shape mismatch; GSC echoes Search Analytics dimensions **positionally**, so the row's named fields depend on the caller passing `dimensions` in the same order it requested them.
- **Fixtures only — no live call in tests.** The adapter is verified against `src/seo/__fixtures__/gsc/search-analytics.json` + `url-inspection.json`; a live API call in CI is a hard nonGoal. Keep the global-`fetch` reference confined to `adapters/http.ts` so the grep/scan confinement test stays green.
- **Not wired into the analyzer/CLI/hub yet.** No `hub/finding.ts` import; egress/governor/data-source/local-export/parser/retriever/skills untouched; no new dependencies. `GscAdapter` fetches typed rows; turning those into findings is a later sprint.

## Scope

One commit — `d070211` — creating `src/seo/adapters/http.ts` (55 lines: `HttpClient`/`HttpResponse`/`HttpRequestInit` + `defaultHttpClient`), `src/seo/sources/gsc-adapter.ts` (267 lines: `GscAdapter` + the two total parsers), `src/seo/sources/gsc-adapter.test.ts` (304 lines, 14 tests: axis-off zero-network spy ×2, fixture data + provenance + `governor.record` assertion, rowLimit-cap, per-site scope, governor-refused zero-network, 429/503/thrown-transport → abstain-not-throw via `.resolves`, the three `disabled` arms, and the fetch-confinement grep/scan), and two recorded GSC fixtures under `src/seo/__fixtures__/gsc/`, plus an additive barrel edit to `src/seo/index.ts` (+3 lines). No DataForSEO/analyzer/runner/CLI/hub; no new dependencies. All 5 required criteria (sc-8-1..8-5) passed on **iteration 1**; full suite **4384 passed | 1 skipped | 0 failed** (`src/seo` 94 passed).
