// ── bober_principles tool ─────────────────────────────────────────────
//
// No args -> read .bober/principles.md and return content.
// With { content } -> write/update .bober/principles.md.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cwd } from "node:process";

import { ensureBoberDir } from "../../state/index.js";
import { registerTool } from "./registry.js";

// ── Constants ─────────────────────────────────────────────────────────

const PRINCIPLES_FILENAME = "principles.md";

function principlesPath(projectRoot: string): string {
  return join(projectRoot, ".bober", PRINCIPLES_FILENAME);
}

// ── Registration ─────────────────────────────────────────────────────

export function registerPrinciplesTool(): void {
  registerTool({
    name: "bober_principles",
    description:
      "Read or write the project principles file (.bober/principles.md). " +
      "Without arguments reads the current principles. " +
      "With content writes/replaces the principles file. " +
      "Principles are injected into every generator and evaluator agent prompt.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description:
            "Principles content to write. Omit to read current principles.",
        },
      },
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>): Promise<string> => {
      const projectRoot = cwd();
      const filePath = principlesPath(projectRoot);

      const newContent =
        typeof args.content === "string" ? args.content : undefined;

      // Write mode
      if (newContent !== undefined) {
        await ensureBoberDir(projectRoot);
        await writeFile(filePath, newContent, "utf-8");

        process.stderr.write(
          `[bober_principles] Wrote ${newContent.length} characters to ${filePath}\n`,
        );

        return JSON.stringify(
          {
            status: "updated",
            path: filePath,
            characters: newContent.length,
            message:
              "Principles file updated. These will be injected into all future agent prompts.",
          },
          null,
          2,
        );
      }

      // Read mode
      try {
        const content = await readFile(filePath, "utf-8");
        return JSON.stringify(
          {
            path: filePath,
            content,
          },
          null,
          2,
        );
      } catch {
        return JSON.stringify(
          {
            content: null,
            message:
              "No principles file. Use bober_principles with content to create one.",
          },
          null,
          2,
        );
      }
    },
  });
}
