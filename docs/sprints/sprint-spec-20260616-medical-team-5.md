# Apple Health ingestion (SAX streaming) + `bober medical import`

**Contract:** sprint-spec-20260616-medical-team-5  ·  **Spec:** spec-20260616-medical-team  ·  **Completed:** 2026-06-16

## What this sprint added

Bounded, streaming **ingestion** for the medical team — the path that actually
fills the Sprint 4 `HealthDataStore`. An `IngestionNormalizer` holds an
`IngestionAdapter` **registry** and drives `importFile(path)` through the first
adapter that `canHandle`s the file, into the store via an async
`ObservationSink`. The first adapter, `AppleHealthAdapter`, stream-parses the
Apple Health `export.xml` via **SAX** with bounded (~1000-row) batches and
for-await backpressure, so it **never loads the whole (~multi-GB) document into
memory**. A `bober medical import <file>` CLI command wires it end-to-end and
prints the resulting counts. Re-importing the same file is idempotent — the
Sprint 4 `INSERT OR IGNORE` dedup makes the second run report `newRows: 0`.
This is Sprint 5 of 7; egress guard + medications + full SOP wiring (S6) and
literature retrieval (S7) remain.

## Public surface

### `src/medical/types.ts` (additive)

- `IngestionResult` (`types.ts:190`) — `{ recordsParsed: number; newRows: number }`.
  `recordsParsed` is the total numeric `<Record>` elements seen; `newRows` is the
  count of rows actually inserted (dedup-aware via S4 `INSERT OR IGNORE`).
- `ObservationSink` (`types.ts:199`) — `writeBatch(obs: HealthObservation[], labs: LabResult[]): Promise<void>`.
  The sink is **async on purpose** so the adapter can await it and apply backpressure.
- `IngestionAdapter` (`types.ts:208`) — `{ readonly kind: string; canHandle(filePath): boolean; ingest(filePath, sink): Promise<IngestionResult> }`.
  Adding a new source (Whoop, CSV, …) is a **new class only** — the registry dispatches by `canHandle` (ADR-4).

### `src/medical/ingestion.ts`

- `class StoreObservationSink` (`ingestion.ts:16`) — `ObservationSink` backed by a
  `HealthDataStore`. `writeBatch` calls `store.upsertObservations(obs)` and
  `store.upsertLabResult(lab)` (both synchronous `better-sqlite3` calls) and
  accumulates the public `newRows` counter across **all** batches for the final result.
- `class IngestionNormalizer` (`ingestion.ts:39`) — the adapter registry.
  - `register(adapter)` (`ingestion.ts:49`) — push an adapter onto the registry (linear-scan dispatch).
  - `importFile(filePath)` (`ingestion.ts:57`) — find the first adapter where
    `canHandle(filePath)`, then `await adapter.ingest(filePath, sink)` and return its
    `IngestionResult`. Throws `Error("No ingestion adapter can handle '<path>'")`
    (message contains the path) when no adapter matches (sc-5-7).

### `src/medical/adapters/apple-health.ts`

- `class AppleHealthAdapter` (`apple-health.ts:29`) — `IngestionAdapter` (`kind = "apple-health"`).
  - `canHandle(filePath)` (`apple-health.ts:35`) — cheap `.xml` extension check (no read).
  - `ingest(filePath, sink)` (`apple-health.ts:47`) — the streaming parser (see below).

### CLI — `src/cli/commands/medical.ts`

- `bober medical import <file>` (`medical.ts:34`) — opens the medical
  `HealthDataStore` at `.bober/medical/health.db`, constructs the
  `IngestionNormalizer` + `StoreObservationSink` + `AppleHealthAdapter`, runs
  `importFile(file)`, prints `records parsed` / `new rows`, and always closes the
  store in a `finally`. Registered via `registerMedicalCommand(program)` in
  `src/cli/index.ts:318`.

## How to use / how it fits

```bash
# Stream an Apple Health export into .bober/medical/health.db
bober medical import ~/apple_health_export/export.xml
#   Imported ~/apple_health_export/export.xml
#     records parsed: 248913
#     new rows:       248913

# Re-run is idempotent — dedup via INSERT OR IGNORE:
bober medical import ~/apple_health_export/export.xml
#     records parsed: 248913
#     new rows:       0
```

Ingestion is the populate-the-store half of the medical SOP. It calls Sprint 4's
`HealthDataStore.upsertObservations` (via the sink); the Sprint 4
`NumericsQueryLayer` then reads from the same store. S6 will wire the numerics
layer into `MedicalSopEngine.run`, completing the chain: **import → store →
numerics → guardrailed answer**.

### Streaming / backpressure mechanism (sc-5-4, sc-5-5)

