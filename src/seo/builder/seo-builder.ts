/**
 * SeoBuilder — the gated generative builder (spec-20260717-seo-improver-
 * builder, Sprint 12; ADR-4, the highest-risk piece of this spec). Crosses
 * the advisory→generative boundary that Sprints 2/11 fenced off:
 * `build(input)` accepts `ApprovedFinding[]` ONLY (`./approved-finding.js`) —
 * a raw `SeoFinding[]` does not type-check (see `seo-builder.test.ts`'s
 * `@ts-expect-error` compile-proof, sc-12-1) — and is constructed with a
 * MANDATORY `NeverEncodeFilter` (`../never-encode-filter.js`, Sprint 2) that
 * is re-run over EVERY generated draft's artifact text before it is
 * returned (drop-only, sc-12-3/sc-12-4). Every returned `SeoDraft` carries
 * `humanApprovalRequired: true` (the type's literal, ADR-4) and a
 * `sourceCitationUrl` copied verbatim from the approving finding — nothing
 * is ever auto-applied to a live property.
 *
 * Mirrors `SeoAnalyzer`'s shape (`../analyzer.ts:304-336`): constructor-
 * injected deps, `now` threaded in (never `new Date()`), and never-throws-
 * on-recoverable-failure — here, a per-finding generation error increments
 * `skipped` and moves on rather than bricking the whole batch (same
 * drop-only spirit as `NeverEncodeFilter`, `../never-encode-filter.ts:16`).
 */
import type { BoberConfig } from "../../config/schema.js";
import type { NeverEncodeFilter } from "../never-encode-filter.js";
import type { SeoFinding } from "../types.js";

import type { ApprovedFinding } from "./approved-finding.js";
import { DEFAULT_DRAFT_GENERATORS, kindForApprovedFinding, type DraftGenerator } from "./draft-generators.js";
import type { SeoDraft, SeoDraftKind } from "./draft-types.js";

// -- Public types -------------------------------------------------------------

export type SeoBuildInput = {
  /** ONLY `ApprovedFinding[]` — a raw `SeoFinding[]` must NOT type-check (sc-12-1). */
  approvedFindings: ApprovedFinding[];
  /** The URL/page/entity every produced draft targets. */
  target: string;
  /**
   * Accepted for interface parity with `SeoAnalyzeInput` (`../analyzer.ts:76`)
   * and the Sprint-13 runner/CLI contract. Not consumed by this sprint's
   * `build` body — no builder behaviour this sprint reads `config`.
   */
  config: BoberConfig;
  /** Injected wall-clock snapshot (ISO-8601) — `build` never reads the clock itself. */
  now: string;
};

export type SeoBuildResult = {
  drafts: SeoDraft[];
  /** Count of approved findings that produced NO draft — either a generation error or a never-encode re-filter drop. */
  skipped: number;
};

// -- SeoBuilder ---------------------------------------------------------------

export class SeoBuilder {
  constructor(
    /** MANDATORY (sc-12-1, ADR-4) — re-run over every generated draft's artifact text before it is returned. */
    private readonly neverEncode: NeverEncodeFilter,
    private readonly generators: Record<SeoDraftKind, DraftGenerator> = DEFAULT_DRAFT_GENERATORS,
  ) {}

  /**
   * Generates one `SeoDraft` per approved finding via the deterministic
   * templates in `./draft-generators.js`, re-runs the mandatory
   * `NeverEncodeFilter` over each artifact, and returns only the drafts
   * that pass. NEVER throws: a generation error for one finding increments
   * `skipped` and the loop continues (sc-12-5).
   */
  build(input: SeoBuildInput): SeoBuildResult {
    const drafts: SeoDraft[] = [];
    let skipped = 0;

    for (const finding of input.approvedFindings) {
      try {
        const kind = kindForApprovedFinding(finding);
        const artifact = this.generators[kind](finding, input.target);

        if (this.isBanned(artifact)) {
          // Re-filter DROP (sc-12-3/sc-12-4) — never emitted, counted as skipped.
          skipped += 1;
          continue;
        }

        drafts.push({
          kind,
          humanApprovalRequired: true, // LITERAL true (draft-types.ts) — never a plain boolean.
          sourceCitationUrl: finding.sourceCitationUrl, // COPIED verbatim — never invented.
          sourceFindingId: finding.sourceFindingId,
          target: input.target,
          artifact,
          playbookRef: finding.playbookRef,
        });
      } catch {
        // A generation error skips this finding only — never bricks the batch (sc-12-5).
        skipped += 1;
      }
    }

    return { drafts, skipped };
  }

  /**
   * Re-runs the INJECTED `NeverEncodeFilter` over `artifactText` (§4 of the
   * sprint briefing). `NeverEncodeFilter.apply` scans `SeoFinding.recommendation`
   * + evidence fields (`../never-encode-filter.ts:50-57`); a `SeoDraft` has
   * no `recommendation` field, so a throwaway probe `SeoFinding` is built
   * whose `recommendation` IS the draft artifact text — the only field that
   * matters for the scan. Using the injected filter instance (rather than
   * `NEVER_ENCODE_PATTERNS` directly) keeps the "mandatory filter" guarantee
   * load-bearing and testable (a test could inject a spy filter).
   */
  private isBanned(artifactText: string): boolean {
    const probe: SeoFinding = {
      recommendation: artifactText,
      workflow: "technical-audit",
      playbookRef: "",
      citationUrl: "",
      evidence: [],
      severity: 3,
      humanApprovalRequired: false,
      confidence: "firm",
    };
    return this.neverEncode.apply([probe]).dropped.length > 0;
  }
}
