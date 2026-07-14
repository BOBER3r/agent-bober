import type { VulnClass, FindingSeverity } from "../security-audit-types.js";
import { ALL_VULN_CLASSES } from "../stack-knowledge.js";
import { parseFrontmatter } from "../../vault/frontmatter.js";
import type { SecuritySignature, SecurityStackId } from "./signature.js";

/**
 * Total parser turning a security skill file's markdown into typed
 * SecuritySignature[] records (arch-20260712-security-audit-agent-team-architecture.md).
 *
 * Block format (mirrored in skills/bober.security-generic/SKILL.md's
 * "## Signature Block Format" section — the two are one executable spec):
 *
 *   ### <signatureId>
 *   - **Title:** <human-readable title>
 *   - **CWE:** CWE-xx                (optional — omit for cwe: null)
 *   - **Severity:** critical|high|medium|low|info
 *   - **VulnClass:** <a VulnClass union member, verbatim>
 *   - **Invariant:** <the safety invariant this signature protects>
 *   - **Keywords:** comma, separated, keywords
 *
 *   **Unsafe:**
 *   ```ts
 *   <unsafe example>
 *   ```
 *
 *   **Safe:**
 *   ```ts
 *   <safe example>
 *   ```
 *
 * A block is split on a `### ` heading (heading text, trimmed, is the signatureId).
 * Required: non-empty signatureId, Title, a VulnClass that is an ALL_VULN_CLASSES
 * member, a valid Severity, and non-empty Unsafe/Safe fenced examples — any one
 * missing/invalid drops the whole block. Mirrors parseSlitherOutput's defensive
 * narrowing (security-scanners.ts:144-201): guard input type, `continue`/drop past
 * malformed blocks, never throw, return the parseable subset.
 */

// ── Type guards (mirror isVulnClass at security-scanners.ts:74-76) ───

function isVulnClass(value: string): value is VulnClass {
  return (ALL_VULN_CLASSES as string[]).includes(value);
}

const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;

function isSeverity(value: string): value is FindingSeverity {
  return (SEVERITIES as readonly string[]).includes(value);
}

// ── Field extraction ───────────────────────────────────────────────

type FieldName = "Title" | "CWE" | "Severity" | "VulnClass" | "Invariant" | "Keywords";

const LABEL_RE = /^-\s+\*\*(Title|CWE|Severity|VulnClass|Invariant|Keywords):\*\*\s*(.*)$/;

function extractLabelledFields(block: string): Partial<Record<FieldName, string>> {
  const fields: Partial<Record<FieldName, string>> = {};
  for (const rawLine of block.split("\n")) {
    const match = LABEL_RE.exec(rawLine.trim());
    if (match) fields[match[1] as FieldName] = match[2].trim();
  }
  return fields;
}

/**
 * Extract the fenced code body following a labelled marker (e.g. "**Unsafe:**").
 * Returns null when the marker, opening fence, or closing fence is missing —
 * covers a truncated/unclosed code fence without throwing.
 */
function extractFencedExample(block: string, marker: string): string | null {
  const markerIdx = block.indexOf(marker);
  if (markerIdx === -1) return null;

  const afterMarker = block.slice(markerIdx + marker.length);
  const fenceOpenIdx = afterMarker.indexOf("```");
  if (fenceOpenIdx === -1) return null;

  const afterFenceOpen = afterMarker.slice(fenceOpenIdx + 3);
  const infoLineEnd = afterFenceOpen.indexOf("\n");
  if (infoLineEnd === -1) return null; // opening fence never closed with a newline

  const body = afterFenceOpen.slice(infoLineEnd + 1);
  const fenceCloseIdx = body.indexOf("```");
  if (fenceCloseIdx === -1) return null; // truncated/unclosed fence

  return body.slice(0, fenceCloseIdx).trim();
}

// ── Block parsing ──────────────────────────────────────────────────

/** Parse one "### <signatureId>" block. Returns null on any missing/invalid required field. */
function parseBlock(stackId: SecurityStackId, block: string, skillRelPath: string): SecuritySignature | null {
  const newlineIdx = block.indexOf("\n");
  const signatureId = (newlineIdx === -1 ? block : block.slice(0, newlineIdx)).trim();
  if (signatureId === "") return null;

  const fields = extractLabelledFields(block);

  const title = fields.Title;
  if (!title) return null;

  const vulnClassRaw = fields.VulnClass;
  if (!vulnClassRaw || !isVulnClass(vulnClassRaw)) return null;

  const severityRaw = fields.Severity;
  if (!severityRaw || !isSeverity(severityRaw)) return null;

  const unsafeExample = extractFencedExample(block, "**Unsafe:**");
  if (!unsafeExample) return null;

  const safeExample = extractFencedExample(block, "**Safe:**");
  if (!safeExample) return null;

  const cwe = fields.CWE && fields.CWE.length > 0 ? fields.CWE : null;
  const keywords = fields.Keywords
    ? fields.Keywords.split(",").map((k) => k.trim()).filter((k) => k.length > 0)
    : [];

  return {
    stackId,
    signatureId,
    title,
    cwe,
    severity: severityRaw,
    vulnClass: vulnClassRaw,
    invariant: fields.Invariant ?? "",
    unsafeExample,
    safeExample,
    keywords,
    skillRef: skillRelPath,
  };
}

// ── Public parser ──────────────────────────────────────────────────

export const SecuritySignatureParser = {
  /**
   * Pure and total: takes markdown text (no fs access), never throws, drops
   * malformed blocks and returns the parseable subset.
   */
  parse(stackId: SecurityStackId, skillMarkdown: string, skillRelPath: string): SecuritySignature[] {
    if (typeof skillMarkdown !== "string") return [];

    const { body } = parseFrontmatter(skillMarkdown);
    const blocks = body.split(/^### /m).slice(1);

    const signatures: SecuritySignature[] = [];
    for (const block of blocks) {
      const signature = parseBlock(stackId, block, skillRelPath);
      if (signature) signatures.push(signature);
    }

    return signatures;
  },
};
