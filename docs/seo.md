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
other. **As of Sprint 9 all four data axes are wired into the runner's `selectSource`**
(`src/seo/runner.ts:259`), which assembles a capability-keyed `CapabilitySeoRouter` per
the ADR-8/ADR-10 route table — so opting into an axis now actually routes data through a
`bober seo` run (see **Pipeline wiring** below). The `site-crawl` axis is backed by
`DamcrawlerCrawlEngine` (`src/seo/sources/damcrawler-crawl-engine.ts`, Sprint 6) through
its `CrawlSource` adapter (`src/seo/sources/crawl-source.ts`, Sprint 7, serving
`link-graph` and — per ADR-8, only when `search-console` is off — `url-inspection`); it
additionally requires the optional `damcrawler`/`playwright` peer deps to be installed
(see **Optional site-crawl deps** below). The `ai-visibility` axis now routes to a **live
in-house grounded-API spine** when it is on **and** at least one configured engine is
keyed (`spec-20260718-in-house-ai-visibility`, Sprint 3): `selectSource` calls
`resolveAiVisibilityProvider(config, egress, deps)` — mirroring `resolveSerpProvider` —
which composes one arm per keyed engine into an `AiVisibilityMultiplexer` behind the
provider-agnostic `AiVisibilityAdapter`. **No-key-safe:** with the axis off, no
`aiVisibility` config, no configured engines, or no matching API key, the factory returns
`undefined` and the axis falls back to the **offline `LocalExportSource` arm** (reads
`ai-visibility.csv`/`.json` if present) exactly as before — never a bogus zero-arm live
adapter. See **In-house AI-visibility (grounded-API spine)** below.

A **fifth** axis, `ai-visibility-scrape` (`seo.egress.ai-visibility-scrape`, default
`false`, Sprint 3), reserves a separate egress gate for the future AI-visibility
UI-scrape arm. It is **axis-only** this sprint — it composes **no provider yet** (the
scrape arm lands Sprint 10), so it is inert end-to-end and is deliberately **excluded**
from `selectSource`'s all-off byte-identical predicate (which reads only the four data
axes). It is a **distinct axis** from `ai-visibility` (ADR-5): opting into one does not
opt into the other.

| Axis | Config key | Gates |
|---|---|---|
| Google Search Console | `seo.egress.search-console` | Live search-analytics / URL-inspection API calls |
| DataForSEO | `seo.egress.serp-provider` | Live SERP / keyword / backlink API calls |
| AI-visibility (GEO) | `seo.egress.ai-visibility` | AI-answer / GEO capability — **routes to the live in-house grounded-API spine (`AiVisibilityAdapter` ← `resolveAiVisibilityProvider` → `AiVisibilityMultiplexer`) when the axis is on and ≥1 configured engine is keyed (Sprint 3); no-key-safe fall-back to the offline `LocalExportSource` arm otherwise** |
| Site crawl | `seo.egress.site-crawl` | damcrawler-backed crawl / URL-coverage / link-graph / SERP-scrape — **engine `DamcrawlerCrawlEngine` (Sprint 6) + adapter `CrawlSource` (Sprint 7) router-wired in Sprint 9 (ADR-8: `link-graph` always; `url-inspection` only when `search-console` is off); needs the optional `damcrawler`/`playwright` peer deps** |
| AI-visibility scrape | `seo.egress.ai-visibility-scrape` | Reserved egress gate for the future AI-visibility UI-scrape arm — **axis-only as of Sprint 3 (composes no provider until Sprint 10); a distinct axis from `ai-visibility` (ADR-5)** |

The whole `seo.egress` object is `.optional()` — a config that omits it keeps all five
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

The `ai-visibility` adapter (`AiVisibilityAdapter`,
`src/seo/sources/ai-visibility-adapter.ts`) is **provider-agnostic by design (ADR-5)**:
it depends on an injected `AiVisibilityProvider` port
(`{ name; estCostUsdPerPrompt; probe(target, prompts, locale) }`), never on a specific
vendor SDK. Swapping providers means writing a new port implementation, with no change to
the adapter, the seam, or the egress model. The adapter is egress-gated (`ai-visibility`)
and USD-metered through the quota governor (cost = `estCostUsdPerPrompt × prompts.length`,
booked only after a successful probe; a provider error abstains and books nothing). A
single `ai-visibility` axis gates every provider — there is no per-vendor axis.

