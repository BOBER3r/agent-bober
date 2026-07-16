---
name: bober.seo-parasite-watch
description: "Per-workflow SEO signature library for the parasite-watch workflow. A data file of discrete, cited SEO tactics read by SeoPlaybookParser (src/seo/parser.ts), not a workflow skill. Encodes READ-ONLY detection/monitoring guidance for competitors' parasite SEO on high-DR third-party hosts, plus the Nov-2024 site-reputation-abuse policy, framed exclusively as defender-side awareness. Every policy-violating tactic itself (placement, expired-domain plays, paid links) is encoded ONLY as a never-encode block the parser drops -- see the safety note below."
---

# bober.seo-parasite-watch — Parasite-SEO Detection Signature Library

This skill is a **signature-library** file for the `parasite-watch` workflow, not
a workflow skill in its own right. It is read (as raw markdown text) by
`SeoPlaybookParser.parse()` (`src/seo/parser.ts`) and turned into typed
`SeoSignature[]` records consumed by the SEO agent team's retriever
(`SeoPlaybookRetriever`). It follows the identical block format defined and
documented in `skills/bober.seo-generic/SKILL.md` ("Signature Block Format") --
the two files are one executable spec; a block missing `Title` or
`PrimarySourceUrl`, or tagged `PolicyClass: never-encode`, is DROPPED by the
parser at load time.

**Safety framing (read before editing this file):** parasite SEO is an
adversarial tactic under a NAMED Google spam policy. Every surviving block
below is read-only competitor monitoring -- phrased as Detect / Monitor / Flag
/ Audit, never as an instruction to place content, buy links, or register a
domain. Every policy-violating tactic itself (placement on a third-party host,
expired-domain authority plays, paid links) is encoded as a `PolicyClass:
never-encode` block, which the parser hard-drops at `src/seo/parser.ts:111` so
it never reaches an analyzer prompt -- it exists here only to document the
automation boundary for human readers, mirroring the precedent block
`parasite-seo-placement` in `skills/bober.seo-generic/SKILL.md:163-171`. See
`.bober/research/research-20260715-ultimate-seo-agents-skills-research.md`
§3/§6 for the underlying policy evidence.

## Signatures

### parasite-competitor-detection-highdr-hosts
- **Title:** Detect competitors' parasite SEO on high-DR third-party hosts
- **Workflows:** parasite-watch
- **Tactic:** Monitor target SERPs for competitor content placed on high-authority third-party hosts (Forbes, Reddit, Medium, major news outlets, .edu domains) -- keyword-stuffed "best <X>" listicles or review pages outranking dedicated competitor sites are the parasite-SEO signal. Flag newly-appearing parasite entrants for the human operator to review. This is READ-ONLY SERP monitoring, never a placement action.
- **Invariant:** Parasite SEO (site-reputation abuse) remains widespread across gambling/affiliate SERPs despite the Nov-2024 policy update; continuous SERP monitoring detects new parasite entrants a defender must respond to.
- **PrimarySourceUrl:** https://developers.google.com/search/blog/2024/11/site-reputation-abuse
- **PolicyClass:** auto-safe
- **EvidenceGrade:** primary-unverified
- **Keywords:** parasite-seo, detection, site-reputation-abuse, serp-monitoring, competitor

### site-reputation-abuse-policy-awareness
- **Title:** Maintain policy awareness of the Nov-2024 site-reputation-abuse loophole closure
- **Workflows:** parasite-watch
- **Tactic:** Keep the parasite-watch audit report's policy-reference section current with Google's site-reputation-abuse definition; use it as the classification rubric when flagging detected competitor placements, so findings are labeled against the actual named policy rather than an informal "seems spammy" judgment.
- **Invariant:** Google's Nov 2024 policy update closed the first-party-involvement loophole for site-reputation abuse: no amount of third-party oversight, white-labeling, or licensing arrangement exempts content hosted to exploit another site's ranking signal.
- **PrimarySourceUrl:** https://developers.google.com/search/blog/2024/11/site-reputation-abuse
- **PolicyClass:** auto-safe
- **EvidenceGrade:** primary-unverified
- **Keywords:** site-reputation-abuse, policy-awareness, nov-2024, classification

### standalone-section-algorithm-watch
- **Title:** Watch for Google scoring a site section as "standalone" from the main site
- **Workflows:** parasite-watch, technical-audit
- **Tactic:** Audit site sections (subdomains, subdirectories with distinct editorial control or topic focus) for the risk of being algorithmically scored as standalone from the main site's authority; report any section showing "starkly different" content/purpose from the core site as a silent-traffic-loss risk finding, not a policy violation -- this is a ranking-mechanics watch item, not a spam classification.
- **Invariant:** Google's spam-policy documentation notes that a site section starkly different in purpose from the rest of the site may be scored as if it were a standalone entity, which can silently reduce the traffic that section inherits from the main site's authority -- a distinct risk from an outright policy violation.
- **PrimarySourceUrl:** https://developers.google.com/search/docs/essentials/spam-policies
- **PolicyClass:** auto-safe
- **EvidenceGrade:** primary-unverified
- **Keywords:** standalone-section, algorithm-watch, silent-traffic-loss, technical-audit

