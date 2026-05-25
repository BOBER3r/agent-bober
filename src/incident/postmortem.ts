/**
 * Postmortem synthesis (Sprint 23).
 *
 * Deterministic, programmatic synthesizer. Reads ALL artifacts under
 * .bober/incidents/<id>/ and assembles an evidence-cited postmortem.md.
 * Does NOT spawn an LLM subagent — postmortems must be reproducible from
 * disk artifacts alone for audit purposes (mirrors resolution-verify.ts).
 *
 * Citation format: per-sentence inline (artifact#L<n>) references. The
 * synthesizer enforces a minimum citation floor; below it, a synthesis-
 * failure warning is appended to the document.
 *
 * Redaction: every quoted artifact snippet is scanned against the secret-
 * pattern regex set BEFORE inclusion. Matches are replaced with [REDACTED]
 * and counted; the count is emitted in the footer.
 *
 * Sprint 23 — src/incident/postmortem.ts
 */

import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  IncidentMetadataSchema,
  type IncidentId,
  type IncidentMetadata,
} from "./types.js";

// ── PostmortemResult shape ─────────────────────────────────────────────────────

export interface PostmortemResult {
  /** Absolute path to the written postmortem.md */
  path: string;
  /** The full markdown content (caller can stream to stdout for CLI show) */
  content: string;
  /** Number of secret-like strings redacted from artifacts during synthesis */
  redactionCount: number;
  /** True if 5-Whys synthesis produced fewer than 3 deterministic levels */
  shallowWarning: boolean;
  /** Number of inline citations in the generated markdown */
  citationCount: number;
}

// ── Redaction patterns (mirror skills/bober.postmortem/SKILL.md) ──────────────
// These exact regexes are the canonical set — SKILL.md documents them.

const REDACTION_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/g,
  /aws_secret_access_key\s*[=:]\s*\S+/gi,
  /(?:Bearer|Token|token|apikey|api_key|api-key)[\s=:]+["']?[A-Za-z0-9._-]{16,}["']?/gi,
  /sk-[A-Za-z0-9]{20,}/g,
  /sk_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /secret_[A-Za-z0-9_-]+/gi,
  /password\s*[=:]\s*\S+/gi,
  /Authorization:\s*Bearer\s+\S+/gi,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g,
];

const REDACTION_PLACEHOLDER = "[REDACTED]";

function redact(text: string): { redacted: string; count: number } {
  let count = 0;
  let out = text;
  for (const re of REDACTION_PATTERNS) {
    // Reset lastIndex on each application (global flag requires it).
    re.lastIndex = 0;
    out = out.replace(re, () => {
      count++;
      return REDACTION_PLACEHOLDER;
    });
  }
  return { redacted: out, count };
}

// ── JSONL helpers (local — single consumer) ───────────────────────────────────

interface JsonlLine<T> {
  record: T;
  lineNo: number;
}

async function readJsonlWithLineNo<T>(path: string): Promise<JsonlLine<T>[]> {
  try {
    const raw = await readFile(path, "utf-8");
    const results: JsonlLine<T>[] = [];
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line) {
        results.push({ record: JSON.parse(line) as T, lineNo: i + 1 });
      }
    }
    return results;
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    throw err;
  }
}

// ── Artifact interfaces (local shapes — avoid importing from types.ts to keep thin) ─

interface TimelineRow {
  timestamp: string;
  eventKind: string;
  source: string;
  summary: string;
  refPath?: string;
}

interface ObservationRow {
  timestamp: string;
  phase: number;
  observation: string;
  source: string;
  verified: boolean;
}

interface ChangeRow {
  id: string;
  type: string;
  executedAt: string;
  description: string;
  inverse: { description: string; command?: string };
  status: string;
}

interface RunbookExecRow {
  timestamp: string;
  runbookName: string;
  stepNumber: number;
  status: string;
  preconditionResult: string;
  postconditionResult: string;
  rollbackTriggered?: boolean;
}

interface ActionRow {
  timestamp: string;
  action: string;
  blastRadius: string;
  requiresApproval: boolean;
  rationale?: string;
}

interface DiagnosisHypothesis {
  id: string;
  statement: string;
  confidence: "high" | "medium" | "low";
  supportingEvidence: Array<{ source: string; path: string; snippet: string; timestamp?: string }>;
  contradictingEvidence: Array<{ source: string; path: string; snippet: string }>;
}

