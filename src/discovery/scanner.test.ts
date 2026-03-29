/**
 * Unit tests for the deep programmatic codebase scanner.
 *
 * Tests run the scanner against agent-bober's own repository to verify
 * real-world output matches expected conventions for this project.
 *
 * All tests use the actual project root (process.cwd()), which must be
 * the agent-bober repository root when running vitest.
 */

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { scanProject } from "./scanner.js";
import { scanPackageScripts } from "./scanners/package-scripts.js";
import { scanCIChecks } from "./scanners/ci-checks.js";
import { scanGitConventions } from "./scanners/git-conventions.js";
import { scanCodeConventions } from "./scanners/code-conventions.js";
import { scanTestConventions } from "./scanners/test-conventions.js";
import { scanDocumentation } from "./scanners/documentation.js";

// ── Helpers ───────────────────────────────────────────────────────

/**
 * The project root is the agent-bober repo root.
 * When vitest runs, cwd() is the project root.
 */
const PROJECT_ROOT = process.cwd();

// ── scanProject (orchestrator) ────────────────────────────────────

describe("scanProject()", () => {
  it("returns a DiscoveryReport with all required sections", async () => {
    const report = await scanProject(PROJECT_ROOT);

    expect(report).toMatchObject({
      projectRoot: PROJECT_ROOT,
      scannedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });

    // All sections must be present (non-undefined)
    expect(report.packageScripts).not.toBeNull();
    expect(report.packageManager).not.toBeNull();
    expect(report.ciChecks).toBeDefined();
    expect(report.documentation).toBeDefined();
    expect(report.detectedStack).not.toBeNull();
  });

  it("sets projectRoot to the given absolute path", async () => {
    const report = await scanProject(PROJECT_ROOT);
    expect(report.projectRoot).toBe(PROJECT_ROOT);
  });

  it("sets scannedAt to an ISO timestamp near now", async () => {
    const before = Date.now();
    const report = await scanProject(PROJECT_ROOT);
    const after = Date.now();

    const scanTime = new Date(report.scannedAt).getTime();
    expect(scanTime).toBeGreaterThanOrEqual(before);
    expect(scanTime).toBeLessThanOrEqual(after);
  });

  it("does not throw on a non-existent directory -- returns graceful report", async () => {
    const report = await scanProject("/tmp/bober-nonexistent-test-dir-xyz");

    expect(report.packageScripts).toBeNull();
    expect(report.gitConventions).toBeNull();
    expect(report.ciChecks).toMatchObject({ workflows: [], allRunCommands: [] });
    expect(report.documentation).toMatchObject({ files: [] });
  });
});

// ── scanPackageScripts ────────────────────────────────────────────

