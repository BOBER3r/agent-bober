# agent-bober

[![npm version](https://img.shields.io/npm/v/agent-bober.svg)](https://www.npmjs.com/package/agent-bober)
[![license](https://img.shields.io/npm/l/agent-bober.svg)](https://github.com/BOBER3r/agent-bober/blob/main/LICENSE)

**Multi-agent harness for building applications autonomously with any LLM.**

[agentbober.com](https://agentbober.com) | [npm](https://www.npmjs.com/package/agent-bober) | [GitHub](https://github.com/BOBER3r/agent-bober)

Inspired by Anthropic's engineering publication [**"Harness design for long-running application development"**](https://www.anthropic.com/engineering/harness-design-long-running-apps), agent-bober implements a multi-agent pipeline as a reusable, installable workflow. It orchestrates AI agents in a structured loop: a **Researcher** analyzes your codebase, a **Planner** decomposes your idea into sprint contracts, a **Curator** pre-analyzes code patterns and utilities for each sprint, a **Generator** writes the code with curated context, and an **Evaluator** independently verifies each sprint against its contract before moving on. The result is autonomous, high-quality software development with built-in guardrails, context resets, and brutally honest evaluation.

Works with **Claude, GPT, Gemini, Ollama**, and any OpenAI-compatible endpoint. Mix and match providers per agent role.

```
You describe a feature
        |
        v
  +------------+
  | Researcher |   Two-phase codebase analysis: generates questions,
  +------------+   then explores with NO feature knowledge. Facts only.
        |
        v
  +------------+   (optional — set pipeline.architectPhase: true)
  |  Architect |   5-checkpoint solution design: components, data flow,
  +------------+   ADRs, and architecture doc. Output goes to planner only.
        |
        v
  +-----------+
  |  Planner  |   Mandatory questions, design discussion doc,
  +-----------+   structure outline, then sprint contracts.
        |
        v
  +-----------+
  |  Curator  |   Reads codebase FOR the sprint: extracts patterns,
  +-----------+   utils, affected files, test templates. Saves briefing.
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

## Operating Modes

agent-bober operates in four modes — pick the one that matches your situation. See
[VISION.md](./VISION.md) for full documentation, worked examples, and configuration details.

| Mode | When to Use | Entry Point |
|------|-------------|-------------|
| **Autopilot** | Feature spikes, greenfield work, no production risk | `agent-bober run` |
| **Careful-Flow** | Production behavior changes, want checkpoint approval | `agent-bober run --mode careful` |
| **Diagnose** | Production system is broken right now | `agent-bober incident start` |
| **Postmortem** | After resolving an incident, generate a retrospective | `bober postmortem generate` |

---

## Installation

There are two ways to run agent-bober, and they are complementary:

- **Claude Code plugin** — the skills (`/bober-run`, `/bober-plan`, …) and subagents, running on your Claude Code subscription. No npm or API key required.
- **npm package** — the standalone CLI + MCP server (`agent-bober`), which calls LLM providers directly (anthropic / deepseek / claude-code) and powers headless, CI, and programmatic runs.

For the full feature set, install both.

### Claude Code Plugin

Install the plugin from its marketplace, then install `bober`:

```text
/plugin marketplace add BOBER3r/agent-bober
/plugin install bober@agent-bober
```

This installs 24 skills + 11 subagents. Update later with `/plugin update bober`. The plugin runs the Researcher → Planner → Curator → Generator → Evaluator pipeline as Claude Code subagents on your Claude subscription — provider selection (the [Capability Matrix](#capability-matrix)) does **not** apply in this mode.

### npm CLI / MCP Server

```bash
# Install globally
npm install -g agent-bober

# Or use directly with npx
npx agent-bober init
```

**Updating later:** upgrade the package, then refresh each project's installed commands/agents:

```bash
npm i -g agent-bober@latest      # upgrade the global CLI/engine
agent-bober update               # in each project: refresh .claude/ commands + agents (config untouched)
```

`update` re-emits `.claude/commands/` and `.claude/agents/` from the new package version without touching your `bober.config.json` or `.bober/` state. Claude Code **plugin** users update separately with `/plugin update bober` (the plugin tracks the GitHub repo, not npm).

This is required to use the DeepSeek / claude-code providers, run bober headlessly or in CI, or expose the MCP server. A few plugin skills (`bober.plan`, `bober.sprint`, `bober.impact`, `bober.onboard`, `bober.graph`) also shell out to the `agent-bober` CLI, so installing it unlocks their full behavior. Graph features additionally require the separate [`tokensave`](#graph-tokensave-integration) binary.

agent-bober works in multiple environments:

- **Claude Code** -- Plugin with 20+ slash commands (`/bober-plan`, `/bober-run`, etc.) — install via the marketplace above
- **Cursor / Windsurf** -- MCP server with 37 tools in the chat interface
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
/bober-research     # Two-phase codebase research (facts only, no opinions)
/bober-architect    # Solution architecture design (optional, for complex features)
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

## Graph (Tokensave) Integration

> **Optional.** The graph is an opt-in enhancement — agent-bober's core pipeline (Researcher → Planner → Curator → Generator → Evaluator) works fully without it. Enable it only if you want semantic code search, impact analysis, and auto-generated onboarding docs.

agent-bober integrates with [tokensave](https://github.com/aovestdipaperino/tokensave) to build a structural code graph that powers semantic search, impact analysis, and automated onboarding documentation.

**Prerequisite — install the `tokensave` binary.** It is a native Rust binary, **not** an npm package, so `npm install -g agent-bober` does **not** install it. Install it separately:

```bash
# macOS (Homebrew)
brew install aovestdipaperino/tap/tokensave
# Windows (Scoop)
scoop bucket add tokensave https://github.com/aovestdipaperino/scoop-bucket && scoop install tokensave
# Any platform (Cargo / Rust)
cargo install tokensave
```

Required version range: **`>=6.0.0-beta.1 <7.0.0`**. agent-bober verifies this on `agent-bober graph init` and prints the correct install hint if `tokensave` is missing or out of range. If the binary is absent, graph features degrade gracefully and the rest of the pipeline is unaffected.

Once `tokensave` is installed, enable the graph by adding a `graph` section to `bober.config.json`:

```json
{
  "graph": {
    "enabled": true,
    "languageTier": "core"
  }
}
```

Once enabled, three new CLI commands and slash commands become available:

```bash
agent-bober graph init         # Initialise the graph index
agent-bober graph sync         # Re-index changed files (--force for full re-index)
agent-bober graph status       # Check graph status (--json for machine-readable)
agent-bober onboard            # Generate .bober/onboarding/ documentation
agent-bober impact <symbol>    # Analyse impact radius and test coverage
```

In Claude Code, the same workflows are available as slash commands: `/bober-graph`, `/bober-onboard`, `/bober-impact`.

For architecture details see: [`.bober/architecture/arch-20260524-port-code-review-graph-architecture.md`](.bober/architecture/arch-20260524-port-code-review-graph-architecture.md)

---

## Multi-Provider Support

agent-bober is **provider-agnostic**. Use any LLM provider for any agent role. Mix and match providers freely -- use one for planning, another for generation, a local model for evaluation.

### Supported Providers

| Provider | Shorthands | API Key (env var) |
|----------|-----------|---------|
| **Anthropic** (default) | `opus`, `sonnet`, `haiku` | `ANTHROPIC_API_KEY` |
| **DeepSeek** | `deepseek`, `deepseek-v4-pro`, `deepseek-v4-flash` | `DEEPSEEK_API_KEY` |
| **OpenAI** | Any OpenAI model ID | `OPENAI_API_KEY` |
| **Google Gemini** | `gemini-pro`, `gemini-flash` | `GOOGLE_API_KEY` or `GEMINI_API_KEY` |
| **OpenAI-Compatible** | Any model (Ollama, LM Studio, Groq, custom endpoints) | Optional (none for local servers) |

Shorthands resolve to the latest model version automatically. You can also pass any full model ID directly -- it will be sent to the provider as-is.

> **Which API key do I need? (read this first)**
>
> **The default is Anthropic, so `ANTHROPIC_API_KEY` on its own means every role calls Claude — nothing else.** Setting `ANTHROPIC_API_KEY` does **not** turn on DeepSeek. Provider selection is **config-driven, not key-driven**: a key is only used if a role is actually pointed at that provider.
>
> To use **DeepSeek** you need **three** things together:
> 1. `npm install openai` — the OpenAI SDK is the OpenAI-compatible client DeepSeek runs through (an optional peer dependency).
> 2. `export DEEPSEEK_API_KEY=sk-...` — get a key at <https://platform.deepseek.com>. (`ANTHROPIC_API_KEY` is **not** needed if no role uses Anthropic.)
> 3. Point one or more roles at DeepSeek in `bober.config.json` — see [DeepSeek setup (full example)](#deepseek-setup-full-example) below.
>
> DeepSeek is **not** reachable with the `--provider` CLI flag alone (that flag only swaps the provider name; DeepSeek also needs its model + endpoint) — configure it in `bober.config.json`.

### Capability Matrix

> **This matrix applies to the standalone CLI / programmatic provider layer only** (`npx agent-bober run …`), where bober calls each provider's API directly. It does **not** apply to the **Claude Code plugin**: when you run a skill like `/bober-run` inside Claude Code, the roles are spawned as Claude Code subagents on your Claude subscription, so provider selection (including `claude-code`) does not apply. See [Claude Code Plugin](#claude-code-plugin) below.

| Role                   | anthropic (default)  | deepseek (openai-compat) | claude-code (subscription) |
| ---------------------- | -------------------- | ------------------------ | -------------------------- |
| planner                | yes                  | yes                      | yes (no tools needed)      |
| researcher (phase 1/2) | yes                  | yes                      | yes (no tools needed)      |
| curator                | yes                  | yes (tools)              | no (runs own loop)         |
| generator              | yes                  | yes (tools)              | no (runs own loop)         |
| evaluator              | yes                  | yes (tools)              | no (runs own loop)         |
| code-reviewer          | yes                  | yes (tools)              | no (runs own loop)         |
| documenter             | yes                  | yes (tools)              | no (runs own loop)         |

**DeepSeek prerequisites:** `npm install openai` (optional peer dep) and set `DEEPSEEK_API_KEY` in
your environment. DeepSeek supports all roles including tool-calling roles (curator, generator,
evaluator, code-reviewer).

**claude-code prerequisites:** An active Claude subscription (Pro/Max/Team) and the `claude` CLI
on PATH. claude-code is **planner and researcher only** — it cannot be used for tool-using roles
because the `claude -p` interface does not support tool-calling. As of the **2026-06-15 ToS update**,
programmatic subscription use is metered (Agent-SDK credit, billed at API rates, no rollover).
Each `claude -p` call injects approximately **40,000 tokens of system-prompt overhead**.

See [`docs/providers.md`](docs/providers.md) for copy-paste config snippets for each provider.

### DeepSeek setup (full example)

DeepSeek runs through the built-in OpenAI-compatible adapter pointed at `https://api.deepseek.com`. End-to-end:

**1. Install the OpenAI-compatible client** (one-time):

```bash
npm install openai
```

**2. Export your DeepSeek key** (get one at <https://platform.deepseek.com>):

```bash
export DEEPSEEK_API_KEY=sk-...
```

**3a. Configure roles — shorthand (simplest).** Set only the `model`; the provider (`openai-compat`) and the `https://api.deepseek.com` endpoint are inferred automatically:

```jsonc
// bober.config.json — DeepSeek for every role
{
  "planner":    { "model": "deepseek-v4-pro" },
  "researcher": { "model": "deepseek-v4-flash" },
  "curator":    { "model": "deepseek-v4-pro" },
  "generator":  { "model": "deepseek-v4-pro" },
  "evaluator":  { "model": "deepseek-v4-flash" }
}
```

**3b. Configure roles — explicit (equivalent).** Spell out the provider and endpoint if you prefer — also the form to use for a self-hosted DeepSeek-compatible gateway:

```jsonc
{
  "generator": {
    "provider": "openai-compat",
    "model": "deepseek-v4-pro",
    "endpoint": "https://api.deepseek.com"
  }
}
```

**4. Run:**

```bash
agent-bober run "Build a REST API with auth and CRUD"
```

> Use `"provider": "openai-compat"` (as in 3b), **not** `"provider": "deepseek"` — `deepseek` is a *model* shorthand, not a provider name, so `"provider": "deepseek"` is rejected as an unsupported provider.

**Mix providers** — e.g. plan on Claude (highest quality) and generate/evaluate on DeepSeek (cheaper). You then need **both** `ANTHROPIC_API_KEY` and `DEEPSEEK_API_KEY` in your environment:

```jsonc
{
  "planner":   { "model": "opus" },
  "generator": { "model": "deepseek-v4-pro" },
  "evaluator": { "model": "deepseek-v4-flash" }
}
```

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
    "model": "your-preferred-model"
  },
  "evaluator": {
    "provider": "openai-compat",
    "model": "any-local-model",
    "endpoint": "http://localhost:11434/v1"
  }
}
```

The `ollama/` prefix is a shortcut for local models:
```jsonc
{ "model": "ollama/llama3" }  // resolves to openai-compat at localhost:11434
```

Override provider for all roles from the CLI:
```bash
npx agent-bober run "feature" --provider openai
```

Provider SDKs (`openai`, `@google/generative-ai`) are **optional peer dependencies** -- install only what you use. Only `@anthropic-ai/sdk` is required by default.

### Anthropic features (Claude Opus 4.8)

- **Latest model by default.** The `opus` shorthand resolves to **`claude-opus-4-8`** (1M context, adaptive thinking). Pin the previous generation with the `opus-4-7` shorthand.
- **Prompt caching, on by default.** Multi-turn Anthropic calls reuse a cached system + recent-message prefix (ephemeral `cache_control`, system-and-last-3 strategy), cutting input-token cost. Disable per role with `"providerConfig": { "promptCaching": false }`.
- **Effort control.** Set `effort` (`low` | `medium` | `high` | `xhigh` | `max`) to trade latency/cost against depth; when omitted, the API default applies (`high` on Opus 4.8). Other providers ignore it.
- **Mid-conversation system updates.** Instructions can be revised mid-task without breaking the prompt cache (Anthropic `mid_conv_system` blocks).

---

## MCP Server (Cursor, Windsurf, etc.)

agent-bober includes an MCP (Model Context Protocol) server that exposes **37 tools** across pipeline, run-management, careful-flow approvals, multi-project discovery, incident response, and graph in any MCP-compatible IDE.

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
| `bober_architect` | sync | Solution architecture -- 5-checkpoint flow producing docs + ADRs |
| `bober_research` | sync | Two-phase codebase research -- fact-only analysis |
| `bober_run` | async | Full autonomous pipeline (returns immediately, poll with status) |
| `bober_brownfield` | async | Brownfield pipeline for existing codebases |
| `bober_react` | async | React web application pipeline (Vite or Next.js) |
| `bober_solidity` | async | EVM smart contract pipeline (Hardhat/Foundry) |
| `bober_anchor` | async | Solana program pipeline (Anchor) |
| `bober_playwright` | sync | Set up, run, or check Playwright E2E tests |
| `bober_status` | poll | Check pipeline progress or read current status |
| `bober_contracts` | read | List all sprint contracts or read a specific one |
| `bober_spec` | read | Read the current PlanSpec |
| `bober_principles` | read/write | Read or set project principles |
| `bober_config` | read/write | Read or update `bober.config.json` |
| `bober_list_pending_approvals` · `bober_approve_checkpoint` · `bober_reject_checkpoint` | careful-flow | List / approve / reject checkpoint approvals (careful mode) |
| `bober_list_active_runs` · `bober_get_run_status` · `bober_abort_run` · `bober_run_in_worktree` | run-mgmt | Manage concurrent and isolated-worktree runs |
| `bober_subscribe_events` · `bober_unsubscribe_events` | events | Live run event stream |
| `bober_get_project_state` · `bober_list_projects` · `bober_list_specs` | discovery | Multi-project state + spec discovery |
| `bober_incident_start` · `bober_incident_status` · `bober_incident_list` · `bober_incident_abort` · `bober_rollback_start` · `bober_postmortem_get` · `bober_playbook_search` · `bober_playbook_list` | incident | Diagnose, roll back, postmortem, and search playbooks |

*(37 tools total — the rows above summarize the additional categories beyond the core pipeline tools.)*

---

## Brownfield Auto-Discovery

When you run `agent-bober init brownfield` (or use the `bober_init` MCP tool with mode=brownfield), agent-bober deeply analyzes your existing codebase and automatically:

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
| `/bober-research` | Two-phase codebase research -- opinion-free facts for planning |
| `/bober-architect` | Solution architecture workflow -- 5-checkpoint discussion producing architecture docs + ADRs |
| `/bober-plan` | Plan any feature -- research, questions, design doc, outline, contracts |
| `/bober-sprint` | Execute the next sprint contract |
| `/bober-eval` | Evaluate current sprint output |
| `/bober-run` | Full autonomous pipeline (research + plan + sprint + eval loop) |
| `/bober-react` | React web application workflow |
| `/bober-solidity` | EVM smart contract workflow |
| `/bober-anchor` | Solana program workflow |
| `/bober-brownfield` | Existing codebase workflow |
| `/bober-playwright` | Set up Playwright E2E testing, generate tests, debug failures |
| `/bober-code-review` | Advisory review of the sprint diff against the contract + anti-pattern catalog |
| `/bober-security-audit` | On-demand stack-aware security audit of a path (or the working tree) -- spawns the `bober-security-auditor` subagent, presents severity-ranked findings; advisory-only |
| `/bober-verify` | Verification-before-completion -- run checks and confirm output before claiming success |
| `/bober-debug` | Systematic debugging -- reproduce, isolate, hypothesize, fix, verify |
| `/bober-graph` | Manage the code graph index -- init, sync, status (requires tokensave) |
| `/bober-impact` | Analyse the impact radius and test coverage of a symbol or file |
| `/bober-onboard` | Generate onboarding docs from the code graph |
| `/bober-incident` | Run the incident lifecycle -- diagnose, deploy, verify, postmortem |
| `/bober-diagnose` | Investigate a production incident -- evidence at boundaries, hypothesize-and-disprove |
| `/bober-deploy` | Execute a remediation action with blast-radius classification + change-management gates |
| `/bober-runbook` | Execute a step-by-step recovery procedure with pre/postcondition gates |
| `/bober-postmortem` | Synthesize an evidence-cited postmortem from incident artifacts |
| `/bober-using-bober` | Establishes how to find and use bober skills (loaded at conversation start) |

> **Preset-aware install:** `agent-bober init <preset>` installs the universal commands above plus only the stack-specific commands matching your preset or mode -- e.g. `/bober-solidity` is added for a `solidity` project, `/bober-react` and `/bober-playwright` for `nextjs`/`react-vite`, and `/bober-brownfield` for an existing codebase. The Claude Code plugin (`/plugin install`) always ships the full set.

### CLI

```bash
npx agent-bober init [preset]                            # Initialize project (with provider selection)
npx agent-bober update                                   # Refresh .claude/ commands + agents after upgrading the package
npx agent-bober plan "feature"                           # Run the planner (also materializes sprint contracts)
npx agent-bober plan answer <specId>                     # Resolve clarification questions interactively
npx agent-bober plan answer <specId> <questionId> "..."  # Resolve a single clarification question
npx agent-bober sprint                                   # Execute next sprint (consumes plan's contracts)
npx agent-bober eval                                     # Evaluate current sprint
npx agent-bober run "feature"                            # Full autonomous loop
npx agent-bober run "feature" --team example             # Full autonomous loop using the 'example' team
npx agent-bober chat                                     # Interactive chat REPL (roster + memory aware)
npx agent-bober chat example                             # Interactive chat REPL using the 'example' team
npx agent-bober chat hub                                 # Priority-hub chat REPL (in-session /priority + /decide)
npx agent-bober mcp                                      # Start MCP server (Cursor/Windsurf)
```

#### Chat Steer Commands (Phase 2 — mid-flight HITL)

Inside the `agent-bober chat` REPL you can steer in-flight runs with these commands:

| Command | Description |
|---|---|
| `/careful [on\|off]` | Toggle approval gates for new runs. When ON, new runs spawn with `--approve-gates post-research,post-plan,post-sprint` and pause at each curated gate waiting for human input. |
| `/approve <checkpointId>` | Approve a pending checkpoint (e.g. `post-plan`, `post-sprint`) and resume the run. |
| `/reject <checkpointId> [feedback]` | Reject a pending checkpoint with optional feedback for the run to use on retry. |
| `/tell <runId> <text>` | Queue free-text guidance for a run — applied at the next pipeline boundary. |
| `/pause <runId>` | Soft-pause a run at the next cooperative boundary. The process stays alive. |
| `/resume <runId>` | Resume a soft-paused run. |
| `/stop <runId>` | Hard-stop a run by killing its process (contrast with `/pause` which is cooperative). |
| `/runs` | List all active and recent runs. |
| `/help` | Show the full command list. |
| `/exit` | Exit the chat session. |

**Curated gates** (triggered by `--approve-gates`): `post-research`, `post-plan`, `post-sprint`. Each gate pauses the run and surfaces a notice in the next chat turn. Use `/approve` or `/reject` to resolve.

**Limitation:** Only one careful run at a time is fully supported. Pending markers are checkpointId-keyed in a shared `.bober/approvals/` directory, so two concurrent careful runs that hit the same gate id would collide. The non-chat equivalents (`list-approvals`, `approve`, `reject`) remain available as fallback. See `docs/chat-steer.md` for the full model and the documented limitations.

#### New Commands (Sprints 9–25)

The following commands were added after the initial release. Full reference in [COMMANDS.md](./COMMANDS.md).

```bash
# Checkpoint approval (careful-flow mode)
npx agent-bober list-approvals                        # List pending checkpoints
npx agent-bober approve <checkpointId>                # Approve a checkpoint
npx agent-bober approve <checkpointId> --edit <file>  # Approve with edit delta
npx agent-bober reject <checkpointId>                 # Reject a checkpoint
npx agent-bober audit show <runId>                    # Show audit log for a run

# Incident response
npx agent-bober incident start '<symptom>' --severity S2   # Start incident
npx agent-bober incident status <incidentId>               # Check status
npx agent-bober incident end <incidentId> --verified       # Mark resolved
npx agent-bober incident list                              # List all incidents
npx agent-bober incident abort <incidentId> --reason "..."  # Abort incident

# Rollback
npx agent-bober rollback <incidentId> --dry-run    # Preview rollback plan
npx agent-bober rollback <incidentId>              # Execute rollback

# Postmortem
npx agent-bober postmortem generate <incidentId>   # Generate retrospective
npx agent-bober postmortem show <incidentId>       # Print retrospective

# Playbooks
npx agent-bober playbook list                      # List all playbooks
npx agent-bober playbook show <name>               # Show playbook content
npx agent-bober playbook search '<symptom>'        # Search by symptom

# Medical team (Phase 6)
npx agent-bober medical import <file>              # Stream-import a health export (e.g. Apple Health export.xml)
npx agent-bober medical import-labs <pdf>          # Parse a lab PDF into vault notes + health store (cloud-inference axis; fail-closed off)
npx agent-bober medical supplements add <name> [--dose <d>]  # Record a supplement as a FactStore fact (medical scope; idempotent re-add)
npx agent-bober medical supplements list           # Print supplements from the markdown-frontmatter file
npx agent-bober medical profile show               # Decrypt + show the SOPS-encrypted personalization profile (fail-closed if sops missing)
npx agent-bober medical profile set <key> <value>  # Update one profile field (age/sex/conditions/...); re-encrypts via sops (age backend, local)
npx agent-bober medical whoop sync [--since <iso>] # Sync WHOOP recovery/sleep/cycle/workout (device-connection axis)
npx agent-bober medical review [--dig-deeper <id>] # Deterministic offline proactive pass -> trend + cadence-gap + cross-marker-offer Finding notes; --dig-deeper runs the gated 4-lens deep analysis for an offer
npx agent-bober medical recommend <question> [--goal <g>]  # 4-lens judge panel -> action/question Finding (cloud-inference axis; fail-closed local)
npx agent-bober medical research [--marker <m>]    # Online MedlinePlus research -> grounded vault research notes + watch findings (literature-retrieval axis; zero egress off)

# Vault knowledge base
npx agent-bober vault reindex --scope <domain> [--vault <dir>]  # Rebuild the derived FactStore from a vault's note frontmatter

# Priority hub (cross-domain Findings)
npx agent-bober hub list                           # Print Findings from the project's own FactStore + sibling kb-* repos (read-only, deduped by id); title [kind] urgency/severity per line
npx agent-bober hub priority [--domain <d>] [--due <days>] [--tag <t>]  # Rank pooled Findings (general, or filtered) and write priority.md into the kb-hub vault; prints a ranked summary
npx agent-bober hub decide "X vs Y"                # Rank Findings under decision scope (only X/Y-relevant survive) and write priority.md

# Task inbox (zero-friction capture into the hub pool)
npx agent-bober task add "<text>" [--domain <d>]   # Capture a plain task as one open kind=action Finding in the hub pool; deterministic, never prompts/blocks
npx agent-bober task list [--all] [--status <s>]   # List tasks (open + in-progress + woken snoozed by default; --all or --status widens to done/dropped)
npx agent-bober task start <id>                    # Move a task to in-progress (supersede; prior status kept as history)
npx agent-bober task done <id>                     # Mark a task done (supersede; hidden from the default list, still in --all)
npx agent-bober task drop <id>                     # Abandon a task → status=dropped via supersede (never deleted)
npx agent-bober task snooze <id> --until <when>    # Defer a task: status=snoozed + snooze-until:<ISO> tag; hidden from default list until wake time passes (lazy, no timer)
npx agent-bober task ingest [file]                 # Domain seam: ingest a Finding JSON (file or stdin) into the hub pool; content-id dedup (domain|title|kind), schema-validated, fail-closed exitCode=1
npx agent-bober task from-gmail <thread>           # Opt-in: capture one Gmail thread as an open action task. OFF by default (taskInbox.gmailEgress) — refuses with no MCP client/network when disabled; sanitizes connector errors (never leaks tokens)

# Do-bridge (promote a Finding into an agent-bober run)
npx agent-bober do <findingId> --dry-run           # Preview the agent-bober run task a coding/projects Finding would launch (read-only: no mutation, no approval marker, no spawn); unsupported domain → exitCode=1
npx agent-bober do <findingId>                      # Real path: write a promote-<id> approval marker, gate (TTY confirm / non-TTY wait for agent-bober approve|reject), then launch detached `agent-bober run` on approve — links Finding.promotesTo (runId, status launched) + moves it open→in-progress; reject leaves it unchanged
npx agent-bober do <findingId> --yes               # Real path, auto-approve (skip the confirm prompt; still writes+clears the marker)
npx agent-bober do --reconcile                     # Reconcile launched promotions: read each run's run-state.json snapshot → advance the Finding (completed→done, aborted/failed→open, running→unchanged); also runs best-effort at the start of every `agent-bober do`

# Calendar planner (deterministic slot-fill from ranked Findings)
npx agent-bober calendar plan --dry-run --findings <path> [--freebusy <path>]  # Place ranked Findings into open slots in priority order (pure JS, LLM never packs); print scheduled (ISO start/end) + unscheduled (reason) — dry-run writes nothing to any calendar
npx agent-bober calendar plan --export-ics <path> --findings <path> [--freebusy <path>]  # Same slot-fill, then write the plan to a local-first RFC 5545 .ics file (one VEVENT per scheduled item, UTC DTSTART/DTEND) with zero network egress — import it manually into your calendar app
npx agent-bober calendar plan --findings <path> [--freebusy <path>]  # Live path: slot, then PROPOSE through the existing approval gate — writes a pending marker + plan sidecar and ZERO events; prints checkpointId (calendar-<id>) + how to approve. No auto-approve in any mode
npx agent-bober calendar apply <checkpointId>      # Write events for an approved plan: detects the approved/rejected marker inline → connector.writeEvents EXACTLY once on approval / never on reject (Google still egress-gated). Approve first: agent-bober approve <checkpointId> (or /approve in chat)

# Research scheduler (recurring multi-model research jobs)
npx agent-bober research job add --question "..." [--cadence daily|weekly|monthly] [--tier <t>] [--domain <d>] [--target-repo <r>] [--online-research]  # Define a recurring research job as JSON under .bober/research/jobs/ (validated by ResearchJobSchema; deterministic jobId=sha256(question|createdAt); --online-research stored but inert until egress lands)
npx agent-bober research job list                  # List all defined research jobs (jobId, cadence, question, [domain])
npx agent-bober research job remove <jobId>        # Delete a research job's JSON file (not-found → exitCode=1)
npx agent-bober research run <jobId>               # Execute one stored job: query ≥2 distinct tier-policy provider/model blocks, write a vault research note (frontmatter jobId/question/models[]/generatedAt), emit exactly one kind:"watch" hub Finding; prints the note path. Offline unless research.egress.onlineResearch; never throws (not-found → exitCode=1)
npx agent-bober research tick [--watch] [--interval <ms>]  # Run every job due as of now (nextDueAt unset or <= now) on the same path; idempotent — advances each run job's nextDueAt by cadence (daily+1d/weekly+7d/monthly+1mo) + sets lastRunAt, so a 2nd tick runs nothing. Clock read only at the boundary. --watch = in-process setInterval (default 1h); for unattended runs use OS cron/launchd, e.g. `0 * * * * agent-bober research tick`
npx agent-bober research digest [--since <iso>]    # Aggregate research runs in [since, now] (default last 24h) into a morning digest under .bober/research/digests/<date>.{md,json} — markdown (one bullet per run: title/top finding/source) + JSON for the Telegram bot. Reads vault research notes (non-sensitive titles only); empty window writes both files with an explicit no-new-research body; never throws

# Telegram frontend (local long-polling bot; transport + whitelist + funnel + zero-friction capture + scoped hub-priority commands + inline approve/adjust/reject gate + document-upload medical-ingest opt-in + streaming in-place progress + silent scheduled digest + multi-LLM /fleet secretary view) — spec COMPLETE (7/7 sprints)
npx agent-bober telegram                           # Start the local getUpdates long-polling bot (NO server/webhook/inbound port). Reads TELEGRAM_BOT_TOKEN (required; absent → exitCode=1, no network) + TELEGRAM_ALLOWED_USERS (comma-separated numeric ids; empty → deny-all, fail-closed) from env. Plain text from a whitelisted sender is captured as one open inbox task (message = title, no other required field) with a "Captured: <title>" reply; /priority, /today, and /decide X vs Y reply with a numbered ranked list from the priority hub (ephemeral scope parsed from the command, delegated to the hub CLI subprocess so the LLM stays out of the adapter, titles only); /pending lists pending approval checkpoints with [Approve][Adjust][Reject] inline buttons whose taps write the SAME .approved.json/.rejected.json disk markers the approve/reject CLI writes (no new mechanism — calendar/do-bridge resolve through the one existing gate; Approve has no editDelta, Adjust carries editDelta, Reject carries feedback; taps are whitelist-first + pendingExists-guarded, Adjust/Reject collect a follow-up text turn via ephemeral in-memory state); uploading a document (Telegram is NOT E2E-encrypted) DEFERS the download behind a per-upload [Yes][No] opt-in that names the local medical store (.bober/medical) — only on Yes does it download to a temp dir + hand the file to the existing `medical import` ingest exactly once (medical egress/consent/audit guards stay authoritative in the subprocess) + reply with a non-sensitive count only (no PHI) + remove the temp dir; No/no-confirm ingests nothing; /start gets a help stub and any other /command an "Unknown command" stub; everyone else gets one denial echoing their own id. Two Sprint-6 outbound delivery modes (presentation only, no run/fleet/scheduler logic): streamProgress reports a long-running operation by editing ONE status message in place — one sendSafeForEdit send (captures the message id) + N sendSafeEdit edits on the SAME id over an injected async iterable (never a new message per tick; live do-bridge wiring left as a documented seam in src/do-bridge/do.ts), and sendDigest delivers a scheduler-handed digest payload silently (sendSafe with {silent:true} → disable_notification; content/cadence owned by the research-scheduler). /fleet (Sprint 7) shows the most recent fleet run: a read-only renderer reads .bober/fleet-synthesis.json, groups findings by per-agent FactRecord.subject, and replies with a header (round count) + one labeled section per agent (label + one-line summary of the latest finding + round + confidence + finding count); the SAME renderer feeds the live streaming sections, over-long values are truncated to one line, missing/empty synthesis → "no recent fleet run" (never throws), /fleet is whitelist-gated first (non-whitelisted reads nothing), and SynthesisBundle/FactRecord are type-only imports so the bot keeps zero runtime coupling to src/fleet/better-sqlite3 (no new dep). All text replies leave through the single sendSafe funnel + all keyboards through the single sendSafeKeyboard funnel + streaming through sendSafeForEdit/sendSafeEdit (four chokepoints total; the new silent option is an optional 4th sendSafe arg so prior callers are byte-identical); grammy is isolated behind the transport wrapper. Ctrl+C (SIGINT/SIGTERM) stops it; never throws. spec-20260628-telegram-frontend is COMPLETE (7/7 sprints); deferred: live do-bridge streaming wire + live smoke tests need a real bot token, Tier 2/Tier 3 → sibling specs

# Security audit (three surfaces over one runSecurityAudit core: fail-closed pipeline gate + this CLI + the advisory `bober.security-audit` skill; opt-in, default-off) — spec-20260712 COMPLETE (7/7). agent-bober itself dogfoods the gate (security.enabled=true, scanners:[] — LLM-only). Full reference: docs/security-audit.md
npx agent-bober security-audit [target]            # Run an on-demand stack-aware security audit against a local path (or the working tree when target is omitted). Runs the SAME runSecurityAudit core the in-pipeline gate uses (with evaluation=null), persists a cited artifact to .bober/security/<id>-security-audit.md, and prints a summary (verdict, per-bucket counts, top findings as path:line, artifact path). Exit code: 0 = pass, 2 = blocked-by-threshold OR fail-closed (audit threw / auditor output unparseable) — wire it into CI. Blocking threshold is security.standaloneBlockOn ('critical' default | 'important' also fails on important-bucket findings). Does NOT require security.enabled=true — the explicit invocation IS the opt-in; the pipeline gate's critical-only veto is untouched. After the exit code is computed, critical (hub severity/urgency 5) + important (3) findings are emitted into the priority hub (best-effort, guarded by security.hub default true; never changes the exit code) so they show up in `bober hub list`/`priority`. Local paths only (no remote URLs). For a conversational audit inside Claude Code use the `/bober-security-audit` skill (advisory-only; spawns the bober-security-auditor subagent)

# Fleet orchestrator (spawn N isolated agent-bober children in bulk)
npx agent-bober fleet <manifest>                   # Run a fleet of agent-bober children from a manifest (full reference in COMMANDS.md)
npx agent-bober fleet expand <goal>                # Decompose a goal into a fleet manifest and optionally run it (full reference in COMMANDS.md)
npx agent-bober fleet expand-deep <goal>           # Robustly decompose a large/ambiguous goal (two-stage plan-then-expand) into a fleet manifest and optionally run it (full reference in COMMANDS.md)

# Config, telemetry & introspection
npx agent-bober config [migrate]                   # Inspect and migrate bober.config.json (full reference in COMMANDS.md)
npx agent-bober telemetry <status|purge|export>    # Inspect, export, or purge local telemetry events (opt-in, local-only; full reference in COMMANDS.md)
npx agent-bober worktree run <task>                # Run the full Bober pipeline in an isolated git worktree on a new branch (full reference in COMMANDS.md)
npx agent-bober memory <distill|list|show|prune>   # Inspect and distill self-improvement lessons (full reference in COMMANDS.md)
npx agent-bober facts <add|list|show|invalidate>   # Inspect and manage semantic bi-temporal facts (full reference in COMMANDS.md)
```

#### Clarification gating

When the planner can't fully decompose a feature without more information, it stops with `status: "needs-clarification"` instead of fabricating sprints — and writes **no** contracts. The CLI surfaces the open questions and you resolve them via `plan answer`. After the last question is answered the spec auto-promotes to `status: "ready"`, its sprint contracts are materialized into `.bober/contracts/`, and the next `sprint`/`run` proceeds. See the **Architecture** section for the full lifecycle.

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

For **DeepSeek**, set `DEEPSEEK_API_KEY` and point your roles at the `deepseek` model in `bober.config.json` — the `--provider` flag alone is not enough, since DeepSeek also needs its model + endpoint (see [DeepSeek setup (full example)](#deepseek-setup-full-example)):

```bash
npm install openai
export DEEPSEEK_API_KEY=sk-...
cd your-project
agent-bober init nextjs
# in bober.config.json set "model": "deepseek-v4-pro" on the roles you want
agent-bober run "Build a complete dashboard with auth, CRUD, and charts"
```

---

## Lens Panels (multi-perspective evaluation & architecture)

Both the **evaluator** and the **architect** can run as a *lens panel* -- fanning a single decision out across several independent perspectives, then reconciling them into one verdict. Panels are **opt-in and off by default**; when disabled, behavior is byte-identical to the single-pass path.

- **Evaluator panel** (`evaluator.panel`): runs each sprint evaluation through the built-in lenses **correctness**, **security**, **regression**, **quality**, and **simplicity**, with bounded fan-out and a reconcile step, recording per-lens verdicts as telemetry.
- **Architect panel** (`architect.panel`): gates the architecture approach-selection and review checkpoints through the built-in lenses **scalability**, **security**, **cost**, **operability**, **maintainability**, **reversibility**, and **simplicity**, with a fail-closed reconcile.

The **simplicity** lens is a complexity-only perspective (YAGNI): it hunts code that reinvents the standard library, dependencies doing what a native platform feature already does, single-implementation abstractions, dead flexibility, and logic that could be materially shorter — while being explicitly forbidden from ever recommending the removal of a test, a validation at a trust boundary, error handling, security, or accessibility. It pairs with a generator convention: deliberate simplifications with a known ceiling are marked with a `bober:` comment naming the ceiling **and** the upgrade path (e.g. `// bober: global lock, per-account locks if throughput matters`), so a shortcut reads as an auditable choice rather than an oversight — and the code-reviewer treats a marked shortcut as intent, an unmarked one with an obvious ceiling as a finding.

Enable a panel and (optionally) restrict or override the lenses:

```jsonc
{
  "evaluator": {
    "panel": { "enabled": true, "lenses": ["correctness", "security"], "maxConcurrent": 4 }
  },
  "architect": {
    "panel": { "enabled": true }   // empty "lenses" => all built-ins
  }
}
```

Leave `lenses` empty to use the full built-in set; `maxConcurrent` bounds how many lenses run in parallel (default 4). The same panels are available on the Claude Code plugin surface via the lens-aware evaluator/architect agents.

---

## Teams

agent-bober supports domain-agnostic **teams** — named configurations that route each run or chat session to a distinct set of providers, a separate memory namespace, and a chosen pipeline shape. **Adding a team is data, not code**: declare it in `bober.config.json`, no source changes required.

```jsonc
{
  "defaultTeam": "programming",   // Active team when --team / chat <team> is omitted
  "teams": {
    "example": {
      "displayName": "Example research team",
      "memoryNamespace": "example",   // Lessons land in .bober/memory/example/
      "pipelineShape": "ts",
      "providers": { "chat": "openai" }
    }
  }
}
```

```bash
npx agent-bober run "summarise research" --team example
npx agent-bober chat example
```

The built-in **programming** team is always available (no config entry needed) and uses
the default `.bober/memory/` path and the project's configured providers.

For full documentation on the three differentiation axes (provider routing / memory
namespace / pipeline shape), the built-in programming team, and the deferred
`.bober/teams/*.json` file registry, see [docs/teams.md](./docs/teams.md).

---

## Documentation

The `bober/medical-team` build turns agent-bober into a **local-first, multi-LLM personal
knowledge platform** — recurring research + fleet runs produce Findings and vault notes, the
priority hub ranks them, and a local Telegram bot is the read/act surface. Start with the umbrella
guide, then drill into a subsystem:

- **[docs/knowledge-platform.md](./docs/knowledge-platform.md)** — umbrella guide: how the pieces
  connect, one-time setup, and end-to-end quick-starts. **Read this first.**
- [docs/fleet.md](./docs/fleet.md) — multi-LLM fleet (heterogeneous children, difficulty tiers, blackboard, synthesis).
- [docs/research-scheduler.md](./docs/research-scheduler.md) — recurring multi-model research jobs, vault notes, digests.
- [docs/telegram.md](./docs/telegram.md) — the local long-polling Telegram frontend.
- [docs/providers.md](./docs/providers.md) — provider/model selection and env-var setup.
- [docs/storage.md](./docs/storage.md) — the local SQLite / JSON storage model and egress axes.

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

  // -- Curator (NEW in 0.11.0) -------------------------
  "curator": {
    "provider": "anthropic",              // "anthropic" | "openai" | "google" | "openai-compat"
    "model": "opus",                      // Default: opus (thorough codebase analysis)
    "endpoint": null,                     // Custom base URL (for openai-compat)
    "providerConfig": {},                 // Provider-specific settings
    "maxTurns": 25,                       // Max tool-use turns for curation
    "enabled": true                       // Set false to skip curation (generator explores on its own)
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
    "plugins": [],                        // Custom evaluator plugin paths
    "panel": {                            // Multi-lens evaluation (opt-in, off by default)
      "enabled": false,                   // Run the evaluator across multiple lenses
      "lenses": [],                       // [] = built-ins: correctness, security, regression, quality, simplicity
      "maxConcurrent": 4                  // Max lenses evaluated in parallel
    }
  },

  // -- Documenter (per-sprint docs, on by default) -----
  "documenter": {
    "enabled": true,                      // Spawn a doc subagent after each sprint passes; set false to skip
    "model": "sonnet",                    // Model for the documentation pass
    "maxTurns": 20,                       // Max tool-use turns for the doc pass
    "timeoutMs": 300000,                  // Advisory: a documenter timeout never downgrades the passed sprint
    "provider": "anthropic",              // Optional provider override
    "endpoint": null                      // Custom base URL (for openai-compat)
  },

  // -- Architect (lens panel, opt-in) ------------------
  "architect": {
    "panel": {
      "enabled": false,                   // Multi-lens architecture review (off by default)
      "lenses": [],                       // [] = built-ins: scalability, security, cost, operability, maintainability, reversibility, simplicity
      "maxConcurrent": 4
    }
  },

  // -- Security auditor (opt-in; whole section optional, default-off; agent-bober's own repo dogfoods it with { enabled: true, scanners: [] } — LLM-only) --
  "security": {                           // Optional. Omit entirely => byte-identical (no key, no defaults).
    "enabled": false,                     // Fail-closed pipeline gate runs ONLY when exactly true. NOT required by the standalone CLI.
    "failClosed": true,                   // Unparseable auditor output / timeout blocks. Default true.
    "timeoutMs": 300000,                  // Per-audit time-box (pipeline gate).
    "model": "opus",                      // Auditor model. Any model string or shorthand.
    "maxTurns": 20,                       // Max read-only tool-use turns for the audit.
    "standaloneBlockOn": "critical",      // CI threshold for `bober security-audit`: 'critical' | 'important'. Gate ignores this key.
    "scanners": [],                       // Opt-in deterministic pre-filter strategies (EvalStrategy[]). slither/semgrep JSON parsed into auditor priors; unknown scanners → raw-text excerpt. Nonzero exit ⇒ [] (use exit-0 commands). Empty ⇒ zero child processes.
    "hub": true                           // Emit critical (severity 5) / important (severity 3) findings into the priority hub after the verdict (gate + CLI). Best-effort; false ⇒ zero hub writes. Never affects the verdict/exit code.
  },

  // -- Sprint ------------------------------------------
  "sprint": {
    "maxSprints": 10,                     // Max sprints per plan
    "requireContracts": true,             // Require contract agreement before coding
    "sprintSize": "medium"                // "small" | "medium" | "large"
  },

  // -- Pipeline ----------------------------------------
  "pipeline": {
    "engine": "ts",                       // Orchestration engine: "ts" (default) | "skill" | "workflow"
    "researchPhase": true,                // Run two-phase research before planning (default: true)
    "architectPhase": false,              // Run solution architecture phase before planning (default: false)
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
  },

  // -- Teams (NEW: adding a team is data, not code) ----
  "defaultTeam": "programming",           // Optional. Active team when --team / chat <team> is omitted.
  "teams": {                              // Optional. Each entry is a team defined purely as DATA.
    "example": {
      "displayName": "Example research team",
      "memoryNamespace": "example",       // Lessons land in .bober/memory/example/
      "pipelineShape": "ts",              // "ts" | "skill" | "workflow"
      "providers": { "chat": "openai" }   // Partial role->provider override; unset roles keep defaults
    }
  },

  // -- Medical team egress (Phase 6; all three axes default false) --
  "medical": {                            // Optional. Omit entirely => zero egress (all axes off).
    "egress": {                           // Three INDEPENDENT opt-in axes; code-enforced zero-egress default.
      "cloudInference": false,            // Permit cloud inference synthesis. Default false.
      "literatureRetrieval": false,       // Permit MedlinePlus literature retrieval. Default false.
      "deviceConnection": false           // Permit WHOOP device-connection egress. Default false.
    },
    "inference": {                        // Optional. Synthesis/critic model override. Omit => local Ollama default.
      "provider": "openai-compat",        // Default openai-compat. A CLOUD provider here needs egress.cloudInference=true.
      "endpoint": "http://localhost:11434/v1", // Default localhost (Ollama). Non-localhost => treated as cloud + gated.
      "model": "llama3"                   // Default llama3. Threaded into both synthesis and the grounding critic.
    },
    "vaultDir": ".bober/medical/vault"    // Optional. Vault dir for proactive-review Finding notes. Omit => <root>/.bober/medical/vault.
  },

  // -- Vault (on-device Obsidian MCP read/write adapter) --
  "vault": {                              // Optional. Omit entirely => no MCP adapter.
    "obsidian": {                         // Declares ONE on-device Obsidian MCP server.
      "name": "my_vault",                 // Alphanumeric/underscore. Used in errors — never secrets.
      "mcpCommand": "npx",                // Local executable to spawn (stdio). REMOTE schemes are refused.
      "mcpArgs": ["-y", "obsidian-mcp-server"],
      "mcpEnv": { "OBSIDIAN_API_KEY": "..." }, // OPAQUE secret — never logged or stringified.
      "enabled": true,                    // Default true.
      "toolNames": {                      // Optional. Override per-op tool names for a non-cyanheads server.
        "readNote": "obsidian_read_file",      // Default (cyanheads/obsidian-mcp-server).
        "writeNote": "obsidian_update_file",   // Default.
        "listNotes": "obsidian_list_files_in_dir" // Default.
      }
    }
  },

  // -- Task inbox Gmail egress (opt-in; isolated single axis, default false) --
  "taskInbox": {                          // Optional. Omit entirely => zero Gmail egress.
    "gmailEgress": false                  // Permit `agent-bober task from-gmail` to read a thread via the MCP connector. Default false.
  },

  // -- Calendar planner (Google Calendar egress, opt-in; default 'ics', zero-egress) --
  "calendar": {                           // Optional. Omit entirely => local .ics connector, zero cloud egress.
    "egress": {                           // Single opt-in axis; code-enforced fail-closed default.
      "cloudCalendar": false              // Permit Google Calendar (cloud) free/busy read + event write. Default false.
    },
    "connector": "ics",                   // 'ics' (local, default) | 'google' (cloud, needs egress.cloudCalendar=true + a 0600 token).
    "timezone": "America/New_York"        // Optional IANA tz, informational only (not used in epoch-ms slot math).
  },

  // -- Research scheduler online egress (opt-in; isolated single axis, default false) --
  "research": {                           // Optional. Omit entirely => research runs are fully offline.
    "egress": {                           // Single opt-in axis; code-enforced fail-closed default.
      "onlineResearch": false             // Permit `agent-bober research run` web/online retrieval. Default false.
    }
  }
}
```

> **The Obsidian MCP adapter is on-device only.** `VaultMcpAdapter` wraps the existing
> `ExternalMcpServer` and exposes `readNote` / `writeNote` / `listNotes` over the declared
> server. An `isOnDevice()` guard **refuses any non-local declaration before the server is
> spawned** — a `mcpCommand` with a remote URL scheme (`https?`/`wss?`/`ftp`/`tcp://`) or an
> `mcpArgs` element pointing at a non-loopback host throws (naming only `name`, never `mcpEnv`).
> `mcpEnv` is treated as opaque secrets and is never logged. Tool names default to
> cyanheads/obsidian-mcp-server and are overridable for other servers (e.g. the Obsidian Local
> REST API plugin's built-in MCP). The adapter is an independent read/write surface — it is **not**
> wired into `agent-bober vault reindex`, which reads notes from the local filesystem. See
> [docs/sprints/sprint-spec-20260628-obsidian-vault-store-4.md](./docs/sprints/sprint-spec-20260628-obsidian-vault-store-4.md).

> **Zero-egress is code-enforced for the medical team.** All three `medical.egress` axes
> default `false`, so a medical SOP turn makes **zero outbound calls** out of the box —
> a numeric question is answered from deterministic local compute and a literature
> question abstains, with no network module ever reached. The default is enforced two
> ways: the runtime `EgressGuard` (whose `assertAllowed` throws when an axis is off) and
> a scoped `no-restricted-imports` ESLint boundary over `src/medical/**/*.ts` that makes
> any network import a lint error (with **two** sanctioned exceptions — the
> literature-retrieval source `src/medical/retrieval/medline-source.ts` and the WHOOP
> client `src/medical/whoop/whoop-client.ts`). Opting `literatureRetrieval` **in** turns
> on a real MedlinePlus / NIH (no-auth) grounded retrieval + cited synthesis that
> **abstains unless a retrieved passage supports the claim**; it runs the synthesis on a
> **local** model (Ollama by default). Opting `deviceConnection` **in** turns on the
> authenticated WHOOP transport (OAuth2 refresh + paginated v2 fetch; credentials from
> `WHOOP_CLIENT_ID`/`WHOOP_CLIENT_SECRET` env vars + a `0600` refresh-token sidecar, no
> keychain) used by the on-demand `agent-bober medical whoop sync [--since <iso>]` command,
> which persists WHOOP recovery/sleep/cycle/workout into the medical health store
> (idempotent, fail-closed). The three axes are **independent** — enabling one never
> enables another. See
> [docs/teams.md](./docs/teams.md) ("EgressGuard + full SOP wiring", "MedlinePlus
> grounded retrieval + cited synthesis", and "WHOOP device-connection axis +
> authenticated transport").

> **The synthesis/critic model is configurable, and cloud is gated by `cloudInference`.**
> The optional `medical.inference` block `{ provider?, endpoint?, model? }` overrides the
> model used for grounded synthesis **and** the grounding critic. Omit it (the default) and
> the medical team uses the **local Ollama default** (`openai-compat`,
> `http://localhost:11434/v1`, `llama3`). A **cloud** provider here (anything that is not
> `openai-compat` against a `localhost` endpoint) is honoured **only** when
> `medical.egress.cloudInference` is `true`; with the axis off (the default) the resolver
> **fails closed to the local default** and **no cloud client is ever constructed** — so the
> out-of-the-box posture still makes zero cloud egress. The critic's outcome is recorded as
> the IDs/enums-only `criticVerdict` (`approve` / `reject-abstained` / `error-abstained`)
> field on the PHI-free `0600` medical audit log. See
> [docs/teams.md](./docs/teams.md) ("Configurable model + cloud-inference gating" and
> "Critic verdict in the audit").

> **Gmail capture is opt-in and default-off.** The isolated `taskInbox.gmailEgress` axis
> (default `false`, separate from the `medical.egress` axes) gates `agent-bober task from-gmail
> <thread>`. With the axis off — the default — the command **refuses with an opt-in message,
> sets `exitCode=1`, and constructs no MCP client / makes no network call**, so the
> out-of-the-box build performs **zero Gmail egress**. The gate fires fail-closed at two
> layers (the CLI returns before constructing the connector, and the `fromGmailTask` core
> throws before `mcp.start()`/`callTool()`), a missing/invalid config resolves to disabled,
> and any connector error is caught and **sanitized** (`KEY=VALUE` env assignments stripped to
> `[redacted]`, the same regex as `src/mcp/external-client.ts`) so tokens never leak. When
> enabled (plus an enabled `observability` provider named `gmail`), one thread is read on
> demand and captured through the same `captureTask` write path as `task add`. See
> [COMMANDS.md](./COMMANDS.md) (`agent-bober task from-gmail <thread>`) and
> [docs/sprints/sprint-spec-20260628-task-inbox-6.md](./docs/sprints/sprint-spec-20260628-task-inbox-6.md).

> **Google Calendar egress is opt-in and default-off.** The isolated `calendar.egress.cloudCalendar`
> axis (default `false`, separate from the `medical`/`taskInbox` axes) gates the Sprint 3 Google
> Calendar connector. With the axis off — the default — the calendar planner uses the local-first
> `.ics` connector and makes **zero cloud egress**; any Google read/write **refuses before constructing
> the MCP client**, naming `calendar.egress.cloudCalendar`. Enabling it also requires a provisioned
> `0600` OAuth token sidecar (`.bober/calendar/google-token.json`), and only a non-sensitive
> `calendarSafeTitle` (never the full finding title, evidence, or tags) ever leaves the device as the
> event summary; connector errors are sanitized (`KEY=VALUE` stripped, same regex as
> `src/mcp/external-client.ts`) so tokens never leak. Hosted OAuth is **unfit for unattended/cron runs**,
> so scheduled use should stay on the `.ics` fallback. See [docs/calendar.md](./docs/calendar.md) and
> [docs/sprints/sprint-spec-20260628-calendar-planner-3.md](./docs/sprints/sprint-spec-20260628-calendar-planner-3.md).

> **Online research egress is opt-in and default-off.** The isolated `research.egress.onlineResearch`
> axis (default `false`, **separate** from the `medical`/`taskInbox`/`calendar` axes) gates `bober
> research run` (and `agent-bober research tick`) web retrieval. With the axis off — the default — a research run uses only its injected
> provider clients and makes **zero outbound retrieval requests**; the `ResearchEgressGuard`
> (`src/research/egress.ts`, mirroring the medical `EgressGuard`) is fail-closed (`assertAllowed` throws
> `Egress axis 'online-research' not enabled` when off), and the runner's gated branch skips retrieval
> entirely so the retrieval client is **never constructed** and the note is byte-identical to the
> offline run. Opting in threads the retrieved source URLs into the note frontmatter `sources` list. See
> [COMMANDS.md](./COMMANDS.md) (Research Commands → "Online research egress") and
> [docs/sprints/sprint-spec-20260628-research-scheduler-3.md](./docs/sprints/sprint-spec-20260628-research-scheduler-3.md).

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
  User Idea --> [Researcher] --> Research Doc (facts only)
                    |
                    v
              [Planner] --> Questions → Design Doc → Outline → Contracts
                                        |
                                        v
                                  [Curator]  (reads codebase for THIS sprint,
                                    |         produces Sprint Briefing with
                                    |         patterns, utils, impact analysis)
                                    v
                                  [Generator]  (receives briefing + contract + principles)
                                    |     ^
                                    v     | (rework feedback)
                                [Evaluator]
                                    |
                          pass? ----+---- fail?
                            |              |
                      [Documenter]   [Rework Loop]
                       (writes/updates
                        docs; advisory)
                            |
                      [Next Sprint]
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

- **Researcher** (default: Claude Opus): Two isolated context windows. Phase 1 generates exploration questions from the feature description. Phase 2 explores the codebase using ONLY those questions -- no feature knowledge, producing a fact-only research document. This prevents the planner from hallucinating patterns that don't exist.
- **Planner** (default: Claude Opus): Receives the research doc, generates mandatory clarification questions (self-answers in autonomous mode with codebase evidence), produces a design discussion doc for alignment, then a structure outline enforcing vertical slice decomposition, and finally sprint contracts.
- **Curator** (default: Claude Opus): Read-only codebase analysis scoped to a single sprint. For each sprint contract, reads the target files, extracts relevant code sections, inventories existing utilities the generator must reuse, identifies affected files and tests, gathers testing patterns, and produces a structured Sprint Briefing saved to `.bober/briefings/`. Runs once per sprint before the generator. Configurable via `curator` section in config.
- **Generator** (default: Claude Sonnet): Full tool access (`bash`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`). Receives the Sprint Briefing (curated patterns, utils, impact analysis) plus the sprint contract and principles -- no research, design, or outline artifacts (context distillation). Starts coding immediately instead of exploring the codebase.
- **Evaluator** (default: Claude Sonnet): Read-only + bash tools (`bash`, `read_file`, `glob`, `grep` -- deliberately NO write/edit). Independently verifies by running the dev server, taking Playwright screenshots, executing tests, and inspecting code. Cannot fix bugs -- only report them with precise feedback.
- **Documenter** (default: Claude Sonnet): Spawned after a sprint's evaluator returns PASS, while the change is fresh. Writes a concise record of what the sprint built and finds & updates the existing docs that are now stale (README, ADRs, CLAUDE.md, module docs). Documentation only -- never touches application code or tests, and its result is **advisory**: a documenter failure or timeout never downgrades the already-passed sprint. On by default; configurable via the `documenter` section (set `enabled: false` to skip).

Beyond the build pipeline, agent-bober ships a set of **operations subagents** for the incident lifecycle (invoked via `/bober-incident`, `/bober-diagnose`, `/bober-deploy`, `/bober-runbook`, and `/bober-postmortem`). Like every pipeline agent they run through the same provider-agnostic `LLMClient` layer, so they honour whatever provider you configure (Anthropic, DeepSeek, or any OpenAI-compatible endpoint):

- **Diagnoser** (default: Claude Sonnet): Read-only incident investigator. Gathers evidence at component boundaries and forms hypotheses with both supporting AND contradicting evidence, emitting a structured DiagnosisResult -- never writes code, never deploys.
- **Deployer** (default: Claude Sonnet): Executes a remediation action classified by blast radius. Risky actions are gated behind a Tier 2 checkpoint, and a ChangeEntry with a required inverse is recorded BEFORE execution.
- **Postmortemer** (default: Claude Sonnet): Read-only synthesizer that turns the incident's recorded artifacts into an evidence-cited postmortem -- chronological timeline, 5-Whys, contributing factors, and action items. Pure offline synthesis, no live observability access.

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
  research/        Research documents (fact-only codebase analysis)
  architecture/    Architecture documents and ADRs (optional architect phase)
  designs/         Design discussion documents
  outlines/        Structure outlines (vertical slice decomposition)
  briefings/       Sprint Briefings (curated codebase context per sprint)
  eval-results/    Evaluation result logs
  handoffs/        Context handoff documents
  memory/          Self-improvement memory (per-team namespaced)
    INDEX.md         Distilled lessons index (planner-read)
    QUARANTINE.md    Pruned/contradictory lessons (moved, never deleted)
    facts.db         Bi-temporal SQLite semantic-facts store (auto-produced, planner-read)
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

See [AGENTS.md](./AGENTS.md) for contributor discipline including the anti-slop pre-PR checklist.

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
    state/            State management for .bober/ directory (research, design, outline artifacts)
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
