# Additive pipeline plumbing + medical team registration

**Contract:** sprint-spec-20260616-medical-team-1  ·  **Spec:** spec-20260616-medical-team  ·  **Completed:** 2026-06-16

## What this sprint added

The integration linchpin for Phase 6 (the medical team). It threads a new
`medical-sop` orchestration engine name through every place the engine union
is mirrored — the `PipelineEngineName` TS union, both Zod enums, and both
exhaustive selector switches — and stands up a new `src/medical/` module with a
**stub** `MedicalSopEngine`, the `GuardrailSet` type surface, and a
`buildMedicalTeam` builder. `loadTeam(config, 'medical')` now resolves to a
built-in `medical` team whose `pipelineShape` is `medical-sop` and whose
`guardrails` slot holds a concrete (allow-all stub) `GuardrailSet`. This is
plumbing and skeleton only: no consent gate, red-flag detection, health store,
numerics, ingestion, egress, or retrieval — those land in S2–S7. Byte-zero
behavior change to the `ts`/`skill`/`workflow` engines and the programming team
was a hard requirement, verified by regression tests.

## Public surface

- `PipelineEngineName` (`src/orchestrator/workflow/engine.ts:7`) — union widened to `"ts" | "skill" | "workflow" | "medical-sop"`.
- `PipelineSectionSchema.engine` Zod enum (`src/config/schema.ts:220`) — widened to include `"medical-sop"` (still defaults to `"ts"`).
- `TeamConfigSchema.pipelineShape` Zod enum (`src/config/schema.ts:366`) — widened to include `"medical-sop"`, mirroring the TS union.
- `MedicalSopEngine` (`src/medical/engine.ts:22`) — class implementing `PipelineEngine`; `readonly name = "medical-sop"`; `run()` returns a trivial success `PipelineResult` (placeholder spec, empty sprint lists, `duration: 0`). No LLM calls, no SDK imports.
- `buildMedicalTeam(config)` (`src/medical/team.ts:55`) — returns the built-in `medical` `Team`: `id "medical"`, `displayName "Medical team"`, `memoryNamespace "medical"`, `providers: resolveRoleProviders(config)`, `pipelineShape "medical-sop"`, the 7 standard roles, and a stub `GuardrailSet`.
- `GuardrailSet` / `GuardrailVerdict` / `GuardrailContext` / `MedicalAnswer` / `Citation` (`src/medical/types.ts:11-39`) — shared medical type surface. `GuardrailSet.evaluate(prompt, ctx)` returns a `GuardrailVerdict` discriminated union (`allow` | `short-circuit` | `refuse`); `GuardrailContext`, `Citation` are placeholder interfaces with real fields landing in S3/S7.
- `loadTeam(config, "medical")` (`src/teams/registry.ts:42`) — new built-in branch routing the `medical` team id to `buildMedicalTeam`.

## How to use / how it fits

The `medical` team is a **code-registered built-in** (like `programming`), not a
`bober.config.json` `teams` entry. It is resolved by id:

```ts
import { loadTeam } from "./teams/registry.js";
const team = loadTeam(config, "medical"); // pipelineShape === "medical-sop"
```

At runtime, `selectPipelineEngineForTeam(team, config)` returns a
`MedicalSopEngine` when the team's `pipelineShape` is `medical-sop`
(`src/orchestrator/workflow/selector.ts:124`). The config-path selector
`selectPipelineEngine(config)` adds `medical-sop` as a **defensive
exhaustiveness branch** only — `config.pipeline.engine` is never legitimately
`medical-sop`, so it falls through to `TsPipelineEngine`
(`src/orchestrator/workflow/selector.ts:64`), leaving every programming path
unchanged while keeping the `never`-guarded switch exhaustive.

## Notes for maintainers

- **`medical-sop` is not a user config knob.** It is accepted by the Zod enums
  for type/schema lockstep with the TS union, but the medical team is reached
  via the built-in `loadTeam(config, "medical")` branch, not by setting
  `pipeline.engine` or a `teams.<id>.pipelineShape` to `medical-sop`. The README
  config comments deliberately still list only `ts | skill | workflow` as the
  user-facing engine choices.
- **Everything in `src/medical/` is a stub.** `MedicalSopEngine.run` returns a
  trivial result, `GuardrailSet.evaluate` always returns `{ kind: "allow" }`
  (`rulesetVersion "0.0.0"`), and `GuardrailContext`/`Citation` are empty
  placeholder interfaces. Real enforcement and fields land in later sprints
  (gates S2/S3, store + numerics S4, ingestion S5, egress + full SOP S6,
  literature retrieval S7).
- **`MEDICAL_ROLES` is an intentional inline copy** of the registry's
  `DEFAULT_ROLES` (`src/medical/team.ts`) to avoid a circular import
  (`registry.ts → medical/team.ts → registry.ts`). If team rosters diverge,
  extract to a shared module.
- **No SDK leakage:** `src/medical/` imports only types from `config/schema`,
  `orchestrator/pipeline`, and `orchestrator/workflow/engine`, plus
  `contracts/spec` and `config/role-providers` — no `@anthropic-ai/sdk` /
  `openai` imports (enforced by sc-1-8, an ESLint boundary follows in S6).
