# Snooze with wake semantics

**Contract:** sprint-spec-20260628-task-inbox-3  ·  **Spec:** spec-20260628-task-inbox  ·  **Completed:** 2026-06-29

## What this sprint added

Sprint 3 lets a user **defer** a task with `bober task snooze <id> --until <when>`: the task moves to
`status='snoozed'`, records its wake time as a `snooze-until:<ISO>` entry on the Finding's `tags[]`,
and **disappears from the default `bober task list`** until that wake time has passed — then it
reappears for re-triage. Visibility is computed **lazily at list time** against an **injected clock**
(there is no background timer and no auto-wake). **No** Finding schema field was added — the wake
time lives entirely in `tags[]`, and `'snoozed'` was already a member of the status enum. Re-snoozing
a task **replaces** its wake time rather than stacking tags, and terminal (`done`/`dropped`) tasks
cannot be snoozed.

## Public surface

- **`bober task snooze <id> --until <when>`** (`src/cli/commands/task.ts:306`, registered in
  `registerTaskCommand`) — defer a task. `--until` is **required**; it accepts an ISO date or
  datetime (e.g. `2026-12-01` or `2026-12-01T09:00:00Z`). The value is parsed with `new Date(when)`
  and **normalized to a canonical ISO** via `.toISOString()` at the CLI boundary. On an unparseable
  value (`NaN`) it prints a red `invalid --until value` error and sets `process.exitCode = 1`
  **without throwing**. An unknown id or a terminal task prints a yellow message and also exits
  non-zero. On success it prints `Task <id> snoozed until <ISO>`.
- `isVisibleInDefaultList(finding, now)` (`src/hub/finding-store.ts:104`) — the **PURE** default-list
  predicate. Returns `true` for `open`/`in-progress`; for `snoozed` returns `true` only when the wake
  time is `<= now` (or there is no valid snooze-until tag — treated as visible so the user
  re-triages); returns `false` for `done`/`dropped`. **Never reads the clock** — `now` is a
  parameter.
- `snoozeUntil(finding)` (`src/hub/finding-store.ts:85`) — PURE helper that extracts the wake-time ISO
  string from the first `snooze-until:` tag, or `null` if absent.
- `SNOOZE_TAG_PREFIX` (`src/hub/finding-store.ts:78`) — the exported constant `"snooze-until:"` used
  to encode and strip the wake-time tag.
- `runTaskSnooze(store, id, until, now)` (`src/cli/commands/task.ts:181`) — DI core for the snooze
  command. Parses/normalizes `until`, reads the active Finding, **strips any prior `snooze-until:`
  tag and appends the new one**, then delegates to `transitionFinding` with `newStatus='snoozed'`.
  Never throws.
- `runTaskList(store, opts, now)` (`src/cli/commands/task.ts:101`) — **signature change**: gained a
  third `now: string` parameter and its default filter now uses `isVisibleInDefaultList(f, now)`
  instead of the old `ACTIVE_STATUSES` membership check (that module-private constant was removed).
  `--all` and `--status <s>` paths are unchanged. The `task list` handler stamps
  `now = new Date().toISOString()` at the boundary and passes it in.

## How to use / how it fits

```bash
$ bober task add "renew passport"
Captured task 1f3c9a0b2e4d6f80

$ bober task snooze 1f3c9a0b2e4d6f80 --until 2026-12-01
Task 1f3c9a0b2e4d6f80 snoozed until 2026-12-01T00:00:00.000Z

$ bober task list                 # snoozed task is hidden until its wake time
No tasks found.

$ bober task list --all           # …but still in the store, status=snoozed
ID                 STATUS       DOMAIN       TITLE
--------------------------------------------------------------------------------
1f3c9a0b2e4d6f80   snoozed      inbox        renew passport

# once the wall clock passes 2026-12-01, the task returns to the default list.
```

Snooze reuses the Sprint 2 `transitionFinding` supersede path, so a snooze is recorded as a
bitemporal UPDATE (prior status survives as history) exactly like `start`/`done`/`drop`. A snoozed
task can still be **completed or dropped** at any time — those transitions are unchanged and clear it
from the list by their own `status`. Like every other task handler, `snooze` stamps `now` at the
boundary only, opens the active team's namespace `FactStore`, and closes it in a `finally`.

## Notes for maintainers

- **No auto-wake.** There is no timer or scheduler. A snoozed task "wakes" purely because the next
  `task list` runs with a `now` that has passed the stored wake time. Reminders/notifications on wake
  are out of scope (telegram/scheduler territory).
- **Lexicographic ISO comparison is intentional and safe.** `isVisibleInDefaultList` compares
  `wake <= now` as plain strings. This is correct **only** because both sides are always
  `Date.prototype.toISOString()` output (`YYYY-MM-DDTHH:mm:ss.sssZ` — fixed width, always `Z`). The
  wake time is normalized with `.toISOString()` before it is ever stored in the tag, so the invariant
  holds. Do not store a raw/non-normalized `--until` string in the tag, or the string compare breaks.
- **Re-snooze replaces, never stacks.** `runTaskSnooze` filters out any existing `snooze-until:` tag
  before appending the new one. Keep that strip-then-append order if you touch the tag write.
- **`now` stays out of the hub layer.** `isVisibleInDefaultList` / `snoozeUntil` are PURE; the only
  clock read is `new Date().toISOString()` at the two CLI handler boundaries (`list`, `snooze`).
- **No schema change.** The wake time lives in `tags[]`; `src/hub/finding.ts` is untouched. If you
  ever migrate it to a first-class field, update `snoozeUntil`, `SNOOZE_TAG_PREFIX`, and the strip
  logic together.
- **Sibling reads are unaffected.** `bober hub list` / `priority` / `decide` / `chat hub` do not call
  `isVisibleInDefaultList`; a snoozed task is still an ordinary active Finding to them. Only the
  default `bober task list` hides it.

## Scope

Commit `2b5c3c9`: 3 files changed, **+290 / -13** — `src/hub/finding-store.ts` (+42:
`SNOOZE_TAG_PREFIX`, `snoozeUntil`, `isVisibleInDefaultList`) and `src/cli/commands/task.ts` (+122:
`runTaskSnooze`, the `snooze` registration, the `runTaskList` `now` parameter + filter swap, removal
of the `ACTIVE_STATUSES` constant), plus the collocated `task.test.ts` (**+6 snooze tests**, 3
existing `runTaskList` call sites updated to pass `now`), all against an in-memory `:memory:`
FactStore. **No** new runtime dependency; `src/hub/finding.ts` (the Finding schema), `captureTask`,
`transitionFinding`, and the priority-hub collector/judge/renderer are untouched. All five criteria
(`sc-3-1..sc-3-5`, four required) passed on iteration 1 (**zero reworks**); eval
`eval-sprint-spec-20260628-task-inbox-3-1` → **pass** (5/5), full suite **3291 → 3297** green, build +
typecheck + lint clean (0 errors).