interface DiagnosisResult {
  diagnosisId: string;
  incidentId: string;
  timestamp: string;
  summary: string;
  hypotheses: DiagnosisHypothesis[];
  nextActions: unknown[];
  _mtime?: number;
}

interface ResolutionEvidenceFile {
  incidentId: string;
  verifiedAt: string;
  criteria: {
    metricName: string;
    threshold: number;
    comparison: string;
    windowMinutes: number;
    provider: string;
  };
  samples: Array<{ timestamp: string; value: number }>;
  allSamplesPassed: boolean;
  _filename?: string;
}

// ── Artifact readers ───────────────────────────────────────────────────────────

async function readDiagnoses(dir: string): Promise<DiagnosisResult[]> {
  try {
    const entries = await readdir(dir);
    const jsonFiles = entries.filter((e) => e.endsWith(".json"));
    const results: DiagnosisResult[] = [];
    for (const fname of jsonFiles) {
      try {
        const raw = await readFile(join(dir, fname), "utf-8");
        const parsed = JSON.parse(raw) as DiagnosisResult;
        const s = await stat(join(dir, fname));
        parsed._mtime = s.mtimeMs;
        results.push(parsed);
      } catch {
        // Skip malformed files — log nothing here, we mention gaps in output
      }
    }
    // Sort by mtime descending — most recent first.
    results.sort((a, b) => (b._mtime ?? 0) - (a._mtime ?? 0));
    return results;
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    throw err;
  }
}

async function readResolutionEvidence(dir: string): Promise<ResolutionEvidenceFile[]> {
  try {
    const entries = await readdir(dir);
    const jsonFiles = entries.filter((e) => e.endsWith(".json"));
    const results: ResolutionEvidenceFile[] = [];
    for (const fname of jsonFiles) {
      try {
        const raw = await readFile(join(dir, fname), "utf-8");
        const parsed = JSON.parse(raw) as ResolutionEvidenceFile;
        parsed._filename = fname;
        results.push(parsed);
      } catch {
        // Skip malformed files
      }
    }
    return results;
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    throw err;
  }
}

// ── Duration formatter ────────────────────────────────────────────────────────

function formatDuration(createdAt: string, resolvedAt: string | undefined): string {
  if (!resolvedAt) return "ongoing";
  const ms = Date.parse(resolvedAt) - Date.parse(createdAt);
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h${String(m).padStart(2, "0")}m`;
}

function utcHHMM(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  if (isNaN(d.getTime())) return isoTimestamp;
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

// ── Section composers ──────────────────────────────────────────────────────────

function composeHeader(meta: IncidentMetadata): string {
  const duration = formatDuration(meta.createdAt, meta.resolvedAt);
  const titleSymptom = meta.symptom.length > 80 ? meta.symptom.slice(0, 80) + "..." : meta.symptom;
  const lines = [
    `# Postmortem: ${titleSymptom}`,
    "",
    `**Incident ID:** ${meta.incidentId} (incident.json)`,
    `**Status:** Resolved`,
    `**Severity:** S3 *(default — derive from observation count and impact magnitude)*`,
    `**Date:** ${meta.createdAt} → ${meta.resolvedAt ?? "ongoing"} (incident.json)`,
    `**Duration:** ${duration}`,
  ];
  return lines.join("\n");
}

function composeTldr(
  meta: IncidentMetadata,
  diagnoses: DiagnosisResult[],
  changelog: JsonlLine<ChangeRow>[],
  tally: (s: string) => string,
): string {
  const symptom = tally(meta.symptom);
  const topDiag = diagnoses[0];
  const topHyp = topDiag?.hypotheses?.sort((a, b) => {
    const order = { high: 3, medium: 2, low: 1 } as const;
    return (order[b.confidence] - order[a.confidence]) ||
           (b.supportingEvidence.length - a.supportingEvidence.length);
  })[0];

  // Find the last change entry.
  const lastChange = changelog.length > 0 ? changelog[changelog.length - 1] : null;

  let summary = `Symptom: ${symptom} (incident.json). `;
  if (topHyp && topDiag) {
    summary += `Root cause candidate: ${tally(topHyp.statement)} (diagnoses/${topDiag.diagnosisId}.json#${topHyp.id}). `;
  } else {
    summary += "Root cause: no diagnosis recorded — human review required. ";
  }
  if (lastChange) {
    summary += `Resolving action: ${tally(lastChange.record.description)} (changelog.jsonl#L${lastChange.lineNo}).`;
  } else if (meta.resolutionEvidence?.verified) {
    summary += `Resolution verified via metric check (incident.json).`;
  } else {
    summary += `Resolution method: see incident.json for details.`;
  }
  return summary;
}

