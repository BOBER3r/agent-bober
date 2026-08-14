# Observe what a real 29 KB plan actually does to the graph engine

**Contract:** sprint-spec-20260812-pge-real-workload-errors-1  ·  **Spec:** spec-20260812-pge-real-workload-errors  ·  **Completed:** 2026-08-12

## What this sprint added

The first **measurement** of `PgeEngine` against a workload that is not a fixture. A harness
drives a real `PgeEngine` over the committed `.bober/topology/coding.json`, with this
repository's own committed 14-sprint `PlanSpec` (`spec-20260805-pge-graph-engineering` — the
plan that built the graph engine) as the planner's output, every effect answered from a stub
and `fetch` replaced by a throwing implementation. What the run does is committed as data in
`.bober/topology/measurements/real-workload.json`.

**Nothing is fixed here.** The sprint's entire value is that the remaining eight sprints of
this spec act on an observation rather than on a chain of inferences. The measurement records
that `plan_materialize`'s writes to **both** the `spec` (29,214 canonical bytes) and
`sprintContracts` (135,106 canonical bytes) channels are **rejected** at superstep 12 against
the 4,096-byte cap every channel in the committed artifact declares; the run reaches the
terminal node `graceful_failure` with `status: "completed"` / `verdict: "failed"`;
`state.spec` is still `null` at the finalize boundary; and `PgeEngine.run`'s own
`commit.finalize` call therefore throws `FinalizeWithoutSpecError` rather than returning a
`PipelineResult`.

## Public surface

- **`.bober/topology/measurements/real-workload.json`** (new committed artifact) — the
  measurement itself, `formatVersion: 1`. Fields: `graph` (`graphId`/`graphVersion`),
  `workload` (`specPath`, `specId`, `specCanonicalBytes`, `contractCount`,
  `contractsCanonicalBytes`), `channelLimits` (all ten channels, each 4096), `rejections[]`
  (`channel`, `nodeId`, `branchKey`, `bytes`, `limit`, `superstep`), `failures[]` (`nodeId`,
  `branchKey`, `superstep`, `errorClass`), `terminalNodeId`, `status`, `verdict`,
  `specChannelNullAtBoundary`, `engineOutcome`.
- **`src/pge/engine/real-workload.test.ts`** (new) — the harness and its four tests. Every
  non-`MEASURE` run re-derives the measurement and asserts the committed bytes are unchanged,
  so the artifact is a pinned expectation, not a snapshot someone took once.
- **`realWorkload()` / `realPlanSpec()` / `realContracts(spec)` / `realWorkloadBindings(input, workload)`**
  (`src/pge/engine/__fixtures__/real-workload.ts`) — load the real spec and the 14 real
  contracts named by `spec.sprints` (read from `.bober/contracts/`, never hand-listed), and
  build `wholeGraphBindings` with **only** `planner` and `materialize` replaced. Every other
  collaborator is the shipped whole-graph fixture body, so anything observed downstream of the
  plan region is attributable to the byte caps and not to a second fixture.
- **`MEASURE_REAL_WORKLOAD=1`** (env var) — regenerating the committed measurement is a
  deliberate act:
  `MEASURE_REAL_WORKLOAD=1 npx vitest run src/pge/engine/real-workload.test.ts`. Unset, the
  test compares instead of writing; it never skips.

## How to use / how it fits

The measurement is the instrument the rest of `spec-20260812-pge-real-workload-errors` is
evidenced by: sprint 3 sizes the caps to measured reality, and sprint 4 regenerates this same
file so the fix shows up as the disappearance of the very rejections that found the defect.
Read the artifact first; re-derive it with the command above only when the inputs genuinely
changed.

The one thing that decides the harness: `PgeEngine.run` computes the interpreter's own
`GraphRunResult` and then **discards** its `.verdict` and `.failures` before returning a
`PipelineResult` (the recorded limitation at `src/pge/engine/pge-engine.ts:461-475`). A
harness that only inspected the returned `PipelineResult` would observe nothing at all. So
`PgeEngine.run` is what is driven — sc-1-1 requires a real engine — and the interpreter's own
result is captured through the engine's shipped `PgeEngineDeps.interpreterFactory` seam, never
through a private reimplementation of `run()`. The terminal node is read from the trace spans,
because `GraphRunResult` carries no terminal-node field; the harness's header says so.

## Notes for maintainers

- **The measurement contradicted the spec's prose, and the prose lost.** The spec asserted the
  14 contracts totalled 138,284 bytes as one `sprintContracts` update; that figure was naive
  `JSON.stringify`, and the metric the commit boundary actually checks is
  `canonicalJson` (`src/pge/runtime/commit.ts:257-259`), which measures **135,106**. Per
  sc-1-5 the measurement was committed unchanged and only
  `.bober/specs/spec-20260812-pge-real-workload-errors.json`'s `assumptions[5]` was corrected,
  in the same commit. Every structural claim held exactly.
- **Three guards keep the harness from passing for the wrong reason**, and they are worth
  keeping if this file is ever refactored: (1) the loaded graph is asserted to be the committed
  `coding` artifact with **every** channel still at 4096 — the runtime's own fixture graph
  (`src/pge/runtime/__fixtures__/golden-graph.ts:360,366`) raises `spec` to 8192 and
  `sprintContracts` to 65536 and would show fewer rejections while looking healthier; (2) a
  span assertion proves `plan_materialize` genuinely ran, so an empty rejection list could
  never be an artefact of the node never being reached; (3) a separate test refuses a
  collaborator and asserts the run fails **by name** with `GoldenBindingInvokedError`, proving
  the network and collaborator doors are shut.
- **The harness reads each channel's own declared limit, not one constant.** A test raises the
  `spec` cap in a *throwaway copy* of the artifact (re-signed through the shipped
  `checksumTopology`, so it is a legitimate artifact rather than one `readValidatedTopologySpec`
  would refuse) and asserts exactly the `spec` rejection disappears while `sprintContracts`
  survives. No cap in the committed artifact was raised — that is sprint 3.
- **Advisory carried from the evaluator (no action this sprint):** sc-1-3's prose names
  `GraphRunResult` as the source for the terminal node, but that type has no terminal-node
  field, so it is read from the trace. If a future sprint changes `GraphRunResult`'s shape,
  weigh adding an explicit terminal-node field against widening the interpreter's public
  surface.
- Suite 6856 → **6860** (+4), zero regressions; typecheck, typecheck:tests, lint and build all
  green. Commit `5190f7d`.
