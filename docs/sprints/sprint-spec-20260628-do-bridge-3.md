# Reconcile promotion outcome to done and prove registry extensibility

**Contract:** sprint-spec-20260628-do-bridge-3  ·  **Spec:** spec-20260628-do-bridge  ·  **Completed:** 2026-06-29

## What this sprint added

Sprint 3 **closes the do-bridge loop** and is the **final sprint** of `spec-20260628-do-bridge`. Sprint 2
launched a promoted run and linked the Finding (`promotesTo.status = "launched"`, status `in-progress`)
but never advanced it past launch; Sprint 3 adds **reconciliation** — a `reconcilePromotions` pass that
reads each launched run's `run-state.json` **snapshot** and advances the linked Finding to its terminal
state (`completed → done`, `aborted`/`failed → open`, `running`/missing → unchanged). It is exposed via a
new `bober do --reconcile` flag **and** runs **best-effort at the start of every `bober do`**, so the
next promote also picks up any finished runs. The sprint also **proves the registry is extensible**: a
second, deliberately **non-functional** stub promoter is registered under a `{ domain: "projects", kind:
"action" }` key, demonstrating the registry accepts a new `(domain, kind)` pair while an unregistered
pair still **fails closed**. The consolidated extension-point guide **`docs/do-bridge.md`** ships with it.
The hub `FindingSchema` (`src/hub/finding.ts`) is **byte-unchanged**.

## Public surface

- `reconcilePromotions(deps: ReconcileDeps)` (`src/do-bridge/reconcile.ts:51`) — the DI core. Lists
  promoted Findings via the port, filters to `promotesTo.status === "launched"`, reads each linked run's
  state through the injected `readState`, and applies the transition. Returns a `ReconcileSummary`
  `{ completed, aborted, unchanged }`. **Never throws** — per-finding failures are caught and counted as
  `unchanged`. All I/O (store, run-state reader, clock) is injected so unit tests need no real run.
- `reconcilePromotionsForRoot(projectRoot, store, now)` (`src/do-bridge/reconcile.ts:102`) — the CLI
  wrapper that injects the real `readRunState(projectRoot, runId)` adapter (`src/state/run-state.ts`).
  The caller is responsible for wrapping it in try/catch (the command does).
- `ReconcileDeps` (`src/do-bridge/reconcile.ts:12`) — `{ store: FindingStore; readState: (runId) =>
  Promise<RunState | null>; now: () => string }`.
- `ReconcileSummary` (`src/do-bridge/reconcile.ts:27`) — `{ completed: number; aborted: number;
  unchanged: number }`, the counts printed by `--reconcile`.
- `FindingStore.listPromoted()` (`src/do-bridge/finding-port.ts:55`) — new port method: returns all
  Findings that currently carry a `PromotionRef` (`promotesTo` defined). Implemented on both adapters.
- `FindingStore.applyOutcome(id, status, ref, { now })` (`src/do-bridge/finding-port.ts:62`) — new port
  method: transition a Finding to an **arbitrary** status **and** overwrite its `promotesTo` ref in one
  supersede-aware write. Used by reconcile for the `done` / `open` outcomes. The `FactStoreFindingStore`
  adapter (`finding-port.ts:107`) routes through the hub's `transitionFinding()` so bitemporal history is
  preserved; the `InMemoryFindingStore` adapter (`finding-port.ts:165`) stores the ref object directly
  and records the write.
- `bober do --reconcile` flag (`registerDoCommand`, `src/cli/commands/do.ts:213`) — reconcile-only path:
  runs `reconcilePromotionsForRoot` and prints `do --reconcile: completed=<n> aborted=<n> unchanged=<n>`,
  then exits without promoting. Mutually exclusive with the promote path (it `return`s early).
- **Start-of-command best-effort reconcile** (`src/cli/commands/do.ts:275`) — every normal
  `bober do <id>` invocation runs `reconcilePromotionsForRoot` inside a try/catch (mirroring
  `seedProjectFacts` in `src/orchestrator/pipeline.ts:981`) **before** building the launch deps; a
  reconcile failure logs a `Reconcile skipped: …` warning and **never aborts** the command.
- **Second stub promoter** (`src/cli/commands/do.ts:266`) — a `projectsActionStub: Promoter` returning a
  `{ kind: "bober-run", task: "STUB — not functional" }` plan, registered under
  `{ domain: "projects", kind: "action" }` purely to prove `registry.register` accepts a new key. Marked
  non-functional in code comments; replace with a real promoter in a future sprint.
- **`docs/do-bridge.md`** (new, generator-owned) — the consolidated do-bridge feature guide: it names the
  exact `register()` call site, the `Promoter` interface / `PromotionPlan` / `PromoterKey` shapes,
  resolution precedence, the reconcile transition table, and a worked "add a medical/financial promoter"
  example.

## Run-state → Finding transition table

`reconcilePromotions` reads the current `run-state.json` snapshot for each launched promotion and applies:

| Run `state.json` status | Finding transition | `promotesTo.status` | Summary bucket |
|---|---|---|---|
| `completed` | `in-progress` → `done` (supersede) | `completed` | `completed` |
| `aborted` or `failed` | `in-progress` → `open` | `aborted` | `aborted` |
| `running` (also `input-required` / `paused`) | unchanged (no write) | unchanged | `unchanged` |
| missing / corrupt (`readState` → `null`) | unchanged (no write) | unchanged | `unchanged` |

