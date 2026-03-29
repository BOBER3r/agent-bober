/**
 * Scanner: Package Scripts
 *
 * Reads package.json scripts, maps them to bober command categories,
 * and detects the package manager from lockfiles.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileExists } from "../../utils/fs.js";
import type {
  PackageScriptsReport,
  BoberCommandCategory,
  CommandMapping,
} from "../types.js";

// ── Package manager detection ─────────────────────────────────────

type PackageManager = "npm" | "yarn" | "pnpm" | "bun";

async function detectPackageManager(
  projectRoot: string,
): Promise<PackageManager | null> {
  if (await fileExists(join(projectRoot, "bun.lockb"))) return "bun";
  if (await fileExists(join(projectRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (await fileExists(join(projectRoot, "yarn.lock"))) return "yarn";
  if (await fileExists(join(projectRoot, "package-lock.json"))) return "npm";
  // Fallback: if package.json exists, assume npm
  if (await fileExists(join(projectRoot, "package.json"))) return "npm";
  return null;
}

function buildRunCommand(
  pm: PackageManager | null,
  scriptName: string,
): string {
  switch (pm) {
    case "yarn":
      return `yarn ${scriptName}`;
    case "pnpm":
      return `pnpm run ${scriptName}`;
    case "bun":
      return `bun run ${scriptName}`;
    case "npm":
    default:
      return `npm run ${scriptName}`;
  }
}

// ── Category matching ─────────────────────────────────────────────

/**
 * Keywords used to identify bober command categories.
 * Checked against the script name (key in package.json "scripts").
 */
const CATEGORY_PATTERNS: Array<{
  category: BoberCommandCategory;
  patterns: RegExp[];
}> = [
  {
    category: "build",
    patterns: [/^build$/, /^compile$/, /^tsc$/, /^bundle$/],
  },
  {
    category: "test",
    patterns: [/^test$/, /^test:run$/, /^vitest$/, /^jest$/, /^mocha$/],
  },
  {
    category: "lint",
    patterns: [/^lint$/, /^lint:fix$/, /^eslint$/, /^tslint$/],
  },
  {
    category: "typecheck",
    patterns: [/^typecheck$/, /^type-check$/, /^types$/, /^tsc:check$/],
  },
  {
    category: "dev",
    patterns: [/^dev$/, /^start$/, /^serve$/, /^watch$/],
  },
  {
    category: "install",
    patterns: [/^prepare$/, /^postinstall$/, /^setup$/],
  },
];

function categorizeScript(
  scriptName: string,
  command: string,
  pm: PackageManager | null,
): { category: BoberCommandCategory; mapping: CommandMapping } | null {
  const normalizedName = scriptName.toLowerCase();

  for (const { category, patterns } of CATEGORY_PATTERNS) {
    if (patterns.some((p) => p.test(normalizedName))) {
      return {
        category,
        mapping: {
          scriptName,
          command,
          runCommand: buildRunCommand(pm, scriptName),
        },
      };
    }
  }

  return null;
}

// ── Main scanner ──────────────────────────────────────────────────

interface PackageJson {
  scripts?: Record<string, string>;
  [key: string]: unknown;
}

export async function scanPackageScripts(
  projectRoot: string,
): Promise<PackageScriptsReport | null> {
  const pkgPath = join(projectRoot, "package.json");
  if (!(await fileExists(pkgPath))) {
    return null;
  }

  let pkg: PackageJson;
  try {
    const raw = await readFile(pkgPath, "utf-8");
    pkg = JSON.parse(raw) as PackageJson;
  } catch {
    return null;
  }

  const pm = await detectPackageManager(projectRoot);
  const allScripts = pkg.scripts ?? {};
  const categorized: Partial<Record<BoberCommandCategory, CommandMapping>> = {};

  for (const [scriptName, command] of Object.entries(allScripts)) {
    const result = categorizeScript(scriptName, command, pm);
    if (result && !(result.category in categorized)) {
      categorized[result.category] = result.mapping;
    }
  }

  return {
    packageManager: pm,
    allScripts,
    categorized,
  };
}
