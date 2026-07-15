# Sprint Briefing: Lab-note vault writer + derived HealthDataStore reindex + ingest dedup

**Contract:** sprint-spec-20260628-medical-ingest-2
**Generated:** 2026-06-28T00:00:00Z

---

## 0. TL;DR for the Generator

- Create 4 files (all NEW): `src/medical/lab-note.ts`, `src/medical/lab-note.test.ts`, `src/medical/lab-reindex.ts`, `src/medical/lab-reindex.test.ts`.
- **NO YAML dep is vendored.** `package.json` has no `yaml`/`js-yaml`/`gray-matter`. Adding one is a non-goal. **Hand-roll a tiny frontmatter writer + parser** inside `src/medical/lab-note.ts` (mirror the approach of `src/vault/frontmatter.ts` but DO NOT import it — `src/vault/` IS the forbidden sibling vault-store module from spec-20260628-obsidian-vault-store).
- Reuse `ParsedLabMarker` from `src/medical/lab-types.ts` (Sprint 1).
- Map a marker → `LabResult` and call `HealthDataStore.upsertLabResult(result)` (`src/medical/health-store.ts:212`). It returns `info.changes` = 1 for a new row, **0 for a duplicate** (dedup via the deterministic `labResultId`).
- Status is pure deterministic JS (no LLM): `value < refLow → "low"`, `value > refHigh → "high"`, else `"normal"`; a parser-supplied `critical` flag → `"critical"`.
- All fs via `node:fs/promises`; ESM `.js` import extensions; `import type` for types; collocated `*.test.ts`; timestamps injected (never `Date.now()`).

---

## 1. Target Files

### src/medical/lab-note.ts (create)

**Directory pattern:** `src/medical/` uses **kebab-case** file names (`lab-types.ts`, `lab-pdf-parser.ts`, `health-store.ts`). New file = `lab-note.ts`.
**Most similar existing file (for the hand-rolled frontmatter approach — REFERENCE ONLY, DO NOT IMPORT):** `src/vault/frontmatter.ts`.

This file should export (suggested):
- `type LabStatus = "low" | "normal" | "high" | "critical"`
- `deriveLabStatus(value, refLow?, refHigh?, critical?): LabStatus` — pure, sync, no LLM (sc-2-3).
- `writeLabNote(vaultDir, marker, meta): Promise<string>` — serializes one marker to `<vaultDir>/labs/<panel-slug>/<marker-slug>-<date>.md` with YAML frontmatter, returns the path (sc-2-2).
- `parseLabNote(raw): LabNoteFrontmatter` (or a record) — parse frontmatter back for the round-trip test and for `lab-reindex.ts` reuse.
- A small `slugify(s): string` helper (see pattern §2).

**Frontmatter keys REQUIRED by sc-2-2:** `marker, value, unit, ref_low, ref_high, ref_range, date, status, panel, source`.

**Field mapping (marker → frontmatter → LabResult):**

| ParsedLabMarker | frontmatter key | LabResult field |
|---|---|---|
| `name` | `marker` | `biomarker` |
| `value` | `value` | `value` |
| `unit` | `unit` | `unit` |
| `referenceLow` | `ref_low` | `referenceLow` |
| `referenceHigh` | `ref_high` | `referenceHigh` |
| (report) `collectedAtIso` | `date` | `collectedAtIso` |
| (report) `panel` | `panel` | (not stored in lab_results) |
| derived | `status` | (not stored) |
| caller-supplied | `source` | (not stored) |

`ref_range` is a human-readable string, e.g. `` `${refLow}-${refHigh}` `` (or `""` when both absent). `writeLabNote`'s `meta` arg should carry `{ panel, collectedAtIso, source }` (panel/date/source come from the `ParsedLabReport`, not the marker).

---

### src/medical/lab-reindex.ts (create)

Should export `reindexLabNotes(vaultDir, store): Promise<number>` — glob the labs dir, read each note, parse frontmatter via `parseLabNote`, map to `LabResult`, call `store.upsertLabResult(...)`, accumulate and return the **new-row count** (sum of the `number` returns).

**Closest structural precedent (for the glob + read + map shape — REFERENCE ONLY, DO NOT IMPORT, it is in the forbidden vault module):** `src/vault/reindex.ts:60-102` (walk notes → map → write) and `src/vault/note-io.ts:49-51` (`glob("**/*.md", { cwd, absolute: true, nodir: true })`).

**Allowed imports for the new files:** `node:fs/promises`, `node:path`, `glob` (dep present), `./lab-types.js`, `./health-store.js`, `./types.js`, and `../utils/fs.js` (`ensureDir` — NOT in the vault module, safe to import).

