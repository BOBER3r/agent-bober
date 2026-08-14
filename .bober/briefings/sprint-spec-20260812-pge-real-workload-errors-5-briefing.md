# Sprint Briefing: PipelineResult gains an error channel, layered in the engine

**Contract:** sprint-spec-20260812-pge-real-workload-errors-5
**Generated:** 2026-08-12T11:05:00Z
**Repo HEAD:** 5ad1d28 (branch `bober/pge-graph-engineering`)

> **READ SECTION 7 FIRST.** A blocking, empirically measured consequence was found that the
> contract's nonGoal 4 does not account for. It is not optional and it is not a judgement call.

> **Contract line numbers are STALE.** Sprint 4 inserted ~60 lines into `src/pge/engine/pge-engine.ts`
> ("The superstep ceiling" section, lines 139-200). Everything the contract cites as `461-489` now
> lives at **`512-548`**. Every citation in THIS briefing was re-read at HEAD and is current.

---

## 1. Target Files

### `src/orchestrator/pipeline.ts` (modify)

**Relevant section — lines 68-84 (the whole surface being revised):**
```ts
// ── Types ──────────────────────────────────────────────────────────

export interface PipelineResult {
  success: boolean;
  spec: PlanSpec;
  completedSprints: SprintContract[];
  failedSprints: SprintContract[];
  totalCost?: number;
  duration: number;
  /**
   * When the planner refuses to fully decompose the request (ambiguityScore
   * over threshold or open clarification questions), the pipeline stops
   * before sprint execution and sets this flag. Callers should surface
   * `spec.clarificationQuestions` to the user in this case.
   */
  needsClarification?: boolean;
}
```

`PipelineFailure` belongs **here**, immediately above `PipelineResult` — see §4 for why this
is the only cycle-free, lint-clean home.

**Imported by (type-only unless noted):** `src/orchestrator/finalize.ts:45`,
`src/orchestrator/workflow/flusher.ts:22`, `.../engine.ts:2`, `.../ts-engine.ts:3` (also imports
`runTsPipeline` as a **value**), `.../workflow-engine.ts:4`, `.../conformance.ts:15`,
`src/orchestrator/worktree.ts:15` (value + type), `src/mcp/run-manager.ts:15`,
`src/cli/commands/trace.ts:8`, `src/medical/engine.ts:21`, `src/pge/engine/pge-engine.ts:6`,
`src/pge/runtime/commit.ts:7`, `src/pge/runtime/replay.ts:17`, `src/index.ts:95` (public re-export).

**Test file:** `src/orchestrator/pipeline.test.ts` (exists). The key-order pin is in
`src/orchestrator/finalize.test.ts` — see §2.

---

### `src/pge/engine/pge-engine.ts` (modify — two independent changes)

**(a) The discard to remove — lines 512-548 verbatim:**
```ts
    // ── Finalize through the single owner ────────────────────────────
    if (result.status === "interrupted") {
      throw new PgeRunNotCompletedError(
        runId,
        result.status,
        `paused at superstep ${String(result.supersteps)} for checkpoint '${result.pending.checkpointId}'`,
      );
    }

    // `completed` and `aborted` are both OVER, so both finalize. ...
    //
    // ── RECORDED LIMITATION: `GraphRunResult.verdict` and `.failures` do not reach here ──
    //
    // The interpreter computes its own richer verdict (`verdictFrom`, `runtime/interpreter.ts`)
    // which DOES account for task failures, and it is discarded at this boundary. ...
    // Not corrected here, and deliberately: `PipelineResult` has no error channel, and
    // nonGoal 3 of this sprint forbids adding a field to it. ...
    // it needs a `PipelineResult` revision, which is a spec-level change.
    return commit.finalize(result.state, {
      runId,
      projectRoot,
      config,
      superstep: result.supersteps,
      startedAtMs,
    });
```
Note the `interrupted` guard at 513-519 runs FIRST, so at line 542 `result` is narrowed to
`completed | aborted` — **both variants declare `readonly failures: readonly TaskFailure[]`**
(`src/pge/runtime/interpreter.ts:336` and `:346`). No further narrowing is needed.

**(b) The `supersepsForMeasuredCost` typo — declaration at line 184:**
```ts
export function supersepsForMeasuredCost(measuredSupersteps: number): number {
  let cap = 1;
  while (cap < measuredSupersteps * SUPERSTEP_HEADROOM_FACTOR) cap *= 2;
  return Math.max(cap, DEFAULT_MAX_SUPERSTEPS);
}
```
Complete occurrence list (verified by `grep -rn` over `src docs scripts .bober`):