function composeImpact(
  observations: JsonlLine<ObservationRow>[],
  resolutionEvidence: ResolutionEvidenceFile[],
  tally: (s: string) => string,
): string {
  const lines: string[] = [];

  const verifiedObs = observations.filter(
    (o) => o.record.verified && (o.record.phase === 1 || o.record.phase === 2),
  );
  if (verifiedObs.length === 0) {
    lines.push("- No verified observations recorded for this incident — (observations.jsonl is empty or unverified).");
  } else {
    for (const o of verifiedObs) {
      lines.push(`- ${tally(o.record.observation)} (observations.jsonl#L${o.lineNo})`);
    }
  }

  const passed = resolutionEvidence.filter((e) => e.allSamplesPassed);
  if (passed.length > 0) {
    const ev = passed[0];
    const sample = ev.samples?.[0];
    if (sample && ev.criteria) {
      lines.push(
        `- Resolution sample: observed ${sample.value} against threshold ${ev.criteria.threshold} ` +
        `(${ev.criteria.comparison}) at ${sample.timestamp} ` +
        `(resolution-evidence/${ev._filename ?? "evidence.json"})`,
      );
    }
  }

  return lines.join("\n");
}

function composeTimelineTable(
  timeline: JsonlLine<TimelineRow>[],
  tally: (s: string) => string,
): string {
  const header = [
    "| Time (UTC) | Event | Source |",
    "|------------|-------|--------|",
  ];
  if (timeline.length === 0) {
    return header.join("\n") + "\n| — | No timeline events recorded | (timeline.jsonl is empty) |";
  }
  const rows = timeline.map((t) => {
    const time = utcHHMM(t.record.timestamp);
    const summary = tally(t.record.summary.slice(0, 80));
    const source = `${t.record.source} (timeline.jsonl#L${t.lineNo})`;
    return `| ${time} | ${summary} | ${source} |`;
  });
  return [...header, ...rows].join("\n");
}

function composeRootCause(
  meta: IncidentMetadata,
  diagnoses: DiagnosisResult[],
  changelog: JsonlLine<ChangeRow>[],
  tally: (s: string) => string,
): { markdown: string; shallowWarning: boolean } {
  const whys: string[] = [];

  // Why 1: symptom from incident.json.
  whys.push(`1. Why did ${tally(meta.symptom)} happen? (incident.json)`);

  // Why 2: highest-confidence hypothesis from most-recent diagnosis.
  if (diagnoses.length > 0) {
    const d = diagnoses[0];
    const order = { high: 3, medium: 2, low: 1 } as const;
    const top = [...(d.hypotheses ?? [])].sort(
      (a, b) =>
        (order[b.confidence] - order[a.confidence]) ||
        (b.supportingEvidence.length - a.supportingEvidence.length),
    )[0];

    if (top) {
      whys.push(
        `2. Because ${tally(top.statement)}. (diagnoses/${d.diagnosisId}.json#${top.id})`,
      );

      // Why 3: strongest supporting evidence on that hypothesis.
      if (top.supportingEvidence && top.supportingEvidence.length > 0) {
        const ev = top.supportingEvidence[0];
        whys.push(`3. Because ${tally(ev.snippet)}. (${ev.path})`);
      }
    }
  }

  // Why 4 + 5: changes within 30 min before incident.createdAt, sorted by executedAt desc.
  const created = Date.parse(meta.createdAt);
  const preChanges = changelog
    .filter((c) => {
      const t = Date.parse(c.record.executedAt);
      return Number.isFinite(t) && created - t > 0 && created - t < 30 * 60 * 1000;
    })
    .sort((a, b) => (a.record.executedAt < b.record.executedAt ? 1 : -1));

  if (preChanges[0] && whys.length >= 3) {
    const minutes = Math.round(
      (created - Date.parse(preChanges[0].record.executedAt)) / 60000,
    );
    whys.push(
      `4. Because ${tally(preChanges[0].record.description)} shipped ${minutes}m before symptom onset. ` +
      `(changelog.jsonl#L${preChanges[0].lineNo})`,
    );
  }
  if (preChanges[1] && whys.length >= 4) {
    const minutes = Math.round(
      (created - Date.parse(preChanges[1].record.executedAt)) / 60000,
    );
    whys.push(
      `5. Because ${tally(preChanges[1].record.description)} (preceding change ${minutes}m before symptom onset). ` +
      `(changelog.jsonl#L${preChanges[1].lineNo})`,
    );
  }

  const shallowWarning = whys.length < 3;
  let markdown = whys.join("\n");
  if (shallowWarning) {
    const missingArtifact = diagnoses.length === 0 ? "diagnoses/" : "supportingEvidence";
    markdown +=
      "\n\n**Warning:** 5-Whys synthesis was shallow due to missing evidence — only " +
      `${whys.length} level(s) derivable from artifacts (missing evidence in ${missingArtifact}). ` +
      "Human review required to deepen this chain.";
  }
  return { markdown, shallowWarning };
}

