# agent-bober CLI Reference

Complete reference for all `bober` CLI commands. For conceptual context on operating modes, see
[VISION.md](./VISION.md). For contributor discipline and PR requirements, see [AGENTS.md](./AGENTS.md).

Install globally or use with npx:

```bash
npm install -g agent-bober
# or
npx agent-bober <command>
```

---

## Core Pipeline Commands

### `bober init [preset]`

Initialize a project. Creates `bober.config.json` and the `.bober/` directory.

```bash
bober init                    # Interactive setup (picks provider, preset)
bober init nextjs             # Next.js full-stack (App Router, Prisma)
bober init react-vite         # React + Vite
bober init solidity           # EVM smart contracts (Hardhat)
bober init anchor             # Solana programs (Anchor)
bober init api-node           # Node.js API
bober init python-api         # Python API (FastAPI)
bober init brownfield         # Existing codebase — triggers auto-discovery
```

Brownfield auto-discovers your tech stack, commit message format, test patterns, and generates
`.bober/principles.md` and evaluator strategies from your actual commands.

---

### `bober update`

Refresh the project's installed Claude Code slash commands (`.claude/commands/`) and agent
definitions (`.claude/agents/`) from the currently-installed `agent-bober` package. Run it after
upgrading the package so a project picks up new/changed commands and agents.

```bash
npm i -g agent-bober@latest    # upgrade the CLI/engine first
bober update                   # then, inside the project, refresh .claude/
```

Non-destructive: it re-emits only `.claude/commands/` and `.claude/agents/`, respecting the
project's recorded `mode`/`preset`. It never touches `bober.config.json`, `.bober/` state, or
`.gitignore`. Errors (exit 1) if no `bober.config.json` exists — run `bober init` first.

> Claude Code **plugin** users (installed via `/plugin marketplace add`) update with
> `/plugin update bober` instead — the plugin tracks the GitHub repo, not the npm package.

---

### `bober plan "feature"`

Run the planner. Produces a PlanSpec with sprint contracts.

```bash
bober plan "Add CSV export to the users table page"
```

If the planner needs more information, it emits `status: needs-clarification` and surfaces
questions. Resolve them with:

```bash
bober plan answer <specId>                            # Interactive resolution
bober plan answer <specId> <questionId> "my answer"   # Single-question resolution
```

After the last question is answered, the spec auto-promotes to `ready` and the pipeline proceeds.

---

### `bober sprint`

Execute the next pending sprint contract (generator + evaluator loop).

```bash
bober sprint
```

Runs one sprint: curator reads the codebase for context, generator writes code, evaluator
verifies. On failure, the generator reworks up to `evaluator.maxIterations` times.

---

### `bober eval`

Evaluate the current sprint output independently (without running the generator).

```bash
bober eval
```

Useful for re-evaluating after a manual fix.

---

### `bober run "feature"`

Full autonomous pipeline: research → plan → sprint → eval loop for all sprints.

```bash
bober run "Build a dashboard with auth and charts"
bober run "feature" --mode careful                  # Careful-flow mode
bober run "feature" --mode autopilot                # Explicit autopilot (default)
bober run "feature" --checkpoint disk               # Disk checkpoints
bober run "feature" --checkpoint pr                 # GitHub PR checkpoints
bober run "feature" --checkpoint cli                # stdin confirmation
bober run "feature" --checkpoint noop               # No checkpoints (explicit)
bober run "feature" --checkpoint-all                # Apply mechanism to ALL checkpoints
bober run "feature" --provider openai               # Override provider for all agents
```

`--mode` and `--checkpoint` flags override `bober.config.json` for the duration of the run.
See [VISION.md](./VISION.md) for a full explanation of modes.

---

### `bober mcp`

Start the MCP server for use in Cursor, Windsurf, or any MCP-compatible IDE.

```bash
bober mcp
```

---

### `bober chat [team]`

Start an interactive chat REPL. Each turn is answered with awareness of the
on-disk run roster and the `.bober/memory/` lesson distill. Conversation persists
to `.bober/chat/default.jsonl` and resumes on the next launch.

```bash
bober chat                # start an interactive session
```

Inside the session:

```
> what runs are active?   # answered using roster + memory context
> /runs                   # list active/recent runs (deterministic, no LLM call)
> /help                   # show slash commands
> /exit                   # end the session
```

The `[team]` argument is accepted but ignored in Phase 1. The provider/model is
resolved from the `chat` role in `bober.config.json` (defaults to `opus` on
`anthropic`; override with e.g. `{ "chat": { "provider": "deepseek", "model": "deepseek-chat" } }`).
Spawn and steer actions are acknowledged but not yet executed in this version.

---

## Approval & Checkpoint Commands

These commands manage checkpoint approval in careful-flow mode. Checkpoints appear as
`.bober/approvals/<checkpointId>.pending.json` files.

### `bober list-approvals`

List all pending checkpoints awaiting approval.

```bash
bober list-approvals
bober list-approvals --json     # Machine-readable JSON output
```

Output columns: checkpoint ID, age, prompt describing what is waiting.

---

### `bober approve <checkpointId>`

Approve a pending checkpoint and allow the pipeline to continue.

```bash
bober approve post-research-spec-20260524-jwt-1
bober approve post-plan-spec-20260524-jwt-1 --edit ./my-edits.md
```

`--edit <path>` reads the file and attaches its contents as `editDelta` — the planner
incorporates the edits before continuing.

---

### `bober reject <checkpointId>`

Reject a pending checkpoint. The pipeline aborts the current run.

```bash
bober reject post-plan-spec-20260524-jwt-1
```

---

### `bober audit show <runId>`

Show the immutable audit log for a pipeline run. Each log entry records a decision (approved,
rejected, auto-approved), the approver identity, and a timestamp.