| File | Line | Kind |
|---|---|---|
| `src/pge/engine/pge-engine.ts` | 184 | declaration (`export function`) |
| `src/pge/engine/pge-engine.ts` | 193 | jsdoc prose on `PGE_ENGINE_MAX_SUPERSTEPS` |
| `src/pge/engine/pge-engine.ts` | 200 | call site (the shipped constant) |
| `src/pge/engine/real-workload.test.ts` | 86 | named import |
| `src/pge/engine/real-workload.test.ts` | 694, 701, 705, 706 | 4 call sites in the sc-4-5 pin |
| `docs/pge-graph.md` | 779, 807 | live docs prose |
| `docs/sprints/sprint-…-4.md` | 14, 71, 105, 128 | **HISTORICAL RECORD — do NOT edit** |
| `docs/sprints/README.md` | 2570 | **HISTORICAL RECORD — do NOT edit** |

The contract says "both call sites"; there are in fact **five** runtime call sites across two
files plus two live-doc mentions. Rename all of them. `docs/sprints/**` records what shipped in
sprint 4 (including a bullet that explicitly records the misspelling as a known defect) — rewriting
history there would falsify the record.

---

### `src/pge/engine/pge-engine.test.ts` (modify) — sc-5-4's home

**⚠ This file mocks the whole `pipeline.js` module** (`src/pge/engine/pge-engine.test.ts:35-37`):
```ts
vi.mock("../../orchestrator/pipeline.js", () => ({
  runTsPipeline: vi.fn(),
}));
```
Consequence: **`PipelineFailure` must be a pure TYPE** (`import type`). If you export any runtime
value from `pipeline.ts` (a mapper function, a class, a const) and import it here, it will be
`undefined` at runtime and this file's every test will break. See §9.

---

### `src/pge/topology/coding.graph.ts` (modify — comments only)

Line 108, inside the `//`-comment block at 103-112 that precedes `graphVersion`:
```ts
  // `sprintContracts` are raised to `capForCorpusMax` of their committed workload-corpus
  // maximum (`src/pge/golden/workload.ts`, `.bober/workload/`, 123 real payloads) — see
```
Line 191, inside the `//`-comment block at 187-193 inside the `spec` channel object:
```ts
      // 1.3.0: capForCorpusMax(48_097) = 131_072 — the committed workload corpus's
      // largest spec entry (52 committed PlanSpecs that parse) is 48,097 canonical bytes;
```
`123` → `120`, `52` → `50`. **Both are `//` line comments, not `doc:` string values.** See §9 for
the checksum proof.

---

### `docs/pge-graph.md` (modify — sc-5-6)

Two sites, both **outside** every `<!-- pge:nodes -->` region (markers are at lines 135-161,
165-175, 179-196 only — `grep -n "pge:nodes" docs/pge-graph.md`):

1. **The sprint-13 recorded limitation**, lines 816-828 — the bullet beginning
   "**Neither the `commit` refusal nor the interpreter's own richer verdict is in what the caller
   gets back.**", specifically line 821-822: *"unaffected by this sprint's nonGoals (adding an error
   channel to `PipelineResult` is a later sprint's, not this one's)"*.
2. **Engine migration disposition**, lines 948-987 — line 967: *"The run nevertheless reports
   `success: true`, because `PipelineResult` has no error channel."* and lines 982-984:
   *"Flipping the default … requires … plus an error channel on `PipelineResult` so a fail-closed
   refusal cannot be reported as success."*

**REPLACE the claims; do not append a contradicting paragraph beside them** (the evaluator checks
exactly this). The Option-A nuance to preserve: the channel now EXISTS and carries the refusal;
`success` still follows `deriveRunSuccess` by deliberate D3 decision.

---

## 2. The frozen key-order test — the exact answer to sc-5-2/sc-5-3

**Source:** `src/orchestrator/finalize.test.ts:205-263`
```ts
describe("finalizePipelineRun — frozen PipelineResult shape (sc-4-6)", () => {
  const PRE_EXTRACTION_KEYS = [
    "success",
    "spec",
    "completedSprints",
    "failedSprints",
    "duration",
  ];

  it("returns exactly the pre-extraction key set, in the pre-extraction order", async () => {
    ...
    expect(Object.keys(result)).toEqual(PRE_EXTRACTION_KEYS);
```
```ts
  it("does not add a needsClarification key (that field is workflow-only)", async () => {
    ...
    expect("needsClarification" in result).toBe(false);
```

**What adding an optional `errors` key inside `finalizePipelineRun` would do:** `Object.keys()`
enumerates OWN keys in insertion order and `toEqual` on arrays is exact — so the moment
`finalize.ts:262-268` returns a sixth key, this test fails with
`expected [ 'success', …, 'duration', 'errors' ] to deeply equal [ 'success', …, 'duration' ]`.
A conditional spread inside `finalizePipelineRun` would ALSO fail whenever the condition held,
which is worse: an intermittently green pin.

