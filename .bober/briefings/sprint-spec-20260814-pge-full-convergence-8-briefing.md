# Sprint Briefing: context_compact and critique execute

**Contract:** sprint-spec-20260814-pge-full-convergence-8
**Generated:** 2026-08-14T19:20:00Z
**Verified against:** branch `bober/pge-full-convergence`, artifact `.bober/topology/coding.json` at **graphVersion 1.5.0**, 44 declared nodes, 44 committed cases (7 replay / 37 integrity).

---

## 0. HEADLINE — read this before anything else

**One of the two target nodes is reachable by a case; the other is structurally blocked. The stopCondition fires for `context_compact`.**

| node | verdict | evidence |
|---|---|---|
| `critique` | **REACHABLE.** A case pinning a *corrected-but-recorded-fail* sprint drives it. Recipe in §8. | `root.ts:439-457`, `root.ts:291-302`, `sprint-review.ts:213-235` |
| `context_compact` | **STRUCTURALLY BLOCKED.** Its only inbound edge is `supervisor --compact--> context_compact`, and the shipped supervisor handler *contains no code path that returns that label*. `COMPACT_LABEL` (`supervisor.ts:82`) is referenced **nowhere else in `src/`** — verified by grep. No `featureRequest`, no binding, and no permitted `input.config` can change a node body. | §2.1 |

Second headline: **driving `critique` unavoidably drives `rework_route` too** — `critique`'s sole successor is `rework_route` (`e-eval-critiqued`, artifact edge list) and `rework_route`'s body cannot fail there. The contract's nonGoal *"Driving rework_route — sprint 9"* cannot be honoured; the pin at `coverage.test.ts:243-246` will go RED unless `rework_route` also leaves `NEVER_EXECUTED`. This is not contrivance, it is the graph's shape, and `NEVER_EXECUTED`'s own text already predicts it (`coverage.test.ts:108-115`: *"the case that would exercise `critique` exercises this node too"*).

---

## 1. Baseline — measured, not assumed

Run just now on the working tree:

```
npx vitest run src/pge/golden/coverage.test.ts --exclude '**/.claude/worktrees/**' --exclude '**/node_modules/**'
 ✓ src/pge/golden/coverage.test.ts (9 tests) 452ms   Test Files 1 passed (1)
```

- Declared nodes: **44** (`.bober/topology/coding.json`).
- `NEVER_EXECUTED` = **4** entries → executed = **40 / 44 ≈ 90.9 %**, floor is `> 0.85` (`coverage.test.ts:260`).
- Replay cases: **7** (`grep -l '"enforcement": *"replay"' .bober/golden/*.json`); floor `GOLDEN_MIN_REPLAY_CASES = 5` (`case-schema.ts:127`).
- Dataset size 44, bounds 20..50 (`case-schema.ts:77-78`) — one or two new cases is fine.

### `NEVER_EXECUTED` — VERBATIM, current state

`src/pge/golden/coverage.test.ts:143`:

```ts
const NEVER_EXECUTED = ["context_compact", "critique", "rework_route", "synthesize"] as const;
```

The claims attached to each (doc block `coverage.test.ts:46-142`), condensed with their exact line spans — **do not paraphrase these when editing; they are the claims the sprint is deleting**:

| entry | lines | claim, as recorded |
|---|---|---|
| `context_compact` | :80-88 | *"only edge in is `supervisor -> context_compact` under the `compact` label, and the shipped supervisor never selects that label … `supervisor.reads` … no `messages` … Recorded as artifact drift in `nodes/supervisor.ts`."* Filed as **structural**. Note the text says *"Re-checked directly against `.bober/topology/coding.json` … unchanged since `1.2.0`, and unmoved by the `specDraft` channel `1.4.0` added"* — the artifact is now **1.5.0**, so that sentence needs re-verification wording. |
| `critique` | :89-106 | *"a genuine gap in the dataset, not a wall: a case pinning a corrected-but-recorded-fail sprint alongside an otherwise passing run would exercise it."* Filed as **missing scenario**. |
| `rework_route` | :107-115 | *"it inherits `critique`'s gap … would choose the `"exhausted"` label, not `"rework"`, and still produce a `status: "ok"` span — it is a missing-scenario node like `critique`, and the case that would exercise `critique` exercises this node too."* |
| `synthesize` | :116-141 | **structural**, dead by construction. Untouched by this sprint. |

---

## 2. The two target nodes — exact reachability analysis

### 2.1 `context_compact` — STRUCTURALLY BLOCKED (stopCondition)

