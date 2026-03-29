# agent-bober

[![npm version](https://img.shields.io/npm/v/agent-bober.svg)](https://www.npmjs.com/package/agent-bober)
[![license](https://img.shields.io/npm/l/agent-bober.svg)](https://github.com/BOBER3r/agent-bober/blob/main/LICENSE)

**Generator-Evaluator multi-agent harness for building applications autonomously with any LLM.**

[agentbober.com](https://agentbober.com) | [npm](https://www.npmjs.com/package/agent-bober) | [GitHub](https://github.com/BOBER3r/agent-bober)

Inspired by Anthropic's engineering publication [**"Harness design for long-running application development"**](https://www.anthropic.com/engineering/harness-design-long-running-apps), agent-bober implements the Generator-Evaluator multi-agent pattern as a reusable, installable workflow. It orchestrates AI agents in a structured loop: a **Planner** decomposes your idea into sprint contracts, a **Generator** writes the code, and an **Evaluator** independently verifies each sprint against its contract before moving on. The result is autonomous, high-quality software development with built-in guardrails, context resets, and brutally honest evaluation.

Works with **Claude, GPT, Gemini, Ollama**, and any OpenAI-compatible endpoint. Mix and match providers per agent role.

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

agent-bober works in multiple environments:

- **Claude Code** -- Plugin with 10 slash commands (`/bober-plan`, `/bober-run`, etc.)
- **Cursor / Windsurf** -- MCP server with 10 tools in the chat interface
- **Any MCP-compatible IDE** -- MCP server via stdio transport
- **Any terminal** -- CLI commands (`npx agent-bober run "feature"`)

## Quick Start

### Any Project
```bash
npx agent-bober init
```

Interactive setup -- pick your AI provider, choose a preset, describe what you want to build.

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

Brownfield init **auto-discovers your codebase**: scans package.json scripts, CI configs, git history, file naming patterns, import conventions, test setup, and documentation. It auto-generates project principles and configures evaluator strategies with the correct commands -- no manual setup needed.

Then in Claude Code:
```
/bober-principles   # Define project standards (optional but recommended)
/bober-plan         # Describe your feature, get a structured plan
/bober-sprint       # Execute the next sprint
/bober-eval         # Evaluate the sprint output
/bober-run          # Full autonomous pipeline
```

Specialized workflows:
```
/bober-react        # React web app workflow
/bober-solidity     # EVM smart contract workflow
/bober-anchor       # Solana program workflow
/bober-brownfield   # Existing codebase workflow
/bober-playwright   # Set up and generate E2E tests
```

---

## Multi-Provider Support

agent-bober is **provider-agnostic**. Use any LLM provider for any agent role. Mix and match -- Opus for planning, GPT-4.1 for generation, local Ollama for evaluation.

### Supported Providers

| Provider | Models | API Key |
|----------|--------|---------|
| **Anthropic** (default) | `opus`, `sonnet`, `haiku` | `ANTHROPIC_API_KEY` |
| **OpenAI** | `gpt-4.1`, `gpt-4.1-mini`, `o3`, `o4-mini` | `OPENAI_API_KEY` |
| **Google Gemini** | `gemini-pro`, `gemini-flash` | `GOOGLE_API_KEY` or `GEMINI_API_KEY` |
| **OpenAI-Compatible** | Any model (Ollama, LM Studio, Groq, DeepSeek, etc.) | Optional |

### Configuration

Set providers per agent role in `bober.config.json`:

```jsonc
{
  "planner": {
    "provider": "anthropic",
    "model": "opus"
  },
  "generator": {
    "provider": "openai",
    "model": "gpt-4.1"
  },
  "evaluator": {
    "provider": "openai-compat",
    "model": "llama3.1:70b",
    "endpoint": "http://localhost:11434/v1"
  }
}
```

Model shorthands auto-resolve to the correct provider:
- `"opus"` / `"sonnet"` / `"haiku"` -- Anthropic
- `"gpt-4.1"` / `"o3"` / `"o4-mini"` -- OpenAI
- `"gemini-pro"` / `"gemini-flash"` -- Google
- `"ollama/llama3"` -- OpenAI-compatible at localhost:11434

Override provider for all roles from the CLI:
```bash
npx agent-bober run "feature" --provider openai
```

Provider SDKs (`openai`, `@google/generative-ai`) are **optional peer dependencies** -- install only what you use. Only `@anthropic-ai/sdk` is required by default.

---

## MCP Server (Cursor, Windsurf, etc.)

agent-bober includes an MCP (Model Context Protocol) server that exposes all functionality as tools in any MCP-compatible IDE.

### Setup for Cursor

Add to `.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "bober": {
      "command": "npx",
      "args": ["agent-bober", "mcp"]
    }
  }
}
```

### Setup for Windsurf

Add to your Windsurf MCP configuration:
```json
{
  "mcpServers": {
    "bober": {
      "command": "npx",
      "args": ["agent-bober", "mcp"]
    }
  }
}
```

### Available MCP Tools

| Tool | Type | Description |
|------|------|-------------|
| `bober_init` | sync | Initialize project config and `.bober/` directory |
| `bober_plan` | sync | Plan a feature, create sprint contracts |
| `bober_sprint` | sync | Execute the next sprint (generator + evaluator loop) |
| `bober_eval` | sync | Evaluate a sprint independently |
| `bober_run` | async | Full autonomous pipeline (returns immediately, poll with status) |
| `bober_status` | poll | Check pipeline progress or read current status |
| `bober_contracts` | read | List all sprint contracts or read a specific one |
| `bober_spec` | read | Read the current PlanSpec |
| `bober_principles` | read/write | Read or set project principles |
| `bober_config` | read/write | Read or update `bober.config.json` |

---

## Brownfield Auto-Discovery

When you run `bober init brownfield` (or use the `bober_init` MCP tool with mode=brownfield), agent-bober deeply analyzes your existing codebase and automatically:

### What It Scans

| Area | What It Reads | What It Detects |
|------|---------------|-----------------|
| **Package scripts** | `package.json` scripts, lockfiles | Build/test/lint/typecheck commands, package manager (npm/yarn/pnpm/bun) |
| **CI/CD** | `.github/workflows/*.yml`, `.gitlab-ci.yml` | CI check commands, deployment steps |
| **Git history** | Last 50 commits, branch names | Commit message format (conventional commits, prefixes), branch naming strategy |
| **Code conventions** | Samples up to 20 source files | File naming (camelCase/kebab-case/PascalCase), import style, export patterns, TypeScript strictness |
| **Test setup** | Test files, framework configs | Test framework, file naming pattern (*.test.ts vs *.spec.ts), mocking library, coverage config |
| **Documentation** | README.md, CONTRIBUTING.md, CLAUDE.md, .cursorrules, docs/ | Existing standards and guidelines |

### What It Produces

1. **`.bober/principles.md`** -- Comprehensive project principles synthesized by a single LLM call from the scan data. Each rule includes file path examples from your actual codebase and notes any inconsistencies (e.g., "Most files use camelCase but `src/utils/parse-config.ts` uses kebab-case").

2. **`bober.config.json`** -- Evaluator strategies with real, PM-qualified command strings (e.g., `{ type: "lint", command: "pnpm run lint", required: true }`), plus CI-derived custom strategies labeled `(from CI)`.

### How It Works

```bash
$ npx agent-bober init brownfield

Analyzing codebase...

Detected: TypeScript, React, Vite, ESLint, Vitest, Playwright
Package manager: pnpm
Git: conventional commits (feat:/fix:), feature/* branches
Tests: vitest, *.test.ts, co-located

Auto-configured strategies:
  typecheck  pnpm run typecheck  (required)
  lint       pnpm run lint       (required)
  build      pnpm run build      (required)
  unit-test  pnpm run test       (required)
  playwright npx playwright test (optional)

Look good? [Y/n]
```

The `/bober-principles` command also triggers auto-discovery when called with no arguments in a brownfield project -- it analyzes the codebase instead of asking interview questions.

---

## Commands

### Slash Commands (Claude Code)

| Command | Description |
|---|---|
| `/bober-principles` | Define project principles -- AI expands your rough notes into standards |
| `/bober-plan` | Plan any feature -- stack-agnostic, sprint-decomposed |
| `/bober-sprint` | Execute the next sprint contract |
| `/bober-eval` | Evaluate current sprint output |
| `/bober-run` | Full autonomous pipeline (plan + sprint + eval loop) |
| `/bober-react` | React web application workflow |
| `/bober-solidity` | EVM smart contract workflow |
| `/bober-anchor` | Solana program workflow |
| `/bober-brownfield` | Existing codebase workflow |
| `/bober-playwright` | Set up Playwright E2E testing, generate tests, debug failures |

### CLI

```bash
npx agent-bober init [preset]       # Initialize project (with provider selection)
npx agent-bober plan "feature"      # Run the planner
npx agent-bober sprint              # Execute next sprint
npx agent-bober eval                # Evaluate current sprint
npx agent-bober run "feature"       # Full autonomous loop
npx agent-bober mcp                 # Start MCP server (Cursor/Windsurf)
```

### Fully Autonomous Mode (no human in the loop)

**Option A: Claude Code (recommended)**

Launch Claude Code with auto-accept permissions, then run the pipeline:

```bash
cd your-project
agent-bober init nextjs
claude --dangerously-skip-permissions
# Inside Claude Code:
/bober-run Build a complete dashboard with auth, CRUD, and charts
```

Claude will plan, build, evaluate, rework, and iterate without asking you anything. Come back to a finished project.

**Option B: CLI with API key**

```bash
export ANTHROPIC_API_KEY=sk-ant-...
cd your-project
agent-bober init nextjs
agent-bober run "Build a complete dashboard with auth, CRUD, and charts"
```

The CLI uses the Anthropic SDK directly -- no approval prompts at all.

**Option C: With a different provider**

```bash
export OPENAI_API_KEY=sk-...
cd your-project
agent-bober init nextjs
agent-bober run "Build a complete dashboard with auth, CRUD, and charts" --provider openai
```

---

## Configuration

All configuration lives in `bober.config.json` at your project root. The `init` command creates this file from a template, and you can customize it afterward.

### Full Configuration Reference

```jsonc
{
  // -- Project -----------------------------------------
  "project": {
    "name": "my-app",                     // Project name
    "mode": "greenfield",                 // "greenfield" | "brownfield"
    "preset": "nextjs",                   // Optional: "nextjs" | "react-vite" | "solidity" | "anchor" | "api-node" | "python-api"
    "description": "A task management app with real-time collaboration"
  },

  // -- Planner -----------------------------------------
  "planner": {
    "provider": "anthropic",              // "anthropic" | "openai" | "google" | "openai-compat"
    "model": "opus",                      // Any model string or shorthand
    "endpoint": null,                     // Custom base URL (for openai-compat)
    "providerConfig": {},                 // Provider-specific settings
    "maxClarifications": 5,               // Max clarifying questions (0 to skip)
    "contextFiles": [                     // Extra files the planner should read
      "docs/architecture.md"
    ]
  },

  // -- Generator ---------------------------------------
  "generator": {
    "provider": "anthropic",              // "anthropic" | "openai" | "google" | "openai-compat"
    "model": "sonnet",                    // Any model string or shorthand
    "endpoint": null,                     // Custom base URL (for openai-compat)
    "providerConfig": {},                 // Provider-specific settings
    "maxTurnsPerSprint": 50,              // Max tool-use turns per sprint
    "autoCommit": true,                   // Auto-commit after each sprint
    "branchPattern": "bober/{feature-name}" // Git branch naming
  },

  // -- Evaluator ---------------------------------------
  "evaluator": {
    "provider": "anthropic",              // "anthropic" | "openai" | "google" | "openai-compat"
    "model": "sonnet",                    // Any model string or shorthand
    "endpoint": null,                     // Custom base URL (for openai-compat)
    "providerConfig": {},                 // Provider-specific settings
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

  // -- Sprint ------------------------------------------
  "sprint": {
    "maxSprints": 10,                     // Max sprints per plan
    "requireContracts": true,             // Require contract agreement before coding
    "sprintSize": "medium"                // "small" | "medium" | "large"
  },

  // -- Pipeline ----------------------------------------
  "pipeline": {
    "maxIterations": 20,                  // Max total iterations across all sprints
    "requireApproval": false,             // Pause for user approval between sprints
    "contextReset": "always"              // "always" | "on-threshold" | "never"
  },

  // -- Commands ----------------------------------------
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

The strategy type is **open** -- you can use any name and provide a shell command directly. No plugin file needed:

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

Existing codebase with **intelligent auto-discovery**:

- Deep codebase scan: package scripts, CI configs, git history, code conventions, test setup
- Auto-generated project principles from discovered patterns
- Evaluator strategies auto-configured with real commands from your scripts and CI
- Conservative sprint sizes (`small`)
- Higher evaluator iteration limit (5 rework cycles)
- Emphasizes reading existing patterns before making changes

### `base`

Minimal config, planner decides everything. Just a `bober.config.json` with `build` as the only required evaluator strategy. Intended as a starting point for any tech stack not covered by other presets.

---

## E2E Testing with Playwright

If your evaluation strategies include `playwright`, the generator will automatically:
- Add `data-testid` attributes to all interactive UI elements
- Write Playwright test files in `e2e/` alongside UI code
- Verify tests pass before completing each sprint

To set up Playwright in your project:
```
/bober-playwright setup
```

This installs `@playwright/test`, creates `playwright.config.ts` with a `webServer` block that auto-starts your dev server, scaffolds an `e2e/` directory with an example smoke test, and configures JSON reporting for structured feedback.

To generate tests for a specific feature:
```
/bober-playwright "test the login flow"
```

The evaluator runs Playwright tests automatically during evaluation and feeds failures back to the generator for rework. Failed tests include the test name, file location, error message, and screenshot paths when available.

To debug failing E2E tests:
```
/bober-playwright debug
```

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

This architecture implements the patterns described in Anthropic's [**"Harness design for long-running application development"**](https://www.anthropic.com/engineering/harness-design-long-running-apps) by Prithvi Rajasekaran. The key insight from that research: separating code generation from code evaluation creates a feedback loop that catches errors early and dramatically improves output quality. In their tests, a solo agent produced broken output in 20 minutes, while the full harness produced a polished, working application -- demonstrating that multi-agent orchestration with honest evaluation is worth the investment.

### Provider-Agnostic Architecture

Each agent runs as a **multi-turn agentic loop** with tool access via the unified `LLMClient` interface. The provider layer abstracts away the differences between Anthropic, OpenAI, Google, and OpenAI-compatible APIs. System prompts are loaded from the detailed agent definitions in `agents/bober-*.md` (300-600 lines of role-specific instructions, anti-leniency protocols, and evaluation criteria).

- **Planner** (default: Claude Opus): Explores the codebase via read-only tools (`read_file`, `glob`, `grep`), then produces sprint-decomposed plans. Thinks about scope, dependencies, and risk.
- **Generator** (default: Claude Sonnet): Full tool access (`bash`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`). Reads existing code, writes implementation, runs tests, and commits -- all autonomously within the sprint contract boundaries.
- **Evaluator** (default: Claude Sonnet): Read-only + bash tools (`bash`, `read_file`, `glob`, `grep` -- deliberately NO write/edit). Independently verifies by running the dev server, taking Playwright screenshots, executing tests, and inspecting code. Cannot fix bugs -- only report them with precise feedback.

The separation ensures that:
1. The Generator cannot "mark its own homework" -- an independent evaluation step with its own tool access catches issues through actual runtime verification, not just reading the generator's self-report.
2. Sprint contracts provide clear scope boundaries, preventing feature creep.
3. Automated checks (programmatic evaluators) + agent-based qualitative evaluation run after every sprint.
4. Context resets between sprints keep the Generator focused and prevent context degradation.
5. The Evaluator's anti-leniency protocol ensures passing on the first iteration is rare for non-trivial work.

### State Management

All bober state lives in the `.bober/` directory:

```
.bober/
  specs/           PlanSpec JSON files
  contracts/       SprintContract JSON files
  eval-results/    Evaluation result logs
  handoffs/        Context handoff documents
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
    discovery/        Brownfield auto-discovery (scanner, synthesizer, config generator)
      scanners/       Sub-scanners (package-scripts, ci-checks, git, code, tests, docs)
    evaluators/       Built-in evaluator plugins
    mcp/              MCP server and tool definitions
      tools/          10 MCP tools (init, plan, sprint, eval, run, status, etc.)
    orchestrator/     Agent runners, agentic loop, tool infrastructure
      tools/          Tool schemas, sandboxed handlers, role-based sets
    providers/        LLM provider adapters (Anthropic, OpenAI, Google, OpenAI-compat)
    state/            State management for .bober/ directory
    utils/            Shared utilities
  agents/             Agent system prompts (.md files, loaded at runtime)
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

## Links

- [agentbober.com](https://agentbober.com) -- Official website
- [npm](https://www.npmjs.com/package/agent-bober) -- Package registry
- [GitHub](https://github.com/BOBER3r/agent-bober) -- Source code
- [Anthropic Research](https://www.anthropic.com/engineering/harness-design-long-running-apps) -- The paper that inspired this project

## License

[MIT](LICENSE) -- Copyright (c) 2026 BOBER3r
