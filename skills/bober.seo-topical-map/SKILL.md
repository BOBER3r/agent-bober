---
name: bober.seo-topical-map
description: "Per-workflow SEO signature library for the topical-map workflow. A data file of discrete, cited SEO tactics read by SeoPlaybookParser (src/seo/parser.ts), not a workflow skill. Encodes the leak's siteFocusScore/siteRadius topical-authority mechanism and AI Overview query-fan-out coverage for the topical-map workflow."
---

# bober.seo-topical-map — Topical Map Signature Library

This skill is a **signature-library** file for the `topical-map` workflow, not a
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

The signatures below encode the leaked Google Content Warehouse API's
`siteFocusScore` (site-wide dedication to one topic) and `siteRadius`
(per-page deviation from the site's central theme) topical-authority
mechanism, plus Ahrefs' finding that AI Overviews retrieve via query
fan-out, so a topical map must cover the fan-out set of sub-questions, not
just the head keyword. Most signatures here are **read-only map generation
and fan-out analysis** (auto-safe); the one signature that would publish the
full map at scale is `human-approve` -- consistent with research §6's
automation boundary.

## Signatures

### sitefocusscore-topical-dedication
- **Title:** Build the map to maximize siteFocusScore -- concentrate coverage on one dedicated topic
- **Workflows:** topical-map
- **Tactic:** Structure the topical map so new and existing pages reinforce dedication to a single central topic; when mapping candidate nodes, prefer additions that deepen the existing topical cluster over additions that diversify into unrelated subject areas.
- **Invariant:** The leaked Google Content Warehouse API documents siteFocusScore as a site-wide score that rewards a site's dedication to one topic; a topical map that maximizes coverage within a single dedicated topic is directly reinforcing a signal the leak shows Google mechanically scores.
- **PrimarySourceUrl:** https://sparktoro.com/blog/an-anonymous-source-shared-thousands-of-leaked-google-search-api-documents-with-me-everyone-in-seo-should-see-them/
- **PolicyClass:** auto-safe
- **EvidenceGrade:** single-source
- **Keywords:** sitefocusscore, topical-dedication, topical-map, leak

### siteradius-deviation-outlier-map
- **Title:** Flag high-siteRadius off-topic nodes as ranking outliers to isolate, not map targets to add
- **Workflows:** topical-map
- **Tactic:** When candidate map nodes deviate sharply from the site's established central theme, flag them as ranking-outlier risk in the map report and deliberately isolate them from the core cluster rather than adding them as easy incremental-traffic nodes.
- **Invariant:** The leak documents siteRadius as a per-page score of deviation from the site's central theme, and identifies high-deviation pages as documented ranking outliers; a topical map that adds high-siteRadius nodes without flagging them is building against the leak's own mechanism.
- **PrimarySourceUrl:** https://sparktoro.com/blog/an-anonymous-source-shared-thousands-of-leaked-google-search-api-documents-with-me-everyone-in-seo-should-see-them/
- **PolicyClass:** auto-safe
- **EvidenceGrade:** single-source
- **Keywords:** siteradius, deviation, ranking-outlier, topical-map

### query-fan-out-coverage-map
- **Title:** Cover the AI Overview query fan-out set, not just the head keyword
- **Workflows:** topical-map
- **Tactic:** Build map nodes for the fan-out query set around a topic -- related sub-questions, comparisons, and specifications -- rather than optimizing a single page for one head keyword; treat fan-out coverage as a first-class map-completeness dimension.
- **Invariant:** Ahrefs' analysis of 863K SERPs / 4M AIO URLs documents that AI Overviews retrieve results via query fan-out, generating and retrieving against a broadened set of related sub-queries; a topical map scoped only to head keywords under-covers what AIO actually retrieves against.
- **PrimarySourceUrl:** https://ahrefs.com/blog/ai-overview-citations-top-10/
- **PolicyClass:** auto-safe
- **EvidenceGrade:** single-source
- **Keywords:** fan-out, query-expansion, aio, topical-map

### topical-authority-cluster-completeness
- **Title:** Map the whole cluster -- comprehensive sub-topic coverage is mechanically scored
- **Workflows:** topical-map
- **Tactic:** Evaluate map completeness against the full sub-topic cluster rather than a handful of isolated high-value posts; report gaps in cluster coverage as map-quality findings, since comprehensive coverage of a topic is what the underlying authority mechanism rewards.
- **Invariant:** The leak's siteFocusScore mechanism operationalizes topical authority as a function of a site's dedication to one topic; comprehensive sub-topic coverage, not isolated high-value posts, is what mechanically reinforces that score.
- **PrimarySourceUrl:** https://ipullrank.com/google-algo-leak
- **PolicyClass:** auto-safe
- **EvidenceGrade:** single-source
- **Keywords:** topical-authority, cluster-completeness, sitefocusscore, coverage-gap

### commercial-intent-map-priority
- **Title:** Prioritize commercial/transactional fan-out nodes given the AIO intent-mix shift to money queries
- **Workflows:** topical-map
- **Tactic:** When ranking candidate map nodes for build priority, weight commercial and transactional fan-out queries higher than the historical default of purely informational sub-topics, reflecting where AIO trigger volume has moved.
- **Invariant:** A Semrush 10M+ keyword panel documents the AIO intent mix shifting Jan-Oct 2025: informational share fell from 91.3% to 57.1% of triggers while commercial rose to 18.57% and transactional to 13.94%; a topical map that still prioritizes informational nodes by default is misaligned with the current trigger mix.
- **PrimarySourceUrl:** https://www.semrush.com/blog/semrush-ai-overviews-study/
- **PolicyClass:** auto-safe
- **EvidenceGrade:** verified
- **Keywords:** commercial-intent, transactional, aio-intent-shift, map-priority

### new-node-central-theme-alignment
- **Title:** Keep every newly-mapped node aligned to the site's central theme (low siteRadius)
- **Workflows:** topical-map
- **Tactic:** Before adding a new node to the map, check its alignment against the site's established central theme; reject or flag proposed nodes that would push the map toward a higher average siteRadius rather than accepting any topically-adjacent traffic opportunity.
- **Invariant:** The leak documents siteRadius as a per-page score of deviation from the site's central theme, with high-deviation pages identified as documented ranking outliers; keeping new nodes low-siteRadius by design is the map-generation-time application of that same mechanism.
- **PrimarySourceUrl:** https://sparktoro.com/blog/an-anonymous-source-shared-thousands-of-leaked-google-search-api-documents-with-me-everyone-in-seo-should-see-them/
- **PolicyClass:** auto-safe
- **EvidenceGrade:** single-source
- **Keywords:** siteradius, central-theme, node-alignment, topical-map

### map-buildout-at-scale-approval
- **Title:** Publishing the full map at scale changes the live site -- requires human sign-off
- **Workflows:** topical-map
- **Tactic:** When a topical-map analysis recommends bulk-publishing a large batch of new pages to fill fan-out or cluster-completeness gaps at scale, propose the buildout plan as a report but do not execute the mass publish without explicit human approval, since scaled content production at once is a structural site change with abuse-policy exposure.
- **Invariant:** The 522-site/64%-decayed HCU baseline and the leak's contentEffort signal both associate scaled, low-effort content production with downstream decline risk; a topical-map recommendation to publish new nodes at scale therefore requires a human-owned execution decision rather than automatic publication.
- **PrimarySourceUrl:** https://detailed.com/q3/
- **PolicyClass:** human-approve
- **EvidenceGrade:** single-source
- **Keywords:** map-buildout, scaled-content, human-approve, live-site-change
