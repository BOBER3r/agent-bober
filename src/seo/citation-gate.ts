/**
 * SeoCitationGate — the deterministic, offline, pre-hub citation gate
 * (spec-20260715-ultimate-seo-suite, Sprint 10; ADR-3,
 * arch-20260715-ultimate-seo-agents-skills-architecture.md:279-295).
 *
 * Pure and total: no LLM, no egress, no filesystem, no clock. Imports
 * nothing beyond `./types.js`. Partitions findings by whether their
 * `citationUrl` is a well-formed primary-source URL — uncited findings are
 * dropped and NEVER reach the hub (Sprint 11) or a human.
 *
 * Naming note (see the sprint briefing §0): the contract (sc-10-3) spells
 * the method `filter`; the architecture and generatorNotes call it `apply`.
 * Both are provided — `filter` is an alias of the same implementation.
 */
import type { SeoFinding } from "./types.js";

/** Mirrors `SeoConfigSchema.blockThreshold` (config/schema.ts:697). */
export type SeoBlockThreshold = "never" | "any-uncited" | "critical-uncited";

export type CitationGateResult = {
  /** Findings with a well-formed primary-source citationUrl — the ONLY findings emitted downstream. */
  cited: SeoFinding[];
  /** Findings with an empty/malformed citationUrl — never reach the hub. */
  dropped: SeoFinding[];
  /** Fail-closed exit-2 signal, derived from `dropped` per `threshold`. */
  blocked: boolean;
};

/**
 * A citationUrl is well-formed when it is a non-empty, non-whitespace
 * string that parses as an absolute http(s) URL. No URL-validation utility
 * exists elsewhere in `src` — this is a local, single-purpose check.
 */
function isWellFormedCitationUrl(url: string): boolean {
  if (typeof url !== "string" || url.trim().length === 0) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * bober: the "critical" cutoff for `critical-uncited` is not pinned by the
 * contract; severity 4-5 (of the 1..5 scale) is the recommended reading
 * per the sprint briefing — bump this constant if that reading changes.
 */
const CRITICAL_SEVERITY_FLOOR = 4;

function isBlocked(dropped: SeoFinding[], threshold: SeoBlockThreshold): boolean {
  switch (threshold) {
    case "never":
      return false;
    case "any-uncited":
      return dropped.length > 0;
    case "critical-uncited":
      return dropped.some((finding) => finding.severity >= CRITICAL_SEVERITY_FLOOR);
    default: {
      const _exhaustive: never = threshold; // compile error if a SeoBlockThreshold value is unhandled
      return _exhaustive;
    }
  }
}

export class SeoCitationGate {
  /**
   * Partitions `findings` into `cited`/`dropped` by citationUrl
   * well-formedness, then derives `blocked` from `threshold`. Pure and
   * total: identical input always yields identical output.
   */
  apply(findings: SeoFinding[], threshold: SeoBlockThreshold): CitationGateResult {
    const cited: SeoFinding[] = [];
    const dropped: SeoFinding[] = [];

    for (const finding of findings) {
      if (isWellFormedCitationUrl(finding.citationUrl)) {
        cited.push(finding);
      } else {
        dropped.push(finding);
      }
    }

    return { cited, dropped, blocked: isBlocked(dropped, threshold) };
  }

  /** Alias of `apply` — satisfies the contract's literal `.filter(...)` wording (sc-10-3). */
  filter = (findings: SeoFinding[], threshold: SeoBlockThreshold): CitationGateResult =>
    this.apply(findings, threshold);
}