---

## 2. Patterns to Follow

### Hand-rolled YAML frontmatter serialize (MIRROR, do not import)
**Source:** `src/vault/frontmatter.ts:145-164`
```ts
export function serializeFrontmatter(frontmatter: Record<string, unknown>, body: string): string {
  const lines: string[] = ["---"];
  for (const [key, val] of Object.entries(frontmatter)) {
    if (Array.isArray(val)) {
      lines.push(`${key}:`);
      for (const item of val as unknown[]) lines.push(`  - ${String(item)}`);
    } else {
      lines.push(`${key}: ${String(val)}`);
    }
  }
  lines.push("---");
  return lines.join("\n") + "\n" + body;
}
```
**Rule:** Produce `---\n<key: value lines>\n---\n<body>`. For lab notes you only need flat scalar keys (no arrays). Build your own equivalent in `lab-note.ts`.

### Hand-rolled frontmatter parse (MIRROR, do not import)
**Source:** `src/vault/frontmatter.ts:53-135` — splits on `\n`, requires `lines[0].trim() === "---"`, finds the closing `---`, then `key: value` per line; numbers via `/^-?\d+(\.\d+)?$/` → `Number(raw)`, else string. Your `parseLabNote` can be a stripped-down version: split on the `---` fences, then `key:value` per line, coercing `value`/`ref_low`/`ref_high` to numbers.

### Deterministic id (dedup key) — already implemented, just rely on it
**Source:** `src/medical/health-store.ts:48-53`
```ts
export function labResultId(biomarker: string, collectedAtIso: string, value: number): string {
  return createHash("sha256")
    .update(`${biomarker}|${collectedAtIso}|${value}`)
    .digest("hex")
    .slice(0, 16);
}
```
**Rule:** You do NOT compute this yourself. `upsertLabResult` derives it when `result.id` is absent. Dedup is automatic: same biomarker+date+value → same id → `INSERT OR IGNORE` → returns 0.

### Slug derivation precedent
**Source:** `src/incident/timeline.ts:117-128` (`deriveSlug`) — lowercase, strip `[^a-z0-9]`, join with `-`. That one keeps only the first 3 tokens & truncates to 30 (tuned for symptoms). For a marker/panel slug, write a simpler local helper, e.g. `s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")`. Use it for both `<panel-slug>` and `<marker-slug>` so the note path is deterministic and collision-resistant.

### Pure deterministic numeric classification style (the status helper should look like this)
**Source:** `src/medical/numerics.ts:9-11` (file header invariant) + `:75-83` (`linearPercentile`)
```
// NO async. NO fs. NO network. NO LLM import. NO dynamic execution. Identical input => identical output.
```
**Rule:** `deriveLabStatus` is a plain sync function returning a union literal. No imports beyond types. (sc-2-3 requires "no LLM call in the path".)

### Async file write with auto-created parent dir
**Source:** `src/utils/fs.ts:34-47` (`writeJson` → `ensureDir(dirname(path))` then `writeFile`) and `src/vault/note-io.ts:38-41` (`writeNote` → `ensureDir(dirname(note.path))` + `writeFile(path, serialize(...), "utf-8")`)
```ts
export async function writeNote(note: VaultNote): Promise<void> {
  await ensureDir(dirname(note.path));
  await writeFile(note.path, serializeNote(note), "utf-8");
}
```
**Rule:** In `writeLabNote`, compute the path, `await ensureDir(dirname(path))`, then `await writeFile(path, serialized, "utf-8")`. Import `ensureDir` from `../utils/fs.js`.

### Glob a directory of markdown notes
**Source:** `src/vault/note-io.ts:49-51`
```ts
export async function listNotes(vaultDir: string): Promise<string[]> {
  return glob("**/*.md", { cwd: vaultDir, absolute: true, nodir: true });
}
```
**Rule:** In `reindexLabNotes`, `glob("**/*.md", { cwd: vaultDir, absolute: true, nodir: true })` (or scope to `labs/` subdir) then `readFile` each + parse.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---|---|---|---|
| `HealthDataStore.upsertLabResult` | `src/medical/health-store.ts:212` | `(result: LabResult): number` | INSERT OR IGNORE a lab result; returns 1 (new) or 0 (dup). The dedup mechanism for this sprint. |
| `HealthDataStore.getLabSeries` | `src/medical/health-store.ts:196` | `(biomarker: string): LabResult[]` | All results for a biomarker, ordered `collected_at` ASC. Used by sc-2-4/sc-2-5 assertions. |
| `labResultId` | `src/medical/health-store.ts:48` | `(biomarker, collectedAtIso, value): string` | Deterministic SHA-256 dedup id. Rely on it via upsert; do not recompute. |
| `ensureDir` | `src/utils/fs.ts:45` | `(path: string): Promise<void>` | `mkdir(path, { recursive: true })`. Use in `writeLabNote`. |
| `fileExists` / `readJson` / `writeJson` | `src/utils/fs.ts:10,24,34` | various | General fs helpers (likely unused here, but exist). |
| `glob` | `glob` npm dep (`package.json:69`) | `(pattern, opts)` | Directory walk for `reindexLabNotes`. |
| `ParsedLabMarkerSchema` / `ParsedLabReportSchema` | `src/medical/lab-types.ts:6,15` | Zod schemas | Sprint-1 schemas; `type ParsedLabMarker`/`ParsedLabReport` to map FROM. |

