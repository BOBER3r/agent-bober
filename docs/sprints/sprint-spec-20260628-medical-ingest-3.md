# bober medical import-labs <pdf> end-to-end command (fail-closed + audit + dedup)

**Contract:** sprint-spec-20260628-medical-ingest-3  ·  **Spec:** spec-20260628-medical-ingest  ·  **Completed:** 2026-06-28

## What this sprint added

The **first user-facing command of the medical-ingest leg** — it wires Sprint 1's
`parseLabPdf` and Sprint 2's `writeLabNote` / `reindexLabNotes` into a single
`bober medical import-labs <pdf>` subcommand under the existing `medical` command tree (it is
**not** a new top-level command). The command logic is extracted into an exported, testable
`runImportLabs(projectRoot, pdfPath, deps, opts)` core that mirrors the `runWhoopSync` /
`WhoopSyncDeps` injection pattern. The **load-bearing safety property** is fail-closed ordering:
it resolves an `EgressGuard` from config and, when the `cloud-inference` axis is **off (the
default)**, prints a clear message naming `medical.egress.cloudInference`, sets
`process.exitCode = 1`, and **returns before reading the PDF or constructing any inference
client** — the injected parser spy is provably never invoked (sc-3-3). Only when the axis is
opted in does it build the client, read and parse the PDF, write a vault note per marker, reindex
into `HealthDataStore`, and append an **IDs/enums-only** audit `ingest` entry. Re-importing the
same report adds **zero** new store rows (ingest-time dedup). **Ships nothing to cloud by default.**

## Public surface

- `bober medical import-labs <pdf> [--vault <dir>]` (`src/cli/commands/medical.ts:268`) — parses a lab PDF and ingests the results into the medical health store. Subcommand of `medical` (registered under `medicalCmd`). `--vault` overrides the note directory (default: under `.bober/medical`).
- `runImportLabs(projectRoot, pdfPath, deps?, opts?): Promise<void>` (`src/cli/commands/medical.ts:153`) — the extracted, testable command core. Production callers pass no `deps`; the CLI `.action()` delegates to it. Never throws — on any error it writes a clear message to stderr, sets `process.exitCode = 1`, and always closes the store in `finally`.
- `ImportLabsDeps { parse?: typeof parseLabPdf; nowIso?: string }` (`src/cli/commands/medical.ts:132`) — the dependency-injection seam. `parse` overrides the PDF parser (tests inject a fixture parser returning a canned `ParsedLabReport`); `nowIso` overrides the audit timestamp (default `new Date().toISOString()`).

## How to use / how it fits

```bash
# Default (cloud-inference axis OFF) — fail-closed, exits 1, reads no PDF bytes:
bober medical import-labs ~/labs/cbc-2026-06-01.pdf
#   cloud-inference egress not enabled — set medical.egress.cloudInference: true in bober.config.json

# Opt in (bober.config.json), then re-run:
#   { "medical": { "egress": { "cloudInference": true } } }
bober medical import-labs ~/labs/cbc-2026-06-01.pdf
#   Lab import complete
#     records parsed: <n>
#     new rows:       <n>   (0 on a repeat import of the same report)
```

`runImportLabs` runs a **load-bearing, ADR-ordered** sequence:

1. `loadConfig` + `EgressGuard.fromConfig`.
2. **`cloud-inference` axis check** (`medical.ts:165`) — if off: stderr message naming
   `medical.egress.cloudInference`, `process.exitCode = 1`, **return** — *before* any
   `readFile` or client build.
3. `buildMedicalInferenceClient(config, egress)` (`medical.ts:175`).
4. `readFile(pdfPath)` (`medical.ts:177`) → `parse(pdfBytes, { client, model })` (`medical.ts:179`).
5. `writeLabNote` per marker → `reindexLabNotes(vaultDir, store)` (`medical.ts:195`) into
   `HealthDataStore` at `.bober/medical/health.db`.
6. `AuditLog.append({ tIso: nowIso, event: "ingest" })` (`medical.ts:198`) — IDs/enums only.
7. `finally`: `store?.close()`.

This closes the parse → vault → derived-index pipeline that Sprints 1 and 2 staged. The vault
remains canonical; `HealthDataStore.lab_results` is the derived, rebuildable index (see Sprint 2).

## Notes for maintainers

- **Fail-closed ordering is the safety guarantee, not just an early return.** The egress check is
  step 2, ahead of both `readFile` and `buildMedicalInferenceClient`. sc-3-3 asserts the injected
  parser spy `callCount === 0`, no `labs/` note directory exists, `exitCode === 1`, and stderr
  names `medical.egress.cloudInference`. Keep this gate *before* any PDF read or client build if
  this function is refactored. **Default cloud-inference is off, so the command ships nothing to
  cloud by default.**
- **Audit is IDs/enums-only — PHI rule.** The appended entry is `{ tIso, event: "ingest" }` and
  nothing else — no marker name, value, panel, or record count reaches the audit log (the test
  asserts the audit file contains neither the marker name nor the value). Do not add health values
  or prompt text to this entry.
- **Ingest-time dedup is inherited, not re-implemented.** A second `import-labs` over the same
  report reports `new rows: 0` because `reindexLabNotes` → `HealthDataStore.upsertLabResult` keys
  on the deterministic `labResultId` under `INSERT OR IGNORE` (Sprint 2 / `health-store.ts`). The
  command does no dedup of its own.
- **Subcommand, not top-level.** `import-labs` is registered under `medicalCmd`, alongside
  `import` and `whoop sync`. The `.action()` never throws — it sets `process.exitCode` and returns.
- **No real network in tests.** Every test injects a fake parser via `ImportLabsDeps.parse` and a
  fixed `nowIso`; the production parse client (`buildMedicalInferenceClient`) is only constructed
  on the axis-on path, which the tests reach with `cloudInference: true`.
- **Scope.** Commit `cd4a2ea`: modified `src/cli/commands/medical.ts` (+`ImportLabsDeps`,
  `runImportLabs`, the `import-labs` subcommand) and `src/cli/commands/medical.test.ts`
  (sc-3-2/3-3/3-4, 3 new tests; medical CLI suite now 9 tests). No new deps. Full suite **2947**
  green (+3), all four criteria (sc-3-1..sc-3-4) passed iteration 1.
