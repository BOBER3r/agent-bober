/**
 * Medical team shared data types (Phase 6, Sprint 1).
 *
 * Defines the type surface for the medical-sop pipeline.
 * No execution logic lives here — real enforcement lands in S2/S3/S6.
 */

// ── Guardrail verdict ───────────────────────────────────────────────

/** Discriminated union returned by GuardrailSet.evaluate. */
export type GuardrailVerdict =
  | { kind: "allow" }
  | { kind: "short-circuit"; rule: string; cannedResponse: string }
  | { kind: "refuse"; rule: string; reason: string };

// ── Guardrail context + set ─────────────────────────────────────────

/** Context passed to GuardrailSet.evaluate. Real fields land in S3. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface GuardrailContext {
  /* placeholder — real fields land in S3 */
}

/** Interface for a rule set that guards medical prompts before LLM call. */
export interface GuardrailSet {
  evaluate(prompt: string, ctx: GuardrailContext): GuardrailVerdict;
  readonly rulesetVersion: string;
}

// ── Medical answer ──────────────────────────────────────────────────

/** Literature citation shape — source URL + title for a retrieved MedlinePlus passage (S7). */
export interface Citation {
  title: string;
  url: string;
  source: "medlineplus";
}

/** Shape of the medical engine answer. Real population lands in S2/S6. */
export interface MedicalAnswer {
  body: string;
  abstained: boolean;
  citations: Citation[];
  disclaimerFooter: string;
  shortCircuit: boolean;
}

// ── Consent record ──────────────────────────────────────────────────

/**
 * Persisted consent record stored at .bober/medical/consent.json.
 * All timestamps are injected ISO 8601 strings — never wall-clock reads.
 */
export interface ConsentRecord {
  consentVersion: string;
  /** ISO 8601; INJECTED parameter — never Date.now(). */
  acceptedAtIso: string;
  rulesetVersion: string;
  disclaimerVersion: string;
}

// ── Audit log ───────────────────────────────────────────────────────

/** Discriminated audit event type. IDs/enums only — no prompt text or health values. */
export type AuditEvent =
  | "consent"
  | "short-circuit"
  | "refuse"
  | "answer"
  | "abstain"
  | "ingest";

/**
 * Audit entry appended to .bober/medical/audit-<date>.jsonl.
 * ONLY IDs/enums allowed — NEVER prompt text or health values.
 */
export interface AuditEntry {
  /** ISO 8601; INJECTED parameter — never Date.now(). */
  tIso: string;
  event: AuditEvent;
  /** Optional ruleset version (populated when a guardrail runs). */
  rulesetVersion?: string;
  /** Optional patternset version (populated in S3 by RedFlagDetector). */
  patternsetVersion?: string;
  /** Optional rule ID triggering the event (IDs only — never text). */
  ruleId?: string;
}

// ── Health observations (S4) ────────────────────────────────────────

/**
 * A single time-stamped health metric observation.
 * All timestamps are ISO 8601 INJECTED parameters — the store never reads the clock.
 * id is derived deterministically from (metric|tStart|source|value) via SHA-256.
 */
export interface HealthObservation {
  /** Deterministic SHA-256 of metric|tStart|source|value; derivable, so optional on input. */
  id?: string;
  metric: string;
  value: number;
  unit: string;
  /** ISO 8601; INJECTED parameter — never Date.now(). */
  tStart: string;
  tEnd?: string;
  /** e.g. "apple-health" | "whoop" */
  source: string;
}

/**
 * A laboratory test result with reference range.
 * id is optional on input (derived from biomarker|collectedAtIso|value via SHA-256).
 */
export interface LabResult {
  id?: string;
  biomarker: string;
  value: number;
  unit: string;
  /** ISO 8601; INJECTED parameter — never Date.now(). */
  collectedAtIso: string;
  referenceLow?: number;
  referenceHigh?: number;
}

/** A stored baseline value for a metric used to compute delta/trend. */
export interface Baseline {
  metric: string;
  value: number;
  unit: string;
}

// ── Numerics (S4, ADR-3) ────────────────────────────────────────────

/**
 * Closed whitelist of numeric primitives (ADR-3).
 * Adding a computation requires extending this union (a code review event), not a model decision.
 */
export type NumericPrimitive =
  | "mean"
  | "min"
  | "max"
  | "latest"
  | "delta"
  | "slope"
  | "percentile"
  | "zscore";

/**
 * Result of a NumericsQueryLayer.getMetric() call.
 * value is null when sampleCount === 0 (empty window), cross-unit refusal, or zscore n<2.
 * sampleCount === 0 signals upstream abstention.
 */
export interface NumericResult {
  primitive: NumericPrimitive;
  /** null when sampleCount === 0 OR cross-unit refusal OR zscore n<2 */
  value: number | null;
  unit: string;
  /** 0 => upstream abstention */
  sampleCount: number;
}

/** Time window for querying a metric. */
export interface MetricWindow {
  metric: string;
  fromIso: string;
  toIso: string;
  /** Expected unit (used for abstain result labelling when window is empty). */
  unit?: string;
}

/** Trend summary for a lab biomarker series. */
export interface LabTrend {
  biomarker: string;
  sampleCount: number;
  /** Latest value; null when sampleCount === 0 (abstain). */
  latestValue: number | null;
  /** Latest unit; empty string when sampleCount === 0. */
  latestUnit: string;
  /** ISO 8601 timestamp of the most recent result; null when sampleCount === 0. */
  latestCollectedAt: string | null;
  /** Simple least-squares slope over (t,value); null when sampleCount < 2. */
  slope: number | null;
}

// ── Ingestion (S5) ──────────────────────────────────────────────────

/**
 * Result returned by IngestionAdapter.ingest / IngestionNormalizer.importFile.
 * recordsParsed: total numeric <Record> elements seen.
 * newRows: NEW rows actually inserted (dedup-aware via INSERT OR IGNORE).
 */
export interface IngestionResult {
  recordsParsed: number;
  newRows: number;
}

/**
 * Async sink that receives bounded observation batches from an adapter.
 * writeBatch is awaited by the adapter to apply backpressure before the next batch.
 */
export interface ObservationSink {
  writeBatch(obs: HealthObservation[], labs: LabResult[]): Promise<void>;
}

/**
 * Interface for a streaming health data import adapter.
 * canHandle selects the adapter; ingest streams the file into the sink.
 * Adding a new adapter (Whoop, CSV, …) only requires a new class — ADR-4 registry.
 */
export interface IngestionAdapter {
  readonly kind: string;
  canHandle(filePath: string): boolean;
  ingest(filePath: string, sink: ObservationSink): Promise<IngestionResult>;
}
