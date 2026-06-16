# Teams: Adding a Team is Data, Not Code

This guide covers the agent-bober team abstraction introduced in Phase 4
(Sprint 1–4 of the domain-agnostic team platform plan). A "team" is a pure
data object in `bober.config.json` — no code change, no new pipeline engine.

See the research document at
`.bober/research/20260614-chattable-team-of-agents-platform.md` (Phase 4,
lines 290–330) for the full motivation and architecture.

---

## What Is a Team?

A team is a named configuration entry that declares three differentiation axes:

| Axis | Config Field | Effect |
|---|---|---|
| **Provider routing** | `providers` | Partial role-to-provider override (unset roles keep the resolved project defaults). |
| **Memory namespace** | `memoryNamespace` | Lessons land in `.bober/memory/<namespace>/` instead of the shared `.bober/memory/`. |
| **Pipeline shape** | `pipelineShape` | Which orchestration engine to use: `"ts"` (default), `"skill"`, or `"workflow"`. |

The built-in **programming** team is always available and uses the default
memory path, the project's default providers, and the `"ts"` engine. Omitting
`--team` or `[team]` selects it automatically.

---

## Config Shape

Declare teams under the top-level `teams` key in `bober.config.json`:

```jsonc
{
  "defaultTeam": "programming",   // Optional. Active team when --team / chat <team> omitted.
  "teams": {
    "example": {
      "displayName": "Example research team",  // Human-readable label (optional)
      "memoryNamespace": "example",            // Lessons land in .bober/memory/example/
      "pipelineShape": "ts",                   // "ts" | "skill" | "workflow"
      "providers": {                           // Partial override — unset roles keep defaults
        "chat": "openai"
      }
    }
  }
}
```

All fields under `teams.<id>` are optional. Unspecified fields inherit the
project defaults resolved by `loadTeam` (`src/teams/registry.ts`).

**`memoryNamespace` constraint:** must match `/^[a-z0-9_-]+$/i` (schema
validation). No slashes, spaces, or dots.

---

## The Three Differentiation Axes

### 1. Provider Routing

Each role (`planner`, `generator`, `evaluator`, `curator`, `chat`, etc.) can
be independently overridden. Roles not listed in `providers` keep the project
default from `resolveRoleProviders`.

```jsonc
"providers": {
  "chat": "openai",       // Chat role uses OpenAI
  "planner": "google"     // Planner role uses Google
  // generator, evaluator, etc. keep project defaults
}
```

### 2. Memory Namespace

Lessons distilled during a team's session land in
`.bober/memory/<memoryNamespace>/` — a sibling directory to the programming
team's `.bober/memory/`.

The programming team uses the sentinel value `""` (empty string), which maps
to the root `.bober/memory/` path. No `programming/` subdirectory is ever
created — this is intentional back-compat behavior.

### 3. Pipeline Shape

Selects the orchestration engine for sprints driven by this team:

| Value | Engine | Use case |
|---|---|---|
| `"ts"` (default) | TypeScript pipeline | Standard feature development |
| `"skill"` | Skill-based engine | Skill-driven sub-tasks |
| `"workflow"` | Workflow engine | Local-model dynamic workflow runtime |
| `"medical-sop"` | Medical SOP engine | Built-in `medical` team only (Phase 6) — see note below |

> **`"medical-sop"` is not a user config knob.** It is accepted by the
> `pipelineShape` schema (so the Zod enum stays in lockstep with the
> `PipelineEngineName` TS union), but the medical team is a **code-registered
> built-in** reached via `loadTeam(config, "medical")`, not by hand-setting
> `pipelineShape: "medical-sop"` on a config team. As of Phase 6 Sprint 1 the
> `MedicalSopEngine` is a stub — the real medical SOP (consent/red-flag gates,
> numerics, retrieval) lands in later sprints.

---

## CLI Usage

### `bober run --team <id>`

Select a team for the full autonomous pipeline run:

```bash
npx agent-bober run "add research summary" --team example
```

The `--team` flag is additive. Omitting it runs the programming team unchanged:

```bash
npx agent-bober run "implement feature X"   # programming team (default)
```

The team id is threaded to `runPipeline` as `opts.teamId`, which calls
`loadTeam(config, teamId)` to resolve the full team object and select the
appropriate pipeline engine.

