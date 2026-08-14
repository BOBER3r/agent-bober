# Documentation + deferred live-smoke follow-up + final byte-identical check

**Contract:** sprint-spec-20260726-graph-backend-choice-8  ·  **Spec:** spec-20260726-graph-backend-choice  ·  **Completed:** 2026-07-27

## What this sprint added

This is the **final sprint of spec-20260726-graph-backend-choice** (docs-only). It generalizes the
README's graph section from tokensave-specific to both engines, adds a new full reference
(`docs/graph-backends.md`) with the operation-parity table derived directly from
`tokensave-backend.ts` / `code-review-graph-backend.ts`, fixes a pre-existing dead link, and records
a fresh final-verification pass. No adapter/selection/transport behavior changed; the only code
touched is one cosmetic CLI `.description()` string in `src/cli/commands/graph.ts`.

## Public surface

- **`README.md`** — the "Graph (Tokensave) Integration" section is renamed "Graph Integration
  (tokensave or code-review-graph)" and rewritten to cover both engines: the selection algorithm
  (auto-detect with tokensave preference, `graph.backend` override, `graph.tokensavePath` /
  `graph.codeReviewGraphPath`), install commands for both engines (tokensave's brew/scoop/cargo
  strings kept **verbatim**; `pip install code-review-graph`, Python 3.10+ added), a 9-row operation
  parity table (search/reviewContext/overview/impact/changes/callers/callees/imports/tests) plus a
  3-row CLI-verb table, and the `graph status --json` engine/backendVersion/selectedBy readout. The
  stale "not implemented yet" / "scheduled to be fixed in Sprint 7" / "stay on tokensave for full
  querying" caveat (accurate through Sprint 5, now 2 sprints out of date) is removed and replaced
  with a statement that `code-review-graph` has full read/write parity as of Sprint 6 (query
  sub-patterns) and Sprint 7 (`reviewContext` narrow fix).
- **`docs/graph-backends.md`** (new) — the fuller reference: the selection algorithm with source
  line citations, both install paths, the full parity table (with tokensave-side AND
  code-review-graph-side source line citations per row, so each mapping is spot-checkable against
  the code), the `graph status` readout, a "Verification & live smoke" section (what CI runs against
  real committed fixtures vs. the deferred manual live-cr-graph-`serve` recipe, including the
  venv+`.pth` workaround for cr-graph's `python -I` parser-probe blocker), the 5 residual follow-ups
  carried from Sprints 4/6/7, and this sprint's final verification numbers.
- **`README.md`** dead-link fix — the "For architecture details see:" link at (former) line 239
  pointed at `.bober/architecture/arch-20260524-port-code-review-graph-architecture.md`, which does
  not exist in this repository (confirmed via `find`/`grep` before editing — no such file anywhere
  under `.bober/architecture/`). It now points at `docs/graph-backends.md`.
- **`README.md`** minor consistency fixes — the `/bober-graph` slash-command table row's
  "(requires tokensave)" now reads "(requires tokensave or code-review-graph)"; a
  `docs/graph-backends.md` link was added to the `## Documentation` index.
- **`src/cli/commands/graph.ts`** — one cosmetic string: the `graph` command group's
  `.description()` changed from `"Code-graph (tokensave) integration commands"` to
  `"Code-graph (tokensave or code-review-graph) integration commands"`. No test asserted the old
  string (verified via `grep` before changing it); this is `--help` text only, no logic change.

## How the parity table was derived (not fabricated)

Each row was read directly from source, not carried over from the handoff's suggested list without
verification:

- `tokensave-backend.ts` — the `TOOL` (`:18-24`) and `QUERY_TOOL` (`:27-32`) const maps, and each
  `*Plan` method's `tool:` field, were read line-by-line.
- `code-review-graph-backend.ts` — each `*Plan` method's `tool:` field was read line-by-line; the
  `CR_QUERY_PATTERN` map (`:150-155`) and its accompanying "Trap 1" comment (bober `imports_of` →
  cr-graph `"importers_of"`, NOT cr-graph's own `"imports_of"`) were read and reproduced verbatim in
  both `README.md` and `docs/graph-backends.md`.
- `registry.ts` and `cli/commands/graph.ts` were read to confirm the selection algorithm description
  and the `graph status --json` field names (`engine`/`backendVersion`/`selectedBy`) match the actual
  emitted JSON shape (`graph.ts:303-312`).
- The result matched the handoff's suggested mapping exactly — no corrections were needed, but every
  row was independently confirmed against the current source rather than trusted blindly.

## Verification (see `docs/graph-backends.md` §6 for the full write-up)

- `npx vitest run` → **375 test files (1 skipped) · 5083 tests passed | 2 skipped | 0 failed** — same
  as the Sprint 7 baseline, confirming zero regressions from this sprint's docs-only change.
- `npm run build` → clean.
- `npm run typecheck` → clean.
- `npm run lint` → **0 errors, 2 warnings** (both pre-existing, unrelated `no-explicit-any` warnings
  in `src/orchestrator/eval-persist.test.ts`).
- No live `code-review-graph serve` smoke run was performed this sprint. The "cr-graph selectable
  end-to-end" verification is satisfied via the real committed fixtures under
  `tests/graph/fixtures/cr-graph/` exercised by the vitest run above, per this sprint's nonGoal
  against claiming live verification without an actual run.

## Notes for maintainers

- **spec-20260726-graph-backend-choice is now complete** — all 8 sprints done. Sprints 1-7 built the
  `GraphBackend` seam, full auto-detect/override selection, complete `code-review-graph` adapter
  parity (all six response `*Plan`s + `CliMap`), and command parity across every graph-consuming
  surface; this sprint documents it and confirms nothing regressed.
- **Residual follow-ups** (not fixed this sprint, all documented in `docs/graph-backends.md` §5):
  the `code-review-graph update` diff-base ceiling, the `tokensavePath`+`backend` transport
  precedence edge case, the accept-any `isCompatible` TODO, two minor test-coverage gaps, a
  file-size soft-threshold note on `code-review-graph-backend.ts`, and the pre-existing
  `ARCH_DOC_PATH` dead-link constant duplicated in three CLI files' error messages (`graph.ts`,
  `impact.ts`, `onboard.ts`) — this sprint fixed the equivalent `README.md` link but deliberately did
  **not** touch those three `.ts` constants, since that would be a code change beyond this sprint's
  docs-only scope.
- **Live cr-graph smoke run remains a manual, deliberately-deferred step** (nonGoal: do not add it
  to CI). `docs/graph-backends.md` §4 has the exact reproducible recipe, including the environment
  gotcha from Sprint 4 (the venv+`.pth` workaround needed to get a populated graph rather than a
  0-node one).
