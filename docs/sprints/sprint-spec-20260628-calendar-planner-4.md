# Approve-gate: propose -> /approve|/tell -> write events

**Contract:** sprint-spec-20260628-calendar-planner-4  ·  **Spec:** spec-20260628-calendar-planner  ·  **Completed:** 2026-06-29

## What this sprint added

Sprint 4 **closes the plan** by composing the full safety flow: the **live** `bober calendar plan`
(no `--dry-run` / `--export-ics`) now slots the findings and **proposes** the schedule through the
**existing** approval gate — writing a pending marker plus a plan sidecar and **zero** calendar events
— then prints the `checkpointId` and how to approve it. Events are written **only** when an
`ApprovedMarker` exists for that checkpoint: a new `bober calendar apply <checkpointId>` detects the
approved/rejected marker inline and calls the chosen connector's `writeEvents` **exactly once** on
approval, **never** on rejection. A `/tell`-style constraint adjustment (`adjustPlan`) re-runs the
Sprint 1 slotter under a deterministic constraint delta (exclude an interval / shift the window) and
re-proposes — **pure, no write**. The whole gate **reuses** `src/state/approval-state.ts` and the
existing `bober approve` / `/approve` / `/reject` / `/tell` handlers — there is **no** new approval
mechanism and **no** auto-approve anywhere (including autopilot). The `checkpointId` convention
`calendar-<planId>` mirrors do-bridge's `promote-<id>` so the existing approval CLI/chat surface works
with zero new wiring, and the Sprint 3 Google connector stays egress-gated on the apply path.

## Public surface

- `proposePlan(args: ProposeArgs)` (`src/calendar/proposal-gate.ts:98`) — writes the plan sidecar
  (`.bober/calendar/<checkpointId>.plan.json`, holding the `ProposedPlan` + `connectorName`) and a pending
  approval marker via `savePending`, returning `{ checkpointId }` where `checkpointId = "calendar-${planId}"`.
  Takes **no connector** — so calling `writeEvents` before approval is structurally impossible.
- `applyPlan(projectRoot, checkpointId, connector)` (`src/calendar/proposal-gate.ts:151`) → `ApplyOutcome`
  (`{ status: "applied"; writtenCount }` | `{ status: "rejected"; feedback? }` | `{ status: "pending" }`).
  Reads `.bober/approvals/` via `readdir`: on `<id>.approved.json` it reloads the sidecar and calls
  `connector.writeEvents(plan.scheduled)` **exactly once**, then best-effort `deletePending`; on
  `<id>.rejected.json` it returns the feedback and **never** writes; otherwise reports `pending`.
- `adjustPlan(findings, busy, constraints, delta)` (`src/calendar/proposal-gate.ts:212`) → `ProposedPlan` —
  **pure** re-run of `planSlots` under a `ConstraintDelta` (`excludeInterval` appended to `busy[]`,
  and/or `windowStartIso` / `windowEndIso` shift); writes nothing and does not mutate its inputs.
- `ProposeArgs` / `ApplyOutcome` / `ConstraintDelta` (`src/calendar/proposal-gate.ts:40`, `:57`, `:69`) —
  the exported types for the three entry points.
- `bober calendar plan` (live, no flags) (`src/cli/commands/calendar.ts:163`) — slots the findings, calls
  `proposePlan`, and prints `Proposal saved. Approve to write events:` with `bober approve <checkpointId>`
  / `/approve <checkpointId>` and the `Checkpoint ID`. **Zero** events written.
- `bober calendar apply <checkpointId>` (`src/cli/commands/calendar.ts:307`) — resolves the connector from
  `calendar.connector` (default `ics`; Google still egress-gated → actionable error + exit 1 when OAuth
  not provisioned), calls `applyPlan`, and prints `Applied: N event(s) written.` / a rejection reason
  (exit 1) / a `Pending approval` hint. Optional `--out <path>` overrides the ICS output path.
- `runCalendarApply(projectRoot, checkpointId, deps)` (`src/cli/commands/calendar.ts:211`) — the extracted,
  dependency-injected core (`CalendarApplyDeps` can inject a stub `connector` and `icsOutPath`).

## How to use / how it fits

The default `bober calendar plan` is now the **live propose path**; the two earlier modes stay as
explicit flags. The three modes are:

- `--dry-run` — slot and **print only**; writes nothing.
- `--export-ics <path>` — slot and write a local RFC 5545 `.ics` file (zero egress); the manual import is
  the human review, so there is **no** approval gate.
