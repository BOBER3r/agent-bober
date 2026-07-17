# SEO / GEO Suite

An offline-first SEO/GEO capability that runs eight evidence-cited workflows
(technical, ranking, decay, topical, AI-visibility, parasite, internal-linking, schema)
over your site. One CLI (`bober seo <workflow> [target]`, `src/seo/command.ts:47`), a
`/bober-seo` orchestration skill, and two subagents (`bober-seo-strategist`,
`bober-seo-verifier`) share the same underlying `SeoWorkflowRunner`
(`src/seo/runner.ts`). The whole feature is **opt-in and offline by construction**: a
project's `bober.config.json` that omits the `seo` key runs byte-identically to a
project with no SEO suite at all, and even with `seo` present, the default data source
reads local files — no network call happens unless one of the egress axes below is
explicitly opted in.

---

## Quick Start

### CLI

```bash
bober seo <workflow> [target]
# or: agent-bober seo <workflow> [target]
```

Runs one of the 8 workflows end-to-end against `target` (a URL, domain, or local path;
falls back to `config.seo.defaultTarget` when omitted). Gathers data (offline by
default), retrieves the matching playbook signatures, analyzes, applies the citation
gate, persists a `SeoReport` to `.bober/seo/reports/<reportId>.json`
(`SeoReportStore`), best-effort emits cited findings into the priority hub, and prints:

```
SEO report <id>: verdict=<pass|blocked>, findings=<n>, droppedUncited=<n>
```

**Exit codes:**

| Code | Meaning |
|---|---|
| `0` | Pass — the citation gate did not trip `seo.blockThreshold`. |
| `2` | Blocked — either the threshold tripped, or the run failed closed (an unknown workflow, or the run threw). |
| `1` | Reserved for Commander's own usage errors — not a workflow outcome. |

An unrecognized `<workflow>` prints the valid list and exits `2` immediately with zero
report and zero hub emits (`src/seo/command.ts:55-62`).

### Skill

Invoke the `bober.seo` skill (Claude Code slash command `/bober-seo [workflow] [target]`
once distributed via `init`/`update-all`) for a conversational run. The skill routes to
the CLI for a scriptable result, or spawns `bober-seo-strategist`
(`agents/bober-seo-strategist.md`) for an analysis woven into the conversation,
optionally followed by `bober-seo-verifier` (`agents/bober-seo-verifier.md`) when
`seo.verifier.enabled` is set.

---

## The 8 workflows

| Workflow | Analyzes |
|---|---|
| `technical-audit` | Crawlability, indexing state, robots/sitemap, technical health |
| `rank-track` | Ranking position movement and SERP presence for tracked keywords |
| `content-decay` | Pages/queries losing clicks or position — refresh candidates |
| `topical-map` | Topical coverage and site-focus/site-radius gaps |
| `ai-visibility` | Brand/citation presence in AI answers (AI Overviews, ChatGPT, Perplexity, etc.) |
| `parasite-watch` | Third-party-host placement risk — **detect-only**, never recommends the tactic itself |
| `internal-linking` | Internal link structure, orphan pages, anchor-text distribution |
| `schema-audit` | Structured-data / entity markup coverage and validity |

Source of truth: `SEO_WORKFLOWS`, `src/seo/command.ts:27-36`.

---

## Egress axes (all default `false`)

The suite's live-data adapters are each gated behind their own default-off axis
(`SeoEgressGuard`, `src/seo/egress.ts`). Opting into one does **not** opt into any
other. Three axes now have a live adapter behind them (`search-console`,
`serp-provider`, `ai-visibility`); the fourth (`site-crawl`) now has a backing engine
too — `DamcrawlerCrawlEngine` (`src/seo/sources/damcrawler-crawl-engine.ts`) landed in
Sprint 6 — but its `SeoDataSource`
adapter — `CrawlSource` (`src/seo/sources/crawl-source.ts`, Sprint 7, serving
`url-inspection` + `link-graph`) — is still **not selected by the runner's
`selectSource`** (Sprint 9 / ADR-8 decides GSC-vs-crawl precedence), so enabling
`site-crawl` alone still does not change a `bober seo`
run today, and it additionally requires the optional `damcrawler`/`playwright` peer
deps to be installed (see **Optional site-crawl deps** below). The `ai-visibility`
adapter (`AiVisibilityAdapter`) likewise exists but is **not yet selected by the
runner's `selectSource`** (Sprint 9 wires it), so enabling that axis alone does not
change a `bober seo` run today; the adapter is usable only when constructed directly
with an injected provider.

