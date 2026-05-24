/**
 * Markdownlint compliance test for OnboardingComposer.
 *
 * Writes all 5 rendered artifacts to a temp directory via writeAll(),
 * then runs markdownlint-cli on that directory and asserts exit code 0.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { OnboardingComposer } from "../../src/graph/onboarding-composer.js";
import type { OnboardingInputs } from "../../src/graph/types.js";

const execFileAsync = promisify(execFile);

// ── Check markdownlint availability ───────────────────────────────

let hasMarkdownlint = false;
try {
  // Use the local node_modules binary
  const { stdout } = await execFileAsync("npx", ["--no", "markdownlint", "--version"], {
    timeout: 10_000,
  });
  hasMarkdownlint = stdout.trim().length > 0;
} catch {
  hasMarkdownlint = false;
}

// ── Fixture ────────────────────────────────────────────────────────

const POPULATED_INPUTS: OnboardingInputs = {
  status: { tokensaveVersion: "6.0.0-beta.1", indexedFileCount: 42 },
  hotspots: [
    { symbol: "parseGraph", file: "src/graph/parser.ts", line: 10, score: 95, reason: "High cyclomatic complexity" },
    { symbol: "buildIndex", file: "src/graph/indexer.ts", line: 55, score: 80, reason: "Large function" },
  ],
  deadCode: [
    { symbol: "legacyHelper", file: "src/utils/legacy.ts", line: 5 },
  ],
  circular: [],
  largest: [],
  moduleApis: [
    {
      module: "graph",
      community: "core",
      symbols: [
        { name: "GraphClient", file: "src/graph/client.ts", line: 10, hasInternalCallers: true },
        { name: "buildIndex", file: "src/graph/indexer.ts", line: 55, hasInternalCallers: false },
      ],
    },
    {
      module: "utils",
      community: "support",
      symbols: [
        { name: "assertNever", file: "src/graph/types.ts", line: 109, hasInternalCallers: false },
      ],
    },
  ],
  files: [
    { path: "src/graph/client.ts", symbols: 3 },
  ],
};

// ── Setup/teardown ─────────────────────────────────────────────────

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "bober-md-lint-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

// ── Markdownlint compliance test ───────────────────────────────────

describe("OnboardingComposer — markdownlint compliance", () => {
  it.skipIf(!hasMarkdownlint)(
    "all 5 rendered artifacts pass markdownlint with zero violations",
    async () => {
      const composer = new OnboardingComposer();
      const artifacts = composer.render(POPULATED_INPUTS);
      await composer.writeAll(artifacts, tmp);

      // Resolve the config file path — project root .markdownlint.json
      const configPath = join(new URL("../../.markdownlint.json", import.meta.url).pathname);

      let exitCode = 0;
      let stdout = "";
      let stderr = "";

      try {
        const result = await execFileAsync(
          "npx",
          ["--no", "markdownlint", "--config", configPath, `${tmp}/*.md`],
          { timeout: 30_000, shell: true },
        );
        stdout = result.stdout;
        stderr = result.stderr;
      } catch (err) {
        const execErr = err as { code?: number; stdout?: string; stderr?: string };
        exitCode = execErr.code ?? 1;
        stdout = execErr.stdout ?? "";
        stderr = execErr.stderr ?? "";
      }

      expect(exitCode, `markdownlint violations found:\n${stdout}\n${stderr}`).toBe(0);
    },
  );

  it("all 5 rendered artifact strings end with a trailing newline", () => {
    const composer = new OnboardingComposer();
    const artifacts = composer.render(POPULATED_INPUTS);

    expect(artifacts.readme, "readme must end with newline").toMatch(/\n$/);
    expect(artifacts.architectureOverview, "architectureOverview must end with newline").toMatch(/\n$/);
    expect(artifacts.hotspots, "hotspots must end with newline").toMatch(/\n$/);
    expect(artifacts.knowledgeGaps, "knowledgeGaps must end with newline").toMatch(/\n$/);
    expect(artifacts.communities, "communities must end with newline").toMatch(/\n$/);
  });

  it("empty-state artifacts also end with a trailing newline", async () => {
    const emptyInputs: OnboardingInputs = {
      status: { tokensaveVersion: "6.0.0-beta.1", indexedFileCount: 0 },
      hotspots: [],
      deadCode: [],
      circular: [],
      largest: [],
      moduleApis: [],
      files: [],
    };

    const composer = new OnboardingComposer();
    const artifacts = composer.render(emptyInputs);

    expect(artifacts.readme, "readme (empty) must end with newline").toMatch(/\n$/);
    expect(artifacts.architectureOverview, "architectureOverview (empty) must end with newline").toMatch(/\n$/);
    expect(artifacts.hotspots, "hotspots (empty) must end with newline").toMatch(/\n$/);
    expect(artifacts.knowledgeGaps, "knowledgeGaps (empty) must end with newline").toMatch(/\n$/);
    expect(artifacts.communities, "communities (empty) must end with newline").toMatch(/\n$/);
  });
});
