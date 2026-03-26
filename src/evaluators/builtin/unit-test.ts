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

// ── Test framework detection ───────────────────────────────────────

type TestFramework = "vitest" | "jest" | "unknown";

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

async function readPackageJson(projectRoot: string): Promise<PackageJson | null> {
  try {
    const raw = await readFile(join(projectRoot, "package.json"), "utf-8");
    return JSON.parse(raw) as PackageJson;
  } catch {
    return null;
  }
}

function detectFramework(pkg: PackageJson): TestFramework {
  const allDeps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
  };

  if ("vitest" in allDeps) return "vitest";
  if ("jest" in allDeps) return "jest";

  // Check scripts for hints
  const testScript = pkg.scripts?.test ?? "";
  if (testScript.includes("vitest")) return "vitest";
  if (testScript.includes("jest")) return "jest";

  return "unknown";
}

// ── JSON result shapes ─────────────────────────────────────────────

// Vitest JSON reporter output (subset)
interface VitestJsonResult {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  testResults: Array<{
    name: string;
    status: string;
    assertionResults: Array<{
      fullName: string;
      status: string;
      failureMessages?: string[];
      location?: { line: number; column: number };
    }>;
  }>;
}

// ── Parser ─────────────────────────────────────────────────────────

function parseJsonTestResults(raw: string): VitestJsonResult | null {
  // The JSON may be preceded by console output. Find the first '{'.
  const jsonStart = raw.indexOf("{");
  if (jsonStart === -1) return null;

  try {
    const parsed = JSON.parse(raw.slice(jsonStart)) as VitestJsonResult;
    if (typeof parsed.numTotalTests !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

// ── Evaluator ──────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 60_000;

export class UnitTestEvaluator implements EvaluatorPlugin {
  readonly name = "Unit Tests";
  readonly description = "Runs vitest or jest and reports test results.";

  async canRun(projectRoot: string, config: BoberConfig): Promise<boolean> {
    if (config.commands.test) return true;

    const pkg = await readPackageJson(projectRoot);
    if (!pkg) return false;

    const framework = detectFramework(pkg);
    return framework !== "unknown";
  }

  async evaluate(context: EvalContext): Promise<EvalResult> {
    const { projectRoot, config, strategy } = context;
    const timestamp = new Date().toISOString();
    const timeout = (strategy.config?.timeout as number) ?? DEFAULT_TIMEOUT_MS;

    // Determine command
    if (config.commands.test) {
      return this.runCustomCommand(config.commands.test, projectRoot, timeout, timestamp);
    }

    const pkg = await readPackageJson(projectRoot);
    const framework = pkg ? detectFramework(pkg) : "unknown";

    switch (framework) {
      case "vitest":
        return this.runVitest(projectRoot, timeout, timestamp);
      case "jest":
        return this.runJest(projectRoot, timeout, timestamp);
      default:
        return {
          evaluator: this.name,
          passed: false,
          score: 0,
          details: [
            {
              criterion: "Test framework detection",
              passed: false,
              message: "No supported test framework detected (vitest or jest).",
              severity: "error",
            },
          ],
          summary: "Could not detect a test framework.",
          feedback: "Install vitest or jest, or set commands.test in your bober config.",
          timestamp,
        };
    }
  }

  // ── Vitest ─────────────────────────────────────────────────────

  private async runVitest(
    projectRoot: string,
    timeout: number,
    timestamp: string,
  ): Promise<EvalResult> {
    try {
      const result = await execa("npx", ["vitest", "run", "--reporter", "json"], {
        cwd: projectRoot,
        timeout,
        reject: false,
        all: true,
      });

      const allOutput = result.all ?? result.stdout ?? "";
      return this.processJsonResults(allOutput, result.exitCode ?? 1, timestamp);
    } catch (err) {
      return this.errorResult(err, timestamp);
    }
  }

  // ── Jest ───────────────────────────────────────────────────────

  private async runJest(
    projectRoot: string,
    timeout: number,
    timestamp: string,
  ): Promise<EvalResult> {
    try {
      const result = await execa("npx", ["jest", "--json", "--forceExit"], {
        cwd: projectRoot,
        timeout,
        reject: false,
        all: true,
      });

      const allOutput = result.all ?? result.stdout ?? "";
      return this.processJsonResults(allOutput, result.exitCode ?? 1, timestamp);
    } catch (err) {
      return this.errorResult(err, timestamp);
    }
  }

  // ── Custom command ─────────────────────────────────────────────

  private async runCustomCommand(
    command: string,
    projectRoot: string,
    timeout: number,
    timestamp: string,
  ): Promise<EvalResult> {
    const [cmd, ...args] = command.split(/\s+/);

    try {
      const result = await execa(cmd, args, {
        cwd: projectRoot,
        timeout,
        reject: false,
        all: true,
      });

      const allOutput = result.all ?? result.stdout ?? "";

      // Try to parse JSON output (in case the custom command produces it).
      const jsonResults = parseJsonTestResults(allOutput);
      if (jsonResults) {
        return this.processJsonResults(allOutput, result.exitCode ?? 1, timestamp);
      }

      // Fallback: simple pass/fail based on exit code.
      if (result.exitCode === 0) {
        return {
          evaluator: this.name,
          passed: true,
          score: 100,
          details: [],
          summary: "All tests passed.",
          feedback: "Tests completed successfully.",
          timestamp,
        };
      }

      return {
        evaluator: this.name,
        passed: false,
        score: 0,
        details: [
          {
            criterion: "Test execution",
            passed: false,
            message: allOutput.slice(0, 2000) || `Tests exited with code ${result.exitCode}`,
            severity: "error",
          },
        ],
        summary: "Tests failed.",
        feedback: allOutput.slice(0, 2000),
        timestamp,
      };
    } catch (err) {
      return this.errorResult(err, timestamp);
    }
  }

  // ── Result processing ──────────────────────────────────────────

  private processJsonResults(
    rawOutput: string,
    exitCode: number,
    timestamp: string,
  ): EvalResult {
    const parsed = parseJsonTestResults(rawOutput);

    if (!parsed) {
      // Couldn't parse JSON — fall back to exit code.
      const passed = exitCode === 0;
      return {
        evaluator: this.name,
        passed,
        score: passed ? 100 : 0,
        details: passed
          ? []
          : [
              {
                criterion: "Test execution",
                passed: false,
                message:
                  rawOutput.slice(0, 2000) ||
                  `Tests exited with code ${exitCode}`,
                severity: "error",
              },
            ],
        summary: passed ? "Tests passed." : "Tests failed (could not parse JSON output).",
        feedback: passed ? "All tests passed." : rawOutput.slice(0, 2000),
        timestamp,
      };
    }

    const { numTotalTests, numPassedTests, numFailedTests, numPendingTests } = parsed;
    const details: EvalDetail[] = [];

    // Map each failed test to a detail.
    for (const suite of parsed.testResults ?? []) {
      for (const assertion of suite.assertionResults ?? []) {
        if (assertion.status === "failed") {
          details.push({
            criterion: `test: ${assertion.fullName}`,
            passed: false,
            message: (assertion.failureMessages ?? []).join("\n").slice(0, 500),
            file: suite.name,
            line: assertion.location?.line,
            severity: "error",
          });
        }
      }
    }

    const passed = numFailedTests === 0;
    const score = numTotalTests === 0 ? 100 : Math.round((numPassedTests / numTotalTests) * 100);

    const summary = [
      `Tests: ${numPassedTests} passed`,
      numFailedTests > 0 ? `${numFailedTests} failed` : null,
      numPendingTests > 0 ? `${numPendingTests} skipped` : null,
      `${numTotalTests} total`,
    ]
      .filter(Boolean)
      .join(", ");

    const feedback = this.buildFeedback(passed, details, numFailedTests);

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

  // ── Helpers ────────────────────────────────────────────────────

  private buildFeedback(passed: boolean, details: EvalDetail[], failedCount: number): string {
    if (passed) return "All tests passed. No changes needed.";

    const lines = [`${failedCount} test(s) failed. Fix the following:`, ""];
    for (const d of details.slice(0, 15)) {
      const loc = d.file ? `  ${d.file}${d.line ? `:${d.line}` : ""}` : "  (unknown)";
      lines.push(`${loc}`);
      lines.push(`    ${d.criterion}: ${d.message.split("\n")[0]}`);
    }
    if (details.length > 15) {
      lines.push(`  ... and ${details.length - 15} more failures`);
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
          criterion: "Test execution",
          passed: false,
          message: err instanceof Error ? err.message : String(err),
          severity: "error",
        },
      ],
      summary: "Unit test runner failed to execute.",
      feedback: `The test command could not be run: ${err instanceof Error ? err.message : String(err)}`,
      timestamp,
    };
  }
}

/**
 * Factory function for the registry.
 */
export function createUnitTestEvaluator(): EvaluatorPlugin {
  return new UnitTestEvaluator();
}
