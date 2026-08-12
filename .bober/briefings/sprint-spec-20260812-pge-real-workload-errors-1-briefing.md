# Sprint Briefing: Observe what a real 29 KB plan actually does to the graph engine

**Contract:** sprint-spec-20260812-pge-real-workload-errors-1
**Generated:** 2026-08-12T00:00:00Z

> This sprint MEASURES. It fixes nothing. Every cap stays at 4096, `PipelineResult` is not
> touched, no golden case is added. The output is a committed measurement artifact plus the
> tests that produce and pin it.

---

## 0. THE ONE THING THAT DECIDES THIS SPRINT — how to see `GraphRunResult`

`PgeEngine.run` computes the interpreter's result and then **throws it away**:

**Source:** `src/pge/engine/pge-engine.ts`, lines 420-427 and 461-482
```ts
const interpreter = (this.deps.interpreterFactory ?? createGraphInterpreter)();
let result: GraphRunResult;
try {
  result = await interpreter.run(graph, initialOverallState({...}), ctx);
} catch (error) { await closeQuietly(trace); throw error; }
...
// ── RECORDED LIMITATION: `GraphRunResult.verdict` and `.failures` do not reach here ──
return commit.finalize(result.state, { runId, projectRoot, config, superstep: result.supersteps, startedAtMs });
```

A harness that only inspects the returned `PipelineResult` observes **nothing** — no
`verdict`, no `failures`, no `commits[].rejected`.

**USE THE SHIPPED SEAM: `PgeEngineDeps.interpreterFactory`** (`src/pge/engine/pge-engine.ts:162`,
consumed at `:420`). Wrap the real `createGraphInterpreter()` in a recorder:

```ts
import { createGraphInterpreter } from "../runtime/interpreter.js";
import type { GraphInterpreter, GraphRunResult } from "../runtime/interpreter.js";

let observed: GraphRunResult | null = null;
const recordingInterpreter = (): GraphInterpreter => {
  const inner = createGraphInterpreter();          // the SHIPPED interpreter, unmodified
  return {
    run: async (graph, init, ctx) => (observed = await inner.run(graph, init, ctx)),
    resume: (graph, ref, value, ctx) => inner.resume(graph, ref, value, ctx),
  };
};
```

Precedent that this seam is real and already exercised:
- `src/pge/engine/pge-engine.test.ts:319-338` — "uses the injected interpreter factory rather than constructing its own"
- `src/pge/engine/pge-engine.test.ts:344-356` — a substituted interpreter, asserting the error class crosses the seam.

**Say in a comment in your code which one you drove and why** (contract `generatorNotes`).
Answer: `PgeEngine.run` is driven (sc-1-1 requires "a real PgeEngine"), and the interpreter's
result is captured through the engine's own `interpreterFactory` dep — no private wiring, no
reimplementation of `run()`.

### Expect `PgeEngine.run` to REJECT, not resolve

Derived path (verify, do not assert without observing):
`plan_materialize` writes `spec` (29 KB) and `sprintContracts` (135 KB) → both above 4096 →
both **rejected and dropped** (`src/pge/runtime/commit.ts:358-370`) → `state.spec` stays
`null` → `gate_plan_out`'s precondition `state.spec === null` fails
(`src/pge/nodes/plan.ts:448-451`) → the artifact's `gate.onFail: "graceful_failure"`
(`.bober/topology/coding.json`, node `gate_plan_out`) → `graceful_failure -> END`
(edge `e-failure-end`) → back in the engine, `commit.finalize` hits
`if (state.spec === null) throw new FinalizeWithoutSpecError(state.runId)`
(`src/pge/runtime/commit.ts:436`).

So the harness MUST be shaped as:

```ts
let engineOutcome: { kind: "resolved"; success: boolean } | { kind: "threw"; errorClass: string };
try {
  const result = await withNetworkDisabled(() => new PgeEngine({...}).run(...));
  engineOutcome = { kind: "resolved", success: result.success };
} catch (error) {
  engineOutcome = { kind: "threw", errorClass: (error as Error).name };
}
// `observed` is populated either way — the interpreter finished before finalize threw.
```

