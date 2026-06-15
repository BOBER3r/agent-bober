# Team-aware pipeline-shape selection

**Contract:** sprint-spec-20260615-team-abstraction-3  ·  **Spec:** spec-20260615-team-abstraction  ·  **Completed:** 2026-06-15

## What this sprint added

The runtime half of Phase 4: the pipeline engine is now resolved from the **active
team's `pipelineShape`** instead of solely from global config. A new team-aware seam in
`src/orchestrator/workflow/selector.ts` (`resolveEngineNameForTeam` +
`selectPipelineEngineForTeam`) takes `team.pipelineShape` as the *requested* engine and
then runs it through the **same** eligibility + `'careful'`-mode downgrade pipeline as the
legacy `resolveEngineName`/`selectPipelineEngine` — the downgrade log line is
byte-identical. `runPipeline` now resolves the active team via
`loadTeam(config, opts.teamId ?? config.defaultTeam)` (additive optional `opts.teamId`,
default `'programming'`) and selects the engine from that team's shape. The
programming / no-team path is **byte-for-byte today's behavior** by construction
(the programming team's `pipelineShape === resolveEngineName(config)`, set in Sprint 1);
`selectPipelineEngine`/`resolveEngineName` are unchanged.

## Public surface

- `resolveEngineNameForTeam(team, config): PipelineEngineName` (`src/orchestrator/workflow/selector.ts:75`) — pure resolver. Uses `team.pipelineShape` as the requested engine; if `'workflow'` is requested but the config is ineligible (`isWorkflowEligible`) or `pipeline.mode === 'careful'`, downgrades to `'ts'` with one log line byte-identical to `resolveEngineName`'s. Otherwise returns the shape verbatim (`'ts' | 'skill' | 'workflow'`).
- `selectPipelineEngineForTeam(team, config): PipelineEngine` (`src/orchestrator/workflow/selector.ts:103`) — instantiates the engine for a team via `resolveEngineNameForTeam` over the same exhaustive `PipelineEngineName` switch (`'ts'`/`'skill'` → `TsPipelineEngine`, `'workflow'` → `WorkflowEngine`). For the programming team this is equivalent to `selectPipelineEngine(config)`.
- `runPipeline(userPrompt, projectRoot, config, opts?)` — `opts` gains optional `teamId?: string` (`src/orchestrator/pipeline.ts:980`). Resolves `teamId = opts?.teamId ?? config.defaultTeam`, loads the team (`loadTeam`), and selects the engine from its shape (`src/orchestrator/pipeline.ts:982-984`). The frozen positional signature is preserved; the only non-test caller (`src/cli/commands/run.ts`) passes `{ runId }` and is unaffected.

## How to use / how it fits

`runPipeline` is the single public entry point; team selection is opt-in and additive.
With no team specified it resolves to `'programming'` and behaves exactly as before:

```ts
// No team → 'programming' → byte-for-byte today's engine selection.
await runPipeline(prompt, root, config);

// Explicit team override (or set config.defaultTeam) drives the engine from its shape.
await runPipeline(prompt, root, config, { teamId: "ops" });
```

Engine resolution remains belt-and-suspenders: a team declaring `pipelineShape: 'workflow'`
only reaches `WorkflowEngine` when the config is eligible *and* not in `'careful'` mode;
otherwise `resolveEngineNameForTeam` downgrades to `'ts'` (one log line) before instantiation.
Eligibility (`isWorkflowEligible`) and the `'careful'` downgrade are evaluated against
`config`, exactly as in the legacy path — the team's shape only chooses the *requested*
engine name.

## Notes for maintainers

- **Programming / no-team is unchanged by construction.** `loadTeam(config)` and
  `loadTeam(config, 'programming')` carry `pipelineShape === resolveEngineName(config)`
  (Sprint 1, `registry.ts`), so `selectPipelineEngineForTeam(programmingTeam, config)`
  selects the same engine class as `selectPipelineEngine(config)`. The legacy
  `selectPipelineEngine`/`resolveEngineName` functions were **not** modified — they remain
  for back-compat and are still exported.
- **The downgrade log line is duplicated, not shared.** `resolveEngineNameForTeam`
  intentionally inlines the same `logger.info(...)` string as `resolveEngineName` so the
  two paths emit byte-identical output; if you ever edit one, edit both.
- **`'skill'` still falls through to `TsPipelineEngine`** — no skill engine exists (a
  standing non-goal), same as the legacy switch.
- **Out of scope this sprint:** no new engine or medical SOP, no memory-namespacing
  changes (Sprint 2), and **no CLI `--team` flag or example team** — surfacing `teamId`
  on the `bober run` command line, an example declared team, and the user-facing
  "adding a team is data, not code" docs are deferred to Sprint 4. `runPipeline`'s
  `opts.teamId` is the programmatic seam those will build on.
