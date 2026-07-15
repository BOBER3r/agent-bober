---
name: bober.design
description: Frontend design team workflow — build premium, non-generic landing pages and UI through a five-role pipeline (intake → art direction → build → screenshot critique → polish). Use when building or redesigning any user-facing page where visual quality matters: landing pages, portfolios, marketing sites, product pages, dashboards with a public face. Triggers on "build a landing page", "make this look premium", "design a site", "this looks too AI".
argument-hint: <what-to-build-or-improve>
handoffs:
  - label: "Plan Feature"
    command: /bober-plan
    prompt: "Plan the engineering work behind this designed page"
  - label: "E2E Tests"
    command: /bober-playwright
    prompt: "Write Playwright E2E tests for the designed page"
---

# bober.design — Frontend Design Team Workflow

You are running the **bober.design** skill: a five-role design team compressed into one
pipeline. Its single purpose is output that could not be mistaken for AI-generated — pages with
a point of view, built to a hard quality floor.

The pipeline exists because genericness is not a vague quality problem; it is a named,
enumerable, machine-detectable failure mode. The team designs against an explicit catalog of
AI tells (see the **Anti-Slop Catalog** reference), plans before building, critiques
screenshots instead of trusting code, and gates on deterministic checks.

**The Iron Law of this skill: no design decision happens outside DESIGN.md during the build.**
Plan first, then build the plan. A builder that improvises palette or type on the fly produces
the average of its training data — that average is the enemy.

## The five roles

| Role | Who | Output |
|------|-----|--------|
| 1. Intake | You (orchestrator), interactive | Brief: subject, audience, job, references, constraints |
| 2. Art direction | `bober-art-director` subagent | `.bober/design/DESIGN.md` (the contract) |
| 3. Build | `bober-frontend-builder` subagent | Working code, DESIGN.md as law |
| 4. Critique | `bober-design-critic` subagent | Screenshot-verified findings + slop score + verdict |
| 5. Polish | builder again, one batch | Final pass: typography, motion, copy sweep |

Steps 3–4 loop (max 3 iterations) until the critic passes.

## Step 0 — Applicability & survey

- If the task has no visual surface (backend, infra, pure logic), stop and use the right skill.
- Survey the project: greenfield or existing? Stack (plain HTML / Vite+React / Next.js /
  Astro…)? If greenfield with no stack preference, default to a single static page first
  (HTML + modern CSS + minimal JS) — design quality is stack-independent and a static page
  iterates fastest; migrate into a framework after the design is approved.
- Check for installed substrate (all optional, never required):
  - **ui-ux-pro-max** plugin (`~/.claude/plugins/marketplaces/ui-ux-pro-max-skill/.claude/skills/ui-ux-pro-max/scripts/search.py`):
    a searchable database of styles, palettes, font pairings, and per-stack guidelines. Treat
    it as a *candidate generator only* — its recommendations trend generic (it will happily
    suggest Inter/Inter for a premium portfolio), so everything it returns must pass the
    art director's anti-slop gate.
  - **frontend-design** skill (Anthropic) — its philosophy is already absorbed into this
    pipeline; don't invoke it redundantly inside this workflow.
  - **impeccable** (`npx impeccable detect`) and **axe-core** — deterministic gates for the
    critic, used if available.

## Step 1 — Intake (interactive; you run this, not a subagent)

Subagents can't talk to the user. All discovery happens here, and its quality caps the quality
of everything downstream.

### 1a. References (worth more than any description)

Ask the user for visual references before anything else:

- A `reference/` folder in the project (screenshots, section by section — hero, content
  sections, footer, detail pages, loading states — named or annotated for which section each
  file informs). Read every image.
- Or URLs of sites they admire (capture screenshots via Playwright if available).
- **Borrow from several references, never copy one site.** For each reference, record WHAT
  specifically to take (the spacing? type contrast? mood? one interaction?) — one sentence per
  image, confirmed with the user if ambiguous.
- No references? Proceed — the art director designs from the subject's own world — but say
  that references would raise the ceiling and give the user a moment to add some.

### 1b. Clarifying questions (one batch, 4–6 questions max)

Run two discovery tracks in the same batch:

