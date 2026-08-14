# A monotone version the rank-aware join can read, stable under replay

**Contract:** sprint-spec-20260812-terminal-vocabulary-3  ·  **Spec:** spec-20260812-terminal-vocabulary  ·  **Completed:** 2026-08-12

## What this sprint added

`SprintContract` gains one optional field, `version?: number`
(`src/contracts/sprint-contract.ts:213`), and `sprint_exit` writes it on the settled copy
(`src/pge/nodes/sprint-review.ts:212`). Nothing reads it yet — **`src/pge/registry/reducers.ts` is
not in this diff at all** (`git diff --stat` on it is empty). This sprint supplies the field;
sprint 4 switches the `sprintContracts` channel's join to consult it. The value written is
`attempts`, the count of decisive evaluations already computed one line above for `branchStatus`,
chosen because it is the one monotone number at that site that a replay reproduces exactly.

## Public surface

- **`SprintContractSchema.version`** (`src/contracts/sprint-contract.ts:213`) —
  `z.number().int().min(0).optional()`. Declared on the exported `SprintContract` type, so it
  survives `saveContract` → `loadContract`. **Never `.default(...)`** — see below.
- **`sprintExitNode` writes `version: attempts`** (`src/pge/nodes/sprint-review.ts:197-212`) —
  the settled contract handed to the `sprint.exit` effect and pushed onto the `sprintContracts`
  channel now carries the same number `branchStatus` records as `attempts`.

No CLI command, flag, config key or newly exported symbol. The change is a schema field and one
node write.

## Why a `version` field was needed at all — `updatedAt` is a dead tiebreak

`versionRank` (`src/pge/registry/reducers.ts:348-359`) is `replaceIfNewer`'s rank function. It
returns a three-part key compared in order by `rankIsGreater` (`:361-367`):

1. `version` — `0` when the key is missing or non-finite,
2. `updatedAt` — `""` when missing,
3. `canonicalJson(value)`.

Step 2 cannot decide anything in the case that matters. Under the golden harness's fixed clock the
seeded and settled copies of the same contract carry a **byte-identical** `updatedAt`. This is not
an inference — it is readable in the committed fixture: in
`.bober/golden/replay-full-run-evaluation-passes.json` the `plan.materialize` (`proposed`) copy and
the `sprint.exit` (`completed`) copy both read `"updatedAt": "2026-08-05T00:00:00.000Z"`, the same
string as their `createdAt`. So the comparison falls through to step 3, canonical JSON, where
`"completed" < "proposed"` lexically and **the seeded copy wins**.

That is the whole reason a `version` field exists: step 1 is the only step with anything left to
say. `sc-3-4` pins it with both halves — the settled copy wins with `updatedAt` held identical, and
a **counterfactual control** with `version` absent from both copies shows the seeded copy winning
instead, so the ordering is attributable to `version` and not to an accident of `canonicalJson`.

## Where the number comes from, and why a replay reproduces it

```ts
const attempts = Math.max(
  1,
  state.evaluations.filter(
    (entry) => entry.contractId === contract.contractId && entry.verdict !== "skipped",
  ).length,
);
```

`state.evaluations` is an **`appendById`** channel (`src/pge/topology/coding.graph.ts:151`). Its
reducer unions members by intrinsic id (`mergeEntries`, `src/pge/registry/reducers.ts:183`), and a
`SprintVerdict`'s id is `` `${contractId}:${nodeId}:${iteration}` ``
(`src/pge/nodes/sprint-evaluate.ts:125`). A union keyed like that is **commutative and idempotent**:
the resulting set is a function of *which* verdicts exist, never of the order they arrived in, and a
verdict written twice contributes once.

`attempts` is a pure `filter().length` over that set. It therefore inherits the same property — it
depends on which verdicts exist, not on delivery order — and it touches **no clock, no superstep
counter and no spanId**. This is the property that makes the value replay-stable, and it is worth
stating explicitly because "a count over a channel" does not obviously imply it. The order-invariance
of `appendById` itself is pinned separately in `src/pge/registry/reducers.test.ts`.

Two independent confirmations, both by execution rather than argument:

