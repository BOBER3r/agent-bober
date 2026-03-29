/**
 * Type definitions for the deep programmatic codebase scanner.
 *
 * DiscoveryReport is the top-level output of scanProject().
 * All sections are optional -- a graceful failure in a sub-scanner
 * produces a null/empty section, not a thrown error.
 */

// ── Package Scripts ───────────────────────────────────────────────

/** Bober command categories mapped from package.json scripts. */
export interface CommandMapping {
  /** Script name in package.json (e.g. "build", "test:watch"). */
  scriptName: string;
  /** Actual command string (e.g. "tsc", "vitest run"). */
  command: string;
  /** Full run command including package manager prefix (e.g. "npm run build"). */
  runCommand: string;
}

export type BoberCommandCategory =
  | "build"
  | "test"
  | "lint"
  | "typecheck"
  | "dev"
  | "install";

export interface PackageScriptsReport {
  /** Detected package manager. */
  packageManager: "npm" | "yarn" | "pnpm" | "bun" | null;
  /** All scripts from package.json. */
  allScripts: Record<string, string>;
  /** Scripts mapped to bober categories. */
  categorized: Partial<Record<BoberCommandCategory, CommandMapping>>;
}

// ── CI Checks ─────────────────────────────────────────────────────

export type CICategory = "test" | "lint" | "build" | "deploy" | "other";

export interface CIStep {
  /** Name of the CI step if present. */
  name: string | null;
  /** The run command extracted from the step. */
  runCommand: string;
  /** Inferred category. */
  category: CICategory;
}

export interface CIWorkflow {
  /** Relative path to the workflow file (e.g. ".github/workflows/ci.yml"). */
  file: string;
  steps: CIStep[];
}

export interface CIChecksReport {
  workflows: CIWorkflow[];
  /** Flat list of all unique run commands across all workflows. */
  allRunCommands: string[];
}

// ── Git Conventions ───────────────────────────────────────────────

export interface GitConventionsReport {
  /** Whether conventional commits (feat:, fix:, etc.) are detected. */
  usesConventionalCommits: boolean;
  /** Most common commit prefix pattern (e.g. "bober(", "feat:", "TICKET-"). */
  mostCommonPrefix: string | null;
  /** Raw sample of recent commit messages (last 50). */
  recentMessages: string[];
  /** Detected branch naming patterns (e.g. "feature/*", "bober/*"). */
  branchPatterns: string[];
  /** All branch names from git branch -a. */
  branches: string[];
  /** Whether the repo has a linear history (no merge commits). */
  hasLinearHistory: boolean;
  /** Ratio of merge commits among sampled commits (0-1). */
  mergeCommitRatio: number;
}

// ── Code Conventions ──────────────────────────────────────────────

export type FileNamingStyle = "camelCase" | "kebab-case" | "PascalCase" | "snake_case" | "mixed";

export interface FileNamingReport {
  dominant: FileNamingStyle;
  counts: Record<FileNamingStyle, number>;
}

export interface ImportStyleReport {
  /** Count of relative imports (e.g. ./foo, ../bar). */
  relativeCount: number;
  /** Count of absolute/alias imports (e.g. @/components, src/utils). */
  absoluteCount: number;
  /** Whether imports use .js extensions (common in ESM TypeScript). */
  usesJsExtensions: boolean;
  /** Example import lines (up to 5). */
  examples: string[];
}

export interface ExportStyleReport {
  namedExportCount: number;
  defaultExportCount: number;
  /** Dominant style. */
  dominant: "named" | "default" | "mixed";
}

export interface TypeScriptPatternsReport {
  /** Number of `any` usages across sampled files. */
  anyCount: number;
  /** Number of `@ts-ignore` / `@ts-expect-error` usages. */
  tsIgnoreCount: number;
  /** Number of `enum` declarations. */
  enumCount: number;
  /** Number of `interface` declarations. */
  interfaceCount: number;
  /** Number of `type` alias declarations. */
  typeAliasCount: number;
}

export interface CodeConventionsReport {
  /** Total source files sampled. */
  filesSampled: number;
  fileNaming: FileNamingReport;
  importStyle: ImportStyleReport;
  exportStyle: ExportStyleReport;
  typescriptPatterns: TypeScriptPatternsReport | null;
}

// ── Test Conventions ──────────────────────────────────────────────

export type TestFramework = "vitest" | "jest" | "mocha" | "jasmine" | "pytest" | "unknown";
export type MockingLibrary = "vitest" | "jest" | "sinon" | "testdouble" | "none" | "unknown";

export interface TestConventionsReport {
  framework: TestFramework;
  /** Dominant test file naming pattern (e.g. "*.test.ts", "*.spec.ts"). */
  filePattern: "*.test.ts" | "*.spec.ts" | "*.test.js" | "*.spec.js" | "mixed" | "unknown";
  /** Whether test files are colocated with source (true) or in a separate dir (false). */
  colocated: boolean;
  /** Test directories found (e.g. ["__tests__", "test", "tests"]). */
  testDirs: string[];
  mockingLibrary: MockingLibrary;
  /** Whether a coverage config was detected. */
  hasCoverageConfig: boolean;
  /** Total test files found. */
  testFileCount: number;
}

// ── Documentation ─────────────────────────────────────────────────

export interface DocFile {
  /** Relative path from project root. */
  path: string;
  /** Content truncated to 2000 chars. */
  content: string;
  /** Whether the content was truncated. */
  truncated: boolean;
}

export interface DocumentationReport {
  files: DocFile[];
}

// ── Detected Stack ─────────────────────────────────────────────────

export interface DetectedStackReport {
  hasTypescript: boolean;
  hasReact: boolean;
  hasNext: boolean;
  hasVite: boolean;
  hasPlaywright: boolean;
  hasEslint: boolean;
  hasVitest: boolean;
  hasJest: boolean;
  hasPython: boolean;
  hasRust: boolean;
  hasNestjs: boolean;
  hasFastify: boolean;
  hasExpress: boolean;
  /** Primary language detected. */
  primaryLanguage: "typescript" | "javascript" | "python" | "rust" | "unknown";
}

// ── Top-Level Report ──────────────────────────────────────────────

export interface DiscoveryReport {
  /** Absolute path to the scanned project root. */
  projectRoot: string;
  /** ISO timestamp of the scan. */
  scannedAt: string;
  packageScripts: PackageScriptsReport | null;
  packageManager: "npm" | "yarn" | "pnpm" | "bun" | null;
  ciChecks: CIChecksReport;
  gitConventions: GitConventionsReport | null;
  codeConventions: CodeConventionsReport | null;
  testConventions: TestConventionsReport | null;
  documentation: DocumentationReport;
  detectedStack: DetectedStackReport | null;
}
