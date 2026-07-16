---
name: bober.seo-schema-audit
description: "Per-workflow SEO signature library for the schema-audit workflow. A data file of discrete, cited SEO tactics read by SeoPlaybookParser (src/seo/parser.ts), not a workflow skill. Encodes the entity-linking to AI Overview visibility lift (Schema App case study), Google's structured-data policy guidance, and leak-grounded date-consistency signals for the schema-audit workflow."
---

# bober.seo-schema-audit — Schema Audit Signature Library

This skill is a **signature-library** file for the `schema-audit` workflow, not a
workflow skill in its own right. It is read (as raw markdown text) by
`SeoPlaybookParser.parse()` (`src/seo/parser.ts`) and turned into typed
`SeoSignature[]` records consumed by the SEO agent team's retriever
(`SeoPlaybookRetriever`). It follows the identical block format defined and
documented in `skills/bober.seo-generic/SKILL.md` ("Signature Block Format") --
the two files are one executable spec; a block missing `Title` or
`PrimarySourceUrl`, or tagged `PolicyClass: never-encode`, is DROPPED by the
parser at load time -- see `.bober/research/research-20260715-ultimate-seo-agents-skills-research.md`
for the underlying evidence.

The signatures below encode the quantified entity-linking -> AI Overview
visibility lift (Schema App case study), Google's own structured-data
eligibility and policy documentation, and the leak's date-consistency
guidance applied to structured-data audits. Read-only validation and
audit tactics are `auto-safe`; generating and deploying structured data at
scale across a site is a structural change with policy exposure and is
`human-approve` -- consistent with research §6's automation boundary.

## Signatures

### schema-entity-linking-aio
- **Title:** Entity-linking / schema markup measurably lifts AI Overview visibility (+19.72%)
- **Workflows:** schema-audit
- **Tactic:** Prioritise entity-linking and schema-markup work as a standard, budgeted line item in every schema audit, not an optional add-on -- treat it as one of the few quantified levers with a measured AI Overview visibility outcome.
- **Invariant:** A documented Schema App case study measured a +19.72% increase in AI Overview visibility from entity-linking / schema-markup work -- one of the few quantified schema-to-GEO (generative-engine-optimization) results in the current evidence base.
- **PrimarySourceUrl:** https://www.schemaapp.com/schema-markup/case-study-entity-linking-increases-aio-visibility/
- **PolicyClass:** auto-safe
- **EvidenceGrade:** single-source
- **Keywords:** entity-linking, schema-markup, aio-lift, schema-audit

### structured-data-validation
- **Title:** Validate structured data against Google's eligibility guidance as a standard audit step
- **Workflows:** schema-audit
- **Tactic:** Run every audited page's structured data through validation against Google's documented eligibility requirements before flagging it as compliant; treat "present but invalid" markup as a distinct finding from "absent" markup.
- **Invariant:** Google's structured-data documentation defines validation and rich-result eligibility requirements that markup must satisfy; rich-result eligibility depends on valid, complete markup, not merely its presence.
- **PrimarySourceUrl:** https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data
- **PolicyClass:** auto-safe
- **EvidenceGrade:** primary-unverified
- **Keywords:** structured-data, validation, rich-results, schema-audit

### article-date-schema-alignment
- **Title:** Article schema datePublished/dateModified must align with the visible byline
- **Workflows:** schema-audit
- **Tactic:** For every audited article page, compare the structured data's datePublished and dateModified against the visible byline date on the page; flag any mismatch as an audit finding.
- **Invariant:** Google's Article structured-data documentation specifies datePublished and dateModified properties that are expected to reflect the article's actual publish/update history; misalignment with the visible byline is a documented markup-accuracy issue.
- **PrimarySourceUrl:** https://developers.google.com/search/docs/appearance/structured-data/article
- **PolicyClass:** auto-safe
- **EvidenceGrade:** primary-unverified
- **Keywords:** article-schema, datepublished, datemodified, byline-alignment

### leak-date-consistency-schema
- **Title:** Cross-check structured-data dates against on-page and URL date signals (leak-grounded)
- **Workflows:** schema-audit
- **Tactic:** As part of every schema audit, cross-check the structured data's date fields against the visible on-page byline date and any date embedded in the URL; report drift across any of the three as a single date-consistency finding.
- **Invariant:** Mike King's technical analysis of the leak states the tactical implication that bylineDate, syntacticDate, and semanticDate should be kept consistent across structured data, titles, and URLs; a schema audit is a natural enforcement point for this cross-check.
- **PrimarySourceUrl:** https://ipullrank.com/google-algo-leak
- **PolicyClass:** auto-safe
- **EvidenceGrade:** single-source
- **Keywords:** date-consistency, structured-data, leak, schema-audit

### mass-schema-generation-approval
- **Title:** Mass structured-data generation/deployment across a site requires human approval
- **Workflows:** schema-audit
- **Tactic:** Do not auto-deploy generated structured data at scale across a site; generate proposed markup, then route it through human review before publication, since bulk deployment is a structural site change with policy exposure.
- **Invariant:** Google's General Structured Data Guidelines state that structured data must accurately reflect the content of the page it's on and penalise markup that does not match visible content; generating and deploying markup at scale across many pages without per-page review is a policy-exposed structural change, so a human must approve mass generation before deployment.
- **PrimarySourceUrl:** https://developers.google.com/search/docs/appearance/structured-data/sd-policies
- **PolicyClass:** human-approve
- **EvidenceGrade:** primary-unverified
- **Keywords:** mass-schema-generation, structured-data-policy, human-approve, sd-guidelines

### entity-schema-org-product-faq
- **Title:** Implement Organization/Product/FAQ entity schema to strengthen the entity graph behind the AIO lift
- **Workflows:** schema-audit
- **Tactic:** Where absent, implement Organization, Product, and FAQ structured data (as applicable to the page type) as the concrete entity-linking work behind the measured AI Overview visibility lift, prioritising pages that already rank or are AIO-eligible.
- **Invariant:** The Schema App case study's +19.72% AI Overview visibility lift was produced by entity-linking / schema-markup work; Organization, Product, and FAQ schema are the standard entity-graph structured-data types that operationalize entity linking on a page.
- **PrimarySourceUrl:** https://www.schemaapp.com/schema-markup/case-study-entity-linking-increases-aio-visibility/
- **PolicyClass:** auto-safe
- **EvidenceGrade:** single-source
- **Keywords:** organization-schema, product-schema, faq-schema, entity-graph

### sd-policy-compliance-audit
- **Title:** Audit for structured-data policy violations (markup that doesn't reflect visible content)
- **Workflows:** schema-audit
- **Tactic:** Check every page's structured data against the visible content it describes and flag any markup that adds information not present on the page, or that is hidden/irrelevant to the user, as a policy-compliance finding -- do not wait for a manual action to surface it.
- **Invariant:** Google's General Structured Data Guidelines document policy violations including markup that doesn't reflect the page's visible content and irrelevant or misleading markup; a schema audit should proactively check for these violations.
- **PrimarySourceUrl:** https://developers.google.com/search/docs/appearance/structured-data/sd-policies
- **PolicyClass:** auto-safe
- **EvidenceGrade:** primary-unverified
- **Keywords:** structured-data-policy, compliance-audit, sd-guidelines, schema-audit
