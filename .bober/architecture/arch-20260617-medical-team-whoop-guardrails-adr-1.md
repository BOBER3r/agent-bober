# ADR-1: WHOOP device-connection as a sink-feeding network adapter behind a new third egress axis

**Decision:** Integrate WHOOP via a `WhoopSyncAdapter` that pulls v2 records and writes `HealthObservation[]` into the existing `ObservationSink`, with all HTTP confined to one new ESLint-excepted file (`src/medical/whoop/whoop-client.ts`) guarded at runtime by a new `EgressGuard` axis `"device-connection"` (default false), triggered on-demand by `bober medical whoop sync`; the refuse layer reuses the existing `GuardrailSet`/`{kind:"refuse"}` surface and Apple Health stays the offline SAX file-import path as-is.

**Context:** The medical team has no WHOOP adapter, no code-enforced non-emergency refusal, and an unconfirmed Apple Health scope. WHOOP is a token-authenticated, paginated, rate-limited (100/min, 10k/day) network API — fundamentally different from the file-import sources the existing `IngestionAdapter` contract was shaped for — and must persist locally without violating the zero-egress-by-default boundary (base ADR-6).

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A: WHOOP as a file-shaped `IngestionAdapter` | Max surface reuse; one source model | Overloads file-path-shaped `canHandle(filePath)`/`ingest(filePath, sink)` (`src/medical/types.ts:209-213`) with a token/window; forces network code under the ESLint-banned adapter dir or a blanket exception weakening base ADR-6; no seam for OAuth refresh / pagination / rate-limits |
| B: Sink-feeding network adapter + new device-connection egress axis | Reuses `ObservationSink`/store/dedup unchanged; network in one excepted file w/ `assertAllowed`; clean OAuth/pagination/rate-limit seam; pull-based CLI matches approved no-webhook posture | Adds a sync entry point + one excepted file + a third egress axis; widens audited egress footprint from 1 to 2 files |
| C: Generic multi-provider `DeviceSyncManager` | Future wearables plug in; centralized OAuth/rate-limit | Speculative abstraction for one in-scope provider; larger new surface; wrong-abstraction risk from a sample size of one |

**Rationale:** The backward-compatibility constraint names `IngestionAdapter.ingest(filePath, sink)` as a file-path-shaped Locked Dependency (base ADR-4: extend by a new class, never alter the interface), which eliminates A's reuse-by-overloading; the consumers constraint (single self-responsible user, exactly one provider in scope) plus the YAGNI rung eliminate C's multi-provider layer. B reuses the `ObservationSink`/`HealthDataStore`/content-derived-dedup downstream unchanged and confines all new egress to one ESLint-excepted file behind a new axis independent of `cloud-inference`/`literature-retrieval`, honouring base ADR-6's per-purpose-opt-in invariant.

**Consequences:** `EgressAxis` gains a third value `"device-connection"` (default false) in `src/medical/egress.ts` and the medical config schema; a new `src/medical/whoop/whoop-client.ts` joins the ESLint network-exception list as the second sanctioned egress file; a `bober medical whoop sync` subcommand is added mirroring `medical import`; WHOOP records dedup via `source="whoop"` with no schema change. The refuse layer adds a `RefusalDetector` + a dispatch branch in `MedicalSopEngine.run` reusing existing types; Apple Health requires no new code.

**Risk:** If WHOOP later mutates v2 records in place (rather than append-only), the content-derived SHA-256 dedup key (`src/medical/health-store.ts:32-42`) treats an edited record as a new row, double-counting a time-series — mitigated only by adding a UUID-keyed upsert path that would touch base ADR-4 storage; unproven and tracked as an Open Question.
