# Builder safety benchmark + docs + update-all sync

**Contract:** sprint-spec-20260717-seo-improver-builder-14  ·  **Spec:** spec-20260717-seo-improver-builder  ·  **Completed:** 2026-07-17

> **Final sprint — closes the SEO improver + builder extension at 14 of 14.** This is a
> **docs-and-test-only capstone**: it adds no production code. It proves the Phase-2 builder's
> safety guarantees empirically, makes the Phase-2 `@ts-expect-error` compile-proofs
> regression-protected, documents the whole builder surface, and confirms the distribution
> targets are in sync.

## What this sprint added

The Phase-2 capstone. Four things, none of which touch `src/seo/`'s production code:

1. An **adversarial safety benchmark** — a new `describe` block appended to
   `src/seo/builder/seo-builder.test.ts` (14 tests) that empirically proves, in one place, the
   three structural guarantees Sprints 11–13 claim: **(a)** an un-approved / uncited /
   downgraded hub finding can never be resurrected into a draft, **(b)** no draft across **all
   four** `SeoDraftKind`s ever emits a never-encode tactic, and **(c)** every draft carries
   `humanApprovalRequired === true`.
2. A scoped **`tsconfig.test.json` + `typecheck:tests` npm script** that actually compiles the
   builder's `*.test.ts` files, so the Phase-2 `@ts-expect-error` compile-proofs (the
   `ApprovedFinding` nominal-type guard and the `SeoBuilder.build` type gate) are
   CI-enforceable instead of merely evaluator-verified — closing the Sprint-12 follow-up.
3. The **Phase-2 builder section in `docs/seo.md`** (the gated-generation model, the
   `ApprovedFinding` boundary, the human-approval loop, `bober seo build <reportId>`), plus a
   Guardrails bullet and an FAQ entry.
4. A **`npm run update-all` sync** re-confirming **zero drift** across the sync targets (no
   skill/agent content changed this sprint, so nothing had to be copied).

The consolidated spec index section (sprints 1–14) added to
[`docs/sprints/README.md`](./README.md) is part of this same commit.

## Public surface

- `npm run typecheck:tests` (`package.json:16`) — `tsc --noEmit -p tsconfig.test.json`. A new
  developer/CI command that type-checks the builder test files so the `@ts-expect-error`
  compile-proofs are genuinely enforced. Green today; deliberately breaking a proof makes it
  fail.
- `tsconfig.test.json` (new file) — extends the base `tsconfig.json` with `noEmit: true` /
  `incremental: false` and scopes `include` to **`src/seo/builder/**/*.ts` only**, crucially
  **without** re-inheriting the base config's `*.test.ts` exclusion, so the builder's test
  files are actually compiled. The narrow scope is intentional (see maintainer notes).
- `docs/seo.md` **`## Phase 2 — the builder (gated generation)`** section — the user-facing
  reference for the `SeoBuilder` gated-generation model, the `ApprovedFinding` structural
  boundary, the draft → hub-`action` → human-approve → apply-by-hand loop, the
  `bober seo build <reportId>` command, and the `typecheck:tests` enforcement note. Plus a
  Guardrails bullet and a "How do I turn an approved finding into an artifact?" FAQ entry.

No new application symbols were added — this sprint documents and stress-tests the builder
(`ApprovedFinding`, `SeoBuilder.build`, `NeverEncodeFilter`, `bober seo build`) that Sprints
11–13 shipped.

## The safety benchmark (sc-14-1)

The new `describe("SeoBuilder — adversarial safety benchmark (sc-14-1)")` block is **additive**
— it reuses the file's existing fixtures (`makeApprovedRow`, `baseInput`, `ApprovedHubFinding`)
and leaves the five pre-existing describes untouched. Its three groups map one-to-one onto the
guarantees:

- **(a) No resurrection.** `it.each` over all five non-approved hub statuses (`open`,
  `in-progress`, `snoozed`, `done`, `dropped`) asserts `ApprovedFinding.from(...)` returns
  `null`; two more cases cover a missing `cite:` entry (uncited / never-encode-dropped
  surrogate) and a malformed `cite:` URL (verifier-downgraded-to-uncited surrogate). The
  clincher is a **mixed batch** — one approved+cited row alongside dropped/open/in-progress/
  uncited rows — mapped through `ApprovedFinding.from` exactly as the real hub adapter
  (`readApprovedSeoFindings`) does: only the one legitimate row survives to reach
  `SeoBuilder.build`, and it produces exactly one draft. The gate runs **before** `build`, so
  resurrection is structurally impossible, not just architecturally intended.