If the run does NOT throw, or the terminal node is not `graceful_failure`: **commit the
measurement unchanged and correct the SPEC's `assumptions` array** (sc-1-5). Never adjust
the measurement to match the prediction.

---

## 1. Target Files

### `src/pge/engine/__fixtures__/real-workload.ts` (create)

**Directory pattern:** `src/pge/engine/__fixtures__/` holds exactly one file today —
`whole-graph.ts` (427 lines). Fixture modules export `*Bindings(input, options)` factories,
a `seed*` helper and a `*Config()` builder. Follow that shape.

**Most similar existing file:** `src/pge/engine/__fixtures__/whole-graph.ts` — reuse it,
do not fork it.

**Structure template (derived from `whole-graph.ts:69-80`, `:321-332`, and `capture.test.ts:95-125`):**
```ts
// ── The real workload ───────────────────────────────────────────────
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { PlanSpecSchema } from "../../../contracts/spec.js";
import type { PlanSpec } from "../../../contracts/spec.js";
import type { SprintContract } from "../../../contracts/sprint-contract.js";
import type { CodingBindings } from "../../registry/index.js";
import type { PgeRegistriesInput } from "../pge-engine.js";
import { REPO_ROOT, wholeGraphBindings } from "./whole-graph.js";

/** The repository's own 29 KB PlanSpec, PARSED — bytes are measured off the parsed value. */
export const REAL_SPEC_PATH = join(REPO_ROOT, ".bober", "specs", "spec-20260805-pge-graph-engineering.json");

export async function realPlanSpec(): Promise<PlanSpec> {
  return PlanSpecSchema.parse(JSON.parse(await readFile(REAL_SPEC_PATH, "utf-8")));
}

/** Its 14 committed contracts, read from `spec.sprints` rather than from a hand-written list. */
export async function realContracts(spec: PlanSpec): Promise<SprintContract[]> { /* ... */ }

/** wholeGraphBindings with ONLY the two plan-region collaborators replaced. */
export function realWorkloadBindings(input: PgeRegistriesInput, w: Workload): CodingBindings {
  const base = wholeGraphBindings(input);
  return {
    ...base,
    planner: async () => ({ kind: "ready" as const, spec: w.spec }),
    materialize: async () => w.contracts,
  };
}
```
`REPO_ROOT` is already exported at `whole-graph.ts:71`; `COMMITTED_ARTIFACT` at `:72`.

---

### `src/pge/engine/real-workload.test.ts` (create)

**Directory pattern:** tests are co-located (`.bober/principles.md:20`). Siblings:
`src/pge/engine/whole-graph.test.ts` (270 lines), `src/pge/engine/pge-engine.test.ts`.

**Most similar existing files:**
- `src/pge/golden/capture.test.ts` — the **regenerate-or-compare committed artifact** pattern (see §2).
- `src/pge/engine/whole-graph.test.ts` — the **real PgeEngine over the committed artifact in a temp root** pattern.

---

### `.bober/topology/measurements/real-workload.json` (create)

No `measurements/` directory exists yet (`ls .bober/topology/` → `coding.json`,
`state-audit.json`). A subdirectory under `.bober/topology/` is an established shape —
`src/pge/topology/optimize.ts:34` (`variantsDir`) already owns `variants/`.

**Serialize with ONE writer used by both the write path and the compare path**, exactly as
`goldenCaseJson` does (`src/pge/golden/capture.ts:227-229`:
`` `${JSON.stringify(goldenCase, null, 2)}\n` ``).
Recommended fields (only include what survives two runs byte-identically — sc-1-4 is your
own filter): `formatVersion`, `graph: { graphId, graphVersion }`,
`workload: { specPath, specId, specCanonicalBytes, contractCount, contractsCanonicalBytes }`,
`channelLimits` (read off the LOADED artifact, not hardcoded),
`rejections: [{ channel, nodeId, branchKey, bytes, limit, superstep }]`,
`failures: [{ nodeId, branchKey, superstep, errorClass }]`, `terminalNodeId`, `status`,
`verdict`, `specChannelNullAtBoundary`, `engineOutcome`.

---

## 2. Patterns to Follow

