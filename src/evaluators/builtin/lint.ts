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

// ── ESLint JSON output types ───────────────────────────────────────

interface EslintMessage {
  ruleId: string | null;
  severity: 1 | 2; // 1 = warning, 2 = error
  message: string;
  line: number;
  column: number;
}

interface EslintFileResult {
  filePath: string;
  messages: EslintMessage[];
  errorCount: number;
  warningCount: number;
}

// ── ESLint config file candidates ──────────────────────────────────

const ESLINT_CONFIG_FILES = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".eslintrc.yml",
  ".eslintrc.yaml",
];

async function hasEslintConfig(projectRoot: string): Promise<boolean> {
  for (const candidate of ESLINT_CONFIG_FILES) {
    try {
      await access(join(projectRoot, candidate));
      return true;
    } catch {
      // not found
    }
  }
  return false;
}

// ── Parser ─────────────────────────────────────────────────────────

function parseEslintJson(raw: string): EslintFileResult[] {
  // ESLint --format json outputs an array.  Sometimes extra text
  // precedes the JSON (e.g. deprecation warnings).  Find the first '['.
  const jsonStart = raw.indexOf("[");
  if (jsonStart === -1) return [];

  try {
    const parsed: unknown = JSON.parse(raw.slice(jsonStart));
    if (!Array.isArray(parsed)) return [];
    return parsed as EslintFileResult[];
  } catch {
    return [];
  }
}

// ── Evaluator ──────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 60_000;

export class LintEvaluator implements EvaluatorPlugin {
  readonly name = "Lint";
  readonly description = "Runs ESLint (or a custom lint command) and reports violations.";

  async canRun(projectRoot: string, config: BoberConfig): Promise<boolean> {
    if (config.commands.lint) return true;
    return hasEslintConfig(projectRoot);
  }

  async evaluate(context: EvalContext): Promise<EvalResult> {
    const { projectRoot, config, strategy } = context;
    const timestamp = new Date().toISOString();
    const timeout = (strategy.config?.timeout as number) ?? DEFAULT_TIMEOUT_MS;

    // Prefer structured ESLint JSON output when no custom command is set.
    const useStructuredEslint = !config.commands.lint || config.commands.lint.includes("eslint");

    if (useStructuredEslint) {
      return this.runEslintStructured(projectRoot, config, timeout, timestamp);
    }

    return this.runGenericLint(projectRoot, config, timeout, timestamp);
  }

  // ── Structured ESLint ──────────────────────────────────────────

  private async runEslintStructured(
    projectRoot: string,
    config: BoberConfig,
    timeout: number,
    timestamp: string,
  ): Promise<EvalResult> {
    // Build command.  If config.commands.lint is set and contains "eslint",
    // we append --format json.  Otherwise default to npx eslint.
    let cmd: string;
    let args: string[];

    if (config.commands.lint) {
      const parts = config.commands.lint.split(/\s+/);
      cmd = parts[0];
      args = [...parts.slice(1), "--format", "json"];
    } else {
      cmd = "npx";
      args = ["eslint", ".", "--format", "json"];
    }

    try {
      const result = await execa(cmd, args, {
        cwd: projectRoot,
        timeout,
        reject: false,
        all: true,
      });

      const allOutput = result.all ?? result.stdout ?? "";
      const eslintResults = parseEslintJson(allOutput);

      // If we got structured results, use them.
      if (eslintResults.length > 0) {
        return this.buildFromEslintResults(eslintResults, timestamp);
      }

      // No structured results but exit code 0 => assume clean.
      if (result.exitCode === 0) {
        return {
          evaluator: this.name,
          passed: true,
          score: 100,
          details: [],
          summary: "Linting passed with no issues.",
          feedback: "No lint issues found.",
          timestamp,
        };
      }

      // Fallback: couldn't parse JSON, treat raw output as a single error.
      return {
        evaluator: this.name,
        passed: false,
        score: 0,
        details: [
          {
            criterion: "Lint check",
            passed: false,
            message: allOutput.slice(0, 2000) || `Lint exited with code ${result.exitCode}`,
            severity: "error",
          },
        ],
        summary: "Linting failed.",
        feedback: allOutput.slice(0, 2000),
        timestamp,
      };
    } catch (err) {
      return this.errorResult(err, timestamp);
    }
  }

