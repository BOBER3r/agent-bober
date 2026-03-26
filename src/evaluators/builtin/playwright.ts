import { readFile, readdir } from "node:fs/promises";
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

async function hasPlaywrightConfig(projectRoot: string): Promise<boolean> {
  const configNames = [
    "playwright.config.ts",
    "playwright.config.js",
    "playwright.config.mjs",
  ];
  for (const name of configNames) {
    try {
      await readFile(join(projectRoot, name), "utf-8");
      return true;
    } catch {
      // continue
    }
  }
  return false;
}

async function hasE2eTests(projectRoot: string): Promise<boolean> {
  try {
    const entries = await readdir(join(projectRoot, "e2e"));
    return entries.some(
      (e) => e.endsWith(".spec.ts") || e.endsWith(".spec.js") || e.endsWith(".test.ts") || e.endsWith(".test.js"),
    );
  } catch {
    return false;
  }
}

/**
 * Check if a specific port is in use by attempting to parse lsof output.
 * Returns true if the port appears to be in use.
 */
async function isPortInUse(port: number): Promise<boolean> {
  try {
    const result = await execa("lsof", ["-i", `:${port}`, "-t"], {
      reject: false,
      timeout: 5000,
    });
    return result.exitCode === 0 && (result.stdout ?? "").trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Extract the port number from a playwright.config.ts or bober.config.json.
 * Falls back to 3000 if nothing can be determined.
 */
async function detectPort(
  projectRoot: string,
  config: BoberConfig,
): Promise<number> {
  // Try to parse port from playwright.config.ts
  try {
    const pwConfig = await readFile(
      join(projectRoot, "playwright.config.ts"),
      "utf-8",
    );
    // Look for port: <number> in the webServer block
    const portMatch = pwConfig.match(/port\s*:\s*(\d+)/);
    if (portMatch) {
      return parseInt(portMatch[1], 10);
    }
    // Look for baseURL with port
    const urlMatch = pwConfig.match(/baseURL\s*:\s*['"]https?:\/\/[^:]+:(\d+)/);
    if (urlMatch) {
      return parseInt(urlMatch[1], 10);
    }
  } catch {
    // No playwright config — continue
  }

  // Try to extract port from the dev command
  const devCmd = config.commands.dev ?? "";
  const portFlag = devCmd.match(/--port\s+(\d+)|--port=(\d+)|-p\s+(\d+)/);
  if (portFlag) {
    const portStr = portFlag[1] ?? portFlag[2] ?? portFlag[3];
    if (portStr) return parseInt(portStr, 10);
  }

  return 3000;
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

/**
 * Collect screenshot paths from the test-results directory.
 * Scans one level of subdirectories (Playwright creates one folder per test).
 */
async function collectScreenshots(projectRoot: string): Promise<string[]> {
  const screenshots: string[] = [];
  const resultsDir = join(projectRoot, "test-results");

  try {
    const topEntries = await readdir(resultsDir);
    for (const topEntry of topEntries) {
      const subDir = join(resultsDir, topEntry);
      try {
        const subEntries = await readdir(subDir);
        for (const entry of subEntries) {
          if (
            entry.endsWith(".png") ||
            entry.endsWith(".jpg") ||
            entry.endsWith(".jpeg")
          ) {
            screenshots.push(join("test-results", topEntry, entry));
          }
        }
      } catch {
        // Not a directory or inaccessible — skip
      }
    }
  } catch {
    // test-results directory does not exist — that's fine
  }

  return screenshots;
}

// ── Dev server management ──────────────────────────────────────────

interface DevServerHandle {
  process: ReturnType<typeof execa>;
  kill: () => void;
}

async function startDevServer(
  projectRoot: string,
  devCommand: string,
  waitMs: number = 8000,
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
      try {
        child.kill("SIGTERM");
        // Give SIGTERM a moment, then force kill
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // Process already dead
          }
        }, 3000);
      } catch {
        // Process already dead
      }
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

    // Check if Playwright is installed at all
    if (!(await hasPlaywright(projectRoot))) {
      return {
        evaluator: this.name,
        passed: true,
        score: undefined,
        details: [],
        summary: "Playwright not installed. Skipped.",
        feedback:
          "Playwright is not installed in this project. Run /bober-playwright setup to initialize. Marked as skipped, not failed.",
        timestamp,
      };
    }

    // Check if playwright.config.ts exists
    if (!(await hasPlaywrightConfig(projectRoot))) {
      return {
        evaluator: this.name,
        passed: true,
        score: undefined,
        details: [],
        summary: "Playwright config not found. Skipped.",
        feedback:
          "No playwright.config.ts found. Run /bober-playwright setup to create one. Marked as skipped, not failed.",
        timestamp,
      };
    }

    // Check if there are any E2E test files
    if (!(await hasE2eTests(projectRoot))) {
      return {
        evaluator: this.name,
        passed: true,
        score: undefined,
        details: [],
        summary: "No E2E test files found. Skipped.",
        feedback:
          "No test files found in e2e/ directory. Use /bober-playwright to generate tests. Marked as skipped, not failed.",
        timestamp,
      };
    }

    // Detect the port and check if the webServer block will handle the dev server
    const port = await detectPort(projectRoot, config);
    const hasWebServerConfig = await this.configHasWebServer(projectRoot);

    let server: DevServerHandle | null = null;

    try {
      // Only start a separate dev server if:
      // 1. The playwright config does NOT have a webServer block (Playwright won't start one)
      // 2. The port is not already in use (someone else started it)
      // 3. There is a dev command configured
      if (!hasWebServerConfig && config.commands.dev) {
        const portBusy = await isPortInUse(port);
        if (!portBusy) {
          server = await startDevServer(projectRoot, config.commands.dev);
        }
      }

      return await this.runPlaywright(projectRoot, strategy, timeout, timestamp);
    } finally {
      if (server) {
        server.kill();
      }
    }
  }

  /**
   * Check if the playwright.config.ts has a webServer configuration block.
   * If it does, Playwright will manage the dev server itself.
   */
  private async configHasWebServer(projectRoot: string): Promise<boolean> {
    try {
      const configContent = await readFile(
        join(projectRoot, "playwright.config.ts"),
        "utf-8",
      );
      return configContent.includes("webServer");
    } catch {
      return false;
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

      // Also try reading the JSON results file directly (more reliable than stdout parsing)
      let report = parsePlaywrightJson(allOutput);
      if (!report) {
        report = await this.readJsonResultsFile(projectRoot);
      }

      if (report) {
        return this.buildFromReport(report, projectRoot, timestamp);
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

  /**
   * Try to read the JSON results file from the e2e-results directory.
   * This is more reliable than parsing stdout because the JSON reporter
   * writes directly to a file.
   */
  private async readJsonResultsFile(
    projectRoot: string,
  ): Promise<PlaywrightJsonReport | null> {
    const possiblePaths = [
      join(projectRoot, "e2e-results", "results.json"),
      join(projectRoot, "test-results.json"),
      join(projectRoot, "playwright-report", "results.json"),
    ];

    for (const filePath of possiblePaths) {
      try {
        const raw = await readFile(filePath, "utf-8");
        const report = parsePlaywrightJson(raw);
        if (report) return report;
      } catch {
        // File doesn't exist — try next
      }
    }

    return null;
  }

  private async buildFromReport(
    report: PlaywrightJsonReport,
    projectRoot: string,
    timestamp: string,
  ): Promise<EvalResult> {
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

    // Collect screenshots from the test-results directory for enriching feedback
    const screenshots = await collectScreenshots(projectRoot);

    for (const test of allTests) {
      if (test.status === "failed" || test.status === "timedOut") {
        let message = test.error ?? `Test ${test.status}`;

        // Include screenshot path from the test attachment or from the directory scan
        if (test.screenshot) {
          message += `\nScreenshot: ${test.screenshot}`;
        } else {
          // Try to find a matching screenshot by test name
          const matchingScreenshot = screenshots.find((s) =>
            s.toLowerCase().includes(
              test.title
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .slice(0, 40),
            ),
          );
          if (matchingScreenshot) {
            message += `\nScreenshot: ${matchingScreenshot}`;
          }
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

    // Append screenshot summary if failures have screenshots
    const screenshotCount = details.filter((d) =>
      d.message.includes("Screenshot:"),
    ).length;
    if (screenshotCount > 0) {
      summaryParts.push(`${screenshotCount} failure screenshot(s) captured`);
    }

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

      // Include screenshot info if present
      const screenshotLine = d.message.split("\n").find((l) => l.startsWith("Screenshot:"));
      if (screenshotLine) {
        lines.push(`    ${screenshotLine}`);
      }
    }
    if (details.length > 10) {
      lines.push(`  ... and ${details.length - 10} more failures`);
    }

    lines.push("");
    lines.push("Investigate the failing assertions and fix either the UI code or the test expectations.");
    lines.push("Check test-results/ for failure screenshots if available.");

    return lines.join("\n");
  }

  private errorResult(err: unknown, timestamp: string): EvalResult {
    const message = err instanceof Error ? err.message : String(err);

    // Detect specific error conditions for better feedback
    let feedback = `Playwright could not be run: ${message}`;
    if (message.includes("ENOENT") || message.includes("not found")) {
      feedback =
        "Playwright binary not found. Run 'npx playwright install chromium' to install browser binaries.";
    } else if (message.includes("ETIMEDOUT") || message.includes("timeout")) {
      feedback =
        "Playwright tests timed out. This usually means the dev server failed to start or the application is hanging. " +
        "Check playwright.config.ts webServer settings and verify the dev server starts correctly with the configured command.";
    } else if (message.includes("ERR_CONNECTION_REFUSED")) {
      feedback =
        "Could not connect to the dev server. Verify the port in playwright.config.ts matches the dev server port " +
        "and that the dev server starts successfully.";
    }

    return {
      evaluator: this.name,
      passed: false,
      score: 0,
      details: [
        {
          criterion: "Playwright execution",
          passed: false,
          message,
          severity: "error",
        },
      ],
      summary: "Playwright E2E tests failed to execute.",
      feedback,
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
