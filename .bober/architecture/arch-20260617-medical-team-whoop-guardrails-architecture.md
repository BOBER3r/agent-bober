# Architecture: Medical Team — WHOOP Device-Connection + Code-Enforced Refusal Guardrails

**Architecture ID:** arch-20260617-medical-team-whoop-guardrails
**Generated:** 2026-06-17T00:00:00Z
**Status:** draft

---

## Executive Summary

This architecture extends the existing medical team (`arch-20260616-medical-team`, module `src/medical/`) to production-grade for a single self-responsible user, and does not contradict that base architecture's ADRs 1-7. It adds a WHOOP device-connection ingestion path as a sink-feeding network adapter behind a new third egress axis `"device-connection"` (default false), confirms Apple Health stays the offline SAX file-import path unchanged, and closes the code-enforced non-emergency refusal gap by emitting the already-defined `{kind:"refuse"}` verdict through a deterministic `RefusalDetector`. The accepted tradeoffs are a small new component surface (a WHOOP sync orchestrator, one new ESLint-excepted network file, a token store, a refusal detector) and a second sanctioned network-egress file, in exchange for reusing the existing `ObservationSink`/`HealthDataStore`/dedup unchanged and keeping all highest-stakes decisions code-enforced and pre-LLM. The primary engineering risk is WHOOP in-place record mutation double-counting against the content-derived dedup key; the shipping/marketing FFDCA §201(h) gate is an external process tracked in the base architecture and out of scope here.

---

## Problem Statement

**Problem:** The existing medical team (`src/medical/`) has three production-grade gaps for a single self-responsible user: (a) no WHOOP device-connection ingestion adapter despite `HealthObservation.source` (`src/medical/types.ts:106`) already naming `"whoop"` and the adapter registry (`src/medical/ingestion.ts:39-64`) being designed to accept new adapters via a new class (base ADR-4); (b) Apple Health ingestion is complete only for the offline `export.xml` file-import path (`src/medical/adapters/apple-health.ts:29-119`, SAX streaming) with no determination of whether a live/connection path is in scope; and (c) `MedicalGuardrails.evaluate` (`src/medical/guardrails.ts:80-98`) never emits the `{kind:"refuse"}` verdict that already exists in the type surface (`src/medical/types.ts:14`) and audit enum (`src/medical/types.ts:69`), so requests for prescriptions/dosing/treatment-plans fall through to `{kind:"allow"}` (`src/medical/guardrails.ts:97`) and are refused prompt-only by the LLM rather than code-enforced before any model call.

