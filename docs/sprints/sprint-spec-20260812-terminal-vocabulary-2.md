# No committed contract carries a status the schema forbids

**Contract:** sprint-spec-20260812-terminal-vocabulary-2  ·  **Spec:** spec-20260812-terminal-vocabulary  ·  **Completed:** 2026-08-12

## What this sprint added

Four contracts on disk — `sprint-spec-20260604-docs-correction-{1,2,3,4}.json` — carried
`"status": "pending"`, a word `ContractStatusSchema` has never contained. Each is migrated to
`"completed"` by a **one-line diff**; nothing else in the four files changed. The sprint then adds
the guard that would have caught the drift when it happened: `src/contracts/sprint-contract.test.ts`
now reads `.bober/contracts/` **at run time** and asserts every file's `status` parses against
`ContractStatusSchema`. No production source file was touched — this is a data repair plus a pin.

## Public surface

None. There is no new exported symbol, CLI flag, or config key; the deliverable is four corrected
data files and a test.

| Claim | The test that fails when it stops being true |
|---|---|
| No contract in `.bober/contracts/` carries a status outside `ContractStatusSchema` | `src/contracts/sprint-contract.test.ts:384` — *"no committed contract carries a status outside ContractStatusSchema"* |
| The walk really happened (it is not vacuously green on an empty read) | same file — *"the walk actually happens against the real corpus"*, a `> 200` threshold rather than a hardcoded 256, so a newly added contract does not force an edit here |
| The rule bites, with no disk involved | same file — *"bites: a synthetic illegal status is reported"*, driving the pure `findIllegalStatuses()` (`:362`) over in-memory entries |
| It does not over-fire on any legal member | same file — *"does not bite on any legal ContractStatusSchema member"*, generated from `ContractStatusSchema.options` |
| The **directory-reading** path bites too, so a brand-new file is covered automatically | same file — *"the directory-reading scan reports exactly the one file whose status was rewritten"*, an `mkdtemp` copy of the real corpus with one status rewritten to `"pending"` |

Five new cases (the file goes 26 → 31). The temp copy lives under `os.tmpdir()`, never under
`.bober/`, so a crashed run leaves no residue in the corpus it is scanning.

**It validates the `status` field alone, not the whole `SprintContractSchema` — deliberately.**
60 of the 256 files fail the whole schema for reasons unrelated to `status` (legacy
`successCriteria` shape, missing `nonGoals` / `stopConditions` / `definitionOfDone`), and the only
way to make a whole-schema test green would be to rewrite fields this contract's nonGoal 2 forbids
touching. sc-2-2 asks that "its status parses against `ContractStatusSchema`" — read literally.
The strict-parse count is **unchanged at 196 / 256** before and after this sprint.

## A correction to the record: `loadContract` is strict; `listContracts` is the leak

This contract's own description says the four "load only because `loadContract` parses
non-strictly". **That is false.** `loadContract` (`src/state/sprint-state.ts:96-101`)
`safeParse`s against `SprintContractSchema` and **throws** on failure — these four never loaded
through it at all. The actual leak is `listContracts` (`src/state/sprint-state.ts:132-144`), which
`safeParse`s each file and **silently skips** the ones that fail, by documented design ("so that a
single bad file doesn't break listing for the rest").

That distinction is why the drift sat undetected, and it is not limited to these four: everything
that reads the corpus reads it through `listContracts`, so **60 of the 256 files are invisible to
every reader today** — including the sprint history handed to the generator and the evaluator. The
false premise was corrected in the commit message and is not repeated in code, tests, or docs.

## Why `completed` and not `proposed`

The parent spec `spec-20260604-docs-correction` is `status: "abandoned"`, which invites
`"proposed"`. The work was in fact carried out, and choosing `"proposed"` would have falsified the
record — precisely what this contract's stopCondition forbids. The evidence, each item
independently re-checked by the evaluator:

- `.bober/history.jsonl:271-272` — `plan-created` then `plan-completed` for this spec,
  `sprintCount: 4`, branch `bober/docs-correction-0.16.0`, commit `0a39fa8`.
- All five annotated tags `v0.12.0` … `v0.16.0` exist, and **`v0.16.0` points at `0a39fa8`** — the
  exact commit the history record names.
- Every sprint's own deliverable is on disk today: `CHANGELOG.md:59` (`## [0.16.0]`),
  `README.md:784` (`## Lens Panels`), `COMMANDS.md:2263` (`DEEPSEEK_API_KEY`) and `VISION.md:304`
  (`pipeline.engine`).
- The spec's `abandonedReason` reads *"Superseded 2026-07-14 … Re-scoped into a fresh 0.18.0
  docs/metadata refresh spec"*, matching `history.jsonl:919`'s `spec-superseded` event with reason
  `stale-0.16.0-repo-now-0.18.0`. **Superseded, not never-executed.**

`"passed"` is equally settled semantically and was rejected on a different ground:
`src/mcp/tools/sprint-corpus.test.ts:62-71` pins "the corpus contains zero contracts whose status
is the literal `passed`" as this plan's documented root cause. Writing that word here would leave
these four files one future repair away from falsifying that pin, for nothing `"completed"` does
not already give.

## Notes for maintainers

Two inconsistencies survive this sprint **on purpose**. Both were raised by the generator and the
evaluator; neither is an accident, and neither is a defect this sprint was allowed to fix.

- **The four are now the only `completed` contracts in the corpus without a `completedAt` key.**
  Verified: every other `completed` contract has one. `completedAt` is optional
  (`src/contracts/sprint-contract.ts:201`), so this is schema-legal, and it is the direct
  consequence of nonGoal 2 ("rewriting any other field of those four contracts") — these
  pre-schema-era files never had the key, and adding it would have been inventing a timestamp.
- **The parent spec still reads `abandoned` while its children now read `completed`.** That pairing
  is exactly what the evidence above supports (the sprints ran; the spec was later superseded
  rather than executed to closure), but it is an odd shape to meet cold. Reconciling the spec's
  status is a separate decision about a separate file, out of scope here.

  A future sprint could take both together — backfill `completedAt` and reconcile the spec status —
  since they stem from the same tension. Until then, read them as recorded, not as oversights.

Other things worth knowing:

- **The guard scans the working tree, not the git index.** `readdir` on `.bober/contracts/` picks
  up untracked contracts too (8 of today's 256 are untracked, from an unrelated un-run plan). This
  is what makes sc-2-4 true in the strongest sense — a contract a planner just materialised is
  covered before it is ever committed — but it does mean the test's *"committed contract"* wording
  is approximate.
- **Migrating the status does not make these four files load.** They still fail
  `SprintContractSchema` on the legacy-shape fields, as do 56 others. They remain invisible to
  `listContracts`; what changed is that the corpus no longer contains a word the schema forbids.
- Passed **iteration 1**, all 5 of 5 required criteria. Suite **459 files / 6931 tests passed**, 2
  pre-existing skips; typecheck (both tsconfigs), lint, build green; golden gate **6/6**. The
  evaluator went past the generator's own mutation control and planted a canary contract with
  status `"pending"` into the **real** `.bober/contracts/`, confirmed the guard failed naming it,
  and removed it with no residue. Commit `a5c8531`.
