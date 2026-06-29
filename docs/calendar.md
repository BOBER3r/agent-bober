# Calendar Planner

The calendar planner sub-system schedules hub Findings into calendar time-slots.
It ships two connectors that both implement the `CalendarConnector` interface:

1. **Local `.ics` connector** (Sprint 2) — zero-egress, writes an RFC 5545 file to disk.
2. **Google Calendar connector** (Sprint 3) — cloud egress, writes events via the Google Calendar MCP.

---

## Connectors

### Local .ics (default, zero-egress)

```
bober calendar plan --export-ics /path/to/output.ics
```

No configuration required. Produces a standard `.ics` file that any calendar
application can import. **This is the recommended connector for unattended / cron-scheduled runs.**

### Google Calendar (cloud, opt-in)

**WARNING: hosted OAuth is UNFIT for unattended or cron-scheduled runs.**

The Google connector uses interactive OAuth tokens that expire. Re-authorization
requires a user present at a terminal. For any scheduled or automated use, use the
local `.ics` fallback (`bober calendar plan --export-ics`) instead.

#### Enabling

Set the egress axis in `bober.config.json`:

```json
{
  "calendar": {
    "egress": {
      "cloudCalendar": true
    },
    "connector": "google"
  }
}
```

The axis defaults to `false` (fail-closed). Without it, any attempt to write to
Google refuses immediately with an error naming the `calendar.egress.cloudCalendar` flag
and records zero network calls.

#### Token provisioning

Provision a Google OAuth token out-of-band into the 0600 sidecar:

```
.bober/calendar/google-token.json
```

File format:

```json
{
  "token": "<your-oauth-access-token>"
}
```

The file must have mode `0600`. The connector refuses with a clear message (and
suggests the `.ics` fallback) when the sidecar is absent.

**Note:** The OAuth authorize handshake is out of scope. Token acquisition is
performed out-of-band (mirrors the WHOOP pattern in `src/medical/whoop/whoop-token.ts`).

#### Privacy

Only `finding.calendarSafeTitle` (or the generic placeholder `"Focus block"` when
absent) is sent as the event summary. The event payload never contains:

- The full finding title
- Evidence strings
- Tags

The `.ics` connector uses the full title locally (no egress).

---

## Config reference

```json
{
  "calendar": {
    "egress": {
      "cloudCalendar": false
    },
    "connector": "ics",
    "timezone": "America/New_York"
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `egress.cloudCalendar` | boolean | `false` | Allow Google Calendar cloud egress. Fail-closed. |
| `connector` | `"ics"` \| `"google"` | `"ics"` | Active connector. |
| `timezone` | string | — | IANA timezone (informational only). |
