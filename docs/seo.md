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
other. **As of Sprint 9 all four axes are wired into the runner's `selectSource`**
(`src/seo/runner.ts:259`), which assembles a capability-keyed `CapabilitySeoRouter` per
the ADR-8/ADR-10 route table — so opting into an axis now actually routes data through a
`bober seo` run (see **Pipeline wiring** below). The `site-crawl` axis is backed by
`DamcrawlerCrawlEngine` (`src/seo/sources/damcrawler-crawl-engine.ts`, Sprint 6) through
its `CrawlSource` adapter (`src/seo/sources/crawl-source.ts`, Sprint 7, serving
`link-graph` and — per ADR-8, only when `search-console` is off — `url-inspection`); it
additionally requires the optional `damcrawler`/`playwright` peer deps to be installed
(see **Optional site-crawl deps** below). The `ai-visibility` axis is wired too, but
because **no concrete AI-visibility provider is pinned yet** (Sprint 5) it routes to the
**offline `LocalExportSource` arm** (reads `ai-visibility.csv`/`.json` if present) rather
than to the live `AiVisibilityAdapter` — that adapter stays usable only when constructed
directly with an injected provider, pending a provider-selection follow-up.

| Axis | Config key | Gates |
|---|---|---|
| Google Search Console | `seo.egress.search-console` | Live search-analytics / URL-inspection API calls |
| DataForSEO | `seo.egress.serp-provider` | Live SERP / keyword / backlink API calls |
| AI-visibility (GEO) | `seo.egress.ai-visibility` | AI-answer / GEO capability — **router-wired in Sprint 9, but routed to the offline `LocalExportSource` arm because no vendor is pinned; the live `AiVisibilityAdapter` (provider-agnostic) awaits a pinned provider** |
| Site crawl | `seo.egress.site-crawl` | damcrawler-backed crawl / URL-coverage / link-graph / SERP-scrape — **engine `DamcrawlerCrawlEngine` (Sprint 6) + adapter `CrawlSource` (Sprint 7) router-wired in Sprint 9 (ADR-8: `link-graph` always; `url-inspection` only when `search-console` is off); needs the optional `damcrawler`/`playwright` peer deps** |

The whole `seo.egress` object is `.optional()` — a config that omits it keeps all four
axes off, and the offline `LocalExportSource` needs none (`src/config/schema.ts:675-686`).
`SeoEgressGuard.assertAllowed` throws if a live adapter method is called against a
not-opted-in axis — a hard, code-enforced barrier every network-opening adapter must
call first.

A companion `seo.serp.provider` key (`'dataforseo' | 'damcrawler'`, default
`'dataforseo'`; `src/config/schema.ts:708-711`) selects which implementation serves the
`serp` capability. Both implementations of the provider-agnostic `SerpProvider` port
(`src/seo/serp-provider.ts`, Sprint 8; `resolveSerpProvider` is the selection factory)
exist, and **as of Sprint 9 the key is live end-to-end** — `selectSource` calls
`resolveSerpProvider(config, …)` and wraps the result in a `SerpProviderSource` on the
`serp` route whenever the `serp-provider` **or** `site-crawl` axis is on (ADR-10):

- **`dataforseo`** (default, `src/seo/sources/dataforseo-serp-provider.ts`) — a thin
  delegate over the existing `DataForSeoAdapter.serp` path; **byte-identical to today**.
  Gated by the **`serp-provider`** axis, and its per-SERP USD (`0.0006/result`) is booked
  **inside** the wrapped adapter — the wrapper never re-books, so there is no
  double-charge.
- **`damcrawler`** (`src/seo/sources/damcrawler-serp-provider.ts`) — a **zero-USD** scrape
  via damcrawler's `search()`, gated by the **`site-crawl`** axis (**ADR-10** — the same
  Playwright/anti-bot/ToS risk surface as the crawler, deliberately **not** the
  `serp-provider` axis, which means "licensed, USD-metered DataForSEO egress"). It books
  nothing (no quota governor), needs the optional `damcrawler`/`playwright` peer deps, and
  per **ADR-11** sanitizes each result's `title` **and** `url` through `ContentSanitizer`
  before any row can reach the analyzer prompt. Axis-off ⇒ `abstain{egress-site-crawl-disabled}`
  (zero sockets); dep absent ⇒ `abstain{damcrawler-not-installed}`; any anti-bot/search/parse
  error ⇒ `abstain{serp-scrape-error}`. It never throws.

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

### Pipeline wiring (Sprint 9)

