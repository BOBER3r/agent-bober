# Connector interface + .ics export (local-first, zero-egress)

**Contract:** sprint-spec-20260628-calendar-planner-2  ·  **Spec:** spec-20260628-calendar-planner  ·  **Completed:** 2026-06-29

## What this sprint added

Sprint 2 introduces the **single calendar abstraction** the planner depends on — a `CalendarConnector`
interface (`readFreeBusy` + `writeEvents`) — and ships its **first concrete implementation**: a
local-first **RFC 5545 (`.ics`) exporter** that materializes a `ProposedPlan` to a file on disk with
**zero network egress**. A new `bober calendar plan --export-ics <path>` flag slots the ranked findings
(reusing the Sprint 1 pure slotter, **unchanged**) and writes a `VCALENDAR` file with one `VEVENT` per
scheduled item, which the user imports manually into their calendar app. The slotter and CLI now depend
only on the `CalendarConnector` interface, so the Sprint 3 Google connector can be added without
touching the slotter (the DoD's extensibility contract).

## Public surface

- `CalendarConnector` (`src/calendar/connector.ts:23`) — the single calendar abstraction both the `.ics`
  (this sprint) and Google (Sprint 3) connectors implement: `{ readonly name: string; readFreeBusy(window):
  Promise<BusyInterval[]>; writeEvents(items: PlanItem[]): Promise<WriteResult> }`. The slotter/CLI depend
  on this interface only.
- `FreeBusyWindow` (`src/calendar/connector.ts:8`) — the free/busy lookup window `{ windowStartIso,
  windowEndIso }` (a subset of `SlotConstraints`).
- `WriteResult` (`src/calendar/connector.ts:14`) — the outcome of `writeEvents`: `{ writtenCount: number;
  target: string }` (how many events written and the destination path).
- `createIcsConnector(opts)` (`src/calendar/ics-connector.ts:63`) — factory returning a `CalendarConnector`
  named `"ics"`. `writeEvents` serializes `PlanItem[]` to RFC 5545 and writes it via `node:fs/promises`
  `writeFile`; `readFreeBusy` reads a local free/busy JSON file (or returns `[]` when none is configured) —
  **no network in either path**.
- `IcsConnectorOptions` (`src/calendar/ics-connector.ts:54`) — `{ outPath: string; freeBusyPath?: string;
  nowIso?: string }`. `outPath` is the `.ics` destination; `freeBusyPath` is an optional local
  `BusyInterval[]` JSON file; `nowIso` is an injectable clock for `DTSTAMP` determinism.
- `bober calendar plan --export-ics <path>` (`src/cli/commands/calendar.ts`) — new flag on the existing
  command. When set, `runCalendarPlan` builds a connector (default `createIcsConnector`), calls
  `writeEvents(plan.scheduled)`, and prints `Wrote N event(s) to <path>`. The Sprint 1 dry-run/preview path
  is byte-identical when the flag is absent.
- `CalendarPlanDeps.makeConnector?` (`src/cli/commands/calendar.ts`) — new optional injectable
  `(outPath: string) => CalendarConnector` so tests can substitute the connector; production passes none
  and falls back to `createIcsConnector`.

## How to use / how it fits

```bash
bober calendar plan --export-ics out.ics --findings ./ranked-findings.json --freebusy ./freebusy.json
```

slots the ranked findings exactly as Sprint 1 does, then writes an RFC 5545 file with one `VEVENT` per
scheduled item:

```text
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//agent-bober//calendar-planner//EN
BEGIN:VEVENT
UID:f-1@agent-bober
DTSTAMP:20260629T000000Z
DTSTART:20260629T000000Z
DTEND:20260629T003000Z
SUMMARY:Renew prescription
END:VEVENT
...
END:VCALENDAR
```

Each `VEVENT` carries `UID` (`<findingId>@agent-bober`), `DTSTAMP`, `DTSTART`/`DTEND` in UTC basic format
(`YYYYMMDDTHHMMSSZ`), and `SUMMARY` (the `PlanItem.title`, RFC 5545 TEXT-escaped). Lines use CRLF
endings with a trailing CRLF per spec. The produced file imports cleanly into a calendar app — this is the
**user-invoked, manually-imported** path, which is also the offline/unattended fallback for the OAuth
caveat. No approval gate applies here (the manual import step is the human review; the gate lands in
Sprint 4 for direct live writes).

## Notes for maintainers

- **File writes live ONLY in `ics-connector.ts`.** `calendar.ts` calls `connector.writeEvents()` and keeps
  **no** `writeFile` import — Sprint 1's no-`writeFile` source-scan on `calendar.ts` still passes. Putting
  the only `node:fs/promises` write behind the connector is what keeps the CLI connector-agnostic.
- **Zero egress is source-scanned, not just asserted.** `ics-connector.ts` imports no `http`/`https`/
  `fetch`, no `src/mcp/external-client`, and no `child_process`; `readFreeBusy` reads only a local file via
  `node:fs/promises` (delegated to `readBusyIntervalsFromFile`). Keep it that way — the Google network path
  is a separate connector (Sprint 3), not an edit to this file.
- **`DTSTAMP` is injectable for determinism.** `nowIso` is threaded from the CLI boundary into the connector
  and used for every `VEVENT`'s `DTSTAMP`; default is `new Date().toISOString()`. The round-trip test
  depends on this determinism.
- **Hand-rolled VEVENT writer, intentionally minimal.** No calendar library was added. Out of scope (by
  contract): recurring events (`RRULE`), attendees, alarms (`VALARM`), and timezones beyond UTC
  normalization. `SUMMARY` escaping covers backslash (first), newline, comma, and semicolon per RFC 5545
  §3.3.11; if richer fields are added later, extend the escaping in lockstep.

## Scope

Commit `0481407`: 5 files changed, **+343 / -2**. New `src/calendar/connector.ts` (interface +
`WriteResult` + `FreeBusyWindow`) and `src/calendar/ics-connector.ts` (RFC 5545 writer), each with
collocated tests, plus a **21-line additive edit** to `src/cli/commands/calendar.ts` (the `--export-ics`
branch + `makeConnector` dep; no `writeFile` import). **10 new calendar tests** (generation, round-trip,
no-egress source-scan, live `--export-ics`); build + typecheck + lint clean, full suite **3438** green,
zero regressions, `slotter.ts` byte-unchanged. All six required criteria (`sc-2-1..sc-2-6`) passed on
iteration 1; eval `eval-sprint-spec-20260628-calendar-planner-2-1` → **pass** (6/6 required).

> **Plan status:** Sprint 2 of 4 of `spec-20260628-calendar-planner` (*Calendar planner: deterministic
> slotter + Google MCP/.ics + approve-gate*). The Google Calendar MCP adapter + live free/busy read
> (Sprint 3) and the approve-gated live write (Sprint 4) remain owned by later sprints. User-facing CLI
> usage for `bober calendar plan --export-ics` lives in [`COMMANDS.md`](../../COMMANDS.md) under
> **Calendar Commands** and the README CLI list.