```bash
bober audit show run-20260524-abc123
```

---

## Incident Response Commands

Incident response commands manage the full lifecycle of a production incident. See
[VISION.md — Mode 3: Diagnose](./VISION.md#mode-3-diagnose-incident-response) for the full workflow.

### `bober incident start <symptom>`

Create a new incident and start investigation.

```bash
bober incident start '500 errors on checkout endpoint'
bober incident start '500 errors on checkout endpoint' --severity S2
```

Severity levels: `S1` (critical), `S2` (high), `S3` (medium), `S4` (low).

Creates artifacts at `.bober/incidents/<incidentId>/`.

---

### `bober incident status <incidentId>`

Print current incident state: phase, severity, duration, latest diagnosis, action counts, and
resolution criteria.

```bash
bober incident status inc-20260524-500-errors-on-checkout
```

---

### `bober incident end <incidentId>`

Mark an incident resolved. Requires either external metric verification or an operator override.

```bash
bober incident end inc-20260524-500-errors-on-checkout --verified
bober incident end inc-20260524-500-errors-on-checkout --override "False alarm — alerting misconfiguration"
```

`--verified` asserts that resolution criteria were confirmed by external metrics.
`--override <reason>` documents an operator override with an audit trail. Both flags are optional
but exactly one is required.

If `incident.autoPostmortem` is `true` (default), postmortem synthesis fires automatically.

---

### `bober incident list`

List all incidents sorted by creation date (most recent first).

```bash
bober incident list
```

---

### `bober incident abort <incidentId>`

Abort an incident at any phase. Writes an abort marker. Optionally rolls back executed changes.

```bash
bober incident abort inc-20260524-500-errors-on-checkout \
    --reason "False alarm — wrong alert threshold"

bober incident abort inc-20260524-500-errors-on-checkout \
    --reason "Escalating to SRE" \
    --confirm-rollback    # Also rolls back executed changes
```

`--reason` is required. `--confirm-rollback` executes rollback; each step is gated as a risky action.

---

## Rollback Commands

### `bober rollback <incidentId>`

Roll back executed changes for an incident. Each step is gated as a risky action (requires
`bober approve` unless `allowAutopilotRiskyActions` is set).

```bash
bober rollback inc-20260524-500-errors-on-checkout
bober rollback inc-20260524-500-errors-on-checkout --dry-run          # Print plan without executing
bober rollback inc-20260524-500-errors-on-checkout --since <changeId> # Roll back only changes after this ID
bober rollback inc-20260524-500-errors-on-checkout --json             # Emit plan as JSON
```

---

## Postmortem Commands

Postmortem commands synthesize retrospective documents from incident artifacts. See
[VISION.md — Mode 4: Postmortem](./VISION.md#mode-4-postmortem) for the full workflow.

### `bober postmortem generate <incidentId>`

Generate (or regenerate) the postmortem document for an incident.

```bash
bober postmortem generate inc-20260524-500-errors-on-checkout
```

Output: `.bober/incidents/<incidentId>/postmortem.md`

If `incident.autoPostmortem` is `true`, this runs automatically on `bober incident end`.
Use `generate` to regenerate after adding new artifacts.

---

### `bober postmortem show <incidentId>`

Render the postmortem to stdout.

```bash
bober postmortem show inc-20260524-500-errors-on-checkout
```

---

## Playbook Commands

Playbooks are reusable incident-response runbooks stored in `.bober/playbooks/`. When an incident
is created, the diagnoser searches for matching playbooks and auto-follows them if confidence
exceeds the `HIGH_CONFIDENCE_THRESHOLD` (currently `0.6`).

### `bober playbook list`

List all available playbooks.

```bash
bober playbook list
```

---

### `bober playbook show <name>`

Show the full content of a playbook.

```bash
bober playbook show high-error-rate-api
```

---

### `bober playbook search <symptom>`

Search playbooks for ones matching a symptom description.

```bash
bober playbook search "connection pool exhausted"
```

Returns playbooks ranked by confidence score.

---

## Graph Commands

Graph commands require `graph.enabled: true` in `bober.config.json` and the
[tokensave](https://github.com/aovestdipaperino/tokensave) tool installed.

### `bober graph init`

Initialize the structural code graph index.

```bash
bober graph init
```

---

### `bober graph sync`

Re-index changed files.

```bash
bober graph sync           # Incremental sync
bober graph sync --force   # Full re-index
```

---

### `bober graph status`

Check graph status.

```bash
bober graph status
bober graph status --json  # Machine-readable JSON
```

---

### `bober graph check-prereq`

Verify that graph prerequisites (tokensave, parsers) are installed.

```bash
bober graph check-prereq
```

---

## Utility Commands

### `bober impact <target>`

Analyse the impact radius and test coverage of a symbol or file.

```bash
bober impact "UserService"
bober impact "src/auth/jwt.ts"
```

---

### `bober onboard`

Generate `.bober/onboarding/` documentation from the code graph.

```bash
bober onboard
```

---

## Environment Variables

| Variable | Provider | Purpose |
|----------|----------|---------|
| `ANTHROPIC_API_KEY` | Anthropic | Required for Anthropic provider |
| `OPENAI_API_KEY` | OpenAI | Required for OpenAI provider |
| `GOOGLE_API_KEY` or `GEMINI_API_KEY` | Google Gemini | Required for Google provider |
| `DEEPSEEK_API_KEY` | DeepSeek (openai-compat) | Required for the DeepSeek provider (also `npm install openai`) |

The `claude-code` provider requires **no** API key — it uses an active Claude subscription via the
`claude` CLI on PATH. See [docs/providers.md](./docs/providers.md).

---

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Error (see stderr) |

All commands write errors to stderr and progress to stdout.