**Vibe discovery:** subject and its world (materials, instruments, era, vernacular) ·
audience and the page's single job · 3-5 adjectives the user wants a stranger to feel ·
what competitors/peers look like (so we can NOT look like that) · any brand constraints
(existing colors/fonts/logo) · motion appetite (calm ↔ theatrical).

**Copy strategy:** what the thing actually does, in the user's own words · the one action a
visitor should take · proof available (real numbers, real names, real work).

Also: target stack, single-mode or light+dark, and any hard constraints (CMS, existing design
system, performance budget).

Use AskUserQuestion for the choice-shaped items; free text for the open ones. Do not proceed
until the subject, audience, and job are concrete. Real content only from here on — collect
actual copy inputs, names, numbers, and image assets now, not lorem ipsum later.

### 1c. Write the brief

Distill intake into `.bober/design/BRIEF.md`: subject/audience/job, reference notes (per-image,
what-to-take), both discovery tracks' answers, constraints, assets inventory. This is the art
director's entire knowledge of the user's intent — write it like a handoff, not notes.

## Step 2 — Art direction

Spawn **bober-art-director** with: the full text of BRIEF.md, the reference image paths (it can
Read them), the Anti-Slop Catalog and DESIGN.md template references (inlined below in this
command file — pass them verbatim), and `.bober/design/history.md` if it exists.

The art director returns DESIGN.md content after running its internal generic-twin self-critique.
Write it to `.bober/design/DESIGN.md`.

**Approval gate:** present to the user — the named vibe, the two influences and their collision,
the palette table, the type pairing, the signature element, the wildcard, and the Slop Ledger.
Ask: approve, or adjust? Iterate the art director (not the builder) until approved. This is the
cheapest point in the pipeline to change direction; after this, DESIGN.md is frozen for the
build. In a fully autonomous run (explicitly requested), apply the critic's brief-level review
instead and proceed.

Append the history ledger line to `.bober/design/history.md` once approved.

## Step 3 — Build

Spawn **bober-frontend-builder** with: DESIGN.md verbatim, the stack decision, the asset paths,
the Anti-Slop Catalog, and (iteration ≥2) the critic's full findings batch.

Build order: tokens first (CSS variables / theme file generated from DESIGN.md §3–4 — the only
place hex values may live), then section by section per the §5 wireframes, then the signature
element, then the motion plan. The builder self-verifies (builds clean, renders, no console
errors) before returning.

## Step 4 — Critique loop

Spawn **bober-design-critic** with: DESIGN.md, the Critique Rubric reference, how to run the
page (dev server command or file path), and the iteration number.

- Critic returns a verdict + findings (screenshot-verified, severity-ranked, slop score).
- `fail` → collect ALL findings into ONE batch (batched fixes beat drip-fed fixes; the builder
  sees the full picture and fixes root causes, not symptoms), re-spawn the builder, re-critique.
  Max 3 iterations; if still failing, stop and present the open findings honestly to the user
  with the critic's screenshots — never silently ship a failing page.
- `design-brief` findings (page faithful to a weak DESIGN.md) → route to the art director,
  not the builder, and re-run from Step 2 with the user's awareness.
- `pass` → Step 5.

## Step 5 — Polish

One final builder pass, one batch, guided by the critic's MEDIUM/NIT findings plus:

- **Typography micro-pass:** optical alignment, widows/orphans in headings, tabular figures on
  data, letter-spacing on all-caps labels.
- **Motion audit:** every animation earns its place per DESIGN.md §8; reduced-motion path
  actually verified.
- **Copy sweep:** the anti-slop copy sweep from the Copy Guide, applied line by line.

Then a final critic smoke pass (phases 1, 3, 8 + slop lint only) to confirm the polish didn't
regress anything.

## Step 6 — Report

Present to the user: the final 1440/768/375 screenshots, the named vibe and signature element
(one line each), the slop score and a11y result, how to run it, and what to iterate next.
Findings you chose not to fix stay listed — the user decides, not silence.

## Working with the sprint pipeline

For larger builds, this skill composes with the standard bober pipeline: run Steps 0–2 here,
then hand DESIGN.md to `/bober-plan` as a context file so sprint contracts inherit the design
contract, with `bober-design-critic` added as an evaluation strategy alongside typecheck/tests.
The design contract and the engineering contract stay separate documents with separate
evaluators.

