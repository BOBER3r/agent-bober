# Gate the promotion through the approve marker and launch real work

**Contract:** sprint-spec-20260628-do-bridge-2  ·  **Spec:** spec-20260628-do-bridge  ·  **Completed:** 2026-06-29

## What this sprint added

Sprint 2 turns the read-only `bober do <findingId> --dry-run` preview from Sprint 1 into a **real,
approve-gated launch path**. Running `bober do <findingId>` (without `--dry-run`) now writes a
`.bober/approvals/promote-<findingId>.pending.json` marker summarizing the planned `bober run` task,
**gates** on it (TTY confirm prompt · non-TTY poll for an external `bober approve`/`bober reject` ·
`--yes` auto-approve), and **only on approval** launches the work **detached** through an injected
`Launcher` port whose default adapter wraps the chat `RunSpawner` to spawn `agent-bober run <task>
--run-id <id>`. On launch it links the Finding (`promotesTo = { kind:"bober-run", runId, launchedAt,
status:"launched" }`) and transitions it `open → in-progress` via the `FindingStore` port; on rejection
it deletes the pending marker and leaves the Finding untouched. The pipeline is **not** run in-process
(no blocking `runPipeline` await), and the Finding is **not** marked `done` here — terminal
reconciliation is Sprint 3.

## Public surface

- `Launcher` (`src/do-bridge/launcher.ts:19`) — the injected port `{ launch(plan: PromotionPlan):
  Promise<{ runId: string; pid?: number }> }`. Injected into `runDo` so unit tests use a fake and never
  spawn a real process.
- `RunSpawnerLauncher` (`src/do-bridge/launcher.ts:51`) — default adapter. Wraps `RunSpawner` (the chat
  run-spawner) to spawn a detached `agent-bober run <plan.task> --run-id <runId>`; `runId` format is
  `do-<findingId>-<timestamp>` (stable prefix for identifying do-bridge runs in roster `state.json`).
  `RunSpawnerLauncherOptions` (`src/do-bridge/launcher.ts:27`) accepts an injected `spawner` and `now`
  for tests. **Hard boundary:** this file owns the `RunSpawner` import; `src/cli/commands/do.ts` must
  not import `RunSpawner`/`execa`/`node:child_process` directly.
- `PromotionRef` (`src/do-bridge/types.ts:44`) — **changed from a bare string (Sprint 1) to a structured
  object** `{ kind:"bober-run"; runId; launchedAt; status:"launched"|"completed"|"aborted" }` written to
  `Finding.promotesTo` after a launch.
- `serializePromotionRef(ref)` (`src/do-bridge/types.ts:52`) / `parsePromotionRef(s)`
  (`src/do-bridge/types.ts:60`) — cross the on-disk boundary: serialize the object to a JSON string for
  storage; parse it back (returns `null` on bad/missing JSON, never throws).
- `DoFinding` (`src/do-bridge/finding-port.ts:17`) — do-bridge view of a `Finding` where `promotesTo` is
  the parsed `PromotionRef` **object** rather than the raw on-disk string. Owned by the port layer.
- `FindingStore.setPromotion(id, ref, { now })` (`src/do-bridge/finding-port.ts:48`) — new write method
  on the port: sets `promotesTo = ref` **and** transitions `open → in-progress` in one call; returns the
  updated `DoFinding` (or `null` if the id is absent). `readFinding` now returns `DoFinding`.
- `FactStoreFindingStore` (`src/do-bridge/finding-port.ts:67`) — `setPromotion` serializes the ref and
  delegates to the hub's supersede-aware `transitionFinding()` so bitemporal history is preserved.
- `InMemoryFindingStore` (`src/do-bridge/finding-port.ts:102`) — test fake; `setPromotion` stores the
  ref **object** directly and records every call in `writes[]` (assert `writes.length === 1` on approve,
  `=== 0` on reject).
- `runPromotionGate(args)` (`src/do-bridge/promote.ts:66`) — the gate core. Writes the pending marker via
  `savePending`, then resolves `--yes → saveApproved` · TTY → injected `confirm()` →
  `saveApproved`/`saveRejected` · non-TTY → poll `.bober/approvals/` for `<checkpointId>.approved.json`
  /`.rejected.json` (mirrors `src/orchestrator/checkpoints/mechanisms/disk.ts`), always deleting the
  pending marker before returning `{ approved }`. `PromotionGateArgs` (`src/do-bridge/promote.ts:32`)
  injects `projectRoot`/`confirm`/`now`/`pollMs`/`timeoutMs`. `GateOutcome` (`src/do-bridge/promote.ts:25`).
- `RunDoDeps` (`src/cli/commands/do.ts:59`) — injected deps for the real path: `{ launcher, projectRoot,
  confirm, isTTY?, now?, pollMs?, timeoutMs? }`. Optional on `runDo` so Sprint-1 dry-run/error tests still
  compile.
- `runDo(store, registry, findingId, opts, deps?)` (`src/cli/commands/do.ts:90`) — extended with `opts.yes`
  and `deps`; **Branch 4** (non-dry-run) gates then launches and links. Never throws (sets
  `process.exitCode = 1` on every failure branch).
- `bober do <findingId>` real path + `--yes` flag (`registerDoCommand`, `src/cli/commands/do.ts:204`) —
  builds the real `RunSpawnerLauncher` + a `prompts()`-backed `confirm`, wired through `runDo`.

## How to use / how it fits

