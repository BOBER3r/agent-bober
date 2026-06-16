# HealthDataStore + deterministic NumericsQueryLayer

**Contract:** sprint-spec-20260616-medical-team-4  ·  **Spec:** spec-20260616-medical-team  ·  **Completed:** 2026-06-16

## What this sprint added

The data + numerics layer that **keeps arithmetic out of the LLM** (ADR-3).
`HealthDataStore` (`src/medical/health-store.ts`) is a `better-sqlite3` **synchronous**
store mirroring `FactStore` (`src/state/facts.ts`): it persists health observations and
lab results behind a deterministic SHA-256 id with `INSERT OR IGNORE` dedup, exposing
only typed accessors. `NumericsQueryLayer` (`src/medical/numerics.ts`) computes a
**closed whitelist of 8 numeric primitives** (`mean | min | max | latest | delta | slope
| percentile | zscore`) plus `getLabTrend` in pure TypeScript — there is **no `eval`, no
`Function`, no `vm`, no `child_process`/`execa`** anywhere in the layer. The LLM never
performs arithmetic; adding a computation is a code-review event (extend the
`NumericPrimitive` union), not a model decision. The numeric/lab type surface was added
**additively** to `src/medical/types.ts`. This is Sprint 4 of 7; ingestion (S5), egress +
medications + full SOP wiring (S6), and literature retrieval (S7) remain.

## Public surface

### `src/medical/health-store.ts`

- `observationId(metric, tStart, source, value): string` (`health-store.ts:32`) —
  deterministic 16-char hex id = `SHA-256(metric|tStart|source|value).slice(0,16)`,
  mirroring `factId` (`src/state/facts.ts:58-69`). No wall-clock dependency; identical
  inputs always produce the same id.
- `labResultId(biomarker, collectedAtIso, value): string` (`health-store.ts:48`) —
  deterministic 16-char hex id = `SHA-256(biomarker|collectedAtIso|value).slice(0,16)`.
- `class HealthDataStore` (`health-store.ts:115`) — fully **synchronous** SQLite store;
  `new HealthDataStore(dbPath)` opens (and `CREATE TABLE IF NOT EXISTS` migrates) the db.
  - `upsertObservations(rows: HealthObservation[]): number` (`health-store.ts:155`) —
    transactional `INSERT OR IGNORE` keyed on `observationId`; returns the count of
    **NEW rows only** (sum of `info.changes`; `0` for a re-insert of existing rows).
  - `getObservations(metric, fromIso, toIso): HealthObservation[]` (`health-store.ts:181`) —
    rows for `metric` within the inclusive `[fromIso, toIso]` range, ordered `t_start` ASC
    (ISO-8601 sorts lexicographically == chronologically).
  - `getLabSeries(biomarker): LabResult[]` (`health-store.ts:196`) — all lab results for a
    biomarker, ordered `collected_at` ASC.
  - `upsertLabResult(result: LabResult): number` (`health-store.ts:212`) — `INSERT OR IGNORE`
    keyed on `labResultId`; returns `0` or `1`.
  - `getBaseline(metric): Baseline | undefined` / `putBaseline(b: Baseline): void`
    (`health-store.ts:236`, `:247`) — kv-backed baseline read/write (`baseline:<metric>`,
    `INSERT OR REPLACE`).
  - `getPreference(key): string | undefined` (`health-store.ts:257`) — kv-backed preference
    read (`pref:<key>`).
  - `close(): void` (`health-store.ts:265`) — closes the underlying db connection.

### `src/medical/numerics.ts`

- `class NumericsQueryLayer` (`numerics.ts:164`) — `new NumericsQueryLayer(store)`; all
  methods **synchronous**, no async/fs/network/LLM import.
  - `getMetric(window: MetricWindow, primitive: NumericPrimitive, percentile = 50): NumericResult`
    (`numerics.ts:182`) — pulls rows via `store.getObservations`, runs the per-row **unit
    guard**, then dispatches the primitive through an exhaustive `switch` with a `never`
    guard (a new union member fails the build until handled). `percentile` is used only by
    the `percentile` primitive (linear interpolation between closest ranks; default p50).
  - `getLabTrend(biomarker): LabTrend` (`numerics.ts:212`) — `{ biomarker, sampleCount,
    latestValue, latestUnit, latestCollectedAt, slope }` from `store.getLabSeries`; slope is
    the least-squares slope over the series (null when `sampleCount < 2`).

### `src/medical/types.ts` (additive)

- `HealthObservation` (`types.ts:95`), `LabResult` (`types.ts:112`), `Baseline` (`types.ts:124`).
- `NumericPrimitive` (`types.ts:136`) — the closed 8-member union.
- `NumericResult` (`types.ts:151`), `MetricWindow` (`types.ts:161`), `LabTrend` (`types.ts:170`).

## How to use / how it fits

The numerics layer reads from the store; the LLM consumes only the resulting `NumericResult`
values, never raw arithmetic:

```ts
const store = new HealthDataStore(dbPath);
store.upsertObservations([
  { metric: "weight", value: 70.0, unit: "kg", tStart: "2026-06-01T08:00:00Z", source: "withings" },
  { metric: "weight", value: 71.0, unit: "kg", tStart: "2026-06-08T08:00:00Z", source: "withings" },
]);

const numerics = new NumericsQueryLayer(store);
numerics.getMetric(
  { metric: "weight", fromIso: "2026-06-01T00:00:00Z", toIso: "2026-06-30T00:00:00Z" },
  "delta",
);
// => { primitive: "delta", value: 1, unit: "kg", sampleCount: 2 }
```

