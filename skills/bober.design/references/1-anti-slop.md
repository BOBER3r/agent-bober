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
