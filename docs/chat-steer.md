# Chat Steer: Mid-Flight Human-in-the-Loop

This guide covers the Phase 2 chat steer commands introduced in the
`chat-interrupt-approve-steer` sprint series. These commands let you
control in-flight agent runs from inside the `bober chat` REPL without
stopping them.

See the research document at
`.bober/research/20260614-chattable-team-of-agents-platform.md`
(Phase 2, line 277: `### Phase 2 — Interrupt/approve/steer in chat`)
for the full motivation and architecture. The substrate mapping table at
line 51 of the same document shows how `approval-state.ts` and the
DiskCheckpointMechanism provide the interrupt/resume substrate.

See also `docs/teams.md` for the `bober chat <team>` surface that the
steer commands layer onto.

---

## The Cross-Process Model

`bober chat` runs in a **chat process** that is separate from the **child
run process** spawned via `RunSpawner`. The two processes coordinate via
disk markers:

- **Chat process**: owns `RunState` (`.bober/runs/<runId>/state.json`)
  and reads/writes approval markers in `.bober/approvals/`. It surfaces
  pending gates and steer artifacts to the user through the REPL.
- **Child run process**: reads markers at curated pipeline gates to decide
  whether to pause, resume, or abort. It writes `*.pending.json` when it
  reaches a gate and reads `*.approved.json` / `*.rejected.json` to act.

This design keeps the chat process lightweight: it never executes pipeline
code, only marshals disk signals that the run process reads cooperatively.

---

## `/careful` Toggle

```
/careful on    — new runs spawn with --approve-gates
/careful off   — new runs run in autopilot (default)
/careful       — query current state
```

When careful mode is ON, every run spawned in the session includes the
`--approve-gates post-research,post-plan,post-sprint` flag. The run
process checks these gates at curated checkpoints and writes a
`<checkpointId>.pending.json` marker to `.bober/approvals/` when it
arrives at one.

The careful flag is persisted per session in
`.bober/chat/<sessionId>.careful.json` so it survives a REPL restart.

---

## Curated Gates

Three gates are pre-registered as approval checkpoints in the pipeline:

| Gate | Pauses After | What to Review |
|---|---|---|
| `post-research` | The research phase completes | Research document quality, scope correctness |
| `post-plan` | The planning phase completes | Sprint plan, contract precision |
| `post-sprint` | Each sprint implementation completes | Code diff, tests, build status |

Each gate surfaces a notice in the next chat turn:
```
[run run-123 waiting at post-plan: Research phase complete, proceed to plan?]
```

The run stays alive with its process intact — it is waiting cooperatively
at the checkpoint, not killed.

---

## `/approve` and `/reject`

```
/approve <checkpointId>              — approve; run resumes
/reject <checkpointId> [feedback]   — reject with optional feedback for retry
```

`/approve <id>` writes `.bober/approvals/<id>.approved.json` and clears
the chat-owned RunState pending fields (`pendingCheckpointId`,
`pendingPrompt`, `pendingSince`), resetting status back to `"running"`.

`/reject <id> <feedback>` writes `.bober/approvals/<id>.rejected.json`
carrying the feedback string, then clears the same RunState fields.

The child run process reads the `.approved.json` or `.rejected.json` at
the gate and continues (or retries) accordingly.

Non-chat equivalents: `npx agent-bober list-approvals`,
`npx agent-bober approve <id>`, `npx agent-bober reject <id>`.

---

## `/tell` — Guidance Channel

```
/tell <runId> <text>
```

Appends a free-text guidance entry to `.bober/runs/<runId>/guidance.jsonl`.
The pipeline drains unconsumed entries at the next pipeline boundary via
`drainGuidance`. Guidance is additive — multiple `/tell` calls accumulate.

The entry is marked `consumed: false` until the run drains it. Once
drained, the entry is atomically rewritten as `consumed: true`.

---

## `/pause` and `/resume`

```
/pause <runId>   — cooperative soft-pause
/resume <runId>  — resume a paused run
```

`/pause` writes `.bober/runs/<runId>/paused.json` and flips the chat-owned
RunState to `status: "paused"` with a `pausedAt` timestamp. **The run
process is NOT killed** — it polls `isPaused` at cooperative boundaries
and blocks while the marker is present. This is explicitly distinct from
`/stop`.

`/resume` removes `paused.json` (best-effort) and resets RunState back to
`status: "running"`, dropping `pausedAt`.

### `/pause` vs `/stop`

| | `/pause` | `/stop` |
|---|---|---|
| Process | Stays alive | Killed (SIGTERM) |
| Reversible | Yes — `/resume` | No |
| Mechanism | Disk marker poll | OS signal |
| Use when | You want to inspect and continue | You want to abandon the run |

---

## Cleanup on Completion / Abort

When the chat process observes a run going terminal (completed or aborted),
it automatically cleans up stale steer artifacts:

1. Deletes pending approval marker(s) correlated to the run (by `runId`
   field in the marker).
2. Unlinks `.bober/runs/<runId>/guidance.jsonl` and `paused.json`
   (best-effort — ENOENT tolerated).
3. Clears the chat-owned RunState pending/paused fields
   (`pendingCheckpointId`, `pendingPrompt`, `pendingSince`, `pausedAt`)
   while leaving the terminal status (`completed`/`aborted`) as-is.

This cleanup is **best-effort and never throws** — a cleanup failure cannot
break a chat turn.

---

## Limitations and Follow-Ups

### Single Careful Run at a Time

Pending markers are **checkpointId-keyed in a shared `.bober/approvals/`
directory** (`approval-state.ts` lines 13-14: `<checkpointId>.pending.json`).
They are NOT scoped by `runId` in the filename. As a result, two concurrent
careful runs that both reach the same gate (e.g., `post-plan`) would
overwrite each other's pending markers.

The current constraint: **only one careful run at a time** is safely
supported. Running two careful runs concurrently can cause gate collisions
and unpredictable approval routing.

The cleanup helper (`steer-cleanup.ts`) correlates markers to their run by
reading the `runId` field inside each marker. This field-level correlation
is a workaround for the filename collision — it means cleanup must scan all
pending markers and filter by `runId` rather than addressing them directly.

### RunId-Scoped Marker Follow-Up

The clean upgrade path is to embed the `runId` in the marker filename:
`<runId>-<checkpointId>.pending.json`. This makes each marker uniquely
addressable per run, enables multiple concurrent careful runs, and simplifies
cleanup (address directly by `<runId>-<checkpointId>` instead of scanning).
This is deferred to a future sprint.

See `.bober/research/20260614-chattable-team-of-agents-platform.md`
(Phase 2, line 277) for the longer-term multi-careful-run architecture.

After implementing this guide on a new project, run `npm run update-all`
(human follow-up) to sync the updated planner skill and agent copies into
the `.claude/` directories of all downstream projects.

---

## Related

- `docs/teams.md` — the team abstraction that `bober chat <team>` builds on
- `.bober/research/20260614-chattable-team-of-agents-platform.md` — full
  Phase 2 architecture and substrate mapping (line 51 for the substrate table,
  line 179 for the two interrupt classes: hard stop vs soft steer)
- `src/state/approval-state.ts` — marker read/write helpers
- `src/state/guidance.ts` — guidance channel helpers
- `src/state/pause.ts` — pause/resume marker helpers
- `src/chat/steer-cleanup.ts` — completion cleanup implementation
