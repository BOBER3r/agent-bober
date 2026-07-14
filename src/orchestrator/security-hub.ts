/**
 * security-hub.ts — maps SecurityAuditResult findings into the canonical hub
 * Finding shape and emits them via an injected sink (spec-20260712-security-
 * audit-agent-team, sprint 6). Closes the ADR open question at
 * .bober/architecture/arch-20260712-security-audit-agent-team-architecture.md:363
 * ("wiring important findings into the priority hub ... must respect the
 * hub's canonical FindingSchema").
 *
 * Two callers wire this module in AFTER the audit's verdict is already
 * computed: the pipeline gate (security-gate.ts) and the standalone CLI
 * (security-audit.ts). Neither call site awaits emission inside a
 * time-boxed race, and a hub failure never changes the verdict or exit code
 * — emission is a best-effort side effect (nonGoals[3]).
 *
 * Mirrors the injected-FindingSink precedent in src/research/runner.ts:
 * the mapper is PURE (never reads the clock — `now` is injected by the
 * caller) and the sink is a dependency the caller binds to the real
 * `ingestFinding` (src/hub/finding-store.ts) at the fs boundary.
 */

import { createHash } from "node:crypto";
import type { Finding } from "../hub/finding.js";
import type { SecurityAuditResult, SecurityFinding } from "./security-audit-types.js";
import type { Logger } from "../utils/logger.js";

// ── Types ──────────────────────────────────────────────────────────────

/** Hub Finding emitter — mirrors research runner's FindingSink (runner.ts:44). */
export type SecurityFindingSink = (finding: Finding) => Promise<void>;

// ── Local id hash ────────────────────────────────────────────────────────

/**
 * Content-stable id: hash of domain|title|kind. Replicated locally because
 * finding-store.ts's own deriveFindingId is not exported — src/research/
 * runner.ts sets this precedent (runner.ts:104-109). This is an id hash,
 * NOT a schema-level redefinition of the Finding shape (sc-6-4).
 */
function deriveFindingId(domain: string, title: string, kind: string): string {
  return createHash("sha256").update(`${domain}|${title}|${kind}`).digest("hex").slice(0, 16);
}

// ── Severity mapping (sc-6-1) ────────────────────────────────────────────
//
// Read directly from the REAL FindingSchema (src/hub/finding.ts:15-16):
// both `severity` and `urgency` are `z.number().int().min(1).max(5)`.
//
//   Audit bucket             Hub severity   Hub urgency   Rationale
//   ------------------------ -------------  ------------  ----------------------
//   review.critical[]        5 (highest)    5             blocking vulnerability
//   review.important[]       3 (mid)        3             non-blocking, surfaced
//   review.minor[] /         (not emitted)  --            nonGoals[2] — the LLM
//   approvedAreas                                          auditor did not confirm
//                                                           these into a blocking
//                                                           or notable bucket.
const CRITICAL_SEVERITY = 5;
const CRITICAL_URGENCY = 5;
const IMPORTANT_SEVERITY = 3;
const IMPORTANT_URGENCY = 3;

// ── Mapping ──────────────────────────────────────────────────────────────

/**
 * Build one hub Finding per SecurityFinding in a bucket.
 *
 * `title` is STABLE — vulnClass + a discriminator + the first evidence
 * entry's path:line. It must NEVER embed the free-text description
 * verbatim: the Finding `id` is derived from `domain|title|kind`, so a
 * title that varies across retries would mint a new id every time and
 * defeat the hub's content-hash dedup (sc-6-3).
 *
 * The discriminator (`#${...}`) fixes a title collision (G10): two
 * DIFFERENT vulnerabilities of the same vulnClass at the same path:line
 * used to hash to the SAME id and silently overwrite each other. It
 * prefers `signatureId`, then `cwe`, then falls back to a short stable
 * hash of the finding's own `description` — content-derived so identical
 * retries (same description) still resolve to the same discriminator and
 * dedup, while two distinct descriptions diverge into distinct ids.
 *
 * The description itself still lands in `evidence[]` — FindingSchema has
 * no `body` field, and its `evidence` is `z.array(z.string())` (finding.
 * ts:17), NOT the `{path,line,snippet}[]` shape a SecurityFinding
 * carries — so each evidence entry is flattened to a string.
 */
function mapBucket(
  findings: SecurityFinding[],
  severity: number,
  urgency: number,
  stack: string,
  now: string,
): Finding[] {
  return findings.map((finding) => {
    const primaryEvidence = finding.evidence[0];
    const path = primaryEvidence?.path ?? "unknown";
    const line = primaryEvidence?.line ?? 0;
    const discriminator =
      finding.signatureId ??
      finding.cwe ??
      createHash("sha256").update(finding.description).digest("hex").slice(0, 8);
    const title = `[security] ${finding.vulnClass ?? "vulnerability"} #${discriminator} at ${path}:${line}`;

    const evidence: string[] = [
      finding.description,
      ...finding.evidence.map((e) => `${e.path}:${e.line} — ${e.snippet}`),
    ];

    return {
      id: deriveFindingId("security", title, "risk"),
      domain: "security",
      title,
      kind: "risk",
      urgency,
      severity,
      evidence,
      surfacedAt: now,
      tags: [
        "security",
        ...(finding.vulnClass ? [`vuln:${finding.vulnClass}`] : []),
        `stack:${stack}`,
        ...(finding.cwe ? [`cwe:${finding.cwe}`] : []),
        ...(finding.severity ? [`severity:${finding.severity}`] : []),
        ...(finding.confidence ? [`confidence:${finding.confidence}`] : []),
        ...(finding.signatureId ? [`sig:${finding.signatureId}`] : []),
      ],
      status: "open",
    };
  });
}

/**
 * Map a SecurityAuditResult into hub Findings — one per critical (severity
 * 5) and important (severity 3) finding. `minor` and `approvedAreas` are
 * never emitted (nonGoals[2]) — the LLM auditor did not confirm those into a
 * blocking or notable bucket. A clean audit (no critical/important) returns
 * `[]`.
 *
 * PURE: never reads the clock — `now` is injected by the caller.
 */
export function mapAuditToFindings(result: SecurityAuditResult, now: string): Finding[] {
  // review.critical/important are always built from SecurityFinding objects
  // inside runSecurityAudit (a superset of the locked ReviewFinding shape) —
  // the same safe narrowing security-gate.ts's renderSecurityFeedback relies
  // on (security-gate.ts:158).
  const critical = result.review.critical as SecurityFinding[];
  const important = result.review.important as SecurityFinding[];

  return [
    ...mapBucket(critical, CRITICAL_SEVERITY, CRITICAL_URGENCY, result.stack, now),
    ...mapBucket(important, IMPORTANT_SEVERITY, IMPORTANT_URGENCY, result.stack, now),
  ];
}

// ── Emission ─────────────────────────────────────────────────────────────

/**
 * Map and emit a SecurityAuditResult's findings through the injected sink.
 *
 * Best-effort: never throws. A failure raised by the sink (or by the
 * mapping) is caught and logged via `log.warn` — it must NEVER alter the
 * audit verdict or block the pipeline/CLI (sc-6-2). Callers invoke this
 * strictly AFTER the verdict has already been computed and OUTSIDE any
 * time-boxed race (nonGoals[3]).
 */
export async function emitSecurityFindings(
  result: SecurityAuditResult,
  sink: SecurityFindingSink,
  log: Pick<Logger, "warn">,
  now: string,
): Promise<void> {
  try {
    for (const finding of mapAuditToFindings(result, now)) {
      await sink(finding);
    }
  } catch (err) {
    log.warn(`Security hub emission failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
