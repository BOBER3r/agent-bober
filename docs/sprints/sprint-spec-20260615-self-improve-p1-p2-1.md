# Replay store + selfImprove config section + `bober replay capture|list|show`

**Contract:** sprint-spec-20260615-self-improve-p1-p2-1  ·  **Spec:** spec-20260615-self-improve-p1-p2  ·  **Completed:** 2026-06-15

## What this sprint added

Lands the **storage foundation** of Phase 5's replay regression harness — the substrate that
later sprints will use to make self-improvement safe to enable. A new `selfimprove/` module holds
a pure, SQLite-backed `ReplayStore` (cloning the `FactStore` discipline from
`src/state/facts.ts`) over a `replay_cases` baseline index, plus immutable per-case JSON
fixtures under `.bober/replay/cases/`. A new off-by-default `selfImprove` config section
(Zod) is wired into `BoberConfigSchema`, and a `bober replay capture|list|show` CLI ingests
existing `.bober/eval-results/eval-*.json` into the corpus. **No live pipeline file was touched and
no LLM call is made** — this sprint only freezes a golden corpus and reads it back.

This is the first of four Phase 5 sprints. The actual regression gate (`replay run` /
verdict comparison), the evaluator guards (`deterministicGate`, `rubricIsolation`,
`requireCitedArtifact`), and the GEPA evolve loop are **deferred to Sprints 2–4** — which is
exactly why every `selfImprove` flag defaults to `false` here: the corpus can be built and
inspected with zero behavior change until those gates exist.

## Public surface

- `ReplayStore` (`src/orchestrator/selfimprove/replay-store.ts:68`) — SQLite-backed case store; constructor takes a db path (works with `':memory:'`), creates `replay_cases` idempotently (`CREATE TABLE IF NOT EXISTS`). Methods: `putCase(input)` (validates via `ReplayCaseSchema`, derives the deterministic `caseId`, `INSERT OR REPLACE` with bound `?` params, returns the record), `getCase(id)` → record | `null`, `listCases()` → records ordered by `t_captured ASC`, `getBaselineVerdict(id)` → `"pass"`/`"fail"`/`null`, `close()`. **PURE**: never calls `Date.now()`/`new Date()` inside the class — every timestamp is a parameter.
- `caseId(contractId, iteration, diffDigest)` (`src/orchestrator/selfimprove/replay-store.ts:22`) — exported deterministic id: `sha256(`${contractId}|${iteration}|${diffDigest}`).slice(0,16)`, mirroring `factId` (`src/state/facts.ts:58`). `tCaptured` is intentionally excluded from the hash, so the id is stable across recaptures and only changes when `diffDigest` changes.
- `ReplayCaseSchema` / `ReplayCaseInput` / `ReplayCaseRecord` (`src/orchestrator/selfimprove/replay-types.ts:9,18,22`) — Zod input schema (`contractId`, `iteration`, `baselineVerdict` enum `pass|fail`, `diffDigest`, `evalDetailsJson`, `tCaptured` as ISO-8601 datetime) + the record type (`= input & { caseId }`), mirroring `FactSchema`.
- `SelfImproveSectionSchema` / `SelfImproveSection` (`src/config/schema.ts:120`) — `z.object` with `deterministicGate`, `rubricIsolation`, `requireCitedArtifact` each `.default(false)`, plus `replayDir` `.default('.bober/replay')`. Wired into `BoberConfigSchema` as `selfImprove: SelfImproveSectionSchema.optional()` (`src/config/schema.ts:413`). A config that omits `selfImprove` loads without throwing.
- `registerReplayCommand(program)` (`src/cli/commands/replay.ts:43`) — registers `bober replay capture|list|show`, registered in `src/cli/index.ts` next to `registerFactsCommand`. Handlers **never throw** — on error they set `process.exitCode = 1` and return (the `src/cli/commands/facts.ts` pattern).

## How to use / how it fits

In a project that already has `.bober/eval-results/eval-*.json`:

```bash
bober replay capture          # ingest eval-results → .bober/replay/cases/<caseId>.json + replay.db
bober replay list             # one row per captured case (id, contract, iter, verdict, captured-at)
bober replay show <caseId>    # contractId, iteration, baselineVerdict, diffDigest, tCaptured, source path
```

`capture` reads each `eval-*.json` (`persistEvalResult` shape: `contractId`, `iteration`,
`passed`, `results[]`), maps `baselineVerdict = passed ? 'pass' : 'fail'`, derives
`diffDigest = sha256(JSON.stringify(results)).slice(0,32)` (the real git diff is not
re-derivable post-hoc), stores `evalDetailsJson = JSON.stringify(results)`, stamps
`tCaptured = new Date().toISOString()` **at the handler boundary** (not in the store), writes
the baseline row and an immutable `.bober/replay/cases/<caseId>.json` fixture. Files that fail
`JSON.parse` or are missing required fields are skipped with a warning, not crashed. All three
subcommands accept `--replay-dir <dir>` (default `.bober/replay`). An absent eval-results
directory or unknown `show <id>` prints a friendly message; `show <id>` on an unknown id also
sets `exitCode=1`.

The frozen corpus this produces is the input the upcoming `replay run` gate (Sprint 2) will
diff a re-evaluation against, to catch regressions in the self-improvement loop before it is
allowed to act.

## Notes for maintainers

- **Off-by-default is load-bearing.** Every `selfImprove` flag defaults to `false` and the
  section is `.optional()`. Until Sprints 2–4 wire the gates that read these flags, capturing
  and inspecting the corpus has **zero** effect on a pipeline run. Do not flip a default to
  `true` without the corresponding gate landing.
- **Purity boundary.** `ReplayStore` mirrors `FactStore`: no clock read inside the class, every
  SQL statement parameterized with `?` (no string interpolation), id is a content hash. Keep new
  store methods on the same discipline so the store stays `:memory:`-testable.
- **No new dependency.** Reuses the already-present `better-sqlite3` from `src/state/facts.ts` —
  `package.json` is unchanged.
- **`replay show` source path (known UX nit, intentional).** `show` prints the fixture path
  (`.bober/replay/cases/<id>.json`), not the original eval-result path. The fixture's JSON body
  carries `sourceFile` (the original eval-result path) for full provenance; the evaluator
  accepted this as a UX-only detail.
- **Sibling-command convention.** Like `bober facts` / `bober memory`, the `replay` family is
  documented in [`docs/self-improvement-memory.md`](../self-improvement-memory.md) (under "Replay
  Regression Harness"), not in `COMMANDS.md` / the README command list — those omit the
  self-improvement family by established convention.
