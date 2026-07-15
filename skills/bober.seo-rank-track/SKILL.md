---
name: bober.seo-rank-track
description: "Per-workflow SEO signature library for the rank-track workflow. A data file of discrete, cited SEO tactics read by SeoPlaybookParser (src/seo/parser.ts), not a workflow skill. Encodes AI Overview citation-vs-rank decoupling, AIO prevalence volatility, and the zero-click-rate reality for the rank-track workflow."
---

# bober.seo-rank-track — Rank Tracking Signature Library

This skill is a **signature-library** file for the `rank-track` workflow, not a
workflow skill in its own right. It is read (as raw markdown text) by
`SeoPlaybookParser.parse()` (`src/seo/parser.ts`) and turned into typed
`SeoSignature[]` records consumed by the SEO agent team's retriever
(`SeoPlaybookRetriever`). It follows the identical block format defined and
documented in `skills/bober.seo-generic/SKILL.md` ("Signature Block Format") --
the two files are one executable spec; a block missing `Title` or
`PrimarySourceUrl`, or tagged `PolicyClass: never-encode`, is DROPPED by the
parser at load time -- see
`.bober/research/research-20260715-ultimate-seo-agents-skills-research.md`
for the underlying evidence.

The signatures below encode Ahrefs' and Semrush's 2025-2026 rank-tracking
studies: AI Overview citation increasingly decouples from organic top-10
position (only 38% of AIO-cited pages rank top-10), AIO prevalence and
intent mix are highly volatile, zero-click rate has not spiked as claimed,
and most AI citations are "ghost citations" (linked but unnamed). Every
signature here is pure read-only monitoring/analysis, so all are
**auto-safe** -- consistent with research §6's automation boundary.

## Signatures

### aio-citation-rank-decouple
- **Title:** Track AIO-citation coverage as a metric separate from organic rank -- only 38% of cited pages rank top-10
- **Workflows:** rank-track
- **Tactic:** Record AIO-citation status as an independent tracked metric alongside position, not as a proxy derived from rank; a page can be a heavily-cited AIO source while ranking well outside the organic top-10, so rank-only tracking misses most of the citation surface.
- **Invariant:** An Ahrefs analysis of 863K SERPs / 4M AIO URLs found only 38% of AIO-cited pages ranked in the organic top-10 as of Jan 2026 (down from ~76% in Jul 2025), with 31.2% ranking 11-100 and 31.0% ranking beyond top-100.
- **PrimarySourceUrl:** https://ahrefs.com/blog/ai-overview-citations-top-10/
- **PolicyClass:** auto-safe
- **EvidenceGrade:** verified
- **Keywords:** aio-citation, rank-decouple, top10, ahrefs

### zero-click-reality-check
- **Title:** Zero-click rate slightly decreased after AIOs appeared -- don't over-index on click-loss panic
- **Workflows:** rank-track
- **Tactic:** When interpreting rank-tracking data for click-loss risk, do not default to a narrative of AIO-driven zero-click collapse; report the measured, small directional change instead of an assumed large one.
- **Invariant:** A 200K+ keyword before/after study validated against Datos clickstream data found the zero-click rate slightly DECREASED (33.75% to 31.53%) on keywords after AI Overviews appeared.
- **PrimarySourceUrl:** https://www.semrush.com/blog/semrush-ai-overviews-study/
- **PolicyClass:** auto-safe
- **EvidenceGrade:** verified
- **Keywords:** zero-click, reality-check, datos, clickstream

### aio-prevalence-volatility-cadence
- **Title:** AI Overview prevalence swings hard -- re-measure on a recurring cadence, not a one-time snapshot
- **Workflows:** rank-track
- **Tactic:** Schedule AIO-prevalence re-measurement for tracked queries on a recurring cadence; treat AIO as a churning surface that needs standing monitoring, not a one-time audit finding that stays valid indefinitely.
- **Invariant:** A Semrush 10M+ keyword panel documents AIO prevalence fluctuating through 2025 from 6.49% of queries (Jan) to 24.61% (Jul) to 15.69% (Nov) -- a large enough swing that a single-point measurement is stale within weeks.
- **PrimarySourceUrl:** https://www.semrush.com/blog/semrush-ai-overviews-study/
- **PolicyClass:** auto-safe
- **EvidenceGrade:** verified
- **Keywords:** aio-prevalence, volatility, monitoring-cadence, semrush

