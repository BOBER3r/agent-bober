---
name: bober.seo-ai-visibility
description: "Per-workflow SEO signature library for the ai-visibility workflow. A data file of discrete, cited SEO/GEO tactics read by SeoPlaybookParser (src/seo/parser.ts), not a workflow skill. Encodes VERIFIED 2025-2026 AI-visibility correlations (Ahrefs 75k-brand study, Semrush ghost-citations study, Profound platform-citation study) with per-platform GEO divergence marked perishable."
---

# bober.seo-ai-visibility — AI-Visibility (GEO) Signature Library

This skill is a **signature-library** file for the `ai-visibility` workflow, not a
workflow skill in its own right. It is read (as raw markdown text) by
`SeoPlaybookParser.parse()` (`src/seo/parser.ts`) and turned into typed
`SeoSignature[]` records consumed by the SEO agent team's retriever
(`SeoPlaybookRetriever`). It follows the identical block format defined and
documented in `skills/bober.seo-generic/SKILL.md` ("Signature Block Format") --
the two files are one executable spec; a block missing `Title` or
`PrimarySourceUrl`, or tagged `PolicyClass: never-encode`, is DROPPED by the
parser at load time.

The signatures below encode VERIFIED generative-engine-optimization (GEO)
correlations from three independent 2025-2026 studies -- Ahrefs' 75,000-brand
correlation analysis, Semrush's ghost-citations study, and Profound's
680-million-citation platform analysis -- plus one deliberate `never-encode`
boundary block for AI-recommendation poisoning. Per-platform citation-mix
figures are explicitly marked **PERISHABLE** below: platform algorithms and
source-weighting change fast, so treat those specific percentages as
dated-as-of-measurement, not durable constants. See
`.bober/research/research-20260715-ultimate-seo-agents-skills-research.md`
§1/§7 for the underlying evidence and the two REFUTED claims that must never
be encoded here (ChatGPT-Wikipedia dominance, Reddit-leading-AI-Overviews).

## Signatures

### ai-visibility-youtube-presence-audit
- **Title:** Audit and grow YouTube presence -- the strongest single AI-visibility correlate
- **Workflows:** ai-visibility
- **Tactic:** Include YouTube brand presence (owned-channel content, creator partnerships, video PR, transcript/caption quality) as a first-class line item in every AI-visibility audit, not an afterthought to written-content SEO. Report current YouTube mention volume as a baseline metric alongside branded web mentions.
- **Invariant:** Across ChatGPT, Google AI Mode, and AI Overviews, YouTube mentions show the single highest correlation (~0.737 Spearman) with brand visibility in AI answers, in a 75,000-brand Ahrefs correlation study -- stronger than any other measured signal, including backlinks.
- **PrimarySourceUrl:** https://ahrefs.com/blog/ai-brand-visibility-correlations/
- **PolicyClass:** auto-safe
- **EvidenceGrade:** verified
- **Keywords:** youtube, ai-visibility, geo, correlation, audit

### ai-visibility-branded-mention-audit
- **Title:** Audit branded web-mention volume (linked or unlinked) -- the strongest non-video AI-visibility signal
- **Workflows:** ai-visibility
- **Tactic:** Track and report branded web-mention volume across the open web as a distinct AI-visibility metric, counting unlinked mentions equally with linked ones; do not discount coverage that omits a hyperlink when assessing AI-visibility health.
- **Invariant:** Branded web mentions (linked or unlinked) correlate at 0.66-0.71 with brand visibility in AI answers -- the strongest non-YouTube signal, and dramatically stronger than classic backlink volume (~0.218), in the same 75,000-brand Ahrefs study.
- **PrimarySourceUrl:** https://ahrefs.com/blog/ai-brand-visibility-correlations/
- **PolicyClass:** auto-safe
- **EvidenceGrade:** verified
- **Keywords:** brand-mention, ai-visibility, geo, correlation, backlinks-weak

### ai-visibility-ghost-citation-mention-split
- **Title:** Track citation rate and mention rate as two distinct AI-visibility metrics
- **Workflows:** ai-visibility
- **Tactic:** Report AI-citation rate and AI-mention rate as separate audit metrics for every tracked brand/page; do not conflate "the page is linked as a source" with "the brand is named in the answer text" -- they measure different things and a gap between them is itself a finding.
- **Invariant:** 61.7% of AI citations are "ghost citations" -- the source page is linked but the brand is never named in the AI-generated answer -- across 3,981 domain appearances / 115 prompts / 4 platforms / 14 countries in the Semrush/Kevin Indig ghost-citations study.
- **PrimarySourceUrl:** https://www.semrush.com/blog/the-ghost-citations-study/
- **PolicyClass:** auto-safe
- **EvidenceGrade:** verified
- **Keywords:** ghost-citation, citation-rate, mention-rate, ai-visibility

