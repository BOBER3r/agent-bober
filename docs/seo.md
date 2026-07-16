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
other. Two axes are wired to a live adapter today; two more (`ai-visibility`,
`site-crawl`) were registered by the SEO improver+builder foundation and are reserved
for adapters that land in later sprints — enabling them today is inert (no network path
exists yet).

| Axis | Config key | Gates |
|---|---|---|
| Google Search Console | `seo.egress.search-console` | Live search-analytics / URL-inspection API calls |
| DataForSEO | `seo.egress.serp-provider` | Live SERP / keyword / backlink API calls |
| AI-visibility (GEO) | `seo.egress.ai-visibility` | Live AI-answer / GEO provider egress — **reserved; no adapter wired yet** |
| Site crawl | `seo.egress.site-crawl` | damcrawler-backed crawl / URL-coverage / link-graph / SERP-scrape — **reserved; no adapter wired yet** |

The whole `seo.egress` object is `.optional()` — a config that omits it keeps all four
axes off, and the offline `LocalExportSource` needs none (`src/config/schema.ts:675-686`).
`SeoEgressGuard.assertAllowed` throws if a live adapter method is called against a
not-opted-in axis — a hard, code-enforced barrier every network-opening adapter must
call first.

A companion `seo.serp.provider` key (`'dataforseo' | 'damcrawler'`, default
`'dataforseo'`; `src/config/schema.ts:708-711`) selects which implementation serves the
`serp` capability. It is likewise inert until the provider it names is wired in a later
sprint.

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
| `egress` | `{ "search-console", "serp-provider", "ai-visibility", "site-crawl" }` (optional) | unset | The four live-data axes above (last two reserved). Omit entirely ⇒ byte-identical, all stay off. |
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
    "ai-visibility": false,           // AI-answer/GEO provider egress. Default false. Reserved (no adapter yet).
    "site-crawl": false               // damcrawler crawl/link-graph/SERP-scrape egress. Default false. Reserved (no adapter yet).
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
