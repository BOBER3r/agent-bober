/**
 * Shared utilities for per-artifact-type renderers.
 *
 * Private to the renderers/ directory — not re-exported from registry.ts.
 * All functions are pure (no I/O, no side effects).
 *
 * Sprint 11 — colocated in renderers/ per mechanisms/ precedent.
 */

/**
 * Apply a line cap to rendered content.
 * If content exceeds maxLines, truncates with the canonical truncation marker:
 *   `... <N more lines truncated, see <path>:<startLine> for full content>`
 * When no source path is available, falls back to:
 *   `... <N more lines truncated>`
 */
export function applyLineCap(
  content: string,
  maxLines: number,
  sourcePath?: string,
): string {
  const lines = content.split("\n");
  if (lines.length <= maxLines) return content;
  const kept = lines.slice(0, maxLines);
  const dropped = lines.length - maxLines;
  const startLine = maxLines + 1;
  const pathHint = sourcePath
    ? ` see ${sourcePath}:${startLine} for full content`
    : "";
  kept.push(`... <${dropped} more lines truncated,${pathHint}>`);
  return kept.join("\n");
}

/**
 * Extract the first H1 heading from markdown content.
 * Returns null if no H1 is found.
 */
export function extractH1(content: string): string | null {
  for (const line of content.split("\n")) {
    const m = /^#\s+(.+)$/.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * Count list items (lines starting with `- `) under a given section heading.
 * Stops counting when another heading of equal or higher level is encountered.
 */
export function countSectionItems(content: string, sectionName: string): number {
  const lines = content.split("\n");
  let inSection = false;
  let count = 0;

  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      if (inSection) {
        // Encountered next heading — stop
        break;
      }
      if (headingMatch[2].trim().toLowerCase().includes(sectionName.toLowerCase())) {
        inSection = true;
      }
      continue;
    }
    if (inSection && /^\s*[-*]\s+/.test(line)) {
      count++;
    }
  }
  return count;
}

/**
 * Count the number of sections (headings) at level 2 (`## `) in the content.
 */
export function countH2Sections(content: string): number {
  return content.split("\n").filter((l) => /^##\s+/.test(l)).length;
}

/**
 * Extract the first N non-blank lines after a line matching the given separator pattern.
 * If separator is not found, returns the first N non-blank lines of the content.
 */
export function firstNNonBlankAfter(
  content: string,
  n: number,
  separatorPattern: RegExp,
): string[] {
  const lines = content.split("\n");
  let afterSep = false;
  const result: string[] = [];

  for (const line of lines) {
    if (!afterSep) {
      if (separatorPattern.test(line)) {
        afterSep = true;
      }
      continue;
    }
    if (line.trim() !== "") {
      result.push(line);
      if (result.length >= n) break;
    }
  }

  // Fallback: if separator not found, take first N non-blank lines
  if (!afterSep) {
    for (const line of lines) {
      if (line.trim() !== "") {
        result.push(line);
        if (result.length >= n) break;
      }
    }
  }

  return result;
}

/**
 * Parse an inline count from a markdown line matching a pattern.
 * Returns null if not found.
 */
export function parseInlineCount(content: string, pattern: RegExp): number | null {
  const m = pattern.exec(content);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return isNaN(n) ? null : n;
}

/**
 * Extract content and path from an artifact.
 * Handles shapes: { content }, { text }, { path, content }, { path }
 * Does NOT perform file I/O — mechanisms must preload content.
 */
export function extractMarkdownContent(artifact: unknown): {
  content: string;
  path: string | undefined;
} {
  const a = artifact as Record<string, unknown> | null | undefined;
  if (!a || typeof a !== "object") {
    return { content: "", path: undefined };
  }
  const path = typeof a["path"] === "string" ? a["path"] : undefined;
  let content = "";
  if (typeof a["content"] === "string") {
    content = a["content"];
  } else if (typeof a["text"] === "string") {
    content = a["text"];
  }
  return { content, path };
}
