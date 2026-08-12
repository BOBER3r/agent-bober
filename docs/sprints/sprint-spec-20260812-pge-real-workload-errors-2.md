# A committed workload corpus, and the measurement extended to every channel

**Contract:** sprint-spec-20260812-pge-real-workload-errors-2  ·  **Spec:** spec-20260812-pge-real-workload-errors  ·  **Completed:** 2026-08-12

## What this sprint added

Sprint 1 measured two channels against one real plan. This sprint turns that single
observation into a **committed corpus of real payloads** — 123 entries at
**`.bober/workload/`**, covering all ten channels `.bober/topology/coding.json` declares — and
extends the measurement to the channels real generator and evaluator output flows through.
The number that scopes the rest of the spec is the outcome: measured against this
repository's own real data, **only `spec` (48,097 canonical bytes) and `sprintContracts`
(135,106) exceed the 4,096-byte cap**; the other eight channels are one to two orders of
magnitude below it.

**Nothing is fixed here either.** No cap was raised, `.bober/topology/coding.json` is
byte-for-byte unchanged, and the golden dataset was not touched. Sizing the caps from this
corpus is sprint 3's work — this sprint exists so that sprint 3 sizes them from measurement
rather than from a fixture.

## Public surface

- **`.bober/workload/`** (new committed directory, 123 entries, one JSON file per entry named
  for its own `entryId`) — the corpus. Per channel: `spec` 52, `sprintContracts` 28, `ledger`
  12, `counters` 8, `refs` 7, `evaluations` 6, `messages` 6, `branchStatus` 2, `testAnchors`
  1, `verdict` 1. Per provenance: 66 `file`, 28 `file-group`, 29 `observed`.
- **`byteSize(value: unknown): number`** (`src/pge/runtime/commit.ts:265`) — was
  module-private, now **exported**, with a doc comment naming it as the commit boundary's own
  cap metric (`Buffer.byteLength(canonicalJson(value), "utf8")`). Exported specifically so the
  corpus's maximum is never a second, independently-maintained copy of the number that decides
  every channel cap (sc-2-2). Sprint 1's duplicate copy inside `real-workload.test.ts` was
  deleted in the same commit.
- **`src/pge/golden/workload.ts`** (new, dependency-light, compiles into `dist/`) — the
  *reader*:
  - `WORKLOAD_DIR` (`:49`) — `.bober/workload`, relative to the project root.
  - `WORKLOAD_ENTRY_FILE_EXTENSION` (`:52`) — `.json`.
  - `WorkloadProvenanceSchema` / `WorkloadProvenance` (`:65`) — a discriminated union:
    `{kind:"file", path}`, `{kind:"file-group", paths}`, `{kind:"observed", source}`.
  - `WorkloadEntrySchema` / `WorkloadEntry` (`:72`) — `{ entryId, channel, provenance, value }`,
    `.strict()`.
  - `WorkloadCorpus` (`:84`) — `{ dir, files, entries, errors }`.
  - `loadWorkloadCorpus(dir)` (`:103`) — reads the directory (never a manifest), and reports
    unreadable / non-JSON / schema-violating / misnamed files as `errors` rather than throwing.
    An entry whose `entryId` and filename disagree is an error, because such an entry cannot be
    found from a failure message.
  - `maxBytesPerChannel(corpus)` (`:179`) — the corpus maximum per channel, computed with the
    **imported** `byteSize`. A channel with no entry is **absent** from the result, not `0`:
    "measured and found small" is a different fact from "not measured at all".
- **`src/pge/golden/__fixtures__/workload-build.ts`** (new) — the *builder*, kept out of the
  reader on purpose. `buildWorkloadCorpus()` (`:391`) returns `BuildReport` (`:61`)
  `{ written, skippedSpecs, skippedContracts }`.
- **`BUILD_WORKLOAD_CORPUS=1`** (new env var) — regenerating the corpus is a deliberate act
  with a visible `git diff`, the same shape as `capture.ts` and `MEASURE_REAL_WORKLOAD=1`:
  `BUILD_WORKLOAD_CORPUS=1 npx vitest run src/pge/golden/workload.test.ts`. Unset, the test
  only reads and compares; it never skips.
- **`corpusHeadroom`** (new field on `.bober/topology/measurements/real-workload.json`) —
  `{ corpusMaxBytes, declaredLimit, wouldReject }` for `messages` (1,292), `evaluations`
  (1,067) and `refs` (283), all `wouldReject: false`. `declaredLimit` is read off the same
  `channelLimits` the measurement already records, so `wouldReject` is exactly the comparison
  the commit boundary performs.

### The measured maxima (canonical bytes, against a declared limit of 4,096 everywhere)

| channel | corpus maximum | over the cap? |
| --- | --- | --- |
| `sprintContracts` | 135,106 | **yes — 33×** |
| `spec` | 48,097 | **yes — 11×** |
| `messages` | 1,292 | no |
| `evaluations` | 1,067 | no |
| `refs` | 283 | no |
| `ledger` | 221 | no |
| `testAnchors` | 114 | no |
| `branchStatus` | 102 | no |
| `counters` | 64 | no |
| `verdict` | 8 | no |

