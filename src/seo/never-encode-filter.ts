/**
 * NeverEncodeFilter — pure, total, DROP-only runtime never-encode belt
 * (spec-20260717-seo-improver-builder, Sprint 2; ADR-3). Third belt after
 * parse-time drop (`parser.ts:111`, `policyClassRaw === "never-encode"`) and
 * the skill-content lint (`skills-content.test.ts:26-33`). This belt catches
 * an LLM-*synthesized* banned tactic at runtime — one that was never in a
 * skill file, so belts 1/2 never see it — even when it carries a
 * well-formed `citationUrl` that would otherwise sail through
 * `SeoCitationGate` (`citation-gate.ts:66-90`).
 *
 * Pure and total, mirroring `SeoCitationGate.apply` exactly: imports ONLY
 * `./types.js`. No LLM, no egress, no filesystem, no clock, no
 * `Math.random`. Identical input always yields identical output; never
 * throws. DROP-only (ADR-3 option table, nonGoal #1): unlike the citation
 * gate, this filter does NOT compute a `blocked`/exit-2 flag — a single
 * hallucinated phrase must not brick an otherwise-clean run.
 */
import type { SeoFinding } from "./types.js";

export type NeverEncodeResult = {
  /** Findings whose recommendation/evidence matches NO banned tactic — the ONLY findings passed downstream. */
  kept: SeoFinding[];
  /** Findings whose recommendation/evidence matches a banned never-encode tactic. */
  dropped: SeoFinding[];
};

/**
 * Single exported const so the parser floor (`retriever.ts:34-37`), the
 * benchmark's test-local mirror (`benchmark/harness.ts:79-86`), and this
 * filter share intent (generatorNotes). Case-insensitive, `\b`-anchored to
 * avoid over-matching clean recommendations ("Fix duplicate title tags...",
 * "Add a self-referencing canonical tag."). Covers all 8 sc-2-2 classes:
 * parasite SEO, expired-domain, paid/bought links, PBN/link schemes, mass AI
 * pages, cloaking, doorway pages, AI-recommendation poisoning. The first 6
 * are the existing set (`skills-content.test.ts:26-33`); PBN/cloaking/
 * doorway are new for this sprint.
 */
export const NEVER_ENCODE_PATTERNS: readonly RegExp[] = [
  /\bplace\b[^.]*\b(parasite|high-?authority host|third-?party host)/i, // parasite SEO
  /\b(?:buy(?:ing)?|purchas(?:e|ing))\b[^.]*\blinks?\b/i, // paid/bought links
  /\bregister(ing)?\b[^.]*\bexpired domain/i, // expired-domain
  /\bgenerate\b[^.]*\bmass\b[^.]*\bpages\b/i, // mass AI pages
  /\b(?:mass[-\s]?generat(?:e|ing)|generat(?:e|ing)[-\s]?mass)\b/i, // mass AI pages
  /\bpoison/i, // AI-recommendation poisoning
  /\b(?:private blog network|pbn|link scheme|link network|link farm)\b/i, // PBN / link schemes
  /\bcloak(?:ing|ed)?\b/i, // cloaking
  /\bdoorway\s+pages?\b/i, // doorway pages
];

/** Scans `recommendation` + all evidence fields (metric/value/source/url) for a banned tactic match. */
function matchesBannedTactic(finding: SeoFinding): boolean {
  const evidenceText = finding.evidence
    .map((e) => `${e.metric} ${e.value} ${e.source} ${e.url}`)
    .join(" ");
  const text = `${finding.recommendation} ${evidenceText}`;
  return NEVER_ENCODE_PATTERNS.some((pattern) => pattern.test(text));
}

export class NeverEncodeFilter {
  /**
   * Partitions `findings` into `kept`/`dropped` by banned-tactic text
   * matching. Pure and total: identical input always yields identical
   * output. DROP-only — never computes a block/exit-code signal (ADR-3).
   */
  apply(findings: SeoFinding[]): NeverEncodeResult {
    const kept: SeoFinding[] = [];
    const dropped: SeoFinding[] = [];

    for (const finding of findings) {
      if (matchesBannedTactic(finding)) {
        dropped.push(finding);
      } else {
        kept.push(finding);
      }
    }

    return { kept, dropped };
  }
}
