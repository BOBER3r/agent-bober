# Lab-note vault writer + derived HealthDataStore reindex + ingest dedup

**Contract:** sprint-spec-20260628-medical-ingest-2  ·  **Spec:** spec-20260628-medical-ingest  ·  **Completed:** 2026-06-28

## What this sprint added

The **vault-storage + derived-index leg** of the medical-ingest plan — the layer that sits between
Sprint 1's `parseLabPdf` and Sprint 3's CLI. Each parsed lab marker is serialized to a
**markdown-with-YAML-frontmatter note** in the canonical vault (`writeLabNote`), and a separate
`reindexLabNotes` pass globs those notes back and **upserts them into the existing
`HealthDataStore.lab_results`**. The architecture is deliberate: **vault markdown is canonical**;
the SQLite store is a **derived, rebuildable index**. Lab status (`low | normal | high | critical`)
is derived in **deterministic JS** from value vs reference range — never by an LLM. Reindex is
**idempotent**: duplicate notes produce zero new rows because the deterministic `labResultId`
collides under `INSERT OR IGNORE`. The module is **pure file + SQLite** (no network, no LLM, no
`Date.now()`), and it deliberately **does not import the sibling `src/vault` module** — it
hand-rolls a tiny frontmatter writer/parser so this build stays independent of sibling timing.

## Public surface

- `deriveLabStatus(value, refLow?, refHigh?, critical?): LabStatus` (`src/medical/lab-note.ts:71`) — pure/sync. `critical === true` wins; else `value < refLow` ⇒ `"low"`, `value > refHigh` ⇒ `"high"`; missing bounds ⇒ `"normal"`. No LLM, no clock.
- `writeLabNote(vaultDir, marker, meta): Promise<string>` (`src/medical/lab-note.ts:191`) — derives status, builds the 10-key frontmatter, and writes `<vaultDir>/labs/<panel-slug>/<marker-slug>-<date>.md` (date = the `YYYY-MM-DD` portion of `collectedAtIso`, colon-free). Creates parent dirs; returns the path written.
- `parseLabNote(raw): LabNoteFrontmatter` (`src/medical/lab-note.ts:120`) — parses a note's frontmatter back to a structured record (numeric coercion for `value`/`ref_low`/`ref_high`; throws on a missing `---` fence). Round-trips `writeLabNote`.
- `slugify(s): string` (`src/medical/lab-note.ts:58`) — URL-safe slug helper used for the panel/marker path segments.
- `reindexLabNotes(vaultDir, store): Promise<number>` (`src/medical/lab-reindex.ts:32`) — globs `<vaultDir>/labs/**/*.md`, parses each note, maps to `LabResult`, calls `store.upsertLabResult`, and returns the **genuine new-row count** (sum of `info.changes`). A second run over an unchanged vault returns `0`.
- `LabStatus` (`src/medical/lab-note.ts:23`), `LabNoteMeta` (`:26`), `LabNoteFrontmatter` (`:37`) — the type surface. Frontmatter keys (all 10 always present): `marker`, `value`, `unit`, `ref_low`, `ref_high`, `ref_range`, `date`, `status`, `panel`, `source`.

## How to use / how it fits

```ts
import { writeLabNote } from "./medical/lab-note.js";
import { reindexLabNotes } from "./medical/lab-reindex.js";

// 1. Write each parsed marker to the canonical vault as a markdown note.
for (const marker of report.markers) {
  await writeLabNote(vaultDir, marker, {
    panel: report.panel,
    collectedAtIso: report.collectedAtIso,
    source: "lab-pdf",
  });
}

// 2. (Re)build the derived index from the canonical notes.
const newRows = await reindexLabNotes(vaultDir, store); // store: HealthDataStore
```

This consumes Sprint 1's `ParsedLabMarker` (`src/medical/lab-types.ts`) and feeds the existing
Sprint-4 `HealthDataStore`. The frontmatter→`LabResult` mapping is
`marker→biomarker`, `value`, `unit`, `date→collectedAtIso`, `ref_low→referenceLow`,
`ref_high→referenceHigh` — exactly the shape `upsertLabResult` dedups on. Sprint 3 (`bober medical
import-labs <pdf>`) will wire `parseLabPdf` → `writeLabNote` → `reindexLabNotes` behind the
`cloud-inference` egress gate.

## Notes for maintainers

- **Vault is canonical; the store is a derived rebuildable index.** Lab notes are the source of
  truth. `HealthDataStore.lab_results` can be deleted and fully rebuilt by re-running
  `reindexLabNotes` — it holds no information the notes do not.
- **Dedup is the deterministic `labResultId`.** `upsertLabResult` keys on
  `labResultId(biomarker, collectedAtIso, value)` (SHA-256) under `INSERT OR IGNORE`
  (`src/medical/health-store.ts:48`, `:212`) and returns `info.changes` (0 for a dup, 1 for a new
  row). So a repeat `reindexLabNotes` over unchanged notes reports `0` new rows and leaves
  `getLabSeries(marker)` length unchanged (sc-2-5).
- **No `src/vault` import — intentional.** The frontmatter serializer/parser is a hand-rolled flat-scalar
  subset that *mirrors* `src/vault/frontmatter.ts` (see the code comments) but never imports it, so
  this leg's build does not depend on the sibling vault-store spec's timing. It is a **flat-scalar**
  subset only (no arrays / nested objects / quoted-string escaping); swap for a vetted YAML library
  if richer values are ever needed.
- **Pure file + SQLite, deterministic status.** No `createClient`/`fetch`, no `new Date()`/`Date.now()`,
  all timestamps injected; status classification is deterministic JS (preserves the ADR-3 numerics
  guarantee). All fs is `node:fs/promises`. Evaluator guardrail greps were clean.
- **Not wired yet.** `writeLabNote`/`reindexLabNotes` are library functions reachable only by an
  explicit caller — there is no CLI command, egress gating, or audit entry in this sprint (Sprint 3).
- **Scope.** Commit `181f30c`: new `src/medical/lab-note.ts`, `src/medical/lab-reindex.ts`, and their
  `.test.ts` siblings (23 new tests). No new deps (`glob` was already vendored). Full suite **2944**
  green (+33), all five criteria (sc-2-1..sc-2-5) passed iteration 1.
