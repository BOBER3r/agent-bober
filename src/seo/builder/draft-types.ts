/**
 * SeoDraft artifact types (spec-20260717-seo-improver-builder, Sprint 11;
 * ADR-4). Pure `type` declarations only — no runtime code, no imports —
 * mirrors `../types.ts`'s "no runtime" discipline (`types.ts:1-12`).
 *
 * A `SeoDraft` is a PROPOSAL the Sprint-12 `SeoBuilder.build` produces from
 * an `ApprovedFinding` (`./approved-finding.js`); it is never auto-applied.
 * `humanApprovalRequired` is pinned to the LITERAL `true` (not `boolean`) —
 * ADR-4 explicitly rejected a boolean flag as forgeable/mutable, so the type
 * itself must reject `false`. `sourceCitationUrl` must be COPIED verbatim
 * from the `ApprovedFinding` that produced the draft — never invented.
 */

// -- Draft kind -----------------------------------------------------------

/** The four artifact kinds the Sprint-12 `SeoBuilder.build` can draft. */
export type SeoDraftKind = "schema-jsonld" | "internal-link" | "title-meta" | "content-refresh";

// -- SeoDraft ---------------------------------------------------------------

/**
 * One drafted artifact. Every field is provenance-preserving: `artifact` is
 * a proposed text/content string, never auto-applied; `sourceCitationUrl`
 * and `sourceFindingId` trace back to the exact `ApprovedFinding` this draft
 * was derived from.
 */
export type SeoDraft = {
  kind: SeoDraftKind;
  /** LITERAL `true` — a forgeable plain `boolean` was explicitly rejected (ADR-4). */
  humanApprovalRequired: true;
  /** Copied verbatim from `ApprovedFinding.sourceCitationUrl` — never invented. */
  sourceCitationUrl: string;
  /** The hub Finding id this draft was derived from. */
  sourceFindingId: string;
  /** The URL/page/entity this draft targets. */
  target: string;
  /** The proposed artifact text/content — a proposal, never auto-applied. */
  artifact: string;
  /** The playbook whose tactic produced this draft. */
  playbookRef: string;
};
