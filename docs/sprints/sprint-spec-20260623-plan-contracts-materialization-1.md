# Extract shared deterministic `materializeContracts` helper

**Contract:** sprint-spec-20260623-plan-contracts-materialization-1  ·  **Spec:** spec-20260623-plan-contracts-materialization  ·  **Completed:** 2026-06-23

## What this sprint added

The first of a **3-sprint plan→contracts fix**. It pulls the inline contract-creation
loop out of `runTsPipeline` (`pipeline.ts`, the old `~856-906` block) into a new exported
async helper `materializeContracts(spec, projectRoot, config)` in
`src/orchestrator/contract-materialization.ts`. The pipeline now calls that one helper
(`pipeline.ts:853`) in place of the loop; the post-plan and post-sprint-contract audit
checkpoints **stay in the pipeline body**, on either side of the call. Contract content is
extracted **verbatim** — same `createContract` inputs (criteria mapped with
`verificationMethod: "agent-evaluation"`), same `generateContractPrecision` call, same log
strings, same order. The **sole behavioral change** is the contract id: feature-derived
contracts now get a **deterministic, zero-padded `sprint-<specId>-NN`** id instead of the
old non-deterministic `sprint-${Date.now()}-${counter}` default, so `listContracts()`
lexical (filename) ordering matches sprint execution order.

This is a refactor that **makes contract materialization reusable** so that a later sprint
can call the same helper from a standalone path. **It does not yet close the
plan→sprint standalone gap** — that wiring is **Sprint 2** (out of scope here; see
the contract's `nonGoals` / `outOfScope`). Sprint 3 scopes sprint-command contracts. As of
this sprint the helper has exactly **one caller**: `runTsPipeline`.

## Public surface

- `materializeContracts(spec: PlanSpec, projectRoot: string, config: BoberConfig): Promise<SprintContract[]>`
  (`src/orchestrator/contract-materialization.ts:32`) — creates and persists one
  `SprintContract` per feature in `spec.features`, returns them in feature / `sprintNumber`
  order. For each feature it calls `generateContractPrecision(feature, spec, config)`
  (planner LLM), builds the contract via `createContract(...)`, applies precision fields
  (`nonGoals` / `stopConditions` / `definitionOfDone` via the options object;
  `assumptions` / `outOfScope` set directly afterward), **overrides the id** to
  `sprint-${spec.specId}-${String(i + 1).padStart(2, "0")}`, and `saveContract`s it. The
  helper carries **no** `runWithAudit` / `appendHistory` / checkpoint logic — those are
  pipeline concerns and remain in `pipeline.ts`.

The helper is **orchestrator-internal**: it is imported directly by `pipeline.ts` and is
**not** re-exported from `src/index.ts` (the public package API). The pipeline no longer
imports `createContract`, `generateContractPrecision`, or `saveContract` directly — those
moved into the helper.

## How to use / how it fits

Inside `runTsPipeline`, the Phase-2 sprint-loop preamble is now a single call:

```ts
// ── Phase 2: Sprint loop ──
const contracts = await materializeContracts(spec, projectRoot, config);
await runWithAudit({ /* ... checkpointId: "post-sprint-contract" ... */ });
```

The `post-plan` checkpoint (`pipeline.ts:844`) fires before the call and the
`post-sprint-contract` checkpoint (`pipeline.ts:857`) fires after it with the returned
`contracts` array — identical arguments to before the refactor.

Because `listContracts()` sorts the contract JSON filenames lexically and contracts are
filed by `contractId`, the zero-padded ids make `-09` sort before `-10`, so for a 12-plus
sprint spec the listed order equals `sprintNumber` order without any extra sort.

## Notes for maintainers

- **Verbatim extraction + exactly one authorized behavior change.** Everything except the
  id assignment was moved unchanged. The id was previously `createContract`'s default
  (`sprint-${Date.now()}-${contractCounter}`, `sprint-contract.ts:164`); the helper now
  overrides it **after** construction. `createContract`'s default id is unchanged — only
  the materialization path overrides it.
- **The padding width is 2 (covers 1–99 sprints).** A `// bober:` comment in the helper
  flags that the `padStart(2, …)` must widen to 3 if a single spec ever exceeds 99 sprints,
  or lexical ordering would break again (`-099` vs `-100`).
- **Checkpoints intentionally stay in the pipeline.** The helper has zero checkpoint /
  audit / history references by design (per the contract's `evaluatorNotes`). Keep audit
  wiring at the call site, not inside `materializeContracts`.
- **Precision fields are still LLM-generated, fail-soft.** `generateContractPrecision` is
  an async planner call; on failure the helper logs a warning and emits a placeholder
  contract that the generator's precision preflight may block — same as before. Tests mock
  this call.
- **Sprint 2 is the standalone `plan`-command wiring; Sprint 3 scopes sprint-command
  contracts.** This sprint is the extraction step only — do not document a standalone
  plan→contract path as shipped yet.
- **Scope.** Three files: `src/orchestrator/contract-materialization.ts` (new),
  `src/orchestrator/pipeline.ts` (loop → one call, dead imports removed), and
  `src/orchestrator/contract-materialization.test.ts` (new — characterization parity,
  deterministic-id, and 12-sprint ordering tests against a tmp dir, mocking only
  `generateContractPrecision`). Commit `1a7cd2b`. Full suite 2364 passed; the 6 pre-existing
  `tests/e2e/cockpit-integration.test.ts` MCP failures are unrelated and not a regression.
