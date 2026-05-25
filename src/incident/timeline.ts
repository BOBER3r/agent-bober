/**
 * Incident timeline append helpers (Sprint 19).
 *
 * Every helper that writes a domain artifact (observations.jsonl,
 * actions.jsonl, changelog.jsonl, runbook-execution.jsonl) ALSO appends
 * a corresponding event to timeline.jsonl in the same mutex tick. This
 * makes "show me what happened in chronological order" a single file read.
 *
 * Append atomicity: fs.open with O_WRONLY|O_APPEND|O_CREAT plus explicit
 * fh.chmod(0o600) after open — mirrors the audit.ts pattern from Sprint 13.
 * fs.appendFile is NOT used because it does not reliably honor the mode
 * argument across all Node versions (see audit.ts header comment).
 *
 * POSIX O_APPEND atomicity: single-line records are well under PIPE_BUF
 * (4096 bytes), so cross-process appends are safe in practice.
 *
 * Concurrent appends to the same incident are serialized via a per-incidentId
 * Promise-chain mutex. Unrelated incidents proceed in parallel.
 *
 * setIncidentStatus uses atomic temp-file + rename to avoid a torn write
 * if the process crashes mid-update.
 *
 * Sprint 19 — src/incident/timeline.ts
 */

import { open, mkdir, writeFile, readdir, readFile, rename } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import {
  IncidentMetadataSchema,
  TimelineEventSchema,
  ObservationEntrySchema,
  ActionEntrySchema,
  ChangeEntrySchema,
  RunbookExecutionEntrySchema,
  type IncidentId,
  type IncidentMetadata,
  type IncidentResolutionEvidence,
  type IncidentStatus,
  type IncidentSummary,
  type TimelineEvent,
  type ObservationEntry,
  type ActionEntry,
  type ChangeEntry,
  type RunbookExecutionEntry,
} from "./types.js";
import type { VerifyResult } from "./resolution-verify.js";
import { logger } from "../utils/logger.js";

// ── Per-incidentId mutex (Promise-chain pattern) ──────────────────────────────
// One chain per incidentId so unrelated incidents proceed in parallel.
// Mirrors the per-runId mutex in src/orchestrator/checkpoints/audit.ts.

const writeChains = new Map<IncidentId, Promise<void>>();

// ── Internal: append one JSON line ────────────────────────────────────────────

/**
 * Append a single newline-terminated JSON line to `filePath`.
 *
 * The directory is created if absent. Mode 0600 is guaranteed via an
 * explicit fh.chmod() call after open — the umask may reduce the mode
 * set by the open() call itself.
 */
async function appendOneLine(filePath: string, record: unknown): Promise<void> {
  const dir = join(filePath, "..");
  await mkdir(dir, { recursive: true });

  const line = JSON.stringify(record) + "\n";

  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT;
  const fh = await open(filePath, flags, 0o600);
  try {
    // Guarantee mode 0600 even if umask would have reduced it.
    await fh.chmod(0o600);
    await fh.write(line);
  } finally {
    await fh.close();
  }
}

// ── Internal: atomic JSON rewrite via temp + rename ───────────────────────────

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  await rename(tmp, filePath);
}

// ── Internal: incident directory path ─────────────────────────────────────────

function incidentDir(projectRoot: string, incidentId: IncidentId): string {
  return join(projectRoot, ".bober", "incidents", incidentId);
}

// ── deriveSlug ─────────────────────────────────────────────────────────────────

/**
 * Derive a short kebab-case slug from a symptom string.
 *
 * Rules:
 * 1. Lowercase the input.
 * 2. Split on whitespace; take the first 3 non-empty tokens.
 * 3. For each token, strip all characters outside [a-z0-9] (unicode is stripped).
 * 4. Join surviving tokens with '-'.
 * 5. Strip leading/trailing hyphens.
 * 6. Truncate to 30 characters (hard limit).
 * 7. If the result is empty (empty input / all-punctuation / unicode-only), return 'untitled'.
 *
 * Exported for unit testing.
 */
export function deriveSlug(symptom: string): string {
  const tokens = symptom
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .slice(0, 3)
    .map((t) => t.replace(/[^a-z0-9]/g, ""))
    .filter((t) => t.length > 0);

  const slug = tokens.join("-").replace(/^-+|-+$/g, "").slice(0, 30);
  return slug.length > 0 ? slug : "untitled";
}

// ── createIncident ─────────────────────────────────────────────────────────────