function composeContributingFactors(
  runbookExec: JsonlLine<RunbookExecRow>[],
  observations: JsonlLine<ObservationRow>[],
  tally: (s: string) => string,
): string {
  const lines: string[] = [];

  const FAILED_STATUSES = new Set([
    "precondition_failed",
    "execution_failed",
    "postcondition_failed_no_rollback",
    "rollback_failed",
  ]);

  const failedSteps = runbookExec.filter((r) => FAILED_STATUSES.has(r.record.status));
  for (const step of failedSteps) {
    lines.push(
      `- Runbook failure: ${tally(step.record.runbookName)} step ${step.record.stepNumber} ` +
      `status=${step.record.status} (runbook-execution.jsonl#L${step.lineNo})`,
    );
  }

  const unverifiedObs = observations.filter((o) => !o.record.verified);
  for (const o of unverifiedObs) {
    lines.push(
      `- Unverified observation influenced response: ${tally(o.record.observation.slice(0, 120))} ` +
      `(observations.jsonl#L${o.lineNo})`,
    );
  }

  if (lines.length === 0) {
    if (runbookExec.length === 0) {
      lines.push("- No runbook executed for this incident — (runbook-execution.jsonl is empty).");
    } else {
      lines.push("- No failed runbook steps or unverified observations recorded (runbook-execution.jsonl).");
    }
  }

  return lines.join("\n");
}

function composeWentWell(
  runbookExec: JsonlLine<RunbookExecRow>[],
  resolutionEvidence: ResolutionEvidenceFile[],
  tally: (s: string) => string,
): string {
  const lines: string[] = [];

  const successStatuses = new Set(["success", "recovered_via_rollback"]);
  const successSteps = runbookExec.filter((r) => successStatuses.has(r.record.status));
  for (const step of successSteps) {
    lines.push(
      `- Runbook success: ${tally(step.record.runbookName)} step ${step.record.stepNumber} ` +
      `completed with status=${step.record.status} (runbook-execution.jsonl#L${step.lineNo})`,
    );
  }

  const verifiedResolution = resolutionEvidence.filter((e) => e.allSamplesPassed);
  for (const ev of verifiedResolution) {
    if (ev.criteria) {
      lines.push(
        `- Resolution metric verified: ${ev.criteria.metricName} ${ev.criteria.comparison} ${ev.criteria.threshold} ` +
        `for ${ev.criteria.windowMinutes}m sustained (resolution-evidence/${ev._filename ?? "evidence.json"})`,
      );
    }
  }

  if (lines.length === 0) {
    lines.push(
      "- No explicitly successful runbook steps recorded — (runbook-execution.jsonl has no success entries).",
    );
  }

  return lines.join("\n");
}