**Therefore: `errors` MAY NOT be added inside `finalizePipelineRun`. It must be layered after.**
`src/orchestrator/finalize.ts:262-268` stays byte-for-byte unchanged:
```ts
  return {
    success,
    spec,
    completedSprints,
    failedSprints,
    duration,
  };
```
sc-5-3 is satisfied by NOT TOUCHING `finalize.ts` or `finalize.test.ts` at all.

---

## 3. The layering site — the pattern to mirror, and where the spread goes

**Source (the pattern):** `src/orchestrator/workflow/flusher.ts:106-127`
```ts
    // ── Terminal side effects + PipelineResult (single owner) ───────────
    //
    // success/duration are derived inside finalizePipelineRun from the SAME
    // formula the TS engine uses, so the two engines cannot disagree.
    // needsClarification is workflow-only and is layered on afterwards; it was
    // never part of the TS engine's terminal result.

    const finalized = await finalizePipelineRun({
      projectRoot, runId, config,
      spec: result.spec,
      completedSprints,
      failedSprints,
      startedAtMs: startTime,
    });

    return {
      ...finalized,
      needsClarification: result.needsClarification,
    };
```
**Rule:** call the single owner, `await` it into a local, then return a spread with the
engine-specific field appended. The shared fields are produced in exactly one place, so the two
engines cannot disagree about them.

**Where the spread goes in `PgeEngine.run`:** replace the bare `return commit.finalize(...)` at
`src/pge/engine/pge-engine.ts:542-548` with an `await` into a local + a spread. `commit.finalize`
is the pge engine's call into `finalizePipelineRun` (`src/pge/runtime/commit.ts:486-494` — "THE
THIRD CALLER of finalizePipelineRun"), so this site is the exact analogue of flusher.ts:113.

**One deviation from the flusher, and it is required:** the flusher spreads
`needsClarification` **unconditionally** (the key is always present, sometimes `undefined`).
`errors` must be spread **CONDITIONALLY**, because:
- sc-5-5 demands `"errors" in result === false` on a TsPipelineEngine run, and the evaluator
  will assert `in`, not `=== undefined`;
- an always-present `errors` key breaks **five** golden expectations instead of four (§7);
- `Object.keys()` on a pge result with no failures should stay the frozen five.

---

## 4. `TaskFailure` → `PipelineFailure`, and where the type lives

**Source:** `src/pge/runtime/interpreter.ts:321-327` (exact, verified at HEAD):
```ts
export interface TaskFailure {
  readonly nodeId: string;
  readonly branchKey: string | null;
  readonly superstep: number;
  readonly errorClass: string;
  readonly message: string;
}
```
sc-5-1's "1:1 minus `superstep`" therefore yields exactly:
`{ nodeId: string; branchKey: string | null; errorClass: string; message: string }`, all `readonly`.
Keep `branchKey`'s `| null` — it is `null` for the root-level `commit` node (measured, §6).

**Where to declare it: `src/orchestrator/pipeline.ts`, immediately above `PipelineResult`.**

Evidence there is no import cycle and no lint boundary:
- `src/pge/engine/pge-engine.ts:6` ALREADY does `import type { PipelineResult } from "../../orchestrator/pipeline.js";`, and `src/pge/runtime/commit.ts:7` does the same. Adding
  `PipelineFailure` to that existing `import type` line adds zero new edges.
- A runtime cycle DOES exist (`pipeline.ts` → `workflow/selector.ts` → `pge-engine.ts` →
  `ts-engine.ts` → `pipeline.ts`; documented at `src/pge/engine/pge-engine.test.ts:29-34`).
  `import type` is erased by `isolatedModules`/`verbatimModuleSyntax`, so a TYPE import is
  cycle-free. A VALUE export would not be. **Declare a type; export no runtime helper from
  `pipeline.ts`.**
- **ESLint boundaries (`eslint.config.js`) — full audit.** There are exactly four
  `no-restricted-imports` blocks: `src/telemetry/**` (:46), `src/medical/**` (:75),
  `src/pge/topology/**` + `src/contracts/topology.ts` (:116), `src/pge/nodes/**` (:266).
  - `src/pge/topology/**` and `src/contracts/topology.ts` **may not import `**/orchestrator/**`**
    (`eslint.config.js:145-155`) — so `PipelineFailure` must NOT be put in
    `src/contracts/topology.ts`, and no topology file may reference it.
  - `src/pge/nodes/**` (:269-296) restricts only process spawners (`child_process`, `execa`,
    `worker_threads`, `vm`, `cluster`, `module`) plus `src/graph/**` / `src/discovery/**`.
    **Nothing restricts orchestrator↔pge imports in either direction.**
  - `src/pge/engine/**`, `src/pge/runtime/**` have no boundary block at all.
- Global rule in force: `consistent-type-imports` (`.bober/principles.md`, "Use `type` imports").

---

## 5. Every production consumer of `PipelineResult`, and how it reads the result

`grep -rn "PipelineResult" src --include="*.ts" | grep -v test` + follow-through on each.