/**
 * Create a new incident artifact directory with all required files.
 *
 * Layout created:
 * ```
 * .bober/incidents/<incidentId>/
 *   incident.json           — metadata (JSON)
 *   timeline.jsonl          — chronological master event log (JSONL, empty)
 *   observations.jsonl      — verified facts (JSONL, empty)
 *   actions.jsonl           — actions taken/proposed (JSONL, empty)
 *   changelog.jsonl         — deploys/config changes (JSONL, empty)
 *   runbook-execution.jsonl — runbook step results (JSONL, empty)
 *   hypotheses.md           — current hypotheses (Markdown, empty)
 *   diagnoses/              — diagnosis JSON files from bober-diagnoser
 * ```
 *
 * @param symptom  Human-readable description of the incident trigger.
 * @param projectRoot  Absolute path to the project root (caller resolves this).
 * @returns The new incident ID, e.g. 'inc-20260524-500-errors-on'.
 */
export async function createIncident(
  symptom: string,
  projectRoot: string,
): Promise<IncidentId> {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const slug = deriveSlug(symptom);
  const incidentId: IncidentId = `inc-${date}-${slug}`;

  const dir = incidentDir(projectRoot, incidentId);
  await mkdir(dir, { recursive: true });
  await mkdir(join(dir, "diagnoses"), { recursive: true });

  // Initialize empty JSONL files with mode 0600.
  const jsonlFiles = [
    "timeline.jsonl",
    "observations.jsonl",
    "actions.jsonl",
    "changelog.jsonl",
    "runbook-execution.jsonl",
  ];
  for (const fname of jsonlFiles) {
    const fpath = join(dir, fname);
    const flags = constants.O_WRONLY | constants.O_CREAT;
    const fh = await open(fpath, flags, 0o600);
    await fh.chmod(0o600);
    await fh.close();
  }

  // Initialize empty hypotheses.md with mode 0600.
  await writeFile(join(dir, "hypotheses.md"), "", { encoding: "utf-8", mode: 0o600 });

  // Write incident.json atomically.
  const now = new Date().toISOString();
  const metadata: IncidentMetadata = {
    incidentId,
    symptom,
    createdAt: now,
    status: "investigating",
  };
  await atomicWriteJson(join(dir, "incident.json"), metadata);

  // Emit initial timeline event.
  const event: TimelineEvent = {
    timestamp: now,
    eventKind: "incident_created",
    source: "system",
    summary: `Incident created: ${symptom}`,
    refPath: `.bober/incidents/${incidentId}/incident.json`,
  };
  await appendTimeline(projectRoot, incidentId, event);

  return incidentId;
}

// ── appendTimeline ─────────────────────────────────────────────────────────────

/**
 * Append a TimelineEvent to timeline.jsonl.
 *
 * This is the only append helper that writes ONLY to timeline.jsonl.
 * All other append helpers call this implicitly via the double-write pattern.
 */
export async function appendTimeline(
  projectRoot: string,
  incidentId: IncidentId,
  event: TimelineEvent,
): Promise<void> {
  TimelineEventSchema.parse(event);
  const dir = incidentDir(projectRoot, incidentId);
  const timelinePath = join(dir, "timeline.jsonl");

  const prev = writeChains.get(incidentId) ?? Promise.resolve();
  const next = prev.then(() => appendOneLine(timelinePath, event));
  writeChains.set(incidentId, next.catch(() => {}));
  return next;
}

// ── appendObservation ──────────────────────────────────────────────────────────

/**
 * Append an ObservationEntry to observations.jsonl AND emit a timeline event.
 *
 * Both writes happen inside the same mutex tick so they are ordered
 * deterministically relative to other concurrent appends on this incident.
 */
export async function appendObservation(
  projectRoot: string,
  incidentId: IncidentId,
  entry: ObservationEntry,
): Promise<void> {
  ObservationEntrySchema.parse(entry);

  const dir = incidentDir(projectRoot, incidentId);
  const obsPath = join(dir, "observations.jsonl");
  const timelinePath = join(dir, "timeline.jsonl");

  const timelineEvent: TimelineEvent = {
    timestamp: entry.timestamp,
    eventKind: "observation_recorded",
    source: "diagnoser",
    summary: entry.observation.slice(0, 200),
    refPath: `.bober/incidents/${incidentId}/observations.jsonl`,
  };

  const prev = writeChains.get(incidentId) ?? Promise.resolve();
  const next = prev.then(async () => {
    await appendOneLine(obsPath, entry);
    await appendOneLine(timelinePath, timelineEvent);
  });
  writeChains.set(incidentId, next.catch(() => {}));
  return next;
}

// ── appendAction ───────────────────────────────────────────────────────────────

/**
 * Append an ActionEntry to actions.jsonl AND emit a timeline event.
 */
