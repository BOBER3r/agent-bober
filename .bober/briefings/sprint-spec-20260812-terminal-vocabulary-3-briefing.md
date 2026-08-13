# Sprint Briefing: A monotone version the rank-aware join can read, stable under replay

**Contract:** sprint-spec-20260812-terminal-vocabulary-3
**Generated:** 2026-08-12T00:00:00Z

---

## 0. The central question, answered up front

**A replay-stable monotone source DOES exist at `sprint_exit`, and the node already computes it.**
It is the local `attempts` variable at `src/pge/nodes/sprint-review.ts:195-200`.

```ts
// src/pge/nodes/sprint-review.ts:195-200
const attempts = Math.max(
  1,
  state.evaluations.filter(
    (entry) => entry.contractId === contract.contractId && entry.verdict !== "skipped",
  ).length,
);
```

Why it qualifies, point by point:

| Requirement | Verdict | Evidence |
|---|---|---|
| Monotone across seeded -> settled | YES | `attempts >= 1` by `Math.max(1, ...)`. The seeded copy carries **no** `version` at all, and `versionRank` maps a missing/non-finite `version` to `0` (`src/pge/registry/reducers.ts:350-354`). So seeded rank `0` < settled rank `>= 1`. **NOT equal** — the fatal case the contract warns about does not arise. |
| Monotone across repeated exits of the same branch | YES | `state.evaluations` only ever grows (`appendById`, `src/pge/registry/reducers.ts:221-235`), and each `sprint_evaluate` verdict has a distinct intrinsic `id` (`src/pge/nodes/sprint-evaluate.ts:125` — `${contractId}:${nodeId}:${iteration}`), so a second decisive verdict cannot collapse into the first. `sprint_exit` genuinely re-enters: `.bober/golden/replay-full-run-evaluation-fails.json` pins **two** `sprint.exit` calls for the same `branchKey` (`callIndex` 0 and 1). |
| Replay-stable | YES | Derived only from `state.evaluations`, which a replay rebuilds identically from the pinned answers. It is a `filter(...).length` — a **count**, so it is order-invariant, which matters because `appendById` is order-invariant by design. |
| Branch-local (safe under concurrency > 1) | YES | The filter is `entry.contractId === contract.contractId`. Another branch's verdicts cannot move this number. |
| Wall-clock / `Date.now()` / order / iteration derived? | NO | Nothing about `attempts` reads a clock or a position. |

**Recommended implementation:** `version: attempts` on the settled contract. That also makes
`contract.version === branchStatus[contractId].attempts` a true invariant worth asserting,
since the same `attempts` is written to `branchStatus` at `src/pge/nodes/sprint-review.ts:216-220`.

### 0.1 What is in scope at the write site — quoted in full

```ts
// src/pge/nodes/sprint-review.ts:183-225  (sprintExitNode's handler)
handler: async (input, state, ctx) => {
  const contract = resolveContract(input, state, ctx);
  if (contract === null) { throw new Error(...); }
  const refused = isNodeRefusal(input);
  const outcome = refused
    ? { settled: "failed" as const, summary: `admission refused: ${input.check}` }
    : branchOutcome(state, contract.contractId);

  const attempts = Math.max(1, state.evaluations.filter(...).length);   // :195-200
  const settled: SprintContract = {
    ...contract,
    status: outcome.settled === "succeeded" ? "completed" : "failed",
    updatedAt: ctx.clock.nowIso(),                                       // :204  <- THE INSERTION POINT
  };

  await ctx.effects.invoke(EFFECTS.sprintExit, { projectRoot: ctx.projectRoot, contract: settled }, ctx);

  return {
    update: {
      branchStatus: branchRecord(ctx, { state: outcome.settled, attempts, ... } as BranchStatus),  // :216-220
      sprintContracts: [settled],                                                                   // :221
    },
    goto: { kind: "node", node: next },
    output: settled,
  };
},
```

`state` is the full `OverallState` — 16 channels, `src/pge/state/overall.ts:209-227`.
`ctx` is `NodeContext`, `src/pge/registry/nodes.ts:170-191`:

```ts
export interface NodeContext {
  readonly runId: string; readonly projectRoot: string; readonly config: BoberConfig;
  readonly nodeId: string; readonly branchKey: string | null;
  readonly superstep: number; readonly spanId: string;
  readonly priv: Map<string, unknown>; readonly declaredEffects: readonly EffectTag[];
  readonly clock: Clock; readonly signal: AbortSignal; readonly effects: EffectRegistry;
  readonly scratch: ScratchStore; readonly archive: ArchiveHandle; readonly cache: SemanticCache;
  readonly trace: TraceWriter; readonly ledger: BudgetLedger;
  readonly prompts: PromptStore; readonly models: ModelBinder;
}
```

### 0.2 Candidates DISQUALIFIED by nonGoal 3 — do not use these

| Candidate | Where | Why it is disqualified |
|---|---|---|
| `ctx.clock.nowIso()` / `ctx.clock.nowMs()` | `sprint-review.ts:204`; `Clock` at `registry/nodes.ts:39-43`; prod impl `createSystemClock` at `src/pge/runtime/commit.ts:259-265` (`new Date()`, `Date.now()`) | Wall-clock. Explicitly banned by nonGoal 3. |
| `ctx.superstep` | `registry/nodes.ts:176` | Execution-**order** derived. Banned by nonGoal 3 ("run order"). Deterministic for one pinned run, but it moves whenever a gate loop or a retry changes the traversal. |
| `ctx.spanId`, `ctx.runId` | `registry/nodes.ts:171,177` | Not numeric, not monotone. `runId` is a `VOLATILE_KEY` (`conformance.ts:72`) precisely because it varies. |
| `state.messages.length`, `state.evaluations.length` (unfiltered) | `overall.ts:218-219` | Global channels. Under `concurrency > 1` another branch's writes move the number, so two runs with different interleavings disagree. `attempts` is filtered per-`contractId` and is immune. |
| `state.ledger` totals | `overall.ts:225` | Every sprint node charges zeros (`sprint-review.ts:70-85`), so it is 0 in the golden harness — not monotone. |
| `branchStatus[contractId].attempts` read from state | `overall.ts:159-164` | At the moment `sprint_exit` reads it, the record is still the `running` one with `attempts: 0` (`sprint-generate.ts:222-230`, `gates.ts:417-419`). Use the locally-computed `attempts`, not the channel read. |