**Constraints:**
- Latency: No numeric budget. INVARIANT (base ADR-2): the refuse decision MUST be deterministic and execute BEFORE any LLM call (0 LLM round-trips), like the red-flag short-circuit at `src/medical/engine.ts:250-289`. Research REFUTED the single-LLM-call hybrid guardrail and the in-line LLM policy filter — the pre-LLM code-enforced posture is retained.
- Throughput: Single-user interactive `bober chat medical` session. WHOOP API rate limits are 100 req/min and 10,000 req/day with a reset header in seconds; backpressure precedent is the SAX adapter's bounded ~1000-row batches (`src/medical/adapters/apple-health.ts:13,96-99`).
- Data volume: WHOOP v2 returns paginated records (recovery/sleep/cycles/workouts) with UUID resource IDs. The local dedup key is content-derived — `observationId = SHA-256(metric|tStart|source|value)` (`src/medical/health-store.ts:32-42`) — so WHOOP UUIDs do NOT become the PK. v1 is deprecated → target v2 endpoints (`/v2/recovery`, `/v2/activity/sleep`, `/v2/cycle`, `/v2/activity/workout`).
- Cost ceiling: Not a dollar figure. Zero-egress default (base ADR-6) makes default outbound bytes = 0; WHOOP sync is a NEW outbound path requiring its own opt-in.
- Backward compatibility (HARD): The two-axis `EgressGuard` (`src/medical/egress.ts:5`) MUST keep its invariant that enabling one axis never enables another. The ESLint zero-egress boundary forbids ALL network/socket imports in `src/medical/**` (`eslint.config.js:74-97`) EXCEPT the single excepted file `src/medical/retrieval/medline-source.ts` (`eslint.config.js:101-106`); any WHOOP network call MUST be confined to a similarly-excepted sanctioned file with a runtime `assertAllowed` guard. The zero-arg `MedicalSopEngine` constructor (`src/medical/engine.ts:194`) and the `pipelineShape`/`engine` enums (`src/config/schema.ts:220,366`) must not change shape. Base ADRs 1-7 must not be contradicted. Programming-team behavior byte-unaffected.
- Privacy/consent (HARD, engineering posture): WHOOP ToU requires per-user express consent and disclaims HIPAA, serving data as-is. On-device persistence is permitted. OAuth2 Authorization Code is the ONLY supported flow; the `offline` scope is required for a long-lived refresh token; access is scope-gated (`read:recovery`, `read:cycles`, `read:workout`, `read:sleep`, `read:profile`, `read:body_measurement`).
- Determinism (HARD): the audit log records IDs/enums only — never prompt text or health values (`src/medical/types.ts:64-87`); the existing `"refuse"` audit event (`src/medical/types.ts:69`) is the slot for the new code-enforced refusals (precedent: the consent refuse path at `src/medical/engine.ts:219-223`).

**Consumers:** `MedicalSopEngine.run` (invokes `guardrails.evaluate(userPrompt, {})` at `src/medical/engine.ts:253`, dispatches a new refuse verdict alongside the existing short-circuit/allow handling); the `bober medical` CLI (`src/cli/commands/medical.ts`, registered at `src/cli/index.ts:40,317`) as the WHOOP sync trigger; `IngestionNormalizer` + `StoreObservationSink` → `HealthDataStore.upsertObservations` (`src/medical/ingestion.ts:16-32`, `src/medical/health-store.ts:155-175`) as the WHOOP destination; the append-only `AuditLog`.

**Success Criteria:**
- A `{kind:"refuse"}` verdict is emitted by `MedicalGuardrails.evaluate` AND a `"refuse"` audit entry (IDs/enums only) is written for each defined disallowed category (prescriptions / specific-dosing / individualized-treatment-plans), with 0 LLM calls before the refusal — assertable by a spy LLMClient never invoked (precedent: the red-flag spy assertion at `src/medical/engine.ts:53-56`).
- WHOOP recovery/sleep/cycle/workout records land as `HealthObservation` rows in `health_observations` via deterministic dedup, requiring only a NEW class (no `IngestionAdapter` interface change) and zero changes to base ADR-4 storage.
- Default outbound bytes for WHOOP = 0: a new device-connection egress axis defaults false, enforced by BOTH the ESLint import boundary AND a runtime `EgressGuard.assertAllowed` before any WHOOP HTTP.
- Enabling the WHOOP axis does NOT enable `cloud-inference` or `literature-retrieval`, and vice versa.
- Apple Health scope is bounded: the file-import path already satisfies ingestion; no live Apple connection is in scope (no public third-party Apple Health export API).

**Locked Dependencies:** `IngestionAdapter`/`ObservationSink`/`IngestionNormalizer` interfaces (`src/medical/types.ts:200-213`, `src/medical/ingestion.ts:39-64`) — extend by registering a new class, never altering the interfaces (base ADR-4). `HealthDataStore` schema + deterministic `observationId` (`src/medical/health-store.ts:32-42,118-148`). `EgressGuard` axis independence + `assertAllowed` throw-on-disallowed (`src/medical/egress.ts:17-45`, base ADR-6) and the scoped ESLint boundary (`eslint.config.js:74-106`). `GuardrailVerdict`/`GuardrailContext`/`GuardrailSet` + the `"refuse"` audit event (`src/medical/types.ts:11-28,64-87`). The zero-arg `MedicalSopEngine` constructor and gate ordering (`src/medical/engine.ts:191-289`). Provider-agnostic credentials from `process.env` (`src/providers/factory.ts:96,106,117-119,132`) — NOT a new in-tree secret store. The FFDCA §201(h) shipping/marketing gate is an EXTERNAL release-gating process tracked in `arch-20260616-medical-team-architecture.md`, out of scope for this engineering work.