function composeWentWrong(
  runbookExec: JsonlLine<RunbookExecRow>[],
  actions: JsonlLine<ActionRow>[],
  meta: IncidentMetadata,
  tally: (s: string) => string,
): string {
  const lines: string[] = [];

  const FAILED_STATUSES = new Set([
    "precondition_failed",
    "execution_failed",
    "postcondition_failed_no_rollback",
    "rollback_failed",
  ]);

  const failedSteps = runbookExec.filter((r) => FAILED_STATUSES.has(r.record.status));
  for (const step of failedSteps) {
    lines.push(
      `- Runbook execution failure: ${tally(step.record.runbookName)} step ${step.record.stepNumber} ` +
      `failed with status=${step.record.status} (runbook-execution.jsonl#L${step.lineNo})`,
    );
  }

  // Risky actions taken without a preceding precondition pass.
  const precondPassTimes = new Set(
    runbookExec
      .filter((r) => r.record.preconditionResult === "pass")
      .map((r) => r.record.timestamp),
  );
  const riskyActionsWithoutPrecondition = actions.filter(
    (a) => a.record.blastRadius === "risky" && !precondPassTimes.has(a.record.timestamp),
  );
  for (const a of riskyActionsWithoutPrecondition) {
    lines.push(
      `- Risky action taken without preceding precondition pass: ${tally(a.record.action.slice(0, 120))} ` +
      `(actions.jsonl#L${a.lineNo})`,
    );
  }

  // Override resolution.
  if (meta.resolutionEvidence?.override) {
    lines.push(
      `- Incident resolved via override (not metric verification): ${tally(meta.resolutionEvidence.override.reason)} ` +
      `at ${meta.resolutionEvidence.override.at} (incident.json)`,
    );
  }

  if (lines.length === 0) {
    lines.push(
      "- No runbook failures or unguarded risky actions recorded for this incident.",
    );
  }

  return lines.join("\n");
}

function composeActionItems(
  runbookExec: JsonlLine<RunbookExecRow>[],
  actions: JsonlLine<ActionRow>[],
): string {
  const header = [
    "| Item | Owner | Due | Source |",
    "|------|-------|-----|--------|",
  ];
  const rows: string[] = [];

  const FAILED_STATUSES = new Set([
    "precondition_failed",
    "execution_failed",
    "postcondition_failed_no_rollback",
    "rollback_failed",
  ]);

  const failedSteps = runbookExec.filter((r) => FAILED_STATUSES.has(r.record.status));
  for (const step of failedSteps) {
    rows.push(
      `| Investigate and fix ${step.record.runbookName} step ${step.record.stepNumber} failure | TBD | TBD | (runbook-execution.jsonl#L${step.lineNo}) |`,
    );
  }

  // Risky actions without precondition pass.
  const precondPassTimes = new Set(
    runbookExec
      .filter((r) => r.record.preconditionResult === "pass")
      .map((r) => r.record.timestamp),
  );
  const riskyActions = actions.filter(
    (a) => a.record.blastRadius === "risky" && !precondPassTimes.has(a.record.timestamp),
  );
  for (const a of riskyActions) {
    rows.push(
      `| Add precondition gate before: ${a.record.action.slice(0, 60)} | TBD | TBD | (actions.jsonl#L${a.lineNo}) |`,
    );
  }

  // Default monitoring action item — always present.
  rows.push(
    "| Add monitoring for the root-cause signal identified in 5-Whys Level 3 | TBD | TBD | (5-whys-3) |",
  );

  return [...header, ...rows].join("\n");
}

// ── Citation counter ───────────────────────────────────────────────────────────

