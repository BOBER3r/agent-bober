# CapabilitySeoRouter + selectSource (4-axis) + gatherDataBundle integration

**Contract:** sprint-spec-20260717-seo-improver-builder-9  ·  **Spec:** spec-20260717-seo-improver-builder  ·  **Completed:** 2026-07-17

## What this sprint added

This is the **integration linchpin** that finally wires Sprints 5/7/8 into
`SeoWorkflowRunner.run`. It replaces the two-adapter `CompositeSeoSource` with a
capability-keyed **`CapabilitySeoRouter`**, rewrites `selectSource` to assemble a route
table across **all four** egress axes (was two), and extends `gatherDataBundle` with the
`aiVisibility` + `linkGraph` arms plus a **`WORKFLOW_CAPABILITIES`** subset map so a
metered capability is fetched only for the workflows that actually consume it (ADR-7).
After this sprint the SEO pipeline is **fully wired end-to-end** — opting into an axis now
changes a `bober seo` run (previously the S5/S7/S8 adapters existed but were never
selected).

The all-four-axes-off default remains **byte-identical**: `selectSource` returns
`LocalExportSource` as its first statement before any governor/socket/`import('damcrawler')`
is constructed (sc-9-2 / sc-9-5, golden-snapshot verified).

**Security note — Sprint-7 F1 was reopened and re-closed (this is the load-bearing
lesson of this sprint).** Iteration 1 passed all five functional criteria but **FAILED the
mandated F1 security check**: `selectSource` wired `CrawlSource` with an **identity**
sanitizer (`(raw) => ({ content: raw, hadThreats: false })`), and the real
`ContentSanitizer(dam.sanitize)` lived only inside `DamcrawlerCrawlEngine.crawl()` — which
`CrawlSource` never calls. `CrawlSource` only calls `engine.linkGraph()` and
`engine.urlVisibility()`, **neither of which sanitized**, so an attacker-controlled anchor
/ `fromUrl` / `toUrl` from a crawled page reached the analyzer's `JSON.stringify` prompt
**unsanitized** end-to-end for the `internal-linking` workflow. Iteration 2 closed it at
the **engine boundary**: `linkGraph()` and `urlVisibility()` now sanitize every row field
via the same real `dam.sanitize`-backed `ContentSanitizer` that `crawl()` already used, so
**every** engine method sanitizes at the network→in-process boundary. The takeaway:
**an identity sanitizer that silently becomes the *sole* layer is a critical regression, not
harmless defense-in-depth softening — the "redundant" second layer must be genuinely
redundant, i.e. a real first layer has to exist beneath it.**

## Public surface