### commercial-intent-trigger-shift
- **Title:** Track commercial/transactional AIO triggers -- intent mix has moved decisively to money queries
- **Workflows:** rank-track
- **Tactic:** Segment rank-tracking reports by intent (informational vs. commercial vs. transactional) and surface the commercial/transactional AIO-trigger trend as a distinct tracked line, since it reflects where the AIO surface is actually shifting.
- **Invariant:** The same Semrush 10M+ keyword panel documents AIO intent mix shifting Jan-Oct 2025: informational share fell from 91.3% to 57.1% of triggers while commercial rose to 18.57% and transactional to 13.94%.
- **PrimarySourceUrl:** https://www.semrush.com/blog/semrush-ai-overviews-study/
- **PolicyClass:** auto-safe
- **EvidenceGrade:** verified
- **Keywords:** commercial-intent, transactional, aio-trigger-shift, rank-track

### rank-track-monitoring-cadence
- **Title:** Track position on a standing recurring cadence rather than ad-hoc spot checks
- **Workflows:** rank-track
- **Tactic:** Run position tracking as a recurring, read-only monitoring pass on a fixed cadence for tracked queries/URLs, rather than triggering checks only ad-hoc when a stakeholder asks; a recurring cadence is what makes AIO-citation-decouple and volatility findings comparable run-over-run.
- **Invariant:** Both the AIO citation-decouple finding (38% top-10 alignment, down from ~76% seven months earlier) and the AIO prevalence-volatility finding (6.49%->24.61%->15.69% across 2025) show the ranking/citation surface moving materially within months, which only a recurring monitoring cadence can capture.
- **PrimarySourceUrl:** https://www.semrush.com/blog/semrush-ai-overviews-study/
- **PolicyClass:** auto-safe
- **EvidenceGrade:** verified
- **Keywords:** rank-track, monitoring-cadence, recurring, position-tracking

### ghost-citation-two-metric-tracking
- **Title:** Track citation-rate and mention-rate as two separate metrics -- most AI citations are "ghost citations"
- **Workflows:** rank-track
- **Tactic:** Report AI citation-rate (linked as a source) and brand-mention-rate (named in the answer text) as two distinct tracked metrics rather than treating a citation as evidence the brand was actually named.
- **Invariant:** A Semrush/Kevin Indig study of 3,981 domain appearances / 115 prompts / 4 platforms / 14 countries found 61.7% of AI citations are "ghost citations" -- the source page is linked but the brand is never named in the answer.
- **PrimarySourceUrl:** https://www.semrush.com/blog/the-ghost-citations-study/
- **PolicyClass:** auto-safe
- **EvidenceGrade:** verified
- **Keywords:** ghost-citation, citation-rate, mention-rate, two-metric

### navboost-click-quality-leading-indicator
- **Title:** Watch good/bad-click proxies as a leading indicator of upcoming rank movement
- **Workflows:** rank-track
- **Tactic:** Include click-quality proxies (bounce-back behavior, dwell/engagement signals) as a tracked leading-indicator line item alongside raw position, since click-history shifts can precede a rank change rather than only follow it.
- **Invariant:** The leaked Google Content Warehouse API documents NavBoost as a click-based re-ranking system tracking goodClicks, badClicks, lastLongestClicks, and unsquashedClicks over a rolling 13-month window; a shift in this click history is a mechanical input to future re-ranking, making it a leading indicator worth tracking alongside position.
- **PrimarySourceUrl:** https://ipullrank.com/google-algo-leak
- **PolicyClass:** auto-safe
- **EvidenceGrade:** single-source
- **Keywords:** navboost, click-quality, leading-indicator, rank-track
