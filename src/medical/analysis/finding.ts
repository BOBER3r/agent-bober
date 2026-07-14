/**
 * MedicalFinding — common Finding field set emitted as vault markdown frontmatter.
 *
 * PURE / NO network / NO LLM / NO Date.now()
 * All timestamps are injected parameters; the wall clock is read ONLY at the CLI boundary.
 *
 * Finding ids are deterministic SHA-256 slices (mirrors observationId at
 * src/medical/health-store.ts:32-42) over stable content (domain|biomarker|ruleKey).
 * 'now' is NEVER included in the id — re-runs with the same condition produce the same id.
 *
 * Does NOT define a canonical Zod schema; the canonical schema is owned by
 * spec-20260628-priority-hub. This module emits the common Finding field set as
 * vault markdown frontmatter only.
 */

import { createHash } from "node:crypto";

import { serializeFrontmatter } from "../../vault/frontmatter.js";

// -- Types ----------------------------------------------------------------

/** Finding domain — fixed to "medical" for all findings in this module. */
export type FindingDomain = "medical";

/** Finding kind — research §3a finding taxonomy. */
export type FindingKind = "action" | "watch" | "risk" | "question";

/** Finding status. */
export type FindingStatus = "open" | "resolved" | "dismissed";

/**
 * Common Finding field set for medical findings (research §3a, spec §5).
 * domain is fixed to "medical".
 * Emitted as YAML frontmatter only; no canonical Zod schema here.
 */
export interface MedicalFinding {
  id: string;
  domain: FindingDomain;
  title: string;
  kind: FindingKind;
  /** Urgency level 1–5 (5 = most urgent). */
  urgency: number;
  /** Severity level 1–5 (5 = most severe). */
  severity: number;
  evidence: string[];
  /** ISO 8601 — INJECTED parameter, never wall-clock. */
  surfacedAt: string;
  dueBy?: string;
  tags: string[];
  status: FindingStatus;
  promotesTo?: string;
}

// -- Deterministic id -----------------------------------------------------

/**
 * Derive a deterministic 16-char hex finding id.
 * Mirrors observationId at src/medical/health-store.ts:32-42.
 * NEVER includes `now` — same condition must map to same id across runs (idempotency).
 *
 * @param domain    Finding domain (e.g. "medical")
 * @param biomarker Lab biomarker name
 * @param ruleKey   Rule identifier (e.g. "rule-a-high", "rule-b-low")
 */
export function findingId(domain: string, biomarker: string, ruleKey: string): string {
  return createHash("sha256")
    .update(`${domain}|${biomarker}|${ruleKey}`)
    .digest("hex")
    .slice(0, 16);
}

// -- Serialization --------------------------------------------------------

/**
 * Serialize a MedicalFinding to a YAML-frontmatter markdown note string.
 *
 * Uses the array-aware serializeFrontmatter from src/vault/frontmatter.ts (Pattern C).
 * Required frontmatter keys (sc-1-6): id, domain, kind, urgency, severity, surfacedAt, status.
 * Also emits: title, evidence[], tags[].
 *
 * surfacedAt equals MedicalFinding.surfacedAt (injected opts.now) — NEVER wall-clock.
 */
export function serializeFindingToMarkdown(finding: MedicalFinding): string {
  const frontmatter: Record<string, unknown> = {
    id: finding.id,
    domain: finding.domain,
    title: finding.title,
    kind: finding.kind,
    urgency: finding.urgency,
    severity: finding.severity,
    evidence: finding.evidence,
    surfacedAt: finding.surfacedAt,
    tags: finding.tags,
    status: finding.status,
  };

  if (finding.dueBy !== undefined) {
    frontmatter["dueBy"] = finding.dueBy;
  }
  if (finding.promotesTo !== undefined) {
    frontmatter["promotesTo"] = finding.promotesTo;
  }

  const body =
    `\n## ${finding.title}\n\n` +
    `**Kind:** ${finding.kind}  \n` +
    `**Urgency:** ${finding.urgency}/5  \n` +
    `**Severity:** ${finding.severity}/5\n\n` +
    finding.evidence.map((e) => `- ${e}`).join("\n") +
    "\n";

  return serializeFrontmatter(frontmatter, body);
}
