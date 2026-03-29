/**
 * Unit tests for generateEvalConfig().
 *
 * Three test axes:
 * 1. Agent-bober's own DiscoveryReport (via scanProject) to verify real output.
 * 2. Controlled mock reports to verify CI-derived strategy generation.
 * 3. Commands generation correctness for each package manager.
 */

import { describe, it, expect } from "vitest";
import { generateEvalConfig } from "./config-generator.js";
import { scanProject } from "./scanner.js";
import type { DiscoveryReport, PackageScriptsReport, DetectedStackReport } from "./types.js";

// ── Helpers ───────────────────────────────────────────────────────

const PROJECT_ROOT = process.cwd();

/** Minimal DiscoveryReport with all nullable fields set to null. */
function makeReport(overrides: Partial<DiscoveryReport> = {}): DiscoveryReport {
  return {
    projectRoot: "/tmp/test-project",
    scannedAt: new Date().toISOString(),
    packageScripts: null,
    packageManager: null,
    ciChecks: { workflows: [], allRunCommands: [] },
    gitConventions: null,
    codeConventions: null,
    testConventions: null,
    documentation: { files: [] },
    detectedStack: null,
    ...overrides,
  };
}

function makePackageScripts(
  pm: PackageScriptsReport["packageManager"],
  scripts: Array<{ scriptName: string; command: string; category: string }>,
): PackageScriptsReport {
  type Cat = "build" | "test" | "lint" | "typecheck" | "dev" | "install";

  const buildRunCommand = (p: typeof pm, name: string): string => {
    switch (p) {
      case "yarn": return `yarn ${name}`;
      case "pnpm": return `pnpm run ${name}`;
      case "bun": return `bun run ${name}`;
      default: return `npm run ${name}`;
    }
  };

  const categorized: PackageScriptsReport["categorized"] = {};
  const allScripts: Record<string, string> = {};

  for (const { scriptName, command, category } of scripts) {
    allScripts[scriptName] = command;
    const cat = category as Cat;
    if (!(cat in categorized)) {
      categorized[cat] = {
        scriptName,
        command,
        runCommand: buildRunCommand(pm, scriptName),
      };
    }
  }

  return { packageManager: pm, allScripts, categorized };
}

function makeStack(overrides: Partial<DetectedStackReport> = {}): DetectedStackReport {
  return {
    hasTypescript: false,
    hasReact: false,
    hasNext: false,
    hasVite: false,
    hasPlaywright: false,
    hasEslint: false,
    hasVitest: false,
    hasJest: false,
    hasPython: false,
    hasRust: false,
    hasNestjs: false,
    hasFastify: false,
    hasExpress: false,
    primaryLanguage: "unknown",
    ...overrides,
  };
}

// ── Tests against agent-bober's own repo ─────────────────────────

describe("generateEvalConfig() against agent-bober repo", () => {
  it("produces typecheck, lint, build, unit-test strategies", async () => {
    const report = await scanProject(PROJECT_ROOT);
    const { strategies } = generateEvalConfig(report);
    const types = strategies.map((s) => s.type);

    expect(types).toContain("typecheck");
    expect(types).toContain("lint");
    expect(types).toContain("build");
    expect(types).toContain("unit-test");
  });

  it("typecheck strategy has required: true", async () => {
    const report = await scanProject(PROJECT_ROOT);
    const { strategies } = generateEvalConfig(report);
    const tc = strategies.find((s) => s.type === "typecheck");
    expect(tc?.required).toBe(true);
  });

  it("lint strategy has required: true", async () => {
    const report = await scanProject(PROJECT_ROOT);
    const { strategies } = generateEvalConfig(report);
    const lint = strategies.find((s) => s.type === "lint");
    expect(lint?.required).toBe(true);
  });

  it("build strategy has required: true", async () => {
    const report = await scanProject(PROJECT_ROOT);
    const { strategies } = generateEvalConfig(report);
    const build = strategies.find((s) => s.type === "build");
    expect(build?.required).toBe(true);
  });

  it("unit-test strategy has required: true", async () => {
    const report = await scanProject(PROJECT_ROOT);
    const { strategies } = generateEvalConfig(report);
    const ut = strategies.find((s) => s.type === "unit-test");
    expect(ut?.required).toBe(true);
  });

  it("commands.build is 'npm run build'", async () => {
    const report = await scanProject(PROJECT_ROOT);
    const { commands } = generateEvalConfig(report);
    expect(commands.build).toBe("npm run build");
  });

  it("commands.typecheck is 'npm run typecheck'", async () => {
    const report = await scanProject(PROJECT_ROOT);
    const { commands } = generateEvalConfig(report);
    expect(commands.typecheck).toBe("npm run typecheck");
  });

  it("commands.lint is 'npm run lint'", async () => {
    const report = await scanProject(PROJECT_ROOT);
    const { commands } = generateEvalConfig(report);
    expect(commands.lint).toBe("npm run lint");
  });

  it("commands.test is 'npm run test'", async () => {
    const report = await scanProject(PROJECT_ROOT);
    const { commands } = generateEvalConfig(report);
    expect(commands.test).toBe("npm run test");
  });

  it("commands.install is 'npm install' (npm project)", async () => {
    const report = await scanProject(PROJECT_ROOT);
    const { commands } = generateEvalConfig(report);
    expect(commands.install).toBe("npm install");
  });

  it("does not produce playwright strategy (no @playwright/test dep)", async () => {
    const report = await scanProject(PROJECT_ROOT);
    const { strategies } = generateEvalConfig(report);
    const pw = strategies.find((s) => s.type === "playwright");
    expect(pw).toBeUndefined();
  });

  it("does not produce api-check strategy (no API framework dep)", async () => {
    const report = await scanProject(PROJECT_ROOT);
    const { strategies } = generateEvalConfig(report);
    const api = strategies.find((s) => s.type === "api-check");
    expect(api).toBeUndefined();
  });
});