export async function appendAction(
  projectRoot: string,
  incidentId: IncidentId,
  entry: ActionEntry,
): Promise<void> {
  ActionEntrySchema.parse(entry);

  const dir = incidentDir(projectRoot, incidentId);
  const actionsPath = join(dir, "actions.jsonl");
  const timelinePath = join(dir, "timeline.jsonl");

  const timelineEvent: TimelineEvent = {
    timestamp: entry.timestamp,
    eventKind: "action_taken",
    source: "human",
    summary: entry.action.slice(0, 200),
    refPath: `.bober/incidents/${incidentId}/actions.jsonl`,
  };

  const prev = writeChains.get(incidentId) ?? Promise.resolve();
  const next = prev.then(async () => {
    await appendOneLine(actionsPath, entry);
    await appendOneLine(timelinePath, timelineEvent);
  });
  writeChains.set(incidentId, next.catch(() => {}));
  return next;
}

// ── appendChange ───────────────────────────────────────────────────────────────

/**
 * Append a ChangeEntry to changelog.jsonl AND emit a timeline event.
 *
 * Throws a ZodError if `entry.inverse` is missing — the field is REQUIRED
 * at the schema level so Sprint 21 rollback awareness can always find an
 * inverse for every executed change.
 *
 * The zod validation runs BEFORE the mutex is entered so no file is
 * touched if validation fails.
 */
export async function appendChange(
  projectRoot: string,
  incidentId: IncidentId,
  entry: ChangeEntry,
): Promise<void> {
  // Validate BEFORE entering the mutex — throws ZodError if inverse is missing.
  ChangeEntrySchema.parse(entry);

  const dir = incidentDir(projectRoot, incidentId);
  const changelogPath = join(dir, "changelog.jsonl");
  const timelinePath = join(dir, "timeline.jsonl");

  const timelineEvent: TimelineEvent = {
    timestamp: entry.executedAt,
    eventKind: "change_recorded",
    source: "deployer",
    summary: entry.description.slice(0, 200),
    refPath: `.bober/incidents/${incidentId}/changelog.jsonl`,
  };

  const prev = writeChains.get(incidentId) ?? Promise.resolve();
  const next = prev.then(async () => {
    await appendOneLine(changelogPath, entry);
    await appendOneLine(timelinePath, timelineEvent);
  });
  writeChains.set(incidentId, next.catch(() => {}));
  return next;
}

// ── appendRunbookExecution ─────────────────────────────────────────────────────

/**
 * Append a RunbookExecutionEntry to runbook-execution.jsonl AND emit a
 * timeline event.
 */
export async function appendRunbookExecution(
  projectRoot: string,
  incidentId: IncidentId,
  entry: RunbookExecutionEntry,
): Promise<void> {
  RunbookExecutionEntrySchema.parse(entry);

  const dir = incidentDir(projectRoot, incidentId);
  const runbookPath = join(dir, "runbook-execution.jsonl");
  const timelinePath = join(dir, "timeline.jsonl");

  const timelineEvent: TimelineEvent = {
    timestamp: entry.timestamp,
    eventKind: "runbook_step_executed",
    source: "system",
    summary: `${entry.runbookName} step ${entry.stepNumber}: ${entry.status}`,
    refPath: `.bober/incidents/${incidentId}/runbook-execution.jsonl`,
  };

  const prev = writeChains.get(incidentId) ?? Promise.resolve();
  const next = prev.then(async () => {
    await appendOneLine(runbookPath, entry);
    await appendOneLine(timelinePath, timelineEvent);
  });
  writeChains.set(incidentId, next.catch(() => {}));
  return next;
}

// ── setIncidentStatus ──────────────────────────────────────────────────────────

/** Override token regex: prefix 'SKIP_METRIC_VERIFY:' with at least one non-whitespace char after optional spaces. */
const OVERRIDE_TOKEN_RE = /^SKIP_METRIC_VERIFY:\s*(.+)$/;

/** Options for the resolution gate (Sprint 22). */
export interface SetStatusOpts {
  /** REQUIRED when status='resolved' (unless overrideToken given). Must have verified=true. */
  verifyResult?: VerifyResult;
  /** REQUIRED when status='resolved' AND no verifyResult. Format: 'SKIP_METRIC_VERIFY: <reason>'. Empty reason rejects. */
  overrideToken?: string;
}

/**
 * Update the status field in incident.json atomically.
 *
 * If status is 'resolved', sets resolvedAt to now (ISO-8601) automatically.
 * Any additional fields in `extras` are merged in.
 *
 * Sprint 22 resolution gate: when transitioning to 'resolved', one of the
 * following MUST be provided via opts:
 *   1. opts.verifyResult with verified=true — metric verification passed.
 *   2. opts.overrideToken matching 'SKIP_METRIC_VERIFY: <reason>' with a
 *      non-empty, non-whitespace reason — operator override with audit trail.
 * Any other call to setIncidentStatus(id, 'resolved') will THROW.
 *
 * Uses temp-file + POSIX rename for crash safety.
 */
