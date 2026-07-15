---
name: bober.seo-internal-linking
description: "Per-workflow SEO signature library for the internal-linking workflow. A data file of discrete, cited SEO tactics read by SeoPlaybookParser (src/seo/parser.ts), not a workflow skill. Encodes leak-grounded siteFocusScore/siteRadius topical-consolidation signals and fresh/top-tier-indexed link value for the internal-linking workflow."
---

# bober.seo-internal-linking — Internal Linking Signature Library

This skill is a **signature-library** file for the `internal-linking` workflow, not a
workflow skill in its own right. It is read (as raw markdown text) by
`SeoPlaybookParser.parse()` (`src/seo/parser.ts`) and turned into typed
`SeoSignature[]` records consumed by the SEO agent team's retriever
(`SeoPlaybookRetriever`). It follows the identical block format defined and
documented in `skills/bober.seo-generic/SKILL.md` ("Signature Block Format") --
the two files are one executable spec; a block missing `Title` or
`PrimarySourceUrl`, or tagged `PolicyClass: never-encode`, is DROPPED by the
parser at load time -- see `.bober/research/research-20260715-ultimate-seo-agents-skills-research.md`
for the underlying evidence.

The signatures below encode the leaked Google Content Warehouse API's
`siteFocusScore` / `siteRadius` topical-consolidation attributes, the
tactical implication that fresh/top-tier-indexed pages pass more link
value, and the anchor-text demotion signal. Most signatures here are
**read-only analysis** (auto-safe); the one signature that would execute a
redirect or page-merge is `human-approve`, since it is a structural site
change, not an audit -- consistent with research §6's automation boundary.

## Signatures

### sitefocus-internal-consolidation
- **Title:** Concentrate internal links within topical clusters to reinforce siteFocusScore
- **Workflows:** internal-linking
- **Tactic:** Link new and existing pages primarily to other pages within the same topical cluster; avoid diluting internal link equity across unrelated topics on the site.
- **Invariant:** The leaked Google Content Warehouse API documents a siteFocusScore that rewards a site's dedication to one topic; concentrating internal links within topical clusters reinforces the site-wide signal the leak shows Google is mechanically scoring.
- **PrimarySourceUrl:** https://sparktoro.com/blog/an-anonymous-source-shared-thousands-of-leaked-google-search-api-documents-with-me-everyone-in-seo-should-see-them/
- **PolicyClass:** auto-safe
- **EvidenceGrade:** single-source
- **Keywords:** sitefocus, topical-cluster, internal-linking, leak

### siteradius-deviation-outlier
- **Title:** Limit internal link equity flowing to high-siteRadius off-topic outlier pages
- **Workflows:** internal-linking
- **Tactic:** When auditing internal-link structure, identify pages that deviate sharply from the site's central topic and deliberately limit the internal-link equity routed to them rather than treating them as easy incremental-traffic targets.
- **Invariant:** The leaked Google Content Warehouse API documents siteRadius, which scores each page's deviation from the site's central theme; the leak identifies high-deviation pages as documented ranking outliers, so an internal-linking strategy should isolate rather than reinforce them.
- **PrimarySourceUrl:** https://sparktoro.com/blog/an-anonymous-source-shared-thousands-of-leaked-google-search-api-documents-with-me-everyone-in-seo-should-see-them/
- **PolicyClass:** auto-safe
- **EvidenceGrade:** single-source
- **Keywords:** siteradius, deviation, ranking-outlier, internal-linking

### fresh-toptier-link-value
- **Title:** Route internal links from freshly-updated, well-indexed hub pages
- **Workflows:** internal-linking
- **Tactic:** Prioritise placing internal links to priority pages from hub/pillar pages that are frequently updated and confirmed well-indexed, rather than from stale or thinly-indexed pages.
- **Invariant:** Mike King's technical analysis of the leak states the tactical implication that links from fresh and top-tier-indexed pages weigh more in Google's ranking systems than links from stale or poorly-indexed pages.
- **PrimarySourceUrl:** https://ipullrank.com/google-algo-leak
- **PolicyClass:** auto-safe
- **EvidenceGrade:** single-source
- **Keywords:** fresh-link, top-tier-indexed, link-value, hub-page

### anchor-mismatch-demotion
- **Title:** Keep internal anchor text on-topic to avoid anchorMismatchDemotion
- **Workflows:** internal-linking
- **Tactic:** Audit internal anchor text for relevance to the linked page's actual topic; avoid over-optimized, keyword-stuffed, or topically mismatched anchor text even when it targets a high-value keyword.
- **Invariant:** The leak documents anchorMismatchDemotion together with IsAnchorBayesSpam, a Penguin-era anchor-text spam classifier; anchor text that does not match the linked page's topic is a documented demotion trigger.
- **PrimarySourceUrl:** https://ipullrank.com/google-algo-leak
- **PolicyClass:** auto-safe
- **EvidenceGrade:** single-source
- **Keywords:** anchor-text, anchor-mismatch-demotion, penguin, internal-linking

### authority-consolidation-merge
- **Title:** Consolidating overlapping pages concentrates authority -- but requires a human-approved redirect/migration
- **Workflows:** internal-linking
- **Tactic:** When internal-link analysis surfaces overlapping or cannibalising pages, propose consolidating them into the stronger URL and routing internal links accordingly; do not execute the redirect or migration without a human sign-off, since it is a structural site change.
- **Invariant:** The leak's siteAuthority and homepagePagerankNs attributes give a mechanical basis for authority-consolidation strategy (merging overlapping pages into the stronger URL to concentrate site-wide authority signals); because consolidation requires redirects and site migration, a human must own the execution decision.
- **PrimarySourceUrl:** https://ipullrank.com/google-algo-leak
- **PolicyClass:** human-approve
- **EvidenceGrade:** single-source
- **Keywords:** authority-consolidation, redirect, site-migration, human-approve

### topical-cluster-hub-spoke
- **Title:** Build hub-and-spoke internal linking to concentrate siteFocusScore-scored topical authority
- **Workflows:** internal-linking
- **Tactic:** Structure internal linking as hub pages fanning out to member/spoke pages within a topic, rather than flat, undifferentiated cross-linking across the whole site.
- **Invariant:** The leak's siteFocusScore mechanically rewards a site's dedication to one topic; a hub-and-spoke internal-link structure concentrates topical signal into a small set of pillar pages instead of diffusing it flatly across the site.
- **PrimarySourceUrl:** https://sparktoro.com/blog/an-anonymous-source-shared-thousands-of-leaked-google-search-api-documents-with-me-everyone-in-seo-should-see-them/
- **PolicyClass:** auto-safe
- **EvidenceGrade:** single-source
- **Keywords:** hub-spoke, topical-cluster, sitefocusscore, internal-linking
