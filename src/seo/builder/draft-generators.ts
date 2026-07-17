/**
 * Deterministic draft-artifact templates (spec-20260717-seo-improver-builder,
 * Sprint 12; ADR-4). Network-free by construction — no LLM, no `fetch`.
 * Every template is pure: no clock, no `Math.random`, no I/O. Each template
 * echoes the `ApprovedFinding.title` verbatim into the produced artifact text
 * so a banned-implying finding yields a banned-implying draft the Sprint-12
 * `SeoBuilder`'s re-filter can catch and drop (sc-12-4).
 *
 * The generators map is injected into `SeoBuilder`'s constructor (optional,
 * defaulting to `DEFAULT_DRAFT_GENERATORS`) so a test can substitute a
 * generator that forces a banned artifact without touching real templates —
 * mirrors how `runner.ts` injects `analyzer`/`dataSource`/`findingSink`.
 */
import type { ApprovedFinding } from "./approved-finding.js";
import type { SeoDraftKind } from "./draft-types.js";

// -- DraftGenerator ---------------------------------------------------------

/** Turns one `ApprovedFinding` + `target` into the proposed artifact TEXT. */
export type DraftGenerator = (finding: ApprovedFinding, target: string) => string;

// -- Default templates (one per SeoDraftKind, pure) -------------------------

/**
 * One deterministic template per `SeoDraftKind`. Each MUST echo
 * `finding.title` into the artifact text — this is what lets the
 * `SeoBuilder`'s re-filter (`../never-encode-filter.js`) catch a banned
 * tactic implied by the approved finding's own title (sc-12-4).
 */
export const DEFAULT_DRAFT_GENERATORS: Record<SeoDraftKind, DraftGenerator> = {
  "schema-jsonld": (finding, target) =>
    JSON.stringify({ "@context": "https://schema.org", "@type": "WebPage", name: finding.title, url: target }),
  "internal-link": (finding, target) => `Add an internal link on ${target} implementing: ${finding.title}`,
  "title-meta": (finding, _target) => `<title>${finding.title}</title>`,
  "content-refresh": (finding, target) => `Refresh ${target}: ${finding.title}`,
};

// -- Kind selection ----------------------------------------------------------

/** Deterministic mapping from `playbookRef` prefix to the `SeoDraftKind` produced. */
const PLAYBOOK_KIND_RULES: ReadonlyArray<{ prefix: string; kind: SeoDraftKind }> = [
  { prefix: "seo.schema", kind: "schema-jsonld" },
  { prefix: "seo.internal-linking", kind: "internal-link" },
  { prefix: "seo.content-decay", kind: "content-refresh" },
];

/**
 * Deterministically selects the `SeoDraftKind` for an `ApprovedFinding` from
 * its `playbookRef` prefix (`../hub-emitter.ts` encodes `playbook:<ref>` per
 * finding). Falls back to `"title-meta"` — the most generic, broadly
 * applicable draft kind — when no prefix matches. Pure; never throws.
 */
export function kindForApprovedFinding(finding: ApprovedFinding): SeoDraftKind {
  const match = PLAYBOOK_KIND_RULES.find((rule) => finding.playbookRef.startsWith(rule.prefix));
  return match?.kind ?? "title-meta";
}