The `spec` maximum is **48,097**, not sprint 1's 29,214: sprint 1 measured this repository's
own PGE spec, while the corpus holds every spec that parses and the largest of those is bigger.

## How to use / how it fits

Read `.bober/workload/` and the table above before touching a cap. Sprint 3 sizes the caps
from these numbers; sprint 4 regenerates sprint 1's measurement so the fix shows up as the
disappearance of the very rejections that found the defect. The narrative version, with the
provenance rules and the regeneration commands, is
[docs/pge-graph.md → A committed workload corpus](../pge-graph.md#a-committed-workload-corpus).

Regenerating both artifacts, in this order (the second reads the corpus the first writes):

```
BUILD_WORKLOAD_CORPUS=1 npx vitest run src/pge/golden/workload.test.ts
MEASURE_REAL_WORKLOAD=1 npx vitest run src/pge/engine/real-workload.test.ts
```

Committing the corpus, rather than re-reading `.bober/specs/` and `.bober/contracts/` at test
time, is the point of it: a live re-read would let sprint 3's cap drift silently the next time
an unrelated spec file is edited, which is precisely the "a fixture can never again be the only
evidence" property the corpus exists to hold.

## Notes for maintainers

- **The corpus lives at `.bober/workload/`, never `.bober/golden/`.** `src/pge/golden/runner.ts`
  treats every file in the golden directory as one case and reports any non-`.json` entry as a
  stray, feeding the blocking CI golden gate; a subdirectory there also causes `EISDIR` in the
  gate, executor, coverage and capture tests. The two directories are enforced by disjoint
  gates and must stay disjoint.
- **Four channels had no committed payload anywhere in the repository** — `refs`, `counters`,
  `branchStatus`, `ledger`. They were **observed, not invented**: a real `PgeEngine` run over
  the conformance collaborator set with `RunContext.commit` wrapped by a spy recording every
  `ChannelUpdate` the interpreter actually committed. `GraphRunResult` carries only the merged
  final state, so the spy is the only way to recover a genuine per-write payload. Their
  provenance is `{kind:"observed", source}`, which cannot be mistaken for a committed-file
  payload. The sprint's stopCondition required exactly this: record the fact rather than invent
  a payload.
- **60 of 250 committed contracts and 1 of 53 committed specs do not parse** under their own
  schema (an earlier contract/spec era). The builder uses `safeParse` and **skips** them by
  name via `BuildReport`; it never parses-and-throws. Three further contract paths a spec
  references do not exist at all. These skips are deliberate — a corpus build that crashed on
  legacy files would simply not exist.
- **Regeneration is only partly pinned, and the asymmetry matters.** The `messages` and
  `evaluations` entries are a `representativeSample(..., 6)` drawn from a **live `readdir`** of
  `.bober/handoffs/` and `.bober/eval-results/` at build time, not from a pinned file set. It
  is deterministic given a fixed directory listing, but the listing is not pinned to a commit,
  so regenerating after new run artifacts accumulate **silently swaps committed entries** — the
  evaluator demonstrated this concretely, regenerating after this sprint's own gen-report and
  eval-result files landed and watching two committed `messages` entries get replaced (it
  reverted its own regeneration). `spec` and `sprintContracts` do **not** have this property:
  they take every parsing file and their `entryId`s are keyed to committed filenames, so a new
  spec adds an entry rather than displacing one. Expect an unexpectedly large `messages` /
  `evaluations` diff on any regeneration, and check it is a sample shift rather than a real
  change before committing it.
- **The sample always includes the genuine maximum**, by construction — nonGoal 2 forbade
  trimming the corpus to make a number look better, and a sample that dropped the largest real
  payload would have done exactly that.
- **`workload.ts` must stay dependency-light.** It compiles into `dist/` (only test files are
  excluded from `tsconfig.json`), so it must never import `src/pge/registry/index.ts` — the
  composition root deliberately stays out of every load-time graph — and must never drive a
  `PgeEngine`. All of that lives in the `__fixtures__/` builder, which is test-only.
- **The equivalence between the corpus metric and the boundary is tested, not asserted.** One
  test feeds the corpus's largest `messages` payload to a **real** `CommitBoundary` and asserts
  `rejected[0].bytes` equals the corpus number; the evaluator additionally reimplemented
  canonical-JSON byte length from scratch and reproduced `spec=48097` /
  `sprintContracts=135106` / `messages=1292` independently.
- **sc-2-4 is proven to bite**: a test copies the corpus to a temp directory, deletes every
  entry for one channel and asserts the completeness check reports it missing. The committed
  corpus and the committed topology artifact are never mutated by the suite.
- Suite 6860 → **6871** (+11), zero regressions; typecheck, typecheck:tests, lint and build all
  green; all three blocking PGE gates (`pge docs --check`, `pge validate --mode full`,
  `pge audit-state`) green, and `audit-state` reporting *unchanged* corroborates that no cap was
  raised. Commit `93469d8`.
