/**
 * Incident artifact type definitions (Sprint 19).
 *
 * All types are derived from zod schemas via z.infer — never written by hand
 * to avoid schema/type drift. Follow the pattern established in src/config/schema.ts.
 *
 * Schema locks (do NOT change without updating the corresponding skill):
 * - ObservationEntry: 5 fields locked by skills/bober.diagnose/SKILL.md lines 74-82.
 * - RunbookExecutionEntry: 7 camelCase fields locked by skills/bober.runbook/SKILL.md line 208.
 * - ChangeEntry.inverse: REQUIRED at zod level (not optional) — Sprint 21 rollback
 *   awareness depends on every change having an inverse declared at write time.
 */

import { z } from "zod";

// ── IncidentId ─────────────────────────────────────────────────────────────────

export type IncidentId = string;

// ── IncidentArtifactKind ───────────────────────────────────────────────────────

export const IncidentArtifactKindSchema = z.enum([
  "timeline",
  "observation",
  "hypothesis",
  "action",
  "change",
  "runbook-execution",
  "diagnosis",
  "postmortem",
]);
export type IncidentArtifactKind = z.infer<typeof IncidentArtifactKindSchema>;

// ── TimelineEvent ──────────────────────────────────────────────────────────────

export const TimelineEventSchema = z.object({
  /** ISO-8601 timestamp. */
  timestamp: z.string(),
  /** Machine-readable event kind, e.g. 'incident_created', 'action_taken'. */
  eventKind: z.string(),
  /** Which system produced this event. */
  source: z.enum(["diagnoser", "deployer", "human", "observability", "system"]),
  /** Human-readable summary of what happened. */
  summary: z.string(),
  /** Optional relative path to the detail artifact (e.g. actions.jsonl). */
  refPath: z.string().optional(),
});
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;

// ── ObservationEntry ───────────────────────────────────────────────────────────
// Shape locked by skills/bober.diagnose/SKILL.md lines 74-82 (5 fields).

export const ObservationEntrySchema = z.object({
  timestamp: z.string(),
  /** Diagnosis phase: 1–4. */
  phase: z.number().int().min(1).max(4),
  observation: z.string(),
  source: z.string(),
  verified: z.boolean(),
});
export type ObservationEntry = z.infer<typeof ObservationEntrySchema>;

// ── ActionEntry ────────────────────────────────────────────────────────────────

export const ActionEntrySchema = z.object({
  timestamp: z.string(),
  action: z.string(),
  blastRadius: z.enum(["safe", "risky"]),
  requiresApproval: z.boolean(),
  rationale: z.string().optional(),
});
export type ActionEntry = z.infer<typeof ActionEntrySchema>;

// ── ChangeEntry ────────────────────────────────────────────────────────────────
// inverse is REQUIRED — NOT .optional(). Sprint 21 rollback awareness relies on
// every change having a declared inverse at write time.

export const ChangeEntrySchema = z.object({
  id: z.string(),
  type: z.string(),
  executedAt: z.string(),
  description: z.string(),
  /** REQUIRED. Describes how to undo this change. */
  inverse: z.object({
    description: z.string(),
    command: z.string().optional(),
  }),
  status: z.enum(["pending", "executed", "rolled-back", "rolled-back-failed", "failed"]),
});
export type ChangeEntry = z.infer<typeof ChangeEntrySchema>;

// ── RunbookExecutionEntry ──────────────────────────────────────────────────────
// 7 camelCase fields locked by skills/bober.runbook/SKILL.md line 208.
// Do NOT rename fields (e.g. step_number vs stepNumber causes schema drift).

export const RunbookExecutionEntrySchema = z.object({
  timestamp: z.string(),
  runbookName: z.string(),
  stepNumber: z.number().int().min(1),
  status: z.enum([
    "precondition_failed",
    "checkpoint_rejected",
    "execution_failed",
    "postcondition_failed_no_rollback",
    "rollback_failed",
    "recovered_via_rollback",
    "success",
  ]),
  preconditionResult: z.enum(["pass", "fail", "not_run"]),
  postconditionResult: z.enum(["pass", "fail", "not_run"]),
  rollbackTriggered: z.boolean().optional(),
});
export type RunbookExecutionEntry = z.infer<typeof RunbookExecutionEntrySchema>;

