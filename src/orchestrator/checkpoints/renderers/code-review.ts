/**
 * Renderer for `code-review` artifacts.
 *
 * Shows: summary, critical count + first 5 with evidence (file:line),
 * important count, minor count, approved areas. Caps output at 300 lines.
 *
 * Pure function — no I/O. Receives the parsed ReviewResult object directly.
 *
 * Sprint 11 — colocated in renderers/ per mechanisms/ precedent.
 */

import { applyLineCap } from "./_util.js";

interface ReviewEvidenceItem {
  path?: string;
  line?: number;
  snippet?: string;
}

interface ReviewFindingLike {
  description?: string;
  evidence?: ReviewEvidenceItem[];
  antiPattern?: string;
  source?: string;
}

interface ReviewResultLike {
  type?: string;
  reviewId?: string;
  contractId?: string;
  summary?: string;
  critical?: ReviewFindingLike[];
  important?: ReviewFindingLike[];
  minor?: ReviewFindingLike[];
  approvedAreas?: string[];
}

/**
 * Format a ReviewFinding bullet with evidence citation (file:line).
 * Per AGENTS.md, every finding must cite file:line.
 */
function formatFinding(f: ReviewFindingLike): string {
  const ev = f.evidence?.[0];
  const citation = ev ? ` — \`${ev.path ?? "?"}:${ev.line ?? "?"}\`` : "";
  const desc = f.description ?? "(no description)";
  return `- ${desc}${citation}`;
}

/**
 * Render a `code-review` artifact as markdown.
 */
export function renderCodeReview(artifact: unknown): string {
  const r = (artifact ?? {}) as ReviewResultLike;
  const critical = r.critical ?? [];
  const important = r.important ?? [];
  const minor = r.minor ?? [];
  const approvedAreas = r.approvedAreas ?? [];

  const lines: string[] = [
    `## Code Review`,
    ``,
  ];

  if (r.contractId) {
    lines.push(`**Contract:** \`${r.contractId}\``);
    lines.push(``);
  }

  if (r.summary) {
    lines.push(`### Summary`);
    lines.push(r.summary);
    lines.push(``);
  }

  lines.push(`### Findings`);
  lines.push(``);
  lines.push(`- **Critical:** ${critical.length}`);
  lines.push(`- **Important:** ${important.length}`);
  lines.push(`- **Minor:** ${minor.length}`);
  lines.push(``);

  if (critical.length > 0) {
    lines.push(`### Critical findings (first 5)`);
    for (const f of critical.slice(0, 5)) {
      lines.push(formatFinding(f));
    }
    lines.push(``);
  }

  if (approvedAreas.length > 0) {
    lines.push(`### Approved areas`);
    for (const area of approvedAreas) {
      lines.push(`- ${area}`);
    }
    lines.push(``);
  }

  return applyLineCap(lines.join("\n"), 300);
}
