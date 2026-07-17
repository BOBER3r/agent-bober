---
name: bober.seo-verticals
description: "Cross-workflow SEO signature library for competitive/regulated verticals (iGaming, crypto/DeFi, SaaS). A data file of discrete, cited SEO tactics read by SeoPlaybookParser (src/seo/parser.ts), not a workflow skill. Encodes iGaming parasite-SEO detection and regulatory-disclosure guidance, the crypto/DeFi YMYL authority-gap case (Atlendis 538% uplift), and SaaS programmatic-SEO per-page-utility guidance bounded by Google's scaled-content-abuse policy."
---

# bober.seo-verticals — Vertical Playbooks (iGaming / Crypto-DeFi / SaaS) Signature Library

This skill is a **signature-library** file covering three competitive/regulated
verticals -- iGaming, crypto/DeFi, and SaaS -- not a workflow skill in its own
right. It is read (as raw markdown text) by `SeoPlaybookParser.parse()`
(`src/seo/parser.ts`) and turned into typed `SeoSignature[]` records consumed
by the SEO agent team's retriever (`SeoPlaybookRetriever`). It follows the
identical block format defined and documented in
`skills/bober.seo-generic/SKILL.md` ("Signature Block Format") -- the two
files are one executable spec; a block missing `Title` or `PrimarySourceUrl`,
or tagged `PolicyClass: never-encode`, is DROPPED by the parser at load time.

Note: `verticals` is not itself a member of `SeoWorkflow`
(`src/seo/parser.ts:36-45`), so every block below tags `Workflows` with a real
workflow member it feeds (`technical-audit`, `parasite-watch`, `ai-visibility`,
`internal-linking`, `topical-map`) rather than `verticals`, which would be
silently filtered to `[]`. iGaming and crypto/DeFi are adversarial/YMYL
verticals where the leaked ranking-mechanics `scamness` signal and Google's
scaled-content-abuse and site-reputation-abuse policies apply directly; SaaS
programmatic SEO (pSEO) is bounded by the same scaled-content-abuse policy.
Every risk-touching tactic below is `human-approve`; the one policy-violating
tactic (mass unedited AI page generation) is a `never-encode` block the parser
drops. See `.bober/research/research-20260715-ultimate-seo-agents-skills-research.md`
§2/§3/§5 for the underlying evidence.

## Signatures

### igaming-scamness-demotion-awareness
- **Title:** Audit iGaming/crypto domains against the leak's scamness fraud-likelihood score
- **Workflows:** technical-audit, parasite-watch
- **Tactic:** Include a scamness-risk read in every iGaming/crypto technical audit: check the audited domain and its content for fraud-likelihood signals (e.g. thin licensing disclosure, unverifiable payout claims, spoofed-brand patterns) that the leak documents as directly scored, and report any match as a named-demotion risk finding rather than a generic quality note.
- **Invariant:** The leaked Google Content Warehouse API documents scamness, a 0-1023 fraud-likelihood score, as a ranking-mechanics attribute directly relevant to iGaming and crypto verticals -- these verticals are algorithmically screened for fraud signals in a way most verticals are not.
- **PrimarySourceUrl:** https://ipullrank.com/google-algo-leak
- **PolicyClass:** auto-safe
- **EvidenceGrade:** single-source
- **LiveWeightStatus:** documented-only
- **Keywords:** igaming, crypto, scamness, leak, named-demotion

### igaming-parasite-detection
- **Title:** Detect competitor parasite-SEO placements specifically within iGaming/affiliate SERPs
- **Workflows:** parasite-watch
- **Tactic:** Run vertical-scoped SERP monitoring for iGaming/affiliate target keywords, watching for competitor "best casino"/"top betting site" listicles placed on high-authority third-party hosts; flag new parasite entrants for the human operator. This is READ-ONLY SERP monitoring, never a placement action, and is a vertical-specific instance of the general parasite-watch detection pattern.
- **Invariant:** Reporting on iGaming affiliate SERPs documents parasite SEO as a persistent, industry-specific problem -- affiliates report material organic-traffic decline attributable to parasite competitors, with enforcement against violators inconsistent -- making vertical-scoped continuous monitoring the practical defensive baseline.
- **PrimarySourceUrl:** https://www.affiversemedia.com/parasite-seo-is-thriving-in-igaming-and-its-costing-affiliates/
- **PolicyClass:** auto-safe
- **EvidenceGrade:** primary-unverified
- **Keywords:** igaming, parasite-seo, detection, serp-monitoring