### P1 — Seed the COMMITTED artifact into a throwaway root
**Source:** `src/pge/engine/__fixtures__/whole-graph.ts`, lines 69-80
```ts
const HERE = dirname(fileURLToPath(import.meta.url));
/** `<repo>/.bober/topology/coding.json` — this file is four levels below the repo root. */
export const REPO_ROOT = join(HERE, "..", "..", "..", "..");
export const COMMITTED_ARTIFACT = join(REPO_ROOT, ".bober", "topology", "coding.json");
export const CODING_GRAPH_ID = "coding";

export async function seedCommittedArtifact(projectRoot: string): Promise<void> {
  await mkdir(join(projectRoot, ".bober", "topology"), { recursive: true });
  await cp(COMMITTED_ARTIFACT, join(projectRoot, ".bober", "topology", `${CODING_GRAPH_ID}.json`));
  await seedPrompts(projectRoot);
}
```
**Rule:** call `seedCommittedArtifact(tmpRoot)` — it copies the repository's own artifact by
absolute path, which is the structural answer to "did you really load the committed graph?".
(`seedGoldenRoot` at `src/pge/golden/executor.ts:217-246` is the equivalent in the golden
tier and additionally RETURNS the validated `TopologySpec`.)

### P2 — Prove the loaded graph is the committed one
**Source:** `src/pge/engine/pge-engine.ts`, lines 303-333 (`readValidatedTopologySpec` is exported)
```ts
export async function readValidatedTopologySpec(projectRoot: string, graphId: string): Promise<TopologySpec>
```
**Rule:** in the test, `const spec = await readValidatedTopologySpec(tmpRoot, CODING_GRAPH_ID)`
and assert `spec.graphId === "coding"` and that **every** channel's `maxInlineBytes` is 4096
(measured, not asserted from a constant), and that each rejection's `limit` equals the
declared cap of its channel. `src/pge/engine/whole-graph.test.ts:69-71` uses the same
"read the facts off the artifact, never off a list in the test" discipline.

### P3 — The collaborator seam is the ONLY substitution
**Source:** `src/pge/engine/whole-graph.test.ts`, lines 59-62
```ts
await new PgeEngine({
  graphId: CODING_GRAPH_ID,
  bindings: (input) => wholeGraphBindings(input),
}).run("Wire the graph engine.", projectRoot, conformanceConfig(), { runId: "run-tiers" });
```
**Rule:** use `PgeEngineDeps.bindings` (`pge-engine.ts:172`), which routes through
`defaultRegistries()` (`:485-492`) into `codingRegistries` — the shipped composition root.
Do not build `Registries` by hand.

### P4 — Override exactly the two collaborators the workload needs
**Source:** `src/pge/golden/capture.test.ts`, lines 95-125
```ts
return (input) => {
  const base = wholeGraphBindings(input);
  return { ...base, planner: async (...args) => { /* ... */ } };
};
```
**Rule:** spread `wholeGraphBindings(input)` and replace `planner` / `materialize`.
Signatures: `Planner = (userPrompt, projectRoot, config, researchDoc?) => Promise<PlannerResult>`
(`src/pge/nodes/effects.ts:344-348`) and
`ContractMaterializer = (spec, projectRoot, config) => Promise<SprintContract[]>`
(`src/pge/nodes/effects.ts:373-377`). The planner must return
`{ kind: "ready", spec }` — the discriminated union at `effects.ts:333-336`.

### P5 — Shut the doors: throwing fetch, throwing collaborators
**Source:** `src/pge/golden/executor.ts`, lines 162-166 and 330-332
```ts
function refuse(binding: string): () => never {
  return () => { throw new GoldenBindingInvokedError(binding); };
}
...
const result = await withNetworkDisabled(() => new PgeEngine({ ... }).run(...));
```
`withNetworkDisabled` is at `src/pge/runtime/replay.ts:466-478` — it installs a throwing
`fetch` and restores the original in a `finally`. `GoldenBindingInvokedError` is exported at
`src/pge/golden/executor.ts:86-95`.
**Rule:** wrap every engine run in `withNetworkDisabled`. For the NFR "a test asserts a
reached collaborator fails the run by name", add a **positive control**: a second run whose
`materialize` (or `planner`) is bound to `refuse("materialize")`, asserting the captured
`GraphRunResult.failures` contains an entry whose `errorClass` is
`"GoldenBindingInvokedError"` and whose `message` names the binding. That works because a
thrown collaborator becomes a `TaskFailure` at `src/pge/runtime/interpreter.ts:1259-1277`.