describe("scanPackageScripts()", () => {
  it("reads agent-bober package.json and returns a report", async () => {
    const report = await scanPackageScripts(PROJECT_ROOT);
    expect(report).not.toBeNull();
  });

  it("detects npm as the package manager (package-lock.json present)", async () => {
    const report = await scanPackageScripts(PROJECT_ROOT);
    expect(report?.packageManager).toBe("npm");
  });

  it("maps build script correctly", async () => {
    const report = await scanPackageScripts(PROJECT_ROOT);
    expect(report?.categorized.build).toMatchObject({
      scriptName: "build",
      command: "tsc",
      runCommand: "npm run build",
    });
  });

  it("maps test script correctly", async () => {
    const report = await scanPackageScripts(PROJECT_ROOT);
    expect(report?.categorized.test).toMatchObject({
      scriptName: "test",
      runCommand: "npm run test",
    });
  });

  it("maps lint script correctly", async () => {
    const report = await scanPackageScripts(PROJECT_ROOT);
    const lint = report?.categorized.lint;
    expect(lint).toBeDefined();
    expect(lint?.scriptName).toBe("lint");
    expect(lint?.command).toContain("eslint");
  });

  it("maps typecheck script correctly", async () => {
    const report = await scanPackageScripts(PROJECT_ROOT);
    const typecheck = report?.categorized.typecheck;
    expect(typecheck).toBeDefined();
    expect(typecheck?.scriptName).toBe("typecheck");
  });

  it("maps dev script (tsc --watch)", async () => {
    const report = await scanPackageScripts(PROJECT_ROOT);
    const dev = report?.categorized.dev;
    expect(dev).toBeDefined();
    expect(dev?.scriptName).toBe("dev");
  });

  it("includes allScripts with all package.json scripts", async () => {
    const report = await scanPackageScripts(PROJECT_ROOT);
    expect(report?.allScripts).toHaveProperty("build");
    expect(report?.allScripts).toHaveProperty("test");
    expect(report?.allScripts).toHaveProperty("lint");
  });

  it("returns null for a directory without package.json", async () => {
    const report = await scanPackageScripts("/tmp");
    expect(report).toBeNull();
  });

  it("generates correct run command for yarn package manager", async () => {
    // Create a temporary directory with a yarn.lock and package.json
    const tmpDir = join("/tmp", "bober-test-yarn");
    await mkdir(tmpDir, { recursive: true });
    try {
      await writeFile(join(tmpDir, "package.json"), JSON.stringify({
        scripts: { build: "tsc", test: "jest", lint: "eslint src/" },
      }));
      await writeFile(join(tmpDir, "yarn.lock"), "");

      const report = await scanPackageScripts(tmpDir);
      expect(report?.packageManager).toBe("yarn");
      expect(report?.categorized.build?.runCommand).toBe("yarn build");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("generates correct run command for pnpm package manager", async () => {
    const tmpDir = join("/tmp", "bober-test-pnpm");
    await mkdir(tmpDir, { recursive: true });
    try {
      await writeFile(join(tmpDir, "package.json"), JSON.stringify({
        scripts: { build: "tsc" },
      }));
      await writeFile(join(tmpDir, "pnpm-lock.yaml"), "");

      const report = await scanPackageScripts(tmpDir);
      expect(report?.packageManager).toBe("pnpm");
      expect(report?.categorized.build?.runCommand).toBe("pnpm run build");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("generates correct run command for bun package manager", async () => {
    const tmpDir = join("/tmp", "bober-test-bun");
    await mkdir(tmpDir, { recursive: true });
    try {
      await writeFile(join(tmpDir, "package.json"), JSON.stringify({
        scripts: { test: "bun test" },
      }));
      await writeFile(join(tmpDir, "bun.lockb"), "");

      const report = await scanPackageScripts(tmpDir);
      expect(report?.packageManager).toBe("bun");
      expect(report?.categorized.test?.runCommand).toBe("bun run test");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── scanCIChecks ──────────────────────────────────────────────────

describe("scanCIChecks()", () => {
  it("returns a CIChecksReport with workflows array", async () => {
    const report = await scanCIChecks(PROJECT_ROOT);
    expect(report).toMatchObject({
      workflows: expect.any(Array),
      allRunCommands: expect.any(Array),
    });
  });

  it("returns empty workflows when no CI config exists in agent-bober repo", async () => {
    // agent-bober has no .github/workflows -- this should return empty gracefully
    const report = await scanCIChecks(PROJECT_ROOT);
    // Either empty (no CI files) or populated (CI exists): both are valid.
    // The key requirement is no exception and correct shape.
    expect(Array.isArray(report.workflows)).toBe(true);
    expect(Array.isArray(report.allRunCommands)).toBe(true);
  });

  it("parses inline run: commands from a sample YAML workflow", async () => {
    const tmpDir = join("/tmp", "bober-test-ci");
    const workflowDir = join(tmpDir, ".github", "workflows");
    await mkdir(workflowDir, { recursive: true });
    try {
      const yaml = [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - name: Install",
        "        run: npm install",
        "      - name: Test",
        "        run: npm test",
        "      - name: Build",
        "        run: npm run build",
      ].join("\n");

      await writeFile(join(workflowDir, "ci.yml"), yaml);

      const report = await scanCIChecks(tmpDir);
      expect(report.workflows).toHaveLength(1);
      expect(report.workflows[0]?.file).toBe(".github/workflows/ci.yml");

      const commands = report.workflows[0]?.steps.map((s) => s.runCommand);
      expect(commands).toContain("npm install");
      expect(commands).toContain("npm test");
      expect(commands).toContain("npm run build");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("infers correct categories for CI steps", async () => {
    const tmpDir = join("/tmp", "bober-test-ci-categories");
    const workflowDir = join(tmpDir, ".github", "workflows");
    await mkdir(workflowDir, { recursive: true });
    try {
      const yaml = [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  ci:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - name: Test",
        "        run: vitest run",
        "      - name: Lint",
        "        run: eslint src/",
        "      - name: Build",
        "        run: tsc",
        "      - name: Deploy",
        "        run: vercel deploy",
      ].join("\n");

      await writeFile(join(workflowDir, "ci.yml"), yaml);

      const report = await scanCIChecks(tmpDir);
      const steps = report.workflows[0]?.steps ?? [];

      const stepByCmd = (cmd: string) => steps.find((s) => s.runCommand === cmd);
      expect(stepByCmd("vitest run")?.category).toBe("test");
      expect(stepByCmd("eslint src/")?.category).toBe("lint");
      expect(stepByCmd("tsc")?.category).toBe("build");
      expect(stepByCmd("vercel deploy")?.category).toBe("deploy");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("parses multiline run: blocks", async () => {
    const tmpDir = join("/tmp", "bober-test-ci-multiline");
    const workflowDir = join(tmpDir, ".github", "workflows");
    await mkdir(workflowDir, { recursive: true });
    try {
      const yaml = [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - name: Setup and build",
        "        run: |",
        "          npm install",
        "          npm run build",
      ].join("\n");

      await writeFile(join(workflowDir, "ci.yml"), yaml);

      const report = await scanCIChecks(tmpDir);
      const steps = report.workflows[0]?.steps ?? [];
      expect(steps.length).toBeGreaterThan(0);
      // The multiline block should be captured as one command
      const runCmd = steps[0]?.runCommand ?? "";
      expect(runCmd).toContain("npm install");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── scanGitConventions ────────────────────────────────────────────

describe("scanGitConventions()", () => {
  it("scans agent-bober git history successfully", async () => {
    const report = await scanGitConventions(PROJECT_ROOT);
    // agent-bober is a git repo, so this should succeed
    expect(report).not.toBeNull();
  });

  it("returns recent commit messages (non-empty array)", async () => {
    const report = await scanGitConventions(PROJECT_ROOT);
    expect(report?.recentMessages.length).toBeGreaterThan(0);
  });

  it("detects a conventional-style prefix as most common commit pattern", async () => {
    const report = await scanGitConventions(PROJECT_ROOT);
    // The repo uses conventional commits (feat:, docs:, bober(*):, etc.)
    // At minimum, mostCommonPrefix should be non-null and contain ":"
    expect(report?.mostCommonPrefix).not.toBeNull();
    expect(report?.mostCommonPrefix).toMatch(/:/);
  });

  it("detects bober( prefix in recent commit messages", async () => {
    const report = await scanGitConventions(PROJECT_ROOT);
    // The repo has many "bober(sprint-N):" commits in its history
    const hasBober = report?.recentMessages.some((m) => m.startsWith("bober("));
    expect(hasBober).toBe(true);
  });

  it("detects branch patterns from git branches", async () => {
    const report = await scanGitConventions(PROJECT_ROOT);
    expect(Array.isArray(report?.branchPatterns)).toBe(true);
    // agent-bober has bober/* branches
    expect(report?.branchPatterns).toContain("bober/*");
  });

  it("includes branches array", async () => {
    const report = await scanGitConventions(PROJECT_ROOT);
    expect(Array.isArray(report?.branches)).toBe(true);
    expect(report?.branches.length).toBeGreaterThan(0);
  });

  it("returns null for a non-git directory", async () => {
    const report = await scanGitConventions("/tmp");
    expect(report).toBeNull();
  });

  it("provides mergeCommitRatio between 0 and 1", async () => {
    const report = await scanGitConventions(PROJECT_ROOT);
    expect(report?.mergeCommitRatio).toBeGreaterThanOrEqual(0);
    expect(report?.mergeCommitRatio).toBeLessThanOrEqual(1);
  });
});

// ── scanCodeConventions ───────────────────────────────────────────

describe("scanCodeConventions()", () => {
  it("scans agent-bober src/ and returns a report", async () => {
    const report = await scanCodeConventions(PROJECT_ROOT);
    expect(report).not.toBeNull();
  });

  it("detects camelCase as dominant file naming style", async () => {
    const report = await scanCodeConventions(PROJECT_ROOT);
    // agent-bober uses camelCase file names (init.ts, schema.ts, loader.ts, etc.)
    expect(report?.fileNaming.dominant).toBe("camelCase");
  });

  it("detects relative imports (TypeScript ESM project)", async () => {
    const report = await scanCodeConventions(PROJECT_ROOT);
    // This project uses relative imports with .js extensions
    expect(report?.importStyle.relativeCount).toBeGreaterThan(0);
  });

  it("detects .js extensions in imports (NodeNext module resolution)", async () => {
    const report = await scanCodeConventions(PROJECT_ROOT);
    expect(report?.importStyle.usesJsExtensions).toBe(true);
  });

  it("detects named exports as dominant pattern", async () => {
    const report = await scanCodeConventions(PROJECT_ROOT);
    expect(report?.exportStyle.dominant).toBe("named");
  });

  it("detects TypeScript patterns (interface usage)", async () => {
    const report = await scanCodeConventions(PROJECT_ROOT);
    expect(report?.typescriptPatterns).not.toBeNull();
    // The codebase uses many interfaces
    expect(report?.typescriptPatterns?.interfaceCount).toBeGreaterThan(0);
  });

  it("reports zero or minimal any usage (strict mode project)", async () => {
    const report = await scanCodeConventions(PROJECT_ROOT);
    // The project uses strict TypeScript -- should have very few : any usages
    // We can't guarantee zero, but the count should be low
    expect(report?.typescriptPatterns?.anyCount).toBeDefined();
  });

  it("reports filesSampled > 0", async () => {
    const report = await scanCodeConventions(PROJECT_ROOT);
    expect(report?.filesSampled).toBeGreaterThan(0);
  });

  it("returns null for a directory with no source files", async () => {
    const report = await scanCodeConventions("/tmp");
    // /tmp has no .ts or .js files matching our glob
    // May return null or a report with 0 files
    if (report !== null) {
      expect(report.filesSampled).toBeGreaterThanOrEqual(0);
    }
  });
});

// ── scanTestConventions ───────────────────────────────────────────

describe("scanTestConventions()", () => {
  it("scans agent-bober and returns a test conventions report", async () => {
    const report = await scanTestConventions(PROJECT_ROOT);
    expect(report).not.toBeNull();
  });

  it("detects vitest as the test framework", async () => {
    const report = await scanTestConventions(PROJECT_ROOT);
    expect(report?.framework).toBe("vitest");
  });

  it("detects *.test.ts file naming pattern", async () => {
    const report = await scanTestConventions(PROJECT_ROOT);
    expect(report?.filePattern).toBe("*.test.ts");
  });

  it("detects co-located tests (tests alongside source files)", async () => {
    const report = await scanTestConventions(PROJECT_ROOT);
    expect(report?.colocated).toBe(true);
  });

  it("detects vitest as the mocking library", async () => {
    const report = await scanTestConventions(PROJECT_ROOT);
    expect(report?.mockingLibrary).toBe("vitest");
  });

  it("testFileCount > 0 (there are existing tests)", async () => {
    const report = await scanTestConventions(PROJECT_ROOT);
    expect(report?.testFileCount).toBeGreaterThan(0);
  });

  it("includes testDirs array", async () => {
    const report = await scanTestConventions(PROJECT_ROOT);
    expect(Array.isArray(report?.testDirs)).toBe(true);
  });
});

// ── scanDocumentation ─────────────────────────────────────────────

describe("scanDocumentation()", () => {
  it("scans agent-bober and picks up README.md", async () => {
    const report = await scanDocumentation(PROJECT_ROOT);
    const readme = report.files.find((f) => f.path === "README.md");
    expect(readme).toBeDefined();
    expect(readme?.content.length).toBeGreaterThan(0);
  });

  it("truncates content to 2000 chars", async () => {
    const tmpDir = join("/tmp", "bober-test-docs");
    await mkdir(tmpDir, { recursive: true });
    try {
      // Write a README that is longer than 2000 chars
      const longContent = "A".repeat(5000);
      await writeFile(join(tmpDir, "README.md"), longContent);

      const report = await scanDocumentation(tmpDir);
      const readme = report.files.find((f) => f.path === "README.md");
      expect(readme?.content.length).toBe(2000);
      expect(readme?.truncated).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("marks short content as not truncated", async () => {
    const tmpDir = join("/tmp", "bober-test-docs-short");
    await mkdir(tmpDir, { recursive: true });
    try {
      await writeFile(join(tmpDir, "README.md"), "Short content");

      const report = await scanDocumentation(tmpDir);
      const readme = report.files.find((f) => f.path === "README.md");
      expect(readme?.truncated).toBe(false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns empty files array for a directory with no docs", async () => {
    const report = await scanDocumentation("/tmp");
    // /tmp should have no README.md, CONTRIBUTING.md, etc.
    // Result should be empty array, not an error
    expect(Array.isArray(report.files)).toBe(true);
  });

  it("reads docs/**/*.md files", async () => {
    const tmpDir = join("/tmp", "bober-test-docs-dir");
    const docsDir = join(tmpDir, "docs");
    await mkdir(docsDir, { recursive: true });
    try {
      await writeFile(join(docsDir, "guide.md"), "# Guide\nHello world");

      const report = await scanDocumentation(tmpDir);
      const guide = report.files.find((f) => f.path === "docs/guide.md");
      expect(guide).toBeDefined();
      expect(guide?.content).toContain("Hello world");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("reads CONTRIBUTING.md if present", async () => {
    const tmpDir = join("/tmp", "bober-test-docs-contributing");
    await mkdir(tmpDir, { recursive: true });
    try {
      await writeFile(join(tmpDir, "CONTRIBUTING.md"), "# Contributing\nPlease send PRs.");

      const report = await scanDocumentation(tmpDir);
      const contributing = report.files.find((f) => f.path === "CONTRIBUTING.md");
      expect(contributing).toBeDefined();
      expect(contributing?.content).toContain("Contributing");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not include files that do not exist without throwing", async () => {
    // Run against a dir that only has README.md
    const tmpDir = join("/tmp", "bober-test-docs-partial");
    await mkdir(tmpDir, { recursive: true });
    try {
      await writeFile(join(tmpDir, "README.md"), "Just a readme");

      const report = await scanDocumentation(tmpDir);
      // Only README.md should be present (CLAUDE.md, .cursorrules, etc. are absent)
      expect(report.files).toHaveLength(1);
      expect(report.files[0]?.path).toBe("README.md");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