`bober do <findingId>` reads the Finding from the active team's namespace `facts.db` (same store
`bober hub list` / `bober task list` use), resolves a promoter by `domain`/`kind`, and requests approval
to launch the resulting `bober run` task:

```text
$ bober do 1f3c9a0b2e4d6f80
do: requesting approval to launch bober run "Fix flaky auth test — token refresh races on expiry" (team: default team)
? Approve promotion for finding '1f3c9a0b2e4d6f80'? (y/N)
do: launched bober run "Fix flaky auth test …" — runId: do-1f3c9a0b2e4d6f80-2026-06-29T16:51:48.777Z (pid 40912)
```

Three ways the gate resolves:

- **`--yes`** — auto-approves without prompting (writes then clears the marker).
- **TTY** — interactive `prompts()` confirm; decline → reject (no launch, Finding unchanged).
- **Non-TTY** — the command writes the pending marker and **waits**, polling `.bober/approvals/` until an
  operator resolves it out-of-band with `bober approve promote-<id>` or `bober reject promote-<id>`.

The **approval marker / checkpointId convention** reuses `src/state/approval-state.ts` verbatim — no new
storage format. The `checkpointId` is always `promote-<findingId>`, so the marker files are
`.bober/approvals/promote-<findingId>.pending.json`, and the standard `bober approve <checkpointId>` /
`bober reject <checkpointId>` commands (which take a checkpointId) resolve a do-bridge promotion by
writing `promote-<findingId>.approved.json` / `.rejected.json` — exactly the same markers the run
pipeline uses.

## Notes for maintainers

- **Schema-serialization design decision — the hub `FindingSchema` stays byte-unchanged.** The structured
  `PromotionRef` object is **serialized to a JSON string** into the existing `promotesTo:
  z.string().optional()` field of `src/hub/finding.ts`; that file is *not* modified. The do-bridge owns
  `serializePromotionRef`/`parsePromotionRef` and the `DoFinding` view type so callers work with the
  object shape while disk stays a plain string. This keeps the canonical hub schema (shared by the kb-*
  / task-inbox siblings) stable — a later structured `promotesTo` migration would be a hub-owned decision,
  not forced by the do-bridge. `FactStoreFindingStore.setPromotion` writes through `transitionFinding`, so
  the supersede/bitemporal history is preserved (the prior `open` row is not destroyed).
- **The `Launcher` is injected on purpose.** Unit tests pass a fake `Launcher` and a `confirm` stub, so no
  real `execa`/process is ever spawned. The evaluator verified: approve → `launch` invoked **once** + link
  (`status:"in-progress"`, `promotesTo.status:"launched"`, `promotesTo.runId` == the fake's runId); reject
  → `launch` invoked **zero** times, status stays `open`, pending marker removed; `--yes` bypasses the
  prompt but still writes and clears the marker.
- **Detached, not in-process.** The launch is fire-and-forget via `RunSpawner.spawn`; `runDo` returns
  after recording the link. It does not await the child pipeline and does not mark the Finding `done`.
- **Remaining Sprint 3 scope.** Terminal outcome reconciliation (`in-progress → done`/`aborted`, driving
  `PromotionRef.status` to `completed`/`aborted`), promoter-registry extensibility (medical/financial
  promoters + a fleet `Launcher` are explicit non-goals here), and the consolidated `docs/do-bridge.md`
  feature guide all land in Sprint 3.

## Scope

Commit `cf33acb`: 9 files changed, **+1143 / -37**. New `src/do-bridge/launcher.ts` and
`src/do-bridge/promote.ts` (+ collocated tests); `types.ts` grew the `PromotionRef` object +
serialize/parse helpers; `finding-port.ts` gained `DoFinding` + `setPromotion` across both adapters;
`src/cli/commands/do.ts` gained `RunDoDeps`, Branch 4, and the `--yes` flag. **`src/hub/finding.ts` is
byte-unchanged.** Build + typecheck + lint clean, **58 do-bridge tests** + **334 regression tests** green.
All five required criteria passed on iteration 1; eval `eval-sprint-spec-20260628-do-bridge-2-1` →
**pass** (5/5 required):

- **sc-2-1** — `tsc` clean after the Launcher port, RunSpawner adapter, and approve-gate wiring (build).
- **sc-2-2** — with a fake Launcher + approve-stub, writes `promote-<id>.pending.json`, calls
  `launcher.launch` exactly once with `plan.task`, writes `.approved`, deletes the pending marker (unit).
- **sc-2-3** — after approval the FindingStore fake shows `status === "in-progress"` and
  `promotesTo.runId` == the fake Launcher's runId with `promotesTo.status === "launched"` (unit).
- **sc-2-4** — on reject, `launcher.launch` runs zero times, status stays `open`, pending marker removed (unit).
- **sc-2-5** — non-TTY: writes the pending marker and waits; an external `bober approve promote-<id>`
  (reusing `src/state/approval-state.ts`) resolves it and the launch proceeds (manual).

> **User-facing docs** for the real `bober do <findingId>` launch path (approve gate, `--yes`, the
> `promote-<id>` marker resolved by `bober approve`/`bober reject`) live in
> [`COMMANDS.md`](../../COMMANDS.md) under **Do-Bridge Commands** and the README quick-reference. The
> consolidated do-bridge feature guide (`docs/do-bridge.md`) remains owned by Sprint 3 and is
> intentionally not created yet.
