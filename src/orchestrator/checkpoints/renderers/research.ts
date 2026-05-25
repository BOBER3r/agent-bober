/**
 * Renderer for `research` artifacts.
 *
 * Extracts: title (H1), assumptions count, files-explored count, key findings count,
 * and first 3 lines of the executive summary. Caps output at 500 lines.
 *
 * Pure function — no I/O. Mechanisms must preload file content into artifact.content.
 *
 * Sprint 11 — colocated in renderers/ per mechanisms/ precedent.
 */

import {
  applyLineCap,
  extractH1,
  countSectionItems,
  parseInlineCount,
  firstNNonBlankAfter,
  extractMarkdownContent,
} from "./_util.js";

/**
 * Render a `research` artifact as markdown.
 */
export function renderResearch(artifact: unknown): string {
  const { content, path } = extractMarkdownContent(artifact);

  const title = extractH1(content) ?? "(untitled research)";
  const assumptions = countSectionItems(content, "Assumptions");
  const filesExplored =
    parseInlineCount(content, /\*\*Files Explored:\*\*\s+(\d+)/) ??
    parseInlineCount(content, /Files Explored[:\s]+(\d+)/i) ??
    0;
  const findings =
    countSectionItems(content, "Existing Patterns") +
    countSectionItems(content, "Key Findings") +
    countSectionItems(content, "Key files");
  const execSummary = firstNNonBlankAfter(content, 3, /^---$/);

  const lines: string[] = [
    `## Research: ${title}`,
    ``,
    `- **Assumptions:** ${assumptions}`,
    `- **Files explored:** ${filesExplored}`,
    `- **Key findings:** ${findings}`,
    ``,
    `### Executive summary`,
    ...execSummary,
    ``,
  ];

  return applyLineCap(lines.join("\n"), 500, path);
}
