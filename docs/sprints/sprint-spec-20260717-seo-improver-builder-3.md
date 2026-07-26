# liveWeightStatus signature caveat (documented != live-weight)

**Contract:** sprint-spec-20260717-seo-improver-builder-3  ·  **Spec:** spec-20260717-seo-improver-builder  ·  **Completed:** 2026-07-17

## What this sprint added

A single machine-readable enum, `liveWeightStatus`, on `SeoSignature` that encodes
the **documented-vs-live-weight caveat** (ADR-2): whether a playbook invariant is
corroborated by an actual live ranking signal or is merely documented guidance that
nobody has confirmed still moves rankings. It is a **soft field** — parsed from a new
`**LiveWeightStatus:**` label, defaulting to `unknown` when absent or malformed, exactly
mirroring the existing `evidenceGrade` handling — so every already-shipped signature keeps
parsing with zero behavior change. The status is surfaced into the analyzer prompt
(a `LiveWeight:` line) and, critically, drives a **DOWNGRADE-ONLY** confidence rule in
`analyzer.toSeoFinding`: a finding grounded in a `documented-only` signature can never be
emitted as `firm` — it is knocked down to `tentative`. There is no upgrade branch. A
build-time skills-lint additionally flags any high-severity (human-approve) signature that
omits the field. The field lives **only on the signature**; `SeoFinding` is unchanged
(ADR-2, nonGoal #1).

## Public surface

- `SeoSignature.liveWeightStatus` (`src/seo/types.ts:79`) — new **required** member on the
  parsed signature type: `"live-corroborated" | "documented-only" | "unknown"`. Documented
  inline (`types.ts:63-70`) as the documented-vs-live-weight caveat; deliberately absent
  from `SeoFinding`.
- `**LiveWeightStatus:**` playbook label (`skills/bober.seo-generic/SKILL.md:34`,
  `src/seo/parser.ts:87` `LABEL_RE`) — a new soft field in the SKILL.md signature-block
  format; `live-corroborated|documented-only|unknown`, defaults to `unknown` if
  absent/invalid.
- `SeoPlaybookParser` default-to-`unknown` handling (`src/seo/parser.ts:132-133`) — reads
  `fields.LiveWeightStatus`, validates it against `LIVE_WEIGHT_STATUSES`
  (`parser.ts:66`) via `isLiveWeightStatus` (`parser.ts:69`), and falls back to `unknown`
  on absent/garbage input. The parser stays **pure and total** — a malformed value never
  throws, it just defaults (identical idiom to `evidenceGrade`).
- `renderSignature` `LiveWeight:` prompt line (`src/seo/retriever.ts:108`) — appends
  `LiveWeight: <status>` to each rendered signature so the caveat reaches the analyzer
  prompt fragment alongside `Invariant`/`Tactic`/`Source`.
- `toSeoFinding` downgrade-only confidence rule (`src/seo/analyzer.ts:256-259`) — the sole
  assignment of `SeoFinding.confidence`: `signature?.liveWeightStatus === "documented-only"
  && modelFinding.confidence === "firm" ? "tentative" : modelFinding.confidence`.
  `live-corroborated` and `unknown` leave confidence untouched; nothing ever upgrades
  `tentative -> firm`.
- Skills-lint helper `findHighSeverityOmissions` (`src/seo/skills-content.test.ts`,
  sc-3-4) — a **test-only** lint (not a shipped runtime check) that filters signatures for
  `policyClass === "human-approve" && liveWeightStatus === "unknown"` and flags them.
  `human-approve` is the lint's proxy for "high-severity playbook" because severity is
  model-emitted on `SeoFinding`, not carried on a `SeoSignature`.

## How to use / how it fits

A playbook author declares the caveat in a signature block; readers/maintainers do not call
any new API:

```markdown
### risky-live-site-rewrite
- **Title:** Large-scale rewrite
- **PrimarySourceUrl:** https://developers.google.com/search/docs/...
- **PolicyClass:** human-approve
- **LiveWeightStatus:** documented-only
```

A `documented-only` block that the analyzer grounds a `firm` finding in emerges from
`toSeoFinding` as `tentative`. In the pipeline (`resolve playbook -> select source ->
gather -> analyze -> never-encode filter -> citation gate -> ...`), this rule fires inside
the analyze step as each model finding is converted to a `SeoFinding`, using the
`playbookRef -> SeoSignature` lookup that already powers the `human-approve` override.
Omitting the label entirely yields `unknown`, which leaves confidence exactly as the model
emitted it — so existing skills that predate this sprint behave identically.

## Notes for maintainers

- **Downgrade-only is the load-bearing guarantee and was grep-verified by the evaluator.**
  The confidence ternary at `analyzer.ts:256-259` is the *only* place `SeoFinding.confidence`
  is assigned. Do not add any branch that raises confidence — a `documented-only` signal
  must only ever weaken a finding, never strengthen one.
- **`liveWeightStatus` mirrors `evidenceGrade`, not `policyClass`.** It is a *soft* field:
  absent/garbage -> `unknown`, never dropped, never throws. This is the opposite of
  `PolicyClass` (a hard field whose `never-encode`/invalid values drop the whole block).
- **The field lives on `SeoSignature` only (ADR-2).** Do not add it to `SeoFinding`; the
  caveat is a property of the source guidance, and its effect on a finding is expressed
  through the existing `confidence` field alone.
- **The high-severity lint is a `.test.ts` backstop, not a runtime guard, and uses
  synthetic fixtures.** Authoring real `LiveWeightStatus` values into the shipped
  `skills/bober.seo-*` files is **Sprint 4's** job (nonGoal here) — this sprint ships the
  plumbing and the lint, not the re-graded corpus.
- **Known coverage gap carried to Sprint 4.** sc-3-2 (the `LiveWeight:` prompt line) was
  confirmed at runtime but lacks a persisted `retrieve().promptFragment` assertion; the
  evaluator carried adding it to Sprint 4, which authors real values to assert against.

## Scope

One commit — `d3a5c2e` — touching `src/seo/types.ts` (field + docstring), `src/seo/parser.ts`
(status union, guard, label alternation, default-to-`unknown`), `src/seo/retriever.ts` (the
`LiveWeight:` prompt line), `src/seo/analyzer.ts` (downgrade-only ternary), the collocated
`parser.test.ts` / `analyzer.test.ts` / `skills-content.test.ts`, and one documentation
bullet in `skills/bober.seo-generic/SKILL.md`. No new field on `SeoFinding`, no upgrade
path, no re-graded skill corpus (all Sprint 4), no LLM/network/deps. All 5 required criteria
(sc-3-1..3-5) passed on **iteration 1**; build/typecheck/lint clean; full suite
**4546 passed | 1 skipped | 0 failed**, zero regressions.