// ── CI-derived strategies ─────────────────────────────────────────

describe("generateEvalConfig() CI-derived strategies", () => {
  it("generates inline command strategy for novel CI command", () => {
    const report = makeReport({
      ciChecks: {
        workflows: [
          {
            file: ".github/workflows/ci.yml",
            steps: [
              { name: "Clippy", runCommand: "cargo clippy", category: "lint" },
            ],
          },
        ],
        allRunCommands: ["cargo clippy"],
      },
    });

    const { strategies } = generateEvalConfig(report);
    const ci = strategies.find((s) => s.command === "cargo clippy");
    expect(ci).toBeDefined();
    expect(ci?.required).toBe(false);
    expect(ci?.label).toMatch(/from CI/i);
  });

  it("CI strategy type name is kebab-case derived from command", () => {
    const report = makeReport({
      ciChecks: {
        workflows: [
          {
            file: ".github/workflows/ci.yml",
            steps: [
              { name: "Clippy", runCommand: "cargo clippy", category: "other" },
            ],
          },
        ],
        allRunCommands: ["cargo clippy"],
      },
    });

    const { strategies } = generateEvalConfig(report);
    const ci = strategies.find((s) => s.command === "cargo clippy");
    expect(ci?.type).toBe("cargo-clippy");
  });

  it("label includes '(from CI)' suffix", () => {
    const report = makeReport({
      ciChecks: {
        workflows: [
          {
            file: ".github/workflows/ci.yml",
            steps: [
              { name: "Security audit", runCommand: "npm audit", category: "other" },
            ],
          },
        ],
        allRunCommands: ["npm audit"],
      },
    });

    const { strategies } = generateEvalConfig(report);
    const ci = strategies.find((s) => s.command === "npm audit");
    expect(ci?.label).toContain("(from CI)");
  });

  it("does not duplicate a CI command that maps to an already-covered type", () => {
    const report = makeReport({
      packageScripts: makePackageScripts("npm", [
        { scriptName: "lint", command: "eslint src/", category: "lint" },
      ]),
      packageManager: "npm",
      ciChecks: {
        workflows: [
          {
            file: ".github/workflows/ci.yml",
            steps: [
              { name: "Lint", runCommand: "npm run lint", category: "lint" },
            ],
          },
        ],
        allRunCommands: ["npm run lint"],
      },
    });

    const { strategies } = generateEvalConfig(report);
    const lintStrategies = strategies.filter((s) => s.type === "lint");
    // Should only have one lint strategy (from package scripts, not CI)
    expect(lintStrategies).toHaveLength(1);
    // The core strategy does not have an inline command
    expect(lintStrategies[0]?.command).toBeUndefined();
  });

  it("deduplicates identical CI commands (same type produced twice)", () => {
    const report = makeReport({
      ciChecks: {
        workflows: [
          {
            file: ".github/workflows/ci.yml",
            steps: [
              { name: "Step A", runCommand: "cargo clippy", category: "other" },
              { name: "Step B", runCommand: "cargo clippy", category: "other" },
            ],
          },
        ],
        allRunCommands: ["cargo clippy"],
      },
    });

    const { strategies } = generateEvalConfig(report);
    const cargoClippyStrategies = strategies.filter((s) => s.type === "cargo-clippy");
    expect(cargoClippyStrategies).toHaveLength(1);
  });

  it("handles empty CI checks gracefully (no CI strategies added)", () => {
    const report = makeReport({
      ciChecks: { workflows: [], allRunCommands: [] },
    });

    const { strategies } = generateEvalConfig(report);
    const ciStrategies = strategies.filter((s) => s.label?.includes("from CI"));
    expect(ciStrategies).toHaveLength(0);
  });
});

