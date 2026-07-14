# Remove the two verified dead-code orphans (stashAndRestore, saveOutline)

**Contract:** sprint-spec-20260621-codebase-health-remediation-3  ·  **Spec:** spec-20260621-codebase-health-remediation  ·  **Completed:** 2026-06-21

## What this sprint added

This sprint **deletes** the only two dead-code candidates that verification confirmed as genuinely
orphaned — `stashAndRestore` (`src/utils/git.ts`) and `saveOutline` (`src/state/outline-state.ts`) —
plus their barrel re-export lines. Both were exported solely through a barrel
(`src/utils/index.ts`, `src/state/index.ts`) with **zero** call sites (grep-verified). This is a
**removal**, not a feature: the public surface gets **smaller**. `outline-state.ts` is **kept**
because its other export, `readOutline`, is live (imported at `pipeline.ts:58`, called at
`pipeline.ts:828`); only `saveOutline` and the now-unused `writeFile` / `ensureDir` imports it pulled
in were removed. The three research candidates flagged as **false positives** —
`runPlanAnswerInteractive`, `summarizeSprint`, `readBriefing` — were intentionally left untouched.
**Zero behavior change; 2815/2815 tests green.**

## Public surface (removed)

Two exported symbols and their two barrel re-export lines were **removed**. Nothing was added.

- `stashAndRestore<T>(cwd, fn)` — **REMOVED** from `src/utils/git.ts` (was `:149-171`, the function +
  its doc comment) and de-listed from the `./git.js` barrel re-export in `src/utils/index.ts`. It
  stashed dirty changes, ran `fn`, then `git stash pop`'d; no production or test code called it.
  `git.ts` needed no import changes (it already imported `execa` / `hasUncommittedChanges` for live
  functions).
- `saveOutline(projectRoot, specId, content)` — **REMOVED** from `src/state/outline-state.ts` (the
  function + its doc comment) and de-listed from the `./outline-state.js` barrel re-export in
  `src/state/index.ts`. It wrote a per-spec structure-outline markdown file; no caller existed. The
  `writeFile` and `ensureDir` imports it pulled in were **pruned** (kept `readFile` for the retained
  `readOutline`) so `noUnusedLocals` / `no-unused-vars=error` stay green.

### Retained / explicitly untouched

- `readOutline` (`src/state/outline-state.ts`) — **KEPT**, still re-exported from
  `src/state/index.ts`; it is live (`pipeline.ts:58` import, `:828` call). The file was **not**
  deleted because of it.
- `runPlanAnswerInteractive` (live caller `cli/index.ts:152`), `summarizeSprint` (live caller
  `context-handoff.ts:171`), `readBriefing` (public API via `src/index.ts:153`) — **all three left
  untouched**. The evaluator confirmed `readBriefing` still exports at `src/index.ts:153` and that
  `plan.ts` / `context-handoff.ts` / `briefing-state.ts` are absent from the diff.

## How to use / how it fits

Nothing changes for any caller — both removed symbols had no callers. After this sprint,
`grep -rnE '\b(stashAndRestore|saveOutline)\b' src/` returns **zero** matches (functions, barrel
lines, and any collocated test references all gone). The diff is confined to four files:

| File | Change |
|---|---|
| `src/utils/git.ts` | Deleted `stashAndRestore` + doc (~23 lines); no import changes |
| `src/utils/index.ts` | Removed the `stashAndRestore,` line from the `./git.js` re-export |
| `src/state/outline-state.ts` | Deleted `saveOutline` + doc; pruned now-unused `writeFile` + `ensureDir` imports; `readOutline` retained |
| `src/state/index.ts` | Removed the `saveOutline,` line from the `./outline-state.js` re-export; `readOutline` retained |

## Notes for maintainers

- **`outline-state.ts` was deliberately kept, not deleted.** `saveOutline` was the file's *unused*
  export; `readOutline` is its *live* one. If you ever revisit this file, do not assume the whole
  module is dead — `readOutline` feeds the structure-outline read at `pipeline.ts:828`.
- **The import prune was mandatory, not cosmetic.** Removing `saveOutline` orphaned its `writeFile`
  and `ensureDir` imports; with `noUnusedLocals` enforced (and `no-unused-vars=error`), leaving them
  would have failed the build. `readFile` was kept because `readOutline` still uses it. `git.ts`
  needed no equivalent prune (`stashAndRestore`'s `execa` / `hasUncommittedChanges` deps are shared
  with live functions).
- **The 3 false positives stay.** `runPlanAnswerInteractive`, `summarizeSprint`, and `readBriefing`
  *look* orphaned to a naive cross-reference but have live callers / are public API. Do not "finish
  the cleanup" by removing them — that was the explicit non-goal, and it is why this sprint only
  removed 2 of the 5 research candidates.
- **Dynamic-dispatch false positives untouched.** Checkpoint renderers, registry lookups,
  `createBoberMCPServer`, etc. are reached via dynamic dispatch and were out of scope — a static
  unused-export scan flags them spuriously.
- **Scope / verification.** Build / typecheck exit 0 (`noUnusedLocals` confirms the prune is
  correct); lint 0 errors (2 pre-existing warnings only); `npx vitest run` → **2815/2815 passed**
  (219 files) — no importer broke. All 5 required criteria (sc-3-1..sc-3-5) passed iteration 1.
  Commit `a980d30`. **This sprint completes the plan (3 of 3).**