### P6 — Regenerate-or-compare, with NO default skip
**Source:** `src/pge/golden/capture.test.ts`, lines 62 and 253-265
```ts
const CAPTURING = process.env.GOLDEN_CAPTURE === "1";
...
const bytes = goldenCaseJson(captured.goldenCase);
if (CAPTURING) { await writeFile(join(GOLDEN_DIR, `${scenario.caseId}.json`), bytes, "utf-8"); return; }
const committed = await committedCase(scenario.caseId);
expect(committed, `${scenario.caseId}.json is not committed; run GOLDEN_CAPTURE=1 vitest run ...`).not.toBeNull();
expect(bytes).toBe(committed);
```
**Rule:** this is exactly the shape the contract demands — the measurement **always runs**;
the env var only switches compare→write. Do NOT gate the run itself on an env var
(`generatorNotes`: "a measurement nobody runs is not a measurement"). Name yours something
like `MEASURE_REAL_WORKLOAD=1`, and put the command in the test's header comment (AC4:
"regenerable by a documented command").

### P7 — Terminal node comes off the trace, never from an assumption
**Source:** `src/pge/golden/capture.ts`, lines 174-179
```ts
const spans = await readSpans(tracePath(recordRoot, GOLDEN_RUN_ID));
const last = spans[spans.length - 1];
if (last === undefined) throw new Error(`... produced no spans; the run did not execute`);
terminalNodeId = last.nodeId;
```
**Rule:** read the terminal node the same way. `Span` carries `nodeId`, `status`,
`errorClass?`, `superstep` (`src/pge/runtime/trace.ts:63-112`) — you can cross-check that
`plan_materialize`'s span closed `failed` with `errorClass: "StateBloatError"`
(`src/pge/runtime/interpreter.ts:1415-1422`).

### P8 — Freeze the clock so the measurement is reproducible
**Source:** `src/pge/golden/capture.test.ts`, lines 55 and 211-217
```ts
const CAPTURE_INSTANT = new Date("2026-08-05T00:00:00.000Z");
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"], now: CAPTURE_INSTANT }); });
afterEach(() => { vi.useRealTimers(); });
```
**Rule:** `toFake: ["Date"]` ONLY — leave timers real so nothing that awaits one hangs.

