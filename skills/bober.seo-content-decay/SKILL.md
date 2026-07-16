---
name: bober.seo-content-decay
description: "Per-workflow SEO signature library for the content-decay workflow. A data file of discrete, cited SEO tactics read by SeoPlaybookParser (src/seo/parser.ts), not a workflow skill. Encodes the leak's NavBoost click-decay mechanism, the rolling 13-month refresh window, and the HCU-era content-decay baseline (522 sites, 64% traffic-lost) for the content-decay workflow."
---

# bober.seo-content-decay — Content Decay Signature Library

This skill is a **signature-library** file for the `content-decay` workflow, not a
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
NavBoost click-decay mechanism (decay as a failure to keep driving a page's
expected click share over a rolling 13-month window) and Detailed's
522-content-site post-HCU study, which found 64% of content-first sites lost
traffic with a median loss of -471K visits / -17.8%. Most signatures here are
**read-only detection/monitoring** (auto-safe); the one signature that would
execute a large-scale rewrite or page consolidation that changes the live
site is `human-approve` -- consistent with research §6's automation boundary.

## Signatures

### navboost-decay-expected-clicks
- **Title:** Content decay is partly a NavBoost failure to keep driving a page's expected click share
- **Workflows:** content-decay
- **Tactic:** Detect decay by comparing a page's current click share against the click share its rank would predict, not by watching raw rank alone; flag pages whose click-share is sliding relative to their rank as decaying even before the rank itself drops.
- **Invariant:** The leaked Google Content Warehouse API documents NavBoost as a click-based re-ranking system tracking goodClicks, badClicks, lastLongestClicks, and unsquashedClicks over a rolling 13-month window; a page's ranking position and its actual click performance can diverge, and a sustained failure to drive the clicks NavBoost expects for that position is a mechanical decay signal.
- **PrimarySourceUrl:** https://ipullrank.com/google-algo-leak
- **PolicyClass:** auto-safe
- **EvidenceGrade:** single-source
- **Keywords:** navboost, decay, expected-clicks, click-share

### navboost-13month-refresh-window
- **Title:** Set refresh cadence inside NavBoost's rolling 13-month click window, not annually
- **Workflows:** content-decay
- **Tactic:** Schedule content-refresh review cycles to land within the 13-month click-history window NavBoost scores over, rather than on a slower annual cadence that lets a page's click history fully roll past its refresh.
- **Invariant:** The leak documents NavBoost as scoring goodClicks/badClicks/lastLongestClicks/unsquashedClicks on a rolling 13-month window at the URL, subdomain, and root-domain level; a refresh cadence slower than that window lets decayed click history persist uncorrected for a full scoring cycle.
- **PrimarySourceUrl:** https://ipullrank.com/google-algo-leak
- **PolicyClass:** auto-safe
- **EvidenceGrade:** single-source
- **Keywords:** navboost, 13-month-window, refresh-cadence, click-history

### content-decay-hcu-baseline
- **Title:** Post-HCU decay is the norm, not the exception -- run a standing decay-detection pass on every site
- **Workflows:** content-decay
- **Tactic:** Treat decay detection as a standing, recurring audit line item for every content-first site rather than a one-off diagnostic run only when traffic visibly craters; the base rate of decay is high enough that absence of a detection pass is itself a risk.
- **Invariant:** A study of 522 content-first sites post-Helpful Content Update found 64% lost organic traffic, with a median loss of -471K visits (-17.8%) among the sites that declined, per Detailed's Q3 analysis (Glen Allsopp).
- **PrimarySourceUrl:** https://detailed.com/q3/
- **PolicyClass:** auto-safe
- **EvidenceGrade:** single-source
- **Keywords:** hcu, decay-baseline, 64-percent, detailed-q3

### goodclicks-badclicks-early-warning
- **Title:** Audit good/bad-click proxies as a leading indicator of decay before rank drops
- **Workflows:** content-decay
- **Tactic:** Pull bounce-back behavior and dwell/engagement proxies for at-risk pages as a leading-indicator audit line item; a rising badClicks-to-goodClicks proxy ratio is a decay early warning worth flagging before the page's rank actually falls.
- **Invariant:** The leak documents goodClicks and badClicks as tracked NavBoost inputs distinguishing navDemotion (on-site UX causes) from serpDemotion (SERP-behavior causes); a shift in that ratio precedes and helps cause the rank movement decay is ultimately measured by.
- **PrimarySourceUrl:** https://ipullrank.com/google-algo-leak
- **PolicyClass:** auto-safe
- **EvidenceGrade:** single-source
- **Keywords:** goodclicks, badclicks, early-warning, navdemotion

### refresh-cadence-monitoring
- **Title:** Re-measure decaying pages on a recurring cadence, not a one-shot report
- **Workflows:** content-decay
- **Tactic:** Build decay monitoring as a recurring, read-only re-measurement pass over previously-flagged pages rather than a single diagnostic snapshot; re-check decay status on each cadence run so a page's trajectory (worsening, stabilizing, recovering) is visible over time.
- **Invariant:** Both the 64%-decayed HCU baseline and the underlying NavBoost rolling-window mechanism argue that decay is an ongoing, shifting condition rather than a fixed state -- a single audit snapshot cannot capture trajectory, only recurring monitoring can.
- **PrimarySourceUrl:** https://detailed.com/q3/
- **PolicyClass:** auto-safe
- **EvidenceGrade:** single-source
- **Keywords:** refresh-cadence, monitoring, recurring-audit, trajectory

### content-refresh-genuine-effort
- **Title:** Refresh decaying pages with genuine substantiation, not scaled regeneration
- **Workflows:** content-decay
- **Tactic:** When recommending a refresh for a decaying page, recommend adding genuine original substantiation (new data, analysis, first-hand detail) rather than a scaled/templated rewrite pass; a low-effort regeneration risks tripping the same low-effort signal that contributes to decay in the first place.
- **Invariant:** Mike King's technical analysis of the leak documents contentEffort as an LLM-based effort-estimation signal Google runs on article pages; refreshing a decaying page with low-effort scaled output risks reinforcing, not reversing, the mechanical signal associated with decline.
- **PrimarySourceUrl:** https://ipullrank.com/google-algo-leak
- **PolicyClass:** auto-safe
- **EvidenceGrade:** single-source
- **Keywords:** content-refresh, genuine-effort, contenteffort, scaled-regeneration

### large-scale-rewrite-consolidation-approval
- **Title:** Mass rewrite or consolidation of decayed pages changes the live site -- requires human sign-off
- **Workflows:** content-decay
- **Tactic:** When decay analysis surfaces a large batch of decayed pages warranting mass rewrite or consolidation/merging into fewer stronger URLs, propose the plan as a report but do not execute the rewrite, redirect, or merge without explicit human approval, since it is a structural change to the live site.
- **Invariant:** The 522-site/64%-decayed HCU baseline shows decay clusters at scale across many pages at once; executing a large-scale rewrite or consolidation response to that scale of finding involves redirects and content replacement that a human must own the execution decision for, mirroring the internal-linking workflow's authority-consolidation-merge boundary.
- **PrimarySourceUrl:** https://detailed.com/q3/
- **PolicyClass:** human-approve
- **EvidenceGrade:** single-source
- **Keywords:** large-scale-rewrite, consolidation, human-approve, live-site-change