### igaming-regulatory-disclosure
- **Title:** Route iGaming regulatory disclosure (ASA / Gambling Commission-adjacent) claims through human approval
- **Workflows:** technical-audit
- **Tactic:** Treat any content change that touches gambling-advertising disclosure, responsible-gambling messaging, or licensing claims as YMYL content requiring human legal/compliance sign-off before publication; never auto-publish or auto-edit disclosure-adjacent copy as part of an automated audit remediation.
- **Invariant:** iGaming affiliate-marketing reporting documents disclosure and regulatory compliance (advertising-standards and gambling-commission-adjacent obligations) as a live, actively-enforced constraint on iGaming SEO/content operations, distinct from and in addition to ordinary search-spam policy.
- **PrimarySourceUrl:** https://www.businessofigaming.com/parasite-seo-affiliate-marketing/
- **PolicyClass:** human-approve
- **EvidenceGrade:** primary-unverified
- **Keywords:** igaming, regulatory-disclosure, ymyl, compliance, human-approve

### defi-authority-gap-beatable
- **Title:** A DeFi authority gap is beatable with structural work -- the Atlendis case (538% uplift)
- **Workflows:** internal-linking, technical-audit
- **Tactic:** For DeFi/crypto clients facing an authority gap against larger incumbents, recommend (human-approval-gated -- this is structural site work) a combined domain-authority-building and content-migration plan modeled on the Atlendis case: consolidate content onto the root domain rather than a hosted subdomain, and pursue targeted authority-building rather than assuming the gap is unbeatable.
- **Invariant:** Atlendis achieved a 538% organic-traffic uplift in roughly 9 months while starting from a domain authority of 12 against competitors at 38-50, with migrating content from a hosted Medium subdomain to the root domain contributing a further 218% increase -- a documented case that a large authority gap in the DeFi vertical is structurally beatable.
- **PrimarySourceUrl:** https://victoriaolsina.com/case-studies/defi-seo/
- **PolicyClass:** human-approve
- **EvidenceGrade:** single-source
- **Keywords:** defi, crypto, authority-gap, migration, case-study

### crypto-ymyl-editorial-override
- **Title:** Route crypto/DeFi YMYL content changes through editorial human approval, not auto-publish
- **Workflows:** technical-audit, ai-visibility
- **Tactic:** For crypto/DeFi content (investment claims, protocol-risk disclosures, financial-advice-adjacent copy), require human editorial sign-off before any audit-driven content change ships; do not auto-apply content edits in this vertical even when the underlying finding (e.g. a contentEffort or scamness flag) is high-confidence.
- **Invariant:** The leak's scamness scoring and documented manual-whitelist mechanisms for sensitive verticals indicate Google applies extra editorial scrutiny to YMYL-adjacent content in financial verticals; crypto/DeFi content changes carry outsized ranking and trust risk if published without human review.
- **PrimarySourceUrl:** https://ipullrank.com/google-algo-leak
- **PolicyClass:** human-approve
- **EvidenceGrade:** single-source
- **LiveWeightStatus:** documented-only
- **Keywords:** crypto, defi, ymyl, editorial-review, scamness

### saas-pseo-per-page-utility
- **Title:** Programmatic SEO for SaaS works only with genuine per-page utility -- audit for the scaled-content-abuse boundary
- **Workflows:** topical-map, technical-audit
- **Tactic:** Before approving a programmatic-SEO (pSEO) page-generation plan for a SaaS client, require each templated page to demonstrate genuine per-page utility (real underlying data, a distinct user need, non-boilerplate content) as a human-approval gate; audit existing pSEO inventory for pages that are templated-but-empty of unique value, which is the scaled-content-abuse risk signal, not the page-generation approach itself.
- **Invariant:** Google's scaled-content-abuse policy targets mass-produced content lacking genuine per-page value, not programmatic content generation per se -- pSEO succeeds at scale specifically when each page carries real utility, which is the boundary a human-approval gate must enforce before mass publication.
- **PrimarySourceUrl:** https://developers.google.com/search/blog/2024/03/core-update-spam-policies
- **PolicyClass:** human-approve
- **EvidenceGrade:** primary-unverified
- **Keywords:** saas, pseo, programmatic-seo, scaled-content-abuse, per-page-utility