### 0.3 Does the SEEDED copy need a version too? NO.

The seeded copy comes from `plan_materialize` (`src/pge/nodes/plan.ts:411-433`) via the shipped
`materializeContracts` (`src/orchestrator/contract-materialization.ts`, which sets only
`contract.status = "proposed"` at `:61`). It never sets `version`. `versionRank` reads:

```ts
// src/pge/registry/reducers.ts:348-359
function versionRank(value: unknown): [number, string, string] {
  if (value === null || value === undefined) return [Number.NEGATIVE_INFINITY, "", ""];
  let version = 0;                                    // <-- the default the seeded copy gets
  let updatedAt = "";
  if (isPlainObject(value)) {
    const rawVersion = value.version;
    if (typeof rawVersion === "number" && Number.isFinite(rawVersion)) version = rawVersion;
    const rawUpdatedAt = value.updatedAt;
    if (typeof rawUpdatedAt === "string") updatedAt = rawUpdatedAt;
  }
  return [version, updatedAt, canonicalJson(value)];
}
```

Missing `version` -> `0`. Settled `version >= 1` wins on the first tuple element, before
`updatedAt` is ever consulted. **No seed-side change is needed, and none should be made.**

---

## 1. Target Files

### `src/contracts/sprint-contract.ts` (modify)

**Relevant section — the schema, lines 151-203 (add one field):**
```ts
export const SprintContractSchema = z.object({
  contractId: z.string().min(1),
  // ...
  ambiguityScore: z.number().int().min(0).max(10).optional(),   // :183
  generatorNotes: z.string().optional(),                        // :186
  // ...
  createdAt: z.string().datetime({ offset: true }).optional(),  // :198
  updatedAt: z.string().datetime({ offset: true }).optional(),  // :199
  startedAt: ...  completedAt: ...                              // :200-201
});
export type SprintContract = z.infer<typeof SprintContractSchema>;   // :203
```

**Imported by (blast radius, verified by grep for `SprintContractSchema`):**
`src/contracts/index.ts`, `src/contracts/problem-reflection.ts`, `src/state/sprint-state.ts`,
`src/orchestrator/context-handoff.ts`, `src/orchestrator/contract-materialization.ts`,
`src/pge/state/overall.ts`, `src/pge/nodes/effects.ts`, `src/pge/nodes/gates.ts`,
`src/pge/nodes/plan.ts`, `src/pge/nodes/sprint-curate.ts`, `src/pge/nodes/sprint-fanout.ts`,
`src/pge/engine/__fixtures__/real-workload.ts`, `src/pge/golden/__fixtures__/workload-build.ts`,
`src/pge/runtime/__fixtures__/golden-graph.ts` (+ 8 test files).

**Test file:** `src/contracts/sprint-contract.test.ts` (exists, 450+ lines; sprint 2 added the corpus guard at `:334-460`).

**PRECEDENT — but read the warning.** `PlanSpecSchema` already has one:
```ts
// src/contracts/spec.ts:127
version: z.number().int().min(1).default(1),
```
**DO NOT COPY `.default(1)`.** See Pitfall P1 — it is the single worst mistake available in this sprint.
Use `version: z.number().int().min(0).optional()` (or `.min(1).optional()`).

---

### `src/pge/nodes/sprint-review.ts` (modify)

**Relevant sections:** the module header `:12-50` (its KNOWN LIMITATION paragraph becomes
partly FALSE — see section 9), and the handler `:183-226` quoted in section 0.1.

**Imports this file uses:** `SprintContract` (type) from `../../contracts/sprint-contract.js`;
`BranchStatus, GraphMessage, LedgerEntry, OverallState` from `../state/overall.js`;
`NodeContext, NodeImpl` from `../registry/nodes.js`; `EFFECTS` from `./effects.js`;
`branchRecord, isNodeRefusal, nodeSpecOf, portOf, resolveContract, soleSuccessor` from `./gates.js`;
`iterationOf, provisionalEvaluation, sprintVerdict` from `./sprint-evaluate.js`.

**Test file:** `src/pge/nodes/sprint-evaluate.test.ts` (exists, 779 lines) — this is where
`sprintExitNode` is exercised end to end.

---

### `src/pge/nodes/sprint-evaluate.test.ts` (modify)

**Relevant section — the assertion this sprint half-invalidates, lines 764-778:**
```ts
    // KNOWN LIMITATION, asserted so it cannot change unnoticed rather than hidden: the
    // `sprintContracts` channel still carries `proposed`. `appendById` unions by
    // `contractId` and resolves a duplicate by CANONICAL ORDER
    // (`registry/reducers.ts:182`), and `"completed" < "proposed"`, so the settled copy
    // cannot outrank the seeded one. `branchStatus` solves the same problem with an
    // explicit `attempts` discriminator (`state/overall.ts:131-142`); `SprintContract` has
    // no equivalent field, and adding one would change a shipped contract schema.
    expect(
      run.finalState.sprintContracts.find((entry) => entry.contractId === contract.contractId)
        ?.status,
    ).toBe("proposed");
```
**The `expect` still passes after this sprint** (sprint 4 changes `mergeEntries`, not this sprint).
**The COMMENT's last clause becomes false.** Update the prose to: the field now exists; the
join that reads it is sprint 4. Leave the assertion.

