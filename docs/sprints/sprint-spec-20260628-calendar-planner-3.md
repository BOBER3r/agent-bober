# Google Calendar MCP connector (egress-gated) + safe-title privacy

**Contract:** sprint-spec-20260628-calendar-planner-3  ·  **Spec:** spec-20260628-calendar-planner  ·  **Completed:** 2026-06-29

## What this sprint added

Sprint 3 ships the **second `CalendarConnector` implementation** — a **Google Calendar** connector that
reads free/busy and writes events through an external MCP subprocess — and makes it **opt-in and
fail-closed**. A new `calendar` config section adds a default-`false` `calendar.egress.cloudCalendar`
egress axis (modeled on the medical `EgressGuard`); a `CalendarEgressGuard` refuses **before any MCP
client is constructed** when the axis is off, and the connector also refuses when the 0600 OAuth token
sidecar is absent. The one **privacy invariant** that makes cloud egress safe: only
`finding.calendarSafeTitle` (or the generic placeholder `"Focus block"`) ever leaves the device as the
event summary — **never** `PlanItem.title`, evidence, or tags. The Google connector is structurally
interchangeable with the Sprint 2 `.ics` connector behind `CalendarConnector`, so the slotter and CLI are
untouched. Because hosted OAuth needs an interactive re-auth when tokens expire, the connector and
[`docs/calendar.md`](../calendar.md) both state it is **unfit for unattended/cron runs** and point those
runs to the zero-egress `.ics` fallback (Sprint 2).

## Public surface

- `createGoogleConnector(opts)` (`src/calendar/google-connector.ts:109`) — factory returning a
  `CalendarConnector` named `"google"`. Both `readFreeBusy` and `writeEvents` call a shared `guard()`
  **first** (egress axis + token-present check) before touching the adapter, so an axis-off or
  token-absent call throws and records **zero** `listTools`/`callTool`. `writeEvents` maps each `PlanItem`
  to `{ summary, start, end }` where `summary = safeTitleById.get(item.findingId) ?? item.calendarSafeTitle
  ?? "Focus block"`.
- `GoogleConnectorOptions` (`src/calendar/google-connector.ts:81`) — `{ adapter, egress, token,
  findings, freeBusyTool?, writeEventTool? }`. `findings` is the **only** source of truth for safe titles
  (a `findingId → calendarSafeTitle` map is built once at factory time); `token` is the OAuth string (or
  `undefined` to refuse); tool names default to `google_calendar_get_free_busy` /
  `google_calendar_create_event`.
- `GoogleCalendarToolAdapter` (`src/calendar/google-connector.ts:32`) — the minimal injection surface
  `{ listTools(): Promise<ToolDescriptor[]>; callTool(name, args): Promise<unknown> }`. `ExternalMcpServer`
  satisfies it structurally in production; tests inject a hand-rolled stub (no live OAuth/network in CI).
- `sanitizeCalendarError(msg)` (`src/calendar/google-connector.ts:44`) — strips `KEY=VALUE` env
  assignments (regex replicated inline from `src/mcp/external-client.ts:69`) so tokens/MCP env never
  surface in a thrown message; applied to every adapter error.
- `CalendarEgressGuard` (`src/calendar/calendar-egress.ts:16`) — `static fromConfig(config)` reads
  `config.calendar?.egress?.cloudCalendar ?? false`; `assertCloudCalendarAllowed()` throws naming
  `calendar.egress.cloudCalendar` when off (void when allowed); `isCloudCalendarAllowed()` is the boolean
  predicate.
- `CalendarTokenStore` (`src/calendar/calendar-token.ts:26`) — 0600 sidecar at
  `.bober/calendar/google-token.json`. `readToken()` is **fail-closed** (returns `undefined` on
  absent/corrupt rather than throwing); `writeToken(token)` persists `{ token }` with mode `0600` (mirrors
  `whoop-token.ts`). The OAuth acquire handshake is out of scope — the token is provisioned out-of-band.
- `calendar` config section (`src/config/schema.ts:464` `CalendarSectionSchema`, composed at
  `src/config/schema.ts:517` as `calendar: CalendarSectionSchema.optional()`) — `{ egress?: {
  cloudCalendar: boolean (default false) }, connector: "ics" | "google" (default "ics"), timezone?: string
  }`. Additive and optional; `createDefaultConfig` is unchanged, so a config without the `calendar` key
  parses and `cloudCalendar` resolves to `false`.