This layer is the numeric half of the medical SOP. Ingestion (S5) will call
`upsertObservations` / `upsertLabResult` to populate the store; S6 will wire
`NumericsQueryLayer` into `MedicalSopEngine.run` through the existing
`MedicalSopDeps.numerics` injection slot (added in Sprint 3) so the SOP's numeric answers
are computed here, not by the model.

### Abstain vs. refusal — read the `sampleCount`

`getMetric` never throws; both "no data" and "data present but rejected" return
`value: null`, but they are **distinguishable by `sampleCount`** (this is load-bearing for
upstream callers):

| Situation | Result | Meaning |
|---|---|---|
| Empty window (no rows in range) | `{ value: null, sampleCount: 0 }` | **Abstain** — nothing to compute (sc-4-6). |
| Heterogeneous units for the metric | `{ value: null, sampleCount: N>0 }` | **Cross-unit refusal** — rows were found but mixing units would blend (e.g. `kg` + `lb`), so the layer refuses rather than returning a meaningless blended number (sc-4-7). |
| `zscore` with `sampleCount < 2` | `{ value: null, sampleCount: 1 }` | Partial abstain — population stddev is undefined for n<2. |
| `slope` with all rows at the same timestamp | `{ value: null, sampleCount: N }` | Partial abstain — least-squares denominator is 0. |

So `value === null && sampleCount === 0` is a true abstain (call it differently, widen the
window), whereas `value === null && sampleCount > 0` is a deliberate code-enforced refusal
(the data is unsafe to aggregate as-is). `getLabTrend` on an unknown biomarker abstains
with `sampleCount: 0` and `null` latest/slope fields.

## Notes for maintainers

- **3-table design vs. the spec's "single generic events table" wording.** The contract
  description and `definitionOfDone` describe `HealthDataStore` as "a single generic events
  table." The implementation uses **three** tables — `health_observations` (the generic
  metric time-series), `lab_results` (biomarkers with reference ranges), and `kv_store`
  (backing `getBaseline`/`putBaseline`/`getPreference`) — because `LabResult`, `Baseline`,
  and `Preference` have genuinely distinct shapes (e.g. labs carry `ref_low`/`ref_high`
  reference ranges that observations do not). This deviation was **flagged by the generator
  and explicitly accepted by the evaluator**: no `sc-4-*` criterion mandates a single table
  (the criteria are about dedup/new-row-count, the 8 primitives, abstain, the unit guard,
  and no dynamic execution), and `health_observations` is still the generic single-table for
  observations. The contract's `generatorNotes` in fact anticipate "a separate `lab_results`
  table … keep labs distinct from observations," so the 3-table shape is consistent with the
  detailed guidance even though the summary line says "single." Future maintainers should
  treat `health_observations` as the generic table and `lab_results` as the typed lab table;
  per the non-goals, **medications are NOT stored here** — they are FactStore
  value-of-record (S6 / ADR-7).
- **`percentile` method is linear interpolation between closest ranks.** `rank = (p/100)·(n−1)`,
  then interpolate between `v[floor(rank)]` and `v[ceil(rank)]` on the ascending-sorted
  values (so p50 of `[10,20,30,40]` = 25, p25 = 17.5). `zscore` uses **population** stddev
  `sqrt(Σ(v−mean)²/n)` and is `(latest − mean) / popStd` (identical values ⇒ z = 0). These
  formulas are documented in the file header (`numerics.ts:12-29`) — keep the docstring in
  sync if the method ever changes, since tests assert against these exact hand-computed values.
- **Carry-forward (S6 cleanup) — `readFileSync` in `numerics.test.ts`.** The sc-4-8
  source-grep guard test (`src/medical/numerics.test.ts`, ~lines 2 / 346 / 347) reads the
  numerics/health-store source via **synchronous** `readFileSync`, which violates the
  project's "`node:fs/promises` only" principle. It is the only such violation in the
  codebase and is functionally correct (the grep is a genuine guard that would catch a real
  `eval`/`Function`/`vm`/`child_process`/`execa`). This is **non-blocking** (eval verdict was
  PASS) and is bundled with the S3 test-cleanup carry-forward for a final S6 cleanup pass:
  convert to `await readFile(join(dir, 'numerics.ts'), 'utf8')` from `node:fs/promises`.
- **The store never reads the clock.** Every timestamp (`tStart`, `tEnd`, `collectedAtIso`)
  is an **injected ISO-8601 parameter**; `HealthDataStore` and `NumericsQueryLayer` never
  call `Date.now()` / `new Date()`, mirroring the purity contract of the rest of `src/medical`.
- **`better-sqlite3` swap note.** The file header records the intent to swap `better-sqlite3`
  for the built-in `node:sqlite` once `engines.node` is raised to `>= 22.5`. The store's
  synchronous surface is chosen to make that swap mechanical.
- **No SDK/network in the numerics path.** Neither `numerics.ts` nor `health-store.ts`
  imports from `src/providers` or any network module (asserted by the sc-4-8 source-read test).