- `CapabilitySeoRouter` (`src/seo/runner.ts:164`, module-private) — implements
  `SeoDataSource` over `routes: Partial<Record<SeoCapability, SeoDataSource>>`, dispatching
  each capability method to `routes[cap] ?? DISABLED_SOURCE`. `capabilities()` returns
  `Object.keys(routes)` (the routed keys, **not** each source's own advertised set). An
  unrouted capability resolves `{ kind: "disabled" }`; the router **never throws** (sc-9-1).
  Replaces the deleted `CompositeSeoSource`.
- `DISABLED_SOURCE` (`src/seo/runner.ts:145`, module-private) — a shared stub whose every
  method resolves `{ kind: "disabled" }`; the router's fallback for any unrouted capability.
- `SerpProviderSource` (`src/seo/runner.ts:207`, module-private) — adapts a Sprint-8
  `SerpProvider` port's `serp(keyword, location)` into this seam's
  `serp(SerpQuery)`; serves only `serp`, every other capability disabled. `q.priority` is
  dropped (byte-identical — `DataForSeoAdapter.serp` already defaults absent priority to
  `"standard"`).
- `selectSource(config, projectRoot)` (`src/seo/runner.ts:259`, exported) — rewritten for
  four axes. All-off ⇒ `LocalExportSource` (first statement, zero construction). Otherwise
  loads the `SeoQuotaGovernor` once and assembles a `CapabilitySeoRouter` per the ADR-8 /
  ADR-10 route table (see below).
- `WORKFLOW_CAPABILITIES` (`src/seo/workflow-capabilities.ts:28`, exported) — an
  **exhaustive** `Record<SeoWorkflow, SeoCapability[]>` (ADR-7). Every pre-existing
  workflow keeps exactly the five `CORE` capabilities (`search-analytics`, `url-inspection`,
  `serp`, `keywords`, `backlinks`); `ai-visibility` adds `"ai-visibility"`, `parasite-watch`
  adds `"ai-visibility"`, and `internal-linking` adds `"link-graph"`. `technical-audit`
  stays `CORE` (must NOT list the metered `ai-visibility` — sc-9-4 / stopCondition).
- `SeoDataBundle` (`src/seo/analyzer.ts:54`) — gains optional `aiVisibility?` and
  `linkGraph?` arms; an omitted arm renders as **"not requested"** via `describeDataOutcome`
  (`analyzer.ts:139`), not an error. `collectDataProvenance` includes the two new arms.

### Route table assembled by `selectSource` (sc-9-3)

| Capability | Routed to | Condition |
|---|---|---|
| `search-analytics` | `GscAdapter` | `search-console` on |
| `url-inspection` | `GscAdapter` (ADR-8: GSC always wins) → else `CrawlSource` | `search-console` on; else `site-crawl` on |
| `link-graph` | `CrawlSource` | `site-crawl` on |
| `keywords`, `backlinks` | `DataForSeoAdapter` | `serp-provider` on |
| `serp` | `resolveSerpProvider(config)` result, wrapped in `SerpProviderSource` (ADR-10) | `serp-provider` **or** `site-crawl` on |
| `ai-visibility` | `LocalExportSource` (the **offline** arm) | `ai-visibility` on |

## How to use / how it fits

`SeoWorkflowRunner.run` now threads `input.workflow` into `gatherDataBundle(source,
workflow, target, now)`, which probes **only** `WORKFLOW_CAPABILITIES[workflow]` — an
omitted capability is never called on `source` at all (not called-then-discarded), so a
`technical-audit` run incurs **zero** cost/network on the metered `ai-visibility` capability.
No CLI surface changed; the behavior change is that opting into an egress axis now actually
routes live data through the pipeline.

**`ai-visibility` axis routes to the offline arm, deliberately.** No concrete
`AiVisibilityProvider` is pinned yet (Sprint 5 shipped the provider-agnostic
`AiVisibilityAdapter` but no vendor), so wiring the live adapter would force a bogus
provider argument. Enabling the `ai-visibility` axis therefore routes to `LocalExportSource`
(reads `ai-visibility.csv`/`.json` if present, else disabled/abstain). The live
`AiVisibilityAdapter` remains unselected until a provider is chosen — the marked follow-up
is to swap the offline arm for `new AiVisibilityAdapter(egress, governor, provider)` in
`selectSource`.

## Notes for maintainers

- **Identity sanitizers that become the sole layer are dangerous (the F1 lesson).** The
  iteration-1 regression was an identity sanitizer on `CrawlSource` that silently became the
  only "sanitization" on the link-graph path because the engine methods `CrawlSource`
  actually calls (`linkGraph`/`urlVisibility`) did not sanitize. Sanitize
  **attacker-controlled free-text at the boundary where it enters the process**, in every
  method that produces rows — `anchor`, `fromUrl`, `toUrl` (a crawled page controls all
  three) and the inspection `url` are all attacker-controlled. `CrawlSource`'s own sanitizer
  is left as identity **on purpose now** and is genuinely redundant only because the engine
  is the real first layer; its `bober:` ceiling comment documents the upgrade path
  (thread a real `dam.sanitize` through if `CrawlSource` is ever given its own loader).
- **`WORKFLOW_CAPABILITIES` is exhaustive, not `Partial`.** A missing `SeoWorkflow` key is a
  compile error, not a silent capability gap. Adding/removing a `CORE` capability for an
  existing workflow would change `dataProvenance` and break the byte-identical golden report
  (sc-9-5) — change `CORE` membership only with intent.
- **Keep the all-off `LocalExportSource` return the first statement.** It must precede
  `SeoQuotaGovernor.load` so the all-off path provably constructs no governor, opens no
  socket, and never evaluates `import('damcrawler')` (sc-9-2). The governor loads once on
  the not-all-off branch and is shared by every routed adapter.
- **`DataForSeoAdapter` is built unconditionally on the not-all-off branch** and reused for
  `keywords`/`backlinks` and as the `resolveSerpProvider` dependency — each routed method
  self-gates its own axis on call, so constructing it is inert until a routed method runs.

## Scope

Two commits on `bober/medical-team`:

- **`56f2f23`** (iteration 1) — `CapabilitySeoRouter` + 4-axis `selectSource` +
  `gatherDataBundle` capability map. Four files: `src/seo/runner.ts` (+244/−61),
  `src/seo/runner.test.ts` (+304), new `src/seo/workflow-capabilities.ts` (+37),
  `src/seo/analyzer.ts` (+25). All five functional criteria (sc-9-1..9-5) passed, but the
  mandated F1 security check FAILED the sprint (critical link-graph prompt-injection
  regression).
- **`923f39d`** (iteration 2 fix) — sanitize link-graph/url-inspection row free-text at the
  `DamcrawlerCrawlEngine` boundary. Four files: `src/seo/sources/damcrawler-crawl-engine.ts`
  (+31/−13; `linkGraph()` at `:234` and `urlVisibility()` at `:199` now build a
  `ContentSanitizer(dam.sanitize)` and clean every field, mirroring `crawl()`),
  new `src/seo/sources/damcrawler-crawl-engine.test.ts` (+79), new end-to-end
  `src/seo/runner.link-graph-security.test.ts` (+94, exercises the **real** `selectSource`
  production factory with a scripted damcrawler returning a `<system>…</system>` anchor and
  asserts it is stripped), and an 18-line comment/wiring update in `src/seo/runner.ts`.

Iteration 2 PASSED all five criteria with F1 **closed** (verified engine-unit **and**
end-to-end through the real factory); zero regressions; full suite **4650 passed | 1
skipped**. The offline golden report is unchanged by the fix (it touches only the
`site-crawl`-on branch).
