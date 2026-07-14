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

## Approval gate: propose -> approve -> apply

The default `bober calendar plan` (no `--dry-run` / `--export-ics`) is the **live path**. It does
**not** write any calendar events directly. Instead it **proposes** the schedule through the existing
approval gate and writes events only after the checkpoint is explicitly approved. This is the full safety
flow and it reuses `src/state/approval-state.ts` and the existing `bober approve` / `/approve` /
`/reject` / `/tell` handlers — there is **no** new approval mechanism and **no** auto-approve in any mode
(including autopilot).

1. **Propose.** `bober calendar plan --findings <path> [--freebusy <path>]` slots the findings and writes:
   - a pending approval marker at `.bober/approvals/<checkpointId>.pending.json` (via `savePending`), and
   - a plan sidecar at `.bober/calendar/<checkpointId>.plan.json` holding the proposed plan + connector name.

   It writes **zero** calendar events and prints the `checkpointId` (= `calendar-<planId>`, mirroring
   do-bridge's `promote-<id>`) plus how to approve it.

2. **Approve (out-of-band).** `bober approve <checkpointId>` (or `/approve <checkpointId>` in chat) writes
   the `.approved.json` marker. Rejecting with `/reject <checkpointId> [feedback]` writes a
   `.rejected.json` marker instead.

3. **Apply.** `bober calendar apply <checkpointId>` detects the marker inline (via `readdir`, there is no
   `readApproved`/`readRejected` reader) and:
   - on **approved** → reloads the sidecar and calls the chosen connector's `writeEvents` **exactly once**,
     then deletes the pending marker;
   - on **rejected** → aborts with the feedback and exit 1, **never** writing;
   - on **neither** → reports `Pending approval` and writes nothing.

```bash
# propose (zero events written)
bober calendar plan --findings ./ranked-findings.json --freebusy ./freebusy.json
#   → Checkpoint ID: calendar-<planId>

# approve, then apply (writeEvents called exactly once)
bober approve calendar-<planId>
bober calendar apply calendar-<planId>
```

A `/tell`-style correction re-runs the deterministic slotter under a constraint delta (exclude an
interval, or shift the planning window) and **re-proposes** the schedule — pure, with no events written.

**The connector chosen for the live write is `calendar.connector`** (default `ics`). When it is
`google`, the apply path still enforces the `calendar.egress.cloudCalendar` egress axis and the 0600
OAuth token requirement described above — it refuses with an actionable message + exit 1 when OAuth is not
provisioned, and recommends the `--export-ics` fallback for unattended runs.

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
