# Signature library broadening + leak re-grade (curl-verified)

**Contract:** sprint-spec-20260717-seo-improver-builder-4  ·  **Spec:** spec-20260717-seo-improver-builder  ·  **Completed:** 2026-07-17

## What this sprint added

This is a **content-only** sprint on the shipped SKILL.md playbook corpus — no
parser, type, or runtime change (Sprint 3 owns the `liveWeightStatus` field; that
was a nonGoal here). Two things happened. First, the leak-derived ranking-mechanics
signatures were **re-graded to `LiveWeightStatus: documented-only`**, so any finding
the analyzer grounds in them is capped at `tentative` (the Sprint-3 downgrade-only
rule now has real corpus data to bite on). Second, three focused new **vertical
signatures** (iGaming Google-Ads certification, crypto/iGaming site-reputation-abuse,
SaaS scaled-content intent) were added to `skills/bober.seo-verticals/SKILL.md`, each
carrying a **curl GET-verified primary-source citation**. Never-encode tactics were
untouched: the generic-file drop count stays at exactly 1 (no new never-encode block),
and the three new blocks are detection-phrased so they survive the forbidden-action
lint. Parser/types stayed byte-identical; the change is entirely authored Markdown plus
collocated test assertions.

## Public surface

These are authored playbook signatures (level-3 headings parsed by `SeoPlaybookParser`),
not code symbols — the parser and types are unchanged.

- `igaming-ads-certification-compliance` (`skills/bober.seo-verticals/SKILL.md:95`) —
  treats Google Ads gambling certification + per-country licensing as a hard,
  compliance-blocking gate for iGaming paid search. `PolicyClass: human-approve`,
  `EvidenceGrade: verified`. Source: `support.google.com/adspolicy/answer/15132179`.
- `crypto-igaming-site-reputation-abuse-audit` (`skills/bober.seo-verticals/SKILL.md:105`)
  — audits crypto/DeFi and iGaming properties for undisclosed third-party placements,
  citing the **Nov 19 2024** site-reputation-abuse update that closed the
  first-party-oversight loophole. `PolicyClass: human-approve`, `EvidenceGrade: verified`.
  Source: `developers.google.com/search/blog/2024/11/site-reputation-abuse`.
- `saas-scaled-content-intent-audit` (`skills/bober.seo-verticals/SKILL.md:115`) — judges
  SaaS programmatic-SEO output by manipulative-intent/user-value, not production method
  (scaled-content-abuse is method-agnostic). `PolicyClass: auto-safe`,
  `EvidenceGrade: verified`. Source: `developers.google.com/search/docs/essentials/spam-policies`.
- **Leak-derived signatures re-graded `documented-only`** — the four headline
  ranking-mechanics blocks named in the contract (`siteauthority-domain-quality`,
  `navboost-click-quality-audit`, `contenteffort-low-effort-flag` in
  `skills/bober.seo-technical-audit/SKILL.md`; `sitefocus-topical-authority` in
  `skills/bober.seo-generic/SKILL.md`) plus, for a clean sweep, the rest of the
  leak-derived corpus: `hostage-sandbox-new-domain`, `date-consistency-audit`,
  `named-demotions-audit` (technical-audit) and `igaming-scamness-demotion-awareness`,
  `crypto-ymyl-editorial-override` (verticals). `gsc-url-inspection-*` were deliberately
  left at the default `unknown` — they document a live API, not a leaked ranking signal.

## How to use / how it fits

Nothing to call — these are playbook data the runner already loads. On any
`bober seo <workflow>` run, `SeoPlaybookParser` picks the new blocks up automatically,
`renderSignature` emits their `LiveWeight:` line into the analyzer prompt, and
`toSeoFinding` caps a `firm` finding grounded in a `documented-only` signature to
`tentative`. The three new vertical signatures surface on `parasite-watch`,
`technical-audit`, and `topical-map` per their `Workflows:` field. Test coverage:
the carried Sprint-3 gap (`retriever.test.ts`, the persisted `LiveWeight: documented-only`
prompt-fragment assertion) was added, plus `parser.test.ts` / `skills-content.test.ts`
assertions for the re-graded ids and the three new vertical ids.

## Notes for maintainers

- **Curl GET-verification is the fabrication guard — keep the discipline.** Every
  new/re-graded `PrimarySourceUrl` was `curl`-checked to HTTP 200 at authoring time
  (2026-07-17) and the evidence is recorded in commit `808eecd`. This is the same
  discipline that, in the original SEO suite's sprint 2, caught **4 hallucinated 404
  URLs**. When adding a citation, verify it live before encoding it.
- **Use GET, not HEAD, when verifying `support.google.com` citations.**
  `support.google.com/adspolicy/answer/15132179` returns **HEAD 404 but GET 200** —
  Google HEAD-blocks its support pages. A HEAD-only check would falsely flag this real
  page as a fabricated 404. Verify with `curl -sL -o /dev/null -w "%{http_code}"` (a
  full GET), not `curl -sI`. The evaluator independently reproduced this and confirmed it
  is not a false fabrication catch.
- **No REFUTED claim was encoded.** The research phase's refuted claims (e.g.
  ChatGPT-Wikipedia dominance, Reddit-leads-AIO, parasite/expired-domain/paid-link
  tactics) were kept out; the new blocks are all `verified` and detection-phrased.
- **The generic-file never-encode drop count is a load-bearing invariant.** It stays at
  exactly **1** — no never-encode block was added to `bober.seo-generic/SKILL.md`. If a
  future edit changes that count, the never-encode-drop tests will (and should) fail.

## Scope

One commit — `808eecd` — touching only Markdown skill files and collocated tests:
`skills/bober.seo-generic/SKILL.md` (+1 line), `skills/bober.seo-technical-audit/SKILL.md`
(+6), `skills/bober.seo-verticals/SKILL.md` (+32, the three new blocks), and
`src/seo/parser.test.ts` (+11), `src/seo/retriever.test.ts` (+12),
`src/seo/skills-content.test.ts` (+58). `parser.ts`/`types.ts` untouched. All 5 required
criteria (sc-4-1..4-5) passed on **iteration 1** (after one transient-crash retry that
ran no eval); build/typecheck/lint clean; full suite **4550 passed | 1 skipped | 0
failed**, zero regressions.
