# SeoBuilder.build — gated generative drafts (mandatory never-encode re-filter)

**Contract:** sprint-spec-20260717-seo-improver-builder-12  ·  **Spec:** spec-20260717-seo-improver-builder  ·  **Completed:** 2026-07-17

## What this sprint added

The highest-risk piece of **Phase 2 (builder)**: `SeoBuilder`, the first component that
crosses the advisory→generative boundary Sprints 2 and 11 fenced off. `SeoBuilder.build`
consumes `ApprovedFinding[]` **only** (a raw `SeoFinding[]` does not type-check), generates
one `SeoDraft` per finding from deterministic, network-free templates, and — the load-bearing
safety property — **re-runs the mandatory injected `NeverEncodeFilter` over every generated
draft's artifact text** (drop-only). A draft that matches a banned tactic is dropped and
counted in `skipped`, never emitted, even when it was an *approved* finding's own title that
implied the tactic. Every returned draft carries `humanApprovalRequired: true` (the type's
literal) and a `sourceCitationUrl` copied verbatim from the approving finding; nothing is ever
auto-applied to a live property, and `build` never throws (a per-finding generation error
increments `skipped` and the loop continues).

## Public surface

- `SeoBuilder` (class, `src/seo/builder/seo-builder.ts:54`) — the gated generative builder.
  Constructor takes a **mandatory** `NeverEncodeFilter` (first arg, `:57`) and an optional
  injectable `Record<SeoDraftKind, DraftGenerator>` map (`:58`, defaulting to
  `DEFAULT_DRAFT_GENERATORS`). The mandatory filter arg is a compile-time guarantee — you
  cannot construct a builder without one.
- `SeoBuilder.build(input)` (`src/seo/builder/seo-builder.ts:68`) — generates and filter-scrubs
  drafts. Returns `SeoBuildResult`. Never throws.
- `SeoBuildInput` (type, `src/seo/builder/seo-builder.ts:31`) — `{ approvedFindings:
  ApprovedFinding[]; target: string; config: BoberConfig; now: string }`. `approvedFindings`
  accepts `ApprovedFinding[]` **only** (sc-12-1); `config` and `now` are threaded for interface
  parity with `SeoAnalyzeInput` / the Sprint-13 runner but are not read by this sprint's body.
- `SeoBuildResult` (type, `src/seo/builder/seo-builder.ts:46`) — `{ drafts: SeoDraft[];
  skipped: number }`. `skipped` counts findings that produced no draft — either a re-filter
  drop or a generation error.
- `DraftGenerator` (type, `src/seo/builder/draft-generators.ts:20`) — `(finding:
  ApprovedFinding, target: string) => string`; turns one approved finding into proposed
  artifact text.
- `DEFAULT_DRAFT_GENERATORS` (`src/seo/builder/draft-generators.ts:30`) — one deterministic,
  pure (no LLM, no `fetch`, no clock, no `Math.random`) template per `SeoDraftKind`. Each
  echoes `finding.title` into the artifact text so a banned-implying title yields a
  banned-implying draft the re-filter can catch.
- `kindForApprovedFinding(finding)` (`src/seo/builder/draft-generators.ts:53`) — deterministic
  `playbookRef`-prefix → `SeoDraftKind` selection (`seo.schema*`→`schema-jsonld`,
  `seo.internal-linking*`→`internal-link`, `seo.content-decay*`→`content-refresh`), falling
  back to `title-meta` when no prefix matches. Pure; never throws.

## How it fits

`SeoBuilder` sits immediately behind the `ApprovedFinding` one-way valve from Sprint 11. The
intended Sprint-13 wiring is `readApprovedSeoFindings(store)` → `builder.build({ approvedFindings,
... })` → `SeoDraft[]` proposals. Because `build` only accepts `ApprovedFinding` instances, a
raw / gate-dropped / never-encode-dropped / uncited / verifier-downgraded `SeoFinding` has no
path in — and even for a legitimately approved finding, the generated draft is re-scrubbed
before it can leave the builder. This sprint does **not** emit to the hub or add a CLI (Sprint
13), and does **not** auto-apply any draft.

Minimal shape:

```ts
import { SeoBuilder } from "./builder/seo-builder.js";
import { NeverEncodeFilter } from "./never-encode-filter.js";

const builder = new SeoBuilder(new NeverEncodeFilter()); // filter is MANDATORY
const { drafts, skipped } = builder.build({
  approvedFindings, // ApprovedFinding[] only — a raw SeoFinding[] does not type-check
  target: "https://example.com",
  config,
  now,
});
// every draft: humanApprovalRequired === true, sourceCitationUrl copied from the finding
```

## Security lesson — the mandatory re-filter over *generated* text

The Phase-1 pipeline already runs the `NeverEncodeFilter` over `SeoFinding.recommendation`
before a finding can reach the hub, and `ApprovedFinding` guarantees the input is human-approved
and cited. The builder deliberately does **not** trust that provenance for its *output*: it
re-runs the same injected filter over each freshly generated draft artifact (`isBanned`,
`src/seo/builder/seo-builder.ts:111`) and drops any match. This is defense-in-depth against
two concrete leaks a "trust the approved input" design would have:

- An approved finding whose *title* implies a banned tactic (parasite SEO, expired-domain link
  inheritance, link buying) — the templates echo `title` into the artifact, so the drop fires
  on the generated text. Proven across **all four** `SeoDraftKind`s by the evaluator.
- A future / swapped `DraftGenerator` that emits banned text the input did not literally
  contain — the re-filter scans the *generated* artifact, not the input, so it still catches it
  (proven via an injected generator forcing a banned artifact).

Implementation note: a `SeoDraft` has no `recommendation` field, so `isBanned` builds a
throwaway probe `SeoFinding` whose `recommendation` **is** the draft artifact text and asks the
injected filter `apply([probe]).dropped.length > 0`. Using the injected filter instance (not
`NEVER_ENCODE_PATTERNS` directly) keeps the "mandatory filter" guarantee load-bearing and
spy-testable. `artifact` is the only free-text field on `SeoDraft`, so the evaluator found no
bypass path; the builder is network-free by construction.

The takeaway for future generative components: **re-validate what you generate, not just what
you consume — an approval upstream is not a licence to emit un-scanned output.**

## Notes for maintainers

- **The re-filter is the safety property — keep it drop-only and keep the filter mandatory.**
  Do not add a code path that emits a draft without passing through `isBanned`, and do not make
  the constructor's `NeverEncodeFilter` optional. Both would silently re-open the leak this
  sprint closed.
- **Templates must echo the finding's untrusted text into the artifact.** The drop only works
  because the banned-implying title reaches the scanned artifact string. A future generator
  that summarises / paraphrases away the banned phrasing would defeat the title-driven proof —
  if you add such a generator, add a matching benchmark that still forces a banned artifact.
- **`config` / `now` are threaded but unread this sprint.** They exist for parity with the
  analyzer and the Sprint-13 runner contract; do not assume `build` reads them yet.
- **Carried follow-up → Sprint 14 (CI-enforce the compile-proofs).** The `@ts-expect-error`
  compile-proof for sc-12-1 (and the Sprint-11 sc-11-1/sc-11-2 proofs) is **true but not
  regression-protected**: `tsconfig` excludes `**/*.test.ts` from `tsc`, and vitest does not
  type-check by default, so no CI command fails if the type gate weakens. The evaluator
  verified the proofs via a standalone `tsc` probe this sprint. Sprint 14 is scheduled to add a
  `typecheck:tests` script (or enable vitest typecheck) wired into the suite so these proofs
  become enforced. Until then, treat the compile-proofs as manually-verified, not CI-guarded.
- **Phase-2 builder docs land in `docs/seo.md` in Sprint 14** — this sprint deliberately does
  not touch `docs/seo.md`.

## Scope

One commit on `bober/medical-team`:

- **`fba8f94`** — `bober(sprint-12): SeoBuilder.build — gated generative drafts (mandatory
  never-encode re-filter)`. Three new files (+371): `src/seo/builder/seo-builder.ts` (+124),
  `src/seo/builder/draft-generators.ts` (+56), `src/seo/builder/seo-builder.test.ts` (+191).
  Passed **iteration 1**; all five criteria (sc-12-1..sc-12-5) verified — the evaluator wrote
  its own `tsc` type-gate probe and reproduced the never-encode drop across all four
  `SeoDraftKind`s, with no leak path found. Build / typecheck clean, lint 0 errors (2
  pre-existing warnings); suite **4683 passed | 1 skipped** across 351 files; zero regressions.
