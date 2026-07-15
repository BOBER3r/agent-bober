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
