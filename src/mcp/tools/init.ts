// ── bober_init tool ──────────────────────────────────────────────────
//
// Creates bober.config.json and .bober/ directories in the current
// working directory. Accepts { preset?: string, provider?: string }.
// Returns a confirmation message.

import { writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { cwd } from "node:process";

import { configExists } from "../../config/loader.js";
import { createDefaultConfig } from "../../config/schema.js";
import type { ProjectMode } from "../../config/schema.js";
import { getPresetNames } from "../../config/defaults.js";
import { ensureBoberDir } from "../../state/index.js";
import { registerTool } from "./registry.js";

// ── Registration ─────────────────────────────────────────────────────

export function registerInitTool(): void {
  registerTool({
    name: "bober_init",
    description:
      "Initialise a Bober project in the current working directory. " +
      "Creates bober.config.json and the .bober/ state directory. " +
      "Accepts an optional preset (e.g. nextjs, react-vite, api-node) and " +
      "an optional provider (anthropic, openai, google, openai-compat). " +
      "If a config already exists this will overwrite it.",
    inputSchema: {
      type: "object",
      properties: {
        preset: {
          type: "string",
          description:
            "Optional project preset. One of: nextjs, react-vite, api-node, " +
            "python-api, solidity, anchor. Leave blank for a generic config.",
        },
        provider: {
          type: "string",
          description:
            "AI provider to use: anthropic (default), openai, google, openai-compat.",
          default: "anthropic",
        },
        mode: {
          type: "string",
          description:
            "Project mode: greenfield (default) or brownfield.",
          default: "greenfield",
        },
        projectName: {
          type: "string",
          description:
            "Project name. Defaults to the name of the current directory.",
        },
      },
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>): Promise<string> => {
      const projectRoot = cwd();
      const projectName =
        typeof args.projectName === "string" && args.projectName.trim()
          ? args.projectName.trim()
          : basename(projectRoot);

      const rawPreset =
        typeof args.preset === "string" && args.preset.trim()
          ? args.preset.trim()
          : undefined;

      const provider =
        typeof args.provider === "string" && args.provider.trim()
          ? args.provider.trim()
          : "anthropic";

      const rawMode =
        typeof args.mode === "string" && args.mode.trim()
          ? args.mode.trim()
          : "greenfield";

      const mode: ProjectMode =
        rawMode === "brownfield" ? "brownfield" : "greenfield";

      // Validate preset if provided
      if (rawPreset) {
        const knownPresets = getPresetNames();
        if (!knownPresets.includes(rawPreset)) {
          return JSON.stringify({
            error: `Unknown preset "${rawPreset}".`,
            availablePresets: knownPresets,
          });
        }
      }

      // Warn if already initialised (but proceed — tool contract says overwrite)
      const alreadyExists = await configExists(projectRoot);
      if (alreadyExists) {
        process.stderr.write(
          `[bober_init] Overwriting existing bober.config.json in ${projectRoot}\n`,
        );
      }

      // Build config
      const config = createDefaultConfig(projectName, mode, rawPreset, {
        planner: {
          maxClarifications: 5,
          model: "opus",
          provider,
        },
        generator: {
          model: "sonnet",
          maxTurnsPerSprint: 50,
          autoCommit: true,
          branchPattern: "bober/{feature-name}",
          provider,
        },
        evaluator: {
          model: "sonnet",
          strategies: [],
          maxIterations: 3,
          provider,
        },
      });

      // Write bober.config.json
      const configPath = join(projectRoot, "bober.config.json");
      await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

      // Create .bober/ directory structure
      await ensureBoberDir(projectRoot);

      process.stderr.write(
        `[bober_init] Initialised project "${projectName}" in ${projectRoot}\n`,
      );

      return JSON.stringify(
        {
          status: "initialised",
          projectName,
          mode,
          preset: rawPreset ?? null,
          provider,
          configPath,
          boberDir: join(projectRoot, ".bober"),
          message: alreadyExists
            ? "Existing configuration was overwritten."
            : "Project successfully initialised. Run bober_plan to create your first plan.",
          nextStep: "Run bober_plan with a task description to generate a sprint plan.",
        },
        null,
        2,
      );
    },
  });
}
