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

// ── Playwright JSON reporter types ─────────────────────────────────

interface PlaywrightTestResult {
  status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
  duration: number;
  error?: { message?: string; stack?: string };
  attachments?: Array<{ name: string; path?: string; contentType: string }>;
}

interface PlaywrightSuite {
  title: string;
  suites?: PlaywrightSuite[];
  specs?: Array<{
    title: string;
    tests: Array<{
      results: PlaywrightTestResult[];
      projectName: string;
    }>;
    location?: { file: string; line: number; column: number };
  }>;
}

interface PlaywrightJsonReport {
  suites: PlaywrightSuite[];
  stats?: {
    expected: number;
    unexpected: number;
    flaky: number;
    skipped: number;
    duration: number;
  };
}

// ── Helpers ────────────────────────────────────────────────────────

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function hasPlaywright(projectRoot: string): Promise<boolean> {
  try {
    const raw = await readFile(join(projectRoot, "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as PackageJson;
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    return "@playwright/test" in allDeps || "playwright" in allDeps;
  } catch {
    return false;
  }
}

interface FlatTest {
  title: string;
  status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
  error?: string;
  file?: string;
  line?: number;
  screenshot?: string;
}

function flattenSuites(suite: PlaywrightSuite, prefix: string = ""): FlatTest[] {
  const tests: FlatTest[] = [];
  const suiteName = prefix ? `${prefix} > ${suite.title}` : suite.title;

  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests) {
      const lastResult = test.results[test.results.length - 1];
      if (!lastResult) continue;

      const screenshot = lastResult.attachments?.find(
        (a) => a.contentType.startsWith("image/") && a.path,
      );

      tests.push({
        title: `${suiteName} > ${spec.title}`,
        status: lastResult.status,
        error: lastResult.error?.message ?? lastResult.error?.stack,
        file: spec.location?.file,
        line: spec.location?.line,
        screenshot: screenshot?.path,
      });
    }
  }

  for (const child of suite.suites ?? []) {
    tests.push(...flattenSuites(child, suiteName));
  }

  return tests;
}

