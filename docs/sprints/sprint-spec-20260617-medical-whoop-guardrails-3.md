# WHOOP sync adapter + `bober medical whoop sync` CLI

**Contract:** sprint-spec-20260617-medical-whoop-guardrails-3  ·  **Spec:** spec-20260617-medical-whoop-guardrails  ·  **Completed:** 2026-06-17

## What this sprint added

The **end-to-end visible slice** that turns Sprint 2's authenticated-but-non-persisting
WHOOP transport into a working ingestion path: pull WHOOP data and write it to the
medical health store. A new `WhoopSyncAdapter` (`src/medical/whoop/whoop-sync.ts`,
**NO network import** — ADR-1) pages `WhoopClient` across the four collections
(`recovery` / `sleep` / `cycle` / `workout`), maps each `WhoopRecord` to `source:"whoop"`
`HealthObservation`s via a fixed `WHOOP_FIELD_MAP`, and writes them through the
**existing, unchanged** `StoreObservationSink.writeBatch` in bounded per-batch
transactions. Re-running is **idempotent** (content-derived SHA-256 dedup ⇒ `newRows: 0`
on a repeat) and a mid-pagination failure is **fail-closed** (the throw propagates,
committed batches survive, a clean re-run completes — no catch-and-continue). A new
`bober medical whoop sync [--since <iso>]` CLI subcommand wires it together, mirroring
`bober medical import`'s error/exit discipline: it checks the `device-connection` egress
axis **before** constructing any `WhoopClient`/HTTP, surfaces clear axis-off / missing-
credential / not-authorised messages (each `exit 1`, **never** throws), and closes the
store in `finally`. This is **Sprint 3 of the whoop-guardrails spec — the final sprint;
the plan is now complete (3 of 3).** No schema, `ObservationSink`, or `IngestionAdapter`
interface changes; no webhooks; no persisted sync cursor (idempotent re-run instead, ADR-4).

## Public surface

### `src/medical/whoop/whoop-sync.ts` (new — NO network import, ADR-1)

- `class WhoopSyncAdapter` (`whoop-sync.ts:74`) — `constructor(client: WhoopClient)`;
  `readonly source = "whoop"`. **Not** an `IngestionAdapter` (that contract is file-path
  shaped); its entry point is a network `sync`, and all HTTP stays inside the injected
  `WhoopClient`.
  - `sync(window: SyncWindow, sink: ObservationSink): Promise<IngestionResult>`
    (`whoop-sync.ts:84`) — for each of the four collections, loops
    `client.fetchPage(collection, window, cursor)` following `page.nextCursor` until
    `undefined`, maps the page's records, and `await`s `sink.writeBatch(obs, [])`
    per page (the `await` **is** the backpressure; the per-batch better-sqlite3
    transaction commits there). Returns `{ recordsParsed, newRows }` where
    `recordsParsed` counts **mapped observations** (not raw records) and `newRows` is read
    off the sink (mirrors `apple-health.ts`). On any `fetchPage` throw the error
    **propagates** — there is **no** try/catch around the fetch loop (fail-closed).
- `WHOOP_FIELD_MAP` (`whoop-sync.ts:7`, module-private) — the fixed, reviewable
  `Record<WhoopCollection, Record<fieldName, { metric; unit }>>` mapping table. Maps
  known WHOOP score fields per collection (e.g. `recovery_score → whoop_recovery_score %`,
  `hrv_rmssd_milli → whoop_hrv ms`, `strain → whoop_strain score`,
  `kilojoule → whoop_kilojoule kJ`). **Unmapped fields are skipped, never guessed.**
- `mapWhoopRecords(collection, records)` (`whoop-sync.ts:41`, module-private) — pure
  helper that emits one `HealthObservation` per **mapped** field (`metric` + `unit` from
  the table, `value` from the record metric, `tStart = rec.tStartIso`,
  `tEnd = rec.tEndIso`, `source: "whoop"`). The `id` is **left unset** so the store
  derives its content-derived SHA-256 dedup key — the WHOOP UUID (`rec.id`) is **not**
  used as the id, so idempotent re-runs dedup on content, not provider id.

### `src/cli/commands/medical.ts` (extended — new `whoop sync` subcommand)

- `bober medical whoop sync [--since <iso>]` — registered as
  `medical.command("whoop").command("sync")` (`medical.ts:174-189`). On-demand pull (no
  webhooks). `--since` overrides the default window (last 7 days); the window end is
  "now". The action resolves the project root and delegates to `runWhoopSync`.