### igaming-ads-certification-compliance
- **Title:** Google Ads gambling certification + per-country licensing is a hard paid-ads compliance gate for iGaming
- **Workflows:** technical-audit
- **Tactic:** Before any iGaming paid-search campaign passes a technical/compliance audit, verify the advertiser holds current Google Ads gambling certification and a valid license or registration in each individually targeted country; confirm the campaign only targets approved countries, that no targeting reaches minors, and that every landing page displays responsible-gambling information -- flag any gap as a compliance-blocking finding, not a nice-to-have.
- **Invariant:** Google's gambling advertising policy requires advertisers to hold certification plus a valid license/registration per targeted country (a separate certification per country -- e.g. the UK requires Gambling Commission registration and a license number), restricts targeting to approved countries only, forbids targeting minors, and requires landing pages to show responsible-gambling information; this policy governs paid ads, not organic ranking.
- **PrimarySourceUrl:** https://support.google.com/adspolicy/answer/15132179
- **PolicyClass:** human-approve
- **EvidenceGrade:** verified
- **Keywords:** igaming, google-ads, certification, licensing, responsible-gambling, compliance

### crypto-igaming-site-reputation-abuse-audit
- **Title:** Site-reputation-abuse policy closed the first-party-oversight loophole -- audit crypto/iGaming properties for undisclosed third-party placements
- **Workflows:** technical-audit, parasite-watch
- **Tactic:** Audit crypto/DeFi and iGaming content properties for third-party-authored sections (sponsored "best casino"/"top token" guides, licensed review content) published under the brand's own domain, and flag any section lacking genuine first-party editorial oversight; do not accept a claimed licensing, white-label, or partial-ownership arrangement as evidence of compliance -- the Nov 2024 policy update removed that exemption.
- **Invariant:** Google's Nov 19 2024 site-reputation-abuse policy update closed the first-party-oversight loophole: no amount of white-labelling, licensing, partial ownership, or claimed editorial oversight exempts third-party content hosted to exploit a domain's ranking signals; Google explicitly states it does not take a site's claims about content production at face value -- directly relevant to crypto/DeFi and iGaming verticals where sponsored/affiliate content is common.
- **PrimarySourceUrl:** https://developers.google.com/search/blog/2024/11/site-reputation-abuse
- **PolicyClass:** human-approve
- **EvidenceGrade:** verified
- **Keywords:** site-reputation-abuse, parasite-seo, crypto, igaming, editorial-oversight

### saas-scaled-content-intent-audit
- **Title:** Scaled-content-abuse is judged by intent, not production method -- audit SaaS pSEO output regardless of AI/human/hybrid authorship
- **Workflows:** topical-map, technical-audit
- **Tactic:** When auditing a SaaS programmatic-SEO template set, evaluate pages against manipulative-intent and user-value signals (duplicate boilerplate, near-identical pages, absence of unique underlying data) rather than by whether the content was AI-generated, human-written, or hybrid; do not treat human involvement alone as a safety exemption from the scaled-content-abuse review.
- **Invariant:** Google's scaled-content-abuse policy is explicitly method-agnostic -- content "no matter how it's created" (AI, human, or hybrid) is judged by whether it was produced primarily to manipulate rankings with little or no user value, not by production method; a documented case of a 50,000-page near-duplicate programmatic travel site saw it roughly 98% deindexed within three months.
- **PrimarySourceUrl:** https://developers.google.com/search/docs/essentials/spam-policies
- **PolicyClass:** auto-safe
- **EvidenceGrade:** verified
- **Keywords:** saas, pseo, scaled-content-abuse, method-agnostic, intent-test

### mass-ai-page-generation-boundary
- **Title:** Mass unedited AI page generation -- NEVER encode as a tactic
- **Workflows:** topical-map, technical-audit
- **Tactic:** NEVER encode as actionable. Generating large volumes of AI-written pages without meaningful human editing or genuine per-page utility, purely to scale up indexed page count, is a NAMED Google scaled-content-abuse violation. Documented here only to mark the automation boundary; the parser DROPS this block so it can never reach an analyzer prompt.
- **Invariant:** Scaled-content abuse (mass-produced, unedited or minimally-edited content generated primarily to manipulate search rankings) is a named spam policy -- must never be surfaced as an option, even human-approval-gated, regardless of vertical.
- **PrimarySourceUrl:** https://developers.google.com/search/docs/essentials/spam-policies
- **PolicyClass:** never-encode
- **EvidenceGrade:** primary-unverified
- **Keywords:** mass-ai-pages, scaled-content-abuse, never-encode, policy-violation