---

## System Overview

This work builds on the base medical team (`arch-20260616-medical-team`) and extends it additively without contradicting base ADRs 1-7. The WHOOP device-connection is realized as a `WhoopSyncAdapter` whose entry point is a network `sync(window, sink)` rather than the file-path-shaped `IngestionAdapter.ingest`; it pulls v2 records through `WhoopClient` — the single new ESLint-excepted network file — and writes `HealthObservation[]` into the existing `ObservationSink`, reusing the bounded-batch backpressure, the `HealthDataStore`, and the content-derived `INSERT OR IGNORE` dedup unchanged. All WHOOP egress is gated by a new third `EgressGuard` axis `"device-connection"` (default false), enforced both at the import boundary (ESLint) and at runtime (`assertAllowed` before any HTTP), preserving base ADR-6's per-purpose independent opt-in. OAuth credentials come from `process.env` and the offline-scope refresh token persists in a 0600 sidecar via `WhoopTokenStore`, separate from the transport.

The code-enforced refusal closes the non-emergency content-policy gap: `MedicalGuardrails.evaluate` runs the existing `RedFlagDetector` first (emergency short-circuit), then a new deterministic `RefusalDetector` sibling, emitting the already-defined `{kind:"refuse"}` verdict with fixed never-model-generated reason text for prescription / specific-dosing / individualized-treatment-plan requests. `MedicalSopEngine.run` dispatches the refuse verdict on a branch mirroring the consent-refuse path — writing a `"refuse"` audit entry (IDs/enums only) and reaching no numerics, retrieval, or LLM. Apple Health needs no new code; its offline SAX file-import path is the connection.

---

## Component Breakdown

### WhoopClient
**Responsibility:** Perform OAuth2 token exchange/refresh and paginated, rate-limited fetches against the external WHOOP v2 API as the single new ESLint-excepted network file in `src/medical/`.
```typescript
// FILE: src/medical/whoop/whoop-client.ts — the SECOND ESLint network-exception file (sibling to retrieval/medline-source.ts).
// Calls EgressGuard.assertAllowed("device-connection") BEFORE any HTTP (runtime defense-in-depth over the lint boundary).
interface WhoopClient {
  ensureAccessToken(): Promise<string>; // offline-scope refresh_token grant against api.prod.whoop.com
  fetchPage(collection: WhoopCollection, window: SyncWindow, cursor?: string): Promise<WhoopPage>; // honours 100/min + 10k/day
}
type WhoopCollection = "recovery" | "sleep" | "cycle" | "workout"; // /v2/recovery, /v2/activity/sleep, /v2/cycle, /v2/activity/workout
type SyncWindow = { startIso: string; endIso: string };
type WhoopPage = { records: WhoopRecord[]; nextCursor?: string }; // nextCursor undefined ⇒ no further pages
type WhoopRecord = { id: string; tStartIso: string; tEndIso?: string; metrics: Record<string, number> };
// Injectable transport mirrors retrieval/medline-source.ts:FetchLike so tests never hit the network.
type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
  Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;
```
**Dependencies:** [EgressGuard, WhoopTokenStore]

---