### In-house AI-visibility (grounded-API spine, Sprint 3)

As of `spec-20260718-in-house-ai-visibility` (Sprint 3) the injected port is filled by an
**all-in-house grounded-LLM-API spine** rather than a commercial SaaS vendor.
`resolveAiVisibilityProvider(config, egress, deps)` (`src/seo/ai-visibility-provider.ts`)
— the selection factory that mirrors `resolveSerpProvider` — composes one
`ApiSpineEngineProvider` (Sprint 2) arm per configured **and keyed** engine into an
`AiVisibilityMultiplexer`, and `selectSource` wraps that in the `AiVisibilityAdapter`. The
multiplexer fans each `probe()` out to every arm in parallel (`Promise.allSettled`) and
**concatenates** their rows — arms are never merged, each `AiVisibilityRow` keeps its own
`provider` label — and its `estCostUsdPerPrompt` is the plain **sum** of the arms'
already-N-baked prices (never re-multiplied by N). If **every** arm rejects it rethrows
(the adapter degrades to abstain and books nothing); one arm rejecting only drops that
arm's rows.

Which engines run is driven by the new **`seo.aiVisibility`** config
(`src/config/schema.ts`, optional with **no outer default** — omit it and behaviour is
byte-identical, mirroring the `serp` idiom):

- `samplesPerPrompt` (`number`, default `5`) — grounded-search samples per prompt per
  engine (the *N* in the ADR-3 N-baked cost formula).
- `engines` (array, default `[]`) — each entry `{ engine: "anthropic" | "openai" |
  "perplexity"; perCallUsd: number (default 0) }`. An empty/absent list ⇒
  `resolveAiVisibilityProvider` returns `undefined` ⇒ offline fallback. All three engines
  are **live** as of Sprint 7 (`"perplexity"` was type-only through Sprint 6 — see
  **Perplexity Sonar** below).

The production `makeClient` (`defaultAiVisibilityDeps`, `src/seo/runner.ts`) reads each
engine's key from its documented env var (`anthropic` → `ANTHROPIC_API_KEY`, `openai` →
`OPENAI_API_KEY`, `perplexity` → `PERPLEXITY_API_KEY`) and returns `undefined` when the key
is absent, so a **no-key run never opens a socket** and falls back to `LocalExportSource`.
This makes the axis both **byte-identical-when-off** and **no-key-safe**: turning
`ai-visibility` on without a configured, keyed engine changes nothing. The `anthropic`/`openai`
per-engine model is hardcoded (`anthropic` → the default SEO model, `openai` → `gpt-4.1`) since
the config carries no per-engine `model` field yet; `perplexity` carries its own default
(`"sonar"`) on the client itself and is constructed via a separate branch (below).

#### Citation verification + sanitization boundary (Sprint 4)

As of Sprint 4 every `ApiSpineEngineProvider` arm applies two fail-closed boundaries inside
`probe()`, **before any `AiVisibilityRow` is emitted** — both injected once (shared across
all arms) by `resolveAiVisibilityProvider`:

- **Fail-closed cited-URL verification.** A **`CitationVerifier`**
  (`DamcrawlerCitationVerifier`, `src/seo/sources/citation-verifier.ts`) live-checks each
  URL a grounded answer surfaced as a candidate citation, **gated by the existing
  `site-crawl` axis** (no new egress axis — the same axis `DamcrawlerCrawlEngine` uses). It
  is guard-first: egress gate → lazy `import("damcrawler")` → per-url `assertSafeUrl` SSRF
  guard → `scrape`. Only URLs that scrape without a batch-mode `.error` are marked
  `live` (damcrawler's `ScrapeResult` has no numeric HTTP-status field, so `live` means
  "scraped cleanly", not literally HTTP 200), and `brandOnPage` is a word-boundary
  brand-token match over the **sanitized** scraped body. Crucially, `ApiSpineEngineProvider`
  retains **only `live === true` URLs** in `row.sourceUrls`. The verifier is **fail-closed
  on every path** — `site-crawl` off, `damcrawler` absent (optional peer dep), a per-url
  SSRF rejection, or a scrape error all degrade that URL to `{ live:false, brandOnPage:false }`;
  it never throws and never fabricates a live citation. So with `site-crawl` off,
  `mentioned`/`citationPresent` can still be `true` (from the offline extractor) while
  `sourceUrls` is `[]` — a cited URL only ships once the `site-crawl` axis independently
  re-verified it live.
