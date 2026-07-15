# ADR-4: Generic Events Table for Health Observations, Not One Table Per Metric

**Decision:** Store health time-series in a single generic `HealthObservation` events table keyed by `(metric, tStart, source)`, rather than one table per metric type.

**Context:** Apple Health and Whoop emit dozens of heterogeneous, evolving metric types ingested from ~4GB streaming sources. The schema must dedupe on (metric, timestamp, source) and stay backward-stable as new metrics appear.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| Generic events table | New metric = new row, no migration; one dedup index; mirrors `semantic_facts` single-table pattern (facts.ts:142) | Per-metric typing/units enforced in code, not schema |
| One table per metric | Strong per-metric typing | Schema migration per new metric type; brittle against unknown Apple Health types; many near-identical tables |

**Rationale:** CP1 constraints "Apple Health XML up to ~4GB → streaming SAX ingestion" with dedup on (metric, timestamp, source) and the locked `better-sqlite3` single-table bi-temporal convention (`FactStore`, facts.ts:136) make per-table migrations on every novel metric untenable; the generic table absorbs unknown metrics without DDL changes, eliminating the per-table option.

**Consequences:** `HealthDataStore` uses `INSERT OR IGNORE` on a deterministic `(metric|tStart|source|value)` id (mirroring `factId`, facts.ts:58-69); `upsertObservations` returns the count of NEW rows; units/types validated in TypeScript at the accessor boundary.

**Risk:** Heterogeneous units in one table can be mixed if a caller ignores the `unit` field; mitigated by `NumericsQueryLayer` reading `unit` per row and refusing cross-unit aggregation.