**Declared shape**, `src/pge/topology/coding.graph.ts:419-432` (identical in the committed artifact):

```ts
{
  id: "context_compact",
  kind: "tool",
  reads: ["messages", "refs"],
  writes: ["messages", "refs", "counters"],
  effects: ["fs-write"],
  toolRef: "context.compact",
},
```

**Every edge touching it**, read from `.bober/topology/coding.json`:

```
{'from': 'supervisor',       'id': 'e-supervisor-compact', 'kind': 'conditional', 'label': 'compact', 'to': 'context_compact'}
{'from': 'context_compact',  'id': 'e-compact-supervisor', 'kind': 'normal',                          'to': 'supervisor'}
```

So control reaches it **iff** the supervisor returns `{ kind: "label", label: "compact" }`.

**The supervisor's whole handler**, `src/pge/nodes/supervisor.ts:140-177`, has exactly five returns:

```ts
if (isNodeRefusal(input)) return { goto: failGoto, output: input };                        // :143-145
if (dispatchable.has(PLAN_LABEL) && needsPlan(state)) { ... label: PLAN_LABEL ... }        // :147-155
if (dispatchable.has(SPRINTS_LABEL) && ...) return { goto: { kind: "label", label: SPRINTS_LABEL }, ... };   // :165-167
if (dispatchable.has(EVALUATE_LABEL) && needsGlobalEvaluation(spec, state)) { ... }        // :169-171
return { goto: endGoto, output: { supervised: true, ... } };                               // :173-176
```

`COMPACT_LABEL` is declared at `supervisor.ts:82` and its own doc (`supervisor.ts:72-81`) says it is *"The declared label the shipped supervisor never selects."* Grep over the whole tree confirms:

```
$ grep -rn "COMPACT_LABEL" src/
src/pge/nodes/supervisor.ts:82:export const COMPACT_LABEL = "compact";        # the only hit
```

**What a golden case is allowed to vary** (`executor.ts:433-464`, `assertExecutable`): `featureRequest` only, plus `input.config` restricted to exactly `{ approved: true }` (`executor.ts:173-179`, `:452-457`). `input.seed` is **refused** (`:446-451`); `input.entryNodeId` must equal `spec.entry` (`:440-445`). Bindings are the collaborator seam only, and the *replay* never invokes one at all (`executor.ts:251-277` — every binding is a thrower). **None of these can make a shipped node body select a different label.**

Three corollaries worth stating so nobody re-litigates them:

1. It is **not** a token-threshold problem. `contextCompactNode`'s handler (`root.ts:660-700`) returns `{ compacted: false, ... }` and still completes normally when `decideCompaction` says no (`root.ts:674-680`) — a `status: "ok"` span either way. The blocker is upstream, at label selection.
2. `src/pge/runtime/compactor.ts:409` sets `nodeId: "context_compact"` on a **GraphMessage**, not on a span — it cannot satisfy `executedNodeIdsFromSpans`.
3. `context_compact` spans DO exist in the suite — `src/pge/runtime/__tests__/engram.invariant.test.ts:215` (*"86% of the cap: EXACTLY ONE context_compact span"*) — but against a **different graph**, `ENGRAM_GRAPH_ID = "engram-fixture"` (`src/pge/runtime/__fixtures__/engram-graph.ts:84`) whose supervisor declares `reads: ["messages", "counters"]` and does select the label (`engram-graph.ts:125-142`). Golden cases are pinned to `graphId === "coding"` (`executor.ts:458-463`), so this is no help.

**What would be needed** (out of scope, name it in the record): teach `supervisorNode` to measure the window and select `COMPACT_LABEL`, which first requires adding `messages` to `supervisor.reads` in `coding.graph.ts:408` — a topology change, i.e. a **minor `graphVersion` bump plus a shipped-code change**, not a case. (A minor bump would not invalidate existing cases: `checkCaseAgainstGraph` compares MAJOR only — `case-schema.ts:371-377`.)

**Therefore sc-8-1 is unsatisfiable by case authoring.** Follow sprint 3's precedent for a proven-unreachable finding (`.bober/architecture/arch-20260814-pge-full-convergence-adr-1.md`): record the reason with falsifiable conditions, keep the entry in `NEVER_EXECUTED`, and back the claim with a test (§8, step 5).

### 2.2 `critique` — REACHABLE

**Declared shape** (`coding.graph.ts:844-858`): `kind: "llm"`, `reads: ["evaluations","messages"]`, `writes: ["messages","ledger"]`, **`effects: []`**.