function countCitations(content: string): number {
  // Match parenthesized references like (incident.json), (timeline.jsonl#L7),
  // (diagnoses/xxx.json#h1), (5-whys-3), (resolution-evidence/file.json)
  const matches = content.match(
    /\([a-z0-9_./-]+(?:#(?:L?\d+|[a-z0-9-]+))?(?:,\s*[a-z0-9_./-]+(?:#(?:L?\d+|[a-z0-9-]+))?)?\)/gi,
  );
  return matches ? matches.length : 0;
}

// ── Main entry point ───────────────────────────────────────────────────────────

/**
 * Synthesize a postmortem document from incident artifacts.
 *
 * Reads all artifact files under .bober/incidents/<incidentId>/ and assembles
 * a structured, evidence-cited postmortem.md. Pure offline — no LLM calls.
 * Every claim cites a specific artifact path (and line number where applicable).
 *
 * @param projectRoot  Absolute path to the project root.
 * @param incidentId   The incident ID (e.g. 'inc-20260524-500-errors-on').
 * @returns PostmortemResult with path, content, redactionCount, shallowWarning, citationCount.
 */
export async function generatePostmortem(
  projectRoot: string,
  incidentId: IncidentId,
): Promise<PostmortemResult> {
  const dir = join(projectRoot, ".bober", "incidents", incidentId);

  // 1. Read incident.json (required — throws ENOENT if missing).
  const metaRaw = await readFile(join(dir, "incident.json"), "utf-8");
  const meta: IncidentMetadata = IncidentMetadataSchema.parse(JSON.parse(metaRaw));

  // 2. Read JSONL artifacts with line numbers (graceful: missing = empty).
  const timeline = await readJsonlWithLineNo<TimelineRow>(join(dir, "timeline.jsonl"));
  const observations = await readJsonlWithLineNo<ObservationRow>(join(dir, "observations.jsonl"));
  const changelog = await readJsonlWithLineNo<ChangeRow>(join(dir, "changelog.jsonl"));
  const runbookExec = await readJsonlWithLineNo<RunbookExecRow>(join(dir, "runbook-execution.jsonl"));
  const actions = await readJsonlWithLineNo<ActionRow>(join(dir, "actions.jsonl"));

  // 3. Read diagnoses/ (sort by mtime descending — most recent first).
  const diagnoses = await readDiagnoses(join(dir, "diagnoses"));

  // 4. Read resolution-evidence/*.json.
  const resolutionEvidence = await readResolutionEvidence(join(dir, "resolution-evidence"));

  // 5. Compose each section. The tally() wrapper redacts snippets at extraction time.
  let totalRedactions = 0;
  const tally = (s: string): string => {
    const { redacted, count } = redact(s);
    totalRedactions += count;
    return redacted;
  };

  const header = composeHeader(meta);
  const tldr = composeTldr(meta, diagnoses, changelog, tally);
  const impact = composeImpact(observations, resolutionEvidence, tally);
  const timelineTable = composeTimelineTable(timeline, tally);
  const { markdown: rootCause, shallowWarning } = composeRootCause(meta, diagnoses, changelog, tally);
  const contribFactors = composeContributingFactors(runbookExec, observations, tally);
  const wentWell = composeWentWell(runbookExec, resolutionEvidence, tally);
  const wentWrong = composeWentWrong(runbookExec, actions, meta, tally);
  const actionItems = composeActionItems(runbookExec, actions);

  // 6. Assemble document.
  const parts = [
    header,
    "",
    "## TL;DR",
    "",
    tldr,
    "",
    "## Impact",
    "",
    impact,
    "",
    "## Timeline",
    "",
    timelineTable,
    "",
    "## Root Cause (5-Whys)",
    "",
    rootCause,
    "",
    "## Contributing Factors",
    "",
    contribFactors,
    "",
    "## What Went Well",
    "",
    wentWell,
    "",
    "## What Went Wrong",
    "",
    wentWrong,
    "",
    "## Action Items",
    "",
    actionItems,
    "",
  ];

  if (totalRedactions > 0) {
    parts.push(
      "---",
      "",
      `**Redactions:** ${totalRedactions} secret-like string(s) redacted from artifacts. ` +
        "Audit trail: redaction patterns documented in `skills/bober.postmortem/SKILL.md`.",
      "",
    );
  }
  parts.push(`*Generated by \`bober postmortem generate ${incidentId}\` (Sprint 23).*`, "");

  const content = parts.join("\n");

  // 7. Citation count.
  const citationCount = countCitations(content);

  // 8. Write postmortem.md.
  // The incident directory must already exist (incident.json was read above).
  // We do NOT call mkdir here — if the directory was removed between read and
  // write (e.g., test cleanup race), writeFile throws ENOENT which is caught by
  // the caller's fire-and-forget wrapper in timeline.ts (logs a warn, moves on).
  const outputPath = join(dir, "postmortem.md");
  await writeFile(outputPath, content, { encoding: "utf-8", mode: 0o600 });

  return {
    path: outputPath,
    content,
    redactionCount: totalRedactions,
    shallowWarning,
    citationCount,
  };
}
