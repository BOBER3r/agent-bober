/**
 * Scanner: Code Conventions
 *
 * Samples up to 20 source files per file category and detects:
 * - File naming patterns (camelCase / kebab-case / PascalCase / snake_case)
 * - Import style (relative vs absolute/alias, .js extensions)
 * - Export patterns (named vs default)
 * - TypeScript patterns (any, ts-ignore, enum, interface, type)
 */

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { glob } from "glob";
import type {
  CodeConventionsReport,
  FileNamingStyle,
  FileNamingReport,
  ImportStyleReport,
  ExportStyleReport,
  TypeScriptPatternsReport,
} from "../types.js";

// ── Constants ─────────────────────────────────────────────────────

/** Directories to skip when scanning. */
const IGNORE_DIRS = [
  "node_modules",
  "dist",
  ".git",
  ".bober",
  "build",
  "coverage",
  ".next",
  "__pycache__",
  ".turbo",
  ".cache",
  "out",
  ".vercel",
];

const MAX_FILES_PER_CATEGORY = 20;

// ── File naming detection ─────────────────────────────────────────

const KEBAB_CASE_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/;
const PASCAL_CASE_RE = /^[A-Z][a-zA-Z0-9]*$/;
const CAMEL_CASE_RE = /^[a-z][a-zA-Z0-9]*$/;
const SNAKE_CASE_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;

function detectFileNaming(name: string): FileNamingStyle {
  if (KEBAB_CASE_RE.test(name)) return "kebab-case";
  if (PASCAL_CASE_RE.test(name)) return "PascalCase";
  if (SNAKE_CASE_RE.test(name)) return "snake_case";
  if (CAMEL_CASE_RE.test(name)) return "camelCase";
  return "mixed";
}

function analyzeFileNaming(filePaths: string[]): FileNamingReport {
  const counts: Record<FileNamingStyle, number> = {
    camelCase: 0,
    "kebab-case": 0,
    PascalCase: 0,
    snake_case: 0,
    mixed: 0,
  };

  for (const filePath of filePaths) {
    const name = basename(filePath, extname(filePath));
    // Remove test suffixes for more accurate naming analysis
    const cleanName = name.replace(/\.(test|spec)$/, "");
    // Also handle multi-dot names like "foo.test"
    const baseName = cleanName.split(".")[0] ?? cleanName;
    if (baseName) {
      const style = detectFileNaming(baseName);
      counts[style]++;
    }
  }

  // Find dominant style (excluding "mixed")
  let dominant: FileNamingStyle = "mixed";
  let maxCount = 0;
  for (const [style, count] of Object.entries(counts) as [FileNamingStyle, number][]) {
    if (style !== "mixed" && count > maxCount) {
      dominant = style;
      maxCount = count;
    }
  }

  return { dominant, counts };
}

// ── Import style detection ────────────────────────────────────────

