# Builder hub emission + `bober seo build` CLI + draft store

**Contract:** sprint-spec-20260717-seo-improver-builder-13  ·  **Spec:** spec-20260717-seo-improver-builder  ·  **Completed:** 2026-07-17

## What this sprint added

The **wiring** that turns the Sprint-12 `SeoBuilder` into a runnable capability: a new
`bober seo build <reportId>` subcommand, an atomic write-once `SeoDraftStore`, and a
`SeoBuildRunner` that drives one invocation end-to-end — read the persisted report, narrow the
hub's approved SEO findings to that report's workflow, run `SeoBuilder.build`, persist the
`SeoDraft`s, and **best-effort** emit each draft to the priority hub as an approval-required
`kind: "action"` Finding. Everything is additive: `build` is a child subcommand hung off the
existing `seo` command and the `bober seo <workflow>` analyze path stays byte-identical when
`build` is not invoked (sc-13-3). Nothing is auto-applied to a live property, and the runner
**never throws** — it always resolves an `exitCode` of `0` or `2`.

## Public surface

- `bober seo build <reportId>` (CLI subcommand, `src/seo/command.ts:102`) — drafts
  human-approval-required SEO artifacts from a report's approved hub findings. Stamps `now`
  **once** at the `.action()` boundary (`command.ts:111`), never throws, sets
  `process.exitCode` to `0`/`2` (`1` is Commander-reserved). Additive sibling of the analyze
  action — it does not touch the `seo <workflow> [target]` chain above it.
- `SeoBuildRunner` (class, `src/seo/builder/build-runner.ts:152`); `.run(input)`
  (`build-runner.ts:161`) — the one end-to-end driver. Returns `SeoBuildRunOutcome`. One
  top-level try/catch wraps every fallible step (report read, approved-findings read, build,
  persist) → `exitCode: 2`; an unknown reportId or a report with no approved findings is a
  **clean `exitCode: 0`** with an informational stdout message and **zero** hub emits (sc-13-4).
- `SeoBuildRunInput` / `SeoBuildRunOutcome` (types, `build-runner.ts:34` / `:53`) — input
  carries `{ projectRoot, config, reportId, now }` plus optional test injections
  (`reportStore` / `draftStore` / `builder` / `readApproved` / `findingSink`) mirroring
  `runner.ts`'s injectable dependencies; outcome is `{ drafts?, skipped?, exitCode }`.
- `SeoDraftStore` (class, `src/seo/builder/draft-store.ts:49`) — persists a `SeoDraftBundle`
  JSON under `.bober/seo/drafts/`, mirroring `SeoReportStore`: atomic temp-file + POSIX
  `rename`, sanitized `<reportId>-seo-drafts.json` filename, **write-once id = the source
  `reportId`** (one bundle per built report; a re-run overwrites). `read` returns `null` on a
  missing file and `list` returns `[]` when the dir is absent — neither throws; only `save`
  can throw (the runner catches and fails closed).
- `SeoDraftBundle` (type, `draft-store.ts:38`) — `{ reportId, target, generatedAt, drafts,
  skipped }`. `generatedAt` is always the injected `now`, never `Date.now()`.
- `SeoCommandOverrides.runBuild` (`src/seo/command.ts:54`) — the test seam that bypasses the
  real build runner (no real fs/hub), alongside the existing `runWorkflow`.

## How it fits

`SeoBuildRunner` closes the Phase-2 loop that Sprints 11–12 fenced off:

```
report (SeoReportStore) ─┐
                         ▼
  readApprovedSeoFindings(FactStore)  ──filter af.workflow === report.workflow──▶  ApprovedFinding[]
                         ▼
              SeoBuilder.build({ approvedFindings, target: report.target, config, now })
                         ▼
        SeoDraft[]  ──▶  SeoDraftStore.save (.bober/seo/drafts/)  ──▶  best-effort hub kind:"action"
```

