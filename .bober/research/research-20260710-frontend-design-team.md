# Research: Non-Generic AI Frontend Design — Findings Behind bober.design

Date: 2026-07-10 · Method: deep-research workflow (104 agents; 22 sources fetched; 105 claims
extracted; 25 adversarially verified 3-vote; 23 confirmed, 2 refuted; synthesized to 10).
Full raw output was session-scoped; this file is the durable distillation.

## Confirmed findings (all 3-0 verified unless noted)

1. **The "AI-generic" signature is precisely documented and convergent** across independent
   sources. Typography tells: Inter-for-everything; Geist/Space Grotesk/Instrument Serif
   combos; single family per page. Color tells: purple-violet "VibeCode Purple" gradients,
   cyan-on-dark, glowing dark-mode shadows, gradient headline text, warm-cream defaults.
   Layout tells: hero badge, identical icon-card grids, 1-2-3 steps, stat rows. Anthropic's
   own skill names three whole-page default looks (cream+serif+terracotta; near-black+acid
   accent; broadsheet hairlines). Impeccable catalogs 46 named patterns in 8 categories.
   (HIGH confidence)
2. **Genericness is quantifiable and lintable**: Krebs' deterministic Playwright audit of
   1,590 Show HN pages — 22% heavy slop (4+ of 16 tells), 32% mild (2–3), 46% clean (0–1).
   Deterministic DOM/computed-style checks, no LLM judge; author self-reports 5–10% false
   positives. (MEDIUM — single blog-tier study)
3. **AI copy has its own signature** (averaged SaaS headlines) but it's probabilistic — the
   cliches predate LLMs — so enforce *specificity* (headline litmus test) rather than banning
   phrases. (MEDIUM)
4. **Standard countermeasure = blocklist + named replacements**: banned fonts (Inter, Roboto,
   Arial, Helvetica, Space Grotesk, Lato, Open Sans, Source Sans Pro), overused Lucide icons,
   purple gradients / "Stripe palette"; replacements Newsreader, Playfair, Clash Display,
   Outfit, Manrope, Satoshi, Bricolage Grotesque, JetBrains Mono (dev); Iconify Solar /
   Heroicons / Phosphor. Always display+body pairing, never one family. (HIGH)
5. **Dominant workflow = plan-first with validation gates**: Anthropic two-pass token-plan →
   genericness critique → build; web-design-skills' 9-section DESIGN.md as single source of
   truth ("no design decisions outside this file during build"); 2389's dual pre-code
   discovery (Vibe + Copy) with Freshness Check and headline litmus gates. (HIGH)
6. **Entropy rules beat static blocklists**: no hex-code memory (generate palettes fresh from
   real-world references), rotate display fonts across projects, two-influence collision,
   one mandatory wildcard, NAME the vibe ("unnamed vibes become generic"); plus the "AI Slop
   Test" as an explicit redesign gate. (HIGH)
7. **Screenshot self-critique + live-environment review is the established QA pattern**:
   Anthropic "a picture is worth 1000 tokens"; OneRedOak design-review = Playwright-MCP,
   Live Environment First (rendered page before code), 8 phases, screenshot-verified at
   1440/768/375px. (HIGH)
8. **A11y automation runs inside agent loops today**: Community-Access/accessibility-agents
   (WCAG 2.2 AA, axe-core scans against dev server, Playwright keyboard/viewport scans,
   SARIF output), premised on "AI coding tools generate inaccessible code by default". (HIGH)
9. **Slop detection is machine-actionable**: Impeccable (pbakaus, 45k★) — `npx impeccable
   detect`, 41 deterministic rules, `--json` for CI, `/impeccable critique` for the ~5
   judgment rules. Most tells can be a lint gate, not LLM taste. (HIGH)
10. **Synthesis** → five-role team: intake (dual discovery + gates) → art direction (named
    vibe, fresh tokens, signature, generic-twin critique) → build (DESIGN.md as law,
    blocklist at generation time) → critique (screenshots 3 viewports, 8 phases, slop lint +
    axe) → polish (type/motion/copy sweep). Maps onto bober's generator/evaluator loop.

## Refuted — do not repeat as fact

- ✗ The specific tell-frequency ranking "34% dark themes / 27% gradients / 22% icon grids" (0-3).
- ✗ "Tailwind's bg-indigo-500 default caused the purple AI web" origin story (0-3). The purple
  tell itself stands; its causal etymology does not.

## Caveats

- Space moves weekly; blocklists rot — today's replacement pool (Instrument Serif already
  "the newest reflex") is tomorrow's tell. Entropy rules are the durable method.
- Slop tells are statistical, not diagnostic (46% of audited pages clean; some patterns are
  Tailwind/shadcn industry trends, not AI). Score as lints; ledger justified exceptions.
- **No controlled study exists** showing skill-equipped vs vanilla agents produce measurably
  better outcomes (blind preference / conversion). All quality claims are author-self-reported.
- Reference-image-driven workflows, section-collage, and multi-variant-with-judging produced
  no verified claims — adopted in bober.design from practitioner experience (the user's own
  proven workflow), not from verified research.

## Key sources

- github.com/anthropics/claude-code /plugins/frontend-design (primary)
- impeccable.style/slop + github.com/pbakaus/impeccable (primary tool)
- adriankrebs.ch/blog/design-slop (empirical audit)
- github.com/2389-research/landing-page-design (entropy rules, dual discovery)
- github.com/lotfb86/web-design-skills (DESIGN.md pattern; 2★ aggregator — technique evidence only)
- github.com/OneRedOak/claude-code-workflows /design-review (critique protocol)
- github.com/Community-Access/accessibility-agents (a11y agents)
- github.com/nextlevelbuilder/ui-ux-pro-max-skill (data substrate; installed as plugin 2026-07-10)

## What was built from this (same day)

`skills/bober.design/` (SKILL.md + 4 references: anti-slop catalog, DESIGN.md template,
critique rubric, copy guide) and agents `bober-art-director` (opus), `bober-frontend-builder`
(sonnet), `bober-design-critic` (sonnet, Playwright tools). Distributed via update-all.