### WhoopTokenStore
**Responsibility:** Load WHOOP OAuth client credentials from `process.env` and persist/read the long-lived refresh token at `.bober/medical/whoop-token.json` with mode 0600.
```typescript
// Client id/secret via process.env (WHOOP_CLIENT_ID / WHOOP_CLIENT_SECRET) — mirrors src/providers/factory.ts:96-136.
// Token-at-rest sidecar mirrors AuditLog/ConsentGate (.bober/medical/, 0600) — no new secret store (ADR-2).
interface WhoopTokenStore {
  clientCredentials(): { clientId: string; clientSecret: string };   // throws if env vars unset
  readRefreshToken(): Promise<string | undefined>;                   // undefined ⇒ not yet authorized
  writeTokens(tokens: { accessToken: string; refreshToken: string; expiresAtIso: string }): Promise<void>; // 0600
}
```
**Dependencies:** []

---

### WhoopSyncAdapter
**Responsibility:** Pull WHOOP v2 records via `WhoopClient`, map each to `HealthObservation[]`, and feed the existing `ObservationSink` in bounded batches, returning an `IngestionResult`.
```typescript
// Does NOT implement IngestionAdapter (that contract is file-path-shaped, ADR-1). Entry point is a network sync(window).
// Reuses the EXISTING sink/store/dedup unchanged: writeBatch backpressure + INSERT OR IGNORE on
// SHA-256(metric|tStart|source|value) with source="whoop" (src/medical/health-store.ts:32-42,155-175).
interface WhoopSyncAdapter {
  readonly source: "whoop";
  sync(window: SyncWindow, sink: ObservationSink): Promise<IngestionResult>; // { recordsParsed, newRows }
}
// Reused verbatim from src/medical/types.ts:200-202 — NOT redefined here:
// interface ObservationSink { writeBatch(obs: HealthObservation[], labs: LabResult[]): Promise<void>; }
```
**Dependencies:** [WhoopClient, ObservationSink, HealthDataStore]

---

### EgressGuard (extended — third axis)
**Responsibility:** Gate outbound network on three independently opt-in axes (cloud-inference, literature-retrieval, device-connection), all default false, throwing when an axis is not opted in.
```typescript
// ADDITIVE: extend the union + constructor + fromConfig; isAllowed/assertAllowed switch handles all three exhaustively.
// Independence invariant preserved: enabling one never enables another.
type EgressAxis = "cloud-inference" | "literature-retrieval" | "device-connection"; // was 2 (src/medical/egress.ts:5)
interface EgressGuard {
  isAllowed(axis: EgressAxis): boolean;
  assertAllowed(axis: EgressAxis): void; // throws `Egress axis 'device-connection' not enabled`
  // static fromConfig(config: BoberConfig): EgressGuard — reads med?.egress?.deviceConnection ?? false
}
// config: BoberConfigSchema.medical.egress gains `deviceConnection: z.boolean().default(false)` (src/config/schema.ts:378-385).
```
**Dependencies:** []

---

### RefusalDetector
**Responsibility:** Detect non-emergency disallowed request categories (prescription, specific-dosing, individualized-treatment-plan) deterministically and synchronously from the prompt string alone.
```typescript
// Pure + synchronous sibling to RedFlagDetector (src/medical/red-flag.ts:195-212): NO async/fs/network/LLM.
// Versioned patternset for the audit log. Identical input ⇒ identical output.
type RefusalCategory = "prescription" | "specific-dosing" | "individualized-treatment-plan" | "none";
interface RefusalDetector {
  detect(prompt: string): RefusalMatch;  // { category, ruleId? }
  readonly patternsetVersion: string;    // e.g. "refusal-2026.06.17"
}
type RefusalMatch = { category: RefusalCategory; ruleId?: string };
```
**Dependencies:** []

---