### P9 — File style
`.bober/principles.md:32` unicode box-drawing section headers (`// ── Name ─────`, as every
file cited above uses); `:27` ESM `.js` import extensions; `:35` `import type`; `:42`
`node:fs/promises` only; `:36` `_` prefix for unused params.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---|---|---|---|
| `seedCommittedArtifact` | `src/pge/engine/__fixtures__/whole-graph.ts:76` | `(projectRoot: string) => Promise<void>` | Copies the repo's `.bober/topology/coding.json` + synthesises a prompt per `promptRef`. |
| `seedPrompts` | `src/pge/engine/__fixtures__/whole-graph.ts:95` | `(projectRoot: string) => Promise<void>` | One prompt file per `promptRef` in the committed artifact. Without it the first `llm` node dies on `UnknownPromptRefError`. |
| `REPO_ROOT` / `COMMITTED_ARTIFACT` / `CODING_GRAPH_ID` | `src/pge/engine/__fixtures__/whole-graph.ts:71,72,73` | consts | Absolute paths to this checkout's artifact. |
| `wholeGraphBindings` | `src/pge/engine/__fixtures__/whole-graph.ts:321` | `(input: PgeRegistriesInput, options?) => CodingBindings` | Every collaborator the committed artifact needs, deterministic, writing the artifacts the real agents write. |
| `conformanceConfig` | `src/pge/engine/__fixtures__/whole-graph.ts:420` | `(name?) => BoberConfig` | Autopilot config, `researchPhase: false`, `maxIterations: 2`, `evaluator.maxIterations: 1`. |
| `passingSandbox` | `src/pge/engine/__fixtures__/whole-graph.ts:165` | `(scratch, runId) => SandboxRunner` | Spawns nothing, reports success. Already wired inside `wholeGraphBindings`. |
| `goldenConfig` | `src/pge/golden/executor.ts:122` | `() => BoberConfig` | The golden tier's pinned config (same three overrides as `conformanceConfig`). |
| `seedGoldenRoot` | `src/pge/golden/executor.ts:217` | `(sourceRoot, runRoot, graphId?) => Promise<TopologySpec>` | Same as `seedCommittedArtifact` but returns the validated spec. |
| `GoldenBindingInvokedError` / `refuse` | `src/pge/golden/executor.ts:86` (`refuse` is module-private at `:162`) | `class`, `(binding: string) => () => never` | Named failure when a collaborator is reached. Re-implement `refuse` locally (3 lines) or import the error class. |
| `withNetworkDisabled` | `src/pge/runtime/replay.ts:466` | `<T>(fn: () => Promise<T>) => Promise<T>` | Installs a throwing `fetch`, restores it in `finally`. |
| `createRefusingSandbox` | `src/pge/runtime/replay.ts:481` | `() => SandboxRunner` | A sandbox that throws instead of spawning. |
| `readValidatedTopologySpec` | `src/pge/engine/pge-engine.ts:303` | `(projectRoot, graphId) => Promise<TopologySpec>` | The sanctioned artifact loader (schema + structural validation). |
| `createGraphInterpreter` | `src/pge/runtime/interpreter.ts:1616` (consumed at `pge-engine.ts:420`) | `() => GraphInterpreter` | The shipped interpreter. Wrap it; never fork it. |
| `readSpans` / `tracePath` | `src/pge/runtime/trace.ts:328` / `:198` | `(path) => Promise<Span[]>` / `(projectRoot, runId) => string` | Read a run's spans back off disk. |
| `canonicalJson` | `src/pge/registry/reducers.ts:119` | `(value: unknown) => string` | Key-sorted deterministic JSON — the exact serialization the byte cap is measured against. |
| `StateBloatError` | `src/pge/runtime/commit.ts:63-89` | fields `channel`, `bytes`, `limit`, `nodeId`, `branchKey` | The rejection record. **sc-1-2's four fields are already on it — do not recompute them.** |
| `PlanSpecSchema` / `getOpenClarifications` | `src/contracts/spec.ts:124` / `:266` | zod schema / `(spec) => ClarificationQuestion[]` | Parse the committed spec; the clarification predicate the plan router uses. |

**`byteSize` is NOT exported** — module-private at `src/pge/runtime/commit.ts:257-259`:
`Buffer.byteLength(canonicalJson(value), "utf8")`. Recompute it from the exported
`canonicalJson` if needed. Do **not** export it in this sprint — that is a shipped-code edit
this sprint does not need.

**Directories reviewed for reusable helpers:** `src/utils/`, `src/pge/runtime/`,
`src/pge/golden/`, `src/pge/engine/__fixtures__/`, `src/pge/nodes/__fixtures__/`,
`src/pge/registry/`. The table above is the applicable set.

---

## 4. Prior Sprint Output

`dependsOn: []` — this is sprint 1 of the spec. The whole PGE layer (14 sprints) already
exists and is complete. What this sprint stands on:

| Prior artifact | Exports this sprint uses |
|---|---|
| `.bober/topology/coding.json` (graphVersion `1.2.0`, entry `research_body`, 44 nodes, 10 channels) | The graph under measurement. **All ten channels declare `maxInlineBytes: 4096`** — verified by reading the artifact. |
| `src/pge/engine/pge-engine.ts` | `PgeEngine`, `PgeEngineDeps` (`interpreterFactory`, `bindings`, `graphId`), `readValidatedTopologySpec`, `PgeRegistriesInput` |
| `src/pge/runtime/interpreter.ts` | `GraphRunResult` (`:329-363`), `TaskFailure` (`:321-327`), `CommitRecord` (`:313-319`, carries `rejected`) |
| `src/pge/runtime/commit.ts` | `StateBloatError`, `FinalizeWithoutSpecError` (`:131-141`), `CommitResult.rejected` (`:180`) |
| `src/pge/golden/*` | The offline-run discipline this harness copies (`executor.ts`, `capture.ts`, `capture.test.ts`) |
| `.bober/specs/spec-20260805-pge-graph-engineering.json` | The workload: 14 sprints, `clarificationQuestions: []` (so `plan_clarify_check` routes straight to `plan_materialize`). |

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- `:20` collocated `*.test.ts`, Vitest, "tests run against the real project when practical".
- `:31` all mutable state is JSON under `.bober/`; no DB, no module-level state.
- `:44` **"No test mocks for filesystem. Tests that need filesystem state create temp directories and clean up."**
- `:18`/`:19`/`:21` typecheck, lint and build are hard gates. Style rules: see P9.