Inbound: `route_after_eval --rework--> critique` (`e-eval-rework`). Outbound: `critique -> rework_route` (`e-eval-critiqued`, `kind: "normal"`).

**The label decision**, `src/pge/nodes/root.ts:439-457`:

```ts
handler: async (input, state, _ctx) => {
  const carried = SprintVerdictSchema.safeParse(input);
  if (carried.success && carried.data.verdict === "pass") {
    return { goto: { kind: "label", label: "pass" }, output: carried.data };
  }
  if (reworkRoundsTaken(spec, state) < maxIterations) {              // 0 < 2 on a first run
    return { goto: { kind: "label", label: "rework" }, output: ... };
  }
  ...
}
```

So: **any non-pass global verdict on the first evaluation routes to `critique`.**

**The global verdict**, `root.ts:357-358`:

```ts
const passed =
  failedBranches.length === 0 && failedContracts.length === 0 && ungraded.length === 0;
```

`failedContracts` comes from `gradeContracts` (`root.ts:291-302`) which **reduces over every recorded row and lets one `"fail"` outrank a later `"pass"` permanently**:

```ts
if (seen === "fail") continue;
if (verdict.verdict === "fail") grades.set(verdict.contractId, "fail");
else if (verdict.verdict === "pass") grades.set(verdict.contractId, "pass");
```

**The branch outcome** uses the opposite rule — the LAST decisive verdict (`sprint-review.ts:229-234`):

```ts
return { settled: last.verdict === "pass" ? "succeeded" : "failed", ... };
```

**That asymmetry is the whole opening.** A branch that fails once and then passes settles `"succeeded"` (so `reduce_sprints` admits — `gates.ts:1007-1012` refuses only on `failed`/`abandoned`) while its contract is graded `"fail"` for ever (so `evaluate_global` returns non-pass).

**Predicted traversal** (counter model confirmed against the committed `replay-full-run-evaluation-fails` pins, which show exactly this cycle):

```
sprint_evaluate #1 (FAIL) -> gate_anchor_regression -> sprint_route #1  [sprintIterations=1] --retry-->
sprint_correct     [sprintIterations=2] -> sprint_generate #2 -> gate_syntax -> sprint_security #2 ->
sprint_evaluate #2 (PASS) -> gate_anchor_regression -> sprint_route #2  [sprintIterations=3 == bound]
    -> boundedDestination overrides "pass"/sprint_review to onExhausted sprint_exit
       (interpreter.ts:1010-1050; opens a SECOND, `failed` span for sprint_route + a TaskFailure — precedented,
        `replay-full-run-evaluation-fails` already does this and is green)
sprint_exit -> branchStatus "succeeded" (last decisive verdict = pass) -> gate_sprint_out -> reduce_sprints (ADMITS)
 -> supervisor -> gate_eval_in -> evaluate_global (verdict "fail": contracts graded fail: <id>)
 -> route_after_eval --rework--> CRITIQUE  -> rework_route (dispatch set empty -> "exhausted") -> graceful_failure
```

`critique`'s body (`root.ts:486-531`) then: `needsRework = unsucceededBranches ∪ contracts graded fail` = `[contractId]`; one `buildCorrection` per entry (`sprint-correct.ts:155-180` — pure + `ctx.scratch`, **no `ctx.effects.invoke`**, consistent with `effects: []`); writes one `messages` note and one zero-cost `ledger` entry; `goto` its sole successor. Nothing there can throw on this input.

`expected.terminalNodeId` will be **`graceful_failure`**.

**Note for the pin reader:** `critique` and `rework_route` declare `effects: []`, so they contribute **zero `pinnedResponses`**. The proof they ran is the SPAN, read by `coverage.test.ts`, not the pin list.

---

## 3. How "executed" is decided, and where `ok` is written

- `SPAN_STATUSES = ["ok", "failed", "interrupted", "skipped", "serialized"]` — `src/pge/runtime/trace.ts:40`.
- The rule: `coverage.test.ts:180-188`

```ts
export function executedNodeIdsFromSpans(spans): Set<string> {
  const executed = new Set<string>();
  for (const span of spans) {
    if (typeof span.nodeId === "string" && span.status === "ok") executed.add(span.nodeId);
  }
  return executed;
}
```