- Two fully separate `runSprint` invocations over the same fixture, in isolated temp roots, both
  wrote `version: 1` (`sc-3-3`; the evaluator re-ran this from its own script rather than trusting
  the test).
- `replay-full-run-evaluation-fails` invokes `sprint_exit` **twice** (callIndex 0 and 1, same
  branchKey, no intervening evaluation) and **both pins read `version: 2`** — the idempotent second
  exit re-derived the same settled value rather than double-counting.

## The anti-default rule — `version` must never gain a `.default(...)`

**This is load-bearing, not stylistic.** A `.default(0)` (or any default) would materialise
`version` on the **seeded** copy too — on every parse, including `OverallStateSchema.parse` at each
commit boundary. Both copies would then rank equal on step 1, the comparison would fall back through
the dead `updatedAt` to `canonicalJson`, and the seeded copy would win again. Sprint 4 would be left
with nothing to break the tie, defeating the entire point of the field.

The rule is pinned by a test that asserts genuine **absence**, not merely `undefined`:

```ts
expect("version" in result.data).toBe(false);
```

(`src/contracts/sprint-contract.test.ts:474`). The evaluator injected a `.default(0)` into a scratch
copy of the schema and watched that test **fail**, then restored it — so the pin is known to bite,
not assumed to.

The same optionality is what keeps all **256** committed contracts valid without a migration.

## Every claim, and the test that fails when it stops being true

| Claim | The test that pins it |
|---|---|
| `version` is optional — a contract without one still parses | `src/contracts/sprint-contract.test.ts:469` |
| `version` is **absent**, never defaulted, on a contract that omits it | same file `:474` — `'version' in result.data === false`; the anti-default guard |
| An explicit `version` is preserved exactly, and `-1` / `1.5` are rejected | same file `:483`, `:491` |
| A declared `version` survives `saveContract` → `loadContract` | same file `:516` |
| **Control:** an *undeclared* key on the same object does **not** survive the same round trip | same file `:538` — the asymmetry that ruled out riding along as an unknown key. `loadContract` returns `SprintContractSchema.safeParse(...).data`, a plain `z.object` in zod's default *strip* mode (no `.strict()`, no `.passthrough()` anywhere on the schema), so an unknown key reaches the file and vanishes on the next read |
| `sprint_exit` writes a `version`, and it is the same number `branchStatus` records as `attempts` | `src/pge/nodes/sprint-evaluate.test.ts:770-771` |
| The written `version` is replay-stable across two independent runs | same file `:792` |
| The settled copy outranks the seeded one under `replaceIfNewer`, **in both merge directions**, with `updatedAt` held identical | same file `:820` |
| **Control:** with `version` absent from both and `updatedAt` still identical, the *seeded* copy wins | same file `:837` — proves the row above is `version` deciding |
| The `sprintContracts` channel *still* keeps the seeded `proposed` copy (the limitation this sprint does not close) | same file `:786-789`, unchanged and still passing |

Suite **6941 passed / 2 pre-existing skips** (+10: 7 in `sprint-contract.test.ts`, which goes
31 → 38 cases, and 3 in `sprint-evaluate.test.ts`). Typecheck (both tsconfigs), lint, build green;
golden gate **6/6**.

## Golden re-capture: 5 of the 6 replay cases, request side only

Five `enforcement: "replay"` cases pinned the `sprint.exit` request before `version` existed and
were re-captured under `GOLDEN_CAPTURE=1`. **12 insertions / 6 deletions across 5 files**, and every
hunk adds exactly one `"version": N` line inside `pinnedResponses[].request.contract`:

| case | pins re-captured |
|---|---|
| `replay-full-run-evaluation-fails` | 2 (`version: 2` on both) |
| `replay-full-run-evaluation-passes` | 1 (`version: 1`) |
| `replay-plan-clarification-round` | 1 |
| `replay-research-reflexions-exhausted` | 1 |
| `replay-research-second-reflexion` | 1 |
| `replay-plan-clarify-rounds-exhausted` | **0 — no `sprint_exit` pin, correctly untouched** |