// ── Commands generation with different package managers ───────────

describe("generateEvalConfig() commands generation", () => {
  it("generates npm commands correctly", () => {
    const report = makeReport({
      packageManager: "npm",
      packageScripts: makePackageScripts("npm", [
        { scriptName: "build", command: "tsc", category: "build" },
        { scriptName: "test", command: "vitest", category: "test" },
        { scriptName: "lint", command: "eslint src/", category: "lint" },
        { scriptName: "typecheck", command: "tsc --noEmit", category: "typecheck" },
        { scriptName: "dev", command: "tsc --watch", category: "dev" },
      ]),
    });

    const { commands } = generateEvalConfig(report);
    expect(commands.build).toBe("npm run build");
    expect(commands.test).toBe("npm run test");
    expect(commands.lint).toBe("npm run lint");
    expect(commands.typecheck).toBe("npm run typecheck");
    expect(commands.dev).toBe("npm run dev");
    expect(commands.install).toBe("npm install");
  });

  it("generates yarn commands correctly", () => {
    const report = makeReport({
      packageManager: "yarn",
      packageScripts: makePackageScripts("yarn", [
        { scriptName: "build", command: "tsc", category: "build" },
        { scriptName: "test", command: "jest", category: "test" },
        { scriptName: "lint", command: "eslint src/", category: "lint" },
      ]),
    });

    const { commands } = generateEvalConfig(report);
    expect(commands.build).toBe("yarn build");
    expect(commands.test).toBe("yarn test");
    expect(commands.lint).toBe("yarn lint");
    expect(commands.install).toBe("yarn");
  });

  it("generates pnpm commands correctly", () => {
    const report = makeReport({
      packageManager: "pnpm",
      packageScripts: makePackageScripts("pnpm", [
        { scriptName: "build", command: "vite build", category: "build" },
        { scriptName: "lint", command: "eslint .", category: "lint" },
      ]),
    });

    const { commands } = generateEvalConfig(report);
    expect(commands.build).toBe("pnpm run build");
    expect(commands.lint).toBe("pnpm run lint");
    expect(commands.install).toBe("pnpm install");
  });

  it("generates bun commands correctly", () => {
    const report = makeReport({
      packageManager: "bun",
      packageScripts: makePackageScripts("bun", [
        { scriptName: "test", command: "bun test", category: "test" },
        { scriptName: "build", command: "bun build", category: "build" },
      ]),
    });

    const { commands } = generateEvalConfig(report);
    expect(commands.test).toBe("bun run test");
    expect(commands.build).toBe("bun run build");
    expect(commands.install).toBe("bun install");
  });

  it("leaves commands undefined when no corresponding script is detected", () => {
    const report = makeReport({
      packageManager: "npm",
      packageScripts: makePackageScripts("npm", [
        { scriptName: "build", command: "tsc", category: "build" },
      ]),
    });

    const { commands } = generateEvalConfig(report);
    // Only build was in scripts -- others should be undefined
    expect(commands.test).toBeUndefined();
    expect(commands.lint).toBeUndefined();
    expect(commands.typecheck).toBeUndefined();
    expect(commands.dev).toBeUndefined();
  });

  it("sets install to 'npm install' when packageManager is null", () => {
    const report = makeReport({ packageManager: null });
    const { commands } = generateEvalConfig(report);
    expect(commands.install).toBe("npm install");
  });
});

// ── Playwright strategy generation ───────────────────────────────

describe("generateEvalConfig() Playwright strategy", () => {
  it("adds playwright strategy with required: true when dep + CI reference present", () => {
    const report = makeReport({
      detectedStack: makeStack({ hasPlaywright: true }),
      ciChecks: {
        workflows: [
          {
            file: ".github/workflows/ci.yml",
            steps: [
              { name: "E2E", runCommand: "npx playwright test", category: "test" },
            ],
          },
        ],
        allRunCommands: ["npx playwright test"],
      },
    });

    const { strategies } = generateEvalConfig(report);
    const pw = strategies.find((s) => s.type === "playwright");
    expect(pw).toBeDefined();
    expect(pw?.required).toBe(true);
  });

  it("adds playwright strategy with required: false when only dep present (no CI ref)", () => {
    const report = makeReport({
      detectedStack: makeStack({ hasPlaywright: true }),
      ciChecks: { workflows: [], allRunCommands: [] },
    });

    const { strategies } = generateEvalConfig(report);
    const pw = strategies.find((s) => s.type === "playwright");
    expect(pw).toBeDefined();
    expect(pw?.required).toBe(false);
  });

  it("omits playwright strategy when neither dep nor CI ref present", () => {
    const report = makeReport({
      detectedStack: makeStack({ hasPlaywright: false }),
      ciChecks: { workflows: [], allRunCommands: [] },
    });

    const { strategies } = generateEvalConfig(report);
    const pw = strategies.find((s) => s.type === "playwright");
    expect(pw).toBeUndefined();
  });

  it("adds playwright strategy when dep + playwright in test script", () => {
    const report = makeReport({
      detectedStack: makeStack({ hasPlaywright: true }),
      packageScripts: makePackageScripts("npm", [
        { scriptName: "test", command: "playwright test", category: "test" },
      ]),
      packageManager: "npm",
      ciChecks: { workflows: [], allRunCommands: [] },
    });

    const { strategies } = generateEvalConfig(report);
    const pw = strategies.find((s) => s.type === "playwright");
    expect(pw).toBeDefined();
    expect(pw?.required).toBe(true);
  });
});