- Spans are read from `<runRoot>/.bober/traces/golden.jsonl` (`coverage.test.ts:191-211`, `GOLDEN_RUN_ID = "golden"`, `executor.ts:112`).
- `ok` is emitted at `src/pge/runtime/interpreter.ts:1373`, and only **after the superstep commit**: `closing` entries are downgraded to `{ status: "failed" }` when the commit rejected any of that node's writes (`interpreter.ts:1421-1427`). **So a node whose channel write is refused as oversized ends `failed`, not `ok`.** `messages`, `evaluations` and `ledger` all cap at `maxInlineBytes: 4096` in the committed artifact — `critique` writes one short note plus one zero-cost ledger row, so this is safe, but it is the failure mode to check first if the span comes back `failed`.
- Other ways a span exists without the body running: `interrupted` (`:1151`, FailClosed refusal), `serialized` (`:911-916`), `skipped` (`:1696`), and the loop-bound `failed` span (`:1040`).

---

## 4. The golden case shape — what to author vs. what is generated

**Nothing in `.bober/golden/*.json` is hand-written for a replay case.** `capture.ts:120-243` runs the scenario twice (a RECORDED run with real bindings for the pins, then a REPLAY through the shipped executor for `expected.artifacts`) and emits the file. You author a **Scenario entry in `capture.test.ts`** and run:

```
GOLDEN_CAPTURE=1 npx vitest run src/pge/golden/capture.test.ts --exclude '**/.claude/worktrees/**' --exclude '**/node_modules/**'
```

`capture.test.ts:63` gates on `GOLDEN_CAPTURE === "1"`; `:292-295` writes the file, otherwise `:302` byte-compares. `capture.test.ts:308-316` asserts the committed `replay` set equals `SCENARIOS` exactly, so a new scenario **must** ship with its file.

The `Scenario` interface — `capture.test.ts:67-82`:

```ts
interface Scenario {
  readonly caseId: string; readonly title: string; readonly intent: string;
  readonly tags: readonly string[]; readonly notes: string; readonly featureRequest: string;
  /** A FRESH factory per capture: the counting scenarios below are stateful. */
  readonly makeBindings: () => BindingsFactory;
  readonly configInput?: Readonly<Record<string, unknown>>;
}
```

`enforcement: "replay"` is **not** a scenario field — `capture.ts:225` hard-codes it, and `capture.test.ts:288` asserts it. That satisfies sc-8-4 by construction; do **not** hand-write a case file.

Schema constraints the emitted file must satisfy (`case-schema.ts:245-300`): `caseId` kebab-case **and equal to the filename** (`:143-145`), `tags` non-empty, `intent` length > 20 (`dataset.test.ts:155`), `expected.notes` non-empty (`:154`), unique recording keys, `callIndex` contiguous from 0 per `(nodeId, branchKey)`, `expected.artifacts` canonical.

---

## 5. Patterns to follow

### Pattern A — a counting bindings factory (THE pattern for this sprint)
**Source:** `src/pge/golden/capture.test.ts:109-139` (`clarifyingBindings`) and `:141-156` (`critiquingBindings`).

```ts
/** `critique` answers with a finding for the first `rounds` calls, then accepts. */
function critiquingBindings(rounds: number): BindingsFactory {
  let seen = 0;
  return (input) => {
    const base = wholeGraphBindings(input);
    return {
      ...base,
      critique: async (_request, _ctx) => {
        seen += 1;
        return Promise.resolve({ critique: seen <= rounds ? `Round ${String(seen)}: ...` : null });
      },
    };
  };
}
```

**Rule:** derive from `wholeGraphBindings(input)`, override exactly one collaborator, keep the counter in the factory closure, and register the factory via `makeBindings: () => xBindings(n)` so each capture gets a fresh count (`capture.test.ts:74`).

For this sprint the analogous shape is a fail-then-pass **evaluator**. `wholeGraphBindings` already has both behaviours behind one option (`whole-graph.ts:321-323`, `WholeGraphBindingOptions.evaluationPasses` at `:193`), and the failing variant is what `replay-full-run-evaluation-fails` uses (`capture.test.ts:179`). Compose the two rather than re-implementing `stubEvaluation`, so persistence (`persistEvalResult`, `whole-graph.ts:392-400`) is identical on both sides:

```ts
/** The evaluator fails the first `failures` calls, then passes — a corrected sprint. */
function correctingBindings(failures: number): BindingsFactory {
  let seen = 0;
  return (input) => {
    const passing = wholeGraphBindings(input);
    const failing = wholeGraphBindings(input, { evaluationPasses: false });
    return {
      ...passing,
      evaluator: async (...args) => {
        seen += 1;
        return seen <= failures ? failing.evaluator(...args) : passing.evaluator(...args);
      },
    };
  };
}
```