| Consumer | file:line | How it reads the result | Breaks on a new optional key? |
|---|---|---|---|
| `bober run` CLI | `src/cli/commands/run.ts:181-242` | named property reads: `.success`, `.duration`, `.spec.title`, `.spec.features`, `.completedSprints`, `.failedSprints`, `.totalCost` | No |
| MCP run manager | `src/mcp/run-manager.ts:203-221` | named reads; builds `s.result` as an explicit 4-key literal (`success`, `completedSprints`, `failedSprints`, `duration`) | No — and `runState` conformance is unchanged because the literal is explicit |
| Worktree runner | `src/orchestrator/worktree.ts:152,160` | reads `.success` only | No |
| `RunResultFlusher.flush` | `src/orchestrator/workflow/flusher.ts:123-126` | **SPREADS** `...finalized` and appends `needsClarification` | No (spread is key-count-agnostic) |
| `CommitBoundary.finalize` | `src/pge/runtime/commit.ts:443,486-494` | returns `finalizePipelineRun(...)` unchanged | No |
| `TsPipelineEngine.run` | `src/orchestrator/workflow/ts-engine.ts:16-24` | returns `runTsPipeline(...)` unchanged | No — this is why sc-5-5 is free |
| Checkpoint artifact renderer | `src/orchestrator/checkpoints/renderers/pipeline-summary.ts:19-27,44-51` | optional-property reads on a structurally typed `PipelineSummaryArtifact` | No |
| Checkpoint site doc | `src/orchestrator/checkpoints/sites.ts:75` | a documentation STRING listing the shape | No (cosmetic; may be left) |
| Replay driver | `src/pge/runtime/replay.ts:578-590,634-660` | passes the value straight into the conformance harness | No — both sides symmetric |
| `pge trace replay` CLI | `src/cli/commands/trace.ts:92,139-149` | returns it; never reads a field | No |
| Medical engine | `src/medical/engine.ts:239-247, 288, 326, 429-436` | builds 5-key object literals cast `as PipelineResult & { medicalAnswer }` | No — an OPTIONAL field keeps the cast valid |
| Public API | `src/index.ts:93-96` | re-export | No |
| **Conformance harness** | `src/orchestrator/workflow/conformance.ts:436-452` | **ENUMERATES KEYS**: `normalize()` (`:83-100`) walks `Object.keys(obj).sort()` and canonicalises the WHOLE object | **YES — this is the one that breaks. See §7.** |

**The only consumer that enumerates keys is `normalize` in `conformance.ts:96`**, and everything
that flows through it: `collectRunArtifacts` (`:485-497`), the conformance harness, the replay
comparator, **and the golden dataset's committed expectations**.

**Test-side key-counters** (`grep -rn "Object.keys(result" src --include="*.test.ts"`): exactly one
touches `PipelineResult` — `src/orchestrator/finalize.test.ts:243`. It stays green because §2.

---

## 6. sc-5-4's fixture — MEASURED, and cheaper than real-workload.test.ts

`src/pge/engine/real-workload.test.ts:465-476` does produce this (it asserts
`measurement.failures?.[0]?.nodeId === "commit"` / `errorClass === "FailClosed"`), but it drives the
real 29 KB spec + 14 contracts and its tests carry `120_000` ms timeouts.

**The cheapest fixture is `wholeGraphBindings` over the committed artifact — 45 ms.** I ran it at
HEAD against `dist/` and captured the actual output:

```
elapsed_ms 45
resultKeys ['success','spec','completedSprints','failedSprints','duration']
success    true
failures   [ { "nodeId": "commit", "branchKey": null, "superstep": 37,
               "errorClass": "FailClosed",
               "message": "FAIL_CLOSED: node \"commit\" declares effects (git) and there is no
                           recorded approval for checkpoint \"end-of-pipeline\". The node was not executed." } ]
verdict "failed"  status "completed"  supersteps 39
```

The recipe (mirrors `src/pge/engine/whole-graph.test.ts:47-66`):
```ts
const projectRoot = await seededRoot();            // mkdtemp + seedCommittedArtifact(dir)
const result = await new PgeEngine({
  graphId: CODING_GRAPH_ID,
  registries: async (input) => {
    const { codingRegistries } = await import("../registry/index.js");
    return codingRegistries(input.spec, wholeGraphBindings(input));
  },
}).run("…", projectRoot, conformanceConfig(), { runId: "run-…" });
```
Fixture exports: `src/pge/engine/__fixtures__/whole-graph.ts` — `CODING_GRAPH_ID` (:73),
`seedCommittedArtifact` (:76), `wholeGraphBindings` (:321), `conformanceConfig` (:420).
Assert `result.errors?.[0]?.nodeId === "commit"` and `errors[0].errorClass === "FailClosed"`
(the constant is `FAIL_CLOSED_ERROR_CLASS` at `src/pge/runtime/interpreter.ts:392`).