## Error handling

- **Playwright unavailable to the critic** → critique falls back to static analysis of built
  output + explicit note that visual verification was skipped; treat any such review as
  provisional, never as a pass.
- **Fonts fail to load in review** (computed font-family shows a fallback) → CRITICAL: the
  design was reviewed as a different design. Fix loading before judging anything visual.
- **User rejects the vibe late (during build/critique)** → back to Step 2; do not patch a
  rejected direction section by section. Changing DESIGN.md mid-build without re-approval is
  a pipeline violation.
- **Iteration budget exhausted** → present state honestly with screenshots and open findings.

## Attribution

The taste layer of this pipeline adapts Anthropic's `frontend-design` skill (three default
looks, signature element, two-pass plan/critique, writing-as-design). The genericness catalog
synthesizes Impeccable (pbakaus), Krebs' Show HN slop audit, and 2389-research's landing-page
system (entropy rules, named vibes, litmus gates). The critique protocol adapts OneRedOak's
design-review workflow (Live Environment First, 8 phases, three viewports).


---

<!-- Reference: 1-anti-slop.md -->

# Anti-Slop Catalog — AI-Generic Tells, Blocklist, and Entropy Rules

This is the shared genericness knowledge base for the bober design team. The art director designs
against it, the builder is constrained by it, and the critic scores against it.

**How to apply it:** every rule here is a **scored lint, not an absolute ban**. Any single tell can
be the right choice for a specific brief — the failure mode is *stacking defaults*. An empirical
Playwright audit of 1,590 Show HN landing pages (Krebs, 2026) scored 4+ tells as "heavy slop" (22%
of pages), 2–3 as mild (32%), 0–1 as clean (46%). Target: **0–1 tells, and any tell present must be
a justified, written choice in DESIGN.md** — the brief's own words always win, including when the
brief explicitly asks for a "banned" look.

## The three whole-page default looks (never spend a free axis on these)

AI-generated design clusters around three complete looks that appear regardless of subject:

1. **Warm cream** (~#F4F1EA) background + high-contrast serif display + terracotta accent
2. **Near-black** background + single acid-green or vermilion accent
3. **Broadsheet**: hairline rules, zero border-radius, dense newspaper columns

All three are legitimate *when the brief pins them down*. When the brief leaves the visual
direction free, arriving at any of them means the direction was defaulted, not designed.

## Component & layout tells (each +1 slop score)

- Pill "badge" above the hero H1 ("✨ Now in beta", "Backed by…")
- Grid of identical icon-topped feature cards (3 or 6, same size, same radius)
- Numbered 1-2-3 "how it works" step sequence when the content is not truly sequential
- Stat banner row ("10k+ users · 99.9% uptime · 4.9★")
- Big number + small label + gradient accent as the hero (the template answer)
- Rounded-corner card grids as the answer to every layout question
- Dark mode with glowing box-shadows around cards
- Decorative gradient text on headlines
- Centered everything: every section a centered column with a centered heading

## Typography tells

- One font family for the entire page (most commonly Inter)
- The overused pool: **Inter, Roboto, Arial, Helvetica, Space Grotesk, Lato, Open Sans,
  Source Sans Pro** — and the "escape hatch" combos that became their own tell:
  Geist, Instrument Serif (already flagged as "the newest reflex")
- No deliberate type scale: sizes that drift (17/19/22px) instead of a named scale

## Color tells

- Purple/violet gradients ("VibeCode Purple"), generic blue-to-purple
- Cyan-on-dark "tech" scheme
- "The Stripe palette" — soft blurple gradients on white
- Remembered hex codes: reaching for #6366F1, #8B5CF6, #10B981 from muscle memory

## Copy tells (probabilistic — these predate LLMs; enforce specificity, don't just ban phrases)

- Averaged SaaS headlines: "Build the future of work", "Your all-in-one platform",
  "Scale without limits", "Supercharge your workflow"
- **Headline litmus test (hard gate):** if a visitor sees ONLY the headline and nothing else,
  will they know exactly what this product/person/thing is? If not, rewrite.
- Em-dash-heavy triads, "It's not X, it's Y", benefit-benefit-benefit rhythm
- Feature names that describe the implementation ("AI-Powered Engine") instead of what the
  user gets

## Motion tells

- Bounce/elastic easing on UI elements
- Everything fades up on scroll, uniformly, at the same speed
- Scattered micro-animations instead of one orchestrated moment
- Animations >500ms, or animating width/height/top/left instead of transform/opacity

## Replacement pools (rotate — never reuse the previous project's pick)

**Display faces** (pair with a distinct body face, never self-paired): Newsreader, Playfair
Display, Clash Display, Outfit, Manrope, Satoshi, Bricolage Grotesque, Fraunces, Zodiak,
General Sans, Cabinet Grotesk, Big Shoulders, Crimson Pro. For developer products, JetBrains
Mono / IBM Plex Mono as a *utility* face.
**Icons:** Phosphor, Heroicons, Iconify Solar — one set per project, one stroke weight.
Lucide is now overused; avoid unless the project already uses it. Never emoji as icons.

⚠️ **This pool rots.** Everyone reading advice like this switches to the same replacements, which
is how Instrument Serif became a tell within months. The pools are a floor, not the method. The
method is the entropy rules below.

## Entropy rules (anti-convergence — these beat any static list)

1. **No hex-code memory.** Generate colors fresh from real-world references in the subject's
   world (a material, a place, an era, a brand artifact) — never from remembered defaults.
   Name each color after its source ("oxidized copper", not "green-500").
2. **Rotate the display face.** Check `.bober/design/history.md` for faces used in previous
   projects; never repeat the last three.
3. **Two influences, visible collision.** Pick two unrelated influences discovered during
   intake (e.g. "Swiss timetables × phosphor CRT terminals") and make the collision visible
   in the design. One influence produces a theme; two produce an identity.
4. **One wildcard.** Include one deliberate element that doesn't "fit" — a texture, an odd
   alignment, a typographic quirk. Perfectly coherent = obviously generated.
5. **Name the vibe.** Write down a 2–4 word name for the aesthetic direction ("brutalist
   apothecary", "midnight radio"). Unnamed vibes become generic. Every subsequent decision
   is tested against the name.

## The AI Slop Test (final gate, applied by the critic)

> If someone saw this page and was told "AI made this", would they believe it immediately?

If yes — the design has failed, regardless of how many individual rules pass. Identify which
tells create that impression and redesign those. If no — ship it.


---

<!-- Reference: 2-design-brief.md -->

# DESIGN.md — the Design Brief Contract

The art director produces `.bober/design/DESIGN.md`. It is the **single source of truth** for the
build: no design decision may be made outside this file during the build phase. If the builder
needs a value that isn't in DESIGN.md, that is a DESIGN.md bug — the orchestrator routes the
question back to art direction, the builder never improvises one.

Pages may add scoped deviations in `.bober/design/pages/<page>.md` (same sections, overrides
only). When building a page, its override file — if present — wins over the master.

## Required sections

```markdown
# DESIGN — <project name>

## 1. Subject & Job
One concrete subject, its audience, and the page's single job. If the user's brief didn't pin
these down, the intake answers did. Real content only — no lorem ipsum anywhere in the build.

## 2. Vibe
**Name:** <2–4 word named direction, e.g. "brutalist apothecary">
**Influences (exactly two, unrelated):** <influence A> × <influence B> — and one sentence on
where their collision will be visible on the page.
**Freshness check:** how this direction differs from (a) the three default looks, (b) the last
entry in .bober/design/history.md, (c) what a generic competitor page looks like.

## 3. Color Tokens (4–6, named after their real-world source)
| Token | Hex | Source | Role |
|-------|-----|--------|------|
| --color-ink | #1A1B18 | wet slate roof | foreground |
| ... | | | background / accent / surface / muted |
Include the fg/bg contrast ratios for every text-bearing pair (must meet 4.5:1 body, 3:1 large).
State light/dark behavior: single-mode (justify) or both (both fully specified).

## 4. Type Roles
| Role | Face | Weights | Scale steps |
Display / Body / Utility (captions, data). Display and body are different families. State the
type scale as named steps (e.g. 13/16/20/28/44/72) and where each is used. State what makes
this pairing specific to the brief — "it looks nice" is not a reason.

## 5. Layout Concept
One-sentence layout thesis, then ASCII wireframes per section (hero, each content section,
footer). Structural devices (numbering, eyebrows, dividers) listed with the information each
one encodes — a device that encodes nothing gets cut.

## 6. Signature Element
The ONE thing this page will be remembered by (an interaction, a hero treatment, a typographic
move). One paragraph: what it is, why it embodies this subject, and its reduced-motion fallback.
Spend the boldness budget here; everything else stays quiet.

## 7. Wildcard
One deliberate misfit detail and where it lives.

## 8. Motion Plan
The one orchestrated moment (usually page load or first scroll), listed hover/press
micro-interactions, duration/easing tokens (150–300ms micro, ≤400ms transitions, ease-out in /
ease-in out, no bounce on UI), and the prefers-reduced-motion story. Fewer, better.

## 9. Copy Deck
Final headline (must pass the litmus test), subhead, section headings, CTA labels (verbs that
say what happens: "Save changes", not "Submit"), and the empty/error-state voice. Copy is design
material: same intentionality as spacing and color.

## 10. Slop Ledger
Every anti-slop rule this design consciously breaks, each with a one-line justification tied to
the brief. An empty ledger and a rule-breaking design = art direction failure. Unjustified
entries = the critic bounces it.

## 11. Quality Floor (non-negotiable, inherited — restate, don't relitigate)
Responsive 375/768/1440. Visible keyboard focus. WCAG 2.2 AA contrast. Semantic HTML.
prefers-reduced-motion respected. No horizontal scroll on mobile. Touch targets ≥44px.
Real content, no placeholders.
```

## History ledger

After every accepted DESIGN.md, append one line to `.bober/design/history.md`:

```
2026-07-10 | <project> | vibe: <name> | display: <face> | body: <face> | palette: <3 main hex>
```

The art director MUST read this file first and avoid repeating the last three display faces,
vibe names, and palettes. This is what keeps project #5 from converging with project #1.


---

<!-- Reference: 3-critique-rubric.md -->

# Design Critique Rubric — Live-Environment Review Protocol

Used by `bober-design-critic`. Principle: **Live Environment First** — assess the rendered,
interactive page before reading a line of source. Static code analysis alone is rejected as a
review method; a picture is worth 1000 tokens.

## Setup

1. Start the dev server (or open the built HTML) and navigate with Playwright.
2. Capture the baseline screenshot set BEFORE judging anything:
   - **1440px** (desktop), **768px** (tablet), **375px** (mobile) — full-page screenshot each
   - Dark mode variants if DESIGN.md specifies dual-mode
3. Read `.bober/design/DESIGN.md` (and the page override, if any). The review judges the page
   against DESIGN.md and the anti-slop catalog — not against the critic's personal taste.
   If the page is faithful to DESIGN.md but DESIGN.md itself is weak, file that as a
   `design-brief` finding, not a build finding.

## The eight phases (run in order, all mandatory)

| # | Phase | What to check |
|---|-------|---------------|
| 1 | Preparation | Page loads clean; no 404 assets; no console errors/warnings; fonts actually load (check computed font-family — a fallback serving Arial is a CRITICAL finding) |
| 2 | Interaction & user flow | Walk the primary user journey click-by-click. Every interactive element: hover, press, focus, disabled states present and on-style. CTAs do what their label says |
| 3 | Responsiveness | At each viewport: no horizontal scroll, no overlap/clipping, no orphaned layouts. Screenshot evidence for every finding |
| 4 | Visual polish | Spacing rhythm consistent with the scale; alignment true; type scale steps match DESIGN.md; images not stretched; visual hierarchy guides the eye to the one primary action |
| 5 | Accessibility (WCAG 2.2 AA) | Keyboard-only pass: tab order matches visual order, focus always visible, no traps, escape routes in modals. Contrast-check every text/bg pair. Alt text, labels, heading hierarchy, aria on icon-only buttons. Run axe if available (see gates) |
| 6 | Robustness | Long content, missing images, empty states, slow network (throttle), zoom 200%, prefers-reduced-motion actually reduces motion |
| 7 | Code health | ONLY now read source: token usage (no raw hex in components), CSS specificity sanity, semantic HTML, no dead selectors that cancel each other |
| 8 | Content & console | Copy against the copy deck: headline litmus, CTA verb rule, no lorem ipsum, no truncated text. Final console sweep after all interactions |

## Deterministic gates (run after the eight phases)

- **Slop lint:** if `npx impeccable detect` is available (requires network on first run), run it
  with `--json` and record the score. Otherwise run the built-in checks: computed font-family
  vs the overused pool; count of hero badge / icon-card grid / stat row / numbered steps
  patterns in the DOM; gradient usage on text; purple-family dominance. Score = number of
  tells present. **0–1 pass · 2–3 warn · 4+ fail.** A tell justified in DESIGN.md's Slop
  Ledger does not count toward the score.
- **Accessibility scan:** if axe-core is available (`npx @axe-core/cli <url>` or injected via
  Playwright evaluate), run it. Serious/critical violations are BLOCKER findings. If axe is
  unavailable, the manual phase-5 pass stands but note the gap in the report.
- **The AI Slop Test** (from the anti-slop catalog): one honest verdict, looking at the 1440px
  screenshot cold: "would a stranger immediately believe AI made this?" Yes → FAIL with the
  specific tells that create the impression.

## Finding format & severities

```
[BLOCKER]  breaks function, accessibility, or DESIGN.md's quality floor — must fix
[HIGH]     visibly cheapens the page or violates DESIGN.md — fix this iteration
[MEDIUM]   polish item — fix if the iteration budget allows
[NIT]      preference — note, prefixed "Nit:", never blocks
```

Every finding: `severity | phase | viewport | what + where | evidence (screenshot ref) |
suggested fix direction`. Findings describe **problems, not prescriptions** — the builder owns
the how. Praise what works in one line first; it anchors what must not regress.

## Verdict

`pass` — no BLOCKER/HIGH, slop score ≤1, AI Slop Test passed.
`fail` — anything else, with the full findings list for the next build iteration.


---

<!-- Reference: 4-copy-guide.md -->

# Copy Guide — Writing as Design Material

Words appear in a design for one reason: to make it easier to understand, and therefore easier
to use. They are design material, not decoration — bring the same intentionality to copy that
you bring to spacing and color. Copy can make a design feel as templated as the visuals can.

## Headline discipline

- **The litmus test (hard gate):** seeing ONLY the headline, does a visitor know exactly what
  this is? "Build the future of work" fails. "Invoices your clients pay in one tap" passes.
- Specific beats clever, every time. Numbers, nouns from the subject's world, and verbs the
  audience uses beat abstractions ("platform", "solution", "workflow", "supercharge").
- The headline is written from the visitor's side of the screen — what they get, not what the
  system does.

## Voice rules

- Write from the end user's side: name things by what people control and recognize, never by
  how the system is built. A person manages *notifications*, not *webhook config*.
- Active voice by default. A control says exactly what happens when it's used: "Save changes",
  not "Submit". An action keeps its name through the whole flow — the button that says
  "Publish" produces a toast that says "Published".
- Plain verbs, sentence case, no filler. Tone matched to the brand and audience, then held
  consistent — the vocabulary of an interface is its signposting.
- Let each element do exactly one job: a label labels, an example demonstrates, nothing quietly
  does double duty.

## Failure & emptiness are direction, not mood

- Errors state what went wrong and how to fix it, in the interface's voice. They never
  apologize and are never vague ("Invalid input" is banned; "Card number is 15 digits — Amex
  cards start with 34 or 37" passes).
- An empty screen is an invitation to act: what this space is for + the one action to fill it.

## Anti-slop copy sweep (polish pass)

- Kill averaged-SaaS phrasing: "all-in-one", "seamless", "supercharge", "unlock", "empower",
  "take X to the next level", "built for the modern Y".
- Kill rhythm tells: em-dash triads, "It's not X, it's Y", three-benefit drumbeats.
- Every feature name says what the user gets, not the implementation ("Search that reads
  handwriting", not "AI-Powered OCR Engine").
- Read every sentence asking: could this appear on a competitor's page unchanged? If yes,
  it isn't copy yet — it's filler.