### MedicalGuardrails (extended — emits refuse)
**Responsibility:** Evaluate a prompt to allow / short-circuit (red-flag) / refuse (non-emergency disallowed) with zero LLM calls, running the red-flag check first then the refusal check.
```typescript
// Unchanged signature (src/medical/types.ts:25-28); behavior extended at src/medical/guardrails.ts:80-98.
// Order: empty-check → RedFlagDetector.detect (short-circuit) → RefusalDetector.detect (refuse) → allow.
// reason text is FIXED + never model-generated (mirrors canned escalation strings guardrails.ts:30-39).
interface GuardrailSet {
  evaluate(prompt: string, ctx: GuardrailContext): GuardrailVerdict; // may now return { kind:"refuse", rule, reason }
  readonly rulesetVersion: string;
}
// GuardrailVerdict already includes { kind:"refuse"; rule:string; reason:string } (src/medical/types.ts:14) — no type change.
// GuardrailContext STAYS EMPTY (ADR-3): the prompt string suffices, exactly like RedFlagDetector.
```
**Dependencies:** [RedFlagDetector, RefusalDetector]

---

### MedicalSopEngine (extended — refuse dispatch)
**Responsibility:** Add a refuse-verdict dispatch branch to the existing gate sequence that returns the canned refusal as a `MedicalAnswer` and writes a `"refuse"` audit entry with zero downstream numerics/retrieval/LLM.
```typescript
// Unchanged run() signature + zero-arg constructor (src/medical/engine.ts:191-201).
// New branch sits AFTER the short-circuit branch (engine.ts:255-289), MIRRORING the consent-refuse path
// (engine.ts:217-248): zero downstream calls, shortCircuit:true, audit event "refuse" with ruleId only.
class MedicalSopEngine implements PipelineEngine {
  readonly name: "medical-sop";
  run(userPrompt: string, projectRoot: string, config: BoberConfig, opts?: { runId?: string; now?: string }): Promise<PipelineResult>;
}
// On verdict.kind==="refuse": auditLog.append({ tIso: now, event:"refuse", ruleId: verdict.rule, rulesetVersion, patternsetVersion });
```
**Dependencies:** [GuardrailSet, AuditLog, DisclaimerComposer, ConsentGate]

---

### medical whoop CLI subcommand
**Responsibility:** Provide `bober medical whoop sync [--since <iso>]` that wires `EgressGuard` + `WhoopTokenStore` + `WhoopClient` + `WhoopSyncAdapter` + `StoreObservationSink` + `HealthDataStore` and prints the `IngestionResult`.
```typescript
// Mirrors registerMedicalCommand / `medical import <file>` (src/cli/commands/medical.ts:30-72): build sink+store,
// run sync, print recordsParsed/newRows, store.close() in finally, set process.exitCode on error (never throw).
function registerMedicalWhoopSync(medicalCmd: Command): void; // adds `.command("whoop")` → `.command("sync")`
// Action: EgressGuard.fromConfig(config).assertAllowed("device-connection") surfaces a clear "not enabled" error if
// the user has not opted in; otherwise sync the default window (e.g. last 7 days, or --since).
```
**Dependencies:** [WhoopSyncAdapter, WhoopClient, WhoopTokenStore, EgressGuard, HealthDataStore]

---

## Data Model

```typescript
// Reused unchanged from the base architecture (src/medical/types.ts); source="whoop" for synced rows:
type HealthObservation = {
  id?: string;     // deterministic SHA-256(metric|tStart|source|value)
  metric: string; value: number; unit: string;
  tStart: string;  // ISO-8601 (PARAMETER, never reads clock)
  tEnd?: string; source: string; // "whoop"
};
type GuardrailVerdict =
  | { kind: "allow" }
  | { kind: "short-circuit"; rule: string; cannedResponse: string }
  | { kind: "refuse"; rule: string; reason: string }; // now actually emitted (ADR-3)
type AuditEntry = {
  tIso: string;
  event: "consent" | "short-circuit" | "refuse" | "answer" | "abstain" | "ingest"; // "refuse" now written
  rulesetVersion?: string; patternsetVersion?: string; ruleId?: string; // IDs/enums only
};

// New to this architecture:
type WhoopTokenFile = { accessToken: string; refreshToken: string; expiresAtIso: string }; // .bober/medical/whoop-token.json, 0600
type RefusalMatch = { category: "prescription" | "specific-dosing" | "individualized-treatment-plan" | "none"; ruleId?: string };
```

