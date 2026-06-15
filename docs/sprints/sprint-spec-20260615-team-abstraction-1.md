# Team data model + registry + programming team as instance #1

**Contract:** sprint-spec-20260615-team-abstraction-1  ·  **Spec:** spec-20260615-team-abstraction  ·  **Completed:** 2026-06-15

## What this sprint added

The foundation of the domain-agnostic team abstraction (Phase 4): a new `src/teams/`
module with a `Team` data type and a `loadTeam(config, teamId?)` resolver, plus a
built-in `programming` team registered in code. With no id (or `'programming'`),
`loadTeam` reproduces today's behavior **exactly** — providers come from
`resolveRoleProviders`, `pipelineShape` from `resolveEngineName`, and `memoryNamespace`
is the `''` sentinel that maps to the current `.bober/memory/` path. `BoberConfigSchema`
gains two optional, back-compat fields — a `teams` record and a `defaultTeam` string — so
declared teams can be resolved with partial provider overrides merged over the resolved
defaults. This sprint is purely additive resolution + schema: it does **not** namespace
memory, change pipeline-shape selection, or wire any CLI flag yet.

## Public surface

- `Team` interface (`src/teams/types.ts:21`) — the resolved shape the pipeline needs: `{ id, displayName, memoryNamespace, providers: RoleProviderMap, pipelineShape: PipelineEngineName, roles: Role[], guardrails?: unknown }`. Pure types; no execution logic.
- `Role` interface (`src/teams/types.ts:14`) — descriptor metadata (`name: RoleName`, `displayName`) for the 7 role values. Does **not** drive execution this sprint.
- `loadTeam(config, teamId?): Team` (`src/teams/registry.ts:34`) — resolves a `Team` from a `BoberConfig`. No id / `'programming'` returns the built-in programming team; a declared id returns a team built from `config.teams[id]`; an unknown id throws a named `Error`.
- `TeamConfigSchema` Zod schema + `TeamConfig` type (`src/config/schema.ts:361`) — one team entry, all fields optional: `displayName?`, `memoryNamespace?` (safe path segment `^[a-z0-9_-]+$/i`), `pipelineShape?` (`"ts" | "skill" | "workflow"`), `providers?` (partial role → provider record), `roles?`, `guardrails?` (`z.unknown()`).
- `teams?` and `defaultTeam?` fields on `BoberConfigSchema` (`src/config/schema.ts:401-402`) — optional `teams: Record<string, TeamConfig>` and optional `defaultTeam: string`. Both absent is still valid (back-compat); `createDefaultConfig` emits neither.

## How to use / how it fits

`loadTeam` is the single entry point for resolving a team from config. Today only the
built-in default path is meaningful at runtime — the resolver carries `memoryNamespace`
and `pipelineShape`, but nothing consumes them yet (see Notes).

```ts
import { loadTeam } from "./teams/registry.js";

// Default path — deep-equals today's resolved providers + engine + memory path.
const team = loadTeam(config);            // { id: 'programming', memoryNamespace: '', ... }

// A declared team: partial provider override merged over resolved defaults.
// config.teams = { docs: { memoryNamespace: 'docs', providers: { generator: 'deepseek' } } }
const docs = loadTeam(config, "docs");    // providers.generator === 'deepseek',
                                          // providers.planner === resolved default,
                                          // memoryNamespace === 'docs'

loadTeam(config, "nope");                 // throws Error naming 'nope'
```

Provider routing is reused, not reimplemented: declared teams start from
`resolveRoleProviders(config)` and spread the entry's partial `providers` on top, so
unspecified roles keep the resolved default. No provider SDK is imported under
`src/teams` (verified: no `@anthropic-ai/sdk` / `openai` imports).

## Notes for maintainers

- **Zero behavior change is the hard requirement of this sprint.** `resolveRoleProviders`,
  `resolveEngineName`, `runPipeline`, `selectPipelineEngine`, and the memory store are all
  untouched. `loadTeam` is not yet wired into the runtime pipeline beyond compiling.
- **`memoryNamespace: ''` is a sentinel**, not a real namespace. Sprint 2 maps `''` to the
  existing `.bober/memory/` path; until then the value is stored but unused.
- **`pipelineShape` is carried but not selected at runtime** — Sprint 3 will wire it into
  pipeline-shape selection. **`roles`** is descriptor metadata only this sprint, and
  **`guardrails`** is a forward-compat optional field (unused; medical is a later phase).
- **CLI `--team` flags, a second example team, and the platform-facing "adding a team is
  data, not code" documentation are deliberately deferred to Sprint 4.** The
  `teams` / `defaultTeam` config fields are therefore intentionally **not** yet listed in
  the README Full Configuration Reference (matching how other not-yet-user-facing optional
  sections like `chat` are kept out of that block until wired).
- `TeamConfigSchema.providers` is typed as `z.record(z.string(), z.string())` (keys
  *should* be `RoleName` values but are not enum-constrained), so an unknown role key in
  config parses; the merge in `loadTeam` simply spreads it over the resolved map.