### parasite-serp-monitoring-new-entrants
- **Title:** Run continuous SERP monitoring for new parasite-SEO entrants in adversarial verticals
- **Workflows:** parasite-watch
- **Tactic:** Schedule recurring (not one-time) SERP checks for target keywords in adversarial verticals (iGaming, affiliate, crypto) to catch new parasite placements as they appear; a single audit snapshot understates the problem because parasite entrants rotate hosts and rankings volatilely.
- **Invariant:** Industry reporting on iGaming affiliate SERPs documents parasite SEO as an ongoing, shifting problem -- new placements appear and enforcement against them is inconsistent -- making continuous monitoring, not a one-time audit, the correct defensive cadence.
- **PrimarySourceUrl:** https://www.affiversemedia.com/parasite-seo-is-thriving-in-igaming-and-its-costing-affiliates/
- **PolicyClass:** auto-safe
- **EvidenceGrade:** primary-unverified
- **Keywords:** serp-monitoring, new-entrants, igaming, continuous-audit

### remediation-trap-awareness
- **Title:** Flag remediation traps before recommending a manual-action response
- **Workflows:** parasite-watch
- **Tactic:** When a site under audit has a manual action or reputation-abuse penalty, route any proposed remediation (noindexing the offending section, moving content to a different subdirectory) through human approval; do not auto-recommend noindex as a fix, and explicitly flag that relocating penalized content to a new path may itself be treated as circumvention rather than remediation.
- **Invariant:** Noindexing a section does not automatically remove an existing manual action, and moving previously-penalized content into a new subdirectory can be treated by Google as an attempt to circumvent the action rather than a genuine fix -- both are documented remediation traps in Google's spam-policy guidance.
- **PrimarySourceUrl:** https://developers.google.com/search/docs/essentials/spam-policies
- **PolicyClass:** human-approve
- **EvidenceGrade:** primary-unverified
- **Keywords:** remediation-trap, manual-action, circumvention, human-approve

### igaming-parasite-defensive-playbook
- **Title:** Defend against iGaming parasite-SEO pressure with long-tail targeting and diversified traffic
- **Workflows:** parasite-watch
- **Tactic:** For iGaming/affiliate clients facing parasite-SEO pressure on head terms, recommend (human-approval-gated, since it is a strategic content/PR investment) a defensive mix of long-tail keyword targeting the parasite entrants under-cover, genuine E-E-A-T-building PR (real expert bylines, verifiable credentials), and traffic-source diversification so no single SERP category dominates revenue exposure.
- **Invariant:** Reporting on the iGaming affiliate-marketing parasite-SEO landscape documents affiliates experiencing organic-traffic declines from parasite competitors and recommends long-tail targeting, genuine authority-building, and traffic diversification as the practical defensive response, alongside continuous monitoring.
- **PrimarySourceUrl:** https://www.businessofigaming.com/parasite-seo-affiliate-marketing/
- **PolicyClass:** human-approve
- **EvidenceGrade:** primary-unverified
- **Keywords:** igaming, defensive-playbook, long-tail, eeat, traffic-diversification

### parasite-seo-placement-boundary
- **Title:** Parasite-SEO placement on high-DR third-party hosts -- NEVER encode as a tactic
- **Workflows:** parasite-watch
- **Tactic:** NEVER encode as actionable. Placing brand or client content on a high-authority third-party domain (forum, subreddit, unrelated news site) specifically to borrow its ranking signal is a Google site-reputation-abuse policy violation, regardless of disclosure or licensing arrangement. Documented here only to mark the automation boundary; the parser DROPS this block so it can never reach an analyzer prompt.
- **Invariant:** This tactic must never be recommended, even as a human-approval-gated option -- it is a named policy violation, not a judgment call the suite should surface as an option. See the identical precedent in the generic skill's `parasite-seo-placement` block.
- **PrimarySourceUrl:** https://developers.google.com/search/blog/2024/11/site-reputation-abuse
- **PolicyClass:** never-encode
- **EvidenceGrade:** primary-unverified
- **Keywords:** parasite-seo, never-encode, policy-violation, site-reputation-abuse

### expired-domain-authority-play-boundary
- **Title:** Expired-domain authority acquisition -- NEVER encode as a tactic
- **Workflows:** parasite-watch
- **Tactic:** NEVER encode as actionable. Buying/re-registering an expired domain to inherit its historic authority and backlinks (then redirecting or rebuilding on it) is a NAMED Google spam violation ("expired domain abuse", March 2024). Documented here only to mark the automation boundary; the parser DROPS this block so it can never reach an analyzer prompt.
- **Invariant:** Expired-domain abuse is a named spam policy -- must never be surfaced as an option, even human-approval-gated.
- **PrimarySourceUrl:** https://developers.google.com/search/blog/2024/03/core-update-spam-policies
- **PolicyClass:** never-encode
- **EvidenceGrade:** primary-unverified
- **Keywords:** expired-domain, authority-play, never-encode, policy-violation

### paid-links-boundary
- **Title:** Buying or selling links that pass ranking signal -- NEVER encode as a tactic
- **Workflows:** parasite-watch
- **Tactic:** NEVER encode as actionable. Buying links, selling links that pass PageRank-style signal, or exchanging goods/services (including paid posts or sponsorships) specifically for links intended to manipulate ranking is a NAMED Google link-spam violation. Documented here only to mark the automation boundary; the parser DROPS this block so it can never reach an analyzer prompt.
- **Invariant:** Paid/link-spam schemes are a named spam policy category in Google's living spam-policy reference -- must never be surfaced as an option, even human-approval-gated.
- **PrimarySourceUrl:** https://developers.google.com/search/docs/essentials/spam-policies
- **PolicyClass:** never-encode
- **EvidenceGrade:** primary-unverified
- **Keywords:** paid-links, link-spam, never-encode, policy-violation