// ── API framework strategy ────────────────────────────────────────

describe("generateEvalConfig() API framework strategy", () => {
  it("adds api-check strategy for Express projects", () => {
    const report = makeReport({
      detectedStack: makeStack({ hasExpress: true }),
    });

    const { strategies } = generateEvalConfig(report);
    const api = strategies.find((s) => s.type === "api-check");
    expect(api).toBeDefined();
    expect(api?.required).toBe(false);
  });

  it("adds api-check strategy for Fastify projects", () => {
    const report = makeReport({
      detectedStack: makeStack({ hasFastify: true }),
    });

    const { strategies } = generateEvalConfig(report);
    const api = strategies.find((s) => s.type === "api-check");
    expect(api).toBeDefined();
    expect(api?.required).toBe(false);
  });

  it("adds api-check strategy for NestJS projects", () => {
    const report = makeReport({
      detectedStack: makeStack({ hasNestjs: true }),
    });

    const { strategies } = generateEvalConfig(report);
    const api = strategies.find((s) => s.type === "api-check");
    expect(api).toBeDefined();
    expect(api?.required).toBe(false);
  });

  it("omits api-check when no API framework detected", () => {
    const report = makeReport({
      detectedStack: makeStack(),
    });

    const { strategies } = generateEvalConfig(report);
    const api = strategies.find((s) => s.type === "api-check");
    expect(api).toBeUndefined();
  });

  it("omits api-check when detectedStack is null", () => {
    const report = makeReport({ detectedStack: null });
    const { strategies } = generateEvalConfig(report);
    const api = strategies.find((s) => s.type === "api-check");
    expect(api).toBeUndefined();
  });
});

// ── Edge cases & empty report ────────────────────────────────────

describe("generateEvalConfig() edge cases", () => {
  it("returns empty strategies array for a minimal empty report", () => {
    const { strategies } = generateEvalConfig(makeReport());
    expect(strategies).toEqual([]);
  });

  it("returns install command even for empty report (defaults to npm install)", () => {
    const { commands } = generateEvalConfig(makeReport());
    expect(commands.install).toBe("npm install");
  });

  it("strategy ordering is typecheck -> lint -> build -> unit-test -> playwright -> api-check -> CI", () => {
    const report = makeReport({
      packageManager: "npm",
      packageScripts: makePackageScripts("npm", [
        { scriptName: "build", command: "tsc", category: "build" },
        { scriptName: "test", command: "vitest", category: "test" },
        { scriptName: "lint", command: "eslint src/", category: "lint" },
        { scriptName: "typecheck", command: "tsc --noEmit", category: "typecheck" },
      ]),
      detectedStack: makeStack({ hasExpress: true }),
      ciChecks: {
        workflows: [
          {
            file: ".github/workflows/ci.yml",
            steps: [
              { name: "Audit", runCommand: "npm audit", category: "other" },
            ],
          },
        ],
        allRunCommands: ["npm audit"],
      },
    });

    const { strategies } = generateEvalConfig(report);
    const types = strategies.map((s) => s.type);

    const tcIdx = types.indexOf("typecheck");
    const lintIdx = types.indexOf("lint");
    const buildIdx = types.indexOf("build");
    const testIdx = types.indexOf("unit-test");
    const apiIdx = types.indexOf("api-check");

    expect(tcIdx).toBeLessThan(lintIdx);
    expect(lintIdx).toBeLessThan(buildIdx);
    expect(buildIdx).toBeLessThan(testIdx);
    expect(testIdx).toBeLessThan(apiIdx);
  });

  it("does not throw when ciChecks.workflows is empty", () => {
    const report = makeReport({
      ciChecks: { workflows: [], allRunCommands: [] },
    });
    expect(() => generateEvalConfig(report)).not.toThrow();
  });
});