---

## API Contracts

| Method | Input | Output | Error Cases |
|--------|-------|--------|-------------|
| `medical whoop sync` (CLI) | `--since?` ISO | prints `IngestionResult`; exitCode 0/1 | axis off ⇒ clear "not enabled" + exitCode 1; env unset ⇒ "set WHOOP_CLIENT_ID/SECRET" + exitCode 1; no refresh token ⇒ "authorize first" + exitCode 1; never throws (`medical.ts:69-73`) |
| `EgressGuard.assertAllowed` | `EgressAxis` | `void` | Throws `Egress axis 'device-connection' not enabled` when axis false |
| `WhoopTokenStore.clientCredentials` | — | `{ clientId, clientSecret }` | Throws if `WHOOP_CLIENT_ID` or `WHOOP_CLIENT_SECRET` unset |
| `WhoopTokenStore.readRefreshToken` | — | `string \| undefined` | undefined ⇒ not yet authorized (no throw); throws only on unreadable non-absent file |
| `WhoopTokenStore.writeTokens` | tokens | `Promise<void>` (0600) | Throws on filesystem error; mode forced 0600 |
| `WhoopClient.ensureAccessToken` | — | `Promise<string>` | 401/invalid_grant on refresh ⇒ throw "re-authorize"; network error ⇒ throw (sync aborts, store uncorrupted) |
| `WhoopClient.fetchPage` | collection, window, cursor? | `Promise<WhoopPage>` | 401 ⇒ refresh + retry ONCE then throw; 429 ⇒ await Reset-header seconds + retry; 5xx/network ⇒ throw (abort, no partial corruption); malformed JSON ⇒ throw |
| `ObservationSink.writeBatch` | obs[], labs[] | `Promise<void>` | Propagates store error (per-batch transaction rolls back that batch only) |
| `HealthDataStore.upsertObservations` | `HealthObservation[]` | `number` (new rows) | INSERT OR IGNORE ⇒ duplicates silently 0; per-batch transaction (`health-store.ts:163-174`) |
| `GuardrailSet.evaluate` | prompt, ctx | `GuardrailVerdict` | Throws on empty/whitespace prompt (`guardrails.ts:81-83`); never throws on a refuse match |
| `RefusalDetector.detect` | prompt | `RefusalMatch` | None (pure; returns `none` on no match) |
| `AuditLog.append` | `AuditEntry` (`event:"refuse"`) | `Promise<void>` | Throws on filesystem error; entry holds IDs/enums only |

---

## Integration Strategy

### Data Flow

