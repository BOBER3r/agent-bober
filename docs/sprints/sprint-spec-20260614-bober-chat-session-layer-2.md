# Non-blocking detached spawn with session-generated runId (--run-id flag)

**Contract:** sprint-spec-20260614-bober-chat-session-layer-2  ·  **Spec:** spec-20260614-bober-chat-session-layer  ·  **Completed:** 2026-06-14

## What this sprint added

Makes the chat REPL's `spawn` action real: asking `bober chat` to build something
now launches a **detached** `bober run` child that survives the REPL exiting,
returns an immediate ack, and shows up under `/runs` as `running` the same turn.
The enabling piece is an additive, optional `--run-id <id>` flag on `bober run`
that lets the caller (the chat session) pick the run identifier instead of the
pipeline self-generating one — so the session can write the roster entry up front
and the child keys its completion marker and roster state on the same id. Spawning
is non-blocking: the REPL never waits for the run to finish.

## Public surface

- `--run-id <id>` flag on `bober run` (`src/cli/index.ts:217`, threaded via `RunCommandOptions.runId` at `src/cli/commands/run.ts:27`) — use a caller-supplied run identifier instead of self-generating `run-<timestamp>`. Additive and optional; omitting it preserves the previous behavior exactly.
- `runTsPipeline` / `runPipeline` optional `opts?: { runId?: string }` (`src/orchestrator/pipeline.ts:577`, `:975`) — backward-compatible 4th argument. `pipelineRunId` now resolves as `opts?.runId ?? \`run-${Date.now()}\`` (`src/orchestrator/pipeline.ts:585`), so the injected id flows through to the completion marker and roster state. Also threaded through the workflow engine wrappers (`engine.ts`, `ts-engine.ts`, `workflow-engine.ts`).
- `RunSpawner` (`src/chat/run-spawner.ts:49`) — `spawn(task, runId): Promise<SpawnAck>`. Writes the roster `state.json` via `writeRunState` (status `running`) **before** launching, then spawns a detached `bober run <task> --run-id <id>` child (`cwd=projectRoot`, `detached:true`, `stdio:'ignore'`, `child.unref()`), records the pid in the sidecar, and returns a `SpawnAck` synchronously without awaiting the child. The spawn fn, CLI entry, Node binary, and clock are all dependency-injectable for tests. On spawn failure it returns `SpawnAck.spawnError` rather than throwing.
- `SpawnAck` type (`src/chat/run-spawner.ts:16`) — `{ runId, task, pid?, cwd, spawnError? }`.
- `PidSidecar` (`src/chat/pid-sidecar.ts:21`) — persists `runId -> { pid?, task, spawnedAt }` at `.bober/chat/<sessionId>.pids.json`. `record(runId, entry)` merges and atomically rewrites (mode `0o600`); `readAll()` returns `{}` on a missing/malformed file and never throws. State survives across fresh instances.
- `PidEntry` type (`src/chat/pid-sidecar.ts:13`) — `{ pid?, task, spawnedAt }`.
- `ChatSession` spawn wiring (`src/chat/chat-session.ts`) — the classifier `spawn` action now generates a session-scoped `runId` (`run-<clock()>`, clock injectable via the `now` option) and routes to `RunSpawner.spawn`, replying `Launched run <id> for: <task>. Use /runs to track it.` (or a failure message). A `spawner` option allows injecting a fake `RunSpawner` in tests.

## How to use / how it fits

```bash
bober chat
> build a settings page with dark mode
# → "Launched run run-1718370000000 for: build a settings page with dark mode. Use /runs to track it."
> /runs
# → the new run appears as `running` immediately
> /exit        # the detached run keeps going after the REPL exits
```

The id supplied by chat is the same one the detached pipeline uses, so the
roster `state.json` the session wrote and the completion marker
`.bober/runs/<id>.completed.json` the child writes line up on a single key.
`--run-id` can also be passed directly to `bober run` for any caller that needs a
deterministic/known run identifier.

## Notes for maintainers

- **Non-blocking by contract.** `RunSpawner.spawn` must never `await` the child; it
  writes state first, spawns, records the pid, and returns. The child is `unref()`d
  so it does not keep the REPL's event loop alive.
- The detached child is launched with the same CLI-entry resolution as the fleet
  runner (`resolveCliEntry`, `src/fleet/runner.ts`) and `process.execPath` as the
  Node binary; both are injectable on `RunSpawner` for tests.
- The pipeline change is strictly additive — every existing `runPipeline` /
  `runTsPipeline` caller is unaffected because `opts` is optional and the fallback
  preserves the old `run-<timestamp>` id.
- This sprint covers launch only. Completion weaving / history tailing is Sprint 3;
  stop / kill-by-PID (which will consume the pid sidecar) is Sprint 4. The
  classifier `steer` action is still stubbed.