### Architecture / recorded dispositions (`docs/pge-graph.md`)
- `:494-505` records the exact defect this sprint measures: exhausting `planClarifyRounds`
  reaches `graceful_failure` with `state.spec` still null and `commit.finalize` **throws
  `FinalizeWithoutSpecError` instead of returning a failed `PipelineResult`**. Your run
  reaches the same terminal by a different route (a rejected write instead of an unsettled
  planner). **Do not edit `docs/pge-graph.md` in this sprint** — the spec assigns that to
  later features, and every docs claim must land in the same commit as the test that backs it.
- `:528-534` "Recapture is a deliberate act" — the discipline your measurement artifact inherits.

### Contributor guidelines (`AGENTS.md`)
- File-and-line discipline for every claim (`AGENTS.md`, "Evidence Requirements").
- Verification logs: paste real `npm run typecheck` / `lint` / `build` / `test` output.
- **Every file you touch must be in the contract's estimated file set.** The set is exactly
  three files. Anything else is a scope violation to be reported, not silently fixed.

---

## 6. Testing Patterns

**Runner:** vitest 3 (`package.json:115`, `"test": "vitest"` at `:17`).
**There is no `vitest.config.ts` in this repo** — defaults apply, which means a **5 s test
timeout**. A whole-graph `PgeEngine` run does not fit. Pass an explicit timeout as the third
argument to `it`, exactly as `src/pge/golden/capture.test.ts:266` does (`120_000`).
**Assertion style:** `expect`. **Mocks:** `vi.useFakeTimers` for the clock only; collaborators
are replaced through the shipped `bindings` seam, never with `vi.mock`.
**Location:** co-located; fixtures under `__fixtures__/`.