### Pattern B — the closest existing replay case
**Source:** `src/pge/golden/capture.test.ts:170-180`.

```ts
{
  caseId: "replay-full-run-evaluation-fails",
  title: "a whole run whose sprint evaluation fails",
  intent: "Pin the rework branch: a failing evaluation must change which nodes run ...",
  tags: ["replay", "full-run", "region:sprint", "rework"],
  notes: "The only difference from the passing case is the evaluator's verdict, so any artifact that differs between the two is attributable to the rework path and nothing else.",
  featureRequest: "Accept an optional retry block in the pipeline config and validate it.",
  makeBindings: () => (input) => wholeGraphBindings(input, { evaluationPasses: false }),
},
```

**Rule:** this is the **smallest delta** to the `critique` case — same `featureRequest`, same traversal through the sprint region, one changed collaborator. Its committed pins (`.bober/golden/replay-full-run-evaluation-fails.json`) show the exact retry cycle: `sprint_generate` idx 0 and 1, `sprint_security` idx 0 and 1, `sprint_evaluate` idx 0 and 1, then `sprint_exit`; `sprint_correct` contributes NO pin (it makes no effect call). Expect the new case's pins to match that prefix and then diverge: no second `sprint_exit`/`sprint_curate_mocks` (no re-dispatch), no `documenter`, ending with `graceful_failure / run.gracefulFailure`.

### Pattern C — the two-directional guard (sc-8-3's house idiom)
**Source:** `src/pge/golden/coverage.test.ts:283-356`, cited BY NAME as the idiom in `src/orchestrator/workflow/conformance.engines.test.ts:416-424` (*"in the `coverage.test.ts:311-354` idiom"*).

```ts
function missingAgainst(declared, spans) {
  const executed = executedNodeIdsFromSpans(spans);
  return declared.filter((id) => !executed.has(id)).sort();
}

it("a blocked node gaining an ok span fails the pin unless NEVER_EXECUTED shrinks to match", () => {
  const declared = ["documenter", "synthesize"];
  const staleNeverExecuted = ["synthesize"];                                 // nobody removed it
  expect(missingAgainst(declared, [{ nodeId: "documenter", status: "ok" }])).toEqual(staleNeverExecuted);
  const after = missingAgainst(declared, [
    { nodeId: "documenter", status: "ok" }, { nodeId: "synthesize", status: "ok" },
  ]);
  expect(after).not.toEqual(staleNeverExecuted);
  expect(after).toEqual([]);
});
```

**Rule:** prove the pin by MUTATING synthetic spans against `executedNodeIdsFromSpans` / `missingAgainst`, never by driving the real executor. Add one instance per direction for the newly-moved nodes: (a) `critique` losing its only `ok` span with the shrunk list unchanged must fail; (b) `context_compact` gaining an `ok` span with it still listed must fail. The mirror in `conformance.engines.test.ts:425-453` shows the same two-direction shape applied to a set that partly closed and partly stayed — the exact situation here.

---

## 6. Existing utilities — DO NOT recreate

Reviewed: `src/pge/golden/`, `src/pge/nodes/`, `src/pge/runtime/`, `src/pge/engine/__fixtures__/`, `src/utils/`.

