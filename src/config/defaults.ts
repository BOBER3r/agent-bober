import type { BoberConfig, EvalStrategy, ProjectType } from "./schema.js";

// ── Strategy Presets ────────────────────────────────────────────────

const typecheckStrategy: EvalStrategy = {
  type: "typecheck",
  required: true,
};

const lintStrategy: EvalStrategy = {
  type: "lint",
  required: true,
};

const buildStrategy: EvalStrategy = {
  type: "build",
  required: true,
};

const unitTestStrategy: EvalStrategy = {
  type: "unit-test",
  required: true,
};

const playwrightStrategy: EvalStrategy = {
  type: "playwright",
  required: false,
};

const lintOptionalStrategy: EvalStrategy = {
  type: "lint",
  required: false,
};

// ── Project-Type Defaults ───────────────────────────────────────────

export const reactFullstackDefaults: Partial<BoberConfig> = {
  planner: {
    maxClarifications: 5,
    model: "opus",
    contextFiles: ["package.json", "tsconfig.json", "next.config.js", "vite.config.ts"],
  },
  generator: {
    model: "sonnet",
    maxTurnsPerSprint: 50,
    autoCommit: true,
    branchPattern: "bober/{feature-name}",
  },
  evaluator: {
    model: "sonnet",
    strategies: [typecheckStrategy, lintStrategy, buildStrategy, playwrightStrategy],
    maxIterations: 3,
  },
  sprint: {
    maxSprints: 10,
    requireContracts: true,
    sprintSize: "medium",
  },
  pipeline: {
    maxIterations: 20,
    requireApproval: false,
    contextReset: "always",
  },
  commands: {
    install: "npm install",
    build: "npm run build",
    test: "npm test",
    lint: "npm run lint",
    typecheck: "npx tsc --noEmit",
    dev: "npm run dev",
  },
};

export const brownfieldDefaults: Partial<BoberConfig> = {
  planner: {
    maxClarifications: 5,
    model: "opus",
  },
  generator: {
    model: "sonnet",
    maxTurnsPerSprint: 50,
    autoCommit: true,
    branchPattern: "bober/{feature-name}",
  },
  evaluator: {
    model: "sonnet",
    strategies: [typecheckStrategy, lintStrategy, unitTestStrategy],
    maxIterations: 3,
  },
  sprint: {
    maxSprints: 10,
    requireContracts: true,
    sprintSize: "small",
  },
  pipeline: {
    maxIterations: 20,
    requireApproval: true,
    contextReset: "always",
  },
  commands: {},
};

export const genericDefaults: Partial<BoberConfig> = {
  planner: {
    maxClarifications: 5,
    model: "opus",
  },
  generator: {
    model: "sonnet",
    maxTurnsPerSprint: 50,
    autoCommit: true,
    branchPattern: "bober/{feature-name}",
  },
  evaluator: {
    model: "sonnet",
    strategies: [buildStrategy, lintOptionalStrategy],
    maxIterations: 3,
  },
  sprint: {
    maxSprints: 10,
    requireContracts: true,
    sprintSize: "medium",
  },
  pipeline: {
    maxIterations: 20,
    requireApproval: false,
    contextReset: "always",
  },
  commands: {},
};

/**
 * Return the default partial config for a given project type.
 */
export function getDefaults(type: ProjectType): Partial<BoberConfig> {
  switch (type) {
    case "react-fullstack":
      return reactFullstackDefaults;
    case "brownfield":
      return brownfieldDefaults;
    case "generic":
      return genericDefaults;
  }
}