```
(1) WHOOP sync (pull-based, on-demand CLI — approved assumption #2):
bober medical whoop sync [--since <iso>]
  → EgressGuard.fromConfig(config).assertAllowed("device-connection") ... GATE (throws if axis off)
  → WhoopTokenStore.clientCredentials() ............................. throws if WHOOP_CLIENT_ID/SECRET unset
  → WhoopTokenStore.readRefreshToken() .............................. undefined ⇒ print 'authorize first', exit
  → WhoopClient.ensureAccessToken() ................................. offline-scope refresh_token grant
  for each collection in [recovery, sleep, cycle, workout]:
    cursor = undefined
    do:
      → WhoopClient.fetchPage(collection, window, cursor) ........... 401→refresh+retry once; 429→wait Reset header
      → map WhoopRecord[] → HealthObservation[] (source="whoop", metric per collection field, unit fixed)
      → ObservationSink.writeBatch(obs, []) ........................ StoreObservationSink, bounded batch
        → HealthDataStore.upsertObservations(obs) .................. INSERT OR IGNORE on SHA-256; returns NEW-row count
      cursor = page.nextCursor
    while cursor !== undefined
  → print IngestionResult { recordsParsed, newRows }; HealthDataStore.close() in finally
  (FIRST + ONLY network egress in this flow; NO LLM, NO literature retrieval)

(2) Refuse (non-emergency disallowed) inside MedicalSopEngine.run:
MedicalSopEngine.run(userPrompt, projectRoot, config, opts)
  → ConsentGate.hasConsent() ........................................ GATE 1 (fail-closed; absent ⇒ consent refuse, engine.ts:217-248)
  → GuardrailSet.evaluate(userPrompt, {})
      → RedFlagDetector.detect(userPrompt) ⇒ category 'none' ........ (a match here short-circuits instead, engine.ts:255-289)
      → RefusalDetector.detect(userPrompt) ⇒ { category, ruleId }
      → returns { kind:"refuse", rule: ruleId, reason: <FIXED canned text, never model-generated> }
  → refuse branch (mirrors consent-refuse path engine.ts:217-248):
      → AuditLog.append({ tIso: now, event:"refuse", ruleId, rulesetVersion, patternsetVersion }) ... IDs/enums only
      → return MedicalAnswer { body: reason, abstained:false, citations:[], disclaimerFooter, shortCircuit:true }
  (NumericsQueryLayer / FactStore / LiteratureRetriever / LLM NEVER reached — 0 LLM, 0 egress)
```

### Consistency Model

Mixed, all local. **WHOOP observations** — source of truth is the `health_observations` table keyed on content-derived SHA-256(metric|tStart|source|value) with `source="whoop"` (`health-store.ts:32-42`); each `writeBatch` is atomic (per-batch transaction, `health-store.ts:163-174`), but a multi-page/multi-collection sync is eventual-and-resumable: re-running re-pulls overlapping records and `INSERT OR IGNORE` makes it idempotent (ADR-4). **Token store** — source of truth is `.bober/medical/whoop-token.json`, last-write-wins under a single-writer assumption (one sync at a time); `expiresAtIso` governs proactive refresh. **Refuse audit** — append-only `audit-<date>.jsonl`, IDs/enums only, strongly ordered within the single-process append (`audit.ts:44-58`). No cross-store transaction spans observations + token + audit; each is independently consistent.

### External Dependencies

| Service | Used By | Failure Mode | Fallback |
|---------|---------|--------------|----------|
| WHOOP v2 API (`api.prod.whoop.com`) | WhoopClient | 401 (token expired) | Refresh access token + retry once; on refresh failure abort with "re-authorize" |
| WHOOP v2 API | WhoopClient | 429 (rate limit) | Await Reset-header seconds, then retry — never busy-loop |
| WHOOP v2 API | WhoopClient | 5xx / network unreachable | Abort sync; committed batches valid; store NEVER partially corrupted (fail-closed); re-run is idempotent |
| WHOOP OAuth token endpoint | WhoopClient / WhoopTokenStore | invalid_grant (refresh revoked) | Surface "re-authorize"; do not write a bad token; leave store intact |
| Local filesystem (`.bober/medical/`) | WhoopTokenStore, AuditLog, HealthDataStore | Write error / permission | Throw; CLI sets exitCode 1; no silent data loss |

---

## Architecture Decision Records

- [ADR-1: WHOOP device-connection as a sink-feeding network adapter behind a new third egress axis](.bober/architecture/arch-20260617-medical-team-whoop-guardrails-adr-1.md)
- [ADR-2: WHOOP OAuth credentials via process.env; refresh token in a 0600 sidecar, separate from the transport](.bober/architecture/arch-20260617-medical-team-whoop-guardrails-adr-2.md)
- [ADR-3: RefusalDetector as a separate deterministic sibling to RedFlagDetector; GuardrailContext stays empty](.bober/architecture/arch-20260617-medical-team-whoop-guardrails-adr-3.md)
- [ADR-4: Partial-sync atomicity via idempotent resume on content-derived dedup, not a cross-batch transaction](.bober/architecture/arch-20260617-medical-team-whoop-guardrails-adr-4.md)

