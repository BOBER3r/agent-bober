# Sprint Briefing: HealthDataStore + deterministic NumericsQueryLayer

**Contract:** sprint-spec-20260616-medical-team-4
**Generated:** 2026-06-16T00:00:00Z

> Scope: ADD `src/medical/health-store.ts` (HealthDataStore) + `src/medical/numerics.ts` (NumericsQueryLayer) + collocated `*.test.ts`, and ADD types to `src/medical/types.ts`. Do NOT wire the SOP (engine.ts stays untouched this sprint — `deps.numerics` is a placeholder slot). Do NOT implement ingestion (S5), egress/medications (S6), or retrieval (S7).

---

## 1. Target Files

### `src/medical/health-store.ts` (create)

**Directory pattern:** `src/medical/` uses kebab-case file names (`red-flag.ts`, `health-store.ts`), one PascalCase class per file, collocated `*.test.ts`. There is **no** `index.ts`/barrel (`ls src/medical/index.ts` → none) — import directly with the `.js` extension.

**Most similar existing file:** `src/state/facts.ts` — the **ONLY** better-sqlite3 store in the entire `src/` tree (`grep -rln better-sqlite3 src/` → only `src/state/facts.ts`). Mirror it exactly: do NOT invent a new DB pattern. ADR-4 explicitly says "mirrors `semantic_facts` single-table pattern (facts.ts:142)".

**Imports the new file needs (copy from facts.ts:1-3):**
```typescript
import { createHash } from "node:crypto";
import Database from "better-sqlite3";                       // DEFAULT import (esModuleInterop)
import type { Database as DatabaseType } from "better-sqlite3";
```