The surrounding test (`:731-778`, "runs end to end and produces the .bober/ artifacts...") is
the natural home for sc-3-2/sc-3-3, because it already captures the settled contract:
```ts
// src/pge/nodes/sprint-evaluate.test.ts:735-745
const persisted: string[] = [];
const run = await runSprint({
  projectRoot: root,
  bindings: stubSprintBindings({
    writeContract: async (_projectRoot, written) => {
      persisted.push(`${written.contractId}:${written.status}`);
    },
  }),
  contracts: [contract],
});
...
expect(run.finalState.branchStatus[contract.contractId]).toEqual({ state: "succeeded", attempts: 1 });  // :761-764
expect(persisted).toEqual([`${contract.contractId}:completed`]);
```
Widen the `writeContract` stub to capture `written.version` and assert it. That gives you
sc-3-2 directly and, run twice, sc-3-3's determinism half.

---

### `src/state/sprint-state.ts` (modify or verify only)

**Relevant sections:**
```ts
// src/state/sprint-state.ts:38-64  saveContract
export async function saveContract(projectRoot: string, contract: SprintContract): Promise<void> {
  await ensureDir(contractsDir(projectRoot));
  const validation = SprintContractSchema.safeParse(contract);          // :44
  if (!validation.success) { throw new Error(...); }
  const precisionIssues = findPrecisionIssues(validation.data);         // :52
  ...
  await writeFile(filePath, JSON.stringify(contract, null, 2), "utf-8"); // :63  <- writes `contract`, NOT validation.data
}

// src/state/sprint-state.ts:70-104  loadContract
  const result = SprintContractSchema.safeParse(parsed);                 // :96
  ...
  return result.data;                                                    // :103  <- STRIPPED
```

**This is the sc-3-5 asymmetry, exactly.** `saveContract` serialises the *caller's* object
(`:63`), so an undeclared `version` would reach the JSON file; `loadContract` returns
`result.data` from a **`safeParse` on a plain `z.object(...)`** — and this repo is on
**zod `3.25.76`** (`package.json:80`, `"zod": "^3.24.2"`), where `z.object()` defaults to
**strip** mode (no `.strict()`, no `.passthrough()` anywhere on `SprintContractSchema`,
`src/contracts/sprint-contract.ts:151`). So the key would be written and then silently
vanish on the next read. `listContracts` (`:113-147`) does the same at `:137`.

**Two MORE strip points make the point even harder — cite these, they are stronger:**
```ts
// src/pge/registry/effects.ts:154 — every effect request is parsed before the body sees it
const request = def.requestSchema.parse(req);
```
with `SprintExitRequestSchema = z.object({ projectRoot, contract: SprintContractSchema })`
(`src/pge/nodes/effects.ts:867-870`, used at `:885`). An undeclared `version` never even
reaches `saveContract`.
```ts
// src/pge/runtime/commit.ts:441 — every superstep re-parses the whole state
const state = OverallStateSchema.parse(next);
```
and `OverallStateSchema.sprintContracts = z.array(SprintContractSchema)`
(`src/pge/state/overall.ts:217`). An undeclared `version` is stripped out of the channel at
**every** commit boundary. **No test change strictly required here** — the round-trip test
can live in `src/contracts/sprint-contract.test.ts` or a new block in `sprint-state`'s tests;
prefer `sprint-contract.test.ts`, which already has the temp-dir plumbing at `:29`.

---

### `.bober/golden/` (re-capture, 5 of 6 replay cases)

See section 6. Not hand-edited — regenerated.

---

## 2. Patterns to Follow

### Optional-with-no-default schema field
**Source:** `src/contracts/sprint-contract.ts:183-189`
```ts
  ambiguityScore: z.number().int().min(0).max(10).optional(),
  generatorNotes: z.string().optional(),
  evaluatorNotes: z.string().optional(),
  estimatedFiles: z.array(z.string()).default([]),
  estimatedDuration: EstimatedDurationSchema.optional(),
```
**Rule:** `.optional()` leaves the key ABSENT when unset; `.default(x)` MATERIALISES `x` on
every parse. This sprint needs absence. Add `version` in the "Runtime / iteration state"
block (`:191-195`) with a doc comment naming `versionRank` as its consumer.

### Section headers and JSDoc-with-reasoning
**Source:** `src/pge/state/overall.ts:141-158`
```ts
/**
 * Per-branch progress. ...
 *
 * ── `attempts` is the ordering discriminator, not decoration ──
 * ...
 */
export const BranchStatusSchema = z.object({
  state: BranchStateSchema,
  attempts: z.number().int().min(0),
  errorClass: z.string().optional(),
});
```
**Rule:** unicode box-drawing sub-headers inside JSDoc, and the doc explains *why the field
must be monotone*, not what it holds. `version`'s doc should read the same way. (`.bober/principles.md`: "Section comments. Use unicode box-drawing section headers".)

### `import type` everywhere
**Source:** `src/pge/nodes/sprint-review.ts:3-8`
```ts
import type { SprintContract } from "../../contracts/sprint-contract.js";
import type { TopologySpec } from "../../contracts/topology.js";
import type { BranchStatus, GraphMessage, LedgerEntry, OverallState } from "../state/overall.js";
```
**Rule:** ESLint `consistent-type-imports` is errored (`.bober/principles.md`). ESM `.js`
extensions on every relative import.