The **only** reportId → approved-findings linkage is the workflow tag: hub findings carry no
stored reportId, so the report is read first (it also supplies `report.target`, required by
`SeoBuilder.build`, and detects an unknown reportId), then approved findings are narrowed to
`af.workflow === report.workflow` (`build-runner.ts:175`). Each surviving draft is mapped to a
hub Finding by `draftToFinding` (`build-runner.ts:85`) with `kind` pinned to `"action"` — every
`SeoDraft` carries the `humanApprovalRequired: true` type literal, so a draft is *always* an
approval-required action. `emitDraftsToHub` (`build-runner.ts:114`) mirrors Phase-1's
`emitFindingsToHub` best-effort discipline: it runs **after** the persist, checks emptiness
before opening a `FactStore`, and a throwing sink is logged and swallowed — it never changes the
exit code and never un-persists a draft.

Draft severity/urgency default to `3`: a `SeoDraft` carries no severity of its own (it is
decoupled from its source finding by `SeoBuilder.build`), so the runner does not invent a
provenance link back to the approved finding's severity — see the maintainer note below.

## Real-CLI smoke verification

Beyond the unit tests (build/typecheck clean; **4706 passed | 1 skipped** across 353 files;
lint 0 errors / 2 pre-existing warnings; zero regressions), the evaluator ran a **real compiled
CLI smoke test** — `node dist/cli/index.js seo build <reportId>` against a seeded report plus an
approved hub finding — and confirmed end-to-end, on the shipped binary:

- exit `0`, a persisted draft bundle with `humanApprovalRequired: true` and **no leftover
  `.tmp`** file (atomic rename landed);
- a new hub `kind: "action"` fact written for the draft;
- an unknown reportId → informational message, exit `0`, and **zero** hub emits.

This is real exit codes / real persisted files / real hub facts, not mocked — the evaluator note
calls it out explicitly.

## Notes for maintainers

- **`build` never throws and only emits approval-required actions.** Keep the single top-level
  try/catch and the best-effort-after-persist ordering. `exitCode: 2` is reserved for a caught
  *unexpected* error; an unknown reportId / no-approved-findings / workflow-mismatch is a normal
  `exitCode: 0` with a message and zero emits — do not conflate the two.
- **Draft severity/urgency are hard-coded `3`.** If a future sprint threads
  `ApprovedFinding.severity` through `SeoBuildResult` into the draft, revisit `draftToFinding`
  (`build-runner.ts:85`) so the emitted hub action reflects the source finding's severity
  instead of the mid-scale default.
- **Write-once id is the `reportId`.** Re-running `build` for the same report overwrites its
  bundle in place (atomic rename). There is intentionally one draft bundle per built report.
- **`.tmp` uniqueness token uses `Date.now()` for the filename only** (`draft-store.ts:60`),
  never as a bundle timestamp — `generatedAt` is always the injected `now`. Preserve that
  carve-out if you touch the store.
- **Phase-2 builder docs (`docs/seo.md`) land in Sprint 14.** This sprint deliberately does not
  touch `docs/seo.md`, the safety benchmark, or `update-all` (all Sprint-14 non-goals).

## Scope

One commit on `bober/medical-team`:

- **`7be0dca`** — `bober(sprint-13): bober seo build CLI + draft store + hub action emission`.
  Two new files (`src/seo/builder/build-runner.ts` +207, `src/seo/builder/draft-store.ts` +96)
  plus their tests (`build-runner.test.ts` +326, `draft-store.test.ts` +121) and an additive
  edit to `src/seo/command.ts` (+39, the `build` child subcommand) and `command.test.ts` (+98).
  Passed **iteration 1**; all five criteria (sc-13-1..sc-13-5) verified, including the real
  compiled-CLI smoke test above. Build / typecheck clean (no static `damcrawler` import in the
  build path); lint 0 errors (2 pre-existing warnings); suite **4706 passed | 1 skipped** across
  353 files; zero regressions.
