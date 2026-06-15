# `bober replay run` deterministic regression gate + runReplayHarness API

**Contract:** sprint-spec-20260615-self-improve-p1-p2-2  ·  **Spec:** spec-20260615-self-improve-p1-p2  ·  **Completed:** 2026-06-15

## What this sprint added

Lands the **regression gate** that *acts* on the frozen corpus Sprint 1 built. A new
`src/orchestrator/selfimprove/replay-harness.ts` adds a PURE `compareToBaseline(baseline, fresh)`
comparator and an async `runReplayHarness(projectRoot, config)` that opens the Sprint 1
`ReplayStore`, re-derives each captured case's **fresh** verdict **deterministically from the
frozen `eval_details_json`** — **never** by re-running the generator or evaluator LLM — and returns
a `{ regressions, improvements, unchanged, total }` breakdown. A new `bober replay run` CLI verb
prints a per-case delta table and **exits non-zero the moment any case regresses** versus its
recorded baseline. `runReplayHarness` is the public function Sprint 4's GEPA `evolve` verb will
import as its promotion gate. **No live pipeline file is touched and no LLM is invoked** — only the
four expected files changed (`replay-harness.ts` + test, `replay.ts` + test); the Sprint 1
`ReplayStore` schema, `evaluator-agent.ts`, `pipeline.ts`, and `agents/` are all unchanged.

## Public surface

- `compareToBaseline(baseline, fresh)` (`src/orchestrator/selfimprove/replay-harness.ts:71`) —
  **PURE** comparator (no clock, no fs, no LLM; all inputs are parameters). Takes two
  `Map<caseId, "pass" | "fail">` and classifies each caseId **present in `baseline`** into
  `{ regressions, improvements, unchanged }` (all `string[]`, sorted by `localeCompare` for
  byte-stable output). The **baseline corpus defines the gate**: caseIds present only in `fresh`
  are not classified, and a caseId absent from `fresh` falls back to its baseline verdict (→
  `unchanged`).
- `runReplayHarness(projectRoot, config)` (`src/orchestrator/selfimprove/replay-harness.ts:154`) —
  async; opens the `ReplayStore` at `<projectRoot>/<config.selfImprove?.replayDir ??
  '.bober/replay'>/replay.db`, `listCases()`, re-derives each fresh verdict from the frozen
  `evalDetailsJson`, and returns `ReplayHarnessResult` = `{ regressions, improvements, unchanged,
  total, fresh, baseline }` (the `fresh`/`baseline` maps are exposed for the CLI table). Always
  `close()`s the store via `finally`. `config.selfImprove` is **optional** — a missing section
  defaults `replayDir`. **This is the single public entry point Sprint 4's `evolve` verb consumes
  as its promotion gate.**
- `Verdict` / `ReplayComparison` / `ReplayHarnessResult` types
  (`src/orchestrator/selfimprove/replay-harness.ts:31,33,43`) — exported for callers (Sprint 4).
- `bober replay run` (`src/cli/commands/replay.ts:269`) — new subcommand on the existing `replay`
  command. Tolerant `loadConfig` (config absence is non-fatal — falls back to a stub honouring
  `--replay-dir`), calls `runReplayHarness`, prints a per-case delta table, and on any regression
  prints the regressed ids and sets `process.exitCode = 1`. Accepts `--replay-dir <dir>` (default
  `.bober/replay`). Handler **never throws** (sets `exitCode = 1` and returns on error).

## How to use / how it fits

```bash
bober replay run        # re-derive each captured case's fresh verdict and diff vs baseline
```

The table has columns `CASE ID | BASELINE | FRESH | DELTA`, one row per captured case (in
`listCases()` / `t_captured ASC` order). The `DELTA` column reads `ok` (unchanged), green
`improvement` (baseline `fail` → fresh `pass`), or red `REGRESSION` (baseline `pass` → fresh
`fail`). After the table, if any case regressed, the regressed caseIds are listed under
`Regressions (N):`.

**Exit codes:**

| Corpus state | stdout | `process.exitCode` |
|--------------|--------|--------------------|
| Empty (`total === 0`) | `no cases captured` | `0` |
| One or more regressions (baseline `pass` → fresh `fail`) | delta table + `Regressions (N):` list | `1` |
| Clean (no regressions; improvements and/or unchanged only) | delta table | `0` (unset) |

The gate diffs against the corpus frozen by `bober replay capture` (Sprint 1), so run `capture`
first to populate `.bober/replay/`.

### Regression / improvement / unchanged semantics

Classification is strictly a transition of the per-case verdict:

- **regression** — baseline `pass`, fresh `fail`
- **improvement** — baseline `fail`, fresh `pass`
- **unchanged** — same verdict either way (including a caseId absent from `fresh`)

Only **regressions** drive the non-zero exit. Improvements and unchanged cases never fail the gate.

### The deterministic fresh-verdict rule (NO LLM)

Because replay **must not** re-run any LLM, the "fresh" verdict is a stable, reproducible function
of the frozen fixture. `deriveFreshVerdict(evalDetailsJson)`
(`src/orchestrator/selfimprove/replay-harness.ts:111`, internal) parses the captured
`eval_details_json` (the JSON array stored at capture time) and returns:

> `fail` **iff** any element's `failures[]` contains an entry with `passed === false` **and**
> `severity === 'error'`; otherwise `pass`. Malformed JSON, a non-array payload, or any
> missing/absent field is treated **permissively → `pass`**.

This makes a replay run a pure function of the frozen corpus — re-running it over an unchanged
corpus always yields zero regressions.

## Notes for maintainers

- **No-LLM-during-replay is the load-bearing invariant.** `replay-harness.ts` and the `replay run`
  handler contain **zero** `runGeneratorAgent` / `runEvaluatorAgent` / `createClient` references
  (grep-verified). Do not introduce a live re-evaluation here — the fresh verdict must stay derived
  from the frozen `eval_details_json` only. This is what lets Sprint 4 use `runReplayHarness` as a
  cheap, deterministic promotion gate.
- **`compareToBaseline` is pure** (mirrors `distill.ts` / `reconcile.ts` discipline): no clock, no
  fs, no network — keep it that way. Determinism comes from the `localeCompare` sorts on all three
  output arrays.
- **`runReplayHarness` is Sprint 4's gate.** It is the single public entry point the GEPA `evolve`
  verb will import; treat its `{ regressions, improvements, unchanged, total }` shape as a stable
  contract.
- **`replay run` tolerates a missing config.** A failed `loadConfig` is non-fatal — the handler
  falls back to a stub config that still honours `--replay-dir`, so the gate works in a project
  without a `bober.config.json`.
- **Test note (not a defect).** The `runReplayHarness` tests use temp file-backed stores rather than
  `':memory:'` because the harness opens its own DB by path; all four required behaviors
  (identical-rerun → 0 regressions, `pass→fail` → regressions once, `fail→pass` → improvements,
  empty corpus → all-empty) are still verified, plus a warning-severity non-regression case. Full
  suite: 2254 tests pass, no regressions.