The `errors`-producing code path: `src/pge/runtime/interpreter.ts:1183-1200` closes the span
`failClosed: true` and pushes the `TaskFailure` in the same branch, so a FailClosed span and a
TaskFailure are one event.

---

## 7. Impact Analysis — a BLOCKING, MEASURED consequence the contract does not account for

### 7.1 The finding

Four of the five `enforcement: "replay"` golden cases pin `expected.artifacts.pipelineResult` and
run through `PgeEngine.run` over the **real committed coding artifact**, where `commit` is
FAIL_CLOSED-refused. Adding `errors` changes the canonical bytes of that pinned artifact.

**Measured at HEAD (I executed all five cases through `dist/pge/golden/executor.js`):**

| # | caseId | ms | baseline diffs | FailClosed spans in trace | diffs WITH `errors` |
|---|---|---|---|---|---|
| 0 | `replay-full-run-evaluation-fails` | 56 | 0 | **0** | **0** (unaffected) |
| 1 | `replay-full-run-evaluation-passes` | 24 | 0 | 1 (`nodeId:"commit"`) | **1** — `pipelineResult[0]` |
| 2 | `replay-plan-clarification-round` | 21 | 0 | 1 | **1** — `pipelineResult[0]` |
| 3 | `replay-research-reflexions-exhausted` | 21 | 0 | 1 | **1** — `pipelineResult[0]` |
| 4 | `replay-research-second-reflexion` | 17 | 0 | 1 | **1** — `pipelineResult[0]` |

Produced key set today is `["completedSprints","failedSprints","spec","success"]` (`duration` and
`runId` are stripped by `VOLATILE_KEYS`, `conformance.ts:63-74`; keys are sorted by
`normalize`, `:96`). It becomes five keys on cases 1-4.

**Why:** `compareGoldenArtifacts` (`src/pge/golden/runner.ts:141-168`) compares
`canonicalMultiset` bytes element-by-element. `errors` is not in `VOLATILE_KEYS`, so `normalize`
keeps it.

### 7.2 What actually goes red

- **`src/pge/golden/executor.test.ts:61-72`** runs replay cases **0,1,2,3** against the real engine
  inside `npm test` and asserts `compareGoldenArtifacts(...) === []`. **3 test failures** (1,2,3).
  This is part of `npm test`, i.e. sc-5-7.
- **`.github/workflows/ci.yml:103-106`** — `GOLDEN_PASS_THRESHOLD: "80"`,
  `node scripts/run-golden-regression.mjs`, all five cases. Pass rate becomes **1/5 = 20 %**.
  The gate is `passed * 100 > threshold * total` (`src/pge/golden/runner.ts:313`) → **fails**.

### 7.3 What does NOT break (verified, so you do not chase ghosts)

- **`src/orchestrator/workflow/conformance.engines.test.ts:302-309`** — the divergence set stays
  exactly `["audits","contracts","history","pipelineResult"]`. `pipelineResult` is ALREADY in the
  set; the harness emits at most one `ConformanceDiff` per field (`FIELD_SPECS` entry at
  `conformance.ts:417-421`, `identityOf: () => "pipelineResult"`, fixed non-empty
  `path: "<PipelineEngine.run return value>"`), and the assertion is over
  `new Set(report.diffs.map(d => d.field))`. **No fifth field appears; no field disappears.**
  `expect(report.equivalent).toBe(false)` still holds.
  The detail test at `:408-419` asserts only `completedSprints.map(c => c.status)` and
  `pgeResult?.failedSprints` — neither moves. **This is NOT the stop condition firing.**
- **`src/orchestrator/workflow/oracle-retention.test.ts:156-167`** — it only greps the
  conformance test's SOURCE TEXT for `report.equivalent`, the literal
  `expect(report.equivalent).toBe(false)`, and the four field names. Unaffected, provided you do
  not edit `conformance.engines.test.ts`.
- **`src/pge/golden/coverage.test.ts:115-140`** — reads only span `nodeId`s from traces. Unaffected.
- **`src/pge/runtime/replay.test.ts:537,586,640`** — supplies `recordedResult` from a fixture-graph
  run, symmetric on both sides. Unaffected.
- **The two integrity cases whose prose the change falsifies** —
  `.bober/golden/pipeline-result-reports-success-with-no-error-channel.json` and
  `commit-refused-fail-closed-under-noop-gate.json` — are `enforcement: "integrity"`, are **never
  executed**, and the dataset check only validates node ids / effect names against the artifact.
  They go stale but **do not go red**. Sprint 8 re-authors them (feat-5 AC2).
- **`normalize`'s `VOLATILE_KEYS`** — `conformance.ts:41-62` documents an explicitly high bar for
  adding a key. **Adding `errors` to `VOLATILE_KEYS` to make this go away is forbidden** and would
  be a papering-over the harness exists to prevent.

### 7.4 The decision you must take and REPORT

