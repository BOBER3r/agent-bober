// ── bober_playwright tool ────────────────────────────────────────────
//
// Set up Playwright E2E testing and generate test files.

import { cwd } from "node:process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import { configExists } from "../../config/loader.js";
import { registerTool } from "./registry.js";

const execFileAsync = promisify(execFile);

// ── Registration ─────────────────────────────────────────────────────

export function registerPlaywrightTool(): void {
  registerTool({
    name: "bober_playwright",
    description:
      "Set up Playwright E2E testing or run existing tests. " +
      "Actions: 'setup' installs Playwright and creates config, " +
      "'run' executes tests, 'status' checks if Playwright is configured.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["setup", "run", "status"],
          description: "Action to perform. Defaults to 'status'.",
        },
      },
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>): Promise<string> => {
      const action = typeof args.action === "string" ? args.action : "status";
      const projectRoot = cwd();

      const hasConfig = await configExists(projectRoot);
      if (!hasConfig) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          "No bober.config.json found. Run bober_init first.",
        );
      }

      if (action === "status") {
        let hasPlaywrightConfig = false;
        try {
          await readFile(join(projectRoot, "playwright.config.ts"), "utf-8");
          hasPlaywrightConfig = true;
        } catch {
          try {
            await readFile(join(projectRoot, "playwright.config.js"), "utf-8");
            hasPlaywrightConfig = true;
          } catch {
            // Neither config exists
          }
        }

        let hasPlaywrightDep = false;
        try {
          const pkg = JSON.parse(
            await readFile(join(projectRoot, "package.json"), "utf-8"),
          );
          hasPlaywrightDep =
            !!pkg.devDependencies?.["@playwright/test"] ||
            !!pkg.dependencies?.["@playwright/test"];
        } catch {
          // No package.json
        }

        return JSON.stringify(
          {
            configured: hasPlaywrightConfig,
            installed: hasPlaywrightDep,
            message: hasPlaywrightConfig
              ? "Playwright is configured. Use action 'run' to execute tests."
              : "Playwright is not configured. Use action 'setup' to install.",
          },
          null,
          2,
        );
      }

      if (action === "setup") {
        try {
          await execFileAsync("npx", ["playwright", "install", "--with-deps", "chromium"], {
            cwd: projectRoot,
            timeout: 120000,
          });

          return JSON.stringify({
            status: "installed",
            message:
              "Playwright browsers installed. Create playwright.config.ts and e2e/ tests.",
          });
        } catch (err) {
          return JSON.stringify({
            error: `Playwright setup failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }

      if (action === "run") {
        try {
          const { stdout, stderr } = await execFileAsync(
            "npx",
            ["playwright", "test", "--reporter=json"],
            { cwd: projectRoot, timeout: 300000 },
          );

          return JSON.stringify({
            status: "completed",
            output: stdout.slice(0, 5000),
            errors: stderr.slice(0, 2000),
          });
        } catch (err) {
          const error = err as { stdout?: string; stderr?: string; message: string };
          return JSON.stringify({
            status: "failed",
            output: error.stdout?.slice(0, 5000) ?? "",
            errors: error.stderr?.slice(0, 2000) ?? error.message,
          });
        }
      }

      return JSON.stringify({ error: `Unknown action: ${action}` });
    },
  });
}