- **Fail-closed grounded-text sanitization.** The LLM's grounded `answerText` **and** every
  candidate citation URL pass through the fail-closed **`ContentSanitizer`**
  (`src/seo/content-sanitizer.ts`; **ADR-11**) at the network→in-process boundary *before*
  the row is built (spy-asserted call order `[sanitize:text, sanitize:url, verify, row]`; a
  thrown sanitize call fails closed to empty text). Because that text is **not**
  damcrawler-scraped (it comes straight from `GroundedSearchClient.search()`) and
  `ContentSanitizer` needs a **synchronous** `SanitizeFn` while any damcrawler `sanitize`
  export is only reachable via an async lazy `import()`, this boundary wraps
  `defaultGroundedTextSanitizeFn` (`src/seo/ai-visibility-provider.ts`) — a **real,
  dependency-free, synchronous** injection-stripper (removes `<system>`/`<|im_start|>`-style
  role-marker tags and "ignore previous instructions" phrasing), **not** an identity/no-op.
  An identity sanitizer at a named security boundary would be exactly the fake-ceiling the
  Sprint-9 F1 prompt-injection lesson forbids. damcrawler's real async `sanitize` stays
  load-bearing for the actual scraped citation **body** inside `DamcrawlerCitationVerifier`.

The build stays `tsc`-clean **without** `damcrawler` installed (the verifier uses the same
variable-indirection lazy loader as the other damcrawler adapters). Two follow-ups are
tracked: (1) citation **title** text is not yet sanitized (Sprint 4 scopes the grounded-text
boundary to `answerText` + citation URLs only; a title is LLM-echoable free text, so
extending the boundary to `citation.title` is an in-contract, later-sprint candidate); and
(2) the live grounded-API-spine egress path (and the live damcrawler scrape in the verifier)
has **no automated smoke coverage** yet — every test injects fake deps, so end-to-end
validation needs real engine keys plus `damcrawler` installed.

#### Analyzer-side aggregation — rates + Wilson CI (Sprint 5)

The spine emits **one raw `AiVisibilityRow` per sample**, so N probes of the same prompt
against the same engine produce N un-aggregated rows. As of Sprint 5 the **read side** folds
those into a compact, statistically-honest signal for the LLM prompt via a pure
**`AiVisibilityScorer`** (`src/seo/ai-visibility-scorer.ts`; re-exported from
`src/seo/index.ts`):

- `AiVisibilityScorer.aggregate(rows)` groups the raw rows **strictly by `(prompt, provider)`
  — arms are NEVER merged, even when they share a prompt** (the composite key is a
  collision-safe `JSON.stringify([prompt, provider])`, not a `"::"`-delimited concat that a
  prompt could contain) — and folds each group into one **`AiVisibilityMetric`**:
  `{ prompt, provider, samples, mentionRate, citationRate, meanRank?, mentionRateCi95:[number,
  number], sourceUrls }`. `meanRank` is **omitted entirely** (never `undefined`) when no row
  in the group carries a `rank`; `sourceUrls` is the deduped union of every row's `sourceUrls`
  in first-seen order. The scorer is **pure, synchronous, network-free, and never throws** —
  no `Date`, no RNG — and empty input yields `[]`.
- `mentionRateCi95` is a **deterministic Wilson 95% score interval** over the mention
  indicator across a group's samples (`z = 1.96`; clamped to `[0, 1]`; unit-tested against a
  hand-computed `k = 7, n = 10 → [0.3968, 0.8922]`). A single sample (`n <= 1`) returns the
  **degenerate `[rate, rate]`** rather than the raw one-sample Wilson output (which would be a
  misleadingly wide `~[0.207, 1.0]` for `1/1`).

This metric is a **derived, in-analyzer projection only** — it is **never** persisted. The
locked `SeoDataBundle.aiVisibility` stays `DataOutcome<AiVisibilityRow[]>` and the
`AiVisibilityRow` shape is unchanged; the metric lives solely in the analyzer's prompt string.