**Forbidden to import (sibling vault-store module — spec-20260628-obsidian-vault-store):** anything under `src/vault/` — `frontmatter.ts`, `note-io.ts`, `reindex.ts`, `index-map.ts`, `conventions.ts`, `types.ts`. Mirror their approach; never `import` them.

**Utilities reviewed:** `src/utils/` (fs.ts, plus git/logger/etc.), `src/medical/` (health-store, numerics, lab-types, lab-pdf-parser), `src/vault/` (reference only). No existing slug util is exported as a shared helper — write a small local one (precedent: `src/incident/timeline.ts:117`).

---

## 4. Prior Sprint Output

### Sprint 1 (be98982): lab PDF parser + schemas
**Created:** `src/medical/lab-types.ts` — exports `ParsedLabMarkerSchema`, `ParsedLabReportSchema`, and types:
```ts
export interface ParsedLabMarker { name: string; value: number; unit: string;
  referenceLow?: number; referenceHigh?: number; critical?: boolean; }
export interface ParsedLabReport { panel: string; collectedAtIso: string; markers: ParsedLabMarker[]; }
```
**Created:** `src/medical/lab-pdf-parser.ts` — `parseLabPdf(pdfBytes, deps): Promise<ParsedLabReport>` (LLM-backed; NOT used in Sprint 2 — Sprint 2 is pure fs+SQLite).
**Connection to this sprint:** `writeLabNote` consumes a `ParsedLabMarker` (+ report-level `panel`/`collectedAtIso`). Import the type via `import type { ParsedLabMarker, ParsedLabReport } from "./lab-types.js"`.

### Pre-existing (Phase 6, Sprint 4): HealthDataStore
**File:** `src/medical/health-store.ts` — `upsertLabResult`, `getLabSeries`, `labResultId`. `lab_results` columns: `id, biomarker, value, unit, collected_at, ref_low, ref_high`. The `LabResult` type (`src/medical/types.ts:118-127`):
```ts
export interface LabResult {
  id?: string; biomarker: string; value: number; unit: string;
  collectedAtIso: string;          // ISO 8601, INJECTED — never Date.now()
  referenceLow?: number; referenceHigh?: number;
}
```
**Connection:** `reindexLabNotes` maps each parsed note → `LabResult { biomarker: marker, value, unit, collectedAtIso: date, referenceLow: ref_low, referenceHigh: ref_high }` and calls `upsertLabResult`.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM everywhere** — all imports use `.js` extensions for NodeNext (line 27).
- **No synchronous fs ops** — use `node:fs/promises` only (line 42).
- **`import type` for types** — `consistent-type-imports` enforced (line 35).
- **No `any`** — `no-explicit-any` warned; prefer `unknown` + narrowing (line 40).
- **Collocated tests** — `*.test.ts` next to source; Vitest (line 20).
- **No test mocks for filesystem** — tests create temp dirs and clean up (line 44).
- **Section comments** — `// -- Section Name ------` box headers in long files (line 32).

### Architecture Decisions
- `arch-20260616-medical-team-adr-*` exist (ADR-3 = LLM never does arithmetic; ADR-4 = generic single-table + deterministic SHA-256 id). No ingest-specific ADR. The deterministic-status requirement is the ADR-3 spirit applied to classification.
- Research `research-20260627-knowledge-platform-landscape.md` §3b (lines 150-153): **"the vault is canonical; FactStore/SQLite is a derived, rebuildable index"**; **"Dedup/reconcile runs at ingest time"**; labs = markdown notes with `marker/value/unit/ref_range/date/status` frontmatter. This is the source of the frontmatter key set and the dedup-at-ingest model.

### Other Docs
- No `CLAUDE.md`/`CONTRIBUTING.md` coding-guideline override beyond `.bober/principles.md`.

