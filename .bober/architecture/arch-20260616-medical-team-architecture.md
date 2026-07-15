# Architecture: Phase 6 — The Medical Team

**Architecture ID:** arch-20260616-medical-team
**Generated:** 2026-06-16T00:00:00Z
**Status:** draft

---

## Executive Summary

This architecture adds a second domain `Team` instance to agent-bober: a local-first, conversational health/wellness team that validates the domain-agnostic `Team` abstraction on a high-stakes domain. The selected approach (ADR-1) introduces a new `"medical-sop"` `pipelineShape` with a dedicated engine running a fixed SOP (consent→red-flag-gate→numerics→retrieve→answer-with-abstention), a concrete `GuardrailSet` filling the existing `Team.guardrails` slot, an in-process whitelisted numerics layer instead of a Python sandbox, and two independently opt-in egress axes. Regulatory refusals, the emergency short-circuit, numerical reasoning, and the zero-egress default are all CODE-ENFORCED rather than prompt-only — the highest-stakes decisions never pass through an LLM. The accepted tradeoffs are a larger new component surface and a numerics layer less expressive than Pandas, in exchange for determinism, auditability, and byte-zero impact on the existing `ts|skill|workflow` engines and programming team. The primary risk is regulatory: shipping is gated on an external S6.5 counsel/regulatory review (FFDCA §201(h)) that no buildable component can satisfy.

---

## Problem Statement

**Problem:** agent-bober has no health/wellness domain team, and its domain-agnostic `Team` abstraction (`src/teams/types.ts:21`, branch `bober/team-abstraction`) has never been validated on a second high-stakes domain — the medical-specific machinery (code-execution numerics, grounded literature retrieval, code-enforced legal guardrails) does not exist anywhere in the tree.

**Constraints:**
- Latency: No numeric budget. Emergency/red-flag detection MUST short-circuit BEFORE any LLM call (0 LLM round-trips) → deterministic local check, not a model call.
- Throughput: Not specified. Single-user interactive `bober chat` session.
- Data volume: Apple Health export XML up to ~4GB → ingestion MUST stream (SAX/iterative), never load whole document. Time-series tables unbounded.
- Cost ceiling: Not a dollar figure. Local-first: zero-egress default path runs with NO paid cloud inference (local model via `openai-compat`/Ollama, `src/providers/factory.ts:128-129`); cloud is explicit opt-in.
- Backward compatibility (HARD): `Team` interface + `loadTeam` (`src/teams/registry.ts:34`); `pipelineShape` enum `ts|skill|workflow` (`src/config/schema.ts:366`) must not alter existing three; `ChatSession`/`TurnClassifier` (`chat-session.ts:87`, `turn-classifier.ts:126`); programming-team behavior byte-unaffected; memory-namespace isolation (`chat-session.ts:51-53`).
- Regulatory bright line (HARD): FFDCA §201(h) — product becomes a regulated medical device the moment intended use is diagnosis/treatment/prevention; FDA reads intent from BEHAVIOR/DESIGN, not disclaimers. GW safe harbor needs no-specific-disease + low-risk framing; CDS carve-out unavailable to consumer agents; EU MDR no wellness carve-out; IL WOPR Act bans AI-as-therapy-substitute. → Refusals CODE-ENFORCED, not prompt-only.
- Privacy (HARD): FTC §5 / WA MHMDA / proposed HIPRA / EU GDPR apply → local-first zero-egress DEFAULT, enforced in code (reuse `no-restricted-imports` from `src/telemetry/emit.ts:13`).
- Numerical reliability (HARD): LLM MUST NOT do arithmetic on time-series; all numerical reasoning is deterministic generated/whitelisted computation (PHIA ~50% error reduction). No sandbox exists (`src/graph/sandbox.ts` is a path-filter); `execa` is the subprocess precedent.
- Disclaimers (HARD): first-run consent + surfaced per-response footer.
- Engineering (HARD): ESM/`.js`/NodeNext; provider-agnostic via `LLMClient` (`src/providers/types.ts:216`); Zod config; `.bober/` JSON state; `better-sqlite3` sync (like `FactStore`); strict TS zero-error gates; `node:fs/promises`; no unjustified `any`.

**Consumers:** `bober chat medical` user; `ChatSession` + `TurnClassifier`; `loadTeam`; `semantic_facts` `FactStore` (medications under medical `scope`).

