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
