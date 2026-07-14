/**
 * Pure priority.md renderer — produces a Dataview-friendly markdown note.
 *
 * PURE: no IO, no re-ranking, no side effects. The judge's array order is
 * consumed verbatim — rank = index + 1.
 *
 * bober: hand-rolled YAML-frontmatter subset (flat scalars only).
 *        Mirror of lab-note.ts approach — never import that module.
 *        Swap for a vetted YAML library if quoted strings or nested objects are required.
 */

import type { Finding } from "./finding.js";

// ── Cell helpers ──────────────────────────────────────────────────────

/**
 * Escape pipe characters and strip embedded newlines from a table cell value
 * so the Markdown table stays valid for Dataview readers.
 */
function cellValue(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

// ── renderPriorityMd ──────────────────────────────────────────────────

/**
 * Render a ranked Finding[] into a Dataview-friendly priority.md string.
 *
 * @param ranked     Ordered findings from rankFindings() — order is preserved verbatim (no re-sort).
 * @param scopeLabel Human-readable scope label for the frontmatter (e.g. "general", "decide: X vs Y").
 * @param now        Injected clock — used for generatedAt. Never call new Date() here.
 * @returns          Markdown string: YAML frontmatter + Dataview table + per-finding rationale.
 */
export function renderPriorityMd(
  ranked: Finding[],
  scopeLabel: string,
  now: Date,
): string {
  // ── Hand-rolled YAML frontmatter ──────────────────────────────────
  const lines: string[] = ["---"];
  lines.push(`generatedAt: ${now.toISOString()}`);
  lines.push(`scope: ${scopeLabel}`);
  lines.push(`count: ${ranked.length}`);
  lines.push("---");
  lines.push("");

  // ── Dataview-friendly markdown table ─────────────────────────────
  lines.push("| rank | title | domain | kind | urgency | severity | dueBy |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");

  for (let i = 0; i < ranked.length; i++) {
    const f = ranked[i]!;
    const rank = i + 1;
    const dueBy = f.dueBy !== undefined ? f.dueBy : "";
    lines.push(
      `| ${rank} | ${cellValue(f.title)} | ${cellValue(f.domain)} | ${f.kind} | ${f.urgency} | ${f.severity} | ${dueBy} |`,
    );
  }

  lines.push("");

  // ── Per-finding rationale / evidence ─────────────────────────────
  for (let i = 0; i < ranked.length; i++) {
    const f = ranked[i]!;
    const rank = i + 1;
    lines.push(`### ${rank}. ${f.title}`);
    lines.push("");
    if (f.evidence.length > 0) {
      for (const ev of f.evidence) {
        lines.push(`- ${ev}`);
      }
    } else {
      lines.push("- (no evidence recorded)");
    }
    lines.push("");
  }

  return lines.join("\n");
}