---

## 3. Existing Utilities — DO NOT Recreate

Directories reviewed: `src/utils/`, `src/state/`, `src/contracts/`, `src/pge/registry/`,
`src/pge/runtime/`, `src/pge/nodes/__fixtures__/`, `src/pge/runtime/__fixtures__/`.

| Utility | Location | Signature | Purpose |
|---|---|---|---|
| `isSettledContractStatus` | `src/contracts/sprint-contract.ts:101` | `(status: ContractStatus) => boolean` | Sprint 1's "done and good" predicate (`passed`\|`completed`). |
| `isTerminalContractStatus` | `src/contracts/sprint-contract.ts:116` | `(status: ContractStatus) => boolean` | "Stopped at all" (adds `failed`). |
| `updateContractStatus` | `src/contracts/sprint-contract.ts:274` | `(contract, status) => SprintContract` | Status change + `startedAt`/`completedAt` stamping. **Uses `new Date()` (`:278`) — do NOT route the settled contract through it.** |
| `saveContract` / `loadContract` / `listContracts` | `src/state/sprint-state.ts:38 / :70 / :113` | `(projectRoot, contract) => Promise<void>` / `(projectRoot, id) => Promise<SprintContract>` | The only contract disk I/O. `saveContract` is bound as the shipped `sprint.exit` writer (`src/pge/nodes/effects.ts:878`). |
| `replaceIfNewer` | `src/pge/registry/reducers.ts:385` | `Reducer<VersionedValue>` with `.merge(current, updates[])` | **The only EXPORTED surface over `versionRank`.** `versionRank` (`:348`) and `rankIsGreater` (`:361`) are module-private — sc-3-4 must go through `replaceIfNewer.merge(...)`. |
| `canonicalJson` | `src/pge/registry/reducers.ts:119` | `(value: unknown) => string` | Sorted-key deterministic JSON; the join tie-break. |
| `appendById` | `src/pge/registry/reducers.ts:221` | `Reducer<IdentifiedCollection>` | The `sprintContracts` reducer. Duplicate ids resolved by `joinByCanonicalOrder` at `:187`. |
| `canonical` / `normalize` | `src/orchestrator/workflow/conformance.ts:113 / :85` | `(value) => string` / `(value) => unknown` | The ONE artifact normaliser; strips `VOLATILE_KEYS` (`:65-76`). |
| `createMonotonicClock` | `src/pge/runtime/__fixtures__/run-harness.ts:54` | `(startIso?, stepMs?) => Clock` | Logical clock, +1 ms per read. The `runSprint` default. |
| `createFixedClock` | `src/pge/runtime/commit.ts:268` | `(iso: string) => Clock` | **A clock that never moves — use this for sc-3-4** to force byte-identical `updatedAt` on both copies. |
| `runSprint` | `src/pge/nodes/__fixtures__/sprint-harness.ts:410` | `(SprintRunOptions) => Promise<SprintRun>` | Compiles + runs the sprint region off the COMMITTED artifact. Accepts `clock`, `contracts`, `bindings`. |
| `sprintContractFixture` | `src/pge/nodes/__fixtures__/sprint-harness.ts:519` | `(overrides?: Partial<SprintContract>) => SprintContract` | A schema-valid `status: "proposed"` contract with `createdAt`/`updatedAt` both `2026-08-05T00:00:00.000Z`. |
| `stubSprintBindings` | `src/pge/nodes/__fixtures__/sprint-harness.ts:552` | `(overrides?) => Omit<RegionBindings,"runtime">` | Stubs every collaborator; `writeContract` at `:567` is the seam that observes the settled contract. |
| `branchRecord` | `src/pge/nodes/gates.ts:696` | `(ctx, status) => Record<string, BranchStatus>` | Keys a `BranchStatus` by `ctx.branchKey`. |
| `iterationOf` | `src/pge/nodes/sprint-evaluate.ts:111` | `(state, contractId) => number` | `evaluations.length + 1` for a contract — **includes `skipped`**, so it is NOT the same number as `attempts`. |

---

## 4. Prior Sprint Output

### Sprint 1: the terminal vocabulary
**Modified:** `src/contracts/sprint-contract.ts` — added `SETTLED_CONTRACT_STATUSES` (`:69`),
`TERMINAL_CONTRACT_STATUSES` (`:84`), `isSettledContractStatus` (`:101`),
`isTerminalContractStatus` (`:116`). `updateContractStatus` (`:285`) now calls the latter.
**Connection:** you are editing the same file, ~50 lines below. Do not disturb `:38-118`.

### Sprint 2: the real-corpus status guard
**Modified:** `src/contracts/sprint-contract.test.ts:334-460`. It reads only the `status`
key from every `.bober/contracts/*.json` at run time:
```ts
// src/contracts/sprint-contract.test.ts:372-382
async function readContractStatusEntries(dir: string): Promise<ContractStatusEntry[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  ...
  const parsed = JSON.parse(raw) as { status?: unknown };
  entries.push({ file, status: parsed.status });
}
```
and the liveness bound is `expect(entries.length).toBeGreaterThan(200);` (`:390`).
**Connection:** deliberately NOT the whole-contract schema — the header at `:334-344` says 60
of the 256 committed files fail `SprintContractSchema` for unrelated legacy reasons. **An
optional `version` cannot break this guard.** Add your round-trip test as a *new* `describe`,
below `:460`, not inside it.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- TypeScript strict mode, **zero type errors is a hard gate**; zero lint errors is a hard gate.
- **Zod for validation** — "No hand-rolled validation."
- **Contract-based architecture:** "PlanSpecs, SprintContracts, and EvalResults are the
  communication protocol between agents. They live in `contracts/` and are JSON files on disk."
