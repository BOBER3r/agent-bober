/**
 * Scanner: Test Conventions
 *
 * Detects test framework, file naming patterns, directory structure,
 * mocking library, and coverage configuration.
 */

import { readFile } from "node:fs/promises";
import { join, dirname, relative } from "node:path";
import { glob } from "glob";
import { fileExists } from "../../utils/fs.js";
import type {
  TestConventionsReport,
  TestFramework,
  MockingLibrary,
} from "../types.js";

// ── Constants ─────────────────────────────────────────────────────

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

// ── Framework detection ───────────────────────────────────────────

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

async function readPackageJson(projectRoot: string): Promise<PackageJson | null> {
  const pkgPath = join(projectRoot, "package.json");
  if (!(await fileExists(pkgPath))) return null;
  try {
    const raw = await readFile(pkgPath, "utf-8");
    return JSON.parse(raw) as PackageJson;
  } catch {
    return null;
  }
}

function detectFramework(pkg: PackageJson | null): TestFramework {
  if (!pkg) return "unknown";

  const allDeps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };

  if ("vitest" in allDeps) return "vitest";
  if ("jest" in allDeps) return "jest";
  if ("mocha" in allDeps) return "mocha";
  if ("jasmine" in allDeps) return "jasmine";
  if ("pytest" in allDeps) return "pytest";

  // Check scripts for clues
  const scripts = pkg.scripts ?? {};
  const testScript = Object.values(scripts).join(" ").toLowerCase();
  if (testScript.includes("vitest")) return "vitest";
  if (testScript.includes("jest")) return "jest";
  if (testScript.includes("mocha")) return "mocha";
  if (testScript.includes("pytest")) return "pytest";

  return "unknown";
}

function detectMockingLibrary(
  pkg: PackageJson | null,
  framework: TestFramework,
): MockingLibrary {
  if (!pkg) return "unknown";

  const allDeps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };

  // vitest and jest have built-in mocking
  if (framework === "vitest") return "vitest";
  if (framework === "jest") return "jest";

  if ("sinon" in allDeps) return "sinon";
  if ("testdouble" in allDeps) return "testdouble";

  return "none";
}

// ── File pattern detection ────────────────────────────────────────

type TestFilePattern =
  | "*.test.ts"
  | "*.spec.ts"
  | "*.test.js"
  | "*.spec.js"
  | "mixed"
  | "unknown";

function detectFilePattern(testFiles: string[]): TestFilePattern {
  let testTs = 0;
  let specTs = 0;
  let testJs = 0;
  let specJs = 0;

  for (const f of testFiles) {
    if (f.endsWith(".test.ts") || f.endsWith(".test.tsx")) testTs++;
    else if (f.endsWith(".spec.ts") || f.endsWith(".spec.tsx")) specTs++;
    else if (f.endsWith(".test.js") || f.endsWith(".test.jsx")) testJs++;
    else if (f.endsWith(".spec.js") || f.endsWith(".spec.jsx")) specJs++;
  }

  const total = testTs + specTs + testJs + specJs;
  if (total === 0) return "unknown";

  const counts: [TestFilePattern, number][] = [
    ["*.test.ts", testTs],
    ["*.spec.ts", specTs],
    ["*.test.js", testJs],
    ["*.spec.js", specJs],
  ];

  const [dominant] = counts.sort((a, b) => b[1] - a[1]);
  if (!dominant) return "unknown";

  // If dominant pattern accounts for >= 80% of test files, use it
  if (dominant[1] / total >= 0.8) return dominant[0];
  return "mixed";
}

// ── Directory structure detection ─────────────────────────────────

function detectColocated(testFiles: string[], projectRoot: string): boolean {
  if (testFiles.length === 0) return false;

  let colocatedCount = 0;
  let separateCount = 0;

  for (const filePath of testFiles) {
    const rel = relative(projectRoot, filePath);
    const dir = dirname(rel);

    if (
      dir.includes("__tests__") ||
      dir.startsWith("test/") ||
      dir.startsWith("tests/") ||
      dir === "test" ||
      dir === "tests"
    ) {
      separateCount++;
    } else {
      colocatedCount++;
    }
  }

  return colocatedCount >= separateCount;
}

function extractTestDirs(testFiles: string[], projectRoot: string): string[] {
  const dirs = new Set<string>();

  for (const filePath of testFiles) {
    const rel = relative(projectRoot, filePath);
    const dir = dirname(rel);

    if (
      dir.includes("__tests__") ||
      dir.startsWith("test") ||
      dir.startsWith("tests")
    ) {
      // Get the top-level test directory name
      const parts = dir.split("/");
      const testDirPart = parts.find(
        (p) => p === "__tests__" || p === "test" || p === "tests",
      );
      if (testDirPart) dirs.add(testDirPart);
    }
  }

  return Array.from(dirs);
}

// ── Coverage config detection ─────────────────────────────────────

async function detectCoverageConfig(projectRoot: string): Promise<boolean> {
  // Check vitest.config.ts / vitest.config.js
  const vitestConfigs = ["vitest.config.ts", "vitest.config.js", "vitest.config.mjs"];
  for (const cfg of vitestConfigs) {
    const cfgPath = join(projectRoot, cfg);
    if (await fileExists(cfgPath)) {
      try {
        const content = await readFile(cfgPath, "utf-8");
        if (content.includes("coverage")) return true;
      } catch {
        // Skip
      }
    }
  }

  // Check jest.config.ts / jest.config.js
  const jestConfigs = [
    "jest.config.ts",
    "jest.config.js",
    "jest.config.mjs",
    "jest.config.json",
  ];
  for (const cfg of jestConfigs) {
    if (await fileExists(join(projectRoot, cfg))) return true;
  }

  // Check package.json for coverage config
  const pkgPath = join(projectRoot, "package.json");
  if (await fileExists(pkgPath)) {
    try {
      const raw = await readFile(pkgPath, "utf-8");
      const pkg = JSON.parse(raw) as Record<string, unknown>;
      if ("jest" in pkg) {
        const jestConfig = pkg["jest"] as Record<string, unknown>;
        if ("collectCoverage" in jestConfig || "coverageDirectory" in jestConfig) {
          return true;
        }
      }
    } catch {
      // Skip
    }
  }

  return false;
}

// ── Main scanner ──────────────────────────────────────────────────

export async function scanTestConventions(
  projectRoot: string,
): Promise<TestConventionsReport | null> {
  const ignore = IGNORE_DIRS.map((d) => `**/${d}/**`);

  let testFiles: string[];
  try {
    testFiles = await glob(
      "**/*.{test,spec}.{ts,tsx,js,jsx}",
      { cwd: projectRoot, ignore, absolute: true },
    );
  } catch {
    return null;
  }

  const pkg = await readPackageJson(projectRoot);
  const framework = detectFramework(pkg);
  const mockingLibrary = detectMockingLibrary(pkg, framework);
  const filePattern = detectFilePattern(testFiles);
  const colocated = detectColocated(testFiles, projectRoot);
  const testDirs = extractTestDirs(testFiles, projectRoot);
  const hasCoverageConfig = await detectCoverageConfig(projectRoot);

  return {
    framework,
    filePattern,
    colocated,
    testDirs,
    mockingLibrary,
    hasCoverageConfig,
    testFileCount: testFiles.length,
  };
}
