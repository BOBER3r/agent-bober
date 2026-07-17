---
name: bober.seo-technical-audit
description: "Per-workflow SEO signature library for the technical-audit workflow. A data file of discrete, cited SEO tactics read by SeoPlaybookParser (src/seo/parser.ts), not a workflow skill. Encodes leak-grounded ranking-mechanics signals (NavBoost click quality, contentEffort, hostAge sandbox, date consistency, named demotions) and GSC URL Inspection health-check practice for the technical-audit workflow."
---

# bober.seo-technical-audit — Technical Audit Signature Library

This skill is a **signature-library** file for the `technical-audit` workflow, not a
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
ranking-mechanics attributes (`siteAuthority`, NavBoost click signals,
`contentEffort`, `hostAge`, named demotions, byline/syntactic/semantic date
consistency) plus Google Search Console's URL Inspection API as a
programmatic health-check surface. Every signature here is a **read-only
audit**: inspecting or reporting on an existing signal, never mutating the
site -- consistent with research §6's "safely automatable" audit category.

## Signatures

### siteauthority-domain-quality
- **Title:** siteAuthority is a real, leaked, site-wide quality score -- audit domain-level authority signals
- **Workflows:** technical-audit
- **Tactic:** Include a domain-level authority read in every technical audit: check for signals of site-wide quality erosion (thin/duplicate sections, low-value subdomains) that could depress the whole site's ranking potential, not just the audited URL.
- **Invariant:** The leaked Google Content Warehouse API documents siteAuthority as a real site-wide quality score inside Compressed Quality Signals (Q*), contradicting years of public denial that such a score exists; related attributes nsrDataProto and homepagePagerankNs reinforce that site-wide quality and homepage-anchored PageRank both influence every page's ranking potential.
- **PrimarySourceUrl:** https://ipullrank.com/google-algo-leak
- **PolicyClass:** auto-safe
- **EvidenceGrade:** single-source
- **LiveWeightStatus:** documented-only
- **Keywords:** siteauthority, leak, domain-quality, compressed-quality-signals

### navboost-click-quality-audit
- **Title:** NavBoost re-ranks on rolling click history -- audit click quality and on-site UX, not just rank
- **Workflows:** technical-audit
- **Tactic:** Pull and review click-quality proxies (bounce-back behavior, dwell/engagement signals, navigation-friction points) for audited URLs as a distinct audit line item from raw ranking position; a page can rank yet be accumulating badClicks that will erode its position over the NavBoost window.
- **Invariant:** The leak documents NavBoost as a click-based re-ranking system operating over a rolling 13-month window, tracking goodClicks, badClicks, lastLongestClicks, and unsquashedClicks at the URL, subdomain, and root-domain level, and distinguishing navDemotion (on-site UX causes) from serpDemotion (SERP-behavior causes).
- **PrimarySourceUrl:** https://ipullrank.com/google-algo-leak
- **PolicyClass:** auto-safe
- **EvidenceGrade:** single-source
- **LiveWeightStatus:** documented-only
- **Keywords:** navboost, click-quality, goodclicks, badclicks, ux-audit

### contenteffort-low-effort-flag
- **Title:** contentEffort is an LLM effort score -- flag low-effort/scaled pages before they get demoted
- **Workflows:** technical-audit
- **Tactic:** Screen audited pages for low-effort/scaled-output characteristics (thin substantiation, templated boilerplate, no original analysis) and flag them for human content review; treat a low contentEffort read as an early-warning audit finding, not a wait-and-see.
- **Invariant:** The leak documents contentEffort as an LLM-based "effort estimation" Google runs on article pages; low-effort scaled output is algorithmically flagged as not people-first, which is the mechanical reason low-effort AI-generated content underperforms.
- **PrimarySourceUrl:** https://ipullrank.com/google-algo-leak
- **PolicyClass:** auto-safe
- **EvidenceGrade:** single-source
- **LiveWeightStatus:** documented-only
- **Keywords:** contenteffort, low-effort, scaled-content, people-first