// ── IncidentStatus / IncidentMetadata ─────────────────────────────────────────

export const IncidentStatusSchema = z.enum([
  "investigating",
  "remediating",
  "monitoring",
  "resolved",
  "aborted",
]);
export type IncidentStatus = z.infer<typeof IncidentStatusSchema>;

/**
 * Allowed phase transitions for the incident state machine (Sprint 24).
 * Keys are the FROM phase; values are the array of allowed TO phases.
 *
 * The re-open path (resolved → investigating) requires an explicit `reason`
 * — see transitionPhase() in src/incident/orchestrator.ts.
 *
 * `aborted` is terminal: it appears as a value in many keys (any phase may
 * abort) but never as a key — there are no transitions out of aborted.
 */
export const STATUS_TRANSITIONS: Readonly<Record<IncidentStatus, readonly IncidentStatus[]>> = {
  investigating: ["remediating", "resolved", "aborted"],
  remediating:   ["monitoring", "investigating", "aborted"], // self-loop or back to invest. on rollback
  monitoring:    ["resolved", "investigating", "aborted"],   // verifyResolution fail → back to invest.
  resolved:      ["investigating"],                          // re-open path; reason REQUIRED
  aborted:       [],                                         // terminal
} as const;

/** Convenience alias — orchestrator.ts uses 'phase' nomenclature; storage uses 'status'. */
export type IncidentPhase = IncidentStatus;

/**
 * Snapshot of the VerifyResult that authorized the 'resolved' transition.
 * Either verified=true OR an overrideToken with a non-empty reason. Sprint 22.
 */
export const IncidentResolutionEvidenceSchema = z.object({
  verified: z.boolean(),
  observedValue: z.number().optional(),
  sampledAt: z.string().optional(),
  evidencePath: z.string().optional(),
  reason: z.string().optional(),
  hint: z.string().optional(),
  /** Set when transition was authorized via overrideToken. */
  override: z.object({
    reason: z.string().min(1, "override reason is required"),
    at: z.string(),
  }).optional(),
});
export type IncidentResolutionEvidence = z.infer<typeof IncidentResolutionEvidenceSchema>;

export const IncidentMetadataSchema = z.object({
  incidentId: z.string(),
  symptom: z.string(),
  createdAt: z.string(),
  status: IncidentStatusSchema,
  severity: z.enum(["S1", "S2", "S3", "S4"]).optional(), // ← Sprint 24
  resolvedAt: z.string().optional(),
  resolutionCriteria: z.string().optional(),
  resolutionEvidence: IncidentResolutionEvidenceSchema.optional(), // ← Sprint 22
  postmortemPath: z.string().optional(),
});
export type IncidentMetadata = z.infer<typeof IncidentMetadataSchema>;

// ── IncidentSummary ────────────────────────────────────────────────────────────
// Returned by listIncidents() — a subset of IncidentMetadata.

export interface IncidentSummary {
  incidentId: string;
  symptom: string;
  createdAt: string;
  status: IncidentStatus;
  resolvedAt?: string;
}

// ── PostmortemResult (Sprint 23) ───────────────────────────────────────────────
// Return type of generatePostmortem() in src/incident/postmortem.ts.

export const PostmortemResultSchema = z.object({
  /** Absolute path to the written postmortem.md */
  path: z.string(),
  /** The full markdown content (caller can stream to stdout for CLI show) */
  content: z.string(),
  /** Number of secret-like strings redacted from artifacts during synthesis */
  redactionCount: z.number().int().min(0),
  /** True if 5-Whys synthesis produced fewer than 3 deterministic levels */
  shallowWarning: z.boolean(),
  /** Number of inline citations in the generated markdown */
  citationCount: z.number().int().min(0),
});
export type PostmortemResult = z.infer<typeof PostmortemResultSchema>;
