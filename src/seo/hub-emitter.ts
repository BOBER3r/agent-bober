/**
 * SeoHubEmitter — maps cited `SeoFinding`s into the canonical hub `Finding`
 * shape and emits them via an injected sink (spec-20260715-ultimate-seo-suite,
 * Sprint 11). Mirrors `src/orchestrator/security-hub.ts:39-177` — the FIRST
 * use of the import-only `src/hub/finding.ts` from this module.
 *
 * `Finding`/`FindingSchema` are IMPORTED, never redefined (sc-11-4). The
 * mapper is PURE (never reads the clock — `now` is caller-injected, mirrors
 * `mapAuditToFindings`); the sink is a dependency the caller binds to the
 * real `ingestFinding` (`src/hub/finding-store.ts`) at the fs boundary.
 *
 * Uncited findings are dropped TWICE (belt-and-suspenders with
 * `SeoCitationGate`, arch line 325): callers are expected to pass only
 * `SeoCitationGate.apply(...).cited` findings, but `mapToFindings` ALSO
 * skips any finding whose `citationUrl` is missing/empty as a second,
 * independent guard (sc-11-5).
 */
import { createHash } from "node:crypto";

import type { Finding } from "../hub/finding.js";
import type { SeoAnalysis } from "./analyzer.js";
import type { Logger } from "../utils/logger.js";

/** Hub Finding emitter — mirrors `SecurityFindingSink` (`security-hub.ts:29`). */
export type SeoFindingSink = (finding: Finding) => Promise<void>;

/**
 * Content-stable id: hash of domain|title|kind. Replicated locally (same
 * precedent as `security-hub.ts:33-41`) rather than imported — an id hash,
 * NOT a schema-level redefinition of `Finding`.
 */
function deriveFindingId(domain: string, title: string, kind: string): string {
  return createHash("sha256").update(`${domain}|${title}|${kind}`).digest("hex").slice(0, 16);
}

/** Flatten one `SeoFinding.evidence` entry into a hub `evidence[]` string. */
function formatEvidence(entry: { metric: string; value: string; source: string; url: string }): string {
  return `${entry.metric}=${entry.value} (${entry.source}) ${entry.url}`;
}

export class SeoHubEmitter {
  /**
   * Build one hub `Finding` per CITED `SeoFinding` in `analysis.findings`.
   * PURE — never reads the clock (`now` is injected).
   *
   * `kind` mapping: `humanApprovalRequired: true` -> `"action"`;
   * otherwise `"risk"` (informational/low-severity findings could be
   * refined to `"watch"` in a later sprint — not required by sc-11-4).
   *
   * `title` is STABLE across retries (feeds the id hash via
   * `deriveFindingId`) — built from `workflow` + a slice of the
   * recommendation text, never the full free-text body.
   */
  mapToFindings(analysis: SeoAnalysis, now: string): Finding[] {
    const out: Finding[] = [];

    for (const finding of analysis.findings) {
      // Belt-and-suspenders with SeoCitationGate — skip any uncited finding
      // that slipped through, even though callers are expected to pass only
      // gate.cited (sc-11-5).
      if (!finding.citationUrl || finding.citationUrl.trim().length === 0) continue;

      const kind: Finding["kind"] = finding.humanApprovalRequired ? "action" : "risk";
      const title = `[seo] ${finding.workflow}: ${finding.recommendation.slice(0, 80)}`;

      out.push({
        id: deriveFindingId("seo", title, kind),
        domain: "seo",
        title,
        kind,
        urgency: finding.severity,
        severity: finding.severity,
        evidence: [
          finding.recommendation,
          ...finding.evidence.map(formatEvidence),
          `cite:${finding.citationUrl}`,
        ],
        surfacedAt: now,
        tags: [
          "seo",
          `workflow:${finding.workflow}`,
          `playbook:${finding.playbookRef}`,
          `confidence:${finding.confidence}`,
        ],
        status: "open",
      });
    }

    return out;
  }

  /**
   * Map and emit `analysis`'s cited findings through the injected sink.
   * Best-effort: NEVER throws. A failure raised by the sink (or the
   * mapping) is caught and logged via `log.warn` — it must never alter the
   * runner's exit code (mirrors `emitSecurityFindings`, `security-hub.ts:164-177`).
   */
  async emit(
    analysis: SeoAnalysis,
    sink: SeoFindingSink,
    log: Pick<Logger, "warn">,
    now: string,
  ): Promise<void> {
    try {
      for (const finding of this.mapToFindings(analysis, now)) {
        await sink(finding);
      }
    } catch (err) {
      log.warn(`SEO hub emission failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