| Utility | Location | Signature | Purpose |
|---|---|---|---|
| `captureGoldenCase` | `src/pge/golden/capture.ts:120` | `(input: GoldenCaptureInput) => Promise<GoldenCaptureResult>` | Records a run, replays it, emits the case. The only way a replay case is created. |
| `goldenCaseJson` | `src/pge/golden/capture.ts:252` | `(goldenCase: GoldenCase) => string` | The one writer for a case file's bytes. Use for both write and compare. |
| `wholeGraphBindings` | `src/pge/engine/__fixtures__/whole-graph.ts:321` | `(input: PgeRegistriesInput, options?: WholeGraphBindingOptions) => CodingBindings` | The deterministic collaborator set every scenario derives from. `options.evaluationPasses` flips the evaluator. |
| `goldenPlanSpec` / `goldenContracts` | `whole-graph.ts:130` / `:143` | `() => PlanSpec` / `() => SprintContract[]` | The fixed spec (`spec-20260805-pge-conformance`) and its ONE contract, `sprint-spec-20260805-pge-conformance-01`. |
| `executedNodeIdsFromSpans` | `src/pge/golden/coverage.test.ts:180` | `(spans) => Set<string>` | Exported and pure precisely so the pin can be mutation-proved. Reuse; do not re-derive the status rule. |
| `parseGoldenCase` / `isReplayCase` | `src/pge/golden/case-schema.ts:320` / `:304` | `(value, source) => GoldenCaseParse` / `(c) => boolean` | Parse and classify. |
| `checkCaseAgainstGraph` | `src/pge/golden/case-schema.ts:358` | `(goldenCase, facts) => string[]` | Cross-checks ids/effects against the artifact; MAJOR-only version rule. |
| `createGoldenExecutor` / `assertExecutable` | `src/pge/golden/executor.ts:481` / `:433` | factory / `(case, spec) => void` | Runs one replay case; refuses unsupported input. |
| `resolveGoldenConfig` | `src/pge/golden/executor.ts:195` | `(configInput?) => BoberConfig` | Shared by capture and replay so the two can never disagree about config. |
| `gradeContracts` | `src/pge/nodes/root.ts:291` | `(state) => Map<string, ContractGrade>` | The one-`fail`-outranks-`pass` reduction that makes this sprint possible. |
| `branchOutcome` | `src/pge/nodes/sprint-review.ts:213` | `(state, contractId) => { settled, summary, ... }` | Last-decisive-verdict rule; the counterpart asymmetry. |
| `dispatchableContracts` | `src/pge/nodes/sprint-fanout.ts:51` | `(state, candidates) => SprintContract[]` | Excludes `succeeded`/`abandoned` — why `rework_route` selects `exhausted`. |
| `reworkRoundsTaken` | `src/pge/nodes/root.ts:168` | `(spec, state) => number` | Reads the counter off the artifact's own loop bound. |

---

## 7. Impact analysis

### Files that may break

| File | Depends on | Risk | What to check |
|---|---|---|---|
| `src/pge/golden/coverage.test.ts:243-246` | the executed set | **high** | `missing` must equal `NEVER_EXECUTED` exactly. Adding the case without shrinking the list = RED. Shrinking by only one (leaving `rework_route`) = RED. |
| `src/pge/golden/coverage.test.ts:259-260` | `NEVER_EXECUTED.length` | medium | `declared.length - NEVER_EXECUTED.length === executed.size` (44 − 2 = 42) and ratio 42/44 ≈ 95.5 % > 0.85. |
| `src/pge/golden/capture.test.ts:308-316` | `.bober/golden/*.json` | **high** | The committed replay set must equal `SCENARIOS`. New scenario ⇒ new committed file, both or neither. |
| `src/pge/golden/dataset.test.ts:88-89,143` | file count, replay count | low | 45 ≤ 50; 8 ≥ 5. |
| `docs/pge-graph.md:540-600` | the 40/44 figure + the four-row table | **high** | The figure, the table rows for `critique`/`rework_route`, and the `context_compact` row's *"Re-verified … at `1.4.0`"* sentence (artifact is now **1.5.0**). |
| `src/pge/golden/executor.test.ts:74` | replay case list | low | Only `length > 0`; no hard-coded count. |
| `scripts/run-golden-regression.mjs` | pass rate | medium | Threshold is a *strict* `>`; a new failing case would drop it. |

### Existing tests that must still pass
- `src/pge/golden/coverage.test.ts` — the pin itself, both directions (9 tests today).
- `src/pge/golden/capture.test.ts` — re-captures **all** scenarios each run and byte-compares. If any *pre-existing* file changes bytes, runtime behaviour changed; investigate rather than commit.
- `src/pge/golden/dataset.test.ts`, `executor.test.ts`, `runner.test.ts`, `gate.test.ts`, `case-schema.test.ts`.
- `src/pge/nodes/supervisor.test.ts:377-392` — asserts the supervisor declares exactly the four labels including `compact`; a claim-backing test for §2.1 belongs beside it.
- `src/orchestrator/workflow/conformance.engines.test.ts:409-453` — the divergence set pin. Unaffected (own fixture), but it is the guard-idiom reference.
- `src/pge/engine/real-workload.test.ts` — drives its own scenarios, **not** `.bober/golden/`; no re-measure of `.bober/topology/measurements/real-workload.json` is implied by adding a case. (Sprint 7 re-measured because runtime behaviour changed; this sprint changes none.)