| Axis | Config key | Gates |
|---|---|---|
| Google Search Console | `seo.egress.search-console` | Live search-analytics / URL-inspection API calls |
| DataForSEO | `seo.egress.serp-provider` | Live SERP / keyword / backlink API calls |
| AI-visibility (GEO) | `seo.egress.ai-visibility` | Live AI-answer / GEO provider probe (`AiVisibilityAdapter`) — **provider-agnostic, no vendor pinned; adapter exists but not yet router-wired (Sprint 9)** |
| Site crawl | `seo.egress.site-crawl` | damcrawler-backed crawl / URL-coverage / link-graph / SERP-scrape — **engine `DamcrawlerCrawlEngine` (Sprint 6) + adapter `CrawlSource` (Sprint 7, `url-inspection` + `link-graph`) exist but not yet router-wired (Sprint 9 / ADR-8); needs the optional `damcrawler`/`playwright` peer deps** |

The whole `seo.egress` object is `.optional()` — a config that omits it keeps all four
axes off, and the offline `LocalExportSource` needs none (`src/config/schema.ts:675-686`).
`SeoEgressGuard.assertAllowed` throws if a live adapter method is called against a
not-opted-in axis — a hard, code-enforced barrier every network-opening adapter must
call first.

A companion `seo.serp.provider` key (`'dataforseo' | 'damcrawler'`, default
`'dataforseo'`; `src/config/schema.ts:708-711`) selects which implementation serves the
`serp` capability. It is likewise inert until the provider it names is wired in a later
sprint.

The live `ai-visibility` adapter (`AiVisibilityAdapter`,
`src/seo/sources/ai-visibility-adapter.ts`) is **provider-agnostic by design (ADR-5)**:
no concrete AI-visibility vendor (Perplexity, Profound, etc.) is pinned or imported
anywhere under `src/seo/`. It depends on an injected `AiVisibilityProvider` port
(`{ name; estCostUsdPerPrompt; probe(target, prompts, locale) }`) whose concrete
implementation lives outside `src/seo/`; swapping providers means writing a new port
implementation, with no change to the adapter, the seam, or the egress model. The
adapter is egress-gated (`ai-visibility`) and USD-metered through the quota governor
(cost = `estCostUsdPerPrompt × prompts.length`, booked only after a successful probe;
a provider error abstains and books nothing). A single `ai-visibility` axis gates
every provider — there is no per-vendor axis.

### Optional site-crawl deps (`damcrawler` + `playwright`)

