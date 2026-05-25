/**
 * Renderer for `curator-briefing` artifacts.
 *
 * Extracts: title (H1), contract id, section count, first 3 lines of sprint summary,
 * and file path citation count. Caps output at 300 lines.
 *
 * Pure function — no I/O. Mechanisms must preload file content into artifact.content.
 *
 * Sprint 11 — colocated in renderers/ per mechanisms/ precedent.
 */

import {
  applyLineCap,
  extractH1,
  countH2Sections,
  firstNNonBlankAfter,
  extractMarkdownContent,
} from "./_util.js";

/**
 * Render a `curator-briefing` artifact as markdown.
 */
export function renderCuratorBriefing(artifact: unknown): string {
  const { content, path } = extractMarkdownContent(artifact);

  const title = extractH1(content) ?? "(untitled briefing)";

  // Extract contract id from `**Contract:** \`<id>\``
  const contractMatch = /\*\*Contract:\*\*\s+`([^`]+)`/.exec(content);
  const contractId = contractMatch ? contractMatch[1] : "unknown";

  const sectionCount = countH2Sections(content);

  // First 3 lines of ## 0. Sprint Summary body
  const sprintSummary = firstNNonBlankAfter(content, 3, /^##\s+0\.\s+Sprint Summary/i);

  // Count file path references (backtick-quoted paths starting with . or src/)
  const filePathMatches = content.match(/`(?:\.bober|src\/)[^`]+`/g);
  const filePathCount = filePathMatches ? filePathMatches.length : 0;

  const lines: string[] = [
    `## Curator Briefing: ${title}`,
    ``,
    `- **Contract:** \`${contractId}\``,
    `- **Sections:** ${sectionCount}`,
    `- **File paths cited:** ${filePathCount}`,
    ``,
    `### Sprint summary (first 3 lines)`,
    ...sprintSummary,
    ``,
  ];

  return applyLineCap(lines.join("\n"), 300, path);
}