**Structure template (mirror `FactStore` at facts.ts:136-297):**
```typescript
// Deterministic id — mirror factId at facts.ts:58-69. Per the contract/ADR-4 the
// signature is metric|tStart|source|value (NOTE: this order, value LAST).
export function observationId(metric: string, tStart: string, source: string, value: number): string {
  return createHash("sha256")
    .update(`${metric}|${tStart}|${source}|${value}`)
    .digest("hex")
    .slice(0, 16);                 // facts.ts slices to 16 hex chars — keep the same length
}

export class HealthDataStore {
  private db: DatabaseType;

  constructor(dbPath: string) {          // tests pass ":memory:" OR a temp-dir file path
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS health_observations (
        id TEXT PRIMARY KEY,
        metric TEXT NOT NULL,
        value REAL NOT NULL,
        unit TEXT NOT NULL,
        t_start TEXT NOT NULL,
        t_end TEXT,
        source TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_obs_metric ON health_observations(metric, t_start);
      CREATE TABLE IF NOT EXISTS lab_results (
        id TEXT PRIMARY KEY,
        biomarker TEXT NOT NULL,
        value REAL NOT NULL,
        unit TEXT NOT NULL,
        collected_at TEXT NOT NULL,
        ref_low REAL,
        ref_high REAL
      );
      CREATE INDEX IF NOT EXISTS idx_lab_biomarker ON lab_results(biomarker, collected_at);
      CREATE TABLE IF NOT EXISTS kv_store (   -- backs getBaseline/putBaseline + getPreference
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );
    `);
  }

  upsertObservations(rows: HealthObservation[]): number { /* INSERT OR IGNORE in a txn, sum changes */ }
  getObservations(metric: string, fromIso: string, toIso: string): HealthObservation[] { /* filter + ORDER BY t_start */ }
  getLabSeries(biomarker: string): LabResult[] { /* SELECT ... WHERE biomarker = ? ORDER BY collected_at */ }
  getBaseline(metric: string): Baseline | undefined { /* read kv_store key e.g. `baseline:${metric}`, JSON.parse */ }
  putBaseline(b: Baseline): void { /* INSERT OR REPLACE into kv_store, JSON.stringify */ }
  getPreference(key: string): string | undefined { /* read kv_store key e.g. `pref:${key}` */ }
  close(): void { this.db.close(); }       // mirror facts.ts:294-296
}
```

**`upsertObservations` (the sc-4-4 contract — returns NEW-row count only):**
```typescript
upsertObservations(rows: HealthObservation[]): number {
  const stmt = this.db.prepare(
    `INSERT OR IGNORE INTO health_observations
       (id, metric, value, unit, t_start, t_end, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  // better-sqlite3 .transaction returns the fn's return value synchronously.
  const insertAll = this.db.transaction((obs: HealthObservation[]) => {
    let inserted = 0;
    for (const o of obs) {
      const id = o.id ?? observationId(o.metric, o.tStart, o.source, o.value);
      const info = stmt.run(id, o.metric, o.value, o.unit, o.tStart, o.tEnd ?? null, o.source);
      inserted += info.changes;        // INSERT OR IGNORE => changes is 0 for a dup, 1 for a new row
    }
    return inserted;
  });
  return insertAll(rows);
}
```
> WHY this gives NEW-row count: `INSERT OR IGNORE` sets `info.changes = 0` when the PK already exists, `1` when a row is actually inserted. Summing `info.changes` yields exactly the count of NEW rows (re-inserting the same N returns 0). This is the precise behavior sc-4-4 / evaluatorNotes assert.

**`getObservations` (range filter, ordered):**
```typescript
getObservations(metric: string, fromIso: string, toIso: string): HealthObservation[] {
  const rows = this.db.prepare(
    `SELECT id, metric, value, unit, t_start, t_end, source
       FROM health_observations
      WHERE metric = ? AND t_start >= ? AND t_start <= ?
      ORDER BY t_start ASC`,
  ).all(metric, fromIso, toIso) as RawObsRow[];   // ISO-8601 strings sort lexicographically == chronologically
  return rows.map(rowToObservation);
}
```
> Use a `RawObsRow` snake_case interface + a `rowToObservation` mapper exactly like `RawRow` / `rowToRecord` at facts.ts:95-123.

**Test file:** `src/medical/health-store.test.ts` (create).

---

### `src/medical/numerics.ts` (create)

**Most similar existing file (pure/sync style):** `src/medical/red-flag.ts` — note its header "NO async. NO fs. NO network. NO LLM import. Identical input => identical output." (red-flag.ts:9) and the versioned-constant + plain-`switch`/dispatch convention. numerics.ts must follow the same pure-deterministic discipline, PLUS the contract's hard ban: **no eval / new Function / vm / child_process / execa** (sc-4-8).

**Structure template:**
```typescript
import type { HealthDataStore } from "./health-store.js";
import type { NumericPrimitive, NumericResult, MetricWindow, LabTrend } from "./types.js";

export class NumericsQueryLayer {
  constructor(private readonly store: HealthDataStore) {}

  getMetric(window: MetricWindow, primitive: NumericPrimitive, percentile = 50): NumericResult {
    const rows = this.store.getObservations(window.metric, window.fromIso, window.toIso);

    // ABSTAIN: empty window (sc-4-6)
    if (rows.length === 0) {
      return { primitive, value: null, unit: window.unit ?? "", sampleCount: 0 };
    }

    // UNIT GUARD (sc-4-7): refuse to blend heterogeneous units
    const units = new Set(rows.map((r) => r.unit));
    if (units.size > 1) {
      return { primitive, value: null, unit: "", sampleCount: 0 };   // abstain (no-throw contract)
    }
    const unit = rows[0].unit;

    // rows are returned ordered by t_start ASC from getObservations
    const values = rows.map((r) => r.value);
    const value = computePrimitive(primitive, rows, values, percentile);  // null for zscore w/ n<2
    return { primitive, value, unit, sampleCount: rows.length };
  }

  getLabTrend(biomarker: string): LabTrend {
    const series = this.store.getLabSeries(biomarker);
    if (series.length === 0) {
      return { biomarker, sampleCount: 0, /* abstain shape — see types section */ };
    }
    // ...build trend from series...
  }
}
```
> Primitive dispatch MUST be a plain exhaustive `switch` over the `NumericPrimitive` union with a `never` default (see §8 step 3 for the exact computations and the exhaustive-`never` guard).

**Test file:** `src/medical/numerics.test.ts` (create).

---

### `src/medical/types.ts` (modify)

**Relevant context (existing exports the new types sit beside):** the file currently defines `GuardrailVerdict` (types.ts:11), `MedicalAnswer` (types.ts:39), `ConsentRecord` (types.ts:53), `AuditEvent`/`AuditEntry` (types.ts:64-86). ADD the new data-model types at the end of the file, matching the existing JSDoc + section-comment style.

**Add these (shapes per architecture Data Model, arch doc lines 184-237):**
```typescript
// ── Health observations (S4) ────────────────────────────────────────
export interface HealthObservation {
  id?: string;        // deterministic SHA-256 of metric|tStart|source|value; derivable, so optional on input
  metric: string;
  value: number;
  unit: string;
  tStart: string;     // ISO-8601 PARAMETER — store never reads the clock (mirror facts.ts:20-21 / 76-77)
  tEnd?: string;
  source: string;     // e.g. "apple-health" | "whoop"
}

export interface LabResult {
  id?: string;
  biomarker: string;
  value: number;
  unit: string;
  collectedAtIso: string;
  referenceLow?: number;
  referenceHigh?: number;
}

export interface Baseline { metric: string; value: number; unit: string; }

// ── Numerics (S4, ADR-3) ────────────────────────────────────────────
export type NumericPrimitive =
  | "mean" | "min" | "max" | "latest" | "delta" | "slope" | "percentile" | "zscore";

export interface NumericResult {
  primitive: NumericPrimitive;
  value: number | null;   // null when sampleCount === 0 OR cross-unit refusal OR zscore n<2
  unit: string;
  sampleCount: number;    // 0 ⇒ upstream abstention
}

export interface MetricWindow { metric: string; fromIso: string; toIso: string; unit?: string; }

export interface LabTrend { biomarker: string; sampleCount: number; /* + chosen trend fields */ }
```
> The architecture's `NumericPrimitive` is declared at arch doc line 113 and `NumericResult` at lines 232-237. Keep `value: number | null` and `sampleCount: number` EXACTLY (the contract sc-4-6 + the engine's `deps.numerics?: () => unknown` slot at engine.ts:38 will consume these later).

**Imported by:** `src/medical/engine.ts` already imports `GuardrailSet, MedicalAnswer` from `./types.js` (engine.ts:19). Adding NEW exported types is purely additive — it cannot break the existing engine import. Do NOT remove or rename anything in types.ts.

---

## 2. Patterns to Follow

### Deterministic SHA-256 id helper
**Source:** `src/state/facts.ts`, lines 58-69
```typescript
export function factId(scope, subject, predicate, value, tCreated): string {
  return createHash("sha256")
    .update(`${scope}|${subject}|${predicate}|${value}|${tCreated}`)
    .digest("hex")
    .slice(0, 16);
}
```
**Rule:** Build `observationId` identically — `createHash("sha256").update(pipe-joined fields).digest("hex").slice(0,16)`. The contract's signature is `${metric}|${tStart}|${source}|${value}` (assumptions, contract line 73). The same pattern also lives at `src/orchestrator/memory/distill.ts:91-99` (`lessonIdFromSignature`) — two precedents, identical shape.

### better-sqlite3 sync open + CREATE TABLE IF NOT EXISTS in constructor
**Source:** `src/state/facts.ts`, lines 139-158
```typescript
constructor(dbPath: string) {
  this.db = new Database(dbPath);
  this.db.exec(`CREATE TABLE IF NOT EXISTS semantic_facts ( id TEXT PRIMARY KEY, ... );
                CREATE INDEX IF NOT EXISTS idx_facts_sp ON semantic_facts(...);`);
}
```
**Rule:** Open synchronously in the constructor with `new Database(dbPath)`, create tables + indexes via one `this.db.exec(...)` template literal. NO `await` anywhere — better-sqlite3 is 100% synchronous (evaluatorNotes: "Confirm better-sqlite3 sync usage (no await on store methods)").

### Prepared statement + `.run()` / `.all()` / `.get()`
**Source:** `src/state/facts.ts`, lines 175-191 (`.run`), 215-220 (`.all`), 255-257 (`.get`)
```typescript
this.db.prepare(`INSERT OR REPLACE INTO semantic_facts (...) VALUES (?, ?, ...)`).run(id, ...);
const rows = this.db.prepare(`SELECT * FROM semantic_facts WHERE scope = ?`).all(scope) as RawRow[];
const row  = this.db.prepare(`SELECT * FROM semantic_facts WHERE id = ?`).get(id) as RawRow | undefined;
```
**Rule:** Use `?` placeholders (never string interpolation into SQL), cast `.all()`/`.get()` results to a snake_case `Raw*Row` interface, map to camelCase via a `rowTo*` helper. `info.changes` from `.run()` is how you count affected rows (facts.ts:274 uses `info.changes > 0`).

### snake_case raw row + camelCase mapper
**Source:** `src/state/facts.ts`, lines 95-123 (`RawRow` + `rowToRecord`)
**Rule:** DB columns are snake_case (`t_start`, `ref_low`); the TS interfaces are camelCase (`tStart`, `referenceLow`). Bridge them with a dedicated mapper function, exactly as `rowToRecord` does.

### `close()` releases the connection
**Source:** `src/state/facts.ts`, lines 294-296
```typescript
close(): void { this.db.close(); }
```
**Rule:** Always expose `close()`. Tests must call it (or `rm` the temp dir) in `afterEach` to release file handles.

### Pure/deterministic module discipline (for numerics.ts)
**Source:** `src/medical/red-flag.ts`, lines 1-10 + the `PATTERNSET_VERSION` constant (red-flag.ts:36)
**Rule:** numerics.ts is pure + synchronous: no `Date.now()`/`new Date()`, no fs, no network, no LLM import, identical input ⇒ identical output. Add nothing to the closed `NumericPrimitive` whitelist (8 only). Document the chosen percentile method + zscore formula in a JSDoc comment (assumptions, contract line 75).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `factId` | `src/state/facts.ts:58` | `(scope,subject,predicate,value,tCreated): string` | Reference impl for the deterministic SHA-256 id — MIRROR its body for `observationId` (do not import it; different signature). |
| `lessonIdFromSignature` | `src/orchestrator/memory/distill.ts:91` | `(category,tags,refs): string` | Second precedent for the sha256 → slice(0,16) id pattern. |
| `FactStore` (whole class) | `src/state/facts.ts:136` | better-sqlite3 sync store | The single canonical store pattern to mirror (constructor open, exec DDL, prepared stmts, close). |
| `ensureDir` | `src/state/helpers.ts:6` | `(dirPath): Promise<void>` | `mkdir(recursive)` wrapper — use ONLY if you need to create a parent dir for a file-backed db (generatorNotes: "node:fs/promises only for mkdir"). Tests use temp dirs so usually not needed. |
| `Database` (better-sqlite3) | dep `better-sqlite3@^11.9.1` (package.json:65) | `new Database(path)` | The sync driver. `@types/better-sqlite3@^7.6.13` is present (package.json:90) — no type shim needed. DEFAULT import + `import type { Database as DatabaseType }`. |

> Utilities reviewed: `src/state/helpers.ts`, `src/state/facts.ts`, `src/orchestrator/memory/distill.ts`, `src/medical/*`. There is NO existing numeric/statistics helper anywhere — the 8 primitives are net-new pure math you write inline in numerics.ts (do NOT pull in a stats library; keep it in-process per ADR-3).

---

## 4. Prior Sprint Output

### Sprint 1 (60215d2): medical-sop plumbing
**Created:** `src/medical/types.ts` (the file you EXTEND), `src/medical/engine.ts`, `src/medical/team.ts`.
**Connection:** types.ts is where your new `HealthObservation`/`LabResult`/`NumericResult`/`NumericPrimitive`/`MetricWindow`/`Baseline`/`LabTrend` types are added (additively).

### Sprint 3 (6fc7c97): RedFlagDetector + MedicalGuardrails + DI seam
**Created/modified:** `src/medical/red-flag.ts` (pure/sync style to mirror), `src/medical/guardrails.ts`; `MedicalSopDeps` (engine.ts:29-39) gained `llmClient?: LLMClient` and `numerics?: () => unknown` slots.
**Connection:** The `deps.numerics` slot at `src/medical/engine.ts:38` is a PLACEHOLDER. This sprint builds `NumericsQueryLayer` but does NOT wire it into `engine.run` — the engine currently runs consent (Gate 1) → red-flag (Gate 2) → placeholder allow path (engine.ts:81-192). Leave engine.ts UNTOUCHED. Full SOP wiring is S6.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` found at repo root (checked). The binding principles for this sprint come from the ADRs below + CLAUDE.md engineering constraints (strict ESM/NodeNext, `.js` import extensions, provider-agnostic, no SDK types outside `src/providers/`).

### Architecture Decisions
- **ADR-3** (`.bober/architecture/arch-20260616-medical-team-adr-3.md`): Closed `NumericPrimitive` whitelist `mean|min|max|latest|delta|slope|percentile|zscore` as pure TS. NO eval, NO codegen, NO Python sandbox. "adding a computation requires extending the `NumericPrimitive` union (a code review event), not a model decision; `sampleCount: 0` signals upstream abstention."
- **ADR-4** (`.bober/architecture/arch-20260616-medical-team-adr-4.md`): SINGLE generic events table (not one-table-per-metric). `INSERT OR IGNORE` on deterministic `(metric|tStart|source|value)` id (mirroring `factId`, facts.ts:58-69). `upsertObservations` returns count of NEW rows. "Heterogeneous units in one table can be mixed if a caller ignores the `unit` field; mitigated by `NumericsQueryLayer` reading `unit` per row and refusing cross-unit aggregation."
- **Architecture Data Model** (arch doc lines 184-237): exact `HealthObservation`, `LabResult`, `NumericResult` shapes. **Risk table line 328:** "Heterogeneous units mixed in generic table → NumericsQueryLayer reads `unit` per row; refuses cross-unit aggregation."

### Other Docs
- CLAUDE.md (global): no eval/Function/codegen/child_process in numerics (matches sc-4-8). ESM `.js` extensions, NodeNext.
- `eslint.config.js:47` has a `no-restricted-imports` rule (used by telemetry egress boundary). Not directly applied to medical numerics, but the spirit (no forbidden imports) aligns with sc-4-8.

---

## 6. Testing Patterns

### Unit Test Pattern — in-memory DB (simplest, FactStore style)
**Source:** `src/state/facts.test.ts`, lines 1-30
```typescript
import { describe, it, expect, afterEach } from "vitest";
import { FactStore, factId } from "./facts.js";

describe("FactStore (in-memory)", () => {
  let store: FactStore;
  afterEach(() => { store?.close(); });

  it("insert -> getActiveFacts returns the row", () => {
    store = new FactStore(":memory:");
    const t = "2026-06-15T00:00:00.000Z";
    const rec = store.insertFact({ /* ... */ tValid: t, tCreated: t });
    expect(store.getActiveFacts("programming")).toHaveLength(1);
  });
});
```
**Runner:** vitest (`vitest@^3.0.5`, package.json:99; `npm test` → `vitest`).
**Assertion style:** `expect(...).toBe / .toEqual / .toHaveLength / .not.toBeNull`.
**Mock approach:** NONE — real better-sqlite3. The contract is explicit: "using temp dirs, no fs mocks" (sc-4-3).
**File naming:** collocated `*.test.ts` next to source (`facts.ts`/`facts.test.ts`, `red-flag.ts`/`red-flag.test.ts`).

### Unit Test Pattern — temp-dir file DB (use for at least one HealthDataStore test to prove file-backed dedup + cleanup)
**Source:** `src/chat/conversation-store.test.ts`, lines 1-17
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-health-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

it("dedupes via INSERT OR IGNORE (sc-4-4)", () => {
  const store = new HealthDataStore(join(tmpDir, "health.db"));
  const obs = [/* 5 distinct HealthObservation */];
  expect(store.upsertObservations(obs)).toBe(5);   // first insert: 5 new
  expect(store.upsertObservations(obs)).toBe(0);   // re-insert same 5: 0 new
  expect(store.getObservations("weight", "2000-01-01", "2100-01-01")).toHaveLength(5);
  store.close();
});
```
**Selector convention / E2E:** N/A — no Playwright config for this sprint (`playwright.config.ts` not relevant; this is a pure backend sprint).

> Use `:memory:` for the primitive-math tests (fast, no fs) and at least one `mkdtemp` file-backed test for the dedup/persistence assertion (sc-4-4) to satisfy "using temp dirs". The grep test (sc-4-8) reads the source file with `readFileSync` and asserts the regex is absent:
```typescript
import { readFileSync } from "node:fs";
it("contains no eval/codegen/subprocess (sc-4-8)", () => {
  const src = readFileSync(new URL("./numerics.ts", import.meta.url), "utf8")
            + readFileSync(new URL("./health-store.ts", import.meta.url), "utf8");
  expect(src).not.toMatch(/\beval\b|new Function|child_process|\bexeca\b|\bvm\b/);
});
```

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/medical/engine.ts` | `src/medical/types.ts` (imports `GuardrailSet, MedicalAnswer`, engine.ts:19) | low | You only ADD exports to types.ts. Adding types cannot break an existing named import. Do NOT remove/rename `GuardrailVerdict`, `MedicalAnswer`, `ConsentRecord`, `AuditEntry`, `AuditEvent`, `GuardrailSet`, `GuardrailContext`, `Citation`. |
| (none) | `src/medical/health-store.ts` / `numerics.ts` | none | Both files are NET-NEW and imported by nothing yet (the engine's `deps.numerics` slot is `() => unknown` and not wired this sprint). Zero blast radius. |
| `src/state/facts.ts` | — | none | You COPY its pattern; you do NOT modify it. Leave it untouched. |

### Existing Tests That Must Still Pass
- `src/medical/engine.test.ts` — tests consent Gate 1 + red-flag Gate 2 + placeholder allow path; must stay green because engine.ts is untouched.
- `src/state/facts.test.ts` — tests FactStore; untouched, but confirms the better-sqlite3 sync pattern you mirror still compiles against `better-sqlite3@^11.9.1`.
- `src/medical/{red-flag,guardrails,consent,audit,disclaimer,team}.test.ts` — unrelated; verify the FULL suite stays green (sc-4-3) since you import nothing into them.

### Features That Could Be Affected
- **S6 SOP wiring** — will consume `NumericsQueryLayer` via `MedicalSopDeps.numerics` (engine.ts:38). Keep `NumericResult` shape EXACTLY `{ primitive, value: number|null, unit, sampleCount }` so S6 can plug in without a type change. Do NOT change that slot's signature this sprint.
- **S5 ingestion** — will call `store.upsertObservations`. Keep the `HealthObservation` shape + `upsertObservations(rows): number` signature stable (architecture line 83).

### Recommended Regression Checks
1. `npm run build` (sc-4-1) — zero TS errors.
2. `npm run typecheck` (sc-4-2) — zero strict-mode errors.
3. `npm test` (sc-4-3) — FULL suite green (the pre-existing ~2300+ tests + your new ones).
4. Confirm NO `await` on any HealthDataStore method call in tests (better-sqlite3 is sync — evaluatorNotes).
5. Confirm engine.ts / facts.ts diffs are EMPTY (only types.ts additive + two new files).

---

## 8. Implementation Sequence

1. **`src/medical/types.ts`** — ADD `HealthObservation`, `LabResult`, `Baseline`, `NumericPrimitive`, `NumericResult`, `MetricWindow`, `LabTrend` (additive; match existing JSDoc/section-comment style).
   - Verify: `npm run typecheck` still passes; existing `engine.ts` import is unaffected.

2. **`src/medical/health-store.ts`** — `observationId` helper (mirror `factId`) + `HealthDataStore` class (mirror `FactStore`). Single `health_observations` table + `lab_results` table + `kv_store`. Methods: `upsertObservations` (txn, sum `info.changes`), `getObservations` (range + ORDER BY t_start), `getLabSeries`, `getBaseline`/`putBaseline`, `getPreference`, `close`. All SYNC.
   - Verify: `new HealthDataStore(":memory:")` then upsert 5 / re-upsert 5 returns 0; `getObservations` returns 5 in t_start order.

3. **`src/medical/numerics.ts`** — `NumericsQueryLayer(store)` with `getMetric(window, primitive, percentile=50)` + `getLabTrend(biomarker)`. Empty window ⇒ `{value:null, sampleCount:0}` (no throw). Unit-set size > 1 ⇒ abstain (`{value:null, sampleCount:0}`). Exhaustive `switch` over `NumericPrimitive` with a `never` default. NO eval/Function/vm/child_process/execa.
   - **EXACT primitive computations** (given values ordered by `t_start ASC`; fixture from evaluatorNotes: values `[10,20,30,40]` at increasing timestamps):
     - `mean` = sum(values)/n → 25
     - `min` = Math.min(...values) → 10
     - `max` = Math.max(...values) → 40
     - `latest` = value at the max `t_start` = last element of the ASC-ordered array → 40
     - `delta` = latest − earliest = values[n-1] − values[0] → 40 − 10 = 30
     - `slope` = least-squares slope of (t, value), t = `Date.parse(r.tStart)` epoch-ms. slope = `(n·Σ(t·v) − Σt·Σv) / (n·Σ(t²) − (Σt)²)`. For evenly increasing values over increasing time ⇒ slope > 0 (assert `> 0`, plus the exact value if timestamps are evenly spaced). Guard: denominator 0 (all same timestamp) ⇒ abstain (`value:null`, but `sampleCount` = n; or document treating it as 0 — pick one and TEST it).
     - `percentile` (default p50): DOCUMENT the method. Recommended **linear interpolation between closest ranks** on the sorted-ascending values: `rank = (p/100)·(n−1)`; `lo=floor(rank)`, `hi=ceil(rank)`; `value = v[lo] + (rank−lo)·(v[hi]−v[lo])`. For `[10,20,30,40]` p50 → rank=1.5 → `20 + 0.5·(30−20)` = 25. (If you instead pick nearest-rank, document THAT and assert its result.) Put the chosen formula in a JSDoc comment (assumptions, contract line 75).
     - `zscore` = `(latest − mean) / stddev`. Use POPULATION stddev `sqrt(Σ(v−mean)²/n)` (document it). `sampleCount < 2` ⇒ abstain (`value:null`) because stddev is undefined/0 — TEST this. For `[10,20,30,40]`: mean=25, popVar = ((225)+(25)+(25)+(225))/4 = 125, stddev=√125≈11.1803, latest=40 → z=(40−25)/11.1803 ≈ 1.3416.
   - **Edge cases to TEST:** empty window (sc-4-6), `getLabTrend("unknown")` abstain (sc-4-6), mixed units for `metric:"weight"` units `"kg"`+`"lb"` ⇒ abstain not a blended number (sc-4-7), zscore with n<2 ⇒ abstain.
   - Verify: each primitive matches the hand-computed values above (sc-4-5).

4. **`src/medical/health-store.test.ts`** — `:memory:` tests for accessors + a `mkdtemp` file-backed test for dedup NEW-row count (sc-4-4). `afterEach` closes the store / `rm`s the temp dir.
   - Verify: dedup returns 0 on re-insert; `getObservations` count stable.

5. **`src/medical/numerics.test.ts`** — fixture-series tests for all 8 primitives (sc-4-5), empty-window abstain + unknown-biomarker abstain (sc-4-6), cross-unit refusal (sc-4-7), and the `readFileSync` regex grep test for eval/codegen/subprocess (sc-4-8) over BOTH numerics.ts and health-store.ts.
   - Verify: all assertions pass.

6. **Run full verification** — `npm run build` (sc-4-1), `npm run typecheck` (sc-4-2), `npm test` (sc-4-3).

---

## 9. Pitfalls & Warnings

- **`better-sqlite3` is SYNCHRONOUS.** Do NOT `await` `new Database()`, `.run()`, `.all()`, `.get()`, `.transaction()`, or any store method. The evaluator explicitly checks "no await on store methods." Mark store methods as non-async.
- **DEFAULT import for the driver:** `import Database from "better-sqlite3";` (facts.ts:3) — NOT `import { Database }`. The TYPE is `import type { Database as DatabaseType } from "better-sqlite3";` (facts.ts:4). Mixing these up is a common TS error.
- **id signature order is `metric|tStart|source|value`** (value LAST) — different field order than `factId`'s `scope|subject|predicate|value|tCreated`. Copy the *mechanism*, not the field list. Use the order from contract line 73 / ADR-4.
- **NEW-row count comes from `INSERT OR IGNORE` + summing `info.changes`** — do NOT use `INSERT OR REPLACE` (facts.ts:177 uses REPLACE for upsert-overwrite semantics, which is WRONG here: REPLACE would re-insert and report changes=1 on a dup, breaking sc-4-4). Use `INSERT OR IGNORE`.
- **Cross-unit handling = ABSTAIN, not throw.** The architecture risk table (line 328) says "refuses cross-unit aggregation"; the contract's no-throw numerics contract (architecture API table line 251: "sampleCount: 0 ⇒ abstain (no throw)") means you return `{value:null, sampleCount:0}`. Make it observable but do not `throw`. sc-4-7 asserts "refusal/abstain rather than a blended number."
- **Empty window must NOT throw** (sc-4-6) — return the abstain `NumericResult` early before any math.
- **zscore / slope degenerate cases:** n<2 for zscore (stddev undefined) and zero-variance timestamps for slope (division by zero). Decide abstain vs documented sentinel, document it in JSDoc, and TEST it — an `NaN`/`Infinity` slipping into `value` will fail strict expectations.
- **Do NOT wire the engine.** `engine.ts` stays byte-identical this sprint; `deps.numerics` is a placeholder slot (engine.ts:38). Wiring is S6. Touching engine.ts risks breaking `engine.test.ts` and is out of scope.
- **No barrel/index.** `src/medical/` has no `index.ts`. Import across medical files with explicit `./health-store.js`, `./types.js` (`.js` extension required by NodeNext ESM).
- **No stats library.** ADR-3 mandates in-process pure TS. Do not add a dependency; write the 8 primitives inline.
- **ISO-string range filter works because ISO-8601 sorts lexicographically.** Use `t_start >= ? AND t_start <= ?` with ISO strings directly; no `Date` parsing needed for the range filter (but DO parse to epoch-ms for the slope regression).
- **sc-4-8 grep test must cover BOTH files.** Read `numerics.ts` AND `health-store.ts` source in the regex test; an `execa`/`child_process` slipping into the store would also fail the spirit of the no-subprocess rule.