`selectSource` (`src/seo/runner.ts:259`) turns the four axes above into the run's data
source. With **all four off** it returns `LocalExportSource` as its first statement —
zero governor, zero socket, `import('damcrawler')` never evaluated, byte-identical to a
project with no SEO suite. Otherwise it loads the quota governor once and assembles a
**`CapabilitySeoRouter`** that dispatches each capability to the one source that owns it
(an unrouted capability resolves `{ kind: "disabled" }`; the router never throws):

| Capability | Source | Axis |
|---|---|---|
| `search-analytics` | `GscAdapter` | `search-console` |
| `url-inspection` | `GscAdapter`, else `CrawlSource` (ADR-8: GSC wins) | `search-console`, else `site-crawl` |
| `link-graph` | `CrawlSource` | `site-crawl` |
| `keywords`, `backlinks` | `DataForSeoAdapter` | `serp-provider` |
| `serp` | `resolveSerpProvider(config)` result (ADR-10) | `serp-provider` **or** `site-crawl` |
| `ai-visibility` | `LocalExportSource` (offline arm, no vendor pinned) | `ai-visibility` |

`gatherDataBundle` then probes **only** the capabilities `WORKFLOW_CAPABILITIES`
(`src/seo/workflow-capabilities.ts`, ADR-7) lists for the running workflow, so the
metered `ai-visibility` capability is fetched **only** for the `ai-visibility` and
`parasite-watch` workflows, and `link-graph` only for `internal-linking`; every other
workflow gathers the five `CORE` capabilities and nothing more. An omitted capability is
never called and renders as "not requested" in the analysis.

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

As of Sprint 9 the runner's `selectSource` **does** wire `CrawlSource` (ADR-8:
`link-graph` always when `site-crawl` is on; `url-inspection` only when `search-console`
is off), so with the deps installed and the axis on, a `bober seo` run reaches the
engine. **Every** `DamcrawlerCrawlEngine` method — `crawl()`, `urlVisibility()`, and
`linkGraph()` — sanitizes its row free-text at the network→in-process boundary through
the fail-closed `ContentSanitizer` (`src/seo/content-sanitizer.ts`; **ADR-11**) before
any row can reach the analyzer prompt: the page body/`title`/`url` from `crawl()`, the
inspection `url` from `urlVisibility()`, and the `fromUrl`/`toUrl`/`anchor` of each edge
from `linkGraph()` (all attacker-controlled free-text — Sprint 7 finding F1; the
`linkGraph`/`urlVisibility` coverage was completed by the Sprint 9 iteration-2 fix, which
closed a reopened F1 hole where those two methods had been left unsanitized). `CrawlSource`
re-checks every field it emits as a genuine defense-in-depth second layer. Every
caller-supplied crawl/probe URL is additionally checked
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
`src/config/schema.ts:668-714`), `.optional()` on `BoberConfig` with no top-level
default — omitting `seo` entirely means the parsed config has no `seo` key at all.