- **(no flags)** — slot and **propose** via the approval gate; writes **zero** events until approved.

The full propose → approve → apply flow:

```bash
# 1. Propose — writes a pending marker + plan sidecar; ZERO events written
bober calendar plan --findings ./ranked-findings.json --freebusy ./freebusy.json
#   → prints:  Checkpoint ID: calendar-<planId>

# 2. Approve out-of-band (reuses the existing approval gate)
bober approve calendar-<planId>           # or  /approve calendar-<planId>  in chat

# 3. Apply — connector.writeEvents is called exactly once
bober calendar apply calendar-<planId>
```

Rejecting the checkpoint (`/reject calendar-<planId> [feedback]`) makes `apply` abort with the feedback
and **no** write. A `/tell`-style correction re-runs `adjustPlan` to produce a new `ProposedPlan` under
the updated constraint, which is then re-proposed — again with no events written. User-facing usage lives
in [`COMMANDS.md`](../../COMMANDS.md) under **Calendar Commands**; the connector config + privacy model is
in [`docs/calendar.md`](../calendar.md).

## Notes for maintainers

- **`proposePlan` owns ALL filesystem writes on the live path.** Both the plan sidecar and the pending
  marker are written inside `proposal-gate.ts`; `src/cli/commands/calendar.ts` imports **no**
  `writeFile`/`writeJson`/`appendFile` — the Sprint 1 source-scan test still enforces this. Keep new
  writes in the gate module, not the CLI.
- **Markers are detected inline, not via a reader export.** There is no `readApproved` / `readRejected`
  in `approval-state.ts`; `applyPlan` builds the marker filename and checks a `readdir` set, mirroring
  `src/cli/commands/approve.ts` and `src/do-bridge/promote.ts`. `deletePending` is best-effort
  (never throws) — gate control is the **presence of the approved/rejected marker**, not the pending one.
- **No new approval mechanism, no auto-approve.** The gate reuses `savePending` / `deletePending` and the
  existing `/approve` / `/reject` / `/tell` handlers. Approval is strictly out-of-band; there is no
  auto-approve path in any mode (verified by the evaluator).
- **`checkpointId = "calendar-${planId}"`** (mirrors do-bridge `promote-<id>`) so `bober approve` /
  `/approve` resolve it with zero new wiring. The default `planId` is `Date.now().toString(36)`; tests
  inject a fixed `makePlanId` for deterministic assertions.
- **`adjustPlan` models exclusions by appending a `BusyInterval` to `busy[]`** — `SlotConstraints` has no
  `excludeInterval` field; do **not** add one. The function is pure and must stay write-free.
- **Google on the apply path is still egress-gated.** When `calendar.connector` is `google`, `apply`
  refuses with an actionable message + exit 1 unless OAuth is provisioned, and recommends the `.ics`
  fallback — the Sprint 3 cloud-calendar egress axis is not bypassed.

## Scope

Commit `f30c769`: 4 files changed, **+925 / -2**. New `src/calendar/proposal-gate.ts`
(`proposePlan` / `applyPlan` / `adjustPlan`; all fs writes live here) and a live propose path +
`calendar apply <checkpointId>` in `src/cli/commands/calendar.ts` (no `writeFile` import), plus
`src/calendar/proposal-gate.test.ts` (sc-4-3/4/5) and `src/calendar/calendar-e2e.test.ts` (sc-4-6
propose→approve→apply lifecycle). Build + typecheck + lint clean; full suite **3497** green (87 calendar
tests), zero regressions. All six required criteria (`sc-4-1..sc-4-6`) passed on iteration 1; eval
`eval-sprint-spec-20260628-calendar-planner-4-1` → **pass** (6/6 required), with the core safety
invariant independently verified (`proposePlan` structurally cannot write events, `applyPlan` writes
exactly once on approval / never on reject, `adjustPlan` pure, no auto-approve).

> **Plan status:** Sprint 4 of 4 of `spec-20260628-calendar-planner` (*Calendar planner: deterministic
> slotter + Google MCP/.ics + approve-gate*). **The plan is complete (4 of 4).** The deterministic
> slotter (Sprint 1), the zero-egress `.ics` connector (Sprint 2), the egress-gated Google MCP connector
> (Sprint 3), and this approve-gated live write (Sprint 4) together deliver the end-to-end flow: ranked
> hub Findings → deterministic slot-fill → propose through the existing approval gate → write events
> exactly once on approval.