The terminal write goes through `applyOutcome` → `transitionFinding` → `supersedeFact`, so the prior
`in-progress` row is closed with a `tInvalidated` timestamp and the new status is inserted as a fresh
active row — the bitemporal history is preserved, **not** destroyed.

## Invariants (evaluator-verified)

- **Never-throws.** `reconcilePromotions` wraps each finding in a try/catch and the CLI wraps the whole
  reconcile in try/catch — a missing/corrupt `state.json` or a per-finding error can never abort
  `bober do`. The missing-state case returns `null` from `readRunState` and is treated as "still running"
  (left unchanged).
- **Snapshot, not poll.** Reconcile reads the *current* `run-state.json` and returns immediately. It does
  **not** block or poll waiting for an in-flight run to finish (a contract non-goal).
- **Clock injected.** The core never calls `new Date()`; the timestamp is passed in via `deps.now`.
- **Fail-closed extensibility.** `registry.resolve()` for an unregistered `(domain, kind)` returns
  `undefined`, and `bober do` converts that into a non-zero exit with an error message — there is no
  default catch-all promoter.
- **Hub schema byte-unchanged.** `src/hub/finding.ts` is not touched; `promotesTo` stays
  `z.string().optional()` on disk, with the structured `PromotionRef` serialized/parsed at the port layer.

## Success criteria — how each was met

- **sc-3-1 (build)** — `npm run build` / `tsc` is clean after `reconcilePromotions`, the `--reconcile`
  flag, the `listPromoted`/`applyOutcome` port additions, the second stub promoter, and the docs.
- **sc-3-2 (unit)** — with a Finding at `promotesTo.status "launched"` and a run-state fake reporting
  `completed`, reconcile transitions the Finding to `done` and sets `promotesTo.status = "completed"`
  (`reconcile.test.ts`).
- **sc-3-3 (unit)** — a run-state fake reporting `aborted` returns the Finding to `open` with
  `promotesTo.status = "aborted"`; a fake reporting `running` leaves it at `in-progress` unchanged
  (no write).
- **sc-3-4 (unit)** — the second stub promoter registered under `{ domain: "projects", kind: "action" }`
  resolves for a `projects`/`action` finding, while `registry.resolve()` for an unregistered
  `(domain, kind)` returns `undefined` and `bober do` then exits non-zero (`registry.test.ts`).
- **sc-3-5 (manual)** — `docs/do-bridge.md` exists and documents the `PromoterRegistry.register`
  extension point (the exact register call site in `src/cli/commands/do.ts` + the `Promoter` interface)
  for adding future medical/financial promoters.

Eval `eval-sprint-spec-20260628-do-bridge-3-1` → **pass** (5/5 required, iteration 1). Generator report:
**76 do-bridge tests**, full suite **3400** green.

## Notes for maintainers

- **Non-blocking follow-up (evaluator-raised, cosmetic).** The unsupported-promoter error in
  `src/cli/commands/do.ts:111-119` names only the **domain** (`do: unsupported domain '<domain>' — no
  promoter registered for this domain`), not the full `(domain, kind)` pair, even though `sc-3-4`'s intent
  references naming the pair. The criterion **passed** (resolve returns `undefined` and the command exits
  non-zero with a clear message); this is a wording-only improvement, not a behavior fix. Do not "fix" it
  by reopening this sprint — fold it into a later touch of `do.ts` if desired.
- **`docs/do-bridge.md` is the durable extension-point doc.** It is the single place a maintainer adds a
  new domain promoter — it names the `register()` call site, the `Promoter` purity contract, and the
  fail-closed resolution precedence. Keep it in lockstep if the registry wiring in `do.ts` moves.
- **The stub is intentionally inert.** `projectsActionStub` returns a non-functional plan; it exists only
  to satisfy `sc-3-4`'s registration proof. Swapping it for a real `projects/action` promoter is a future
  sprint, not a bug.
- **Reconcile reads `RunState` from the roster.** `readRunState` (`src/state/run-state.ts`) is the
  null-safe reader over `.bober/runs/<runId>/state.json`; `RunSpawner` writes `running → aborted` there
  and the pipeline writes `completed`. Reconcile only ever *reads* run-state — it never writes it.

## Scope

Commit `f430fd1`: 6 files changed, **+686 / -4**. New `src/do-bridge/reconcile.ts` (+112) and its
collocated `reconcile.test.ts` (+216) and `registry.test.ts` (+33); `src/do-bridge/finding-port.ts`
(+50: the `listPromoted` / `applyOutcome` port methods across both adapters); `src/cli/commands/do.ts`
(+71: the `--reconcile` flag, the reconcile-only path, the start-of-command best-effort reconcile, and the
second stub promoter); and the new generator-owned `docs/do-bridge.md` (+208). **`src/hub/finding.ts` is
byte-unchanged.** Build + typecheck + lint clean, **76 do-bridge tests**, full suite **3400** green. All
five required criteria passed on iteration 1.

> **Plan complete (3 of 3).** This closes `spec-20260628-do-bridge`: the promoter registry + FindingStore
> port + `bober do --dry-run` preview (Sprint 1), the approve-gated real launch + `--yes` (Sprint 2), and
> this terminal reconciliation + registry-extensibility proof + consolidated `docs/do-bridge.md`
> (Sprint 3). The consolidated feature guide is [`docs/do-bridge.md`](../do-bridge.md); user-facing CLI
> usage is in [`COMMANDS.md`](../../COMMANDS.md) under **Do-Bridge Commands** and the README CLI list.
