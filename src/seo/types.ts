/**
 * Core SEO type foundation (spec-20260715-ultimate-seo-suite, Sprint 1).
 *
 * Pure `type` declarations only — no runtime code, no imports. These shapes
 * are quoted verbatim from the architecture Component Breakdown / Data Model
 * (.bober/architecture/arch-20260715-ultimate-seo-agents-skills-architecture.md).
 *
 * Deliberately NOT included this sprint (later-sprint nonGoals): the
 * `SeoDataSource` seam, capability/query types, adapters, and any import of
 * `src/hub/finding.js` — `SeoFinding.severity` stays a plain 1..5 numeric
 * union until the hub emitter sprint maps it onto `Finding`.
 */

// ── Workflow ─────────────────────────────────────────────────────────

/** The 8 SEO workflows the CLI dispatches on (architecture lines 65-73). */
export type SeoWorkflow =
  | "technical-audit"
  | "rank-track"
  | "content-decay"
  | "topical-map"
  | "ai-visibility"
  | "parasite-watch"
  | "internal-linking"
  | "schema-audit";

// ── Data outcome / provenance ───────────────────────────────────────

/**
 * Provenance stamped on every `DataOutcome` `"data"` arm (architecture
 * lines 165-169). `costUsd` is set only by costed live sources (DataForSEO).
 * `path`/`mtimeMs` are set only by file-backed sources (LocalExportSource,
 * Sprint 6) for freshness auditing — optional so `gsc`/`dataforseo`
 * provenance stays byte-compatible (same optional idiom as `costUsd`).
 */
export type DataProvenance = {
  source: "local-export" | "gsc" | "dataforseo";
  retrievedAt: string;
  costUsd?: number;
  path?: string;
  mtimeMs?: number;
};

/**
 * Three-arm outcome for every `SeoDataSource` capability call (architecture
 * lines 160-163; mirrors `RetrievalOutcome`, medline-source.ts:25-28).
 */
export type DataOutcome<T> =
  | { kind: "disabled" }
  | { kind: "abstain"; reason: string }
  | { kind: "data"; rows: T; provenance: DataProvenance };

// ── Playbook signature ──────────────────────────────────────────────

/**
 * Parsed from each `skills/bober.seo-*` directory's `SKILL.md`, strong/
 * read-only, memoised per process (architecture lines 349-360).
 */
export type SeoSignature = {
  playbookId: string;
  workflows: SeoWorkflow[];
  title: string;
  tactic: string;
  invariant: string;
  primarySourceUrl: string;
  policyClass: "auto-safe" | "human-approve";
  evidenceGrade: "verified" | "primary-unverified" | "single-source";
  keywords: string[];
  skillRef: string;
};

// ── Finding ──────────────────────────────────────────────────────────

/**
 * One SEO recommendation (architecture lines 258-267). `severity` maps to
 * hub `Finding` urgency/severity 1..5 (finding.ts:15-16) in a LATER sprint —
 * `Finding` is not imported here.
 */
export type SeoFinding = {
  recommendation: string;
  workflow: SeoWorkflow;
  playbookRef: string;
  citationUrl: string;
  evidence: Array<{ metric: string; value: string; source: string; url: string }>;
  severity: 1 | 2 | 3 | 4 | 5;
  humanApprovalRequired: boolean;
  confidence: "firm" | "tentative";
};

// ── Report ───────────────────────────────────────────────────────────

/**
 * Persisted at `.bober/seo/reports/<safeId>-seo-report.json` (architecture
 * lines 363-372).
 */
export type SeoReport = {
  reportId: string;
  workflow: SeoWorkflow;
  target: string;
  generatedAt: string;
  findings: SeoFinding[];
  droppedUncited: number;
  dataProvenance: DataProvenance[];
  verdict: "pass" | "blocked";
};

// ── Quota ledger ─────────────────────────────────────────────────────

/**
 * Persisted at `.bober/seo/quota-ledger.json` (architecture calls this
 * shape `QuotaLedger`, lines 375-385; named `SeoQuotaLedger` per
 * generatorNotes to match the `Seo*` naming convention of this module).
 */
export type SeoQuotaLedger = {
  [dateKey: string]: {
    spentUsd: number;
    scopes: {
      [scopeKey: string]: { rowsToday: number; urlInspectionsToday: number };
    };
  };
};
