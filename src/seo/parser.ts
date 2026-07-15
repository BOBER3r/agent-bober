/**
 * SeoPlaybookParser — pure, TOTAL markdown parser for bober.seo-* skill files
 * (spec-20260715-ultimate-seo-suite, Sprint 2; mirrors
 * `SecuritySignatureParser`, src/orchestrator/security-knowledge/parser.ts:137-156).
 *
 * Block format (mirrored in skills/bober.seo-generic/SKILL.md's "## Signature
 * Block Format" section — the two are one executable spec):
 *
 *   ### <playbookId>
 *   - **Title:** <human-readable title>
 *   - **Workflows:** comma, separated, SeoWorkflow, members
 *   - **Tactic:** <the recommended action>
 *   - **Invariant:** <the evidence-backed claim this signature encodes>
 *   - **PrimarySourceUrl:** <REQUIRED citation URL>
 *   - **PolicyClass:** auto-safe|human-approve|never-encode
 *   - **EvidenceGrade:** verified|primary-unverified|single-source
 *   - **Keywords:** comma, separated, keywords
 *
 * A block is split on a `### ` heading (heading text, trimmed, is the
 * playbookId). Two DROP rules beyond the security template (architecture
 * Data Model comments; research §5/§6):
 *   1. `PrimarySourceUrl` missing/empty -> DROP (no-uncited-claim — the
 *      whole point of this format).
 *   2. `PolicyClass` === "never-encode" -> DROP (parasite SEO, expired-domain
 *      plays, paid links, mass AI pages, AI-recommendation poisoning).
 * Plus the standard: empty playbookId, missing Title, or an invalid
 * PolicyClass value all drop the block. Never throws. No code fences here —
 * SEO signatures carry `tactic`, not unsafe/safe examples, so there is no
 * `extractFencedExample` machinery to port.
 */
import type { SeoSignature, SeoWorkflow } from "./types.js";
import { parseFrontmatter } from "../vault/frontmatter.js";

// ── Type guards ──────────────────────────────────────────────────────

const SEO_WORKFLOWS = [
  "technical-audit",
  "rank-track",
  "content-decay",
  "topical-map",
  "ai-visibility",
  "parasite-watch",
  "internal-linking",
  "schema-audit",
] as const;

function isSeoWorkflow(value: string): value is SeoWorkflow {
  return (SEO_WORKFLOWS as readonly string[]).includes(value);
}

const POLICY_CLASSES = ["auto-safe", "human-approve"] as const;
type PolicyClass = (typeof POLICY_CLASSES)[number];

function isPolicyClass(value: string): value is PolicyClass {
  return (POLICY_CLASSES as readonly string[]).includes(value);
}

const EVIDENCE_GRADES = ["verified", "primary-unverified", "single-source"] as const;
type EvidenceGrade = (typeof EVIDENCE_GRADES)[number];

function isEvidenceGrade(value: string): value is EvidenceGrade {
  return (EVIDENCE_GRADES as readonly string[]).includes(value);
}

// ── Field extraction ───────────────────────────────────────────────

type FieldName =
  | "Title"
  | "Workflows"
  | "Tactic"
  | "Invariant"
  | "PrimarySourceUrl"
  | "PolicyClass"
  | "EvidenceGrade"
  | "Keywords";

const LABEL_RE =
  /^-\s+\*\*(Title|Workflows|Tactic|Invariant|PrimarySourceUrl|PolicyClass|EvidenceGrade|Keywords):\*\*\s*(.*)$/;

function extractLabelledFields(block: string): Partial<Record<FieldName, string>> {
  const fields: Partial<Record<FieldName, string>> = {};
  for (const rawLine of block.split("\n")) {
    const match = LABEL_RE.exec(rawLine.trim());
    if (match) fields[match[1] as FieldName] = match[2].trim();
  }
  return fields;
}

// ── Block parsing ───────────────────────────────────────────────────

/**
 * Parse one "### <playbookId>" block. Returns null when the block is
 * DROPPED: empty playbookId, missing Title, missing/empty PrimarySourceUrl
 * (no-uncited-claim), PolicyClass === "never-encode", or an otherwise
 * invalid PolicyClass value.
 */
function parseBlock(block: string, skillRelPath: string): SeoSignature | null {
  const newlineIdx = block.indexOf("\n");
  const playbookId = (newlineIdx === -1 ? block : block.slice(0, newlineIdx)).trim();
  if (playbookId === "") return null;

  const fields = extractLabelledFields(block);

  const title = fields.Title;
  if (!title) return null;

  const primarySourceUrl = fields.PrimarySourceUrl;
  if (!primarySourceUrl) return null; // no-uncited-claim: HARD drop, no default

  const policyClassRaw = fields.PolicyClass;
  if (policyClassRaw === "never-encode") return null; // never-encode: HARD drop
  if (!policyClassRaw || !isPolicyClass(policyClassRaw)) return null;

  const workflows = fields.Workflows
    ? fields.Workflows.split(",")
        .map((w) => w.trim())
        .filter(isSeoWorkflow)
    : [];

  const evidenceGrade =
    fields.EvidenceGrade && isEvidenceGrade(fields.EvidenceGrade) ? fields.EvidenceGrade : "single-source";

  const keywords = fields.Keywords
    ? fields.Keywords.split(",")
        .map((k) => k.trim())
        .filter((k) => k.length > 0)
    : [];

  return {
    playbookId,
    workflows,
    title,
    tactic: fields.Tactic ?? "",
    invariant: fields.Invariant ?? "",
    primarySourceUrl,
    policyClass: policyClassRaw,
    evidenceGrade,
    keywords,
    skillRef: skillRelPath,
  };
}

// ── Public parser ───────────────────────────────────────────────────

export const SeoPlaybookParser = {
  /**
   * Pure and total: parses `markdown` (no fs access), never throws, and
   * returns ONLY the surviving signatures — dropped blocks (uncited or
   * never-encode) are absent from the output entirely.
   */
  parse(markdown: string, skillRelPath: string): SeoSignature[] {
    return SeoPlaybookParser.parseWithDiagnostics(markdown, skillRelPath).signatures;
  },

  /** Same as `parse`, plus a dropped-block count for report-diagnostics auditability. */
  parseWithDiagnostics(markdown: string, skillRelPath: string): { signatures: SeoSignature[]; dropped: number } {
    if (typeof markdown !== "string") return { signatures: [], dropped: 0 };

    const { body } = parseFrontmatter(markdown);
    const blocks = body.split(/^### /m).slice(1);

    const signatures: SeoSignature[] = [];
    for (const block of blocks) {
      const signature = parseBlock(block, skillRelPath);
      if (signature) signatures.push(signature);
    }

    return { signatures, dropped: blocks.length - signatures.length };
  },
};