- Tests collocated: `*.test.ts` next to `*.ts`, Vitest.
- ESM: `.js` extensions on all relative imports; `import type` enforced.
- Commit format for sprint work: `bober(sprint-N): description`.

### Architecture Decisions
`.bober/architecture/arch-20260805-pge-graph-engineering-adr-{1..8}.md` +
`...-architecture.md`. Relevant: **ADR-4** (three-scope state split / closed reducer registry
— quoted in `src/pge/state/overall.ts:8-62` and `src/pge/registry/reducers.ts:1-50`). The
reducer set is **closed at six**; this sprint adds no reducer, only a field an existing one reads.

### `docs/pge-graph.md` — the doc that states the defect
```
docs/pge-graph.md:1208-1214
  ... The same channel keeps the seeded
  `"proposed"` copy of each contract — `appendById` resolves a duplicate `contractId` by
  canonical order, and `"completed" < "proposed"` — asserted as a known limitation at
  `src/pge/nodes/sprint-evaluate.test.ts:775-777` ... The rank-aware channel join is the other half.
```
Also `docs/pge-graph.md:426-479` (Channels) and the Changelog convention (`:42`, entries keyed
by `graphVersion`). **This sprint does NOT bump `graphVersion`** — see Pitfall P5.

### No repo-level `CLAUDE.md` or `CONTRIBUTING.md` exists.

---

## 6. Golden replay: capture, replay, and what changes (sc-3-3)

### The commands
```bash
# Run the whole gate (needs a build first — it loads dist/):
npm run build && node scripts/run-golden-regression.mjs            # --threshold <n> | GOLDEN_PASS_THRESHOLD | --dir <path>

# Compare committed cases against a fresh capture (this runs on EVERY `npm test`):
npx vitest run src/pge/golden/capture.test.ts

# RE-CAPTURE (rewrites the committed .bober/golden/*.json for the 6 replay cases):
GOLDEN_CAPTURE=1 npx vitest run src/pge/golden/capture.test.ts
```
(`src/pge/golden/capture.test.ts:26-29, :62`; `scripts/run-golden-regression.mjs:36-43`;
`src/pge/golden/gate.ts:72,160-200`.)

### How a case is stored
`.bober/golden/<caseId>.json`, 43 files, shape
`{formatVersion, caseId, title, intent, tags, enforcement, graph, input, pinnedResponses, expected}`.
`enforcement` is `"replay" | "integrity"` (`src/pge/golden/case-schema.ts:110, :253-254`);
only `replay` cases are EXECUTED (`src/pge/golden/executor.ts:267-273`).

### The 6 `enforcement: "replay"` cases (verified by reading every file)
| Case | has a `sprint_exit` pin? |
|---|---|
| `replay-full-run-evaluation-passes` | YES — 1 (`sprint.exit#0`, status `completed`) |
| `replay-full-run-evaluation-fails` | YES — 2 (`sprint.exit#0`, `#1`, both `failed`, **byte-identical requests today**) |
| `replay-plan-clarification-round` | YES — 1 (`completed`) |
| `replay-research-second-reflexion` | YES — 1 (`completed`) |
| `replay-research-reflexions-exhausted` | YES — 1 (`completed`) |
| `replay-plan-clarify-rounds-exhausted` | **NO** — the run never reaches the sprint region |

`capture.test.ts:288-296` asserts these 6 are exactly the declared `replay` set.

### What a replay compares, and what it does NOT
- **Lookup key ignores the request.** `recordingKey` is `` `${nodeId}@${branchKey ?? ""}#${callIndex}` `` (`src/pge/runtime/replay.ts:115-121`), and `invoke` (`:398-419`) checks only that key plus `call.effectName`. **Adding `version` to the request cannot cause a `MissingRecordingError`.**
- **Artifacts are compared through the ONE normaliser.** `compareGoldenArtifacts` (`src/pge/golden/runner.ts:141-168`) -> `canonicalMultiset` (`:119-121`) -> `canonical` (`src/orchestrator/workflow/conformance.ts:113`). `VOLATILE_KEYS` is `{createdAt, updatedAt, startedAt, completedAt, timestamp, duration, runId, totalCost, durationMs, approverId}` (`conformance.ts:65-76`). **`version` is NOT volatile — it WILL appear in compared bytes.**
- **But in a replay, the settled contract never reaches disk.** `sprint.exit` is answered from the recording, so `saveContract` is not called; the only contract on disk comes from the commit boundary persisting `state.sprintContracts` (`src/pge/runtime/commit.ts:450-459`). That channel copy is the **seeded** one (the defect). Proof: every replay case's `expected.artifacts.contracts[0].status === "proposed"`, and its key set is exactly the 16 seeded keys with no `version`.
- **Therefore `expected.artifacts` does NOT change.** What DOES change is `pinnedResponses[].request.contract`, which `capture.test.ts:282` compares byte-for-byte:
```ts
// src/pge/golden/capture.test.ts:277-283
const committed = await committedCase(scenario.caseId);
expect(committed, `${scenario.caseId}.json is not committed; run GOLDEN_CAPTURE=1 ...`).not.toBeNull();
expect(bytes).toBe(committed);
```

**Conclusion: 5 of the 6 replay cases must be re-captured** (all but
`replay-plan-clarify-rounds-exhausted`). The diff will be exactly one added
`"version": N` line inside each `sprint.exit` pin's `request.contract`. `expected.artifacts`
should be untouched — **if it moves, something is wrong and you must stop and understand why.**
The 37 `integrity` cases are never executed (`executor.ts:267-273`) and must not be hand-edited.