### Features that could be affected
- **Sprint 9 (`rework_route` + `synthesize`)** — its `rework_route` half is consumed here. Record that so sprint 9 is re-scoped to `synthesize`, which the committed analysis (`coverage.test.ts:116-141`) says no case can close.
- **Sprint 7's verdict-downgrade change** — `isSettledContractStatus` now live; the new scenario's branch settles `succeeded` with `status: "completed"` on the contract (`sprint-review.ts:290`). Read the captured artifacts against CURRENT behaviour; do not assume last week's.

### Recommended regression checks
1. `npx vitest run --exclude '**/.claude/worktrees/**' --exclude '**/node_modules/**'` (a bare run picks up nested worktrees).
2. `npm run typecheck && npm run typecheck:tests && npm run lint && npm run build`.
3. `node scripts/run-golden-regression.mjs` (or the repo's golden gate invocation) — pass rate strictly above threshold.
4. `git status --short .bober/golden/` after `GOLDEN_CAPTURE=1` — **exactly one new file expected**; any modified pre-existing case is a behaviour change to explain, not to wave through.
5. Verify on a **clean checkout**, not just the working tree (this repo has twice been green locally and red in CI on uncommitted state).

---

## 8. Implementation sequence

1. **`src/pge/golden/capture.test.ts`** — add `correctingBindings(failures: number)` beside `critiquingBindings` (`:141-156`), in Pattern A's shape.
   - *Verify:* `npm run typecheck:tests` clean.
2. **`src/pge/golden/capture.test.ts`** — append one `Scenario` to `SCENARIOS` (`:158-237`). Suggested `caseId: "replay-corrected-sprint-still-grades-fail"`. `featureRequest` identical to the fails case (`:177`). `intent`/`notes` must say the mechanism: *the branch settles `succeeded` on its last decisive verdict while `gradeContracts` keeps the contract `fail` for ever, so `evaluate_global` returns non-pass and `route_after_eval` selects `rework`*.
   - *Verify:* the file parses (`capture.test.ts:283-288` runs `parseGoldenCase` before writing).
3. **Capture.** `GOLDEN_CAPTURE=1 npx vitest run src/pge/golden/capture.test.ts --exclude '**/.claude/worktrees/**' --exclude '**/node_modules/**'`.
   - *Verify:* exactly one new `.bober/golden/*.json`; its `expected.terminalNodeId` is `graceful_failure`; the seven existing files are byte-identical.
4. **Prove the spans before editing the pin.** Run `src/pge/golden/coverage.test.ts` and read the failure: `missing` should now be `["context_compact", "synthesize"]` against a `NEVER_EXECUTED` of four. That failure IS the evidence for sc-8-2 (`critique` `ok`) and for `rework_route`. If `critique` is absent, or present with a `failed` span, STOP and diagnose (see §9) — do not force it.
5. **`src/pge/golden/coverage.test.ts`** — shrink `NEVER_EXECUTED` to `["context_compact", "synthesize"]`; rewrite the doc block (`:46-142`): delete `critique`'s and `rework_route`'s bullets and replace them with the "left this list at sprint 8" paragraph in the shape of the existing `commit`/`finalize` paragraph (`:55-73`); **rewrite `context_compact`'s bullet** to (a) re-verify against the artifact at **1.5.0**, (b) state the sharper reason — the supervisor handler has no code path returning `COMPACT_LABEL` at all (`supervisor.ts:140-177`), the `reads` drift being the reason it *cannot* have one — and (c) note that the node's own body would produce `ok` even below threshold (`root.ts:674-680`), so the block is at label selection, not at a token cap.
   - *Verify:* `coverage.test.ts` green, `executed.size === 42`.
6. **`src/pge/golden/coverage.test.ts`** — add the sc-8-3 controls to the *"the status-ok rule, mutated in both directions"* block (`:283-356`), in Pattern C's shape: `critique` silently re-entering must fail the shrunk pin; `context_compact` gaining an `ok` span must fail it too.
   - *Verify:* both new tests fail if you invert their assertion.
7. **`src/pge/nodes/supervisor.test.ts`** — add the claim-backing test for §2.1 (definitionOfDone: *every documentation claim backed by a test that fails when the claim stops being true*): drive `supervisorNode({ spec: CODING_GRAPH })` across the states the coding graph can produce (empty, plan-ready, branches settled, a large `messages` window) and assert the selected label is never `"compact"` — so teaching the supervisor to compact turns this test red and forces `NEVER_EXECUTED`'s claim to be revisited.
   - *Verify:* the test fails if you make the handler return `{ kind: "label", label: COMPACT_LABEL }`.
8. **`docs/pge-graph.md:540-600`** — figure 40 → **42 of 44 (≈95.5 %)**; delete the `critique` and `rework_route` table rows; rewrite the `context_compact` row with the sharpened reason and the 1.5.0 re-verification; add the sprint-8 paragraph in the shape of the sprint-2 one (`:565-575`).
9. **Record the stopCondition.** `context_compact` is structurally blocked ⇒ **sc-8-1 is not met, deliberately**. State it in the handoff and in the docs, with what would be needed (§2.1). Sprint 3's ADR is the precedent for the form; a fresh ADR is optional here because the block is already an `NEVER_EXECUTED` claim, but the *reason* recorded there must be upgraded to the handler-level fact, not left at the `reads`-drift fact alone.
10. **Full verification** — §7's five checks.

---

## 9. Pitfalls & warnings

- **`rework_route` will leave the list whether you want it to or not.** The contract's nonGoal cannot be honoured; `critique -> rework_route` is the sole successor edge and `rework_route`'s body cannot fail there. Deleting only `critique` from `NEVER_EXECUTED` leaves `coverage.test.ts:245` red. Delete both, deliberately, and say so.
- **Do not hand-write a case file.** `enforcement: "replay"` comes from `capture.ts:225`, and `capture.test.ts:308-316` asserts committed replay cases equal `SCENARIOS`. A hand-written file is orphaned and fails the dataset.
- **Do not try to satisfy `context_compact` with a bigger message window.** The node's threshold decision is downstream of a label the supervisor never selects; and even below threshold the node returns `ok` (`root.ts:674-680`). A case built to "make messages large" would be exactly the contrivance the stopCondition forbids.
- **Do not reach for `input.seed` or a config override.** Both are refused with a typed error (`executor.ts:446-457`); `{ approved: true }` is the ONE permitted config shape (`executor.ts:173-179`).
- **A `failed` span does not count.** If the new case reaches `critique` but its `messages`/`ledger` write is rejected at the commit, the span is downgraded to `failed` (`interpreter.ts:1421-1427`) and the node is NOT executed. Check `.bober/traces/golden.jsonl` in a kept run root (`keepRunRoots: true`, `coverage.test.ts:228`) rather than trusting the aggregate.
- **`sprint_route` will emit a second, `failed` span** when `sprintIterations` hits its bound of 3 (`interpreter.ts:1010-1050`). That is precedented and harmless — `sprint_route` keeps its `ok` span from the first visit, and `replay-full-run-evaluation-fails` already produces this — but do not mistake it for a defect introduced by the new case.
- **`sprint_review` will not run in the new case** (the loop bound redirects `sprint_route`'s `"pass"` to `sprint_exit`). It stays covered by the other cases; do not "fix" this by widening the bound, which would rewrite every committed case.
- **`critique` and `rework_route` add zero `pinnedResponses`** (`effects: []`). Absence of a pin is not absence of execution.
- **Re-capture rewrites ALL scenarios.** If a pre-existing case's bytes move, runtime behaviour changed — sprint 7 already re-captured for a real reason; a second silent move is a finding, not a formality.
- **Line numbers in this briefing were read today and sprints 1-7 all landed today.** Re-grep anchors (`NEVER_EXECUTED`, `const SCENARIOS`) before editing rather than trusting an offset.
- **Run the suite with the worktree excludes.** `npx vitest run --exclude '**/.claude/worktrees/**' --exclude '**/node_modules/**'`; a bare run picks up nested worktrees.

---

## 10. Documentation checked

- **`.bober/principles.md`** — relevant: ESM with `.js` import extensions; `import type`; unicode box-drawing section headers (`// ── Section ──`); tests collocated as `*.test.ts`; zero type/lint errors is a hard gate; no `any`; `node:fs/promises` only. All of these are already the house style of the files being edited.
- **`.bober/architecture/arch-20260814-pge-full-convergence-adr-1.md`** — sprint 3's precedent for recording a *proven unreachable* finding: decision, options table, rationale grounded in runtime facts with file:line, consequences, and a **Risk** section listing the falsifiable conditions under which the decision must be revisited. Mirror that structure for the `context_compact` record.
- **`docs/pge-graph.md:483-602`** — *"The golden dataset: what it proves and what it does not"* and *"How much of the graph the committed cases execute"*: the 40/44 figure, the four-row `NEVER_EXECUTED` table, and the two-directional pin paragraph. `:1593-1614` — outstanding-work item 3, the sprint-2 template for marking a coverage item resolved.
- No `CLAUDE.md` / `CONTRIBUTING.md` at the repo root beyond the global user instructions.