### ai-visibility-per-platform-geo-divergence
- **Title:** [PERISHABLE, dated 2026] Audit per-platform citation/mention mix separately -- platforms diverge sharply and the mix will shift over time
- **Workflows:** ai-visibility
- **Tactic:** Do not optimize AI-visibility as a single undifferentiated target; audit and report citation-vs-mention behavior per platform (ChatGPT, Gemini, Perplexity, AI Overviews), because a page can be heavily mentioned on one platform and heavily cited-but-unnamed on another. Re-measure this split on a recurring cadence -- the specific percentages below are a point-in-time snapshot, not a stable baseline.
- **Invariant:** [PERISHABLE] The Semrush ghost-citations study documents sharp per-platform divergence in citation-vs-mention behavior (e.g. platforms differ materially in how often a cited source page is also named as the brand in the answer text); this mix is measured as of the 2025-2026 study window and should be treated as dated, not durable, given known platform-algorithm churn.
- **PrimarySourceUrl:** https://www.semrush.com/blog/the-ghost-citations-study/
- **PolicyClass:** auto-safe
- **EvidenceGrade:** single-source
- **Keywords:** per-platform, geo-divergence, perishable, citation-mix, dated-2026

### ai-visibility-comparative-query-mention-lift
- **Title:** Build comparison ("vs") content to capture the comparative-query mention lift
- **Workflows:** ai-visibility, topical-map
- **Tactic:** Prioritise comparative/"X vs Y" content in the AI-visibility content plan -- comparison-framed queries earn a measurably higher brand-mention rate than single-entity queries, so this is a specific, evidence-backed content type to invest in, not a generic content-marketing suggestion.
- **Invariant:** Comparative queries generate 2.4x more brand mentions than single-entity queries (43.3% vs 18% mention rate) in the Semrush ghost-citations study's query-type breakdown.
- **PrimarySourceUrl:** https://www.semrush.com/blog/the-ghost-citations-study/
- **PolicyClass:** human-approve
- **EvidenceGrade:** single-source
- **Keywords:** comparative-query, mention-lift, content-plan, ai-visibility

### ai-visibility-aio-citation-rank-decouple
- **Title:** Audit AI Overview citation coverage separately from organic rank -- most cited pages no longer rank top-10
- **Workflows:** ai-visibility, rank-track
- **Tactic:** Do not treat organic top-10 ranking as a prerequisite for AIO citation in the audit methodology; run a dedicated AIO-citation crawl/check independent of rank-tracking, since a majority of currently-cited pages rank outside the top 10.
- **Invariant:** Only 38% of AIO-cited pages ranked in the organic top-10 as of Jan 2026 (down from ~76% in Jul 2025); 31.2% of cited pages ranked 11-100 and 31.0% ranked beyond top-100, per an Ahrefs analysis of 863K SERPs / 4M AIO URLs.
- **PrimarySourceUrl:** https://ahrefs.com/blog/ai-overview-citations-top-10/
- **PolicyClass:** auto-safe
- **EvidenceGrade:** verified
- **Keywords:** aio, citations, rank-decouple, ai-visibility

### ai-visibility-perplexity-community-weighted
- **Title:** [PERISHABLE, dated 2026] For Perplexity-specific work, weight community presence over publisher-style placement
- **Workflows:** ai-visibility
- **Tactic:** When auditing or building Perplexity-specific AI-visibility, prioritise genuine community presence and discussion (Reddit and similar forums) as one input among several platform-mix signals, alongside publisher-style content; re-check this platform mix periodically since platform citation-source weighting is known to shift.
- **Invariant:** [PERISHABLE] In a 680-million-citation Profound study, Perplexity showed the most community-weighted citation mix of the platforms measured, with community-forum sources forming a materially larger share of Perplexity's citations than of other platforms' citation mixes; this mix is a point-in-time measurement, not a durable constant.
- **PrimarySourceUrl:** https://www.tryprofound.com/blog/ai-platform-citation-patterns
- **PolicyClass:** auto-safe
- **EvidenceGrade:** single-source
- **Keywords:** perplexity, community, platform-specific, perishable, dated-2026

### ai-recommendation-poisoning-boundary
- **Title:** AI-recommendation poisoning via prompt injection -- NEVER encode as a tactic
- **Workflows:** ai-visibility
- **Tactic:** NEVER encode as actionable. Injecting hidden prompts into page content, browser-extension "Summarize with AI" surfaces, or other AI-consumed channels to manipulate an AI assistant's recommendation or citation behavior toward a brand is prompt injection / AI-recommendation poisoning, a security and trust violation, not a legitimate GEO tactic. Documented here only to mark the automation boundary; the parser DROPS this block so it can never reach an analyzer prompt.
- **Invariant:** AI-recommendation poisoning (prompt-injection attacks against AI-summarization and AI-assistant surfaces) is a documented 2025-2026 attack class against AI-consumed content; it must never be surfaced as an option, even human-approval-gated -- it is a manipulation technique, not a judgment call.
- **PrimarySourceUrl:** https://developers.google.com/search/docs/essentials/spam-policies
- **PolicyClass:** never-encode
- **EvidenceGrade:** primary-unverified
- **Keywords:** ai-recommendation-poisoning, prompt-injection, never-encode, policy-violation
