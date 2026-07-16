# Offline data layer — SeoDataSource seam + LocalExportSource

**Contract:** sprint-spec-20260715-ultimate-seo-suite-6  ·  **Spec:** spec-20260715-ultimate-seo-suite  ·  **Completed:** 2026-07-16

## What this sprint added

The **data plane** of the SEO suite begins here. Two additive pieces landed: (1) `src/seo/data-source.ts` — the unified `SeoDataSource` seam (ADR-2): the interface every provider implements, its five capabilities, the five `Query`/`Row` type pairs, and a re-export (never a redefine) of the Sprint-1 `DataOutcome`/`DataProvenance` union; and (2) `src/seo/sources/local-export.ts` — `LocalExportSource`, the **zero-egress backbone** that parses crawl output + GSC/SERP exports dropped under `.bober/seo/imports/` (one file per capability, `<capability>.csv` or `.json`) at **zero egress and zero credentials**, using a hand-rolled zero-dependency CSV parser and stamping real `fs.stat` provenance (`path` + `mtimeMs`) on every data-bearing outcome. `src/seo/types.ts` gained an additive optional `path?`/`mtimeMs?` on `DataProvenance` for freshness auditing. No live GSC/DataForSEO adapters, analyzer, governor, CLI, or hub emitter yet — those are later sprints; this sprint proves the seam and the offline path against fixtures.

## Public surface

- `SeoDataSource` (`src/seo/data-source.ts:108`) — the interface every data provider (offline or live) implements. `capabilities(): SeoCapability[]` advertises only what it can serve; the five capability methods `searchAnalytics` / `urlInspection` / `serp` / `keywords` / `backlinks` each return a `Promise<DataOutcome<Row[]>>` and — per the discipline mirrored from medical's `RetrievalOutcome` — **never throw** to the caller.
- `SeoCapability` (`src/seo/data-source.ts:20`) — the five-member capability union: `"search-analytics" | "url-inspection" | "serp" | "keywords" | "backlinks"`.
- Query types (`src/seo/data-source.ts:29-47`) — `SearchAnalyticsQuery`, `UrlInspectionQuery`, `SerpQuery`, `KeywordQuery`, `BacklinkQuery` (quoted from architecture lines 183-212).
- Row types (`src/seo/data-source.ts:54-96`) — `SearchAnalyticsRow`, `UrlInspectionRow`, `SerpRow`, `KeywordRow`, `BacklinkRow`. **Their keys mirror the CSV headers 1:1** (`.bober/seo/imports/<capability>.csv`) — a header typo silently drops a column.
- `DataOutcome<T>` / `DataProvenance` — **re-exported** from `./types.js` (`src/seo/data-source.ts:15`), the canonical Sprint-1 union; deliberately never redefined here.
- `LocalExportSource` (`src/seo/sources/local-export.ts:206`) — the offline `SeoDataSource`. Constructor takes an optional `exportDir` (default `.bober/seo/imports`; tests inject an absolute fixture path). `load()` scans the dir once (memoised) for `<capability>.csv`/`.json` files; `capabilities()` returns the present set (`[]` before `load()`); every capability method resolves through the shared `readCapability` read path.
- `parseCsv(text)` (`src/seo/sources/local-export.ts:98`, **exported**) — the pure, total, zero-dependency CSV reader: first non-empty line is the header, honors quoted fields (embedded commas + escaped `""`), `\r\n`/`\n` endings, and a trailing blank line; header-only or empty (or non-string) input returns `[]`, and it **never throws**.
- Barrel `src/seo/index.ts` — additively re-exports the seam types + `LocalExportSource`.

## The disabled / abstain / data outcome contract

`LocalExportSource` never throws out of any capability method. The three arms map deterministically (`readCapability`, `src/seo/sources/local-export.ts:278`):

- **`{ kind: "disabled" }`** — no local file exists for that capability (here `disabled` means *no import file*, not *egress axis off* — this source has no axis and no transport). A missing export directory degrades **every** capability to `disabled`.
- **`{ kind: "abstain", reason }`** — a present-but-parseable-but-empty input: a header-only CSV (or `[]` JSON) yields `reason: "empty-export"`; any fs/parse/`stat` error yields `reason: "source-error"` (fail-closed, never fail-open).
- **`{ kind: "data", rows, provenance }`** — parsed rows plus provenance `{ source: "local-export", retrievedAt, path, mtimeMs }` from a real `fs.stat`, so every data-bearing outcome is freshness-auditable (sc-6-4).

## The `.bober/seo/imports/` file convention (user-facing)