`AppleHealthAdapter.ingest` deliberately avoids ever holding the document in
memory:

1. **`createReadStream`, never `readFile`.** The file is opened with
   `fs.createReadStream(filePath, { encoding: "utf8" })` and consumed as an
   **async iterable** (`for await (const chunk of stream)`). The stream stays
   paused between iterations — there is no `fs.readFile`/`readFileSync` of the
   whole file anywhere in the layer.
2. **Bounded batches.** Each chunk is fed synchronously to a strict SAX parser
   (`sax.parser(true, { trim: true })`). On every `<Record>` open tag the
   attributes map to a `HealthObservation` and push into a buffer. While
   `buffer.length >= BATCH_CAP` (`= 1000`, `apple-health.ts:13`) the adapter
   `splice`s off a 1000-row slice and `await`s `sink.writeBatch(batch, [])`.
3. **Backpressure = the `await`.** Awaiting `writeBatch` inside the `for await`
   loop **is** the backpressure: the loop does not pull the next chunk from the
   stream until the write resolves, so rows cannot accumulate unbounded behind a
   slow sink. The evaluator proved this with a slow (5 ms/batch) sink whose
   write-start/write-end events are strictly sequential.
4. **Tail flush.** After the stream ends, `parser.close()` is called (in a
   try/catch that tolerates malformed XML tails) and any remaining `< BATCH_CAP`
   buffered observations are flushed in a final `writeBatch`.

### `<Record>` attribute mapping

Each Apple Health `<Record type="…" unit="…" value="…" startDate="…"
endDate="…" sourceName="…"/>` element maps to a `HealthObservation`:

| `<Record>` attribute | `HealthObservation` field | Notes |
|---|---|---|
| `type` | `metric` | e.g. `HKQuantityTypeIdentifierBodyMass` |
| `value` | `value` | `parseFloat`; **`NaN` ⇒ record skipped** (non-numeric records are not stored) |
| `unit` | `unit` | |
| `startDate` | `tStart` | |
| `endDate` | `tEnd` | optional (omitted when empty) |
| (constant) | `source` | always `"apple-health"` — `sourceName` is **not** propagated |

Only numeric records are ingested; `recordsParsed` counts the numeric records
that were buffered, not every `<Record>` in the file.

## Notes for maintainers

- **`sax@1.6.0` dependency — rationale + isolation.** Apple Health exports are
  too large to load whole, so a streaming, event-based parser is required. `sax`
  is a tiny, pure-JS, long-established SAX parser with **no native build step and
  no network surface**. The import is **isolated to `src/medical/adapters/apple-health.ts`
  only** (`import * as sax from "sax"`); no other file imports it. This keeps the
  blast radius of the dependency to the one adapter that needs it — if `sax` is
  ever swapped, only this file changes.
- **Adapter-registry extensibility (ADR-4).** Adding Whoop / CSV / other sources
  is intentionally **additive**: write a new class implementing `IngestionAdapter`
  (its own `canHandle` + `ingest`), `register()` it on the `IngestionNormalizer`,
  and the existing dispatch picks it up — no change to `IngestionNormalizer`,
  `StoreObservationSink`, or the CLI plumbing. Whoop/CSV adapters were an explicit
  **non-goal** of this sprint (Apple Health XML only). `canHandle` is currently a
  cheap `.xml` extension check; the source comment notes it can be extended to
  sniff the `HealthData` root if the registry ever needs to disambiguate multiple
  XML formats.
- **Idempotency comes from S4, not from ingestion.** The adapter does no
  de-duplication itself — re-import safety is entirely the Sprint 4
  `HealthDataStore` `INSERT OR IGNORE` on the deterministic
  `observationId(metric|tStart|source|value)`. `StoreObservationSink.newRows`
  reflects `info.changes`, so a second import of the same file reports
  `newRows: 0` with an unchanged store row count.
- **`IngestionResult.newRows` is read off the sink.** `ingest` reads `newRows`
  back from the sink via a structural `"newRows" in sink` check (falls back to `0`
  if a future sink does not expose it). The count is therefore the sink's running
  total across all batches, not a per-batch figure.
- **SAX parse errors.** `parser.onerror` captures the error and clears
  `parser.error` so the parser is not permanently stuck; a captured error is
  rethrown right after the offending chunk so a genuinely malformed file fails the
  import rather than silently truncating.
- **Generation note (recovery).** The first generator attempt **crashed on a
  transient API socket error** after the implementation was already complete
  (typecheck/build/full suite green) but before the commit + a final lint pass. A
  second focused generator fixed 4 unused-import lint errors, re-verified, and
  committed `aa7f9be`. No application logic was reworked during recovery — the
  passing implementation is the one the first attempt had produced.
