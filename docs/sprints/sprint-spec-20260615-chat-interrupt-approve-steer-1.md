# RunState grammar + careful-mode chat spawn + /careful toggle

**Contract:** sprint-spec-20260615-chat-interrupt-approve-steer-1  ·  **Spec:** spec-20260615-chat-interrupt-approve-steer  ·  **Completed:** 2026-06-15

## What this sprint added

The foundation ("spine") for mid-flight human-in-the-loop control of chat-launched
runs. Three additive pieces land here: (1) the `RunState` status grammar gains
`'input-required'` and `'paused'` plus four optional pending/pause fields, so a future
sprint can represent a run that is blocked at a gate; (2) `bober run` gains an additive
`--approve-gates <comma-list>` flag that turns on disk checkpoints for **only** the named
gates for that one run; and (3) a session-persisted `/careful on|off` chat toggle that
makes `RunSpawner` launch the detached child with a curated `--approve-gates` list. None
of these change autopilot behavior — with careful off (the default), a chat spawn's
argument vector is byte-for-byte identical to Phase 1. The read/surface, write/resolve,
guidance, and pause/resume paths are deliberately out of scope (Sprints 2–6).

## Public surface

- `RunState.status` union (`src/mcp/run-manager.ts:38`) — extended additively from
  `running | completed | failed | aborted` to also include `input-required | paused`.
- `RunState.pendingCheckpointId?` / `pendingPrompt?` / `pendingSince?` / `pausedAt?`
  (`src/mcp/run-manager.ts:57-63`) — optional fields a paused/blocked run carries; they
  round-trip through the existing `writeRunState` / `readRunState` (no serializer change
  was needed, only the type). Unused/unwritten by this sprint's runtime paths.
- `bober run --approve-gates <gates>` CLI flag (registered in `src/cli/index.ts:225`;
  handled in `src/cli/commands/run.ts:144`) — comma-separated checkpoint ids; merges
  `{ gate -> 'disk' }` into `config.pipeline.checkpointOverrides` for that run only. Does
  **not** set `--mode careful`; the override alone activates just the named gates.
- `KNOWN_CHECKPOINT_IDS` (`src/cli/commands/run.ts:15`) — exported readonly list of valid
  approve-gate names, sourced from `CHECKPOINT_SITES` (`src/orchestrator/checkpoints/sites.ts`):
  `post-research`, `post-plan`, `post-sprint-contract`, `pre-curator`, `pre-generator`,
  `pre-evaluator`, `pre-code-reviewer`, `post-sprint`, `end-of-pipeline`. Unknown gate
  names are rejected with a clear error and **no partial merge** (`process.exitCode = 1`).
- `RunCommandOptions.approveGates?: string` (`src/cli/commands/run.ts:38`) — the parsed
  flag value on the run-command options object.
- `CarefulSidecar` class (`src/chat/careful-sidecar.ts:13`) — persists the per-session
  careful flag at `.bober/chat/<sessionId>.careful.json`. `isCareful(): Promise<boolean>`
  (missing/malformed file => `false`, never throws) and `setCareful(on): Promise<void>`
  (writes mode `0o600`).
- `/careful [on|off]` chat slash command (`src/chat/slash-commands.ts:75`) — `on` / `off`
  toggle the sidecar; no arg reports current state. Dispatched via an optional
  `carefulHandler` 4th param on `dispatch(...)` (`src/chat/slash-commands.ts:46`), so
  existing 2-/3-arg callers keep working; absent handler => "Careful mode is unavailable."
- `RunSpawner.spawn(task, runId, opts?)` (`src/chat/run-spawner.ts:97`) — new optional 3rd
  param `{ careful?: boolean } = {}`. When `careful` is true, appends
  `--approve-gates post-research,post-plan,post-sprint` to the child args.

## How to use / how it fits

In a chat session, toggle approval gates on for future runs:

```
> /careful on            # → "Careful mode ON — new runs will pause at curated gates."
> build a settings page  # detached run launches with --approve-gates post-research,post-plan,post-sprint
> /careful               # → reports current state
> /careful off           # back to autopilot
```

`ChatSession` reads `carefulSidecar.isCareful()` at spawn time and passes it into
`RunSpawner.spawn` (`src/chat/chat-session.ts:169`), so the toggle takes effect on the
**next** run launched, per session. Equivalently, from the CLI directly:

```bash
bober run "feature" --approve-gates post-research,post-plan,post-sprint
```

The merged `'disk'` overrides cause those checkpoints to write
`.bober/approvals/<checkpointId>.pending.json` pending markers (handled by the existing,
unchanged `DiskCheckpointMechanism`). After this sprint those curated gates actually fire
pending markers for a careful chat-launched run.

## Notes for maintainers

- **Autopilot byte-for-byte invariant.** With careful off (default), `RunSpawner.spawn`
  builds the exact Phase 1 arg vector — no `--approve-gates` is appended. This is the
  stop-condition for the sprint and is guarded by a canary in `src/chat/run-spawner.test.ts`.
  Do not let later refactors slip an extra arg into the default path.
- **Single careful run at a time (intentional limitation, per the spec).** The careful
  flag is a single per-session sidecar; concurrent careful runs from one session are not
  modeled here. The pending-surface / resolve / pause-resume machinery that would make
  concurrency meaningful arrives in Sprints 2–6.
- **The new `RunState` fields are grammar only.** `pendingCheckpointId` / `pendingPrompt`
  / `pendingSince` / `pausedAt` and the `input-required` / `paused` statuses are defined
  and round-trip, but nothing in this sprint writes them. They exist so Sprints 2–5 can
  populate them without re-touching the type. If you add an exhaustive `switch` on
  `RunState.status`, account for the two new variants (`noFallthroughCasesInSwitch` is on).
- **Non-goals respected.** No changes to `DiskCheckpointMechanism`, `approval-state.ts`,
  the existing `approve`/`reject` CLI, the pipeline algorithm, or autopilot spawn behavior.
- **`--approve-gates` does not force `--mode careful`.** Merging `'disk'` into
  `checkpointOverrides` (override wins over mode) is sufficient to activate only the curated
  gates; setting the mode would gate every site.