  private buildFromEslintResults(
    results: EslintFileResult[],
    timestamp: string,
  ): EvalResult {
    let totalErrors = 0;
    let totalWarnings = 0;
    const details: EvalDetail[] = [];

    for (const file of results) {
      totalErrors += file.errorCount;
      totalWarnings += file.warningCount;

      for (const msg of file.messages) {
        details.push({
          criterion: msg.ruleId ? `lint/${msg.ruleId}` : "lint/unknown",
          passed: false,
          message: msg.message,
          file: file.filePath,
          line: msg.line,
          severity: msg.severity === 2 ? "error" : "warning",
        });
      }
    }

    const passed = totalErrors === 0;
    const totalIssues = totalErrors + totalWarnings;
    const score =
      totalIssues === 0
        ? 100
        : Math.max(0, Math.round(100 - (totalErrors * 10 + totalWarnings * 2)));

    const summary =
      totalIssues === 0
        ? "Linting passed with no issues."
        : `Linting found ${totalErrors} error(s) and ${totalWarnings} warning(s).`;

    const feedback = this.buildFeedback(details);

    return {
      evaluator: this.name,
      passed,
      score,
      details,
      summary,
      feedback,
      timestamp,
    };
  }

  // ── Generic lint command ───────────────────────────────────────

  private async runGenericLint(
    projectRoot: string,
    config: BoberConfig,
    timeout: number,
    timestamp: string,
  ): Promise<EvalResult> {
    const command = config.commands.lint!;
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
          summary: "Linting passed with no issues.",
          feedback: "No lint issues found.",
          timestamp,
        };
      }

      return {
        evaluator: this.name,
        passed: false,
        score: 0,
        details: [
          {
            criterion: "Lint check",
            passed: false,
            message: allOutput.slice(0, 2000) || `Lint exited with code ${result.exitCode}`,
            severity: "error",
          },
        ],
        summary: "Linting failed.",
        feedback: allOutput.slice(0, 2000),
        timestamp,
      };
    } catch (err) {
      return this.errorResult(err, timestamp);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────

  private buildFeedback(details: EvalDetail[]): string {
    if (details.length === 0) return "No lint issues found.";

    const errors = details.filter((d) => d.severity === "error");
    const warnings = details.filter((d) => d.severity === "warning");

    const lines: string[] = ["Fix the following lint issues:", ""];

    if (errors.length > 0) {
      lines.push("Errors (must fix):");
      for (const e of errors.slice(0, 20)) {
        const loc = e.file ? `  ${e.file}${e.line ? `:${e.line}` : ""}` : "  (unknown file)";
        lines.push(`${loc}: ${e.message} [${e.criterion}]`);
      }
      if (errors.length > 20) {
        lines.push(`  ... and ${errors.length - 20} more errors`);
      }
    }

    if (warnings.length > 0) {
      lines.push("", "Warnings (should fix):");
      for (const w of warnings.slice(0, 10)) {
        const loc = w.file ? `  ${w.file}${w.line ? `:${w.line}` : ""}` : "  (unknown file)";
        lines.push(`${loc}: ${w.message} [${w.criterion}]`);
      }
      if (warnings.length > 10) {
        lines.push(`  ... and ${warnings.length - 10} more warnings`);
      }
    }

    return lines.join("\n");
  }

  private errorResult(err: unknown, timestamp: string): EvalResult {
    return {
      evaluator: this.name,
      passed: false,
      score: 0,
      details: [
        {
          criterion: "Lint execution",
          passed: false,
          message: err instanceof Error ? err.message : String(err),
          severity: "error",
        },
      ],
      summary: "Lint check failed to execute.",
      feedback: `The lint command could not be run: ${err instanceof Error ? err.message : String(err)}`,
      timestamp,
    };
  }
}

/**
 * Factory function for the registry.
 */
export function createLintEvaluator(): EvaluatorPlugin {
  return new LintEvaluator();
}
