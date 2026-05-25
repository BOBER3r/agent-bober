// ── bober_list_projects tool ──────────────────────────────────────────
//
// Walks each searchRoot one level deep looking for subdirectories
// containing bober.config.json. Returns an array of ProjectRow objects.
//
// Behavior:
// - Unreadable searchRoot → soft-skip with stderr warning (never throw).
// - Directories without bober.config.json → silently skipped.
// - No caching — every call walks fresh.
// - Does NOT instantiate RunManager; uses readRunStatesFromDisk for
//   per-project run enumeration.
//
// Sprint 5 (cockpit-integration)

import { readdir, readFile, access } from "node:fs/promises";
import { constants, type Dirent } from "node:fs";
import { join, basename } from "node:path";

import { registerTool } from "./registry.js";
import { readRunStatesFromDisk } from "../../state/run-state.js";

// ── Types ─────────────────────────────────────────────────────────────

interface ProjectRow {
  projectPath: string;
  name: string;
  mode?: string;
  hasActiveRuns: boolean;
  lastRunAt?: string;
}

// ── Registration ─────────────────────────────────────────────────────

export function registerListProjectsTool(): void {
  registerTool({
    name: "bober_list_projects",
    description:
      "Enumerate bober projects under one or more search roots by walking each root " +
      "one level deep for directories containing bober.config.json. " +
      "Returns [{ projectPath, name, mode?, hasActiveRuns, lastRunAt? }]. " +
      "Unreadable roots are skipped with a stderr warning. " +
      "Does not instantiate RunManager — reads disk state directly.",
    inputSchema: {
      type: "object",
      properties: {
        searchRoots: {
          type: "array",
          items: { type: "string" },
          description:
            "Array of absolute directory paths to search one level deep.",
        },
      },
      required: ["searchRoots"],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>): Promise<string> => {
      const searchRoots = Array.isArray(args.searchRoots)
        ? (args.searchRoots as unknown[]).filter((x): x is string => typeof x === "string")
        : [];

      if (searchRoots.length === 0) {
        return JSON.stringify({ error: "searchRoots must be a non-empty array of strings." });
      }

      const rows: ProjectRow[] = [];

      for (const root of searchRoots) {
        let dirEntries: Dirent<string>[];
        try {
          dirEntries = await readdir(root, { withFileTypes: true }) as Dirent<string>[];
        } catch (err) {
          process.stderr.write(
            `[bober_list_projects] Skipping unreadable searchRoot ${root}: ${
              err instanceof Error ? err.message : String(err)
            }\n`,
          );
          continue;
        }

        for (const entry of dirEntries) {
          if (!entry.isDirectory()) continue;
          const projectPath = join(root, entry.name as string);
          const configPath = join(projectPath, "bober.config.json");

          try {
            await access(configPath, constants.R_OK);
          } catch {
            continue; // silently skip dirs without bober.config.json
          }

          // Parse minimally — only project.name and project.mode are needed.
          let name = basename(projectPath);
          let mode: string | undefined;
          try {
            const raw = await readFile(configPath, "utf-8");
            const parsed = JSON.parse(raw) as {
              project?: { name?: string; mode?: string };
            };
            if (parsed.project?.name) name = parsed.project.name;
            if (parsed.project?.mode) mode = parsed.project.mode;
          } catch {
            // keep basename fallback for name
          }

          // Active runs / lastRunAt — read from disk without RunManager
          const runs = await readRunStatesFromDisk(projectPath);
          const hasActiveRuns = runs.some((r) => r.status === "running");
          const lastRunAt =
            runs.length > 0
              ? runs.map((r) => r.startedAt).sort().slice(-1)[0]
              : undefined;

          rows.push({
            projectPath,
            name,
            ...(mode !== undefined ? { mode } : {}),
            hasActiveRuns,
            ...(lastRunAt !== undefined ? { lastRunAt } : {}),
          });
        }
      }

      return JSON.stringify(rows, null, 2);
    },
  });
}
