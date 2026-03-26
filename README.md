# agent-bober

**Generator-Evaluator multi-agent harness for building applications autonomously with Claude.**

Inspired by Anthropic's engineering publication [**"Harness design for long-running application development"**](https://www.anthropic.com/engineering/harness-design-long-running-apps), agent-bober implements the Generator-Evaluator multi-agent pattern as a reusable, installable workflow. It orchestrates multiple Claude agents in a structured loop: a **Planner** decomposes your idea into sprint contracts, a **Generator** writes the code, and an **Evaluator** independently verifies each sprint against its contract before moving on. The result is autonomous, high-quality software development with built-in guardrails, context resets, and brutally honest evaluation.

```
You describe a feature
        |
        v
  +-----------+
  |  Planner  |   Asks clarifying questions, produces a PlanSpec
  +-----------+   with sprint contracts and acceptance criteria.
        |
        v
  +-----------+     +-----------+
  | Generator | --> | Evaluator |   Writes code, then verifies it:
  +-----------+     +-----------+   typecheck, lint, build, tests.
        ^               |
        |   (rework)    |
        +---------------+
              |
              v         Repeats per sprint until all
        [Next Sprint]   contracts are satisfied.
```

---

## Installation

```bash
# Install globally
npm install -g agent-bober

# Or use directly with npx
npx agent-bober init
```

agent-bober also works as a **Claude Code plugin**. If you install it as a dependency or globally, Claude Code will detect the plugin manifest and make `/bober:*` slash commands available in your sessions.

## Quick Start

### Any Project
```bash
npx agent-bober init
```

Interactive setup -- describe what you want to build, pick a preset or let the planner decide.

### With a Preset
```bash
npx agent-bober init nextjs         # Next.js full-stack app
npx agent-bober init react-vite     # React + Vite
npx agent-bober init solidity       # EVM smart contracts (Hardhat)
npx agent-bober init anchor         # Solana programs (Anchor)
npx agent-bober init api-node       # Node.js API
npx agent-bober init python-api     # Python API (FastAPI)
```

### Existing Codebase
```bash
cd your-existing-project
npx agent-bober init brownfield
```

Then in Claude Code:
```
/bober:plan         # Describe your feature, get a structured plan
/bober:sprint       # Execute the next sprint
/bober:eval         # Evaluate the sprint output
/bober:run          # Full autonomous pipeline
```

Specialized workflows:
```
/bober:react        # React web app workflow
/bober:solidity     # EVM smart contract workflow
/bober:anchor       # Solana program workflow
/bober:brownfield   # Existing codebase workflow
```

---

## Commands

### Slash Commands (Claude Code)

| Command | Description |
|---|---|
| `/bober:plan` | Plan any feature -- stack-agnostic |
| `/bober:sprint` | Execute the next sprint contract |
| `/bober:eval` | Evaluate current sprint output |
| `/bober:run` | Full autonomous pipeline |
| `/bober:react` | React web application workflow |
| `/bober:solidity` | EVM smart contract workflow |
| `/bober:anchor` | Solana program workflow |
| `/bober:brownfield` | Existing codebase workflow |

### CLI

```bash
npx agent-bober init [preset]       # Initialize project (nextjs, react-vite, solidity, anchor, api-node, python-api, brownfield)
npx agent-bober plan                # Run the planner
npx agent-bober sprint              # Execute next sprint
npx agent-bober eval                # Evaluate current sprint
npx agent-bober run                 # Full autonomous loop
npx agent-bober status              # Show plan progress
```

---

## Configuration

All configuration lives in `bober.config.json` at your project root. The `init` command creates this file from a template, and you can customize it afterward.

### Full Configuration Reference

```jsonc
{
  // ── Project ─────────────────────────────────────
  "project": {
    "name": "my-app",                     // Project name
    "mode": "greenfield",                 // "greenfield" | "brownfield"
    "preset": "nextjs",                   // Optional: "nextjs" | "react-vite" | "solidity" | "anchor" | "api-node" | "python-api"
    "description": "A task management app with real-time collaboration"
  },

  // ── Planner ─────────────────────────────────────
  "planner": {
    "maxClarifications": 5,               // Max clarifying questions (0 to skip)
    "model": "opus",                      // Model for planning: "opus" | "sonnet" | "haiku"
    "contextFiles": [                     // Extra files the planner should read
      "docs/architecture.md"
    ]
  },

  // ── Generator ───────────────────────────────────
  "generator": {
    "model": "sonnet",                    // Model for code generation
    "maxTurnsPerSprint": 50,              // Max tool-use turns per sprint
    "autoCommit": true,                   // Auto-commit after each sprint
    "branchPattern": "bober/{feature-name}" // Git branch naming
  },

  // ── Evaluator ───────────────────────────────────
  "evaluator": {
    "model": "sonnet",                    // Model for evaluation reasoning
    "strategies": [                       // Evaluation strategies to run
      { "type": "typecheck", "required": true },
      { "type": "lint",      "required": true },
      { "type": "build",     "required": true },
      { "type": "unit-test", "required": true },
      { "type": "playwright","required": false }
    ],
    "maxIterations": 3,                   // Max rework cycles per sprint
    "plugins": []                         // Custom evaluator plugin paths
  },

  // ── Sprint ──────────────────────────────────────
  "sprint": {
    "maxSprints": 10,                     // Max sprints per plan
    "requireContracts": true,             // Require contract agreement before coding
    "sprintSize": "medium"                // "small" | "medium" | "large"
  },

  // ── Pipeline ────────────────────────────────────
  "pipeline": {
    "maxIterations": 20,                  // Max total iterations across all sprints
    "requireApproval": false,             // Pause for user approval between sprints
    "contextReset": "always"              // "always" | "on-threshold" | "never"
  },

  // ── Commands ────────────────────────────────────
  "commands": {
    "install":   "npm install",
    "build":     "npm run build",
    "test":      "npm test",
    "lint":      "npm run lint",
    "dev":       "npm run dev",
    "typecheck": "npx tsc --noEmit"
  }
}
```