The wiring is a provenance-guarded branch in the analyzer (`describeAiVisibility`,
`src/seo/analyzer.ts:168`, called by `buildDataBundleSummary` for the AI-Visibility line).
It runs the scorer and serializes `AiVisibilityMetric[]` (rates + CI) into the prompt **only**
when `outcome.kind === "data" && outcome.provenance.source === "ai-visibility"` — the stamp
set exclusively by the live adapter at `ai-visibility-adapter.ts:136` (deliberately **not**
the similarly-named `QuotaRequest.source` at `:116`). **Every non-live outcome** (local-export,
disabled, abstain, or an undefined bundle slot, i.e. `provenance.source !== "ai-visibility"`)
**falls through to the unchanged `describeDataOutcome` path and is byte-identical to
pre-change** (ADR-5 provenance guard). So the analyzer shows aggregated rates+CI per
`(prompt, provider)` for a **live** ai-visibility arm, and the exact prior raw-outcome
rendering for everything else.

#### Tracked prompt set — `TrackedPromptStore` (Sprint 6)

Through Sprint 5 the spine could only ever probe the target's own name: `gatherDataBundle`
synthesized a trivial `{ target, prompts: [target] }` query. As of Sprint 6 a team can curate
the exact prompts they track for a brand in a committed file, loaded by the filesystem-backed
**`TrackedPromptStore`** (`src/seo/tracked-prompt-store.ts`).

`TrackedPromptStore(projectRoot).load(target)` reads
`.bober/seo/ai-visibility/<target>.json` via `node:fs/promises`, `JSON.parse`s it, and
validates it with `TrackedPromptSetSchema.safeParse`, returning a
`TrackedPromptSet{ target, prompts[], engines[], samplesPerPrompt, locale? }`. The file
looks like:

```json
{
  "target": "example.com",
  "prompts": ["what is example.com", "who runs example.com", "is example.com trustworthy"],
  "engines": ["anthropic"],
  "samplesPerPrompt": 9,
  "locale": "en-GB"
}
```

- `target`, `prompts` are required; `locale` is optional; `engines` defaults to `[]` and
  `samplesPerPrompt` to `5` when omitted.
- The `<target>` **filename is traversal-safe** — non-`[a-zA-Z0-9_-]` characters are replaced
  with `_` (so `example.com` → `example_com.json`), mirroring `report-store.ts`'s
  sanitization. A `../`-bearing target can neither throw nor read outside the
  `ai-visibility` directory.

`gatherDataBundle` (`src/seo/runner.ts`) loads that set and feeds the real `prompts` (plus
`locale` when present) into the locked `AiVisibilityQuery` (`{ target, prompts, locale? }`,
`data-source.ts:61`), replacing the old `[target]` literal. Two behaviours are load-bearing:

- **Byte-identical fallback.** `load()` **never throws**: a missing, unreadable, malformed, or
  schema-invalid file all collapse to the same fallback, and `gatherDataBundle` forwards
  `{ target, prompts: [target] }` — with **no `locale` key present at all**
  (`hasOwnProperty("locale") === false`) — byte-identical to the pre-Sprint-6 query.
- **No extra fs read when the axis isn't requested.** The `load()` call lives **inside** the
  `requested.has("ai-visibility")` arm of `gatherDataBundle`'s `Promise.all` (never hoisted
  above it), so a workflow that does not request `ai-visibility` (e.g. `technical-audit`)
  never touches the filesystem for this store — behaviour byte-identical to pre-change.

The file's **`engines` and `samplesPerPrompt` are advisory only** — they are parsed and
validated but deliberately **not** forwarded into the locked `AiVisibilityQuery` (a contract
nonGoal; the query shape stays `{ target, prompts, locale? }`). The real per-run N and engine
list are resolved from the `seo.aiVisibility` config at provider construction, not from this
file. There is **no CLI to author the file** and **no history/time-series store** (both
nonGoals) — it is a stateless read of a committed flat file.

#### Perplexity Sonar — third grounded engine (Sprint 7)

Through Sprint 6 the spine had two live arms (`anthropic`, `openai`), both
`LiveGroundedSearchClient`s wrapping an injected `LLMClient.chat` turn; `"perplexity"` was a
valid `GroundedEngine` enum value but **type-only** — no mapper, no client. As of Sprint 7 it
is a real third arm, built as **`PerplexitySonarClient`** (`src/providers/grounded-search.ts`,
the second `GroundedSearchClient` implementation in that file).