The `site-crawl` axis is backed by `DamcrawlerCrawlEngine`
(`src/seo/sources/damcrawler-crawl-engine.ts`; **ADR-9**), which loads the
[`damcrawler`](https://www.npmjs.com/package/damcrawler) scraper and its `playwright`
peer through a **lazy `import()`** — both are declared as **optional peer dependencies**
(`peerDependenciesMeta … optional: true`), **never** as `dependencies`, so they are
absent from a default install and `npm ci` still resolves cleanly. With the deps
absent every engine method returns `abstain{damcrawler-not-installed}` and never
throws; with the `site-crawl` axis off the engine never loads them at all, keeping the
all-axes-off path byte-identical. To opt in, install them and provision the browser:

```bash
npm i damcrawler playwright   # optional peers — absent by default
damcrawler setup              # installs Playwright Chromium + patchright stealth (runs `npx playwright install chromium --with-deps`)
```

Even with the deps installed and the axis on, no `bober seo` run reaches the engine
until Sprint 9 wires `CrawlSource` into the runner's `selectSource` — the `CrawlSource`
adapter itself (`url-inspection` + `link-graph`) landed in Sprint 7, but the router that
selects it is Sprint 9 / ADR-8. Crawled page free-text — the body **and** the `title`
and `url` (Sprint 7 finding F1) — passes through the fail-closed `ContentSanitizer`
(`src/seo/content-sanitizer.ts`; **ADR-11**) at the network→in-process boundary before
any row can reach the analyzer prompt, and `CrawlSource` re-sanitizes every field it
emits (defense-in-depth). Every caller-supplied crawl/probe URL is additionally checked
by an engine-boundary SSRF guard (`assertSafeUrl`, Sprint 7 finding F2) before any
network call — a private/link-local/loopback/metadata host or a non-`http(s)` scheme
abstains (`ssrf-blocked`) with zero underlying damcrawler calls.

---

## Offline import format (`.bober/seo/imports/`)

The default data source, `LocalExportSource` (`src/seo/sources/local-export.ts:35-52`),
reads **one file per capability** from `.bober/seo/imports/`, either a `.csv` or a
`.json` file with the matching basename:

| Capability | File basename |
|---|---|
| Search Console analytics | `search-analytics.csv` / `.json` |
| URL inspection | `url-inspection.csv` / `.json` |
| SERP positions | `serp.csv` / `.json` |
| Keyword data | `keywords.csv` / `.json` |
| Backlinks | `backlinks.csv` / `.json` |
| AI-visibility (GEO) | `ai-visibility.csv` / `.json` |
| Internal link graph | `link-graph.csv` / `.json` |

The `ai-visibility.csv` header is
`prompt,provider,mentioned,rank,citationPresent,sourceUrls`, where `sourceUrls` is a
single space-delimited cell (URLs never contain spaces). The `link-graph.csv` header is
`fromUrl,toUrl,anchor,internal` (flat edges, `internal` a boolean — the offline mirror
of `CrawlSource`'s live link-graph, added in Sprint 7). With it the offline source now
serves every capability.

A missing file for a capability resolves that capability to `disabled` — it does not
block the other capabilities or the run as a whole. An empty file (header only, or `[]`)
resolves to `abstain{empty-export}`. "Disabled" here means *no local file for this
capability*, not *axis off* — the offline path has no axis at all.

CSV files use a plain header row (first non-empty line) with one record per subsequent
line; quoted fields and embedded commas are supported. JSON files must be a top-level
array of objects with the same keys as the CSV header.

---

## Budget / verifier / target / threshold config

All fields live under the optional top-level `seo` key (`SeoConfigSchema`,
`src/config/schema.ts:668-699`), `.optional()` on `BoberConfig` with no top-level
default — omitting `seo` entirely means the parsed config has no `seo` key at all.

| Field | Type | Default | Effect |
|---|---|---|---|
| `egress` | `{ "search-console", "serp-provider", "ai-visibility", "site-crawl" }` (optional) | unset | The four live-data axes above (both `ai-visibility` and `site-crawl` have an engine/adapter — `site-crawl`'s `CrawlSource` adapter landed in Sprint 7 — but neither is router-wired yet; Sprint 9 wires both; `site-crawl` also needs the optional `damcrawler`/`playwright` peer deps). Omit entirely ⇒ byte-identical, all stay off. |
| `serp.provider` | `"dataforseo" \| "damcrawler"` (optional object, inner default) | `"dataforseo"` | Selects the SERP implementation for the `serp` capability. Omitting `serp` stays byte-identical. |
| `verifier.enabled` | `boolean` | `false` | Adversarial downgrade-only `bober-seo-verifier` stage — see Guardrails below. |
| `budget.maxUsd` | `number` (optional) | unset | Per-run USD ceiling for PAYG DataForSEO calls (reuses `BudgetSectionSchema`). Absent = uncapped. |
| `defaultTarget` | `string` (optional) | unset | Used when the CLI omits `[target]`. |
| `blockThreshold` | `"never" \| "any-uncited" \| "critical-uncited"` | `"critical-uncited"` | CI exit-code gate — which citation-gate outcomes trip exit code `2`. |

**Annotated example:**

```jsonc
"seo": {                              // Optional. Omit entirely => byte-identical (no key, no defaults).
  "egress": {                         // Optional. Omit => byte-identical; all axes stay off.
    "search-console": false,          // Google Search Console API egress. Default false.
    "serp-provider": false,           // DataForSEO SERP/keywords/backlinks egress. Default false.
    "ai-visibility": false,           // AI-answer/GEO provider egress. Default false. Adapter exists (provider-agnostic); not yet router-wired (Sprint 9).
    "site-crawl": false               // damcrawler crawl/link-graph/SERP-scrape egress. Default false. Engine (DamcrawlerCrawlEngine) + CrawlSource adapter exist; not yet router-wired (Sprint 9); needs optional damcrawler/playwright peer deps.
  },
  "serp": { "provider": "dataforseo" }, // Optional. Which SERP impl serves `serp`. Omit => byte-identical.
  "verifier": { "enabled": false },   // Adversarial downgrade-only verifier stage. Default false.
  "budget": { "maxUsd": 5 },          // Per-run USD ceiling for PAYG DataForSEO calls. Absent = uncapped.
  "defaultTarget": "https://example.com", // Used when the CLI omits [target].
  "blockThreshold": "critical-uncited"    // CI exit-code gate: never | any-uncited | critical-uncited.
}
```

---

## Guardrails

- **Never-encode tactics are dropped by three independent belts.** A banned tactic
  (parasite SEO, expired-domain plays, paid/bought links, PBN/link schemes, mass AI
  pages, cloaking, doorway pages, AI-recommendation poisoning) is stopped at any of three
  layers, so no single failure can let one through:
  1. **Parse-time drop.** Every playbook signature block (`skills/bober.seo-*/SKILL.md`)
     requires a `PrimarySourceUrl`; a block missing one, or tagged
     `PolicyClass: never-encode`, is dropped by `SeoPlaybookParser` before it can ever
     reach an analysis prompt (`skills/bober.seo-generic/SKILL.md:31-40`). The shipped
     `parasite-seo-placement` signature (`skills/bober.seo-generic/SKILL.md:163-171`) is
     the concrete example: it documents the policy violation for human readers but is
     `never-encode`, so `parasite-watch` can only ever detect exposure, never recommend
     the tactic.
  2. **Skill-content lint.** A `FORBIDDEN_ACTION_PATTERNS` guard
     (`skills-content.test.ts`) empirically asserts that no *surviving* authored block
     instructs a banned tactic — a build-time backstop on the skill libraries.
  3. **Runtime `NeverEncodeFilter`.** A pure, total, DROP-only filter
     (`src/seo/never-encode-filter.ts`, 9 regexes covering all 8 classes) runs inside
     `SeoWorkflowRunner.run` *after* the analysis parse-check and *before* the citation
     gate. Belts 1 and 2 only see tactics authored into a skill file; this belt catches a
     banned tactic the LLM analyzer **synthesized at runtime** — even one carrying a
     well-formed `citationUrl` that would otherwise pass the citation gate. It is
     DROP-only (it removes the offending finding without failing the run) and never
     throws; its drop count surfaces on the report as `droppedNeverEncode`.
- **`humanApprovalRequired` findings.** Any recommendation touching policy compliance
  (paid links, cloaking, structured-data misuse) or spend (ad budget, paid placements,
  a metered live-API call) is flagged `humanApprovalRequired: true` by the strategist
  and needs a human before acting on it.
- **Citation discipline.** Every finding must carry a `citationUrl` pointing at a
  primary source. The deterministic `SeoCitationGate` drops any finding with a missing
  or malformed citation before it reaches a report or the hub — the LLM's own judgment
  never bypasses this gate (`skills/bober.seo-generic/SKILL.md:31`).
- **Documented ≠ live-weight (confidence downgrade).** Each playbook signature carries a
  soft `LiveWeightStatus: live-corroborated|documented-only|unknown` field
  (`skills/bober.seo-generic/SKILL.md:34`; defaults to `unknown` if absent/invalid). A
  finding the analyzer grounds in a `documented-only` signature can never be emitted as
  `firm` — `analyzer.toSeoFinding` downgrades it to `tentative`, because guidance that is
  merely documented is not (yet) corroborated by a live ranking signal. The rule is
  **downgrade-only** (`live-corroborated`/`unknown` change nothing; nothing is ever
  upgraded) and the field lives on the signature only, not on `SeoFinding` (ADR-2). The
  shipped leak-derived ranking-mechanics signatures (siteAuthority, NavBoost,
  contentEffort, siteFocus/siteRadius, hostAge, date-consistency, named-demotions, and
  the two leak-derived vertical blocks) are graded `documented-only`, so findings grounded
  in them are capped at `tentative`; the `gsc-url-inspection-*` signatures stay `unknown`
  because they document a live API, not a leaked ranking signal.
- **Finder → verifier (opt-in).** When `seo.verifier.enabled` is `true`, a second,
  fresh-context read-only pass (`bober-seo-verifier`) tries to disprove each of the
  strategist's findings. It is strictly downgrade-only (confirm / downgrade-by-one /
  drop — never promote or add) and fail-closed (an unparseable/aborted verification
  keeps the findings unchanged).

---

## FAQ

**Do I need any API key to use this?**
No. The default data source reads `.bober/seo/imports/` — omit both egress axes and
every workflow runs entirely offline against your own exported data.

**How do I turn on live data?**
Set the matching axis to `true` under `seo.egress` in `bober.config.json`, and provide
the corresponding credentials as environment variables: `GSC_OAUTH_TOKEN` for
`search-console`, and `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` for `serp-provider`.
Each axis is independent; turning one on does not affect the other.

**Why does `parasite-watch` never suggest placing content on a third-party host?**
Because that tactic is a named Google site-reputation-abuse policy violation, its
playbook signature is tagged `PolicyClass: never-encode` and is dropped by the parser
before any analysis prompt sees it — the workflow can only ever flag exposure risk, not
recommend the tactic. See Guardrails above.
