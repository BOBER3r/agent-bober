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

Run the planner. Produces a PlanSpec **and** eagerly materializes its sprint contracts into
`.bober/contracts/` (one schema-valid `sprint-<specId>-NN.json` per sprint), so a following
`bober sprint` finds them immediately — the standalone `plan` → `sprint` flow works
end-to-end with no full `run`.

```bash
bober plan "Add CSV export to the users table page"
# → writes .bober/specs/<specId>.json AND .bober/contracts/sprint-<specId>-NN.json
# → prints: Next: npx agent-bober sprint
```

Re-planning the same feature **clears that spec's prior contracts first**, so stale
higher-numbered files do not accumulate (other specs' contracts are left untouched).

If the planner needs more information, it emits `status: needs-clarification` and surfaces
questions — **no contracts are written yet**. Resolve them with:

```bash
bober plan answer <specId>                            # Interactive resolution
bober plan answer <specId> <questionId> "my answer"   # Single-question resolution
```

After the last question is answered, the spec auto-promotes to `ready`, contracts are
materialized at that point, and the command prints `Next: npx agent-bober sprint`.

---

### `bober sprint`

Execute the next pending sprint contract (generator + evaluator loop). It consumes the
contract files that `bober plan` materialized into `.bober/contracts/`.

```bash
bober sprint
```

Runs one sprint: curator reads the codebase for context, generator writes code, evaluator
verifies. On failure, the generator reworks up to `evaluator.maxIterations` times.

`sprint` always acts on the **active** (latest) plan only: it selects contracts whose
`specId` matches the latest spec, so older specs' contracts left on disk are ignored. If
the latest plan is still `needs-clarification`, `sprint` refuses to run — it prints the open
questions and the resolution hint
(`npx agent-bober plan answer <specId> <questionId> "<answer>"`) and spawns **no** generator.
If no contract matches the active plan, the error points you at `plan` (to re-materialize
contracts) or `run` (the full pipeline).

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
bober run "feature" --run-id my-run-123             # Use a caller-supplied run identifier
bober run "feature" --approve-gates post-research,post-plan,post-sprint   # Gate only these checkpoints (disk)
```

`--run-id <id>` makes the pipeline use the supplied identifier instead of self-generating
`run-<timestamp>` — the roster state and completion marker (`.bober/runs/<id>.completed.json`)
are keyed on it. Additive and optional; omitting it preserves the default behavior. This is
how `bober chat` launches detached runs with a session-chosen id.

`--approve-gates <comma-list>` turns on **disk** checkpoints for only the named gates for
that run — it merges `{ gate -> 'disk' }` into `checkpointOverrides` without setting
`--mode careful`, so just the listed sites pause. Valid gate names are the declared
checkpoint sites: `post-research`, `post-plan`, `post-sprint-contract`, `pre-curator`,
`pre-generator`, `pre-evaluator`, `pre-code-reviewer`, `post-sprint`, `end-of-pipeline`.
An unknown gate name is rejected with a clear error and no partial merge. Additive and
optional; this is how `bober chat`'s careful mode launches a gated run.

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
> build a settings page        # spawns a detached `bober run`, returns immediately
> what runs are active?         # answered using roster + memory context
> stop the settings page run    # natural language → stops the matching running run
> /runs                         # list active/recent runs (deterministic, no LLM call)
> /stop <runId>                 # HARD stop: kill the run's process by id (deterministic, no LLM call)
> /pause <runId>                # SOFT pause: hold at next boundary, process stays alive (deterministic)
> /resume <runId>               # resume a soft-paused run (deterministic, no LLM call)
> /careful [on|off]             # toggle approval gates for new runs (deterministic, no LLM call)
> /approve <id>                 # approve a pending checkpoint, resume the run (deterministic)
> /reject <id> [feedback]       # reject a pending checkpoint with optional feedback (deterministic)
> /tell <runId> <text>          # queue free-text guidance for a run, applied at its next boundary (deterministic)
> /help                         # show slash commands
> /exit                         # end the session (detached runs keep going)
```

The full deterministic slash-command set is `/runs`, `/stop <runId>`, `/pause <runId>`,
`/resume <runId>`, `/careful [on|off]`, `/approve <id>`, `/reject <id> [feedback]`,
`/tell <runId> <text>`, `/help`, and `/exit` — none of them call the LLM.

`/careful on` makes runs you launch from chat pause at curated gates; `/careful off` (the
default) launches them in autopilot. With careful **on**, the detached run is launched with
`--approve-gates post-research,post-plan,post-sprint`, so those checkpoints write pending
markers under `.bober/approvals/`. With careful **off**, the spawn is byte-for-byte
identical to autopilot. The flag is persisted per session at
`.bober/chat/<sessionId>.careful.json` and takes effect on the next run you launch;
`/careful` with no argument reports the current state.

When a careful run pauses at a gate (writing a `.bober/approvals/<checkpointId>.pending.json`
marker), the **next** chat turn weaves a one-time `[run <id> waiting at <gate>: <prompt>]`
notice into its reply, and `/runs` shows that run as `[INPUT-REQUIRED]` with a
`waiting=<checkpointId>` segment. The notice is deduped per marker (keyed by
`checkpointId@requestedAt`), so a still-pending run is announced once, not on every turn; the
dedupe state persists across a REPL restart via `.bober/chat/<sessionId>.approvals-cursor.json`.

**Resolving a paused gate from chat.** You can approve or reject a surfaced checkpoint without
leaving the REPL. `/approve <checkpointId>` writes the `.approved.json` marker and acks
resumption; `/reject <checkpointId> [feedback]` writes the `.rejected.json` marker, where
**everything after the id is the feedback string** (it flows into the pipeline's rework round).
Natural language works too — "approve it" / "reject the plan, too broad" is classified to the
same handlers. If a paused checkpoint id does not actually exist, chat replies
`No pending checkpoint found: <id>` and **writes nothing** (the `pendingExists` guard); when an
NL approve/reject names no checkpoint and several are pending, chat asks which one rather than
guessing. Resolution writes the same `.approved.json` / `.rejected.json` markers as the
`bober approve` / `bober reject` CLI below (the same store, not a separate one), so the
detached run resumes via its existing disk poll and the chat-owned `RunState` flips back to
`running` on the next turn. The CLI commands remain available for resolving runs from outside a
chat session.

**Steering a run with free-text guidance.** Beyond approve/reject, you can feed a run
advisory guidance without leaving the REPL. `/tell <runId> <text>` queues the text
(everything after the runId, spacing preserved) onto that run's guidance channel at
`.bober/runs/<runId>/guidance.jsonl`; natural language works too ("tell run X to prefer
Zod"). An unknown runId replies `No such run: <runId>` and **writes nothing**, and a runId
containing path separators or `..` is rejected before any write. Guidance is **queued, not
pushed** — the detached run drains it at its **next** sprint boundary (the pre-generator
read point) and injects each line into the generator's handoff as a `Human guidance: <text>`
entry; it never interrupts an in-flight agent call, never edits files or overrides the
contract, and does **not** require careful mode. Each queued line is consumed exactly once.

**Soft-pausing a run.** `/pause <runId>` is a **soft** suspend, distinct from the hard
`/stop` below: it sends **no kill signal** — the run's process stays alive. It writes a
`runId`-keyed marker at `.bober/runs/<runId>/paused.json` and flips the chat-owned
`RunState` to `paused`; the detached run's pipeline holds at its **next** checkpoint boundary
(the same boundary cluster as guidance) while the marker is present, rather than freezing any
in-flight agent call. `/resume <runId>` removes the marker and flips `RunState` back to
`running`, and the run advances. Natural language works too ("pause that run" / "resume run
X"). `/pause` on an unknown or non-`running` run replies `No such running run: <runId>` and
**writes nothing**. The pause poll is bounded (a forgotten marker resolves after a timeout
rather than hanging the run forever). Contrast with `/stop`, which **kills** the process and
ends the run — use `/pause` when you want to hold and continue, `/stop` when you want to abort.

Asking the session to build something **spawns a detached `bober run`** keyed on a
session-chosen `--run-id`; it survives the REPL exiting and shows up under `/runs` as
`running` the same turn. When such a run finishes, the **next** chat turn weaves a
`[run <id> finished: <phase>]` notice into its reply. Completion notices surface on the
next turn only (no live between-turn push); they are deduped by `runId` and that dedupe
state persists across a REPL restart via `.bober/chat/<sessionId>.cursor.json`, so a run is
announced exactly once. The notice is rotation-safe — it still fires correctly if
`.bober/history.jsonl` was rotated or truncated between turns.

**Steering runs.** You can stop a run two ways, both deterministic (no LLM call):
the `/stop <runId>` slash command, or natural language ("stop the settings page run")
which the classifier routes to the same handler. Stop is a real **hard** stop — distinct
from the soft `/pause` above — it resolves the child PID recorded for this session, sends it
`SIGTERM`, and flips the run's roster `state.json` to `aborted` on disk (the run ends; use
`/pause` instead if you only want to hold and resume later). The runId is resolved against the **current disk roster
at stop-time**, so an id that is not a `running` run replies `No such running run: <id>`
and nothing is killed; chat can only ever kill a PID it spawned this session. If the run is
on disk but its PID is unknown, it is marked `aborted` without a kill. Asking to inspect runs
in natural language returns the same roster summary as `/runs`.

The `[team]` argument is accepted but ignored in Phase 1. The provider/model is
resolved from the `chat` role in `bober.config.json` (defaults to `opus` on
`anthropic`; override with e.g. `{ "chat": { "provider": "deepseek", "model": "deepseek-chat" } }`).

---

## Fleet Commands

The fleet orchestrator runs **N isolated `agent-bober` child runs in bulk** from a manifest.
A manifest is a JSON file describing a `rootDir`, a `concurrency`, and a list of `children`,
each `{ "folder", "task" }` (children may carry an optional per-child `config` and an optional
per-child `tier`). A manifest may also carry an optional top-level `blackboard` block to opt the
run into the cross-child blackboard (see "Inter-child blackboard" below). These commands are
invoked as `agent-bober …` (not `bober …`).

### `agent-bober fleet <manifest>`

Run a fleet of child agent-bober runs from a prepared manifest. Each child runs in its own
`<rootDir>/<folder>` directory against its `task`. Per-child failures are **reported, not
fatal** (the command still exits `0`); exit `1` is reserved for batch-setup errors (bad
manifest, missing credentials, report IO failure). Prints a Fleet Summary (total / completed /
failed / other) when done.

```bash
agent-bober fleet ./fleet.json
agent-bober fleet ./fleet.json --concurrency 4    # Override manifest concurrency
agent-bober fleet ./fleet.json --root ./projects  # Override manifest rootDir
```

A manifest looks like:

```json
{
  "rootDir": ".",
  "concurrency": 3,
  "children": [
    { "folder": "api-server", "task": "Build a REST API server with auth" },
    { "folder": "web-frontend", "task": "Build a React frontend for the API" }
  ]
}
```

#### Per-child difficulty tier (optional)

Each child may carry an optional `tier` that routes its three roles (planner,
generator, evaluator) onto a provider block. A child with **no `tier`** (or `tier:
"default"`) runs exactly as before — the **DeepSeek default**, byte-for-byte unchanged:

```json
{
  "rootDir": ".",
  "concurrency": 3,
  "children": [
    { "folder": "api-server",  "task": "Build a REST API server with auth" },
    { "folder": "web-frontend", "task": "Build a React frontend", "tier": "standard" },
    { "folder": "billing",     "task": "Implement Stripe billing", "tier": "frontier" }
  ]
}
```

The `tier` value is a closed enum — anything outside it is rejected when the manifest
is parsed:

| `tier` | Provider | Model | Endpoint |
|---|---|---|---|
| `default` (or omitted) | — *(no overlay)* | — | DeepSeek default, unchanged |
| `cheap` | `openai-compat` | `deepseek` | `https://api.deepseek.com` |
| `standard` | `openai-compat` | `grok` | `https://api.x.ai/v1` *(Grok / xAI)* |
| `hard` | `anthropic` | `sonnet` | *(default)* |
| `frontier` | `anthropic` | `opus` | *(default)* |

Notes:

- All three roles of a tiered child get the **same** provider block.
- A child's explicit `config` still **wins** over the tier — the tier is applied
  first, then `config` shallow-merges over it. So `{ "tier": "standard", "config": {
  "generator": { "provider": "anthropic", "model": "sonnet" } } }` puts the generator
  on Anthropic and the planner/evaluator on Grok.
- `claude-code` is **never** a tier — it is reserved for the head/orchestrator, never a
  fleet child role. Tiers only name LLM providers. A builder child (`curator` /
  `generator` / `evaluator` / `codeReview`) **must** use an api-key provider
  (`anthropic` / `openai-compat`): if a child's `config` places `claude-code` on one of
  those tool roles, `agent-bober fleet` **rejects the manifest at launch, before any
  child is spawned**, naming the offending child and role.
- The non-DeepSeek tiers need the matching key in the environment: `standard` needs
  `XAI_API_KEY`, `hard` / `frontier` need `ANTHROPIC_API_KEY` (and `cheap` / default
  need `DEEPSEEK_API_KEY`). The model ids are config-overridable per role.

### `agent-bober fleet expand <goal>`

Decompose a single high-level **goal** into a fleet manifest using a DeepSeek decomposer, then
**write it and stop for review by default**. It builds the decomposer LLM client first (so a
missing `DEEPSEEK_API_KEY` fails fast with exit `1` **before any file is written**), turns the
goal into a children-only manifest, atomically writes it to `<root>/.bober/fleet-expand.json`
(overwriting any existing file with a printed notice), prints the manifest, and prints a review
hint. It does **not** run the fleet unless you pass `--yes`.

```bash
# Decompose → write manifest → STOP for review (default)
agent-bober fleet expand "Build a todo app with an API server and a web frontend"

#   …writes <root>/.bober/fleet-expand.json and prints:
#   Review then run: agent-bober fleet "<root>/.bober/fleet-expand.json"

# Review/edit the written manifest, then run it with the runner above:
agent-bober fleet ".bober/fleet-expand.json"

# …or decompose AND run immediately, skipping the review gate:
agent-bober fleet expand "Build a todo app …" --yes
```

`--yes` is the **sole** spawn gate — without it, `fleet expand` writes the manifest and exits
`0` without launching any child runs (no interactive prompt, no TTY check). With `--yes` it
chains into `agent-bober fleet <writtenPath>` after the write and prints the same Fleet Summary.

**Provenance sidecar + recoverable overwrite.** Alongside the manifest, `fleet expand` writes a
provenance sidecar `<outPath>.meta.json` recording `{ command, goal, critique, childCount,
timestamp }` for the manifest it just produced. If a manifest already exists at the output path,
the **prior manifest is preserved as `<outPath>.bak`** (renamed before the new one is written, so
it is fully recoverable) and an **informative, non-blocking notice** is printed — when the prior
sidecar is present it reports which command/goal/childCount produced the old manifest and its
relative age (e.g. `Replacing manifest from \`fleet expand\` for goal "…" (4 children, 12m ago) →
kept as fleet-expand.json.bak`); otherwise a generic `Overwriting existing manifest … → kept as
…bak` notice. The sidecar and `.bak` derive from the **actual** output path, so `--out <custom>`
writes `<custom>.meta.json` / `<custom>.bak` and leaves the default path untouched. This applies
to **both** `fleet expand` and `fleet expand-deep`, which share the same default output path
(unchanged) — the overwrite is now recoverable rather than silently clobbering.

Options:

| Option | Default | Purpose |
|--------|---------|---------|
| `--count <n>` | — | Soft target for the number of sub-projects (folded into the decomposer prompt as a hint, not a hard cap) |
| `--provider <p>` | `openai-compat` | Override the decomposer LLM provider |
| `--model <m>` | `deepseek-v4-pro` | Override the decomposer LLM model **only** (not the children's per-run providers) |
| `--root <dir>` | `.` | Manifest `rootDir` |
| `--concurrency <c>` | `3` | Manifest concurrency |
| `--out <path>` | `<root>/.bober/fleet-expand.json` | Override the output path for the written manifest (the `.meta.json` sidecar and `.bak` backup derive from this path) |
| `--yes` | off | Chain into the fleet run after writing the manifest |

Requires `DEEPSEEK_API_KEY` (see [Environment Variables](#environment-variables)) — the
decomposition step calls DeepSeek via the `openai-compat` provider.

### `agent-bober fleet expand-deep <goal>`

The **robust** sibling of `fleet expand` for **large or ambiguous goals**. Where `fleet expand`
makes a single decomposer pass (and can yield one giant low-quality child on a sprawling goal),
`fleet expand-deep` uses a **two-stage plan-then-expand** decomposer: it first plans a coarse
outline of independent sub-project *areas*, then expands that outline into the children-only
manifest. Everything else is identical to `fleet expand` — same options, same default output
path, same atomic write, same **write-and-stop-by-default** review gate, and the same
**provenance sidecar + recoverable overwrite** (see `fleet expand` above). It builds the
decomposer LLM client first (so a missing `DEEPSEEK_API_KEY` fails fast with exit `1` **before any
file is written**), atomically writes the manifest to `<root>/.bober/fleet-expand.json` plus a
`<outPath>.meta.json` provenance sidecar (here `command` is `"fleet expand-deep"` and `critique`
reflects `--critique`). Because it **shares** the same default path as `fleet expand`, overwriting
a manifest there preserves the **prior** file as `<outPath>.bak` and prints an informative notice
(use `--out` to keep both manifests side by side instead). It prints the manifest, and prints a
review hint. It does **not** run the fleet unless you pass `--yes`.

```bash
# Robustly decompose a large/ambiguous goal → write manifest → STOP for review (default)
agent-bober fleet expand-deep "Build a multi-tenant SaaS platform with billing, auth, and an admin console"

#   …writes <root>/.bober/fleet-expand.json and prints:
#   Review then run: agent-bober fleet "<root>/.bober/fleet-expand.json"

# Review/edit the written manifest, then run it with the runner above:
agent-bober fleet ".bober/fleet-expand.json"

# …or decompose AND run immediately, skipping the review gate:
agent-bober fleet expand-deep "Build a multi-tenant SaaS platform …" --yes
```

`--yes` is the **sole** spawn gate — without it, `fleet expand-deep` writes the manifest and exits
`0` without launching any child runs (no interactive prompt, no TTY check). With `--yes` it
chains into `agent-bober fleet <writtenPath>` after the write and prints the same Fleet Summary.

`--critique` (opt-in, **default off**) adds a **fresh-context critic gate** to the decomposition.
With it, after the two-stage decompose produces a shape-valid manifest a **fresh LLM critic**
(no memory of the original decompose) judges whether the split is degenerate or under-expanded
(e.g. 2 children for a 12-area goal); on a reject verdict the manifest is **re-expanded** with the
critic's feedback. The gate is bounded to **one round** with a closed-form budget of
`DEEP_CRITIQUE_MAX_TOTAL_CALLS = 8` chat calls and **accepts-best on exhaustion** (it never throws
and never returns a result worse than the plain `expand-deep` baseline). The gate runs **after**
the manifest is built and **before** it is written, so everything downstream is unchanged —
**write-and-stop is untouched** (the manifest is still written to disk and reviewed before any
spawn, and `--yes` is still the sole spawn gate). With `--critique` omitted the command is
**byte-identical to plain `fleet expand-deep`** (no critic call, no extra chat calls).

```bash
# Add the fresh-context critic gate (re-expands a degenerate/under-expanded manifest):
agent-bober fleet expand-deep "Build a multi-tenant SaaS platform …" --critique
```

Options:

| Option | Default | Purpose |
|--------|---------|---------|
| `--count <n>` | — | Soft target for the number of sub-projects (folded into the decomposer prompt as a hint, not a hard cap) |
| `--provider <p>` | `openai-compat` | Override the decomposer LLM provider |
| `--model <m>` | `deepseek-v4-pro` | Override the decomposer LLM model **only** (not the children's per-run providers) |
| `--root <dir>` | `.` | Manifest `rootDir` |
| `--concurrency <c>` | `3` | Manifest concurrency |
| `--out <path>` | `<root>/.bober/fleet-expand.json` | Override the output path for the written manifest (the `.meta.json` sidecar and `.bak` backup derive from this path) |
| `--yes` | off | Chain into the fleet run after writing the manifest |
| `--critique` | off | Run a fresh-context critic gate that re-expands a degenerate/under-expanded manifest (one round, budget `DEEP_CRITIQUE_MAX_TOTAL_CALLS=8`, accept-best on exhaustion; write-and-stop unchanged). Default off is byte-identical to plain `expand-deep`. |

Requires `DEEPSEEK_API_KEY` (see [Environment Variables](#environment-variables)) — the
decomposition step calls DeepSeek via the `openai-compat` provider.

**`expand` vs `expand-deep`:** prefer `fleet expand` for small/clear goals (one fast pass);
reach for `fleet expand-deep` when the goal is broad or vague and the single-shot pass produces a
poor split. Both write the same manifest format and feed the same `agent-bober fleet <manifest>`
runner. The `--critique` self-judged gate is available on `fleet expand-deep` only.

### Inter-child blackboard (Phase B)

A fleet run can opt into a **bounded inter-agent blackboard** — a single shared `facts.db` (opened
in WAL mode) by which the isolated children publish and read each other's findings. Add an optional
top-level `blackboard` block to the manifest:

```jsonc
{
  "rootDir": ".",
  "concurrency": 3,
  "blackboard": {
    "namespace": "fleet-run-123",   // Required. Scopes all findings for this run.
    "maxRounds": 3                   // Optional. Exchange rounds, 1–3, default 3 (hard-capped at 3).
  },
  "children": [
    { "folder": "api-server",  "task": "Build a REST API server with auth" },
    { "folder": "web-frontend", "task": "Build a React frontend for the API" }
  ]
}
```

When a `blackboard` block is present, the head resolves **one absolute** shared db path —
`<rootDir>/.bober/memory/<namespace>/facts.db` — and writes it verbatim into each child's
`bober.config.json` (a child-internal `fleet` section). Children, running in separate working
directories, all open that **same** absolute path, so they share one blackboard. With **no**
`blackboard` block the manifest behaves exactly as before and the children's configs are
byte-identical to a non-blackboard run.

**Bounded rounds + early-stop.** With a `blackboard` block, `agent-bober fleet` runs the children
for **up to `maxRounds` rounds** over that one shared blackboard, instead of the single pass a
no-blackboard run does. The head scaffolds each child's config **once** (on round 1) and **re-spawns
`agent-bober run` every round** — re-spawning is how a child gets to *read* the prior round's
siblings' findings (via `agent-bober blackboard read`) before its next attempt. After each round the
head counts the findings on the blackboard and **stops early** the moment a completed round adds
**zero new findings** (so a converged run finishes in fewer than `maxRounds` rounds; the loop always
runs at least 2 rounds before it can early-stop). Round 1's config is never re-written on later
rounds, the run still exits `0` on per-child failures, and `fleet-report.json` is written from the
**final** round's outcomes. With **no** `blackboard` block the run is a single pass, byte-for-byte
as before.

**Synthesis artifact (`fleet-synthesis.json`).** On a blackboard run only, after the unchanged
`fleet-report.json` write, the head also writes a second file `<rootDir>/.bober/fleet-synthesis.json`
— a **pure data bundle** for the head / dynamic-workflow to synthesize over. `agent-bober` itself
**does not synthesize**; it only collects the bundle. The file is the JSON serialization of:

```jsonc
{
  "rounds": 3,                  // the number of rounds actually executed (≤ maxRounds; lower if the run early-stopped)
  "childResults": { /* … */ },  // the same PortfolioReport written to fleet-report.json
  "findings": [ /* … */ ]       // every finding on the blackboard (FactRecord[], from readAll())
}
```

With **no** `blackboard` block, **no** `fleet-synthesis.json` is written and the run output is
byte-for-byte identical to a non-blackboard fleet. `rounds` is the **real executed round count** —
it equals `maxRounds` on a full run and is **lower** when the run early-stops (e.g. `2` when a
`maxRounds: 3` run converges and stops at round 2). On a blackboard run the **same** count also
appears as an optional top-level `rounds` field on `fleet-report.json` (it equals
`fleet-synthesis.json.rounds`); a no-blackboard `fleet-report.json` has **no** `rounds` key, so it
stays byte-for-byte identical to a non-blackboard fleet.

#### `agent-bober blackboard publish <value> [--round N]`

Publish a finding to the shared fleet blackboard. Run from inside a child's working directory (its
`bober.config.json` must carry the head-injected `fleet` section). The finding is published under
this child's subject (its folder name); `--round` defaults to `1`.

```bash
agent-bober blackboard publish "auth bug is in token refresh"
agent-bober blackboard publish "retrying with backoff fixed it" --round 2
```

#### `agent-bober blackboard read [--all]`

Print findings from the shared fleet blackboard, one `[<subject>] <value>` line each. By default it
prints **siblings'** findings (every child except this one); `--all` prints every child's findings.

```bash
agent-bober blackboard read          # siblings only
agent-bober blackboard read --all    # all children's findings
```

Both subcommands read the shared db path from the child's `config.fleet` section **only** (never
re-derived from the cwd). If the current directory's `bober.config.json` has **no** `fleet` section
— i.e. it is not part of a blackboard fleet run — both print a clear message and exit `1` (they
never throw). An empty read prints nothing and exits `0`.

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

## Medical Team Commands

Utilities for the built-in `medical` team (Phase 6). See
[docs/teams.md](./docs/teams.md) for the medical SOP and data model.

### `bober medical import <file>`

Stream-import a health export file into the medical health store
(`.bober/medical/health.db`).

```bash
bober medical import ~/apple_health_export/export.xml
```

Currently supports the Apple Health `export.xml` format, stream-parsed via SAX in
bounded batches so the whole (potentially multi-GB) file is never loaded into
memory. On completion it prints `records parsed` and `new rows`. Re-importing the
same file is **idempotent** — the store dedups on a deterministic id, so the second
run reports `new rows: 0`. An unsupported file type exits non-zero with a clear
message naming the file.

### `bober medical import-labs <pdf>`

Parse a lab-report PDF and ingest its results into the medical health store. Each parsed
marker is written as a markdown-with-frontmatter note in the canonical vault and reindexed
into `.bober/medical/health.db`.

```bash
bober medical import-labs ~/labs/cbc-2026-06-01.pdf
bober medical import-labs ~/labs/cbc-2026-06-01.pdf --vault ~/health-vault   # custom note dir
```

Requires the `cloud-inference` egress axis to be enabled
(`medical.egress.cloudInference: true`, **default false**) — the PDF is parsed by a cloud
model. With the axis **off (the default)** the command prints a clear message naming
`medical.egress.cloudInference`, exits non-zero, and reads **no PDF bytes** and builds **no
inference client** — it is **fail-closed and ships nothing to cloud by default**. With the
axis on it prints `records parsed` and `new rows`. Re-importing the same report is
**idempotent** — the derived index dedups on a deterministic id, so the second run reports
`new rows: 0`. `--vault <dir>` overrides the note directory (default: under
`.bober/medical`).

### `bober medical whoop sync [--since <iso>]`

Pull WHOOP `recovery` / `sleep` / `cycle` / `workout` records over a window and write
them into the same medical health store (`.bober/medical/health.db`). This is the
**on-demand networked** device-connection path (no webhooks); `medical import` is the
offline file-import path.

```bash
bober medical whoop sync                                  # last 7 days (default window)
bober medical whoop sync --since 2026-06-01T00:00:00Z     # custom window start
```

Requires the `device-connection` egress axis to be enabled
(`medical.egress.deviceConnection: true`, **default false**) plus `WHOOP_CLIENT_ID` /
`WHOOP_CLIENT_SECRET` env vars and a stored refresh token in
`.bober/medical/whoop-token.json`. With the axis off, or with credentials/token missing,
it prints a clear message and exits non-zero **without** making any network call — it
never throws. On success it prints `records parsed` and `new rows`. Syncing is
**idempotent** (the store dedups on a content-derived id, so a re-run over an overlapping
window reports `new rows: 0`) and **fail-closed** (a mid-sync failure leaves already-
written rows intact and is recovered by re-running).

---

## Vault Commands

Utilities for the domain-agnostic **vault storage layer**, where an Obsidian vault
(markdown + YAML frontmatter) is the canonical source of truth and the FactStore is a
derived, rebuildable index over note frontmatter.

### `bober vault reindex --scope <domain> [--vault <dir>]`

Walk a vault directory, parse every note, and rebuild the derived FactStore at the active
team's namespace memory path from the notes' frontmatter.

```bash
bober vault reindex --scope medical --vault ./kb-medical
bober vault reindex --scope finance                     # --vault defaults to the project root
```

`--scope` is **required** (the fact scope label, e.g. `medical`, `finance`); `--vault` is
optional and **defaults to the project root**. The command resolves the **same `facts.db`**
that `bober facts` uses (the team/namespace memory path) and writes through the existing
reconcile-at-ingest path, so the FactStore stays a rebuildable projection of the markdown:
re-running over unchanged notes changes nothing (every fact is unchanged), a changed
frontmatter value supersedes the prior fact, and a note flagged `status: superseded`
contributes no active facts. On completion it prints `notes parsed`, `facts added`,
`facts superseded`, and `facts unchanged`. The command is **read-only over the vault** (it
never mutates notes or touches git); a missing/invalid `--vault` directory prints a clear
red message and exits non-zero **without throwing**, and the store is always closed.

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