There is **no green implementation of sc-5-1..sc-5-4 that leaves `.bober/golden/*.json`
untouched.** sc-5-7 ("full suite … green") and nonGoal 4 ("Re-capturing golden cases — that is
sprint 8") are in direct conflict, and the conflict is a planning defect, not an implementation
choice. Recommended course:

1. Make the **minimal surgical expectation edit**: add the `errors` array to
   `expected.artifacts.pipelineResult[0]` in the **four** cases 1-4 (NOT a `GOLDEN_CAPTURE=1`
   re-capture, which is what sprint 8 owns and which would rewrite every field of all five cases).
   Case 0 (`replay-full-run-evaluation-fails`) must be left **untouched** — it has no failure and
   gains no key; touching it would be the mistake.
2. **Report the nonGoal-4 deviation explicitly** in your completion notes with this measurement, so
   sprint 8's re-capture diff is read against a known-changed baseline.
3. If you judge that you may not touch `.bober/golden/` at all, then **STOP and report** under
   contract stop condition 1, citing §7.1's table. Do not weaken the gate, do not add `errors` to
   `VOLATILE_KEYS`, do not lower `GOLDEN_PASS_THRESHOLD`, and do not relabel a replay case
   (`GOLDEN_MIN_REPLAY_CASES = 5` at `src/pge/golden/case-schema.ts:127` has zero slack).

### 7.5 Regression checks (concrete, runnable)

1. `npx vitest run src/orchestrator/finalize.test.ts` — the key-order pin, unmodified.
2. `npx vitest run src/orchestrator/workflow/conformance.engines.test.ts` — divergence set still
   the four fields, `equivalent: false`.
3. `npx vitest run src/orchestrator/workflow/oracle-retention.test.ts`
4. `npx vitest run src/pge/golden/executor.test.ts` — the §7 blast radius.
5. `npx vitest run src/pge/engine/pge-engine.test.ts src/pge/engine/whole-graph.test.ts src/pge/engine/real-workload.test.ts`
6. `node dist/cli/index.js pge dump --check` **after `npm run build`** — must report unchanged.
   Baseline checksum at HEAD, measured:
   `sha256:e4909da6ef351939e507c320741e6e669d3268eaca0b76fe623a9aa3359b45a5`, `graphVersion 1.3.0`.
7. `node dist/cli/index.js pge docs --check` — after the `docs/pge-graph.md` rewrite.
8. `node dist/cli/index.js pge audit-state && git diff --exit-code .bober/topology/`
9. `npm run typecheck && npm run typecheck:tests && npm run lint && npm run build && npx vitest run`

---

## 8. Implementation Sequence

1. **`src/orchestrator/pipeline.ts`** — declare `export interface PipelineFailure` (4 readonly
   fields, §4) above `PipelineResult`; add `errors?: readonly PipelineFailure[];` to
   `PipelineResult` with a doc comment stating Option-A semantics (D3: `success` keeps
   `deriveRunSuccess`; callers treat a non-empty `errors` as failure).
   *Verify:* `npm run typecheck` — every consumer in §5 still compiles untouched.
2. **`src/orchestrator/finalize.ts` / `finalize.test.ts`** — **DO NOT TOUCH.** Confirm with
   `git diff --stat src/orchestrator/finalize*`.
3. **`src/pge/engine/pge-engine.ts` (a)** — rewrite the RECORDED-LIMITATION comment at 527-541 to
   describe what now happens, `await commit.finalize(...)` into a local, and return a conditional
   spread layering `errors` mapped from `result.failures` (drop `superstep`). Add `import type { PipelineFailure }` to the existing line 6 import.
   *Verify:* `npx vitest run src/pge/engine/` and `npm run lint` (`consistent-type-imports`).
4. **`src/pge/engine/pge-engine.ts` (b)** — rename `supersepsForMeasuredCost` →
   `superstepsForMeasuredCost` at :184, :193, :200; update `src/pge/engine/real-workload.test.ts`
   :86, :694, :701, :705, :706; update `docs/pge-graph.md` :779, :807. Leave `docs/sprints/**`.
   *Verify:* `grep -rn supersepsForMeasuredCost src docs` returns only `docs/sprints/**` and
   `.bober/contracts|handoffs`.
5. **`src/pge/topology/coding.graph.ts`** — comments at :108 (`123`→`120`) and :191 (`52`→`50`).
   *Verify:* `npm run build && node dist/cli/index.js pge dump --check` reports unchanged and the
   checksum is still `sha256:e4909…45a5`.
6. **Tests** — sc-5-4 in `src/pge/engine/pge-engine.test.ts` (§6 recipe); sc-5-5 asserting
   `expect("errors" in tsResult).toBe(false)` for a `TsPipelineEngine` run AND that both engines'
   `success` still comes from `deriveRunSuccess`; sc-5-1 asserting the 1:1 field mapping and the
   ABSENCE of `superstep`; sc-5-2 asserting `Object.keys(await finalizePipelineRun(...))` is still
   the frozen five while the pge result carries `errors`.
   *Verify:* each new test fails when the claim is removed (mutate once, revert).
7. **`docs/pge-graph.md`** — rewrite the two sites in §1. Do not add backticked identifiers inside
   any `<!-- pge:nodes -->` region.
   *Verify:* `node dist/cli/index.js pge docs --check`.
8. **§7 decision** — the four golden expectations, or STOP-and-report.
   *Verify:* `npx vitest run src/pge/golden/` and `node scripts/run-golden-regression.mjs`.
9. **Full verification** — `npm run typecheck && npm run typecheck:tests && npm run lint &&
   npm run build && npx vitest run`.

---

## 9. Pitfalls & Warnings

- **The comment edits CANNOT move the artifact checksum — proven, not assumed.**
  `checksumTopology` (`src/pge/topology/canonical.ts:86-89`) hashes `canonicalize(spec)`, and
  `canonicalize` (`:80-83`) is `JSON.stringify(canonicalValue(rest))` over the **runtime object
  value**. `canonicalValue` (`:57-71`) walks `Object.keys(value)` — a TypeScript `//` comment is
  not a key, not a value, and is never reachable from the object. `pge dump` serialises
  `authoredGraph(graphId)` (`src/cli/commands/pge.ts:176,189`) → `dumpTopology` → `serializeTopology`
  (`src/pge/topology/dump.ts:79`), the same canonical form. **No re-dump, no `graphVersion` bump,
  no changelog entry, no golden recapture follows from lines 108 and 191.** The one way to break
  this: editing a `doc:` STRING (e.g. `coding.graph.ts:478`) — those ARE values. Both target lines
  are `//` comments; verify with `pge dump --check` (step 5) regardless.
- **Do not export a runtime value from `src/orchestrator/pipeline.ts`.** `pge-engine.test.ts:35-37`
  replaces the whole module with `{ runTsPipeline: vi.fn() }`. A `PipelineFailure` class or a
  `toPipelineFailure()` helper exported from there would be `undefined` in that test file and would
  also create a real import cycle (§4). Map inline in `pge-engine.ts`, or put a helper in
  `pge-engine.ts` itself.
- **Spread `errors` conditionally, not unconditionally.** Unconditional costs you golden case 0 as
  well and makes `"errors" in result` true on every pge run, which no criterion wants.
- **`result` at pge-engine.ts:542 is already narrowed** to `completed | aborted` by the
  `interrupted` throw at :513-519. Both carry `failures` (`interpreter.ts:336`, `:346`). Do not add
  a redundant `"failures" in result` guard.
- **Never add `errors` to `VOLATILE_KEYS`** (`conformance.ts:63-74`). The module header at :41-62
  documents the bar and names the keys deliberately NOT added (`verdict`, `success`, `outcome`, …).
  Hiding this field would defeat the harness that exists to surface it.
- **Do not touch `conformance.engines.test.ts`.** `oracle-retention.test.ts:146-153` fails on
  `.skip` / `.only` / `.todo` and on fewer than 5 `it(` blocks; :156-167 greps its source for the
  four field names and the exact `expect(report.equivalent).toBe(false)` text.
- **Do not widen the sprint split** to absorb the terminal `commit` failure. The comment you are
  replacing (`pge-engine.ts:537-539`) warns about this specifically: it would invent a failed
  sprint that did not happen and put the two engines' shared `success` formula into disagreement.
  Option B is explicitly out of scope (contract nonGoal 1, spec D3).
- **`process.exitCode` on non-empty `errors` is sprint 6, not this sprint** (contract nonGoal 3).
  `src/cli/commands/run.ts:240-242` stays as-is.
- **ESM/NodeNext:** every import needs a `.js` extension; type-only imports use `import type`
  (`.bober/principles.md`, "Follow"). Unused params take a `_` prefix.
- **Section comments** use the `// ── Name ─────` box-drawing style
  (`.bober/principles.md`, "Section comments"); `pipeline.ts:68` and `pge-engine.ts:512` show it.
- **Commit message format:** `bober(sprint-5): <description>` (`.bober/principles.md`,
  "Conventional commits"). AGENTS.md requires every touched file to be justified against the
  contract's expected changes — `.bober/golden/*.json` (§7) is a deviation you must state.

---

## 10. Relevant Documentation

**Project principles** (`.bober/principles.md`): TypeScript strict mode + zero type errors is a
hard gate; zero lint errors is a hard gate; `consistent-type-imports` enforced; ESM everywhere with
`.js` extensions; tests collocated as `*.test.ts`; filesystem state under `.bober/`; box-drawing
section comments; conventional commits.

**AGENTS.md:** file-and-line discipline on every claim; verification evidence per success criterion
("I tested it" is not evidence"); scope creep is a contract violation — a file touched outside the
contract must be explained, not fixed silently.

**Architecture:** ADR-2 (module-graph boundary — the topology layer imports no executor and no
orchestrator; enforced in `eslint.config.js:114-160` and `src/pge/lint-boundary.test.ts`),
ADR-4 (`nodes[].reads`/`writes` is the single encoding the state audit derives from).

**Spec `resolvedClarifications`:** D2 authorises touching frozen surfaces *deliberately, in the same
commit as the `docs/pge-graph.md` disposition it changes — never as a side effect*. D3 fixes
Option-A `success` semantics for this sprint.

---

## 11. Testing Patterns

**Runner:** vitest. **Assertions:** `expect`. **Mocks:** `vi.mock` / `vi.fn`.
**Naming:** `<module>.test.ts` collocated beside `<module>.ts`. Fixtures in `__fixtures__/`.

**Unit-test pattern — real temp roots, no fs mocks.** Source:
`src/pge/engine/whole-graph.test.ts:36-51`
```ts
let tmpRoots: string[] = [];
beforeEach(() => { tmpRoots = []; });
afterEach(async () => {
  await Promise.all(tmpRoots.map((r) => rm(r, { recursive: true, force: true })));
  tmpRoots = [];
});
async function seededRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bober-pge-whole-"));
  tmpRoots.push(dir);
  await seedCommittedArtifact(dir);
  return dir;
}
```

**Two-directional pin pattern** (this repo's house style for any claim about a constant). Source:
`src/pge/engine/real-workload.test.ts:692-707`
```ts
  it("PGE_ENGINE_MAX_SUPERSTEPS equals a pure function of the measured cost, never a hand-picked literal", () => {
    expect(PGE_ENGINE_MAX_SUPERSTEPS).toBe(supersepsForMeasuredCost(MEASURED_REAL_WORKLOAD_SUPERSTEPS));
    expect(PGE_ENGINE_MAX_SUPERSTEPS).toBeGreaterThanOrEqual(
      MEASURED_REAL_WORKLOAD_SUPERSTEPS * SUPERSTEP_HEADROOM_FACTOR,
    );
    expect(supersepsForMeasuredCost(1)).toBe(DEFAULT_MAX_SUPERSTEPS);
    expect(supersepsForMeasuredCost(1000)).not.toBe(PGE_ENGINE_MAX_SUPERSTEPS);
  });
```
**Rule:** assert the derivation AND a sensitivity case, so the test cannot pass against a constant.

**Absence pattern** (exactly what sc-5-5 needs). Source: `src/orchestrator/finalize.test.ts:251-263`
```ts
    expect("needsClarification" in result).toBe(false);
```
**Rule:** use the `in` operator, never `toBeUndefined()` — the criterion is about the KEY.

**E2E:** none. No Playwright, no `e2e/` directory. The end-to-end tier in this repo is the golden
regression gate (`scripts/run-golden-regression.mjs`, `.github/workflows/ci.yml:103-106`) and the
two-engine conformance job (`src/orchestrator/workflow/conformance.engines.test.ts`).

---

## 12. Prior Sprint Output (sprints 1-4, all passed)

- **Sprint 1** — `src/pge/engine/real-workload.test.ts` + `src/pge/engine/__fixtures__/real-workload.ts`
  (`REAL_SPEC_PATH`, `realWorkload`, `realWorkloadBindings`); committed measurement
  `.bober/topology/measurements/real-workload.json`.
- **Sprint 2/3** — `src/pge/golden/workload.ts` (`capForCorpusMax`, `loadWorkloadCorpus`,
  `maxBytesPerChannel`), corpus under `.bober/workload/`; `coding.graph.ts` channel caps raised
  (`sprintContracts` 524_288 at :184, `spec` 131_072 at :198); `graphVersion 1.3.0` (:113).
  **This is the sprint whose in-flight-spec exclusion made the :108 / :191 comments stale.**
- **Sprint 4** — `SUPERSTEP_HEADROOM_FACTOR` (:164), `MEASURED_REAL_WORKLOAD_SUPERSTEPS = 234`
  (:174), `supersepsForMeasuredCost` (:184, misspelled), `PGE_ENGINE_MAX_SUPERSTEPS = 512` (:200),
  wired at `pge-engine.ts:463`.
  **Connection to this sprint:** the committed measurement now records, on real data,
  `engineOutcome {kind:"resolved", success:true}` beside `verdict:"failed"` and
  `failures:[{nodeId:"commit", branchKey:null, superstep:232, errorClass:"FailClosed"}]` —
  re-read from `.bober/topology/measurements/real-workload.json` at HEAD. That file is the
  evidence sc-5-6's doc rewrite rests on, and sprint 4's own record
  (`docs/sprints/sprint-…-4.md:128`) is where the `supersepsForMeasuredCost` typo was logged as
  carried debt, which is why sc-5-8 exists.
