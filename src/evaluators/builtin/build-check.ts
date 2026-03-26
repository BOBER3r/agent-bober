import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";

import type {
  EvaluatorPlugin,
  EvalContext,
  EvalResult,
  EvalDetail,
  BoberConfig,
} from "../plugin-interface.js";

// ── Helpers ────────────────────────────────────────────────────────

interface PackageJson {
  scripts?: Record<string, string>;
}

async function detectBuildCommand(projectRoot: string): Promise<string | null> {
  try {
    const raw = await readFile(join(projectRoot, "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as PackageJson;
    if (pkg.scripts?.build) {
      return "npm run build";
    }
  } catch {
    // no package.json or unparseable
  }
  return null;
}

// ── Evaluator ──────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 60_000;

export class BuildCheckEvaluator implements EvaluatorPlugin {
  readonly name = "Build Check";
  readonly description = "Runs the project build command and checks for success.";

  async canRun(projectRoot: string, config: BoberConfig): Promise<boolean> {
    if (config.commands.build) return true;
    const detected = await detectBuildCommand(projectRoot);
    return detected !== null;
  }

  async evaluate(context: EvalContext): Promise<EvalResult> {
    const { projectRoot, config, strategy } = context;
    const timestamp = new Date().toISOString();
    const timeout = (strategy.config?.timeout as number) ?? DEFAULT_TIMEOUT_MS;

    const command = config.commands.build ?? (await detectBuildCommand(projectRoot));

    if (!command) {
      return {
        evaluator: this.name,
        passed: false,
        score: 0,
        details: [
          {
            criterion: "Build command detection",
            passed: false,
            message: "No build command found in config or package.json.",
            severity: "error",
          },
        ],
        summary: "No build command available.",
        feedback:
          "Configure a build command in bober config (commands.build) or add a 'build' script to package.json.",
        timestamp,
      };
    }

    const [cmd, ...args] = command.split(/\s+/);

    try {
      const result = await execa(cmd, args, {
        cwd: projectRoot,
        timeout,
        reject: false,
        all: true,
      });

      const allOutput = result.all ?? result.stdout ?? "";

      if (result.exitCode === 0) {
        return {
          evaluator: this.name,
          passed: true,
          score: 100,
          details: [],
          summary: "Build succeeded.",
          feedback: "The project builds successfully. No changes needed.",
          timestamp,
        };
      }

      // Build failed — extract useful error information.
      const details: EvalDetail[] = this.extractBuildErrors(allOutput);

      if (details.length === 0) {
        details.push({
          criterion: "Build execution",
          passed: false,
          message: allOutput.slice(0, 2000) || `Build exited with code ${result.exitCode}`,
          severity: "error",
        });
      }

      return {
        evaluator: this.name,
        passed: false,
        score: 0,
        details,
        summary: `Build failed with exit code ${result.exitCode}.`,
        feedback: this.buildFeedback(allOutput),
        timestamp,
      };
    } catch (err) {
      return {
        evaluator: this.name,
        passed: false,
        score: 0,
        details: [
          {
            criterion: "Build execution",
            passed: false,
            message: err instanceof Error ? err.message : String(err),
            severity: "error",
          },
        ],
        summary: "Build command failed to execute.",
        feedback: `The build command could not be run: ${err instanceof Error ? err.message : String(err)}`,
        timestamp,
      };
    }
  }

  /**
   * Attempt to parse common error patterns from build output.
   */
  private extractBuildErrors(output: string): EvalDetail[] {
    const details: EvalDetail[] = [];

    // Try to find TypeScript-style errors: file(line,col): error TS1234: ...
    const tsPattern = /^(.+?)\((\d+),(\d+)\):\s+error\s+\S+:\s+(.+)$/gm;
    let match: RegExpExecArray | null;
    while ((match = tsPattern.exec(output)) !== null) {
      details.push({
        criterion: "Build error",
        passed: false,
        message: match[4],
        file: match[1],
        line: parseInt(match[2], 10),
        severity: "error",
      });
    }

    // Try webpack/vite style: ERROR in ./src/foo.ts
    const bundlerPattern = /^ERROR\s+in\s+(\S+)/gm;
    while ((match = bundlerPattern.exec(output)) !== null) {
      details.push({
        criterion: "Build error",
        passed: false,
        message: `Build error in ${match[1]}`,
        file: match[1],
        severity: "error",
      });
    }

    return details;
  }

  private buildFeedback(output: string): string {
    const lines = ["The build failed. Here is the relevant output:", ""];
    // Show the last 2000 chars which typically contain the actual errors.
    const tail = output.length > 2000 ? output.slice(-2000) : output;
    lines.push(tail);
    return lines.join("\n");
  }
}

/**
 * Factory function for the registry.
 */
export function createBuildCheckEvaluator(): EvaluatorPlugin {
  return new BuildCheckEvaluator();
}