Perplexity Sonar is a **direct HTTP `chat/completions` API** (`https://api.perplexity.ai`),
**not** reachable through `LLMClient.chat` + a `web_search` `ToolDef`. So `PerplexitySonarClient`
— unlike `LiveGroundedSearchClient` — does **not** wrap an `LLMClient`: it speaks HTTP itself
through an **injectable fetch-like transport** (the file's only `fetch` reference, behind a
default global-`fetch` wrapper) and reads its key from `PERPLEXITY_API_KEY` via an injected
`getApiKey` (env, never hardcoded — mirroring the DataForSEO credential-injection idiom). The
default model is `"sonar"`. Both the transport and the key-reader default to real
implementations, so production wiring needs no arguments while tests stub both and never open a
socket.

- **Citation mapping** (`mapSonarCitations`, local to `grounded-search.ts`) normalizes a Sonar
  response into `GroundedCitation[]`, using the same `title ?? url` fallback as the
  Anthropic/OpenAI mappers: it **prefers `search_results[{ title, url }]`** (the richest shape,
  carrying a title), **falls back to the plain `citations[]` URL array** (URL doubles as title)
  when `search_results` is absent/empty, and returns **`[]` when both are absent** (ungrounded).
- **Never throws** (the abstain contract): a missing key, an `!res.ok` response, a network
  error, or malformed JSON all degrade to `{ answerText: "", citations: [] }`; the adapter
  abstains upstream. `costUsd` is intentionally **omitted** (cost is N-baked via the engine's
  `perCallUsd`, per the multiplexer's cost model above).
- **No SDK/type leak.** Every Sonar-specific type (the response/transport shapes) stays **local
  and unexported** to `grounded-search.ts`; only `PerplexitySonarClient` — which implements the
  provider-agnostic `GroundedSearchClient` — is exported. No Perplexity type crosses
  `src/providers/`.

**Composition is unchanged.** Perplexity is wired in via an **early branch** in
`defaultMakeClient` (`src/seo/runner.ts`): because Sonar is BYOK HTTP and not an `LLMClient`
provider, the branch constructs `new PerplexitySonarClient()` **directly**, bypassing
`createClient` (which has no `perplexity` entry and would otherwise return `undefined`). It is
**no-key-safe** — with `PERPLEXITY_API_KEY` unset the branch returns `undefined` and the arm is
simply skipped. From there the **generic** `resolveAiVisibilityProvider` /
`AiVisibilityMultiplexer` composes it as a third `ApiSpineEngineProvider` arm with **no logic
change**: three configured+keyed engines fan out in parallel and concatenate their rows (never
merged; each `AiVisibilityRow` keeps its own `provider` label), and `estCostUsdPerPrompt` is the
plain **sum** of all three arms' already-N-baked prices. (Worked example: three engines at
`perCallUsd` `0.02`/`0.01`/`0.03` sum to `0.24`; drop the unkeyed Perplexity arm and the
remaining two sum to `0.12`.)

#### Optional LLM-as-judge fuzzy-mention path (Sprint 8)

The deterministic `MentionCitationExtractor` (Sprint 2) decides mention by pure string/host
matching, so a **paraphrased** reference ("their bullseye logo" for Target) reads as
*unmentioned*. As of Sprint 8 an **optional, injected LLM-as-judge second pass** can catch
those fuzzy mentions: a new **`LlmJudgeMentionCitationExtractor`**
(`src/seo/sources/mention-citation-extractor.ts`) that **composes** the deterministic
extractor rather than replacing it.

`extract()` on the judge variant is **async** and runs the deterministic pass first:

- If the deterministic pass already found a mention, it is returned **verbatim** — **no LLM
  call** (cost control: the judge only ever runs on a deterministic *miss*).
