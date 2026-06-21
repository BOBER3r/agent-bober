# Collapse runSprintCycle's 7 positional params into a single typed options object

**Contract:** sprint-spec-20260621-codebase-health-remediation-2  ·  **Spec:** spec-20260621-codebase-health-remediation  ·  **Completed:** 2026-06-21

## What this sprint added

This sprint replaces `runSprintCycle`'s **7 positional parameters** with a single typed
**`RunSprintCycleParams`** options object — the second structural-health item from
`research-20260621-codebase-health-hotspots-cycles` (an over-long positional argument list that was
easy to mis-order at the call site). The function signature now takes `(params: RunSprintCycleParams)`,
the body gains exactly **one** destructure line, and all **6 invocations** (1 production + 5 test) were
converted to object literals. `runSprintCycle` stays **internal** (it is not exported from
`src/index.ts` and not exposed by any MCP tool), so there is **no public-API impact**. This is a
**pure mechanical refactor with zero behavior change**: 2815/2815 tests green.

## Public surface

`runSprintCycle` is **internal** to the orchestrator — no CLI command, flag, config key, or
`src/index.ts` / MCP export changed. The only new exported symbol is a type, added adjacent to the
function it describes:

- `RunSprintCycleParams` (**new** `export interface`, `src/orchestrator/pipeline.ts:158`) — carries the
  same 7 fields as the former positional list, with `pipelineRunId` optional:
  `{ contract: SprintContract; spec: PlanSpec; completedContracts: SprintContract[]; projectRoot: string; config: BoberConfig; projectContext: ProjectContext; pipelineRunId?: string }`.
  Field names mirror the former parameter identifiers exactly, so the body destructure is a drop-in.
- `runSprintCycle(params: RunSprintCycleParams)` (`src/orchestrator/pipeline.ts:168`) — signature changed
  from 7 positional params to the single object. The **only** added body line is the destructure at
  `pipeline.ts:171`: `const { contract, spec, completedContracts, projectRoot, config, projectContext, pipelineRunId } = params;`.
  Return type (`Promise<SprintCycleResult>`) and the entire retry/evaluator-iteration/contract-status/
  code-reviewer-and-documenter-spawning body are **unchanged**.

## How to use / how it fits

Nothing changes for the runtime. The sole production caller, `runTsPipeline`, now passes an object
literal at `src/orchestrator/pipeline.ts:936`:

```ts
const result = await runSprintCycle({
  contract,
  spec,
  completedContracts: completedSprints, // local var → field, by position
  projectRoot,
  config,
  projectContext,
  pipelineRunId,
});
```

Note the one non-identity mapping: the call site's local variable is `completedSprints`, which maps to
the `completedContracts` field (`pipeline.ts:939`) — preserving the former positional argument exactly.
All other fields use the matching local name. The 5 test call sites (in `code-reviewer-agent.test.ts`
and `documenter-agent.test.ts`, which exercise `runSprintCycle` directly via
`await import('./pipeline.js')`) were converted the same way to object literals.

## Notes for maintainers

- **Keep `runSprintCycle` internal.** The load-bearing invariant is that
  `grep -rnE 'runSprintCycle' src/index.ts src/mcp/` returns **zero** matches. Do not promote it to the
  public API or wrap it in an MCP tool as a side effect of touching the orchestrator.
- **Add new inputs as fields, not positional params.** Future inputs to the sprint cycle belong as new
  keys on `RunSprintCycleParams` (mark optional ones with `?`) — never re-introduce positional
  arguments. This is the whole point of the refactor.
- **The `completedSprints → completedContracts` mapping is intentional.** At the production call site the
  local is `completedSprints` but the field is `completedContracts`; that is the original semantics
  preserved by position. Don't "fix" the name mismatch by renaming the field — the field name mirrors the
  former parameter and matches the rest of the codebase's `completedContracts` usage.
- **Behavior is byte-identical aside from param access.** The contract forbade any logic change inside
  `runSprintCycle` (retry loop, evaluator iteration, contract-status updates, code-reviewer/documenter
  spawning) — the diff confirms the only in-body delta is the destructure line.
- **Scope.** The diff is confined to three files: `src/orchestrator/pipeline.ts`,
  `src/orchestrator/code-reviewer-agent.test.ts` (2 call sites: `:229`, `:333`), and
  `src/orchestrator/documenter-agent.test.ts` (3 call sites: `:229`, `:265`, `:299`). Build / typecheck /
  lint clean (2 pre-existing warnings only); `npx vitest run` → **2815/2815 passed** (219 files), no
  regressions. All 6 criteria (sc-2-1..sc-2-6) passed iteration 1. Commit `c7e721c`.