- `runWhoopSync(projectRoot, opts, deps?)` (`medical.ts:40`, **exported**) — the testable
  core, extracted so CLI tests inject fixture deps with no module-level mocking (mirrors
  `run.test.ts`'s `runRunCommand`). In order: loads config; builds
  `EgressGuard.fromConfig(config)`; **if `device-connection` is off**, prints
  `"device-connection egress not enabled — set medical.egress.deviceConnection: true …"`,
  sets `process.exitCode = 1`, and **returns before constructing any `WhoopClient`/HTTP**;
  builds `WhoopTokenStore` and checks `clientCredentials()` (missing env ⇒ "set
  WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET" + exit 1) and `readRefreshToken()` (absent ⇒
  "WHOOP not yet authorised — run `bober medical whoop authorize` first." + exit 1);
  computes the window (`--since` or now − 7 days) — **the clock is read only here at the
  CLI boundary**, never in the adapter or store; opens `HealthDataStore`
  (`.bober/medical/health.db`); runs `WhoopSyncAdapter.sync`; appends an `event:"ingest"`
  audit entry (`tIso` + event only — **IDs/enums only, PHI-free**, never the record
  counts or values); prints `records parsed` / `new rows`; and **always** `store.close()`
  in `finally`. The whole body is wrapped so it **never throws** — any error becomes a
  red message + `exit 1`.
- `interface WhoopSyncDeps` (`medical.ts:32`, **exported**) — `{ client?: WhoopClient;
  nowIso?: string }`. Production callers pass nothing; tests inject a fixture client and a
  fixed clock so the suite runs fully offline.

## How to use / how it fits

```bash
# one-time per axis: enable device-connection in bober.config.json (default false)
#   medical.egress.deviceConnection: true
# provide WHOOP credentials in the environment:
export WHOOP_CLIENT_ID=...   WHOOP_CLIENT_SECRET=...
# (and authorise once so a refresh token exists in .bober/medical/whoop-token.json)

bober medical whoop sync                       # pull the last 7 days
bober medical whoop sync --since 2026-06-01T00:00:00Z   # pull a custom window
```

This closes the WHOOP path stood up in Sprints 2–3:

```
device-connection egress axis off (default)  → sync refuses before any HTTP  (zero outbound bytes)
device-connection on, creds/token present    → WhoopClient pages v2 (OAuth refresh + pagination, Sprint 2)
  → WhoopSyncAdapter maps records → source="whoop" HealthObservations  (this sprint)
    → StoreObservationSink.writeBatch → HealthDataStore (content-SHA-256 dedup, INSERT OR IGNORE)
      → IngestionResult {recordsParsed, newRows} printed; event="ingest" audit; store.close()
```

It sits **alongside** `bober medical import <file>` (Sprint 5 of the base medical team),
which remains the **offline** Apple Health SAX file-import path. WHOOP sync is the
**on-demand networked device-connection** path; both write `source`-tagged observations
into the same `.bober/medical/health.db` and both are idempotent on re-run.

## Notes for maintainers

- **Fail-closed is structural, not coincidental.** `sync` has **no** try/catch around the
  `fetchPage` loop — a mid-pagination throw propagates, leaving the already-committed
  per-batch rows valid and a clean re-run reaching the same end-state. Do **not** add a
  catch-and-continue; that would silently fail-open with a partial sync.
- **Idempotency is content-derived, not provider-id-derived.** The observation `id` is
  left unset so `HealthDataStore` derives it from `metric|tStart|source|value`
  (SHA-256, `INSERT OR IGNORE`). The WHOOP UUID is deliberately **not** the dedup key.
  A second sync over an overlapping window reports `newRows: 0`. No persisted sync cursor
  exists (explicit non-goal, ADR-4) — re-run is the recovery/resume mechanism.
- **The axis gate runs before any HTTP construction.** `runWhoopSync` checks
  `egress.isAllowed("device-connection")` **before** building `WhoopTokenStore` /
  `WhoopClient`, so the axis-off path never constructs a network client — a test asserts
  the `fetchPage` spy sees **zero** calls. This is the CLI-boundary peer to
  `WhoopClient`'s own first-statement `assertAllowed` (defence in depth).
- **The mapping table is the review surface.** `WHOOP_FIELD_MAP` is a small fixed table;
  adding/changing a WHOOP metric is a deliberate code edit, and any field not in the table
  is **skipped, never guessed**. No new numerics primitives were added — WHOOP metrics
  flow through the existing closed whitelist.
- **All HTTP stays in `whoop-client.ts`.** `whoop-sync.ts` and the CLI contain **no**
  network import (verified by the scoped ESLint boundary + a grep); the adapter depends on
  the `WhoopClient` interface, the CLI injects it. Keep new outbound calls inside
  `whoop-client.ts` or they fail `npm run lint`.
- **Audit stays PHI-free.** The `ingest` entry carries `tIso` + `event:"ingest"` only —
  never `recordsParsed` / `newRows` / metric values — consistent with the existing import
  path and the `AuditEntry` type.
- **Clock only at the CLI boundary.** The window start/end are computed in `runWhoopSync`
  (injectable via `deps.nowIso` for tests); the adapter and store never read the clock.
- **`whoop authorize` is referenced but not yet implemented.** The not-authorised message
  points at `bober medical whoop authorize`, which is **not** part of this sprint — the
  refresh token must currently be provisioned out of band into
  `.bober/medical/whoop-token.json`. See **Notes for the orchestrator** in the response —
  flagged as a follow-up, not a bug.
- **Plan close-out.** This is the final sprint of `spec-20260617-medical-whoop-guardrails`
  (3 of 3). With it, the medical team gains the non-emergency refusal Gate 2b (Sprint 1)
  and a full WHOOP device-connection ingestion path behind a third, zero-default egress
  axis (Sprints 2–3). **2484 tests** pass. **Shipping still inherits the base medical
  team's external S6.5 FFDCA §201(h) counsel + regulatory review gate** — the code is
  engineering-complete, the regulatory gate is non-engineering and open.
