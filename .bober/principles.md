# Project Principles

> These principles guide all planning, generation, and evaluation in the Bober pipeline.
> Updated: 2026-04-16

## Mission

Agent-bober is a multi-agent harness that builds applications autonomously using any LLM. It orchestrates a pipeline of specialized agents (Researcher, Planner, Curator, Generator, Evaluator) and supports Claude, GPT, Gemini, and Ollama. It ships as an npm CLI + MCP server for Claude Code, Cursor, and Windsurf.

## Users

- **Primary:** Developers using Claude Code, Cursor, or Windsurf who want autonomous feature generation with quality gates
- **Secondary:** Teams integrating agent-bober programmatically via the TypeScript API or MCP server
- Technical level: intermediate to advanced — users understand LLMs, CI/CD, and modern JS tooling

## Quality Standards

- **Type safety:** TypeScript strict mode with all strict flags (`noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `isolatedModules`). Zero type errors is a hard gate.
- **Lint compliance:** ESLint flat config with `consistent-type-imports` enforced, `no-explicit-any` warned, unused vars errored (with `_` prefix escape). Zero lint errors is a hard gate.
- **Test coverage:** Vitest for unit tests. Tests are collocated with source (`*.test.ts` next to `*.ts`). Tests run against the real project when practical (e.g., scanner tests scan agent-bober itself).
- **Build integrity:** `tsc` must produce clean output. Build is a required evaluator strategy.

## Technical Principles

### Follow

- **ESM everywhere.** `"type": "module"` in package.json. All imports use `.js` extensions for NodeNext resolution. No CommonJS.
- **Provider-agnostic interfaces.** All LLM interaction goes through `providers/types.ts` — provider-specific SDKs are wrapped by adapters (`anthropic.ts`, `openai.ts`, `google.ts`). Never leak SDK types outside adapter files.
- **Zod for config validation.** All configuration schemas are Zod schemas in `config/schema.ts`. Runtime config loading uses `z.parse()`. No hand-rolled validation.
- **Contract-based architecture.** PlanSpecs, SprintContracts, and EvalResults are the communication protocol between agents. They live in `contracts/` and are JSON files on disk in `.bober/`.
- **Filesystem state.** All mutable state (specs, contracts, handoffs, eval results, history) is stored as JSON files in `.bober/`. No database, no in-memory global state.
- **Section comments.** Use unicode box-drawing section headers: `// -- Section Name ------` to organize long files.
- **Small utility modules.** Utils in `utils/` are focused single-purpose files (`fs.ts`, `git.ts`, `logger.ts`). Keep them small.
- **Conventional commits.** Format: `type: description` where type is `feat`, `fix`, `docs`, `release`, `refactor`, `test`, `chore`. Sprint-generated commits use `bober(sprint-N): description`.
- **Use `type` imports.** ESLint enforces `consistent-type-imports` -- import types with `import type { ... }` syntax.
- **Prefix unused params with `_`.** The `_` prefix is the only escape hatch for unused variables/parameters.

### Avoid

- **No `any` without justification.** `no-explicit-any` is a warning; aim for zero. Use `unknown` + type narrowing instead.
- **No SDK lock-in.** Never import `@anthropic-ai/sdk` or `openai` outside of their respective adapter files in `providers/`.
- **No synchronous filesystem ops.** All fs operations use `node:fs/promises`. No `fs.readFileSync` etc.
- **No barrel re-exports for deep internals.** `src/index.ts` exports the public API only. Internal modules import directly.
- **No test mocks for filesystem.** Tests that need filesystem state create temp directories and clean up. The scanner tests run against the real codebase.

## Design Principles

N/A -- no user interface. Agent-bober is a CLI tool and programmatic library. The MCP server exposes tools, not UI.