### Why a replay could become non-byte-identical
Anything that varies between the recorded run and the replayed run: wall-clock reads (the
capture freezes only `Date` — `CAPTURE_INSTANT = new Date("2026-08-05T00:00:00.000Z")`,
`capture.test.ts:47-55`), `runId` (pinned to `"golden"`, `executor.ts:106`), sandbox output
(fixed at `status: "ok"`, `executor.ts:147-158`), or superstep ordering.

### **PROOF that `updatedAt` is useless as a tiebreak** (the reason `version` exists at all)
From `.bober/golden/replay-full-run-evaluation-passes.json`, same run:
```
plan.materialize response contract:   createdAt = 2026-08-05T00:00:00.000Z
                                      updatedAt = 2026-08-05T00:00:00.000Z   (seeded, status "proposed")
sprint.exit  request  contract:       createdAt = 2026-08-05T00:00:00.000Z
                                      updatedAt = 2026-08-05T00:00:00.000Z   (settled, status "completed")
```
Byte-identical `updatedAt`. `versionRank`'s second tuple element is a tie; without `version`
the ordering falls all the way to `canonicalJson`, where `"completed" < "proposed"` and the
seeded copy wins. This is exactly what sc-3-4 must reproduce by construction.

---

## 7. Testing Patterns

### Unit test pattern — schema tests
**Source:** `src/contracts/sprint-contract.test.ts:68-101`
```ts
describe("SprintContractSchema", () => {
  it("accepts a fully populated contract", () => {
    const result = SprintContractSchema.safeParse(validContract());
    expect(result.success).toBe(true);
  });

  it("rejects criterion description shorter than minimum", () => {
    const bad = { ...validContract(), successCriteria: [{ ... }] };
    const result = SprintContractSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});
```
**Runner:** vitest `^3.0.5` (`package.json:115`), invoked as `npm test` / `npx vitest run <path>`.
No `vitest.config.ts` — defaults.
**Assertion style:** `expect(...)`. **Mock approach:** hand-written stub bindings passed as
arguments; `vi.mock` is not the house style for these layers.
**File naming / location:** `*.test.ts` collocated next to the source file.

### The reducer-ordering pattern sc-3-4 should copy
**Source:** `src/pge/registry/reducers.test.ts:497-516`
```ts
describe("replaceIfNewer", () => {
  it("keeps the highest version", () => {
    const older = { specId: "s", version: 1, updatedAt: "2026-08-01T00:00:00.000Z" };
    const newer = { specId: "s", version: 2, updatedAt: "2026-08-01T00:00:00.000Z" };
    expect(replaceIfNewer.merge(older, [newer])).toEqual(newer);
    expect(replaceIfNewer.merge(newer, [older])).toEqual(newer);
  });

  it("breaks a version tie by updatedAt", () => { ... });
});
```
Note the shape: **both directions asserted**, and `updatedAt` deliberately held EQUAL so only
`version` can decide. That is literally sc-3-4. Build a seeded copy from
`sprintContractFixture()` and a settled copy as `{...seeded, status: "completed", version: 1}`
with the **same** `updatedAt`, then assert `replaceIfNewer.merge(seeded, [settled])` is the
settled one **and** `merge(settled, [seeded])` is too.

> **`versionRank` and `rankIsGreater` are NOT exported** (`reducers.ts:348`, `:361` — plain
> `function`, no `export`). Go through `replaceIfNewer.merge`. Do not export them just to test.

### End-to-end region test pattern
**Source:** `src/pge/nodes/sprint-evaluate.test.ts:731-778` (quoted in section 1). Harness at
`src/pge/nodes/__fixtures__/sprint-harness.ts:410-476`; options include
`clock?: Clock` (`:320`) and `contracts?: SprintContract[]` (`:316`); result exposes
`finalState`, `artifactLog`, `handlerLog`, `spans` (`:330-347`). Timeout `30_000` is the
convention for these.

### E2E / Playwright
Not applicable — this repo has no `playwright.config.ts`. The golden gate is the closest
equivalent and is covered in section 6.

---

## 8. Impact Analysis — Affected Features, Files & Tests

### Files that may break
| File | Depends on | Risk | What to check |
|---|---|---|---|
| `src/pge/golden/capture.test.ts` | `sprint_exit`'s effect request bytes | **HIGH** | Re-captures every replay case and byte-compares (`:282`). **Will fail until you re-capture.** This is expected and required. |
| `.bober/golden/replay-*.json` (5 files) | the pinned `sprint.exit` request | **HIGH** | Must be regenerated with `GOLDEN_CAPTURE=1`. Read the diff: only `request.contract.version` should appear. |
| `src/pge/golden/workload.test.ts:130-138` | `SprintContractSchema.parse` of committed contract files vs stored `.bober/workload/sprintContracts-*.json` values | **HIGH if you use `.default()`** | `expect(entry.value, entry.entryId).toEqual(parsed)` — a `.default(1)` would inject `version: 1` into `parsed` and NOT into the stored corpus value. With `.optional()` this is a no-op. |
| `src/orchestrator/workflow/conformance.engines.test.ts:392-407` | the on-disk PGE contract | **MEDIUM** | The PGE contract on disk IS the settled one (`expect(pgeContract.status).toBe("completed")` at `:398`). It will gain `version`. The explicit per-field asserts still pass; the prose "**three** field deltas" (`:286`, `:392`) becomes a fourth. Update the comment. `report.diffs` field names (`:303-308`) are unchanged. |
| `src/pge/state/overall.test.ts:113` | `SprintContractSchema.safeParse(parsed.sprintContracts[0])` | LOW | Optional field, still parses. |
| `src/contracts/sprint-contract.test.ts:384-397` | `.bober/contracts/*.json` status only | LOW | Reads only `status`. Unaffected. |
| `src/pge/nodes/sprint-evaluate.test.ts:764-778` | the channel copy's status | LOW | Assertion still passes; **comment becomes stale** (see section 9). |
| `src/pge/topology/coding.graph.ts:186-195` | `sprintContracts` `maxInlineBytes: 524_288` | LOW | The cap is pinned two-directionally against `.bober/workload/` in `workload.test.ts`. The corpus files are static and gain no bytes; one extra `"version":N` on one settled contract is ~14 bytes against a 524,288 cap. |
| `src/pge/registry/index.ts:107-110` (`codingSchemaCatalog`) | `schemaRef: "SprintContract"` | NONE | The catalog is a **name set**, not a shape (`has: (ref) => known.has(ref)`). The topology artifact `.bober/topology/coding.json` carries only the string. **No `graphVersion` bump.** |
| `src/orchestrator/context-handoff.ts`, `src/pge/nodes/{gates,plan,sprint-curate,sprint-fanout}.ts` | `SprintContractSchema` | LOW | All read specific keys; none enumerate the key set. |

