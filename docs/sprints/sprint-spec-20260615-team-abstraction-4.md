# Second team as data + CLI wiring + docs (the platform proof)

**Contract:** sprint-spec-20260615-team-abstraction-4  ·  **Spec:** spec-20260615-team-abstraction  ·  **Completed:** 2026-06-15

## What this sprint added

The capstone of Phase 4: it proves end-to-end that **adding a team is data, not
code**. A minimal non-medical `example` team is defined purely as a `teams` config
entry — there is **no `'example'` code branch anywhere in production `src/`** (verified
by grep); it flows through the existing `loadTeam` resolver from Sprint 1. Team
selection is now wired into both CLIs: `bober run` gains an additive `--team <id>` flag
(mirroring Phase 1's `--run-id`) threaded into `runPipeline`'s `opts.teamId`, and
`bober chat [team]` finally **resolves** the previously-ignored positional argument via
`loadTeam` and routes the session's memory namespace into `ChatSession`. End to end, a
lesson produced while the `example` team is active lands in `.bober/memory/example/`,
isolated from the programming path; omitting the flag uses the `programming` team with
byte-for-byte unchanged behavior. The generator also authored the user-facing docs (see
links below). This sprint completes the plan (4 of 4).

## Public surface

- `bober run --team <id>` (`src/cli/index.ts:221`) — new additive CLI option registered right after `--run-id`; collected into `cmdOpts.team` and passed to `runRunCommand`. Absent => `config.defaultTeam` then `'programming'` (today's behavior).
- `RunCommandOptions.team?: string` (`src/cli/commands/run.ts:29`) — new optional field; `runRunCommand` threads it as `teamId: options.team` into `runPipeline` and logs `Team: <id>` only when set (`src/cli/commands/run.ts:150`).
- `bober chat [team]` (`src/cli/commands/chat.ts:27`) — the optional positional `team` argument is no longer ignored: the handler calls `loadTeam(config, team)` and passes `memoryNamespace: activeTeam.memoryNamespace || undefined` into `ChatSession`, so the session's `buildMemoryDistill` and spawned runs route to that team's namespace. Omitting it => `programming` (default `.bober/memory/` path).
- The `example` team — declared purely as a `teams` config entry (in test fixtures + the docs), **not** as code. `loadTeam(config, 'example')` returns its declared `memoryNamespace` (`'example'`), `pipelineShape` (`'ts'`), and merged providers; an unknown team id still throws.
- `teams` / `defaultTeam` config fields — now surfaced in the README **Full Configuration Reference** for the first time (they were intentionally held back in Sprints 1–2 until user-facing this sprint).

## How to use / how it fits

This sprint adds no new abstraction — only CLI flags, an example fixture, routing, and
docs. It stitches together S1's resolver, S2's namespacing, and S3's pipeline-shape
selection behind two user-facing entry points:

```bash
# Run the pipeline under a declared team (its providers / shape / memory namespace).
bober run "add a feature" --team example

# Default (no flag) => programming team, unchanged.
bober run "add a feature"

# Start a chat session bound to a team; lessons distill into that team's namespace.
bober chat example
```

The end-to-end proof is the memory routing: a lesson written during an active
`example`-team chat session lands under `.bober/memory/example/`, not the default
`.bober/memory/` path, and is invisible to the default loader (bidirectional isolation,
asserted with real temp dirs in `chat.test.ts`).

The **user-facing** "how to add a team" documentation produced by this sprint lives in
[`docs/teams.md`](../teams.md) (the three differentiation axes — provider routing /
memory namespace / pipeline shape — the `teams` config shape, CLI usage, the built-in
`programming` default, and the deferred `.bober/teams/*.json` file registry) and the
**Teams** section + `teams`/`defaultTeam` config reference in
[`README.md`](../../README.md). This record intentionally links to those docs rather than
duplicating them.

## Notes for maintainers

- **The whole point: `example` is config, not code.** There is no `if (teamId === 'example')`
  branch in production `src/` — the team resolves uniformly through `loadTeam`
  (`registry.ts`). The `example` team is a minimal **validation fixture**, not a second
  production team (a standing non-goal); it reuses `pipelineShape: 'ts'` with a distinct
  namespace + provider override as sufficient proof.
- **`--team` is strictly additive.** Absent `--team` => `teamId` is `undefined`, and
  `runPipeline` falls back to `config.defaultTeam ?? 'programming'` (Sprint 3) — existing
  `bober run` invocations are unchanged. The `Team: <id>` log line is emitted only when the
  flag is set.
- **`bober chat`'s namespace collapse.** `activeTeam.memoryNamespace || undefined` maps the
  programming sentinel (`''`) back to `undefined`, so the default chat session keeps the
  existing `.bober/memory/` path; a named team yields its own subdir.
- **Plan complete — deferred items are out of scope, by design.** Phase 4's plan ends here.
  Still deferred (and explicitly non-goals of this plan): the medical team + guardrail
  enforcement (Phase 6), the `.bober/teams/*.json` file registry (Option A config only —
  documented as deferred in `docs/teams.md`), and `semantic_facts` / memory hygiene
  (Phase 3).
- **History note:** a first generator attempt crashed on a transient API socket error with
  no commit (the partial work was reverted); a clean redo passed iteration 1 on commit
  `8204a32`. Final suite: 1977 tests passing (+16 over the 1961 baseline), zero
  regressions.