| Field | Type | Default | Effect |
|---|---|---|---|
| `egress` | `{ "search-console", "serp-provider", "ai-visibility", "site-crawl" }` (optional) | unset | The four live-data axes above, **all router-wired as of Sprint 9** (`ai-visibility` routes to the offline arm pending a pinned provider; `site-crawl` also needs the optional `damcrawler`/`playwright` peer deps). Omit entirely ⇒ byte-identical, all stay off. |
| `serp.provider` | `"dataforseo" \| "damcrawler"` (optional object, inner default) | `"dataforseo"` | Selects the SERP implementation for the `serp` capability. Both `SerpProvider` impls exist (Sprint 8) — `dataforseo` (metered, `serp-provider` axis, byte-identical to today) and `damcrawler` (zero-USD scrape, gated by the `site-crawl` axis per ADR-10) — and **selection is router-wired as of Sprint 9** (`resolveSerpProvider` in `selectSource`). Omitting `serp` stays byte-identical. |
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
    "ai-visibility": false,           // AI-answer/GEO egress. Default false. Router-wired (Sprint 9) to the offline LocalExportSource arm — live AiVisibilityAdapter awaits a pinned provider.
    "site-crawl": false               // damcrawler crawl/link-graph/SERP-scrape egress. Default false. Engine (DamcrawlerCrawlEngine) + CrawlSource router-wired (Sprint 9, ADR-8); needs optional damcrawler/playwright peer deps.
  },
  "serp": { "provider": "dataforseo" }, // Optional. Which SERP impl serves `serp`: dataforseo (metered, serp-provider axis) | damcrawler (zero-USD scrape, gated by site-crawl axis — ADR-10). Both exist (Sprint 8); router-wired via resolveSerpProvider (Sprint 9). Omit => byte-identical.
  "verifier": { "enabled": false },   // Adversarial downgrade-only verifier stage. Default false.
  "budget": { "maxUsd": 5 },          // Per-run USD ceiling for PAYG DataForSEO calls. Absent = uncapped.
  "defaultTarget": "https://example.com", // Used when the CLI omits [target].
  "blockThreshold": "critical-uncited"    // CI exit-code gate: never | any-uncited | critical-uncited.
}
```

---

## Phase 2 — the builder (gated generation)

Phase 1 (above) only ever *analyzes and recommends* — `bober seo <workflow>` emits cited
findings and stops. Phase 2 adds a second, separately-gated stage that turns a **human-
approved** finding into a concrete draft artifact. Nothing Phase 2 produces is ever
auto-applied to a live property; every artifact is a proposal a human reviews and applies
by hand.

### The `SeoBuilder` gated-generation model

`SeoBuilder.build(input)` (`src/seo/builder/seo-builder.ts:68`) is the only place a draft
artifact is generated, and its input type is gated at compile time:
`SeoBuildInput.approvedFindings` accepts `ApprovedFinding[]` **only** — a raw `SeoFinding[]`
does not type-check (see `seo-builder.test.ts`'s `@ts-expect-error` compile-proof, and the
now-enforced `typecheck:tests` script below). For each approved finding it:

1. Selects a deterministic, pure template per `SeoDraftKind` (`schema-jsonld` /
   `internal-link` / `content-refresh` / `title-meta`, `draft-generators.ts:30`) — no LLM,
   no network, no clock, no randomness.
2. Re-runs the **mandatory** `NeverEncodeFilter` (`src/seo/never-encode-filter.ts`) over the
   generated artifact text before it can be returned (`seo-builder.ts:77`). This is a second,
   independent pass of the same runtime filter the analyze pipeline uses — belt-and-braces:
   even a clean, approved, cited finding cannot produce a banned-tactic artifact, because the
   generated *text itself* is re-scanned. A match increments `skipped`; the draft is dropped,
   never returned, and the run never throws.
3. Stamps every returned `SeoDraft` with the literal `humanApprovalRequired: true`
   (`draft-types.ts:30` — a type literal, not a plain `boolean`, so it cannot be forged to
   `false`) and a `sourceCitationUrl` copied verbatim from the `ApprovedFinding` that produced
   it (`seo-builder.ts:83-91`) — never invented, never re-derived.

`SeoBuilder.build` never throws: a per-finding generation error increments `skipped` and the
loop continues rather than bricking the whole batch (mirrors `SeoAnalyzer`'s fail-closed
discipline).

### The `ApprovedFinding` boundary — resurrection is structurally impossible

`ApprovedFinding` (`src/seo/builder/approved-finding.ts`) is the sole gate between the hub
and the builder. It is constructible **only** via `ApprovedFinding.from(finding)`, which
returns `null` — never throws — unless **both**:

- `finding.status === "approved"` (a human, not the strategist or the verifier, moved the
  hub finding into this state), **and**
- the finding carries a well-formed `cite:<url>` evidence entry (an absolute `http(s)` URL).

Any hub finding the citation gate dropped for lacking a citation, any finding the
`NeverEncodeFilter` already dropped upstream, any finding the opt-in verifier downgraded to
`disproved` (so it never reached the hub as `approved` in the first place), and any finding
still sitting at `open`/`in-progress`/`snoozed`/`done`/`dropped` all resolve to `null` here —
there is no code path from a dropped/un-approved finding into a `SeoDraft`. The reverse
adapter `readApprovedSeoFindings` (`hub-approved-source.ts:30`) reads only `domain: "seo"`,
`status: "approved"` hub rows and maps each through this same gate, so a malformed or
ineligible row is silently skipped rather than crashing the build. `src/seo/builder/seo-
builder.test.ts`'s `sc-14-1` safety benchmark exercises this boundary directly.

### The human-approval loop and `bober seo build <reportId>`

```
bober seo <workflow>            # analyze: cited findings -> hub, kind "action"/"risk"
  |
  v  (a human reviews the hub finding and marks it `approved`)
  |
bober seo build <reportId>      # build: drafts artifacts from ONLY the approved findings
  |
  v
.bober/seo/drafts/<reportId>-seo-drafts.json   (persisted bundle)
  + best-effort hub `action` findings, one per draft
  |
  v  (a human reviews each draft and applies it manually)