- **(b) No never-encode emission.** For **each** of the four `SeoDraftKind`s, a batch of six
  banned-tactic-implying approved findings (parasite placement, bought PBN links,
  expired-domain, mass-generation, cloaking, doorway pages) produces **zero** drafts and
  `skipped === 6` — the mandatory injected `NeverEncodeFilter` re-scan drops them even though
  they were approved+cited. A corpus-wide invariant additionally asserts that no draft from a
  clean four-kind batch matches any `NEVER_ENCODE_PATTERNS` regex.
- **(c) Always human-approval.** A clean four-kind batch yields four drafts, every one with
  `humanApprovalRequired === true` (the type literal, not a forgeable boolean).

## `typecheck:tests` enforcement

The base `tsconfig.json` excludes `*.test.ts` from `tsc`, and Vitest does not type-check by
default — so a Phase-2 compile-proof could silently rot. `tsconfig.test.json` +
`npm run typecheck:tests` closes that gap by compiling `src/seo/builder/**/*.ts` (test files
included). The evaluator **stress-tested the enforcement**: deleting a compile-proof makes the
command fail (the underlying `TS2322` assignability error surfaces once the `@ts-expect-error`
directive no longer suppresses it), confirming the check is real rather than vacuously green.

## Notes for maintainers

- **The `typecheck:tests` scope is deliberately narrow.** `tsconfig.test.json` includes only
  `src/seo/builder/**` on purpose. Widening it to the whole repo (or even all of `src/seo`)
  surfaces dozens of unrelated pre-existing test-type errors and turns the check red — this was
  evaluator-verified during the sprint. If you extend the scope, expect to clean up those
  errors first, or keep the guard focused on the builder's compile-proofs.
- **The safety benchmark is a proof, not a smoke test — keep it exhaustive.** If you add a new
  `SeoDraftKind` or a new hub status, extend groups (b)/(a) respectively so the
  no-never-encode-across-all-kinds and no-resurrection-across-all-statuses invariants stay
  complete.
- **`update-all` reported zero drift, but the target list depends on local state.** The
  evaluator noted a low-priority hygiene item: an **uncommitted** working-tree change to
  `scripts/sync-targets.json` adds a 5th sync target, so the "5 targets / 0 drift" claim relies
  on machine-local config. Not a sprint failure — but a maintainer should decide whether that
  5th target is intended (commit it) or machine-specific (leave it). It was intentionally **not**
  touched here.
- **Deliberate non-goals carried forward.** `bober/medical-team` is **not** merged (a manual
  follow-up), no live smoke test was run, and no AI-visibility provider was pinned — all three
  are intentional deferrals, not omissions.

## Extension complete — 14 of 14

This sprint closes `spec-20260717-seo-improver-builder`. The finished extension is Phase 1's
widened `src/seo/` advisory engine (four egress axes, the runtime `NeverEncodeFilter` third
never-encode belt, `liveWeightStatus` downgrade, the AI-visibility / crawl / SERP data sources,
the `CapabilitySeoRouter`, and a 10-case offline benchmark corpus) plus Phase 2's gated
generative builder (the `ApprovedFinding` structural boundary, `SeoBuilder.build`'s mandatory
never-encode re-filter, `bober seo build <reportId>` + `SeoDraftStore` + best-effort hub
`action` emission, and this adversarial safety benchmark). Every artifact the builder produces
is a proposal a human reviews and applies by hand — nothing is ever auto-published. Full user
reference: [`docs/seo.md`](../seo.md). Consolidated index: [`docs/sprints/README.md`](./README.md).

## Scope

One commit on `bober/medical-team`:

- **`3305fc2`** — `bober(sprint-14): builder safety benchmark + typecheck:tests + Phase-2 docs
  + update-all`. Five files, **no production `src/` code**: `src/seo/builder/seo-builder.test.ts`
  (+122, the sc-14-1 benchmark block), `tsconfig.test.json` (new, +9),
  `package.json` (+1, the `typecheck:tests` script), `docs/seo.md` (+118, the Phase-2 section +
  Guardrails bullet + FAQ), and `docs/sprints/README.md` (+93, the consolidated spec index).
  The `update-all` sync copies files into **separate** sync-target repos, so nothing it touched
  is staged in this commit. Passed **iteration 1** (one transient-crash retry with no eval
  before the passing run); all four criteria (sc-14-1..sc-14-4) verified — safety benchmark
  exhaustive, `typecheck:tests` stress-tested with a deleted proof, `update-all` 0 drift live,
  full suite **4720 passed | 1 skipped | 0 failed** across 353 files (builder tests 23, +14 new).