- `PlanItem.calendarSafeTitle?` (`src/calendar/types.ts:80`) — additive optional field the slotter now
  populates from `finding.calendarSafeTitle` (`src/calendar/slotter.ts:213`); a belt-and-suspenders fallback
  for the safe-title map.

## How to use / how it fits

The Google connector is the cloud sibling of the Sprint 2 `.ics` connector behind the same
`CalendarConnector` interface. It is **off by default**. To enable it:

```json
{
  "calendar": {
    "egress": { "cloudCalendar": true },
    "connector": "google"
  }
}
```

and provision an OAuth token out-of-band into the 0600 sidecar:

```json
// .bober/calendar/google-token.json   (mode 0600)
{ "token": "<oauth-access-token>" }
```

With the axis off (the default) or the sidecar absent, any read/write refuses immediately with a message
naming `calendar.egress.cloudCalendar` (or suggesting the `.ics` fallback) and makes **no** MCP call.
Full user-facing config and privacy details live in [`docs/calendar.md`](../calendar.md); CLI usage lives
in [`COMMANDS.md`](../../COMMANDS.md) under **Calendar Commands**. This sprint provides the connector the
**Sprint 4 approve-gate** will call before a live write.

## Notes for maintainers

- **Privacy source of truth is `findings`, not `PlanItem`.** The event summary comes from the
  `findingId → calendarSafeTitle` map built at factory time; `PlanItem.calendarSafeTitle` is only a
  secondary fallback. Never wire the summary to `PlanItem.title` — the slotter sets `title` to
  `finding.calendarSafeTitle ?? finding.title`, so it can contain the full sensitive title.
- **`guard()` must stay the first statement** in every public connector method — that ordering is the
  sc-3-3 invariant (refuse before constructing/calling the adapter). Adding a new method means adding a
  leading `guard()` call too.
- **Error sanitization regex is replicated, not imported.** `sanitizeCalendarError` duplicates
  `src/mcp/external-client.ts:69` inline to avoid cross-spec coupling (the calendar module keeps a local
  `Finding` consume-copy and avoids importing `src/hub`). If the external-client regex changes, update this
  copy in lockstep.
- **Hosted OAuth is unfit for unattended/cron runs — by design.** Tokens expire and re-auth is
  interactive. The caveat + `.ics` fallback recommendation live in the module doc-comment and
  `docs/calendar.md`; keep both in sync. The OAuth authorize handshake and live token acquisition are out
  of scope (provisioned out-of-band, mirroring WHOOP).
- **No live network in tests.** The `GoogleCalendarToolAdapter` is injected as a stub; there is no real
  OAuth or MCP spawn in CI. The production adapter wrapping `ExternalMcpServer` is what supplies real tool
  discovery (`listTools`) and calls (`callTool`).

## Scope

Commit `123c7c4`: 10 files changed, **+1096 / -0**. New `src/calendar/{calendar-egress,calendar-token,
google-connector}.ts` (each with a collocated test), an additive `CalendarSectionSchema` in
`src/config/schema.ts` (19 lines; `createDefaultConfig` untouched), a 7-line additive optional
`calendarSafeTitle` on `PlanItem` (`src/calendar/types.ts`), a 2-line slotter edit threading it
(`src/calendar/slotter.ts`), and `docs/calendar.md` (the unattended-OAuth caveat + `.ics` fallback,
created by the generator to satisfy sc-3-6). **82 new tests** (egress guard, token sidecar, connector
behavior/privacy/sanitization); build + typecheck + lint clean, full suite **3482** green, zero
regressions. All six required criteria (`sc-3-1..sc-3-6`) passed on iteration 1; eval
`eval-sprint-spec-20260628-calendar-planner-3-1` → **pass** (6/6 required), with four security invariants
independently verified (egress fires before any adapter call, summary from `calendarSafeTitle` only,
errors sanitized, OAuth caveat present).

> **Plan status:** Sprint 3 of 4 of `spec-20260628-calendar-planner` (*Calendar planner: deterministic
> slotter + Google MCP/.ics + approve-gate*). The **approve-gated live write** (Sprint 4) — which calls
> this connector behind the existing approve/steer gate — remains owned by the final sprint.