### Unit test pattern — a real engine run in a temp root
**Source:** `src/pge/engine/whole-graph.test.ts:16-52`
```ts
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

### Non-vacuity / negative-control pattern
**Source:** `src/pge/engine/whole-graph.test.ts:93-107`
```ts
// The negative control: the assertion above must not be passing because NOTHING carries
// a tier. Frontier spans exist, and every one of them belongs to an `llm` node.
const frontier = spans.filter((span) => span.model?.tier === "frontier");
expect(frontier.length).toBeGreaterThan(0);
```
**Rule:** every "we observed N rejections" assertion needs a companion proving the run
actually got that far — e.g. `expect(spans.some((s) => s.nodeId === "plan_materialize")).toBe(true)`
and `expect(workload.specCanonicalBytes).toBeGreaterThan(20_000)`.

### E2E / Playwright
Not applicable — no `playwright.config.ts`, no `e2e/` directory.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
All three target files are `create`. **No shipped module is modified**, so there are no
import-graph dependents to break. The risks are environmental:

| File | Depends on | Risk | What to check |
|---|---|---|---|
| `src/pge/engine/__fixtures__/whole-graph.ts` | imported by your new fixture | medium | You must NOT change it. `capture.test.ts:11` and `whole-graph.test.ts:28-34` import it; any edit re-captures the golden dataset. |
| `.bober/topology/` (new `measurements/` subdir) | `src/pge/topology/dump.ts:23` (`TOPOLOGY_DIR`), `src/pge/topology/audit.ts:43` | low | Adding a subdirectory must not disturb `pge dump --check` or the committed `state-audit.json`. |
| `.bober/specs/spec-20260805-pge-graph-engineering.json`, `.bober/contracts/*.json` | read by your fixture at test time | medium | These are live repo artifacts. Read them **read-only**; never write into the repo root from a test (`whole-graph.test.ts:206-231` pins that property). |

### Existing Tests That Must Still Pass
- `src/pge/golden/capture.test.ts` — re-captures all five replay cases against `wholeGraphBindings`. Any edit to `whole-graph.ts` shows up here first.
- `src/pge/golden/coverage.test.ts` — the node-coverage pin (39/44), two-directional.
- `src/pge/golden/executor.test.ts`, `gate.test.ts`, `runner.test.ts`, `dataset.test.ts` — the golden gate.
- `src/pge/engine/whole-graph.test.ts`, `src/pge/engine/pge-engine.test.ts` — the engine's own contract, including the `interpreterFactory` seam test at `:319-338`.
- `src/pge/topology/ci-gate.test.ts` — the six blocking gate checks (spec NFR: no gate may be weakened).
- `src/pge/audit-git-gate.test.ts`, `src/cli/commands/pge.test.ts` — artifact/audit drift. Run these after adding the new `.bober/topology/measurements/` path.
- `src/orchestrator/workflow/oracle-retention.test.ts` — default engine stays `"ts"`; nothing here flips it.

### Features That Could Be Affected
- **feat-2 (cap sizing, sprint 3)** consumes this measurement. If you record a hardcoded byte count instead of a measured one, feat-2's two-directional cap pin is built on a fiction.
- **feat-5 (golden dataset)** breaks if `whole-graph.ts` changes shape. Additive-only there.

### Recommended Regression Checks
1. `npx vitest run src/pge/engine` — the new tests plus the existing engine suite.
2. `npx vitest run src/pge/golden` — the whole golden tier, unchanged.
3. `npx vitest run src/pge/topology src/pge/audit-git-gate.test.ts src/cli/commands/pge.test.ts` — artifact/audit gates after the new `.bober/topology/measurements/` path exists.
4. Run your measurement test **twice** and `git diff --exit-code .bober/topology/measurements/real-workload.json` — sc-1-4 is only meaningful if you executed it.
5. `npm run typecheck && npm run typecheck:tests && npm run lint && npm run build && npm test`.

---

## 8. Implementation Sequence

1. **`src/pge/engine/__fixtures__/real-workload.ts`** — workload loaders (`realPlanSpec`,
   `realContracts`) + `realWorkloadBindings` spreading `wholeGraphBindings`.
   - Verify: `npx vitest run src/pge/engine` still green; `npm run typecheck:tests` clean.
2. **Add the measurement shape + `measurementJson` serializer** (in the fixture file, or a
   small exported interface in the test file — do not create a fourth file).
   - Verify: the shape contains only values you can derive from `GraphRunResult`, the loaded
     `TopologySpec` and the trace.
3. **`src/pge/engine/real-workload.test.ts` — the observing run.**
   Order inside the file: seed root → `readValidatedTopologySpec` and assert graphId + the ten
   4096 caps → build the recording `interpreterFactory` → `withNetworkDisabled(() => new
   PgeEngine({ graphId, bindings, interpreterFactory }).run(...))` inside `try/catch` →
   assert `observed !== null`.
   - Verify: `observed.commits.flatMap((c) => c.rejected)` is non-empty and every entry is a
     `StateBloatError`; `observed.failures` contains `errorClass: "StateBloatError"`.
4. **Assert the workload is the real one, measured in the test** (evaluator note 2):
   `canonicalJson(spec)` byte length is what the boundary measures, and it is ~29 KB — assert
   `> 20_000` rather than an exact literal so a spec edit does not fail the wrong test, and
   record the exact number in the artifact.
   - Verify: `expect(workload.specId).toBe("spec-20260805-pge-graph-engineering")`.
5. **Terminal node + verdict** from `observed` and the trace (P7).
   - Verify: `terminalNodeId` matches the last span's `nodeId`; `verdict`/`status` come from
     `GraphRunResult`, never from the `PipelineResult`.
6. **Write-or-compare the committed artifact** (P6), then run with the env var once to
   produce `.bober/topology/measurements/real-workload.json` and commit it.
   - Verify: run the test twice with no env var — green both times.
7. **The two controls:** (a) a positive control that a `refuse("materialize")` binding
   surfaces as a named `TaskFailure`; (b) a non-vacuity assertion that `plan_materialize`
   actually executed.
   - Verify: mutate one cap in a LOCAL COPY of the artifact in a temp root and confirm the
     rejection disappears — proving the harness is measuring the cap and not a constant.
     (Do not modify the committed artifact.)
8. **If the observation contradicts the derivation** — commit the measurement unchanged and
   correct `.bober/specs/spec-20260812-pge-real-workload-errors.json`'s `assumptions` array
   **in the same commit** (sc-1-5). Report it in your completion notes.
9. **Full verification** — `npm run typecheck`, `npm run typecheck:tests`, `npm run lint`,
   `npm run build`, `npm test`.

---

## 9. Pitfalls & Warnings

- **The fixture graph raises exactly the two caps that would otherwise blow up.**
  `src/pge/runtime/__fixtures__/golden-graph.ts:360` sets `sprintContracts` to **65536** and
  `:366` sets `spec` to **8192**, while `defaults.maxInlineBytes` at `:355` stays 4096. A
  harness that picked up `GOLDEN_GRAPH_ID` / `goldenRegistries` / `rootWithGoldenArtifact`
  (all from `src/pge/engine/pge-engine.test.ts`'s fixture path) would show FEWER rejections
  and look healthier. **Import nothing from `src/pge/runtime/__fixtures__/golden-graph.ts`.**
  Guard structurally: assert the loaded spec's `graphId === "coding"` and that every channel
  cap is 4096.
- **`PgeEngine.run` is expected to REJECT** with `FinalizeWithoutSpecError`
  (`src/pge/runtime/commit.ts:436`, thrown from `pge-engine.ts:476`). A bare `await run(...)`
  fails the test for the wrong reason and loses the measurement. Catch it, record the class,
  and read `observed` regardless.
- **Control keys bypass the size guard.** `commit.ts:333-339` handles `currentPhase`,
  `specId` and `verdict` BEFORE the channel lookup and the byte check at `:358-370`. So
  `verdict` — although declared as a channel with `maxInlineBytes: 4096` in the artifact —
  can never produce a `StateBloatError`. Do not claim "all ten channels can reject".
- **`GraphRunResult.commits[].rejected` is where the four fields live**
  (`interpreter.ts:313-319, 1385-1391`). `TaskFailure` (`:321-327`) carries only
  `nodeId/branchKey/superstep/errorClass/message` — the bytes are inside the message string.
  Read the structured values off `StateBloatError`, not by regexing a message.
- **Bytes are canonical bytes, not file bytes.** The boundary measures
  `Buffer.byteLength(canonicalJson(value))` of the **parsed** value. Measured on this
  checkout: the spec file is 31,541 bytes on disk, 29,247 as compact JSON, and 29,214 as
  `canonicalJson(PlanSpecSchema.parse(...))`. The 14 contracts as one parsed array are
  135,106 canonical bytes. **Record what the run reports; do not hardcode any of these.**
- **Default vitest timeout is 5 s** (no `vitest.config.ts` exists). Pass `120_000` as the
  third `it` argument, as `capture.test.ts:266` does.
- **Do not create a `.bober/prompts/` tree in the repo.** `seedPrompts`
  (`whole-graph.ts:95-104`) synthesises them inside the temp root for a reason stated at
  `:88-93`: a real tree changes `pge validate --mode full` repo-wide.
- **Nothing may be written into the repository root by a test.**
  `whole-graph.test.ts:206-231` asserts an untouched root as an exact set difference. Your
  only repo write is the measurement artifact, and it happens through the explicit
  regeneration branch.
- **Reproducibility hazards:** wall-clock stamps (freeze `Date`, P8), the `mkdtemp` path
  (never put an absolute temp path in the artifact — `capture.ts:164-170` redacts via
  `redactProjectRoot` from `src/orchestrator/workflow/conformance.js` if you need one),
  ledger costs, and superstep counts if concurrency is non-deterministic. Include a field
  only after you have seen it survive two runs.
- **Scope:** three files. No cap changes (sprint 3), no `PipelineResult` field (feat-3), no
  `docs/pge-graph.md` edit, no golden case added or re-captured.