---

## 6. Testing Patterns

### Unit Test Pattern
**Source:** `src/medical/health-store.test.ts:1-7, 143-170`
```ts
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HealthDataStore } from "./health-store.js";

describe("HealthDataStore (file-backed dedup)", () => {
  let tmpDir: string;
  beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-health-")); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it("INSERT OR IGNORE dedupes; returns NEW-row count only", () => {
    const store = new HealthDataStore(join(tmpDir, "health.db"));
    expect(store.upsertObservations(OBS_5)).toBe(5);   // first insert
    expect(store.upsertObservations(OBS_5)).toBe(0);   // re-insert = all dups
    store.close();
  });
});
```
**Runner:** vitest. **Assertion style:** `expect(...).toBe/.toEqual/.toHaveLength`. **Mock approach:** none — real temp dirs (`mkdtemp` + `rm recursive force`); store via `new HealthDataStore(":memory:")` for pure-store tests or `join(tmpDir, "x.db")` for file-backed. **File naming:** `lab-note.test.ts` / `lab-reindex.test.ts` collocated. **Always `store.close()`** (afterEach or end of test).

**Lab-result test specifics** (`src/medical/health-store.test.ts:88-97`): build `LabResult[]` literals, loop `store.upsertLabResult(lab)`, assert `store.getLabSeries("glucose")` length and ASC `collectedAtIso` order. Reuse this exact shape for sc-2-4.

### Timestamps are injected
There is no clock to fake — pass ISO strings directly in test fixtures (e.g. `collectedAtIso: "2026-01-01T08:00:00.000Z"`). `writeLabNote`/`reindexLabNotes` must never call `Date.now()`/`new Date()`.

### E2E Test Pattern
Not applicable — no Playwright in this repo (pure Node library/CLI).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
All four target files are **new**; no existing file is modified. Risk is contained to new-file compile + correct use of the existing store API.

| File | Depends On | Risk | What to Check |
|---|---|---|---|
| `src/medical/lab-reindex.ts` (new) | `health-store.ts` `upsertLabResult`/`getLabSeries` | low | Pass a real `LabResult` shape (`collectedAtIso`, not `date`); accumulate the `number` return. |
| `src/medical/lab-note.ts` (new) | `lab-types.ts`, `../utils/fs.ts` | low | `.js` import extensions; `import type` for `ParsedLabMarker`. |
| `tsc` build (`npm run build`) | all of `src/` | low | New files must compile under strict mode (`noUnusedLocals`, `noImplicitReturns`, exhaustive switches). |

### Existing Tests That Must Still Pass
This sprint adds files only; no behavior changes to shared code. Run the full suite, but specifically:
- `src/medical/health-store.test.ts` — exercises `upsertLabResult`/`getLabSeries`/dedup; must still pass (you only call its API, do not touch it).
- `src/vault/*.test.ts` (frontmatter/note-io/reindex) — must remain green and **must not be imported** by your new files. If your new code accidentally imports `src/vault/`, that is a spec violation (non-goal), not just a test risk.
- `src/medical/lab-pdf-parser.test.ts`, `numerics.test.ts` — unaffected; confirm no regression from new sibling files.

### Features That Could Be Affected
- **Sprint 3 (import-labs CLI)** — will call `writeLabNote` + `reindexLabNotes`. Keep their signatures clean and exported so Sprint 3 can wire them. Do NOT implement the CLI here (out of scope).
- **Sibling obsidian-vault-store** — shares the *concept* of frontmatter notes but must stay decoupled. Verify zero `from "../vault/..."` / `from "./vault/..."` imports.

### Recommended Regression Checks
1. `npm run build` exits 0 (sc-2-1).
2. `npx vitest run src/medical/lab-note.test.ts src/medical/lab-reindex.test.ts` — all green.
3. `npx vitest run src/medical/health-store.test.ts` — unchanged, still green.
4. `npm run lint` — zero errors (`consistent-type-imports`, no unused vars).
5. `grep -nE "createClient|fetch\(|new Date|Date\.now" src/medical/lab-note.ts src/medical/lab-reindex.ts` → **no matches** (evaluatorNotes: zero network/LLM/clock).
6. `grep -nE "from \"\.\./vault|from \"\./vault|src/vault" src/medical/lab-note.ts src/medical/lab-reindex.ts` → **no matches** (forbidden sibling import).

---

## 8. Implementation Sequence