### Sprint Sizes

| Size | Generator Effort | Files Changed | Scope |
|---|---|---|---|
| `small` | 30-60 min | 1-2 files | Single concern |
| `medium` | 1-3 hours | 3-8 files | One cohesive feature slice |
| `large` | 3-5 hours | 5-15 files | Full feature vertical |

### Context Reset Modes

| Mode | Behavior |
|---|---|
| `always` | Fresh context for every sprint (recommended for long plans) |
| `on-threshold` | Reset when context usage exceeds 80% |
| `never` | Carry context across sprints (only for short plans) |

---

## Evaluator Strategies

### Built-in Strategies

| Strategy | What It Does |
|---|---|
| `typecheck` | Runs the configured typecheck command (e.g., `tsc --noEmit`) |
| `lint` | Runs the configured lint command (e.g., `eslint .`) |
| `build` | Runs the configured build command and checks for success |
| `unit-test` | Runs the configured test command |
| `playwright` | Runs Playwright E2E tests |
| `api-check` | Validates API endpoints respond correctly |

### Inline Command Evaluators

The strategy type is **open** — you can use any name and provide a shell command directly. No plugin file needed:

```json
{
  "evaluator": {
    "strategies": [
      { "type": "typecheck", "required": true },
      { "type": "lint", "required": true },
      { "type": "k6", "command": "k6 run load-test.js", "required": false, "label": "Load Test" },
      { "type": "slither", "command": "slither .", "required": true, "label": "Security Audit" },
      { "type": "anchor-verify", "command": "anchor verify", "required": true },
      { "type": "cargo-test", "command": "cargo test", "required": true },
      { "type": "pytest", "command": "pytest --tb=short", "required": true },
      { "type": "mypy", "command": "mypy . --strict", "required": false }
    ]
  }
}
```

Any strategy with a `command` field runs that command and checks the exit code (0 = pass). Error output is parsed and included in the evaluator feedback. You can set a custom `timeout` in the config:

```json
{ "type": "k6", "command": "k6 run load.js", "required": false, "config": { "timeout": 300000 } }
```

### Custom Evaluator Plugins

For more complex evaluation logic, write a plugin that implements the `EvaluatorPlugin` interface:

```typescript
import type { EvaluatorPlugin, EvalContext, EvalResult } from "agent-bober";

const myPlugin: EvaluatorPlugin = {
  name: "My Custom Check",
  description: "Validates something specific to my project",

  async canRun(_projectRoot, _config) {
    return true;
  },

  async evaluate(context: EvalContext): Promise<EvalResult> {
    return {
      evaluator: "my-custom-check",
      passed: true,
      score: 100,
      details: [],
      summary: "All checks passed",
      feedback: "Everything looks good.",
      timestamp: new Date().toISOString(),
    };
  },
};

export default () => myPlugin;
```

Register plugins in `bober.config.json`:

```json
{
  "evaluator": {
    "strategies": [
      { "type": "custom", "plugin": "./my-evaluator.ts", "required": true }
    ]
  }
}
```

---

## Presets

### `nextjs`

Next.js full-stack (App Router, API routes, Prisma). Includes:

- Next.js with TypeScript, Tailwind CSS, ESLint
- API routes for backend logic
- Prisma ORM for database access
- Vitest for unit tests, Playwright for E2E

### `react-vite`

React + Vite + any backend. Includes:

- Vite dev server with React and TypeScript
- Vitest for unit tests, Playwright for E2E
- ESLint configured for TypeScript + React
- Flexible backend pairing (Express, Fastify, etc.)

### `solidity`

EVM smart contracts (Hardhat/Foundry). Includes:

- Hardhat or Foundry project setup
- OpenZeppelin Contracts integration
- Solhint for linting
- Hardhat tests or Forge tests
- Deployment and verification scripts

### `anchor`

Solana programs (Anchor/Rust). Includes:

- Anchor project setup with program scaffold
- TypeScript integration tests
- Cargo clippy for Rust linting
- IDL generation and client SDK
- Deployment scripts for devnet/mainnet

### `api-node`

Node.js API (Express/NestJS/Fastify). Includes:

- TypeScript API project structure
- Testing with Vitest or Jest
- ESLint and TypeScript strict mode
- Database integration (Prisma/Drizzle)

### `python-api`

Python API (FastAPI/Django). Includes:

- FastAPI or Django project structure
- pytest for testing
- Ruff/Black for linting and formatting
- SQLAlchemy or Django ORM for database access

### `brownfield`

Existing codebase (conservative defaults). No scaffold files -- just configuration:

- Conservative sprint sizes (`small`)
- Higher evaluator iteration limit (5 rework cycles)
- Requires user approval between sprints
- Emphasizes reading existing patterns before making changes

### `base`

Minimal config, planner decides everything. Just a `bober.config.json` with `build` as the only required evaluator strategy. Intended as a starting point for any tech stack not covered by other presets.

---

## Architecture

### How the Agents Interact

```
                        bober.config.json
                              |
                    +---------+---------+
                    |                   |
              .bober/specs/      .bober/contracts/
                    |                   |
                    v                   v
  User Idea --> [Planner] --> PlanSpec + SprintContracts
                                        |
                                        v
                                  [Generator]
                                    |     ^
                                    v     | (rework feedback)
                                [Evaluator]
                                    |
                          pass? ----+---- fail?
                            |              |
                      [Next Sprint]   [Rework Loop]
                            |
                            v
                    All sprints done
                            |
                            v
                      Feature Complete
```

### The Generator-Evaluator Pattern

This architecture implements the patterns described in Anthropic's [**"Harness design for long-running application development"**](https://www.anthropic.com/engineering/harness-design-long-running-apps) by Prithvi Rajasekaran. The key insight from that research: separating code generation from code evaluation creates a feedback loop that catches errors early and dramatically improves output quality. In their tests, a solo agent produced broken output in 20 minutes, while the full harness produced a polished, working application — demonstrating that multi-agent orchestration with honest evaluation is worth the investment.

- **Planner** (Claude Opus): High-reasoning model for decomposing complex features into clear, testable sprint contracts. Thinks about scope, dependencies, and risk.
- **Generator** (Claude Sonnet): Fast, capable model for writing code. Works within the boundaries of a single sprint contract.
- **Evaluator** (Claude Sonnet): Runs automated checks (typecheck, lint, build, tests) and provides structured feedback. If a sprint fails evaluation, the Generator gets specific rework instructions.

The separation ensures that:
1. The Generator cannot "mark its own homework" -- an independent evaluation step catches issues.
2. Sprint contracts provide clear scope boundaries, preventing feature creep.
3. Automated checks run after every sprint, not just at the end.
4. Context resets between sprints keep the Generator focused and prevent context degradation.

### State Management

All bober state lives in the `.bober/` directory:

```
.bober/
  specs/           PlanSpec JSON files
  contracts/       SprintContract JSON files
  evaluations/     Evaluation result logs
  snapshots/       Context snapshots (gitignored)
  progress.md      Human-readable progress tracker
  history.jsonl    Machine-readable event log
```

---

## Shell Scripts

For environments where you need to run bober operations outside of Claude Code:

| Script | Purpose |
|---|---|
| `scripts/init-project.sh` | Initialize a project with a template |
| `scripts/detect-stack.sh` | Auto-detect tech stack (outputs JSON) |
| `scripts/run-eval.sh` | Run evaluation strategies from config |

```bash
# Initialize a new project
bash scripts/init-project.sh nextjs

# Detect an existing project's stack
bash scripts/detect-stack.sh /path/to/project

# Run evaluations
bash scripts/run-eval.sh /path/to/project
```

---

## Contributing

Contributions are welcome. To set up the development environment:

```bash
git clone https://github.com/BOBER3r/agent-bober.git
cd agent-bober
npm install
npm run build
npm run typecheck
npm test
```

### Project Structure

```
agent-bober/
  src/
    cli/              CLI entry point (commander)
    config/           Config schema, loader, defaults
    contracts/        Sprint contract and eval result types
    evaluators/       Built-in evaluator plugins
    orchestrator/     Context handoff and agent coordination
    state/            State management for .bober/ directory
    utils/            Shared utilities
  agents/             Agent system prompts (.md files)
  skills/             Claude Code slash command definitions
  templates/          Project templates and scaffolds
  hooks/              Claude Code hooks
  scripts/            Shell scripts for init, detect, eval
```

### Guidelines

- TypeScript strict mode, no `any`.
- ESM only (`"type": "module"`).
- All evaluator plugins implement the `EvaluatorPlugin` interface.
- Sprint contracts are validated against Zod schemas.
- Test with `vitest`. Run `npm test` before submitting.

---

## Acknowledgments

This project is inspired by and implements the patterns from Anthropic's [**"Harness design for long-running application development"**](https://www.anthropic.com/engineering/harness-design-long-running-apps) by Prithvi Rajasekaran. The paper demonstrated that separating generation from evaluation, using sprint contracts, and applying context resets between agents dramatically improves the quality of autonomously built software. agent-bober packages these patterns into a reusable tool.

---

## License

[MIT](LICENSE) -- Copyright (c) 2026 bober4ik