function parsePlaywrightJson(raw: string): PlaywrightJsonReport | null {
  const jsonStart = raw.indexOf("{");
  if (jsonStart === -1) return null;

  try {
    const parsed = JSON.parse(raw.slice(jsonStart)) as PlaywrightJsonReport;
    if (!Array.isArray(parsed.suites)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ── Dev server management ──────────────────────────────────────────

interface DevServerHandle {
  process: ReturnType<typeof execa>;
  kill: () => void;
}

async function startDevServer(
  projectRoot: string,
  devCommand: string,
  waitMs: number = 5000,
): Promise<DevServerHandle> {
  const [cmd, ...args] = devCommand.split(/\s+/);
  const child = execa(cmd, args, {
    cwd: projectRoot,
    reject: false,
    // Let the process run in the background.
    cleanup: true,
  });

  // Give the server time to start.
  await new Promise((resolve) => setTimeout(resolve, waitMs));

  return {
    process: child,
    kill: () => {
      child.kill("SIGTERM");
    },
  };
}

// ── Evaluator ──────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 120_000;

export class PlaywrightEvaluator implements EvaluatorPlugin {
  readonly name = "Playwright E2E";
  readonly description = "Runs Playwright end-to-end tests and reports results.";

  async canRun(projectRoot: string, _config: BoberConfig): Promise<boolean> {
    return hasPlaywright(projectRoot);
  }

  async evaluate(context: EvalContext): Promise<EvalResult> {
    const { projectRoot, config, strategy } = context;
    const timestamp = new Date().toISOString();
    const timeout = (strategy.config?.timeout as number) ?? DEFAULT_TIMEOUT_MS;
    const shouldStartServer = (strategy.config?.startServer as boolean) ?? true;

    let server: DevServerHandle | null = null;

    try {
      // Start dev server if configured and requested.
      if (shouldStartServer && config.commands.dev) {
        server = await startDevServer(projectRoot, config.commands.dev);
      }

      return await this.runPlaywright(projectRoot, strategy, timeout, timestamp);
    } finally {
      if (server) {
        server.kill();
      }
    }
  }

  private async runPlaywright(
    projectRoot: string,
    strategy: { config?: Record<string, unknown> },
    timeout: number,
    timestamp: string,
  ): Promise<EvalResult> {
    const args = ["playwright", "test", "--reporter", "json"];

    // Add base URL if configured.
    const baseUrl = strategy.config?.baseUrl as string | undefined;
    if (baseUrl) {
      args.push(`--config-base-url=${baseUrl}`);
    }

    try {
      const result = await execa("npx", args, {
        cwd: projectRoot,
        timeout,
        reject: false,
        all: true,
        env: {
          ...process.env,
          // Force non-interactive mode.
          CI: "true",
        },
      });

      const allOutput = result.all ?? result.stdout ?? "";
      const report = parsePlaywrightJson(allOutput);

      if (report) {
        return this.buildFromReport(report, timestamp);
      }

      // Couldn't parse JSON — fall back to exit code.
      if (result.exitCode === 0) {
        return {
          evaluator: this.name,
          passed: true,
          score: 100,
          details: [],
          summary: "All Playwright tests passed.",
          feedback: "E2E tests completed successfully.",
          timestamp,
        };
      }

      return {
        evaluator: this.name,
        passed: false,
        score: 0,
        details: [
          {
            criterion: "Playwright test execution",
            passed: false,
            message:
              allOutput.slice(0, 2000) ||
              `Playwright exited with code ${result.exitCode}`,
            severity: "error",
          },
        ],
        summary: "Playwright tests failed.",
        feedback: allOutput.slice(0, 2000),
        timestamp,
      };
    } catch (err) {
      return this.errorResult(err, timestamp);
    }
  }

  private buildFromReport(
    report: PlaywrightJsonReport,
    timestamp: string,
  ): EvalResult {
    const allTests: FlatTest[] = [];
    for (const suite of report.suites) {
      allTests.push(...flattenSuites(suite));
    }

    const total = allTests.length;
    const passed = allTests.filter((t) => t.status === "passed").length;
    const failed = allTests.filter(
      (t) => t.status === "failed" || t.status === "timedOut",
    ).length;
    const skipped = allTests.filter((t) => t.status === "skipped").length;

    const details: EvalDetail[] = [];

    for (const test of allTests) {
      if (test.status === "failed" || test.status === "timedOut") {
        let message = test.error ?? `Test ${test.status}`;
        if (test.screenshot) {
          message += `\nScreenshot: ${test.screenshot}`;
        }

        details.push({
          criterion: `e2e: ${test.title}`,
          passed: false,
          message: message.slice(0, 500),
          file: test.file,
          line: test.line,
          severity: "error",
        });
      }
    }

    const allPassed = failed === 0;
    const score = total === 0 ? 100 : Math.round((passed / total) * 100);

    const summaryParts = [`E2E Tests: ${passed} passed`];
    if (failed > 0) summaryParts.push(`${failed} failed`);
    if (skipped > 0) summaryParts.push(`${skipped} skipped`);
    summaryParts.push(`${total} total`);

    return {
      evaluator: this.name,
      passed: allPassed,
      score,
      details,
      summary: summaryParts.join(", "),
      feedback: this.buildFeedback(allPassed, details, failed),
      timestamp,
    };
  }

  private buildFeedback(
    allPassed: boolean,
    details: EvalDetail[],
    failedCount: number,
  ): string {
    if (allPassed) return "All E2E tests passed. No changes needed.";

    const lines = [`${failedCount} E2E test(s) failed. Fix the following:`, ""];
    for (const d of details.slice(0, 10)) {
      const loc = d.file ? `  ${d.file}${d.line ? `:${d.line}` : ""}` : "  (unknown)";
      lines.push(`${loc}`);
      lines.push(`    ${d.criterion}: ${d.message.split("\n")[0]}`);
    }
    if (details.length > 10) {
      lines.push(`  ... and ${details.length - 10} more failures`);
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
          criterion: "Playwright execution",
          passed: false,
          message: err instanceof Error ? err.message : String(err),
          severity: "error",
        },
      ],
      summary: "Playwright E2E tests failed to execute.",
      feedback: `Playwright could not be run: ${err instanceof Error ? err.message : String(err)}`,
      timestamp,
    };
  }
}

/**
 * Factory function for the registry.
 */
export function createPlaywrightEvaluator(): EvaluatorPlugin {
  return new PlaywrightEvaluator();
}
