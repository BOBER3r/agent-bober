import { access } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";

import type {
  EvaluatorPlugin,
  EvalContext,
  EvalResult,
  EvalDetail,
  BoberConfig,
} from "../plugin-interface.js";

// ── TSC output parser ──────────────────────────────────────────────

interface TscError {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
}

/**
 * Parse tsc --noEmit output lines into structured errors.
 *
 * Expected format per line:
 *   src/foo.ts(12,5): error TS2345: Argument of type ...
 */
function parseTscOutput(output: string): TscError[] {
  const errors: TscError[] = [];
  const linePattern = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/;

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = linePattern.exec(trimmed);
    if (match) {
      errors.push({
        file: match[1],
        line: parseInt(match[2], 10),
        col: parseInt(match[3], 10),
        code: match[4],
        message: match[5],
      });
    }
  }

  return errors;
}

// ── Evaluator ──────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 60_000;

export class TypeScriptCheckEvaluator implements EvaluatorPlugin {
  readonly name = "TypeScript Check";
  readonly description = "Runs tsc --noEmit to verify the project has no type errors.";

  async canRun(projectRoot: string, config: BoberConfig): Promise<boolean> {
    // If a custom typecheck command is configured, assume it's runnable.
    if (config.commands.typecheck) return true;

    // Otherwise check for tsconfig.json.
    try {
      await access(join(projectRoot, "tsconfig.json"));
      return true;
    } catch {
      return false;
    }
  }

  async evaluate(context: EvalContext): Promise<EvalResult> {
    const { projectRoot, config, strategy } = context;
    const timestamp = new Date().toISOString();
    const timeout = (strategy.config?.timeout as number) ?? DEFAULT_TIMEOUT_MS;

    const command = config.commands.typecheck ?? "npx tsc --noEmit";
    const [cmd, ...args] = command.split(/\s+/);

    try {
      const result = await execa(cmd, args, {
        cwd: projectRoot,
        timeout,
        reject: false,
        all: true,
      });

      const allOutput = result.all ?? result.stdout ?? "";

      // Exit code 0 means no type errors.
      if (result.exitCode === 0) {
        return {
          evaluator: this.name,
          passed: true,
          score: 100,
          details: [],
          summary: "TypeScript compilation succeeded with no errors.",
          feedback: "All types are valid. No changes needed.",
          timestamp,
        };
      }

      // Parse errors from tsc output.
      const tscErrors = parseTscOutput(allOutput);
      const details: EvalDetail[] = tscErrors.map((err) => ({
        criterion: `Type check: ${err.code}`,
        passed: false,
        message: `${err.message} (${err.code})`,
        file: err.file,
        line: err.line,
        severity: "error" as const,
      }));

      // If we couldn't parse any structured errors but the command failed,
      // add a generic detail with the raw output.
      if (details.length === 0 && result.exitCode !== 0) {
        details.push({
          criterion: "TypeScript compilation",
          passed: false,
          message: allOutput.slice(0, 2000) || `tsc exited with code ${result.exitCode}`,
          severity: "error",
        });
      }

      // Score: 0 when there are errors. We could be proportional but
      // type errors are generally blocking.
      const errorCount = details.length;
      const score = errorCount === 0 ? 100 : Math.max(0, 100 - errorCount * 5);

      return {
        evaluator: this.name,
        passed: false,
        score,
        details,
        summary: `TypeScript compilation failed with ${errorCount} error(s).`,
        feedback: buildFeedback(tscErrors),
        timestamp,
      };
    } catch (err) {
      return {
        evaluator: this.name,
        passed: false,
        score: 0,
        details: [
          {
            criterion: "TypeScript compilation",
            passed: false,
            message: err instanceof Error ? err.message : String(err),
            severity: "error",
          },
        ],
        summary: "TypeScript check failed to execute.",
        feedback: `The typecheck command could not be run: ${err instanceof Error ? err.message : String(err)}`,
        timestamp,
      };
    }
  }
}

function buildFeedback(errors: TscError[]): string {
  if (errors.length === 0) return "Fix the TypeScript compilation errors shown above.";

  const grouped = new Map<string, TscError[]>();
  for (const err of errors) {
    const existing = grouped.get(err.file) ?? [];
    existing.push(err);
    grouped.set(err.file, existing);
  }

  const lines: string[] = ["Fix the following TypeScript errors:", ""];
  for (const [file, fileErrors] of grouped) {
    lines.push(`  ${file}:`);
    for (const e of fileErrors.slice(0, 10)) {
      lines.push(`    line ${e.line}: ${e.message} (${e.code})`);
    }
    if (fileErrors.length > 10) {
      lines.push(`    ... and ${fileErrors.length - 10} more`);
    }
  }

  return lines.join("\n");
}

/**
 * Default export: factory function for the registry.
 */
export function createTypescriptCheckEvaluator(): EvaluatorPlugin {
  return new TypeScriptCheckEvaluator();
}