`expected.artifacts` is **byte-identical in all five**. That is not incidental: it re-confirms P10 —
the settled contract never reaches disk during a replay. The evaluator re-ran `capture.test.ts` with
**no** capture env (9/9) and `git status` showed **zero** golden drift afterwards, so the replay is
genuinely byte-identical rather than a self-rewriting fixture.

## Cross-sprint consequence: the `contracts` conformance divergence gains a fourth field delta

PGE now writes `version`; the imperative `runSprintCycle` does not. `conformance.ts`'s comparison
normalises by stripping a **10-key** `VOLATILE_KEYS` list (`src/orchestrator/workflow/conformance.ts:65-76`)
and `version` is not on it — **nor should it be**; stripping it would hide a real difference between
what the two engines write, which is precisely what that harness exists to find.

So the `contracts` artifact can no longer byte-converge. The field-delta count on `contracts` goes
from three to **four**: `status` (`"passed"` vs `"completed"`), `evaluatorFeedback`,
`generatorNotes`, and now `version`. Sprint 5 closes the `status` one, which leaves `version` as the
**third** of the three that stay open alongside `evaluatorFeedback` and `generatorNotes`. It is
recorded, not papered over: `src/orchestrator/workflow/conformance.engines.test.ts:406-408` asserts
`tsContract.version` undefined and `pgeContract.version` defined, and the prose above it names the
new delta and the sprint that introduced it.

**This does not block sprint 5.** That contract already pre-authorises recording it: `sc-5-2` asks
only that the *status* delta be closed with the others "either closed too or **recorded with a
stated reason**", and its stop condition reads verbatim *"Closing the status delta does not close the
contracts divergence because another delta remains — that is a finding to record, not to force."*
What sprint 5 will **not** achieve is dropping `contracts` from the pinned divergence set in
`conformance.engines.test.ts` — it will still appear there afterwards. The disposition in
`docs/pge-graph.md` was updated in this sprint so that sprint 5's record has a factual base to write
against rather than a stale count.

## Notes for maintainers

- **Do not add a `.default(...)` to `version`.** Repeated here because it is the one change that
  looks harmless and silently destroys the field's purpose. `src/contracts/sprint-contract.test.ts:474`
  will fail if you do; the field's own JSDoc says why.
- **Three committed contracts already carried a top-level `version: 1` before this sprint** —
  `sprint-spec-20260618-fleet-expand-deep-critique-{1,2}.json` and
  `sprint-spec-20260618-fleet-manifest-provenance-1.json`, from the records backfill in commit
  `82bcf4b`. Until this sprint it was an *undeclared* key that `loadContract` stripped; it is now a
  declared field. **No reader sees it today**: all three fail `SprintContractSchema` on the legacy
  `successCriteria` shape plus missing `nonGoals` / `stopConditions` / `definitionOfDone`, so
  `listContracts` silently skips them (sprint 2's finding — 60 of 256 files are invisible this way,
  and a live `listContracts` over the real corpus returns **196 contracts, 0 of them carrying a
  `version`**). If a future sprint repairs those three files' shape, their `version: 1` becomes a
  `versionRank` discriminator with a provenance that has nothing to do with `attempts`. Worth
  knowing before sprint 4 makes the field load-bearing.
- **The `KNOWN LIMITATION` block in `src/pge/nodes/sprint-review.ts` was rewritten, not removed.**
  It used to say a monotone field could not be added; it now says the field exists and the channel's
  join simply does not consult it yet. The assertion underneath it
  (`sprint-evaluate.test.ts:786-789`, that the channel still reports `proposed`) is **unchanged and
  still passing** — closing it is sprint 4's job, and it is what makes sprint 4's change observable.
- **The seeded copy carries no `version` key at all**, not `version: 0`. `versionRank` maps both to
  rank `0`, so the two are equivalent *for ranking*; they are not equivalent for the anti-default
  test, which is what keeps them from converging.
- Passed **iteration 1**, 6 of 6 required criteria, each verified by the evaluator's own execution
  rather than by trusting the sprint's tests. Commits `19ad3d4` (schema + node + tests) and
  `83ceed1` (golden re-capture + conformance prose).