---

## Risk Assessment

| Risk | Severity | Owner | Mitigation |
|------|----------|-------|------------|
| Egress-axis bypass (WHOOP HTTP reached with axis off) | critical | WhoopClient / EgressGuard | `assertAllowed("device-connection")` in WhoopClient BEFORE any HTTP AND the CLI re-asserts before constructing the client; ESLint network-import ban confines all WHOOP HTTP to the one excepted file |
| WHOOP 429 rate-limit (100/min, 10k/day) trips mid-sync | high | WhoopClient | `fetchPage` reads the Reset header (seconds), awaits it, retries; pagination loop paces requests under 100/min |
| OAuth access-token expiry mid-pagination (refresh race) | high | WhoopClient / WhoopTokenStore | `ensureAccessToken` refreshes proactively near `expiresAtIso`; a 401 triggers exactly one refresh-then-retry; single-writer sync avoids concurrent-refresh races; new token persisted before continuing |
| WHOOP in-place record mutation vs content-derived dedup ⇒ double-count | high | WhoopSyncAdapter / HealthDataStore | Tracked as Open Question; if observed, add a UUID-keyed upsert path (touches base ADR-4 storage) |
| Refuse false-negative (novel phrasing returns `none`) | high | RefusalDetector | Conservative versioned patternset; a miss falls through to the normal abstaining path, never to confident advice; NEVER an LLM filter (research REFUTED) |
| Partial-sync failure mid-pagination | medium | WhoopSyncAdapter | Committed batches valid (per-batch atomic); re-run idempotent via INSERT OR IGNORE — no corruption, no manual cleanup (ADR-4) |
| Plaintext refresh token at rest | medium | WhoopTokenStore | `whoop-token.json` written 0600 in the 0700 `.bober/medical` dir; acceptable for a single self-responsible user (ADR-2); keychain only if multi-user |
| Refresh token revoked/expired (offline scope lost) | medium | WhoopClient | 401/invalid_grant surfaces "re-authorize" and aborts without touching the store |
| WHOOP env credentials unset at sync time | low | WhoopTokenStore / CLI | `clientCredentials()` throws a clear message; CLI catches and sets exitCode 1 (never throws) |
| WHOOP metric→unit mapping drift (heterogeneous units) | low | WhoopSyncAdapter | Each collection maps to a fixed metric + fixed unit; NumericsQueryLayer already refuses cross-unit aggregation, so a mismatch abstains rather than miscomputes |

---

## Open Questions

- **WHOOP in-place record mutation vs content-derived dedup:** WHOOP v2 records are assumed append-only; the dedup key is content-derived SHA-256 (`health-store.ts:32-42`). Assumption: records are not edited in place. If wrong, an edited record yields a new id and a second row, double-counting a time-series — the fallback is a UUID-keyed upsert path, which would touch base ADR-4 storage.
- **Large-window re-pull approaching 10k/day:** Idempotent resume (ADR-4) re-fetches overlapping pages on retry. Assumption: on-demand single-user syncs with a `--since` window stay well under 10,000 req/day. If wrong (very large windows + frequent failures), the fallback is a persisted per-collection sync cursor/checkpoint (ADR-4 Option C).
- **Plaintext refresh token at rest:** The offline-scope refresh token is stored 0600 plaintext (ADR-2). Assumption: a single self-responsible user on a personal, non-shared machine. If wrong (shared host or multi-user), the fallback is OS keychain integration (ADR-2 Option C).
- **FFDCA §201(h) shipping/marketing gate:** Out of scope for this engineering work — an external release-gating process tracked in `arch-20260616-medical-team-architecture.md`, not a buildable component here.
