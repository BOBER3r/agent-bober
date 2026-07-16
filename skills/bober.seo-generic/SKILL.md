---
name: bober.seo-generic
description: "Generic SEO/GEO signature library shared across every workflow-specific SEO skill. Not a workflow skill -- a data file of discrete, cited SEO/GEO tactics read by SeoPlaybookParser. Encodes VERIFIED 2025-2026 AI-visibility correlation research (Ahrefs, Semrush, Profound), ranking-mechanics leak findings, and the never-encode policy boundary."
---

# bober.seo-generic — Generic SEO/GEO Signature Library

This skill is a **signature-library** file, not a workflow skill. It is read (as raw
markdown text) by `SeoPlaybookParser.parse()` (`src/seo/parser.ts`) and turned into
typed `SeoSignature[]` records used by the SEO agent team's retriever
(`SeoPlaybookRetriever`) as the always-included generic floor. Every surviving
signature below cites its primary source; a block with no `PrimarySourceUrl` or
tagged `PolicyClass: never-encode` is DROPPED by the parser at load time — see
`.bober/research/research-20260715-ultimate-seo-agents-skills-research.md` §1/§6 for
the underlying evidence and the two refuted claims that are deliberately NOT encoded
anywhere in this file (ChatGPT-Wikipedia dominance, Reddit-leading-AI-Overviews).

## Signature Block Format

Each signature is a level-3 heading (three `#` characters, a space, then the
`playbookId`) followed by labelled fields. This file and `SeoPlaybookParser` are one
executable spec — keep them in sync. Unlike the security signature library, SEO
blocks carry **no code fences** — `Tactic` replaces the unsafe/safe example pair.

Fields per block:
- The heading text itself is the `playbookId` (must be non-empty, or the block is dropped).
- `- **Title:** <human-readable title>` (required — missing drops the block)
- `- **Workflows:** comma, separated, SeoWorkflow, members` (soft field; invalid members are filtered out, default `[]`)
- `- **Tactic:** <the recommended action>` (soft field, defaults to `""` if absent)
- `- **Invariant:** <the evidence-backed claim this signature encodes>` (soft field, defaults to `""` if absent)
- `- **PrimarySourceUrl:** <REQUIRED citation URL>` — **a block missing or with an empty value here is DROPPED** (no-uncited-claim rule; the whole point of this format)
- `- **PolicyClass:** auto-safe|human-approve|never-encode` — **`never-encode` is DROPPED**; any other invalid value is also DROPPED
- `- **EvidenceGrade:** verified|primary-unverified|single-source` (soft field, defaults to `single-source` if absent/invalid)
- `- **Keywords:** comma, separated, keywords` (soft field, defaults to `[]`)

A block missing `Title`, `PrimarySourceUrl`, or a valid `PolicyClass` is dropped by the
parser — never a fatal error. A `never-encode` block is dropped even when every other
field is present: it documents the automation boundary for human readers but must
never reach an analyzer prompt.

## Signatures

### youtube-mentions-ai-visibility
- **Title:** YouTube mentions are the strongest AI-visibility correlate
- **Workflows:** ai-visibility
- **Tactic:** Prioritise earning brand presence and mentions on YouTube (owned channel content, creator partnerships, video PR) as a first-class AI-visibility lever, not an afterthought to written-content SEO.
- **Invariant:** Across ChatGPT, Google AI Mode, and AI Overviews, YouTube mentions show the single highest correlation (~0.737 Spearman) with brand visibility in AI answers, in a 75,000-brand Ahrefs correlation study.
- **PrimarySourceUrl:** https://ahrefs.com/blog/ai-brand-visibility-correlations/
- **PolicyClass:** human-approve
- **EvidenceGrade:** verified
- **Keywords:** youtube, ai-visibility, brand-mention, geo, correlation

### branded-mentions-ai-visibility
- **Title:** Branded web mentions (linked or unlinked) are the strongest non-video AI-visibility signal
- **Workflows:** ai-visibility
- **Tactic:** Pursue digital-PR and organic brand-mention placements across the web; unlinked mentions still count toward AI-visibility correlation, so do not discount coverage that omits a hyperlink.
- **Invariant:** Branded web mentions (linked or unlinked) correlate at 0.66-0.71 with brand visibility in AI answers — the strongest non-YouTube signal in the same 75,000-brand study.
- **PrimarySourceUrl:** https://ahrefs.com/blog/ai-brand-visibility-correlations/
- **PolicyClass:** human-approve
- **EvidenceGrade:** verified
- **Keywords:** brand-mention, digital-pr, ai-visibility, geo, unlinked-mention