**This is the import format future docs and later sprints reference.** Drop **one file per capability** under `.bober/seo/imports/`, named `<capability>.csv` or `<capability>.json` (CSV preferred if both exist for the same capability). The recognized basenames are exactly the five `SeoCapability` values: `search-analytics`, `url-inspection`, `serp`, `keywords`, `backlinks`. CSV column headers (and JSON object keys) must match the corresponding `Row` type keys 1:1 — e.g. `search-analytics.csv` header is `query,page,country,device,clicks,impressions,ctr,position`. Numeric columns are coerced from strings (non-finite → `0` for required fields, `undefined` for optionals); `dofollow` reads `true`/`1` as `true`. JSON files must contain a top-level array of row objects.

Example `search-analytics.csv` (quoted-comma field stays one column):

```csv
query,page,country,device,clicks,impressions,ctr,position
best online casino,/reviews/best-online-casino,"Berlin, DE",mobile,142,3800,0.0374,4.2
```

## How to use / how it fits

Nothing new runs on its own yet — `LocalExportSource` is the offline arm of the seam that the analyzer (Sprint 10) and the live `gsc`/`dataforseo` adapters (Sprints 8-9) will sit beside. The intended shape:

```ts
import { LocalExportSource } from "./seo/index.js";

const src = new LocalExportSource(); // defaults to .bober/seo/imports
await src.load();                    // scans once (memoised); optional — methods self-load
const out = await src.searchAnalytics({
  siteUrl: "https://example.com",
  startDate: "2026-06-01",
  endDate: "2026-06-30",
  dimensions: ["query"],
});
if (out.kind === "data") {
  // out.rows: SearchAnalyticsRow[]; out.provenance.mtimeMs for freshness
}
```

The live adapters will be **peer `SeoDataSource` implementations** behind the two egress axes — swapping in a live source is a new impl, not an analyzer change (ADR-2). The query arg is accepted for interface symmetry but is not used by the offline source (it returns the whole imported file for the capability); date/keyword filtering is a live-adapter concern.

## Notes for maintainers

- **Zero-egress is the load-bearing guarantee, and it is proved two ways.** (1) A grep for `fetch`/`http`/`axios`/`undici`/`node-fetch` under `src/seo/` returns no matches in shipped source — `LocalExportSource` imports only `node:fs/promises`, `node:path`, and the repo's `readJson`. (2) A **forced-fetch-throw** test (`local-export.test.ts:108`) replaces `globalThis.fetch` with a function that throws and asserts the offline path still resolves `data` — proving no capability method opens a socket. Keep it that way: this source takes no `EgressGuard` and no transport by construction.
- **`DataProvenance` was extended additively.** `path?`/`mtimeMs?` are optional (same idiom as `costUsd?`), set only by file-backed sources, so `gsc`/`dataforseo` provenance stays byte-compatible. Do not make them required.
- **`DataOutcome`/`DataProvenance` are re-exported, not redefined.** The canonical union lives in `src/seo/types.ts` (Sprint 1). `data-source.ts` re-exports it so callers can import the seam and the outcome from one module; never fork a second definition.
- **Row keys and CSV headers are one contract.** The `Row` types in `data-source.ts` and the per-capability mappers in `local-export.ts` must stay in lockstep with the header names in `.bober/seo/imports/<capability>.csv`. A header typo does not error — it silently drops that column to its default. If you add a column, update the `Row` type, the mapper, and this file's convention section together.
- **CSV parser is hand-rolled on purpose.** No CSV/tabular parser exists anywhere in the repo and none was added (no new deps). `parseCsv` is exported so its edge cases (quoted commas, escaped `""`, CRLF, trailing blank line, non-string totality) are tested directly.
- **`fetch` monkeypatch test caveat.** The zero-network test temporarily reassigns `globalThis.fetch` inside a `try/finally`; it restores the original in `finally`. It asserts behavior, not a spy — do not convert it to a call-count assertion without also guarding against parallel-test fetch users.

## Scope

One commit — `9eecdf2` — creating `src/seo/data-source.ts`, `src/seo/sources/local-export.ts`, `src/seo/sources/local-export.test.ts` (16 tests: data+provenance, `disabled` ×3 + missing-dir, `abstain` header-only, forced-fetch-throw zero-network, and 8 `parseCsv` edge cases), and two fixtures (`__fixtures__/imports/search-analytics.csv` populated + `serp.csv` header-only), plus additive edits to `src/seo/types.ts` (+5 lines: `path?`/`mtimeMs?`) and `src/seo/index.ts` (barrel re-exports). No adapters, governor, analyzer, runner, CLI, or hub emitter; no `hub/finding.ts` import; parser/retriever/playbook-index/skills untouched; no new dependencies. All 5 required criteria (sc-6-1..6-5) passed on **iteration 1**; full suite **4356 passed | 1 skipped | 0 failed** (`src/seo` 66 passed).