const RELATIVE_RE = /^\.\.?\//;
const JS_EXT_RE = /\.js['"]?\s*$/;

function analyzeImportStyle(contents: string[]): ImportStyleReport {
  let relativeCount = 0;
  let absoluteCount = 0;
  let jsExtCount = 0;
  let totalImports = 0;
  const examples: string[] = [];

  for (const content of contents) {
    const importLines = content.match(/^import\s+.+$/gm) ?? [];
    for (const line of importLines) {
      const match = /from\s+['"]([^'"]+)['"]/.exec(line);
      if (!match) continue;
      const importPath = match[1];
      if (!importPath) continue;
      totalImports++;

      if (RELATIVE_RE.test(importPath)) {
        relativeCount++;
      } else {
        absoluteCount++;
      }

      if (JS_EXT_RE.test(importPath)) {
        jsExtCount++;
      }

      if (examples.length < 5) {
        examples.push(line.trim());
      }
    }
  }

  return {
    relativeCount,
    absoluteCount,
    usesJsExtensions: totalImports > 0 && jsExtCount / totalImports >= 0.3,
    examples,
  };
}

// ── Export style detection ────────────────────────────────────────

const NAMED_EXPORT_RE = /^export\s+(const|function|class|interface|type|enum|let|var)\s/gm;
const DEFAULT_EXPORT_RE = /^export\s+default\s/gm;

function analyzeExportStyle(contents: string[]): ExportStyleReport {
  let namedExportCount = 0;
  let defaultExportCount = 0;

  for (const content of contents) {
    const named = content.match(NAMED_EXPORT_RE);
    const defaults = content.match(DEFAULT_EXPORT_RE);
    namedExportCount += named?.length ?? 0;
    defaultExportCount += defaults?.length ?? 0;
  }

  let dominant: "named" | "default" | "mixed";
  const total = namedExportCount + defaultExportCount;
  if (total === 0) {
    dominant = "mixed";
  } else if (namedExportCount / total >= 0.7) {
    dominant = "named";
  } else if (defaultExportCount / total >= 0.7) {
    dominant = "default";
  } else {
    dominant = "mixed";
  }

  return { namedExportCount, defaultExportCount, dominant };
}

// ── TypeScript patterns detection ─────────────────────────────────

function analyzeTypeScriptPatterns(
  contents: string[],
): TypeScriptPatternsReport {
  let anyCount = 0;
  let tsIgnoreCount = 0;
  let enumCount = 0;
  let interfaceCount = 0;
  let typeAliasCount = 0;

  for (const content of contents) {
    // Count `: any` usages (avoid counting "anyCount" variable names etc)
    const anyMatches = content.match(/:\s*any[\s;,)>]/g);
    anyCount += anyMatches?.length ?? 0;

    const tsIgnoreMatches = content.match(/@ts-(ignore|expect-error)/g);
    tsIgnoreCount += tsIgnoreMatches?.length ?? 0;

    const enumMatches = content.match(/\benum\s+\w+/g);
    enumCount += enumMatches?.length ?? 0;

    const interfaceMatches = content.match(/\binterface\s+\w+/g);
    interfaceCount += interfaceMatches?.length ?? 0;

    const typeAliasMatches = content.match(/\btype\s+\w+\s*=/g);
    typeAliasCount += typeAliasMatches?.length ?? 0;
  }

  return { anyCount, tsIgnoreCount, enumCount, interfaceCount, typeAliasCount };
}

// ── Main scanner ──────────────────────────────────────────────────

export async function scanCodeConventions(
  projectRoot: string,
): Promise<CodeConventionsReport | null> {
  const ignore = IGNORE_DIRS.map((d) => `**/${d}/**`);

  // Gather TypeScript/JavaScript files
  let tsFiles: string[];
  let jsFiles: string[];

  try {
    tsFiles = await glob("**/*.{ts,tsx}", {
      cwd: projectRoot,
      ignore,
      absolute: true,
    });
    jsFiles = await glob("**/*.{js,jsx}", {
      cwd: projectRoot,
      ignore,
      absolute: true,
    });
  } catch {
    return null;
  }

  // Exclude test files from naming analysis (but include in content analysis)
  const sourceFiles = [...tsFiles, ...jsFiles]
    .sort()
    .slice(0, MAX_FILES_PER_CATEGORY * 2);

  if (sourceFiles.length === 0) {
    return null;
  }

  // Read file contents
  const contents: string[] = [];
  for (const filePath of sourceFiles.slice(0, MAX_FILES_PER_CATEGORY * 2)) {
    try {
      const content = await readFile(filePath, "utf-8");
      contents.push(content);
    } catch {
      // Skip unreadable files
    }
  }

  const isTypeScript = tsFiles.length > 0;

  return {
    filesSampled: sourceFiles.length,
    fileNaming: analyzeFileNaming(sourceFiles),
    importStyle: analyzeImportStyle(contents),
    exportStyle: analyzeExportStyle(contents),
    typescriptPatterns: isTypeScript
      ? analyzeTypeScriptPatterns(contents)
      : null,
  };
}
