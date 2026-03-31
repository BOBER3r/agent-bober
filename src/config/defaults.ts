import type { BoberConfig, EvalStrategy, ProjectMode } from "./schema.js";

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

const apiCheckStrategy: EvalStrategy = {
  type: "api-check",
  required: true,
};

// ── Known Presets ───────────────────────────────────────────────────

export const KNOWN_PRESETS: string[] = [
  "nextjs",
  "react-vite",
  "solidity",
  "anchor",
  "api-node",
  "python-api",
];

/**
 * Return the list of known preset names.
 */
export function getPresetNames(): string[] {
  return [...KNOWN_PRESETS];
}

// ── Preset Defaults ────────────────────────────────────────────────

const presetDefaults: Record<string, Partial<BoberConfig>> = {
  "nextjs": {
    evaluator: {
      model: "sonnet",
      strategies: [typecheckStrategy, lintStrategy, buildStrategy, unitTestStrategy],
      maxIterations: 3,
    },
    commands: {
      build: "npm run build",
      test: "npm test",
      lint: "npm run lint",
      dev: "npm run dev",
      typecheck: "npx tsc --noEmit",
    },
  },
  "react-vite": {
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
      researchPhase: true,
      architectPhase: false,
    },
    commands: {
      install: "npm install",
      build: "npm run build",
      test: "npm test",
      lint: "npm run lint",
      typecheck: "npx tsc --noEmit",
      dev: "npm run dev",
    },
  },
  "solidity": {
    evaluator: {
      model: "sonnet",
      strategies: [buildStrategy, lintStrategy, unitTestStrategy],
      maxIterations: 3,
    },
    commands: {
      build: "npx hardhat compile",
      test: "npx hardhat test",
      lint: "npx solhint 'contracts/**/*.sol'",
    },
  },
  "anchor": {
    evaluator: {
      model: "sonnet",
      strategies: [buildStrategy, unitTestStrategy, lintStrategy],
      maxIterations: 3,
    },
    commands: {
      build: "anchor build",
      test: "anchor test",
      lint: "cargo clippy",
    },
  },
  "api-node": {
    evaluator: {
      model: "sonnet",
      strategies: [typecheckStrategy, lintStrategy, unitTestStrategy, apiCheckStrategy],
      maxIterations: 3,
    },
    commands: {
      build: "npm run build",
      test: "npm test",
      lint: "npm run lint",
      typecheck: "npx tsc --noEmit",
    },
  },
  "python-api": {
    evaluator: {
      model: "sonnet",
      strategies: [lintStrategy, unitTestStrategy, apiCheckStrategy],
      maxIterations: 3,
    },
    commands: {
      test: "pytest",
      lint: "ruff check .",
      typecheck: "mypy .",
    },
  },
};

// ── Greenfield / Brownfield Base Defaults ──────────────────────────

const greenfieldBase: Partial<BoberConfig> = {
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
    researchPhase: true,
    architectPhase: false,
  },
  commands: {},
};

const brownfieldBase: Partial<BoberConfig> = {
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
    researchPhase: true,
    architectPhase: false,
  },
  commands: {},
};

// ── Main API ───────────────────────────────────────────────────────

/**
 * Return the default partial config for a given project mode and optional preset.
 *
 * - brownfield: conservative defaults (small sprint size, require approval)
 * - greenfield + known preset: preset defaults merged with greenfield base
 * - greenfield (no preset): minimal greenfield base (build + lint)
 */
export function getDefaults(mode: ProjectMode, preset?: string): Partial<BoberConfig> {
  if (mode === "brownfield") {
    return brownfieldBase;
  }

  // Greenfield with a known preset
  if (preset && preset in presetDefaults) {
    return {
      ...greenfieldBase,
      ...presetDefaults[preset],
    };
  }

  // Greenfield without a preset (or unknown preset)
  return greenfieldBase;
}
