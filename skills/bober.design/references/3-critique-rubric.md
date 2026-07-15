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