### link-volume-weak-for-ai
- **Title:** Classic backlink volume is a weak lever for AI visibility
- **Workflows:** ai-visibility
- **Tactic:** Do not spend budget on bulk backlink-volume link building as a primary AI-visibility lever; redirect it toward branded mentions and YouTube presence, which correlate far more strongly.
- **Invariant:** Classic link metrics (backlink count, URL rating) show very weak correlation (~0.218) with AI-answer brand mentions, in the same 75,000-brand study.
- **PrimarySourceUrl:** https://ahrefs.com/blog/ai-brand-visibility-correlations/
- **PolicyClass:** auto-safe
- **EvidenceGrade:** verified
- **Keywords:** backlinks, link-building, ai-visibility, weak-correlation

### aio-commercial-intent-shift
- **Title:** AI Overviews triggers have shifted toward commercial/transactional intent
- **Workflows:** ai-visibility, rank-track
- **Tactic:** Prioritise AIO-visibility work on commercial and transactional queries, not only informational content — the trigger mix has moved decisively toward money queries.
- **Invariant:** AIO intent mix shifted Jan-Oct 2025: informational share fell 91.3%->57.1% of triggers while commercial rose to 18.57% and transactional to 13.94%, per a Semrush 10M+ keyword panel.
- **PrimarySourceUrl:** https://www.semrush.com/blog/semrush-ai-overviews-study/
- **PolicyClass:** auto-safe
- **EvidenceGrade:** verified
- **Keywords:** aio, commercial-intent, transactional, rank-track

### aio-prevalence-volatility
- **Title:** AI Overview prevalence is highly volatile — plan for churn, not a stable surface
- **Workflows:** ai-visibility
- **Tactic:** Re-measure AIO prevalence for target queries on a recurring cadence rather than assuming a one-time audit is durable; build monitoring, not a static report.
- **Invariant:** AIO prevalence fluctuated hard through 2025: 6.49% of queries (Jan) -> 24.61% (Jul) -> 15.69% (Nov), per the same Semrush 10M+ keyword panel.
- **PrimarySourceUrl:** https://www.semrush.com/blog/semrush-ai-overviews-study/
- **PolicyClass:** auto-safe
- **EvidenceGrade:** verified
- **Keywords:** aio, volatility, monitoring, rank-track

### zero-click-not-collapsing
- **Title:** Zero-click rate did not spike after AI Overviews — do not over-index on click-loss panic
- **Workflows:** ai-visibility
- **Tactic:** Do not justify SEO/GEO investment primarily on a claimed AIO-driven zero-click collapse; the measured effect is small, so frame AI-visibility work around brand exposure and citation share instead.
- **Invariant:** Zero-click rate slightly DECREASED (33.75%->31.53%) on keywords after AIOs appeared, in a 200K+ keyword before/after study validated against Datos clickstream data.
- **PrimarySourceUrl:** https://www.semrush.com/blog/semrush-ai-overviews-study/
- **PolicyClass:** auto-safe
- **EvidenceGrade:** verified
- **Keywords:** zero-click, aio, clickstream, datos

### aio-citations-decouple-top10
- **Title:** AIO citations increasingly decouple from organic top-10 rankings
- **Workflows:** ai-visibility, technical-audit
- **Tactic:** Do not assume organic top-10 ranking is required for AIO citation; audit AIO citation coverage separately from rank-tracking, since a majority of cited pages now rank outside the top 10.
- **Invariant:** Only 38% of AIO-cited pages ranked in the organic top-10 as of Jan 2026 (down from ~76% in Jul 2025); 31.2% of cited pages ranked 11-100 and 31.0% ranked beyond top-100, per an Ahrefs analysis of 863K SERPs / 4M AIO URLs.
- **PrimarySourceUrl:** https://ahrefs.com/blog/ai-overview-citations-top-10/
- **PolicyClass:** auto-safe
- **EvidenceGrade:** verified
- **Keywords:** aio, citations, top10, technical-audit

### ghost-citations
- **Title:** Most AI citations are "ghost citations" — cited as a source but never named
- **Workflows:** ai-visibility
- **Tactic:** Track citation rate and brand-mention rate as two distinct AI-visibility metrics; a page being cited as a source link does not mean the brand is actually named in the answer.
- **Invariant:** 61.7% of AI citations are "ghost citations" — the source page is linked but the brand is never named in the answer, across 3,981 domain appearances / 115 prompts / 4 platforms / 14 countries (Semrush/Kevin Indig study).
- **PrimarySourceUrl:** https://www.semrush.com/blog/the-ghost-citations-study/
- **PolicyClass:** auto-safe
- **EvidenceGrade:** verified
- **Keywords:** ghost-citation, citation-rate, mention-rate, ai-visibility