- On a deterministic miss over a **non-empty** answer, the answer text is **sanitized**
  (`ContentSanitizer`) *before* the judge prompt is built, and a **single bounded, Zod-parsed**
  judge turn — the injected provider-agnostic `LLMClient.chat({ jsonObjectMode: true })` (no new
  provider — a nonGoal) — decides whether the answer fuzzily/paraphrasedly mentions the target.
  The verdict shape is locked to **`JudgeVerdictSchema`** `{ mentioned: boolean, rank?: positive
  int }`, parsed by a **never-throws 3-tier `parseJudgeVerdict`** (direct JSON → fenced
  ```` ```json ```` block → first `{…}` span → `safeParse`, mirroring the medical
  `validateGroundingVerdict` idiom).

Three properties are **load-bearing**:

- **Fail-safe, never fail-open** — a thrown `llm.chat` transport error, an unparseable or
  schema-invalid verdict, an empty/whitespace answer, or a sanitizer that drops the text to
  `""` all short-circuit or fall back to the **deterministic result verbatim**. The judge
  **never** turns an empty/malformed answer into `mentioned:true`.
- **Sanitize-before-judge** — the judge sees only already-sanitized answer text, never raw
  scraped/answer content (a defense-in-depth re-sanitize at this boundary).
- **Judge overrides mention only** — it applies the verdict's `mentioned`/`rank`
  (`rank` **omitted**, never `undefined`, when absent); `citationPresent`/`sourceUrls` always
  come from the deterministic pass. The judge is **not** used for citation-URL verification
  (that stays `CitationVerifier`'s job).

The judge is gated by a new optional **`config.seo.aiVisibility.judge`** object
(`src/config/schema.ts`) — `{ enabled: boolean (default false), model?: string }` with **no
outer default**: omit `judge` and `SeoConfigSchema.parse({ aiVisibility: {} })` is
byte-identical (leaks only `samplesPerPrompt`/`engines`), and the judge is off even when the
object is present but `enabled` is omitted. The `MentionCitationExtractor.extract()` port
return type widens to `SampleObservation | Promise<SampleObservation>` so both the sync
deterministic and async judge variants satisfy it (this forces a single `await` at
`api-spine-provider.ts:96`; `probe()` was already async). Deterministic-only extraction stays
**byte-identical** when the judge is off or no `llm` is injected — the judge is opt-in and
deterministic-by-default (making it the default is a nonGoal).

> **KNOWN LIMITATION — the flag is currently INERT.** `LlmJudgeMentionCitationExtractor` is
> exported and unit-tested but **not yet wired into the production factory**:
> `resolveAiVisibilityProvider` / `runner.ts` still construct the plain
> `DeterministicMentionCitationExtractor` with no `llm`. **Setting
> `config.seo.aiVisibility.judge.enabled: true` today produces no behavior change and no
> warning** — nothing reads the flag to build the judge extractor. This is an in-contract
> deferral (the contract scoped Sprint 8 to the extractor + config + build, excluding the
> factory); **the wiring is planned for Sprint 11** (`resolveAiVisibilityProvider` reading
> `judge.enabled`/`judge.model`). Until then, treat `judge` as a reserved-but-inert config key.

#### Scrape-arm throttle — `ScrapeThrottle` (in-house AI-visibility Sprint 9)

The gated scrape arm (the `ai-visibility-scrape` axis, provider lands Sprint 10) meters a
**different** cost than the grounded-API spine: **proxy USD** plus a **per-engine rate window**
that keeps a stealth scraper polite. As of `spec-20260718-in-house-ai-visibility` Sprint 9 the
enforcement primitive for both exists — **`ScrapeThrottle`** (`src/seo/scrape-throttle.ts`) — and
it deliberately uses a **SEPARATE** ledger from the `SeoQuotaGovernor`. This is the arch's
**two-independent-ledgers cost model**:

- The scrape arm books **`$0`** to the `SeoQuotaGovernor` (whose USD ceiling gates only the
  grounded-API spine); its **real proxy cost** is tracked in `ScrapeThrottle`'s own filesystem
  ledger at **`.bober/seo/scrape-throttle-ledger.json`** — a **distinct path** from the governor's
  `.bober/seo/quota-ledger.json`.
- The two ledgers are **independently capped** and **never cross-reconciled** (a deliberate
  nonGoal). Independence is verified in **both directions**: `$50` of proxy spend leaves a
  co-located `governor.spentUsd()` at `0` and never creates the governor ledger file, and a
  corrupt *governor* ledger does not block a throttle `acquire` on its own path.

`ScrapeThrottle` copies the governor's proven concurrency discipline rather than reinventing it:
the **path-generic** `withLedgerLock` per-path mutex reused from `quota-ledger.ts` (so this
ledger gets its **own** serialization chain and cannot interfere with the governor's),
**read-fresh-inside-the-lock**, **atomic temp-file + rename** writes, and **fail-closed-on-corrupt**
— but imports **nothing** from `quota-governor.ts` and keeps its own per-engine
`{ windowStart, count, proxyUsdSpent }` shape.

Its two methods mirror the governor's `admit()`/`record()` pair:

- **`acquire(engine)`** → `{ proceed: true } | { proceed: false; reason: "rate-window" |
  "proxy-budget" }` — **decides and consumes** a rate slot in one read-modify-write under the
  mutex. It grants within the window and proxy budget, denies `"proxy-budget"` once cumulative
  `proxyUsdSpent >= maxProxyUsd`, and denies `"rate-window"` once `count + 1 > maxPerWindow`
  (**proxy-budget is checked before the rate window**). It writes the ledger **only on the
  granting branch** — a refusal has **no side effect** (mirrors `SeoQuotaGovernor.admit()`'s
  no-write-on-refuse). A fixed window resets (`windowStart`/`count`) once
  `now - windowStart >= windowMs`. The decision discriminant is **`proceed`**, not `allowed`.
- **`recordProxyCost(engine, usd)`** — the governor's `record()` twin: accrues completed proxy
  spend under the same mutex + read-fresh + atomic write, so **concurrent calls sharing the
  ledger never lose an update** (proven exact at 100/100, single- and dual-instance). It
  **guards NaN/negative/zero** (a bad value can never corrupt or reduce the total) and **heals a
  corrupt ledger back to `{}`** before accruing.

**Fail-closed asymmetry is intentional.** A corrupt/unreadable ledger makes `acquire` deny
`"proxy-budget"` **without writing** (mirroring the governor's Infinity-on-corrupt refuse), while
`recordProxyCost` *heals* the corruption — corruption blocks the gate, not the accrual. A
**missing** ledger (first run / offline) is a fresh `{}`, i.e. **allow**, and is explicitly **not**
treated as corrupt. The clock is **injected** (`() => ISO string`, mirroring
`DamcrawlerCrawlEngine.now`), never `Date.now()` for the window, so rate-window boundaries are
tested deterministically; caps come from the constructor via `ScrapeThrottleLimits
{ maxPerWindow, windowMs, maxProxyUsd }`.

> **Delivered in isolation.** `ScrapeThrottle` is the enforcement primitive only — **no scrape
> provider constructs or calls it yet**, it adds **no config-schema field** (caps are
> constructor-injected), and the `ai-visibility-scrape` axis still composes no provider. **The
> scrape arm wires this in during Sprint 10.** The public API (`acquire`/`recordProxyCost`,
> `ThrottleDecision.proceed`) was frozen this sprint so that wiring is a pure composition step.

### Pipeline wiring (Sprint 9)

`selectSource` (`src/seo/runner.ts:259`) turns the four **data** axes above into the run's
data source. With **all four off** it returns `LocalExportSource` as its first statement —
zero governor, zero socket, `import('damcrawler')` never evaluated, byte-identical to a
project with no SEO suite. (The `ai-visibility-scrape` axis composes no source yet, so it
is deliberately **not** part of this predicate — see the Egress-axes note above.) Otherwise it loads the quota governor once and assembles a
**`CapabilitySeoRouter`** that dispatches each capability to the one source that owns it
(an unrouted capability resolves `{ kind: "disabled" }`; the router never throws):

| Capability | Source | Axis |
|---|---|---|
| `search-analytics` | `GscAdapter` | `search-console` |
| `url-inspection` | `GscAdapter`, else `CrawlSource` (ADR-8: GSC wins) | `search-console`, else `site-crawl` |
| `link-graph` | `CrawlSource` | `site-crawl` |
| `keywords`, `backlinks` | `DataForSeoAdapter` | `serp-provider` |
| `serp` | `resolveSerpProvider(config)` result (ADR-10) | `serp-provider` **or** `site-crawl` |
| `ai-visibility` | `AiVisibilityAdapter` ← `resolveAiVisibilityProvider` (in-house grounded-API spine) when ≥1 engine is keyed, else offline `LocalExportSource` arm | `ai-visibility` |

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
| `egress` | `{ "search-console", "serp-provider", "ai-visibility", "site-crawl", "ai-visibility-scrape" }` (optional) | unset | The five live-data axes above (`ai-visibility` routes to the live in-house grounded-API spine when a configured engine is keyed, else the offline arm; `ai-visibility-scrape` is axis-only until Sprint 10; `site-crawl` also needs the optional `damcrawler`/`playwright` peer deps). Omit entirely ⇒ byte-identical, all stay off. |
| `serp.provider` | `"dataforseo" \| "damcrawler"` (optional object, inner default) | `"dataforseo"` | Selects the SERP implementation for the `serp` capability. Both `SerpProvider` impls exist (Sprint 8) — `dataforseo` (metered, `serp-provider` axis, byte-identical to today) and `damcrawler` (zero-USD scrape, gated by the `site-crawl` axis per ADR-10) — and **selection is router-wired as of Sprint 9** (`resolveSerpProvider` in `selectSource`). Omitting `serp` stays byte-identical. |
| `aiVisibility` | `{ samplesPerPrompt: number (default 5), engines: { engine: "anthropic"\|"openai"\|"perplexity"; perCallUsd: number (default 0) }[] (default []), judge?: { enabled: boolean (default false), model?: string } }` (optional, no outer default) | unset | In-house grounded-API-spine config for the `ai-visibility` axis (Sprint 3). Omit ⇒ byte-identical; an empty/absent `engines` list or an unkeyed engine ⇒ offline fallback (no-key-safe). All three engines are live: `anthropic`/`openai` need `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`, `perplexity` needs `PERPLEXITY_API_KEY` (Sprint 7). `judge` (Sprint 8, optional, no outer default) gates the optional LLM-as-judge fuzzy-mention pass — **but is currently INERT**: it is not yet read by the production factory, so `judge.enabled:true` changes nothing until the wiring lands (planned Sprint 11). |
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
    "ai-visibility": false,           // AI-answer/GEO egress. Default false. Routes to the in-house grounded-API spine when on + a keyed engine (Sprint 3); else the offline LocalExportSource arm (no-key-safe).
    "site-crawl": false,              // damcrawler crawl/link-graph/SERP-scrape egress. Default false. Engine (DamcrawlerCrawlEngine) + CrawlSource router-wired (Sprint 9, ADR-8); needs optional damcrawler/playwright peer deps.
    "ai-visibility-scrape": false     // AI-visibility UI-scrape egress. Default false. Axis-only (Sprint 3) — composes no provider until Sprint 10.
  },
  "serp": { "provider": "dataforseo" }, // Optional. Which SERP impl serves `serp`: dataforseo (metered, serp-provider axis) | damcrawler (zero-USD scrape, gated by site-crawl axis — ADR-10). Both exist (Sprint 8); router-wired via resolveSerpProvider (Sprint 9). Omit => byte-identical.
  "aiVisibility": {                     // Optional, no outer default. In-house grounded-API spine for the ai-visibility axis (Sprint 3). Omit => byte-identical.
    "samplesPerPrompt": 5,              // Grounded-search samples per prompt per engine (N). Default 5.
    "engines": [                        // Default []. Empty/absent list or an unkeyed engine => offline fallback (no-key-safe).
      { "engine": "anthropic", "perCallUsd": 0.02 } // engine: anthropic|openai|perplexity (all live). perCallUsd default 0. Needs ANTHROPIC_API_KEY / OPENAI_API_KEY / PERPLEXITY_API_KEY respectively.
    ],
    "judge": { "enabled": false }       // Optional, no outer default (Sprint 8). Gates the LLM-as-judge fuzzy-mention pass. model? optional. CURRENTLY INERT — not yet read by the production factory (wiring planned Sprint 11), so enabled:true changes nothing today.
  },
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
No. The default data source reads `.bober/seo/imports/` — omit all five egress axes
(`search-console`, `serp-provider`, `ai-visibility`, `site-crawl`, `ai-visibility-scrape`)
and every workflow runs entirely offline against your own exported data.

**How do I turn on live data?**
It depends on the axis:
- `search-console`: set `seo.egress["search-console"]: true` and provide
  `GSC_OAUTH_TOKEN`.
- `serp-provider`: set `seo.egress["serp-provider"]: true` and provide
  `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD`.
- `ai-visibility`: set `seo.egress["ai-visibility"]: true`, add at least one engine to
  `seo.aiVisibility.engines` (`anthropic`, `openai`, and/or `perplexity`), and provide that
  engine's API key (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `PERPLEXITY_API_KEY`). The axis
  then routes to the in-house grounded-API spine (Sprint 3; `perplexity` added Sprint 7).
  **No-key-safe:** with the axis on but no configured/keyed
  engine, it falls back to the offline `LocalExportSource` arm (`ai-visibility.csv`/`.json`)
  rather than a live provider. `ai-visibility-scrape` is a separate, still-inert axis (no
  provider until Sprint 10).
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
