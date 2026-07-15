# ADR-7: Medications Value-Of-Record Lives In FactStore (Bi-Temporal); HealthDataStore Holds Time-Series Observations

**Decision:** A patient's active medication list (the "value of record" the engine reasons over) is stored in the existing bi-temporal `FactStore` (`src/state/facts.ts`) under a medical scope, while raw quantitative observations (heart rate, labs, etc.) live in the new `HealthDataStore`; the two are NOT merged.

**Context:** Medications change over time and must support "what was the patient taking on date X" plus invalidate-don't-delete history for audit. `FactStore` is already bi-temporal (`facts.ts:150-153` — `t_valid`/`t_invalid`/`t_created`/`t_invalidated`) and invalidates rather than deletes (`reconcile.ts:73` sets both world-time and record-time). `HealthDataStore` is an append-only event table optimized for windowed numeric queries, not for superseding-fact semantics.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A. Medications in `FactStore` (bi-temporal), observations in `HealthDataStore` | Reuses proven invalidate-don't-delete + as-of-date query; medication corrections preserve history; no new bi-temporal code | Two stores to query in one SOP turn; engine must join logically |
| B. Medications as rows in `HealthDataStore` | One store | `HealthDataStore` is append-only events with no `t_invalidated` column; a stopped/corrected medication cannot be superseded without deleting (violates audit) |
| C. New dedicated medications table with custom bi-temporal columns | Tailored schema | Reinvents `FactStore`'s exact bi-temporal model; duplicate invalidation logic to maintain and test |

**Rationale:** CP1 "medications staleness (bi-temporal invalidate-don't-delete)" + local append-only audit constraint. Option B's `HealthDataStore` has no record-time invalidation, so a discontinued drug could only be removed by deletion — eliminated. Option C duplicates `facts.ts:164-206`/`reconcile.ts:73` logic the repo already ships and tests — eliminated by the reuse-not-rebuild principle.

**Consequences:** `MedicalSopEngine` reads active medications via `FactStore.getActiveFacts(scope, subject, "takes-medication")` and observations via `HealthDataStore.getObservations`/`getLabSeries`; a medication change calls the reconcile invalidate path, never a DELETE.

**Risk:** If a medication is written to `FactStore` but its dose is later parsed from an ingested file into `HealthDataStore`, two sources of truth diverge. Mitigated by the Consistency Model: `FactStore` is the sole value-of-record for medications; `HealthDataStore` never stores medication-list state. Surfaced as Integration Risk row 4.