```

`registerSeoCommand`'s `seo build <reportId>` subcommand (`src/seo/command.ts:102-125`) —
run via `SeoBuildRunner.run` (`build-runner.ts:161`) — reads the named `SeoReport`, narrows
the approved hub findings to that report's workflow (the only available report↔finding
linkage today), calls `SeoBuilder.build`, persists the resulting bundle via `SeoDraftStore`
(atomic temp-file + rename, `draft-store.ts:22-23`), and best-effort re-emits each draft as a
hub `kind: "action"` finding (`build-runner.ts:85-101`) so it surfaces in the same review
queue as any other finding. **Nothing in this loop ever writes to the target site** — the
draft is text/content a human copies in, reviews, and applies themselves. An unknown
`reportId` or a report with zero approved findings exits `0` cleanly with an informational
message and zero hub emits; an unexpected failure (a report/finding-store read error, or a
build/persist exception) fails closed to `exitCode 2` (`build-runner.ts:158-159`; `1` stays
Commander-reserved).

### Enforcing the compile-time gate: `typecheck:tests`

The `@ts-expect-error` compile-proofs above (the `ApprovedFinding` nominal-type guard and the
`SeoBuilder.build` type gate) are true today, but the base `tsconfig.json` excludes
`*.test.ts` from `tsc`, and Vitest does not type-check by default — so a proof could silently
rot without either check noticing. `npm run typecheck:tests` (`tsc --noEmit -p
tsconfig.test.json`) closes that gap: `tsconfig.test.json` extends the base config but scopes
`include` to `src/seo/builder/**/*.ts` **without** excluding test files, so the builder's
`*.test.ts` files are genuinely compiled. If a compile-proof ever stops erroring (e.g. the
nominal-type guard is accidentally removed), this command fails with `TS2578: Unused
'@ts-expect-error' directive` instead of silently passing.

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
- **The builder's `ApprovedFinding` boundary + mandatory re-filter (Phase 2).**
  `SeoBuilder.build` only ever accepts `ApprovedFinding[]` (type-gated, `sc-12-1`), and
  `ApprovedFinding.from` returns `null` for any hub finding that is not human-`"approved"`
  or lacks a well-formed `cite:` URL — a dropped, uncited, or verifier-downgraded finding
  has no path into a draft (resurrection structurally impossible, see **Phase 2 — the
  builder** above). Every generated artifact is additionally re-scanned by a second,
  independent `NeverEncodeFilter` pass before it can be returned, and every draft carries
  the literal `humanApprovalRequired: true` — nothing Phase 2 produces is ever
  auto-applied.

---

## FAQ

**Do I need any API key to use this?**
No. The default data source reads `.bober/seo/imports/` — omit all four egress axes
(`search-console`, `serp-provider`, `ai-visibility`, `site-crawl`) and every workflow
runs entirely offline against your own exported data.

**How do I turn on live data?**
It depends on the axis:
- `search-console`: set `seo.egress["search-console"]: true` and provide
  `GSC_OAUTH_TOKEN`.
- `serp-provider`: set `seo.egress["serp-provider"]: true` and provide
  `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD`.
- `ai-visibility`: set `seo.egress["ai-visibility"]: true` — no credentials needed yet;
  because no concrete AI-visibility vendor is pinned (see Egress axes above), this axis
  currently routes to the offline `LocalExportSource` arm (`ai-visibility.csv`/`.json`)
  rather than a live provider.
- `site-crawl`: set `seo.egress["site-crawl"]: true` and install the optional
  `damcrawler`/`playwright` peer deps (`npm i damcrawler playwright && damcrawler
  setup`) — no API key, just the local browser engine.

Each axis is independent; turning one on does not affect the others.

**Why does `parasite-watch` never suggest placing content on a third-party host?**
Because that tactic is a named Google site-reputation-abuse policy violation, its
playbook signature is tagged `PolicyClass: never-encode` and is dropped by the parser
before any analysis prompt sees it — the workflow can only ever flag exposure risk, not
recommend the tactic. See Guardrails above.

**How do I turn an approved finding into an artifact?**
First mark the hub finding `approved` (a human decision — nothing does this automatically).
Then run `bober seo build <reportId>` for the report that finding came from. `SeoBuilder`
reads only findings the `ApprovedFinding` boundary lets through (human-`"approved"` +
well-formed `cite:` URL — see **Phase 2 — the builder** above), drafts a `SeoDraft` per
approved finding, persists the bundle to `.bober/seo/drafts/<reportId>-seo-drafts.json`, and
best-effort re-emits each draft as a hub `action` finding for review. Every draft carries
`humanApprovalRequired: true` and is never applied to the target site automatically — you
review and apply it yourself. A finding that was never approved, or was dropped/uncited
upstream, cannot be resurrected into a draft: `ApprovedFinding.from` returns `null` for it,
so it never reaches `SeoBuilder.build` in the first place.
