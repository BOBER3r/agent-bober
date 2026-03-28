// ── bober_config tool ─────────────────────────────────────────────────
//
// No args -> read and return bober.config.json as-is.
// With { key, value } -> update a specific dot-path field and write back.
// e.g. key="generator.model", value="opus"

import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { constants } from "node:fs";
import { cwd } from "node:process";

import { registerTool } from "./registry.js";

// ── Helpers ───────────────────────────────────────────────────────────

const CONFIG_CANDIDATES = ["bober.config.json", ".bober/config.json"] as const;

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
 * Set a value at a dot-separated path inside a plain object.
 * Creates intermediate objects as needed.
 * Returns the mutated object (same reference).
 */
function setNestedValue(
  obj: Record<string, unknown>,
  dotPath: string,
  value: unknown,
): void {
  const parts = dotPath.split(".");
  let cursor: Record<string, unknown> = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (
      cursor[part] === undefined ||
      cursor[part] === null ||
      typeof cursor[part] !== "object" ||
      Array.isArray(cursor[part])
    ) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }

  const lastPart = parts[parts.length - 1];
  cursor[lastPart] = value;
}

/**
 * Attempt to coerce a string value to a more appropriate JSON type.
 * "true"/"false" -> boolean, numeric strings -> number, else keep as string.
 */
function coerceValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  const n = Number(raw);
  if (!isNaN(n) && raw.trim() !== "") return n;
  return raw;
}

// ── Registration ─────────────────────────────────────────────────────

export function registerConfigTool(): void {
  registerTool({
    name: "bober_config",
    description:
      "Read or update the Bober project configuration (bober.config.json). " +
      "Without arguments returns the full config as JSON. " +
      "With key and value, updates a specific config field using dot-notation " +
      "(e.g. key='generator.model', value='opus'). " +
      "Numeric and boolean values are coerced automatically.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description:
            "Dot-separated config path to update (e.g. generator.model, evaluator.maxIterations).",
        },
        value: {
          type: "string",
          description:
            "New value for the key. Numbers and booleans are coerced automatically.",
        },
      },
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>): Promise<string> => {
      const projectRoot = cwd();
      const configPath = await findConfigPath(projectRoot);

      if (!configPath) {
        return JSON.stringify(
          {
            error:
              "No bober.config.json found. Run bober_init first.",
          },
          null,
          2,
        );
      }

      // Parse the existing config file
      let rawContent: string;
      try {
        rawContent = await readFile(configPath, "utf-8");
      } catch (err) {
        return JSON.stringify(
          {
            error: `Failed to read config: ${err instanceof Error ? err.message : String(err)}`,
          },
          null,
          2,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawContent);
      } catch (err) {
        return JSON.stringify(
          {
            error: `Invalid JSON in config file: ${err instanceof Error ? err.message : String(err)}`,
          },
          null,
          2,
        );
      }

      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return JSON.stringify(
          { error: "Config file does not contain a JSON object." },
          null,
          2,
        );
      }

      const configObj = parsed as Record<string, unknown>;

      const key =
        typeof args.key === "string" && args.key.trim()
          ? args.key.trim()
          : undefined;
      const value =
        typeof args.value === "string" ? args.value : undefined;

      // Read mode (no key provided)
      if (key === undefined) {
        return JSON.stringify(
          {
            path: configPath,
            config: configObj,
          },
          null,
          2,
        );
      }

      // Update mode requires both key and value
      if (value === undefined) {
        return JSON.stringify(
          {
            error:
              "Both key and value must be provided to update the config.",
          },
          null,
          2,
        );
      }

      const coerced = coerceValue(value);
      setNestedValue(configObj, key, coerced);

      try {
        await writeFile(configPath, JSON.stringify(configObj, null, 2) + "\n", "utf-8");
      } catch (err) {
        return JSON.stringify(
          {
            error: `Failed to write config: ${err instanceof Error ? err.message : String(err)}`,
          },
          null,
          2,
        );
      }

      process.stderr.write(
        `[bober_config] Updated ${key} = ${JSON.stringify(coerced)} in ${configPath}\n`,
      );

      return JSON.stringify(
        {
          status: "updated",
          path: configPath,
          key,
          value: coerced,
          config: configObj,
        },
        null,
        2,
      );
    },
  });
}
