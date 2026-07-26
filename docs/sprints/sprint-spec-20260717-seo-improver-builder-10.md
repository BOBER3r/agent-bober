# Phase-1 benchmark cases (never-encode-drop + liveweight-downgrade proofs) + docs completion — Phase 1 complete

**Contract:** sprint-spec-20260717-seo-improver-builder-10  ·  **Spec:** spec-20260717-seo-improver-builder  ·  **Completed:** 2026-07-17

## What this sprint added

The closing sprint of **Phase 1 (advisory-elite)**. It extends the offline benchmark
corpus (from the prior `spec-20260715-ultimate-seo-suite` Sprint 13) with **four new
cases (6 → 10)** that mechanistically exercise the Phase-1 capabilities and safety
behaviors, and **completes `docs/seo.md`** so it documents all four egress axes end to
end. No production code, config, or dependency changed — the sprint is pure benchmark
data + test + docs (three files: `manifest.json`, `harness.test.ts`, `docs/seo.md`).

The load-bearing addition is `kb-never-encode-cited-drop`: it upgrades the never-encode
benchmark proof from the honest-but-weaker Sprint-13 form (a never-encode case authored
*uncited*, so the drop went through the citation gate) to a case that proves the
**runtime `NeverEncodeFilter`** (this spec's Sprint 2, the third never-encode belt) drops
a cloaking tactic that carries a **well-formed, gate-passing citation** — the drop is
attributed to the filter (`droppedNeverEncode === 1`), not the citation gate
(`droppedUncited === 0`). The harness drives the **real** `SeoWorkflowRunner` per case at
zero egress and zero credentials, so these are executable proofs, not assertions.

## New benchmark cases (`src/seo/benchmark/corpus/manifest.json`)

Each case injects offline import CSVs into a temp `.bober/seo/imports/`, scripts the
analyzer's JSON response, and captures the emitted hub findings via `runBenchmark`.

- **`kg-ai-visibility-offline`** (known-good, `ai-visibility` workflow) — imports
  `ai-visibility.csv` (`prompt,provider,mentioned,rank,citationPresent,sourceUrls`). One
  firm, cited finding (`ai-visibility-branded-mention-audit`) reaches the sink; the test
  additionally asserts `dataProvenance` contains a path ending `ai-visibility.csv`,
  proving the **offline ai-visibility capability was actually read** (not skipped).
- **`kg-link-graph-offline`** (known-good, `internal-linking` workflow) — imports
  `link-graph.csv` (`fromUrl,toUrl,anchor,internal`). One firm, cited finding
  (`sitefocus-internal-consolidation`) reaches the sink; the test asserts `dataProvenance`
  contains a path ending `link-graph.csv`, proving the **offline link-graph capability was
  read**.
- **`kb-never-encode-cited-drop`** (known-**bad**, `technical-audit` workflow) — the
  analyzer synthesizes a cloaking recommendation (`seo.technical-audit.cloak-googlebot`,
  severity 4) carrying a **valid** `citationUrl` (`developers.google.com/.../spam-policies`,
  well-formed → would pass the citation gate). Expected: **0 emitted**, verdict `pass`,
  `report.droppedNeverEncode === 1`, `report.droppedUncited === 0`. Proves the drop is by
  the runtime filter, not the gate.
- **`kg-liveweight-downgrade`** (known-good, `topical-map` workflow) — the analyzer emits
  a **`firm`** finding grounded in a `documented-only` leak-derived signature
  (`sitefocus-topical-authority`). Expected: 1 emitted, but the emitted finding's
  `confidence` is downgraded **firm → tentative** by `analyzer.toSeoFinding`, and the hub
  finding carries the `confidence:tentative` tag (not `confidence:firm`). Proves this
  spec's Sprint-3 "documented ≠ live-weight" downgrade end to end.

All reused citation URLs (ahrefs GEO blog, the SparkToro Content-Warehouse-leak writeup,
Google spam policies) are ones already curl-verified HTTP-200 in earlier sprints.

## Test surface (`src/seo/benchmark/harness.test.ts`)

Four new `it` blocks under the existing `runBenchmark — precision/recall report` describe
assert the above per-case outcomes (exit code, emitted count + `playbook:`/`confidence:`
tags, `verdict`, `droppedNeverEncode`/`droppedUncited`, and `dataProvenance` paths). The
pre-existing corpus-wide **zero-network** (a `createClient` mock that throws if any real
provider is constructed) and **determinism** (two independent temp-root runs yield
identical metrics) tests now cover all 10 cases automatically.

## docs/seo.md completion

The FAQ was the last Phase-1-stale spot:

- *"Do I need any API key?"* — corrected "omit both egress axes" → **"omit all four
  egress axes"** (`search-console`, `serp-provider`, `ai-visibility`, `site-crawl`).
- *"How do I turn on live data?"* — replaced the two-axis answer with a per-axis list
  including `ai-visibility` (no creds; routes to the offline `LocalExportSource` arm
  because no vendor is pinned) and `site-crawl` (no API key; needs the optional
  `npm i damcrawler playwright && damcrawler setup` peer-dep flow).
- Bumped the `SeoConfigSchema` line reference `src/config/schema.ts:668-699` → `668-714`
  to match the widened schema.

The rest of `docs/seo.md` (the four-axis Egress table, the Pipeline-wiring section, the
`serp.provider` key, and the annotated config example showing the two new default-false
axes with the byte-identical note) was already completed by Sprints 5–9; this sprint only
closed the FAQ gap.

## Notes for maintainers

- **`kb-never-encode-cited-drop` is the honesty upgrade over Sprint-13.** If you touch the
  `NeverEncodeFilter` (`src/seo/never-encode-filter.ts`) or move where it runs relative to
  the citation gate in `SeoWorkflowRunner.run`, this case's `droppedNeverEncode === 1` /
  `droppedUncited === 0` split is the regression tripwire — a cloaking finding that starts
  passing the gate (or getting dropped *as uncited*) means the runtime belt regressed.
- **The two `dataProvenance` path assertions are capability-read proofs.** They fail if
  `gatherDataBundle` stops probing the `ai-visibility` / `link-graph` capabilities for
  those workflows (`WORKFLOW_CAPABILITIES`, Sprint 9) — i.e. they guard the wiring, not
  just the analyzer output.
- **This sprint completes Phase 1 (advisory-elite).** Phase-2 (builder) benchmark cases
  and docs are deliberately out of scope (deferred to the plan's later builder sprints),
  as is the `npm run update-all` skill/agent sync. No production code was touched.

## Scope

One commit on `bober/medical-team`:

- **`849db43`** — `bober(sprint-10): Phase-1 benchmark corpus cases + docs completion`.
  Three files: `src/seo/benchmark/corpus/manifest.json` (+60, the four cases),
  `src/seo/benchmark/harness.test.ts` (+49, the four `it` blocks), `docs/seo.md` (+18/−7,
  FAQ + line-ref). Passed **iteration 1**; all four criteria (sc-10-1..sc-10-4) verified;
  build/typecheck/lint clean; suite **4654 passed | 1 skipped** (benchmark harness 18/18);
  zero regressions. `package.json` untouched; no Phase-2 content.