**Success Criteria:** emergency short-circuit 0 LLM calls (tested); 100% numerical answers from deterministic compute; every clinical claim cited or abstained; default outbound bytes = 0; each refusal category code-enforced + tested; consent + footer per response; local append-only audit log; adding medical team requires NO change to `Team`/`loadTeam`/programming beyond extending `pipelineShape` + typing the `guardrails` slot.

**Locked Dependencies:** `Team` model + `loadTeam`; `semantic_facts` bi-temporal schema (invalidate-don't-delete); provider-agnostic `LLMClient` + `RoleProviderMap` + Ollama path; `ChatSession`/`TurnClassifier` + namespaced distill; `better-sqlite3` + Zod + `.bober/`. S6.5 counsel review = release-gating external process dependency, NOT a buildable component.

---

## System Overview

The medical team is delivered as data, not code: `buildMedicalTeam(config)` returns a `MedicalTeam` whose `pipelineShape` is the new additive enum value `"medical-sop"` and whose `guardrails` slot holds a concrete `GuardrailSet`. A medical chat turn is routed by the unchanged `TurnClassifier` to `action: "spawn"`, launched as a detached fire-and-forget child via the existing chat spawn contract (ADR-5), and resolved inside that child by an additive `selectPipelineEngineForTeam` case to `MedicalSopEngine`. The engine runs a fixed standard-operating-procedure with three code-enforced gates that all execute before any model call: consent (fail-closed), red-flag short-circuit (0-LLM deterministic, ADR-2), and egress opt-in (ADR-6).

All numerical reasoning over health time-series flows through a closed whitelist of in-process TypeScript primitives (ADR-3) reading from a generic single-table `HealthDataStore` (ADR-4); the LLM never performs arithmetic. The single LLM call in the normal path is `LiteratureRetriever.synthesize`, which runs against the local Ollama model by default and abstains unless a retrieved passage supports the claim. Medications are the bi-temporal value-of-record in the existing `FactStore` (ADR-7), kept separate from observations. Every turn emits a consent footer and an append-only audit entry containing IDs and enums only — never prompt text or health values.

---

## Component Breakdown

### MedicalSopEngine
**Responsibility:** Orchestrate the medical SOP across all gates and produce a `MedicalAnswer`.
```typescript
class MedicalSopEngine extends PipelineEngine {
  readonly name: "medical-sop";
  run(userPrompt: string, projectRoot: string, config: BoberConfig, opts?: RunOpts): Promise<PipelineResult>;
}
```
**Dependencies:** [GuardrailSet, LiteratureRetriever, NumericsQueryLayer, DisclaimerComposer, ConsentGate, AuditLog, EgressGuard]

### GuardrailSet
**Responsibility:** Decide allow / short-circuit / refuse for a prompt with zero LLM calls.
```typescript
interface GuardrailSet {
  evaluate(prompt: string, ctx: GuardrailContext): GuardrailVerdict;
  readonly rulesetVersion: string;
}
```
**Dependencies:** [RedFlagDetector]

### RedFlagDetector
**Responsibility:** Detect acute emergency categories deterministically and synchronously.
```typescript
interface RedFlagDetector {
  detect(prompt: string): RedFlagMatch; // category: cardiac|stroke|anaphylaxis|self-harm|overdose|none
  readonly patternsetVersion: string;
}
```
**Dependencies:** []

### HealthDataStore
**Responsibility:** Persist and query generic health observation time-series.
```typescript
interface HealthDataStore {
  upsertObservations(rows: HealthObservation[]): number; // count of NEW rows (INSERT OR IGNORE)
  getObservations(metric: string, fromIso: string, toIso: string): HealthObservation[];
  getLabSeries(biomarker: string): LabResult[];
  getBaseline(metric: string): Baseline | undefined;
  putBaseline(b: Baseline): void;
  getPreference(key: string): string | undefined;
  close(): void;
}
```
**Dependencies:** []

### IngestionNormalizer
**Responsibility:** Stream-import a source file through the matching adapter into the store.
```typescript
interface IngestionNormalizer {
  importFile(filePath: string): Promise<IngestionResult>;
  register(adapter: IngestionAdapter): void;
}
interface IngestionAdapter {
  readonly kind: string;
  canHandle(filePath: string): boolean;
  ingest(filePath: string, sink: ObservationSink): Promise<IngestionResult>; // Apple Health uses SAX
}
interface ObservationSink { writeBatch(obs: HealthObservation[], labs: LabResult[]): Promise<void>; }
```
**Dependencies:** [HealthDataStore]

### NumericsQueryLayer
**Responsibility:** Compute closed-whitelist numeric primitives over observations with no eval.
```typescript
type NumericPrimitive = "mean"|"min"|"max"|"latest"|"delta"|"slope"|"percentile"|"zscore";
interface NumericsQueryLayer {
  getMetric(window: MetricWindow, primitive: NumericPrimitive): NumericResult; // sampleCount 0 ⇒ abstain
  getLabTrend(biomarker: string): LabTrend;
}
```
**Dependencies:** [HealthDataStore]

### LiteratureRetriever
**Responsibility:** Retrieve grounding passages (network only after opt-in) and synthesize a cited or abstained answer.
```typescript
interface LiteratureRetriever {
  retrieve(query: string): Promise<RetrievalOutcome>; // disabled | abstain{reason} | grounded{passages}
  synthesize(query: string, outcome: RetrievalOutcome, llm: LLMClient): Promise<MedicalAnswer>;
}
```
**Dependencies:** [EgressGuard]

### EgressGuard
**Responsibility:** Gate outbound network on two independently opt-in axes, throwing when not allowed.
```typescript
type EgressAxis = "cloud-inference" | "literature-retrieval"; // both default false
interface EgressGuard {
  isAllowed(axis: EgressAxis): boolean;
  assertAllowed(axis: EgressAxis): void; // throws if not opted in
}
```
**Dependencies:** []

### ConsentGate
**Responsibility:** Enforce fail-closed first-run consent and expose the recorded consent.
```typescript
interface ConsentGate {
  hasConsent(): boolean;
  recordConsent(record: ConsentRecord): void;
  current(): ConsentRecord | undefined;
}
```
**Dependencies:** [AuditLog]

### AuditLog
**Responsibility:** Append IDs-and-enums-only entries to a per-day append-only log file.
```typescript
interface AuditLog {
  append(entry: AuditEntry): Promise<void>; // .bober/medical/audit-<date>.jsonl, O_APPEND|O_CREAT, 0600
}
```
**Dependencies:** []

### DisclaimerComposer
**Responsibility:** Produce the versioned per-response disclaimer footer.
```typescript
interface DisclaimerComposer {
  footer(): string;
  readonly disclaimerVersion: string;
}
```
**Dependencies:** []

### buildMedicalTeam
**Responsibility:** Construct the `MedicalTeam` with `pipelineShape "medical-sop"` and a concrete `GuardrailSet` in the guardrails slot.
```typescript
function buildMedicalTeam(config: BoberConfig): MedicalTeam; // pipelineShape: "medical-sop"
```
**Dependencies:** [GuardrailSet, RedFlagDetector, EgressGuard]

---

## Data Model

```typescript
type HealthObservation = {
  id: string;            // deterministic SHA-256 of metric|tStart|source|value
  metric: string;
  value: number;
  unit: string;
  tStart: string;        // ISO-8601 (timestamp is a PARAMETER, never reads clock)
  tEnd?: string;
  source: string;        // e.g. "apple-health" | "whoop"
};

type LabResult = {
  id: string;
  biomarker: string;
  value: number;
  unit: string;
  collectedAtIso: string;
  referenceLow?: number;
  referenceHigh?: number;
};

type ConsentRecord = {
  consentVersion: string;
  acceptedAtIso: string;
  rulesetVersion: string;
  disclaimerVersion: string;
};

type AuditEntry = {
  tIso: string;
  event: "consent" | "short-circuit" | "refuse" | "answer" | "abstain" | "ingest";
  rulesetVersion?: string;
  patternsetVersion?: string;
  ruleId?: string;       // IDs/enums only — NEVER prompt text or health values
};

type GuardrailVerdict =
  | { kind: "allow" }
  | { kind: "short-circuit"; rule: string; cannedResponse: string }
  | { kind: "refuse"; rule: string; reason: string };

type MedicalAnswer = {
  body: string;
  abstained: boolean;
  citations: Citation[];
  disclaimerFooter: string;
  shortCircuit: boolean;
};

type NumericResult = {
  primitive: NumericPrimitive;
  value: number | null;  // null when sampleCount === 0
  unit: string;
  sampleCount: number;   // 0 ⇒ upstream abstention
};
```

---

## API Contracts

| Method | Input | Output | Error Cases |
|--------|-------|--------|-------------|
| `MedicalSopEngine.run` | `userPrompt, projectRoot, config, opts?` | `Promise<PipelineResult>` | Throws on invalid config; consent absent ⇒ refuse verdict in result |
| `GuardrailSet.evaluate` | `prompt, GuardrailContext` | `GuardrailVerdict` | Throws on empty prompt |
| `RedFlagDetector.detect` | `prompt` | `RedFlagMatch` | None (pure; returns `none`) |
| `HealthDataStore.upsertObservations` | `HealthObservation[]` | `number` (new rows) | Throws on missing required field |
| `IngestionNormalizer.importFile` | `filePath` | `Promise<IngestionResult>` | Throws if no adapter `canHandle` |
| `NumericsQueryLayer.getMetric` | `MetricWindow, NumericPrimitive` | `NumericResult` | `sampleCount: 0` ⇒ abstain (no throw) |
| `LiteratureRetriever.retrieve` | `query` | `Promise<RetrievalOutcome>` | `{disabled}` when axis off; `{abstain}` on source failure |
| `EgressGuard.assertAllowed` | `EgressAxis` | `void` | Throws if axis not opted in |
| `ConsentGate.hasConsent` | — | `boolean` | None |
| `AuditLog.append` | `AuditEntry` | `Promise<void>` | Throws on filesystem error |

---

## Integration Strategy

### Data Flow

```
(1) Normal medical chat turn:
ChatSession.handleTurn → TurnClassifier.classify {spawn}
  → RunSpawner.spawn [detached, NOT awaited] → ack immediately
  detached child: loadTeam → buildMedicalTeam
    → selectPipelineEngineForTeam case "medical-sop" → MedicalSopEngine.run
      → ConsentGate.hasConsent ............................. GATE 1 (fail-closed)
      → GuardrailSet.evaluate → RedFlagDetector.detect ..... GATE 2 (0 LLM)
      → NumericsQueryLayer.getMetric → HealthDataStore ..... (no LLM math)
      → FactStore.getActiveFacts (medications)
      → EgressGuard.isAllowed("literature-retrieval") ...... GATE 3
      → LiteratureRetriever.retrieve → synthesize .......... FIRST + ONLY LLM call (Ollama)
      → DisclaimerComposer.footer + AuditLog.append → PipelineResult
  chat sees result on later CompletionTailer.poll

(1b) SHORT-CIRCUIT: red-flag → short-circuit verdict → canned escalation;
     Numerics / Retriever / LLM NEVER reached (0 LLM, 0 egress).

(2) Ingestion: `bober medical import` → IngestionNormalizer.importFile
  → adapter.canHandle → adapter.ingest (SAX stream)
  → sink.writeBatch (bounded ~1000, pause/resume backpressure)
  → HealthDataStore.upsertObservations (INSERT OR IGNORE)
```

### Consistency Model

Mixed. Strong within each store; eventual across the chat/run process boundary. Sources of truth: `HealthDataStore` (observations, idempotent on deterministic id); `FactStore` (medications value-of-record, invalidate-don't-delete); `ConsentRecord` on disk (fail-closed); disk `state.json` (run result, eventual); audit jsonl (append-only, IDs/enums only).

### External Dependencies

| Service | Used By | Failure Mode | Fallback |
|---------|---------|--------------|----------|
| Literature source | LiteratureRetriever | Source unreachable | Abstain; never fail-open |
| OAuth vendor | LiteratureRetriever | Auth failure | Abstain |
| Ollama local model | LiteratureRetriever.synthesize | Model unavailable | Abstain + "unavailable" footer; NO auto cloud fallback |
| Cloud provider | LLMClient | — | Reachable only via `cloud-inference` opt-in |

---

## Architecture Decision Records

- [ADR-1: Medical team as new `medical-sop` pipelineShape + code-enforced guardrails + in-process numerics + opt-in retrieval egress](.bober/architecture/arch-20260616-medical-team-adr-1.md)
- [ADR-2: Red-flag gate as a pre-LLM deterministic component](.bober/architecture/arch-20260616-medical-team-adr-2.md)
- [ADR-3: In-process whitelisted numeric primitives, not generated/executed code](.bober/architecture/arch-20260616-medical-team-adr-3.md)
- [ADR-4: Generic events table for health observations, not one table per metric](.bober/architecture/arch-20260616-medical-team-adr-4.md)
- [ADR-5: Medical SOP plugs into ChatSession via the existing detached-spawn contract](.bober/architecture/arch-20260616-medical-team-adr-5.md)
- [ADR-6: Two distinct egress axes (cloud-inference, literature-retrieval) + scoped ESLint boundary](.bober/architecture/arch-20260616-medical-team-adr-6.md)
- [ADR-7: Medications value-of-record in FactStore (bi-temporal), not HealthDataStore](.bober/architecture/arch-20260616-medical-team-adr-7.md)

---

## Risk Assessment

| Risk | Severity | Owner | Mitigation |
|------|----------|-------|------------|
| Guardrail bypass (LLM reached before gates) | critical | MedicalSopEngine | All medical turns route through spawn; gates run first in `run`; lint rule forbids pre-gate LLM fast-path |
| Egress leak via transitive network import | critical | EgressGuard | Runtime `assertAllowed` at every call site (defense in depth) over static `no-restricted-imports`; CI lint gate |
| 4GB SAX ingestion blocks event loop | high | IngestionNormalizer | Streaming SAX parse + bounded ~1000-row batches with pause/resume backpressure; never loads whole document |
| Medication staleness | high | FactStore integration | Bi-temporal invalidate-don't-delete path; `getActiveFacts` reads current value-of-record only |
| New enum case unreachable / breaks switch | medium | selectPipelineEngineForTeam | Exhaustive-switch compile-time `never` check; additive branch leaves `ts\|skill\|workflow` byte-identical |
| Consent gate bypass | critical | ConsentGate | Fail-closed: absent consent ⇒ refuse; gate runs before any retrieval or LLM call |
| Abstention not triggering (confidently wrong) | high | LiteratureRetriever | Structured `abstained` flag; `synthesize` abstains unless a passage supports the claim; `sampleCount 0` forces abstain |
| team-abstraction merge dependency | high | Release coordination | `medical-sop` shape cannot land until `bober/team-abstraction` is merged; gate the branch on merge |
| No-LLM-arithmetic drift | high | NumericsQueryLayer | Closed `NumericPrimitive` whitelist; no eval/codegen; new primitives are reviewable code changes |
| Audit PHI leak | high | AuditLog | IDs/enums only — never prompt text or health values; file mode 0600, O_APPEND\|O_CREAT |
| Heterogeneous units mixed in generic table | medium | NumericsQueryLayer | Reads `unit` per row; refuses cross-unit aggregation |

---

## Open Questions

- **S6.5 counsel/regulatory review (release-gating, external):** Shipping is gated on an external FFDCA §201(h) counsel/regulatory review confirming the team's behavior/design stays within the GW safe harbor and outside device intent. Assumption: review passes given code-enforced refusals and abstention. If wrong, the team cannot ship regardless of engineering completeness — this is a process dependency, not a buildable component.
- **`bober/team-abstraction` merge dependency:** The `medical-sop` shape requires the `Team`/`loadTeam` abstraction on `bober/team-abstraction` to be merged to main first. Assumption: it merges before this branch lands. If wrong, the additive `pipelineShape` extension has no base to extend.
- **Sandbox / whitelist expressiveness limits:** The closed `NumericPrimitive` whitelist cannot express arbitrary statistics. Assumption: `mean|min|max|latest|delta|slope|percentile|zscore` covers initial use cases. If a needed computation is missing, the team abstains and the primitive is added via reviewable code change — never via runtime/generated code.
- **Literature-source selection:** The specific grounded-literature source (and any OAuth vendor) is unspecified. Assumption: a single opt-in source behind `literature-retrieval`. If the chosen source's licensing or coverage is inadequate, retrieval abstains more often than desired.
- **Cloud-inference prompt-cache economics:** Whether the opt-in `cloud-inference` axis should leverage provider prompt-caching for cost is unmodeled. Assumption: local Ollama is the default and cloud is rare opt-in, so cache economics are deferred. If cloud becomes common, caching strategy needs design.