export async function setIncidentStatus(
  projectRoot: string,
  incidentId: IncidentId,
  status: IncidentStatus,
  extras?: Partial<Omit<IncidentMetadata, "incidentId" | "symptom" | "createdAt" | "status">>,
  opts?: SetStatusOpts,
): Promise<void> {
  const dir = incidentDir(projectRoot, incidentId);
  const metaPath = join(dir, "incident.json");

  const raw = await readFile(metaPath, "utf-8");
  const existing = IncidentMetadataSchema.parse(JSON.parse(raw));

  // ── Resolution gate (s22-c3, s22-c4) ──────────────────────────────────────
  let resolutionEvidence: IncidentResolutionEvidence | undefined;
  let timelineEvent: TimelineEvent | undefined;
  const now = new Date().toISOString();

  if (status === "resolved") {
    const verified = opts?.verifyResult?.verified === true;
    const overrideMatch = opts?.overrideToken
      ? OVERRIDE_TOKEN_RE.exec(opts.overrideToken)
      : null;
    // Trim the override reason and require non-empty after trim.
    const overrideReason = overrideMatch?.[1]?.trim();

    if (verified && opts?.verifyResult) {
      resolutionEvidence = {
        verified: true,
        observedValue: opts.verifyResult.observedValue,
        sampledAt: opts.verifyResult.sampledAt,
        evidencePath: opts.verifyResult.evidencePath,
        reason: opts.verifyResult.reason,
        hint: opts.verifyResult.hint,
      };
      timelineEvent = {
        timestamp: now,
        eventKind: "incident_resolved",
        source: "system",
        summary: `Resolved: metric verified (observedValue=${opts.verifyResult.observedValue ?? "n/a"})`,
        refPath: opts.verifyResult.evidencePath,
      };
    } else if (overrideReason && overrideReason.length > 0) {
      resolutionEvidence = {
        verified: false,
        override: { reason: overrideReason, at: now },
      };
      timelineEvent = {
        timestamp: now,
        eventKind: "incident_resolved_override",
        source: "human",
        summary: `Resolved via override: ${overrideReason}`,
      };
    } else {
      throw new Error(
        `setIncidentStatus to 'resolved' requires opts.verifyResult.verified=true ` +
        `OR opts.overrideToken='SKIP_METRIC_VERIFY: <reason>' with a non-empty reason. ` +
        `Got: verifyResult.verified=${opts?.verifyResult?.verified ?? "<missing>"}, ` +
        `overrideToken=${opts?.overrideToken !== undefined ? `'${opts.overrideToken}'` : "<missing>"}.`,
      );
    }
  }

  const updated: IncidentMetadata = {
    ...existing,
    ...extras,
    status,
    ...(status === "resolved" && !existing.resolvedAt ? { resolvedAt: now } : {}),
    ...(resolutionEvidence !== undefined ? { resolutionEvidence } : {}),
  };

  await atomicWriteJson(metaPath, updated);

  if (timelineEvent !== undefined) {
    await appendTimeline(projectRoot, incidentId, timelineEvent);
  }
}

// ── listIncidents ──────────────────────────────────────────────────────────────

/**
 * List all incidents in .bober/incidents/, sorted by createdAt descending.
 *
 * Gracefully handles:
 * - Missing .bober/incidents/ directory → returns [].
 * - Malformed incident.json → logged via logger.warn, skipped.
 *
 * ENOENT on readdir is caught and returns []. Any other readdir error is
 * re-thrown (do NOT silence unexpected failures).
 */
export async function listIncidents(projectRoot: string): Promise<IncidentSummary[]> {
  const incidentsDir = join(projectRoot, ".bober", "incidents");

  let entries: string[];
  try {
    entries = await readdir(incidentsDir);
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { code?: string }).code === "ENOENT"
    ) {
      return [];
    }
    throw err;
  }

  const summaries: IncidentSummary[] = [];

  for (const entry of entries) {
    const metaPath = join(incidentsDir, entry, "incident.json");
    try {
      const raw = await readFile(metaPath, "utf-8");
      const meta = IncidentMetadataSchema.parse(JSON.parse(raw));
      summaries.push({
        incidentId: meta.incidentId,
        symptom: meta.symptom,
        createdAt: meta.createdAt,
        status: meta.status,
        ...(meta.resolvedAt !== undefined ? { resolvedAt: meta.resolvedAt } : {}),
      });
    } catch (err: unknown) {
      logger.warn(
        `[listIncidents] Skipping malformed incident.json at ${metaPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Sort descending by createdAt (ISO strings compare lexicographically).
  summaries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

  return summaries;
}