### `bober chat [team]`

Select a team for an interactive chat session:

```bash
npx agent-bober chat example   # chat session routed to the example team
npx agent-bober chat           # programming team (default)
```

The session's `buildMemoryDistill` reads from the team's namespace so the LLM
sees only that team's lessons as context. Spawned `bober run` children inherit
the session's run-id but not yet the team id (see Deferred Features below).

---

## Built-in Programming Team

The programming team is always available and requires no config entry. It is
the fallback when:

- `--team` is omitted from `bober run`
- `[team]` positional arg is omitted from `bober chat`
- `config.defaultTeam` is unset

Its properties:

- `id`: `"programming"`
- `memoryNamespace`: `""` (maps to `.bober/memory/`, the root memory path)
- `pipelineShape`: derived from `config.pipeline.engine`
- `providers`: the full resolved project defaults from `resolveRoleProviders`

---

## Deferred Features

The following are documented here for awareness but are NOT yet implemented:

### `.bober/teams/*.json` File Registry (Option A — Deferred)

A future sprint will support defining teams in individual JSON files under
`.bober/teams/<id>.json` instead of embedding them in `bober.config.json`.
This allows version-controlling team definitions separately and loading them
without modifying the main config. Reference: research doc Phase 4, line 295.

### Spawned-Run Team Propagation (Deferred)

`bober chat <team>` routes the chat session's `buildMemoryDistill` to the
team's namespace. Spawned `bober run` children (triggered by chat) do not yet
carry `--team <id>` in their argv — they run on the programming team by
default. A future sprint will thread `teamId` through `RunSpawnerOptions` so
spawned children inherit the active chat team.

### Guardrails (Phase 6 — In Progress)

The `guardrails` field on a resolved `Team` (`src/teams/types.ts`) holds a
`GuardrailSet` — a rule set that guards medical prompts before the LLM call.
As of Phase 6 Sprint 1 the built-in `medical` team fills this slot with a
**stub** allow-all `GuardrailSet` (`rulesetVersion "0.0.0"`,
`evaluate(...) -> { kind: "allow" }`); the type surface lives in
`src/medical/types.ts` (`GuardrailSet` / `GuardrailVerdict` /
`GuardrailContext`). Real `evaluate` logic — red-flag detection, refusals,
canned short-circuit responses — lands in Sprint 3. Every other team's
`guardrails` slot remains `undefined`, and no current code path reads or
enforces it.

---

## How `loadTeam` Works

`src/teams/registry.ts` exports `loadTeam(config, teamId?)`:

1. If `teamId` is `undefined` or `"programming"` — return the built-in
   programming team.
2. If `teamId` is `"medical"` — return the built-in medical team
   (`buildMedicalTeam(config)`, `pipelineShape "medical-sop"`, Phase 6). Like
   `programming`, this is a code-registered built-in, not a config entry.
3. If `teamId` is a key in `config.teams` — build a `Team` object from the
   config entry, merging partial `providers` over the resolved project defaults.
4. Otherwise — throw `Unknown team '<id>'` (fast-fail at call site).

The two built-in teams (`programming`, `medical`) are the only id-specific
branches. Any team you declare in `config.teams` flows through the config path
the same way the example team does — that is the "adding a *config* team is
data, not code" invariant. A built-in like `medical` carries code (its own
engine + guardrails) because it ships a new pipeline shape, not just a
data overlay.

---

## Adding a New Team (Step by Step)

1. Add an entry to `bober.config.json` under `"teams"`:

   ```jsonc
   "teams": {
     "my-team": {
       "displayName": "My new team",
       "memoryNamespace": "my-team",
       "pipelineShape": "ts",
       "providers": { "chat": "openai" }
     }
   }
   ```

2. Optionally set it as the default:

   ```jsonc
   "defaultTeam": "my-team"
   ```

3. Use it:

   ```bash
   npx agent-bober run "build feature" --team my-team
   npx agent-bober chat my-team
   ```

4. Lessons will accumulate in `.bober/memory/my-team/` — fully isolated from
   the programming team's lessons.

No code changes required. No deployment step. The team is available
immediately after editing `bober.config.json`.
