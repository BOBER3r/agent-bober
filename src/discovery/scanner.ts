/**
 * Main codebase scanner.
 *
 * scanProject() orchestrates all sub-scanners and returns a fully-populated
 * DiscoveryReport. Each sub-scanner handles its own failures gracefully,
 * so a failure in one section does not break the rest.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileExists } from "../utils/fs.js";
import { scanPackageScripts } from "./scanners/package-scripts.js";
import { scanCIChecks } from "./scanners/ci-checks.js";
import { scanGitConventions } from "./scanners/git-conventions.js";
import { scanCodeConventions } from "./scanners/code-conventions.js";
import { scanTestConventions } from "./scanners/test-conventions.js";
import { scanDocumentation } from "./scanners/documentation.js";
import type { DiscoveryReport, DetectedStackReport } from "./types.js";

// ── Stack detection ───────────────────────────────────────────────

interface PackageJsonDeps {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function detectStack(
  projectRoot: string,
): Promise<DetectedStackReport | null> {
  const pkgPath = join(projectRoot, "package.json");

  let allDeps: Record<string, string> = {};
  if (await fileExists(pkgPath)) {
    try {
      const raw = await readFile(pkgPath, "utf-8");
      const pkg = JSON.parse(raw) as PackageJsonDeps;
      allDeps = {
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
      };
    } catch {
      // Continue with empty deps
    }
  }

  const hasTypescript =
    (await fileExists(join(projectRoot, "tsconfig.json"))) ||
    "typescript" in allDeps;

  const hasReact = "react" in allDeps;

  const nextConfigs = ["next.config.js", "next.config.ts", "next.config.mjs"];
  let hasNext = "next" in allDeps;
  if (!hasNext) {
    for (const cfg of nextConfigs) {
      if (await fileExists(join(projectRoot, cfg))) {
        hasNext = true;
        break;
      }
    }
  }

  const hasVite = "vite" in allDeps;
  const hasPlaywright = "@playwright/test" in allDeps;
  const hasEslint = "eslint" in allDeps;
  const hasVitest = "vitest" in allDeps;
  const hasJest = "jest" in allDeps;
  const hasPython =
    (await fileExists(join(projectRoot, "pyproject.toml"))) ||
    (await fileExists(join(projectRoot, "requirements.txt"))) ||
    (await fileExists(join(projectRoot, "Pipfile")));
  const hasRust = await fileExists(join(projectRoot, "Cargo.toml"));
  const hasNestjs = "@nestjs/core" in allDeps;
  const hasFastify = "fastify" in allDeps;
  const hasExpress = "express" in allDeps;

  let primaryLanguage: DetectedStackReport["primaryLanguage"] = "unknown";
  if (hasTypescript) {
    primaryLanguage = "typescript";
  } else if (
    (await fileExists(join(projectRoot, "package.json"))) &&
    !hasTypescript
  ) {
    primaryLanguage = "javascript";
  } else if (hasPython) {
    primaryLanguage = "python";
  } else if (hasRust) {
    primaryLanguage = "rust";
  }

  return {
    hasTypescript,
    hasReact,
    hasNext,
    hasVite,
    hasPlaywright,
    hasEslint,
    hasVitest,
    hasJest,
    hasPython,
    hasRust,
    hasNestjs,
    hasFastify,
    hasExpress,
    primaryLanguage,
  };
}

// ── Main entry point ──────────────────────────────────────────────

/**
 * Scan a project root and return a structured DiscoveryReport.
 *
 * Never throws -- individual scanner failures result in null sections.
 *
 * @param projectRoot Absolute path to the project root directory.
 */
export async function scanProject(
  projectRoot: string,
): Promise<DiscoveryReport> {
  const [
    packageScripts,
    ciChecks,
    gitConventions,
    codeConventions,
    testConventions,
    documentation,
    detectedStack,
  ] = await Promise.all([
    scanPackageScripts(projectRoot).catch(() => null),
    scanCIChecks(projectRoot).catch(() => ({ workflows: [], allRunCommands: [] })),
    scanGitConventions(projectRoot).catch(() => null),
    scanCodeConventions(projectRoot).catch(() => null),
    scanTestConventions(projectRoot).catch(() => null),
    scanDocumentation(projectRoot).catch(() => ({ files: [] })),
    detectStack(projectRoot).catch(() => null),
  ]);

  return {
    projectRoot,
    scannedAt: new Date().toISOString(),
    packageScripts,
    packageManager: packageScripts?.packageManager ?? null,
    ciChecks,
    gitConventions,
    codeConventions,
    testConventions,
    documentation,
    detectedStack,
  };
}
