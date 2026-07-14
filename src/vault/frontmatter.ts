/**
 * Frontmatter parse / serialize — PURE functions for Obsidian YAML frontmatter.
 *
 * Covers the documented Dataview conventions:
 *   - string scalars (unquoted)
 *   - number scalars (integer or float, including negative)
 *   - ISO-8601 date strings — kept as strings, never coerced to Date
 *   - block-style lists (`- item` under the key line)
 *   - inline-style lists (`[a, b, c]`)
 *   - status enum strings (e.g. "active", "superseded") — just strings
 *
 * PURE: Never calls Date.now() or new Date() — no clock dependency.
 *       Never touches the filesystem — no fs or network imports.
 *
 * bober: hand-rolled YAML subset — covers the six Dataview scalar/list
 *        conventions documented above. Quoted strings, nested objects, and
 *        multi-line scalars are NOT supported. Swap for a vetted YAML library
 *        if those are needed.
 */

import type { VaultNote } from "./types.js";

// ── Scalar parsing ──────────────────────────────────────────────────

/** Matches an integer or float (with optional leading minus), no surrounding dashes. */
const NUM_REGEX = /^-?\d+(\.\d+)?$/;

/** Matches an inline YAML list: `[item1, item2, ...]`. */
const INLINE_LIST_REGEX = /^\[(.+)\]$/;

/** Matches a block list item line: optional leading whitespace then `- `. */
const BLOCK_ITEM_REGEX = /^\s+-\s/;

/**
 * Parse a raw scalar string (already trimmed) to its typed value.
 * Number stays numeric; everything else stays a string.
 */
function parseScalar(raw: string): string | number {
  if (NUM_REGEX.test(raw)) {
    return Number(raw);
  }
  return raw;
}

// ── YAML frontmatter parser ─────────────────────────────────────────

/**
 * Parse the leading YAML frontmatter block and return the structured
 * frontmatter together with the verbatim body that follows.
 *
 * If the input does not begin with `---`, returns `{ frontmatter: {}, body: raw }`.
 */
export function parseFrontmatter(raw: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const lines = raw.split("\n");

  if (lines[0]?.trim() !== "---") {
    return { frontmatter: {}, body: raw };
  }

  // Find the closing `---` delimiter (must be at least line 1).
  let closingIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      closingIdx = i;
      break;
    }
  }

  if (closingIdx === -1) {
    // No closing delimiter — treat the whole content as body.
    return { frontmatter: {}, body: raw };
  }

  const yamlLines = lines.slice(1, closingIdx);
  // Body: everything after the closing delimiter line, joined back.
  const body = lines.slice(closingIdx + 1).join("\n");

  const frontmatter: Record<string, unknown> = {};
  let i = 0;

  while (i < yamlLines.length) {
    const line = yamlLines[i];

    // Skip blank lines or lines that don't look like key: ... entries.
    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) {
      i++;
      continue;
    }

    const key = line.slice(0, colonIdx).trim();
    if (key === "") {
      i++;
      continue;
    }

    const rawVal = line.slice(colonIdx + 1).trim();

    if (rawVal === "") {
      // Could be a block list or an empty value.
      const listItems: string[] = [];
      let j = i + 1;
      while (j < yamlLines.length && BLOCK_ITEM_REGEX.test(yamlLines[j])) {
        // Strip the leading `- ` (with any surrounding whitespace).
        listItems.push(yamlLines[j].replace(/^\s*-\s+/, "").trim());
        j++;
      }
      if (listItems.length > 0) {
        frontmatter[key] = listItems;
        i = j;
        continue;
      }
      // Empty value — store as empty string.
      frontmatter[key] = "";
      i++;
      continue;
    }

    // Check for an inline list: `[a, b, c]`.
    const inlineMatch = INLINE_LIST_REGEX.exec(rawVal);
    if (inlineMatch !== null) {
      frontmatter[key] = inlineMatch[1].split(",").map((s) => s.trim());
      i++;
      continue;
    }

    frontmatter[key] = parseScalar(rawVal);
    i++;
  }

  return { frontmatter, body };
}

// ── YAML frontmatter serializer ─────────────────────────────────────

/**
 * Serialize a frontmatter object and body back to a complete note string.
 *
 * Produces `---\n<yaml>\n---\n<body>`. Array values are serialized as
 * block-style lists (one `  - item` line per element).
 */
export function serializeFrontmatter(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const lines: string[] = ["---"];

  for (const [key, val] of Object.entries(frontmatter)) {
    if (Array.isArray(val)) {
      lines.push(`${key}:`);
      for (const item of val as unknown[]) {
        lines.push(`  - ${String(item)}`);
      }
    } else {
      lines.push(`${key}: ${String(val)}`);
    }
  }

  lines.push("---");
  return lines.join("\n") + "\n" + body;
}

// ── VaultNote helpers ───────────────────────────────────────────────

/**
 * Parse a raw note string into a `VaultNote`.
 * The `path` parameter is stored verbatim — no filesystem access occurs here.
 */
export function parseNote(raw: string, path: string): VaultNote {
  const { frontmatter, body } = parseFrontmatter(raw);
  return { frontmatter, body, path };
}

/**
 * Serialize a `VaultNote` back to a raw string suitable for writing to disk.
 */
export function serializeNote(note: VaultNote): string {
  return serializeFrontmatter(note.frontmatter, note.body);
}