1. **`src/medical/lab-note.ts`** — types + pure helpers first.
   - Define `LabStatus = "low" | "normal" | "high" | "critical"` and `deriveLabStatus(value, refLow?, refHigh?, critical?)` (pure switch/if; critical wins; else compare to bounds; missing bounds → "normal").
   - Add `slugify(s)` (precedent `src/incident/timeline.ts:117`).
   - Add `serializeLabFrontmatter(...)` + `parseLabNote(raw)` (mirror `src/vault/frontmatter.ts` shape; flat scalars; coerce numeric keys).
   - Add `writeLabNote(vaultDir, marker, meta): Promise<string>` — build frontmatter `{ marker, value, unit, ref_low, ref_high, ref_range, date, status, panel, source }`, compute `<vaultDir>/labs/<panel-slug>/<marker-slug>-<date>.md`, `ensureDir(dirname)`, `writeFile`, return path.
   - Verify: `tsc --noEmit` clean; status switch is exhaustive.
2. **`src/medical/lab-reindex.ts`** — depends on `lab-note.ts` + `health-store.ts`.
   - `reindexLabNotes(vaultDir, store)`: glob `**/*.md` under labs dir → `readFile` each → `parseLabNote` → map to `LabResult` → `upsertLabResult` → sum returns → return count.
   - Verify: returns a `number`; no `Date.now()`.
3. **`src/medical/lab-note.test.ts`** — round-trip (sc-2-2) + status table (sc-2-3).
   - Write a note to a temp dir, read the file, parse frontmatter, assert all 10 keys present and values equal the inputs.
   - Table-driven: below-low→"low", above-high→"high", in-range→"normal", critical:true→"critical".
   - Verify: temp dir cleaned in afterEach.
4. **`src/medical/lab-reindex.test.ts`** — reindex (sc-2-4) + dedup second run (sc-2-5).
   - Write N notes to a temp vault, `reindexLabNotes` into `new HealthDataStore(":memory:")` (or file db), assert `getLabSeries(marker)` returns matching `value`/`unit`/`collectedAtIso`.
   - Call `reindexLabNotes` a **second time** over the unchanged vault → assert return is `0` AND `getLabSeries(...)` length unchanged.
   - Verify: `store.close()`.
5. **Run full verification** — `npm run build`, `npx vitest run src/medical/`, `npm run lint`, plus the §7 grep checks.

---

## 9. Pitfalls & Warnings

- **Do NOT import `src/vault/`** — it is the forbidden sibling vault-store module. Mirror `frontmatter.ts`/`note-io.ts`/`reindex.ts` by hand; never `import` them. (sc/non-goal + evaluatorNotes will grep for this.)
- **No YAML library** — none is vendored (`package.json:62-76`). Hand-roll. Keep the writer/parser minimal: flat `key: value` scalars only; coerce `value`/`ref_low`/`ref_high` to numbers on parse, leave `marker`/`unit`/`date`/`status`/`panel`/`source`/`ref_range` as strings.
- **Field-name mismatch is the #1 bug** — `LabResult` uses `biomarker` and `collectedAtIso`, while the marker uses `name` and the frontmatter uses `marker`/`date`. Map explicitly; do not pass the frontmatter object straight into `upsertLabResult`.
- **`upsertLabResult` returns `info.changes` (0 or 1), not a boolean** (`health-store.ts:229`). Accumulate the raw number for the new-row count; 0 means deduped.
- **Dedup key is `biomarker|collectedAtIso|value`** (`health-store.ts:48-53`) — `unit`, `ref_low`, `ref_high`, `panel` are NOT in the id. Two notes with same biomarker+date+value but different units still collide (return 0). That is the intended ingest dedup; the sc-2-5 test must use identical notes.
- **Timestamps injected** — `collectedAtIso`/`date` come from the parsed report; never synthesize with `Date.now()`/`new Date()` (store purity contract, `health-store.ts:11`).
- **Strict TS gotchas** — `optional` ref bounds are `number | undefined`; guard before formatting `ref_range`. Exhaustive `switch` on `LabStatus` needs a `never` default or the build flags `noFallthroughCasesInSwitch`/unhandled cases (see `numerics.ts:147-152` for the `never` guard pattern).
- **`.js` extensions on every relative import** (`./lab-types.js`, `./health-store.js`, `./types.js`, `../utils/fs.js`) — NodeNext will fail to resolve extensionless paths.
- **Glob returns absolute paths** when `{ absolute: true }`; pass them straight to `readFile`. Without `nodir: true` you may get directory entries.
- **Note path must be collision-resistant** — include the date in the filename (`<marker-slug>-<date>.md`) so two collection dates for the same marker don't overwrite each other. Sanitize the date for filenames if it contains `:` (ISO timestamps have colons — either slugify the date or use the date portion before `T`).