### hostage-sandbox-new-domain
- **Title:** hostAge sandboxes fresh domains -- calibrate audit expectations for new sites in adversarial verticals
- **Workflows:** technical-audit
- **Tactic:** For newly-registered domains (especially in adversarial/competitive verticals such as iGaming, crypto/DeFi), set index-velocity and ranking-timeline expectations in the audit report around a documented sandbox period rather than treating slow early performance as a technical fault to fix.
- **Invariant:** The leak documents a hostAge attribute used "to sandbox fresh spam in serving time"; new domains in adversarial verticals start handicapped by this sandbox mechanism regardless of on-page technical quality.
- **PrimarySourceUrl:** https://www.hobo-web.co.uk/evidence-based-mapping-of-google-updates-to-leaked-internal-ranking-signals/
- **PolicyClass:** auto-safe
- **EvidenceGrade:** single-source
- **LiveWeightStatus:** documented-only
- **Keywords:** hostage, hostage-sandbox, new-domain, adversarial-vertical

### date-consistency-audit
- **Title:** Byline/syntactic/semantic date consistency is a leak-grounded audit line item
- **Workflows:** technical-audit
- **Tactic:** Audit every content page for date drift: compare the visible byline date against the page's syntactic date signals (structured data, title, meta) and its semantic/inferred date, and flag any page where they disagree.
- **Invariant:** Mike King's technical analysis of the leak states the tactical implication that bylineDate, syntacticDate, and semanticDate should be kept consistent across structured data, titles, and URLs; date drift across these three signals is an identifiable ranking-risk audit finding.
- **PrimarySourceUrl:** https://ipullrank.com/google-algo-leak
- **PolicyClass:** auto-safe
- **EvidenceGrade:** single-source
- **LiveWeightStatus:** documented-only
- **Keywords:** date-consistency, bylinedate, syntacticdate, semanticdate

### gsc-url-inspection-health
- **Title:** Run GSC URL Inspection as a bulk index-health check, scaled across properties within the daily cap
- **Workflows:** technical-audit
- **Tactic:** Use the Search Console URL Inspection API as the primary programmatic index-health check in technical audits; when a site's inventory exceeds a single property's daily cap, verify additional properties (e.g. subdirectories or subdomains registered separately) to scale coverage rather than exceeding the per-property quota.
- **Invariant:** The Search Console API's URL Inspection method is capped at 2,000 queries per day per property and 600 queries per minute -- a hard ceiling on bulk index auditing that a technical-audit workflow must respect and, when necessary, work around via multiple verified properties.
- **PrimarySourceUrl:** https://developers.google.com/webmaster-tools/limits
- **PolicyClass:** auto-safe
- **EvidenceGrade:** primary-unverified
- **Keywords:** gsc, url-inspection, index-health, quota, search-console-api

### named-demotions-audit
- **Title:** Audit for leak-documented named demotions (EMD, anchor-mismatch, scamness)
- **Workflows:** technical-audit
- **Tactic:** Check audited domains and pages against the leak's documented demotion triggers: exact-match-domain patterns, internal/external anchor text that mismatches the linked page's topic, and (for iGaming/crypto verticals) fraud-likelihood signals -- and report any match as a named-demotion risk finding, not a generic "low quality" note.
- **Invariant:** The leak documents persistent named demotions: exactMatchDomainDemotion (2012-era EMD), anchorMismatchDemotion combined with IsAnchorBayesSpam (Penguin-era anchor-text classification), and scamness, a 0-1023 fraud-likelihood score directly relevant to iGaming and crypto verticals.
- **PrimarySourceUrl:** https://www.hobo-web.co.uk/evidence-based-mapping-of-google-updates-to-leaked-internal-ranking-signals/
- **PolicyClass:** auto-safe
- **EvidenceGrade:** single-source
- **LiveWeightStatus:** documented-only
- **Keywords:** named-demotion, exact-match-domain, anchor-mismatch, scamness, igaming

### gsc-url-inspection-api-method
- **Title:** Use the URL Inspection index.inspect method for structured, per-URL index-status audit output
- **Workflows:** technical-audit
- **Tactic:** Call the Search Console URL Inspection API's index.inspect method directly (rather than only reading the GSC UI) so per-URL index-status results feed structured audit output that can be diffed run-over-run.
- **Invariant:** Google's Search Console API documents index.inspect as the URL Inspection method that returns per-URL index-status data programmatically, the same capability exposed in the GSC UI's URL Inspection tool, making it the correct integration point for an automated technical-audit health check.
- **PrimarySourceUrl:** https://developers.google.com/webmaster-tools/v1/urlInspection.index/inspect
- **PolicyClass:** auto-safe
- **EvidenceGrade:** primary-unverified
- **Keywords:** gsc, url-inspection, index-inspect, api-method