### Existing tests that must still pass
- `src/pge/golden/capture.test.ts` — the golden byte-compare (**will need the re-capture first**).
- `src/pge/golden/dataset.test.ts` — pins the committed replay-case COUNT; do not add/remove cases.
- `src/pge/golden/coverage.test.ts` — executes the committed cases and pins the executed node set.
- `src/pge/golden/workload.test.ts` — contract-corpus parse equality (the `.default()` tripwire).
- `src/pge/nodes/sprint-evaluate.test.ts` — the whole sprint region, incl. the known-limitation assertion at `:775-777`.
- `src/pge/registry/reducers.test.ts` — the six-reducer law suite; `replaceIfNewer` at `:497-516`.
- `src/pge/state/overall.test.ts` — key-set snapshot (`:58-70`, `:251`) — **you add no channel, so it must not move**.
- `src/contracts/sprint-contract.test.ts` — sprint 1 + sprint 2 assertions.
- `src/orchestrator/workflow/conformance.engines.test.ts` — two real engine runs, 60 s timeouts.
- `src/pge/runtime/commit.test.ts` — including `:517-523`, which asserts **no clock read exists outside the two clock factories** in `commit.ts`.

### Features that could be affected
- **Sprint 4 (rank-aware channel join)** — consumes this field. Do NOT touch `mergeEntries` (`reducers.ts:183-191`); nonGoal 1.
- **PGE conformance / `pipelineResult` divergence** — `commit.finalize` reads `state.sprintContracts` (`commit.ts:506-533`), which still holds the seeded copy after this sprint. Unchanged here by design.
- **`verdictFrom`** (`src/pge/runtime/interpreter.ts:728`) — counts channel contracts whose status is the literal `"passed"`. Carried in the allowlist at `src/contracts/status-vocabulary.invariant.test.ts:196-202`. Out of scope.

### Recommended regression checks
1. `npm run typecheck && npm run typecheck:tests && npm run lint && npm run build`
2. `npx vitest run src/contracts/sprint-contract.test.ts src/pge/registry/reducers.test.ts src/pge/state/overall.test.ts`
3. `npx vitest run src/pge/nodes/sprint-evaluate.test.ts`
4. `npx vitest run src/pge/golden/workload.test.ts src/pge/golden/dataset.test.ts`
5. `GOLDEN_CAPTURE=1 npx vitest run src/pge/golden/capture.test.ts` then `git diff --stat .bober/golden/` — expect **5 files**, and `git diff .bober/golden/` should show ONLY `"version"` lines inside `pinnedResponses[].request.contract`.
6. `npx vitest run src/pge/golden/capture.test.ts` (no env) — must now be green.
7. `npm run build && node scripts/run-golden-regression.mjs` — the gate.
8. `npx vitest run` — full suite.

---

## 9. Implementation Sequence

1. **`src/contracts/sprint-contract.ts`** — add `version` to `SprintContractSchema` in the
   "Runtime / iteration state" block (`:191-195`), as
   `version: z.number().int().min(0).optional()`, with a JSDoc naming
   `src/pge/registry/reducers.ts:348-359` as the reader and stating why it is `.optional()`
   and not `.default()`.
   - Verify: `npm run typecheck`; `SprintContractSchema.safeParse(<contract with no version>).success === true`.
2. **`src/contracts/sprint-contract.test.ts`** — sc-3-1 (optional, corpus stays valid) +
   sc-3-5 (`saveContract` -> `loadContract` round-trip into a `mkdtemp` dir preserves
   `version`; and a control proving an UNDECLARED key is stripped by the same `loadContract`).
   - Verify: `npx vitest run src/contracts/sprint-contract.test.ts`.
3. **`src/pge/nodes/sprint-review.ts`** — add `version: attempts` to the `settled` literal at
   `:201-205`. Rewrite the KNOWN LIMITATION paragraph at `:33-49`: the sentence "`SprintContract`
   has no equivalent monotone field, and adding one would change a shipped contract schema
   every part of this repository reads" is now FALSE — it now has one, `version`, written
   here; the join that reads it is sprint 4.
   - Verify: `npx vitest run src/pge/nodes/sprint-evaluate.test.ts` (existing tests green).
