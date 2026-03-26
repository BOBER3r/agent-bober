import { execa } from "execa";

import type {
  EvaluatorPlugin,
  EvalContext,
  EvalResult,
  EvalDetail,
} from "../plugin-interface.js";
import type { BoberConfig } from "../../config/schema.js";

/**
 * A generic evaluator that runs an arbitrary shell command.
 *
 * This powers two use cases:
 * 1. Inline `command` field on any strategy (e.g. `{ "type": "k6", "command": "k6 run load.js", "required": false }`)
 * 2. Fallback for unknown strategy types that have a `command` configured
 *
 * Pass criteria: exit code 0 = pass, non-zero = fail.
 * Output is captured and parsed for common error patterns.
 */
export class CommandRunnerEvaluator implements EvaluatorPlugin {
  readonly name: string;
  readonly description: string;
  private readonly command: string;
  private readonly timeout: number;

  constructor(name: string, command: string, timeout = 120_000) {
    this.name = name;
    this.description = `Run command: ${command}`;
    this.command = command;
    this.timeout = timeout;
  }

  async canRun(_projectRoot: string, _config: BoberConfig): Promise<boolean> {
    // Command-based evaluators are always considered runnable.
    // If the command itself doesn't exist, evaluate() handles the error.
    return true;
  }

  async evaluate(context: EvalContext): Promise<EvalResult> {
    const timestamp = new Date().toISOString();
    const { projectRoot } = context;

    const timeout =
      (context.strategy.config?.["timeout"] as number | undefined) ??
      this.timeout;

    const parts = this.command.split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);

    try {
      const result = await execa(cmd, args, {
        cwd: projectRoot,
        timeout,
        reject: false,
        all: true,
        env: { ...process.env, FORCE_COLOR: "0" },
      });

      const output = result.all ?? result.stdout ?? "";
      const passed = result.exitCode === 0;

      const details: EvalDetail[] = [];

      if (!passed) {
        // Try to extract meaningful error lines from the output
        const lines = output.split("\n");
        const errorLines = lines.filter(
          (line) =>
            /error|fail|fatal|panic|exception/i.test(line) &&
            line.trim().length > 0,
        );

        if (errorLines.length > 0) {
          for (const line of errorLines.slice(0, 20)) {
            details.push({
              criterion: this.name,
              passed: false,
              message: line.trim(),
              severity: "error" as const,
            });
          }
        } else {
          // No specific errors found — include tail of output
          const tail = lines.slice(-10).join("\n").trim();
          details.push({
            criterion: this.name,
            passed: false,
            message: tail || `Command exited with code ${result.exitCode}`,
            severity: "error" as const,
          });
        }
      }

      return {
        evaluator: this.name,
        passed,
        score: passed ? 100 : 0,
        details,
        summary: passed
          ? `${this.name}: passed`
          : `${this.name}: failed (exit code ${result.exitCode ?? "unknown"})`,
        feedback: passed
          ? "Command completed successfully."
          : `Command failed. Output:\n${(output ?? "").slice(-2000)}`,
        timestamp,
      };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      return {
        evaluator: this.name,
        passed: false,
        score: 0,
        details: [
          {
            criterion: this.name,
            passed: false,
            message: `Failed to execute: ${message}`,
            severity: "error" as const,
          },
        ],
        summary: `${this.name}: error — ${message}`,
        feedback: `Could not run command "${this.command}": ${message}`,
        timestamp,
      };
    }
  }
}

/**
 * Factory: create a CommandRunnerEvaluator from a strategy's command field.
 */
export function createCommandRunnerEvaluator(
  name: string,
  command: string,
  timeout?: number,
): CommandRunnerEvaluator {
  return new CommandRunnerEvaluator(name, command, timeout);
}
