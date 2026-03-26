import { access } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";

import type { EvaluatorPlugin, EvaluatorFactory } from "./plugin-interface.js";

// ── Validation ─────────────────────────────────────────────────────

/**
 * Validate that a loaded module conforms to the EvaluatorPlugin interface.
 */
function isEvaluatorPlugin(value: unknown): value is EvaluatorPlugin {
  if (value === null || typeof value !== "object") return false;

  const obj = value as Record<string, unknown>;
  return (
    typeof obj.name === "string" &&
    typeof obj.description === "string" &&
    typeof obj.canRun === "function" &&
    typeof obj.evaluate === "function"
  );
}

/**
 * Validate that a loaded module exports a factory function.
 */
function isEvaluatorFactory(value: unknown): value is EvaluatorFactory {
  return typeof value === "function";
}

// ── Loading ────────────────────────────────────────────────────────

/**
 * Resolve a plugin path to an absolute path or npm package name.
 *
 * Supports:
 *   - Absolute paths: `/home/user/my-plugin.js`
 *   - Relative paths: `./plugins/my-plugin.js` (resolved from cwd)
 *   - npm package names: `bober-plugin-my-check`
 */
function resolvePluginPath(pluginPath: string): string {
  if (isAbsolute(pluginPath)) return pluginPath;
  if (pluginPath.startsWith("./") || pluginPath.startsWith("../")) {
    return resolve(process.cwd(), pluginPath);
  }
  // Treat as npm package name — dynamic import will resolve it.
  return pluginPath;
}

/**
 * Load a single evaluator plugin from a file path or npm package name.
 *
 * The module should either:
 *   - Export a default EvaluatorFactory function
 *   - Export a default EvaluatorPlugin instance
 *   - Export a named `createEvaluator` factory function
 *   - Export a named `plugin` instance
 *
 * Returns null (with a console warning) if loading fails.
 */
export async function loadPlugin(
  pluginPath: string,
  config?: Record<string, unknown>,
): Promise<EvaluatorPlugin | null> {
  const resolved = resolvePluginPath(pluginPath);

  // For file paths, verify the file exists before attempting dynamic import.
  if (isAbsolute(resolved)) {
    try {
      await access(resolved);
    } catch {
      console.warn(`[bober] Plugin file not found: ${resolved}`);
      return null;
    }
  }

  try {
    const mod: Record<string, unknown> = await import(resolved);

    // Try default export first.
    const defaultExport = mod.default;

    if (isEvaluatorPlugin(defaultExport)) {
      return defaultExport;
    }

    if (isEvaluatorFactory(defaultExport)) {
      const instance = defaultExport(config);
      if (isEvaluatorPlugin(instance)) return instance;
      console.warn(`[bober] Default factory from ${pluginPath} did not return a valid plugin.`);
      return null;
    }

    // Try named exports.
    if (isEvaluatorFactory(mod.createEvaluator)) {
      const instance = (mod.createEvaluator as EvaluatorFactory)(config);
      if (isEvaluatorPlugin(instance)) return instance;
    }

    if (isEvaluatorPlugin(mod.plugin)) {
      return mod.plugin as EvaluatorPlugin;
    }

    console.warn(
      `[bober] Plugin at ${pluginPath} does not export a valid EvaluatorPlugin or EvaluatorFactory.`,
    );
    return null;
  } catch (err) {
    console.warn(
      `[bober] Failed to load plugin from ${pluginPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Load multiple evaluator plugins. Skips any that fail to load.
 */
export async function loadPlugins(
  paths: string[],
  config?: Record<string, unknown>,
): Promise<EvaluatorPlugin[]> {
  const results = await Promise.allSettled(
    paths.map((p) => loadPlugin(p, config)),
  );

  const plugins: EvaluatorPlugin[] = [];
  for (const result of results) {
    if (result.status === "fulfilled" && result.value !== null) {
      plugins.push(result.value);
    }
  }

  return plugins;
}
