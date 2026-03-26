import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { constants } from "node:fs";

import {
  BoberConfigSchema,
  PartialBoberConfigSchema,
  type BoberConfig,
} from "./schema.js";
import { getDefaults } from "./defaults.js";

/**
 * Config file candidate paths, searched in order.
 */
const CONFIG_CANDIDATES = [
  "bober.config.json",
  ".bober/config.json",
] as const;

/**
 * Find the first existing config file path, or null.
 */
async function findConfigPath(projectRoot: string): Promise<string | null> {
  for (const candidate of CONFIG_CANDIDATES) {
    const fullPath = join(projectRoot, candidate);
    try {
      await access(fullPath, constants.R_OK);
      return fullPath;
    } catch {
      // not found, try next
    }
  }
  return null;
}

/**
 * Check whether a bober config file exists in the given project root.
 */
export async function configExists(projectRoot: string): Promise<boolean> {
  const found = await findConfigPath(projectRoot);
  return found !== null;
}

/**
 * Deep merge two objects, preferring values from `override`.
 * Arrays are replaced, not merged.
 */
function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Partial<T>,
): T {
  const result = { ...base } as Record<string, unknown>;

  for (const key of Object.keys(override)) {
    const overrideVal = (override as Record<string, unknown>)[key];
    const baseVal = result[key];

    if (
      overrideVal !== undefined &&
      overrideVal !== null &&
      typeof overrideVal === "object" &&
      !Array.isArray(overrideVal) &&
      typeof baseVal === "object" &&
      baseVal !== null &&
      !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>,
      );
    } else if (overrideVal !== undefined) {
      result[key] = overrideVal;
    }
  }

  return result as T;
}

/**
 * Load and validate the bober configuration for a project.
 *
 * Resolution order:
 * 1. Discover config file (`bober.config.json` or `.bober/config.json`)
 * 2. Parse & validate the partial config (project section required)
 * 3. Merge with project-type defaults
 * 4. Validate the final merged config against the full schema
 *
 * Throws if no config file is found or validation fails.
 */
export async function loadConfig(projectRoot: string): Promise<BoberConfig> {
  const configPath = await findConfigPath(projectRoot);
  if (!configPath) {
    throw new Error(
      `No bober config found. Looked for ${CONFIG_CANDIDATES.map((c) => join(projectRoot, c)).join(", ")}`,
    );
  }

  let rawContent: string;
  try {
    rawContent = await readFile(configPath, "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to read config file at ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch (err) {
    throw new Error(
      `Invalid JSON in config file ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  // Validate partial config (project is required, everything else optional)
  const partialResult = PartialBoberConfigSchema.safeParse(parsed);
  if (!partialResult.success) {
    const issues = partialResult.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid bober config at ${configPath}:\n${issues}`);
  }

  const partial = partialResult.data;
  const defaults = getDefaults(partial.project.type);

  // Build a complete config by deep-merging defaults with user overrides
  const merged = deepMerge(
    {
      project: partial.project,
      planner: defaults.planner ?? {
        maxClarifications: 5,
        model: "opus" as const,
      },
      generator: defaults.generator ?? {
        model: "sonnet" as const,
        maxTurnsPerSprint: 50,
        autoCommit: true,
        branchPattern: "bober/{feature-name}",
      },
      evaluator: defaults.evaluator ?? {
        model: "sonnet" as const,
        strategies: [],
        maxIterations: 3,
      },
      sprint: defaults.sprint ?? {
        maxSprints: 10,
        requireContracts: true,
        sprintSize: "medium" as const,
      },
      pipeline: defaults.pipeline ?? {
        maxIterations: 20,
        requireApproval: false,
        contextReset: "always" as const,
      },
      commands: defaults.commands ?? {},
    },
    partial as Partial<BoberConfig>,
  );

  // Final full validation
  const fullResult = BoberConfigSchema.safeParse(merged);
  if (!fullResult.success) {
    const issues = fullResult.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Config validation failed after merging defaults:\n${issues}`,
    );
  }

  return fullResult.data;
}