4. **`src/pge/nodes/sprint-evaluate.test.ts`** — sc-3-2 (the `writeContract` stub at `:735-742`
   observes `version >= 1` and `version === branchStatus[id].attempts`); sc-3-3 half one
   (**run `runSprint` twice over the same input and diff the two versions**); sc-3-4
   (`replaceIfNewer.merge` both directions, both copies built with an IDENTICAL `updatedAt`
   via `createFixedClock` from `src/pge/runtime/commit.ts:268`). Update the stale comment at
   `:767-773`.
   - Verify: `npx vitest run src/pge/nodes/sprint-evaluate.test.ts`.
5. **`.bober/golden/`** — `GOLDEN_CAPTURE=1 npx vitest run src/pge/golden/capture.test.ts`,
   then READ THE DIFF. 5 files, `version` lines only, `expected.artifacts` untouched.
   - Verify: re-run without the env var; then `npm run build && node scripts/run-golden-regression.mjs`.
6. **`src/orchestrator/workflow/conformance.engines.test.ts`** — update the "three field
   deltas" prose at `:286` and `:392` to four, and optionally assert
   `pgeContract.version` is defined / `tsContract.version` is undefined.
   - Verify: `npx vitest run src/orchestrator/workflow/conformance.engines.test.ts`.
7. **`docs/pge-graph.md`** (if the DoD's documentation clause requires it) — the
   `:1208-1214` paragraph now has its first half delivered. Every claim added must be backed
   by one of the tests above.
8. **Full verification** — `npm run typecheck && npm run typecheck:tests && npm run lint && npm run build && npx vitest run && node scripts/run-golden-regression.mjs`.

---

## 10. Pitfalls & Warnings

- **P1 — `.default(1)` instead of `.optional()` is fatal, in three separate ways.**
  (a) `OverallStateSchema.parse` at `src/pge/runtime/commit.ts:441` would stamp `version: 1`
  onto the **seeded** copy every superstep, making seeded rank 1 == settled rank 1 and
  **destroying the very ordering sprint 4 needs**. (b) `loadContract` would materialise
  `version: 1` for all ~256 committed contracts, so `src/pge/golden/workload.test.ts:137`'s
  `expect(entry.value).toEqual(parsed)` fails against a corpus that has no such key.
  (c) `saveContract` would start writing `version` into files that had none. `PlanSpecSchema`
  uses `.default(1)` (`src/contracts/spec.ts:127`) — **that precedent is a trap here.**
- **P2 — do not derive the version from `ctx.clock`, `ctx.superstep`, `ctx.spanId`,
  `Date.now()`, `state.messages.length`, or `state.evaluations.length` (unfiltered).** See
  the disqualification table in section 0.2. `src/pge/runtime/commit.test.ts:517-523` even
  asserts no clock read escapes the two factories in `commit.ts` — the repo takes this seriously.
- **P3 — `versionRank` / `rankIsGreater` are private.** `src/pge/registry/reducers.ts:348, :361`
  have no `export`. Test through the exported `replaceIfNewer.merge`. Do not add an export
  "just for the test" — `reducers.ts:1-50` documents a deliberately closed surface.
- **P4 — do not touch `mergeEntries` (`reducers.ts:183-191`) or `joinByCanonicalOrder`
  (`:124-129`).** nonGoal 1. Adding `version` does NOT change today's join: the settled and
  seeded canonical strings first diverge at the `status` key (`"completed" < "proposed"`,
  and `status` sorts before both `updatedAt` and `version`), so the seeded copy still wins
  and `sprint-evaluate.test.ts:775-777` still passes. **That is the correct outcome for this sprint.**
- **P5 — do NOT bump `graphVersion`.** `.bober/topology/coding.json` names `SprintContract`
  only as a `schemaRef` string, and `codingSchemaCatalog` (`src/pge/registry/index.ts:107-110`)
  is a name set with `isAssignable: (from, to) => from === to`. No artifact byte moves, so
  `pge diff --require-version-bump` has nothing to say.
- **P6 — do not hand-edit `.bober/golden/*.json`.** `capture.test.ts` regenerates and
  byte-compares them. Hand edits are wiped and the diff becomes unreadable. Use `GOLDEN_CAPTURE=1`.
- **P7 — do not hand-edit the 37 `integrity` cases.** They are never executed
  (`executor.ts:267-273`); editing them changes a curated specification and proves nothing.
- **P8 — `version` is NOT a `VOLATILE_KEY`** (`src/orchestrator/workflow/conformance.ts:65-76`).
  Do not add it to that set to make a comparison go quiet — the header at `:47` says the bar
  for adding a key is deliberately high, and hiding the field would defeat sprint 4.
- **P9 — do not route the settled contract through `updateContractStatus`**
  (`src/contracts/sprint-contract.ts:274-290`). It calls `new Date()` at `:278` and would
  reintroduce a wall-clock read into a node body.
- **P10 — the `expected.artifacts` of the replay goldens must NOT change.** If a re-capture
  moves them, the settled copy has started reaching disk in replay mode, which would mean
  something other than this sprint's change happened. Stop and investigate.
- **P11 — verify empirically, do not assume, whether `attempts` differs between the TWO
  `sprint_exit` calls in `replay-full-run-evaluation-fails`.** The two pinned requests are
  byte-identical today (920 bytes each). The code says `evaluations` accumulates, so the
  second exit should see 2 decisive verdicts and write `version: 2` — but that is an
  inference. The capture diff is the proof; read it.
- **P12 — the stop condition is real but is NOT triggered here.** `attempts` satisfies every
  constraint. Do not invoke the stop condition; do not invent a counter channel — the reducer
  registry is closed at six and `OVERALL_STATE_KEY_BUDGET` is pinned at 16
  (`src/pge/state/overall.ts:262`).
