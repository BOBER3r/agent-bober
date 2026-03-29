/**
 * Scanner: Documentation
 *
 * Reads key documentation files from the project root and stores
 * their content truncated to 2000 characters each.
 *
 * Files scanned:
 * - README.md
 * - CONTRIBUTING.md
 * - CLAUDE.md
 * - .cursorrules
 * - .github/PULL_REQUEST_TEMPLATE.md
 * - docs/**\/*.md
 */

import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { glob } from "glob";
import { fileExists } from "../../utils/fs.js";
import type { DocumentationReport, DocFile } from "../types.js";

// ── Constants ─────────────────────────────────────────────────────

const MAX_CONTENT_LENGTH = 2000;

/** Fixed documentation files to always attempt reading. */
const FIXED_DOC_FILES = [
  "README.md",
  "CONTRIBUTING.md",
  "CLAUDE.md",
  ".cursorrules",
  ".github/PULL_REQUEST_TEMPLATE.md",
];

// ── Helpers ───────────────────────────────────────────────────────

async function readDocFile(
  projectRoot: string,
  relPath: string,
): Promise<DocFile | null> {
  const fullPath = join(projectRoot, relPath);
  if (!(await fileExists(fullPath))) {
    return null;
  }

  try {
    const raw = await readFile(fullPath, "utf-8");
    const truncated = raw.length > MAX_CONTENT_LENGTH;
    return {
      path: relPath,
      content: truncated ? raw.slice(0, MAX_CONTENT_LENGTH) : raw,
      truncated,
    };
  } catch {
    return null;
  }
}

// ── Main scanner ──────────────────────────────────────────────────

export async function scanDocumentation(
  projectRoot: string,
): Promise<DocumentationReport> {
  const files: DocFile[] = [];
  const seenPaths = new Set<string>();

  // Read fixed doc files first
  for (const relPath of FIXED_DOC_FILES) {
    const docFile = await readDocFile(projectRoot, relPath);
    if (docFile) {
      files.push(docFile);
      seenPaths.add(relPath);
    }
  }

  // Scan docs/**/*.md
  try {
    const docsGlob = await glob("docs/**/*.md", {
      cwd: projectRoot,
      absolute: true,
    });

    // Sort alphabetically for deterministic ordering
    const sortedDocs = docsGlob.sort();

    for (const fullPath of sortedDocs) {
      const relPath = relative(projectRoot, fullPath);
      if (seenPaths.has(relPath)) continue;

      try {
        const raw = await readFile(fullPath, "utf-8");
        const truncated = raw.length > MAX_CONTENT_LENGTH;
        files.push({
          path: relPath,
          content: truncated ? raw.slice(0, MAX_CONTENT_LENGTH) : raw,
          truncated,
        });
        seenPaths.add(relPath);
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // docs/ directory may not exist — that's fine
  }

  return { files };
}