### query-fan-out-coverage
- **Title:** AI Overviews retrieve via query fan-out — optimize for the fan-out set, not just the head keyword
- **Workflows:** topical-map, ai-visibility
- **Tactic:** Build topical-map content that comprehensively covers the fan-out query set around a topic (related sub-questions, comparisons, specifications) rather than optimizing a single page for one head keyword.
- **Invariant:** AI Overviews retrieve results via query fan-out (generating and retrieving against a broadened set of related sub-queries), so single-keyword-optimized pages under-cover what AIO actually retrieves against.
- **PrimarySourceUrl:** https://ahrefs.com/blog/ai-overview-citations-top-10/
- **PolicyClass:** auto-safe
- **EvidenceGrade:** single-source
- **Keywords:** fan-out, topical-map, query-expansion, aio

### perplexity-community-weighted
- **Title:** Perplexity is the most community-weighted AI platform — Reddit dominates its citation mix
- **Workflows:** ai-visibility
- **Tactic:** For Perplexity-specific AI-visibility work, prioritise genuine community presence and discussion (Reddit and similar forums) over traditional publisher-style content placement.
- **Invariant:** Perplexity is the most community-weighted platform in a 680M-citation study: Reddit accounts for 6.6% of ALL Perplexity citations and 46.7% of its top-source citations.
- **PrimarySourceUrl:** https://www.tryprofound.com/blog/ai-platform-citation-patterns
- **PolicyClass:** auto-safe
- **EvidenceGrade:** verified
- **Keywords:** perplexity, reddit, community, platform-specific

### sitefocus-topical-authority
- **Title:** Topical authority is mechanically scored — site focus and page-topic deviation affect ranking potential
- **Workflows:** topical-map
- **Tactic:** Keep new content aligned to the site's established topical focus; treat high-deviation off-topic pages as ranking-risk outliers rather than easy incremental traffic.
- **Invariant:** The leaked Google Content Warehouse API documents a siteFocusScore (site dedication to one topic) and siteRadius (page deviation from the site's central theme) that operationalize topical authority; high-deviation pages are documented ranking outliers.
- **PrimarySourceUrl:** https://sparktoro.com/blog/an-anonymous-source-shared-thousands-of-leaked-google-search-api-documents-with-me-everyone-in-seo-should-see-them/
- **PolicyClass:** auto-safe
- **EvidenceGrade:** single-source
- **Keywords:** topical-authority, sitefocus, site-radius, leak

### schema-entity-aio-lift
- **Title:** Entity/schema markup measurably lifts AI Overview visibility
- **Workflows:** schema-audit, ai-visibility
- **Tactic:** Implement and validate entity-linking schema markup (Organization, Product, FAQ, and related structured data) as a standard part of every technical/schema audit, not an optional add-on.
- **Invariant:** A documented Schema App case study measured +19.72% AI Overview visibility from entity-linking / schema-markup work — one of the few quantified schema-to-GEO results.
- **PrimarySourceUrl:** https://www.schemaapp.com/schema-markup/case-study-entity-linking-increases-aio-visibility/
- **PolicyClass:** auto-safe
- **EvidenceGrade:** single-source
- **Keywords:** schema, entity, structured-data, aio-lift

### parasite-seo-placement
- **Title:** Parasite SEO placement on high-authority third-party hosts
- **Workflows:** parasite-watch
- **Tactic:** NEVER encode as an actionable tactic — placing brand content on a high-authority third-party domain (forum, subreddit, unrelated news site) specifically to borrow its ranking signal is a Google site-reputation-abuse policy violation. The Nov 2024 policy update closed the first-party-involvement loophole: no amount of oversight, white-labeling, or licensing exempts this.
- **Invariant:** This tactic must never be recommended, even as a human-approval-gated option — it is a named policy violation, not a judgment call the suite should surface as an option.
- **PrimarySourceUrl:** https://developers.google.com/search/blog/2024/03/core-update-spam-policies
- **PolicyClass:** never-encode
- **EvidenceGrade:** primary-unverified
- **Keywords:** parasite-seo, site-reputation-abuse, never-encode, policy-violation
