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
> renew passport                # plain task statement → captured as an open hub task
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

**Capturing a task.** A plain task statement — an imperative like `renew passport`,
`book dentist`, `call the bank` — is recognised by the turn classifier as a **new-task intent** and
**captured into the hub pool** as a single open `action` Finding, with the reply being a short
`Captured task: <text>` confirmation rather than an LLM answer. This is the chat front-end for
`bober task add`: it reuses the **same `captureTask` write path**, so the captured item shows up in
`bober task list`, `bober hub list`, and is eligible for `priority` / `decide` / `bober chat hub`. A
**question** ("what is X?", "how do I Y?") still routes to the answerer, and a **decision/scope
statement** ("I'm deciding between X and Y", "should I do A or B?") is **not** captured as a task — it
is answered — so prioritization phrasing is never mistaken for a to-do. Capture is deterministic and
**never throws**: a persistence failure becomes a `Failed to capture task: …` reply, not a crash, and
a malformed classifier response falls back to a normal answer turn.

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

### `bober medical supplements add <name> [--dose <d>]`

Record a supplement (a name plus an optional dose) as a fact in the medical FactStore
(the same `facts.db` that `bober facts` reads). This is **not** the lab-ingest path —
supplements are FactStore facts under the `medical` scope, not `HealthDataStore` lab
rows.

```bash
bober medical supplements add "Vitamin D" --dose "1000 IU"
bober medical supplements add Magnesium                       # dose optional (stored as "unspecified")
```

Each entry flattens into a fact with `subject = <name>`, `predicate = dose`, and the
dose as its value (the placeholder `unspecified` when `--dose` is omitted). Reconcile is
**deterministic** — no LLM, no judge, no network. Re-adding the **same name and dose** is
an **idempotent NOOP** (it prints `Supplement unchanged: <name>` and the active-fact count
does not grow); supplying a **different** dose for the same name updates the existing fact
(`Updated supplement: <name> -> <dose>`). The command never throws — on error it prints a
clear message and exits non-zero.

> Supplements deliberately use a different FactStore shape from medications. A supplement
> is `subject=<name>` / `predicate=dose` (its own subject row), whereas medications are
> `subject=patient` / `predicate=takes-medication` (the value-of-record the SOP reads).

### `bober medical supplements list [--file <path>]`

Print the supplements recorded in a markdown-frontmatter file.

```bash
bober medical supplements list
bober medical supplements list --file ~/health-vault/supplements.md   # custom file
```

`--file` defaults to `.bober/medical/supplements.md`. The file is a YAML-frontmatter list,
one `Name | dose` item per line:

```
---
supplements:
  - Vitamin D | 1000 IU
  - Magnesium | 200 mg
---
```

Each entry prints as `name: dose` (`unspecified` when no dose is given). An empty list
prints `No supplements found.`; the command never throws.

### `bober medical profile show`

Decrypt and print the personalization profile stored at `<vaultDir>/profile.yaml`
(default `.bober/medical/profile.yaml`; `--vault <dir>` overrides). The profile holds
`age` / `sex` / `conditions` / `medications` / `supplements` / `allergies` / `goals`.

```bash
bober medical profile show
bober medical profile show --vault ~/health-vault   # custom vault dir
```

The profile is **SOPS-encrypted** (age backend, local — **no egress**). Reading is
**fail-closed**: if `sops` is not available, the command prints a clear message and exits
non-zero **without** reading or decrypting anything — it never throws.

### `bober medical profile set <key> <value>`

Update a single profile field, then re-validate and re-encrypt the whole profile.

```bash
bober medical profile set age 42
bober medical profile set sex female
bober medical profile set goals "lower ldl, improve sleep"   # array key: comma-separated
bober medical profile set allergies "penicillin, shellfish"
```

Valid keys are `age` / `sex` / `conditions` / `medications` / `supplements` / `allergies`
/ `goals`. `age` must be a non-negative integer and `sex` one of `male` / `female` /
`other` — an invalid value is rejected (Zod) before anything is written. Array keys take a
comma-separated value. The command starts from a safe default if no profile exists yet,
updates the one field, and writes the re-encrypted `profile.yaml`.

> The profile is **SOPS-encrypted** (age backend, local — **no egress**). Writing is
> **fail-closed**: if `sops` is unavailable the command refuses and exits non-zero, and
> **no plaintext profile is ever written to disk** — only ciphertext reaches the file.
> `--vault <dir>` overrides the vault dir (default `.bober/medical`).

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

### `bober medical review [--dig-deeper <id>]`

Run the **deterministic, offline** proactive trend review pass. It scans the lab series in
the medical health store (`.bober/medical/health.db`), applies reference-range, slope,
**re-test cadence**, and **cross-marker** rules, and writes one **Finding** markdown note per
detection into the vault `findings/` directory plus a `findings/dashboard.md` Dataview note.

```bash
bober medical review
#   findings written: 4
#   dashboard:        /abs/.bober/medical/vault/findings/dashboard.md
```

A single offline pass now emits three kinds of finding:

- **trend** — a biomarker crossing a reference range or trending toward its nearer edge;
- **test-gap (cadence)** — a `kind: "question"` finding when a biomarker is **overdue for
  re-testing** versus a **closed, code-reviewed cadence table** (`ldl`, `hba1c`, `tsh`,
  `vitamin_d`, `ferritin`). Biomarkers **absent** from the table are skipped — no cadence is
  guessed;
- **cross-marker offer** — a `kind: "question"` *"want me to dig deeper?"* finding when **both**
  markers of a configured pair (e.g. `ldl` + `triglycerides`) are out of range. It only **offers**
  the deeper analysis; it does **not** run it, and makes **no LLM call**.

The pass involves **no LLM and no network** — all trend/cadence/cross-marker detection is
deterministic (trend math delegated to the numerics layer), so it is safe to schedule. Findings
are written into the vault, which is the canonical markdown sink (default
`<projectRoot>/.bober/medical/vault`, overridable with the `medical.vaultDir` config key). Finding
ids are derived from `domain|biomarker|rule` (not the clock), so **re-running over an unchanged
store overwrites the same notes without creating duplicates**. On success it prints the number of
findings written and the dashboard path and exits 0; on error it prints a clear message and exits
non-zero **without throwing**. The reactive medical SOP / Q&A engine is not involved.

**`--dig-deeper <id>`** is the **only** path that crosses the LLM gate. Pass the id of a
cross-marker offer finding and it recovers the marker pair from the note's frontmatter and runs the
deeper analysis by **delegating to the 4-lens recommendation panel** (the same gated path as
`bober medical recommend`, inheriting its red-flag short-circuit and **cloud-inference fail-closed**
model selection). It prints whether the deep analysis was **accepted** / **flagged for review** /
**escalated** / **refused** and exits 0 on every normal outcome:

```bash
bober medical review --dig-deeper <offer-finding-id>
#   Deep analysis accepted
#     finding: /abs/.bober/medical/vault/findings/<id>.md
```

### `bober medical recommend <question> [--goal <g>]`

Generate a medical recommendation by gating a candidate through the **4-lens judge panel** and
writing a **Finding** note. The pass assembles the patient context (medications + supplements from
the medical FactStore, conditions/allergies/goals from the SOPS profile — defaulting to empty when
absent), builds four per-lens LLM clients, generates a candidate, and reconciles the panel by strict
majority with an absolute contraindication veto.

```bash
bober medical recommend --goal "optimize energy" "what should I do about my high LDL"
#   Recommendation accepted
#     finding: /abs/.bober/medical/vault/findings/<id>.md
```

The panel outcome decides what is written:

- **accepted** → a `kind: "action"` Finding stating the recommendation **directly** (no refer-out
  hedging) with an **LLM-assigned urgency/severity (clamped 1..5) and a `confidence:<x>` tag**;
- **flagged for review** → a `kind: "question"` Finding titled *"flagged for your review"* carrying
  the per-lens dissent (the panel could not reach consensus);
- **escalated** → the canned red-flag escalation is printed and **no Finding is written**;
- **refused** → a content-policy refusal reason is printed and **no Finding is written**.

**Cloud inference is fail-closed.** Per-lens provider diversity (tier-policy: cheap / standard /
hard / frontier) is used **only when the `cloud-inference` egress axis is enabled**; with it off (the
default), all four lenses **and** the candidate generator resolve to the **local Ollama model** and
**no cloud client is constructed**. The audit log records IDs/enums only (no recommendation text, no
health values). Finding ids are derived from `domain|question|rule` (not the clock), so re-asking the
same question overwrites the same note. The command prints the outcome and the finding path and
exits 0 on every normal outcome; on an unexpected error it prints a message and sets a non-zero exit
code **without throwing**.

### `bober medical research [--marker <m>]`

Run the **online** research job — the networked complement to the offline `bober medical review` pass.
For each marker it retrieves latest **MedlinePlus** evidence, **grounds** a note through the fail-closed
grounding critic, and writes a citation-bearing **research note** (`research/<date>-<marker>.md`) into the
vault plus an optional `kind: "watch"` "new evidence" Finding. When `--marker` is omitted it researches a
default marker set (`ldl`, `hdl`, `a1c`).

```bash
bober medical research                 # default markers: ldl, hdl, a1c
bober medical research --marker ldl    # single marker
#   Research complete
#     notes written:    1
#     findings written: 1
```

**This command is gated behind the `literature-retrieval` egress axis and ships zero outbound bytes until
it is explicitly enabled.** With the axis **off** (the default) the job is a **no-op with zero egress** — it
returns immediately, contacts no network, and writes nothing:

```bash
bober medical research
#   literature-retrieval egress not enabled — research skipped (zero egress)
```

Three guarantees hold by construction (evaluator-verified in source):

- **Zero egress when off** — the axis is checked **first**, returning before any retriever / MedlinePlus
  source is even constructed.
- **Fail-closed abstain** — if the grounding critic rejects (or there is no supporting passage), that
  topic **abstains**: no research note and no finding are written. **No uncited synthesis is ever
  persisted.**
- **Cloud inference is independently fail-closed** — synthesis uses the **local Ollama model** unless the
  separate `cloud-inference` axis is enabled; enabling `literature-retrieval` does **not** enable cloud
  inference.

Citations are stored as **flattened** frontmatter (`citationTitles[]` / `citationUrls[]` + a scalar
`source: medlineplus`) so the notes stay queryable. The clock is read only at the CLI boundary; on error the
command prints a message and sets a non-zero exit code **without throwing**. `runResearchJob` (the function
behind this command) is also the **schedulable entrypoint** that a future research scheduler drives on a
cadence.

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

## Hub Commands

The **priority hub** is the cross-domain surface that collects **Findings** — actionable items,
watches, risks, and open questions surfaced by the various domains (medical, and later others). The
hub **owns the one canonical `Finding` schema** (`src/hub/finding.ts`); every producer and consumer
imports it from there. Findings are stored as FactStore rows at predicate `finding` in the `hub`
scope, with each `Finding` serialized as the row's JSON value.

### `bober hub list`

Print the Findings held in the **project's own FactStore** (the active team's namespace memory
path — the same `facts.db` that `bober facts` and `bober vault reindex` resolve) **plus Findings
aggregated across resolved sibling repos**. Each sibling's derived `facts.db` is opened
**read-only** (never mutated) and its findings are pooled into one list **deduplicated by
`Finding.id`** — the project's own findings come first and win dedup ties. One line per finding
shows its title, kind, urgency, and severity.

Siblings are resolved from a `hub.repos` array in `bober.config.json` or `.bober/config.json`
(paths resolved relative to the project root); when that key is absent the hub instead discovers
directories named `kb-*` sitting beside the project root. A configured path that does not exist,
or a sibling with no/corrupt `facts.db`, is silently skipped — resolution never throws.

```bash
bober hub list
# Lipid panel overdue       [question]  urgency=4  severity=2   # own store
# Portfolio rebalance due   [action]    urgency=3  severity=2   # from a sibling kb-* repo (read-only)
```

When no resolved store holds findings it prints a gray `No findings found.` Rows whose stored value
is **malformed JSON or fails Finding validation are silently skipped** — the read path never throws,
so one bad row never breaks the listing. On error the command prints a red message and sets a
non-zero exit code **without throwing**, and the store is always closed.

A `Finding` carries: `id`, `domain`, `title`, `kind` (`action` | `watch` | `risk` | `question`),
`urgency` (1–5), `severity` (1–5), `evidence[]`, `surfacedAt` (ISO), optional `dueBy` (ISO),
`tags[]`, optional `estDurationMin`, optional `calendarSafeTitle`, `status`
(`open` | `in-progress` | `snoozed` | `done` | `dropped`), and optional `promotesTo`.

> Cross-repo aggregation landed in Sprint 2 (`bober hub list` now pools sibling repos read-only,
> deduplicated by id). Note: `hub.repos` (and `hub.outVault`, below) are read from the **raw** config
> file because the Zod config schema strips unknown keys — they are not yet typed config fields.

### `bober hub priority`

Collect findings across the resolved siblings, **rank** them, and write a Dataview-friendly
`priority.md` note into the **kb-hub output vault**. With no options the ranking runs under
**general** scope; passing any of `--domain <d>`, `--due <days>`, or `--tag <t>` switches it to a
**filtered** scope (a finding must match **all** specified constraints). After writing the note the
command prints a `<rank>. <title>` summary to stdout.

```bash
bober hub priority                       # general scope → <kb-hub>/priority.md
bober hub priority --domain medical --due 14   # filtered: medical findings due within 14 days
```

The ranking is the two-pass judge from Sprint 3 (LLM relevance + per-lens scores, then a
deterministic JS sort — **the LLM never emits the order**); the LLM client is built from the active
`chat` provider. The renderer is **pure** and **never re-ranks**: `priority.md` carries a flat YAML
frontmatter block (`generatedAt` / `scope` / `count`), a table
`| rank | title | domain | kind | urgency | severity | dueBy |` with one row per finding, and a
per-finding evidence/rationale section. Sibling source stores are opened **read-only** and never
modified — only `priority.md` is written.

### `bober hub decide <expr>`

Rank findings under **decision** scope. Pass an `"X vs Y"` expression (split case-insensitively on
` vs `); only findings the judge marks relevant to **either** option survive, ranked within that
frame, and the result is written to `priority.md` exactly as `hub priority` does. A malformed
expression (not two non-empty sides) prints a usage error and exits non-zero **without throwing**.

```bash
bober hub decide "take the job offer vs stay"
```

#### Output vault resolution

`priority.md` is written to the **kb-hub output vault**, resolved to an **absolute** path:
`hub.outVault` from `bober.config.json` / `.bober/config.json` if present (resolved against the
project root), otherwise the documented default `<parentOfProjectRoot>/kb-hub` — the kb-hub sibling
vault beside the project root. The target file is `<outVault>/priority.md`. If the output vault
directory does **not** exist, both commands print a clear red error and set a non-zero exit code
**without throwing** and **without auto-creating** another repo's vault root — create the vault (or
set `hub.outVault`) first.

> `priority.md` rendering + the `priority` / `decide` commands landed in Sprint 4 of
> `spec-20260628-priority-hub`; the `bober chat hub` surface (below) landed in Sprint 5. The
> do-bridge (`Finding.promotesTo`), calendar slot-fill, the scheduler, and the Telegram adapter
> remain owned by sibling specs.

### `bober chat hub`

Open an interactive chat REPL bound to the built-in **`hub`** team (memory namespace `hub`).
This is the conversational sibling of `bober hub priority` / `bober hub decide` — same collect
→ rank → render pipeline, but it keeps you in the REPL and returns the ranked summary inline.
The `hub` team is registered **as data** (no guardrails, default pipeline shape), so
`bober chat hub` routes through the ordinary `bober chat [team]` command.

```bash
bober chat hub
```

Inside a hub session, two extra slash commands are available **only in the hub team**:

```
> /priority                 # rank all pooled findings (general scope), print "rank. title" per line
> /decide <X> vs <Y>        # rank only findings relevant to X or Y (decision scope)
```

`/priority` and `/decide` collect findings across the resolved sibling repos, rank them with
the Sprint 3 two-pass judge (using the session's configured `chat` LLM client), print a
`rank. title` summary, and **best-effort** write the same Dataview-friendly `priority.md` to the
resolved kb-hub output vault (a write failure never breaks the chat turn). `/decide` expects an
`X vs Y` expression (split case-insensitively on ` vs `); a malformed expression returns
`Expected 'X vs Y', got: <expr>`. Both commands are **hub-only** — in any other team they return
an informative no-op message and make **no** LLM call.

> These two commands are intentionally **not** listed by `/help` (the `/help` output is
> unchanged from before Sprint 5). All the other deterministic slash commands (`/runs`, `/stop`,
> `/pause`, `/resume`, `/careful`, `/approve`, `/reject`, `/tell`, `/help`, `/exit`) behave
> exactly as documented under `bober chat [team]` above.

---

## Task Inbox Commands

The **task inbox** is the **zero-friction capture** front-end for the hub pool. A plain string
becomes **one open `action` Finding** stored exactly where the hub commands read from — the same
`hub`-scope, predicate `finding` FactStore rows described under **Hub Commands** above. Capture is
**deterministic and synchronous** (no LLM, no prompts, never blocks); LLM-based triage is a later,
separate concern.

### `bober task add <text> [--domain <domain>]`

Capture a plain task as a single **open `kind=action` Finding** in the unified hub pool. The title
is `text` (trimmed); a deterministic 16-char id is derived from the title and capture time. Pass
`--domain <d>` to set the Finding's `domain` (and add a `domain:<d>` tag); with no `--domain` the
domain falls back to `inbox`. All unknown Finding fields are left empty/omitted, and the required
`urgency`/`severity` fields take **neutral placeholder defaults** (`urgency=3`, `severity=1`) rather
than prompting.

```bash
bober task add "renew passport"
#   Captured task 1f3c9a0b2e4d6f80
#     title:  renew passport
#     domain: inbox

bober task add "book annual physical" --domain medical
#     domain: medical
```

A captured task is an ordinary Finding, so it immediately appears in `bober hub list` and is
eligible for ranking by `bober hub priority` / `bober hub decide` / `bober chat hub`. The command
opens the project's FactStore (the active team's namespace memory path) and writes via the reconcile
layer so later dedup/supersede works. Empty text prints a red error and exits non-zero; on any error
the command writes to stderr and sets a non-zero exit code **without throwing**, and the store is
always closed.

### `bober task list [--all] [--status <status>]`

Print a table of tasks (columns `ID  STATUS  DOMAIN  TITLE`; the title is truncated at 36 chars).
By **default** the list shows only **active** tasks — those whose status is `open` or `in-progress`,
plus any **snoozed** task whose wake time has already passed — so finished and deferred work stays out
of the way. Pass `--all` to include every status (including `done`/`dropped`/still-sleeping
`snoozed`), or `--status <s>` to show only one status (`--status` takes precedence over `--all`).
When the filtered set is empty it prints `No tasks found.` The command is read-only; on any error it
writes to stderr and sets a non-zero exit code **without throwing**.

```bash
bober task list                 # open + in-progress + woken (past-wake) snoozed
bober task list --all           # every status, including done/dropped/sleeping
bober task list --status done   # only completed tasks
```

Wake visibility is computed **lazily at list time** against the wall clock stamped when the command
runs — there is no background timer. See `bober task snooze` below.

### `bober task start <id>` · `bober task done <id>` · `bober task drop <id>`

Move a task through its lifecycle. `start` sets `status='in-progress'`, `done` sets `status='done'`,
and `drop` abandons the task by setting `status='dropped'`. Each transition **supersedes** the task's
active Finding with a new-status copy through the reconcile UPDATE path (supersede old row + insert
new active row), so the prior status survives as **bitemporal history** — **no row is ever deleted**,
not even on `drop`. A successful transition prints `Task <id> → <status>`. An **unknown id** prints a
yellow "no task found" message and exits non-zero **without throwing**.

```bash
bober task start 1f3c9a0b2e4d6f80   # → in-progress
bober task done  1f3c9a0b2e4d6f80   # → done (now hidden from the default list)
bober task drop  1f3c9a0b2e4d6f80   # → dropped (superseded, never deleted)
```

Because terminal tasks remain active rows (filtered out of the default list by their `status` field,
not by deletion), `bober task done <id>` removes a task from `bober task list` while
`bober task list --all` still shows it with `status=done`.

### `bober task snooze <id> --until <when>`

Defer a task until a future time. The task moves to `status='snoozed'` and records its wake time on
the Finding as a `snooze-until:<ISO>` tag, then **disappears from the default `bober task list`**
until that wake time has passed — at which point it reappears for re-triage. `--until` is
**required** and accepts an ISO date or datetime (e.g. `2026-12-01` or `2026-12-01T09:00:00Z`); the
value is parsed and **normalized to a canonical ISO** at the CLI boundary before it is stored. There
is **no schema change** — the wake time lives entirely in `tags[]`.

```bash
bober task snooze 1f3c9a0b2e4d6f80 --until 2026-12-01
#   Task 1f3c9a0b2e4d6f80 snoozed until 2026-12-01T00:00:00.000Z

bober task list                 # snoozed task is hidden until 2026-12-01
bober task list --all           # …still present, status=snoozed
```

Visibility is computed **lazily at list time** against the `now` stamped when `task list` runs — a
snoozed task "wakes" simply because a later list runs after its wake time, **not** via any background
timer. **Re-snoozing replaces** the wake time (the prior `snooze-until:` tag is stripped, never
stacked). **Terminal** (`done`/`dropped`) tasks cannot be snoozed, and a snoozed task can still be
completed or dropped at any time. An invalid `--until`, an unknown id, or a terminal task prints to
stderr and exits non-zero **without throwing**.

### `bober task ingest [file]`

The seam **domains** write AUTO-surfaced Findings through. Read a **Finding JSON** from the optional
`<file>` path, or from **stdin** when the arg is omitted, validate it against the Finding schema, and
push it into the unified hub pool — where it becomes an ordinary active Finding visible to
`bober task list`, `bober hub list`, and `priority` / `decide` / `chat hub`. Unlike `task add` (which
captures a plain string), `task ingest` accepts a full structured Finding (any `kind`, e.g.
`watch`/`action`) emitted by a domain's proactive pass.

```bash
echo '{"domain":"medical","title":"LDL trending up","kind":"watch","urgency":3,"severity":2,"summary":"3 of last 4 panels rising","tags":[]}' \
  | bober task ingest
#   Ingested finding (add)

bober task ingest finding.json   # …or read the payload from a file
#   Ingested finding (add)
```

**Content-addressed dedup.** When the payload omits an `id`, ingest derives a deterministic 16-char id
from a hash of `domain|title|kind`. Re-ingesting a finding that agrees on those three fields **collides
on the same id and reconciles to a single active row** — the command prints `Ingested finding (update)`
or `(noop)` rather than adding a duplicate. A payload that supplies its own `id` keeps it. `surfacedAt`
is filled with the current time when absent; the clock is stamped only at the CLI boundary.

**Schema is never bypassed, and ingest is fail-closed.** The payload is validated against the Finding
schema (with `id`/`surfacedAt` optional) and again as a fully-assembled Finding **before** any write.
**Malformed JSON** or a payload **missing required Finding fields** prints a red message to stderr, sets
a **non-zero exit code**, writes **nothing**, and **never throws**. Ingest reuses the same reconcile
write path as `task add`, so supersede/dedup history works identically.

### `bober task from-gmail <thread>` (opt-in Gmail egress)

Turn a single Gmail thread into a captured task. This command is **off by default** and gated behind
an explicit opt-in egress axis — `taskInbox.gmailEgress` in `bober.config.json` (default `false`).

```bash
# Default posture — the axis is unset/false: zero Gmail egress.
bober task from-gmail 18f0a1b2c3d4
#   task from-gmail: Gmail egress not enabled — set taskInbox.gmailEgress: true in bober.config.json to opt in.
#   (exitCode=1, and NO MCP client is constructed — no network call is made)
```

With the axis off (the default) the command **refuses with an opt-in message, sets `exitCode=1`, and
constructs no MCP client / makes no network call**. To enable it, set the axis **and** declare an
enabled `observability` provider named `gmail` (it reuses the existing external-MCP connector):

```jsonc
{
  "taskInbox": { "gmailEgress": true },
  "observability": {
    "providers": [
      { "name": "gmail", "kind": "custom", "mcpCommand": "npx",
        "mcpArgs": ["-y", "some-gmail-mcp-server"], "enabled": true }
    ]
  }
}
```

```bash
bober task from-gmail 18f0a1b2c3d4
#   Captured task 1f3c9a0b2e4d6f80 from Gmail
#     title: Pay invoice
```

When enabled, the command reads **one thread on demand** through the MCP connector, parses it
**locally** into an open `action` Finding (title from the thread subject), and captures it through the
**same `captureTask` write path** as `task add` — so it shows up in `bober task list`, `bober hub
list`, and is eligible for `priority` / `decide` / `chat hub`. The captured Finding carries
`domain=gmail` and a `source:gmail` tag.

**Fail-closed and secret-safe.** A missing or invalid config resolves the axis to **disabled** (never
enabled-by-accident). Any connector failure is **caught**, surfaced on stderr with `exitCode=1`, and
**sanitized** — `KEY=VALUE` env assignments (e.g. a connector token) are stripped to `[redacted]`
(the same regex as `src/mcp/external-client.ts`), so env vars / tokens never leak into a message or
log. This reads one thread on demand — there is **no** Gmail polling, label automation, or general
sync.

> `bober task add` landed in Sprint 1 of `spec-20260628-task-inbox`; `list` and the
> `start` / `done` / `drop` lifecycle transitions landed in Sprint 2; `snooze` and its wake-aware
> list filter landed in Sprint 3; the domain-finding `ingest` seam (with content-id dedup) landed in
> Sprint 4; **chat intent-detection capture** — typing a plain task into `bober chat` to file it
> through the same `captureTask` write path — landed in Sprint 5 (see **`bober chat [team]` →
> Capturing a task** above); and the opt-in, egress-gated `from-gmail` source landed in Sprint 6,
> completing the plan (6/6).

---

## Do-Bridge Commands

The **do-bridge** turns a hub **Finding** into a launchable unit of work. A *promoter* (resolved by the
finding's `domain`, and optionally its `kind`) maps the finding to a *promotion plan* — for coding /
projects findings that is a `bober run` task.

### `bober do <findingId>`

Promote a hub Finding into a `bober run` task. The command reads the finding from the project's FactStore
(the active team's namespace `facts.db` — the same store `bober hub list` and `bober task list` read),
resolves the promoter for its `domain`/`kind`, and either **previews** the launch (`--dry-run`) or
**requests approval and launches** it. Only `coding` / `projects` findings are promotable (they map to a
`bober run` task; the target team comes from an optional `team:<id>` tag, otherwise the default team).

```bash
bober do 1f3c9a0b2e4d6f80 --dry-run    # Preview only — read-only, no marker, no spawn
bober do 1f3c9a0b2e4d6f80              # Real path — write an approval marker, gate, then launch on approve
bober do 1f3c9a0b2e4d6f80 --yes        # Real path, auto-approve (skip the confirm prompt)
bober do --reconcile                   # Reconcile launched promotions to their run outcome, then exit (no findingId)
```

**Dry-run (`--dry-run`)** is read-only: it mutates no state, writes nothing under `.bober/approvals/`,
and spawns no process:

```text
[dry-run] would launch: bober run "Fix flaky auth test — token refresh races on expiry" (team: default team)
```

**Real path** (no `--dry-run`) writes a pending approval marker and **gates** on it before launching
anything:

```text
do: requesting approval to launch bober run "Fix flaky auth test …" (team: default team)
? Approve promotion for finding '1f3c9a0b2e4d6f80'? (y/N)
do: launched bober run "Fix flaky auth test …" — runId: do-1f3c9a0b2e4d6f80-<ts> (pid 40912)
```

The gate resolves one of three ways:

- **`--yes`** — auto-approve without prompting (still writes then clears the marker).
- **TTY** — an interactive confirm prompt; decline → reject (nothing launches, the Finding is unchanged).
- **Non-TTY** (CI, pipes) — the command writes the marker and **waits**, polling until an operator
  resolves it out-of-band.

The approval marker reuses the **same `.bober/approvals/` mechanism the run pipeline uses** — no new
format. The marker's checkpointId is `promote-<findingId>`, so it is resolved with the standard
[`bober approve <checkpointId>`](#bober-approve-checkpointid) / [`bober reject <checkpointId>`](#bober-reject-checkpointid)
commands:

```bash
bober approve promote-1f3c9a0b2e4d6f80   # Approve a waiting promotion → launch proceeds
bober reject  promote-1f3c9a0b2e4d6f80   # Reject it → no launch, Finding untouched
```

On **approval**, the work is launched **detached** (`agent-bober run <task> --run-id do-<id>-<ts>`; the
pipeline is not run in-process), the Finding is linked (`promotesTo` records the new `runId` with status
`launched`), and its status transitions `open → in-progress`. On **rejection**, the pending marker is
deleted and the Finding is left unchanged. Failure branches are non-throwing and exit non-zero (`1`): an
unknown id prints `do: no finding with id '<id>'`, and a finding whose domain has **no registered
promoter** prints a clear message naming the unsupported domain.

### `bober do --reconcile`

Close the loop after a promoted run finishes. `bober do --reconcile` (no `findingId`) reads each launched
promotion's `run-state.json` **snapshot** and advances the linked Finding to its terminal status, then
prints a summary and exits:

```bash
bober do --reconcile                   # → do --reconcile: completed=1 aborted=0 unchanged=2
```

| Run state | Finding transition | `promotesTo.status` |
|-----------|--------------------|---------------------|
| `completed` | `in-progress → done` | `completed` |
| `aborted` / `failed` | `in-progress → open` | `aborted` |
| `running` (or missing/corrupt state) | unchanged | unchanged |

Reconcile is **snapshot-based** (it reads the current state and returns immediately — it never polls or
blocks waiting for a run to finish) and **best-effort** (a missing/corrupt `run-state.json` is treated as
"still running" and the Finding is left untouched). The same reconcile also runs automatically at the
**start of every `bober do <id>`**, wrapped so a reconcile failure can never abort the command.

> **Status.** Complete — `spec-20260628-do-bridge` is **done (3 of 3)**: dry-run preview (Sprint 1),
> approve-gated real launch + `--yes` (Sprint 2), and terminal reconciliation (`--reconcile`) + the
> consolidated [`docs/do-bridge.md`](docs/do-bridge.md) extension-point guide (Sprint 3).

---

## Calendar Commands

The **calendar planner** takes the ranked **Findings** from the priority hub (with `dueBy` and
`estDurationMin`) plus a free/busy model and runs a **deterministic, LLM-free slot-fill** that places
tasks into open slots **in priority order** — the LLM never packs slots. Placement is pure synchronous
TypeScript: identical input produces deep-equal output, with no async, filesystem, network, or model
call inside the algorithm.

### `bober calendar plan --dry-run`

Propose a schedule from a ranked findings file and a free/busy file, and print it. In `--dry-run` the
command is **read-only** — it writes **nothing** to any calendar or `.ics` file (use `--export-ics`
below to write the plan to disk).

```bash
bober calendar plan --dry-run --findings ./ranked-findings.json --freebusy ./freebusy.json
```

- `--findings <path>` (**required**) — a ranked `Finding[]` JSON file, ordered by priority (index 0 =
  highest). Each `Finding` has the same shape `bober hub list` emits; the slotter reads `estDurationMin`
  (default 30 min if absent), optional `dueBy`, and `calendarSafeTitle` (falling back to `title`).
- `--freebusy <path>` (optional) — a `BusyInterval[]` JSON file (`{ startIso, endIso }` entries). Omit it
  to plan against a fully open window.

The planning window is **7 days** from now, computed at the command boundary. Findings are placed into
the earliest free slot that fits their duration before their `dueBy`; each placed item prints with its
ISO start/end and title, and anything that could not be placed prints in an **Unscheduled** list with a
reason (`does-not-fit` or `no-free-slot-before-dueBy`):

```text
Proposed calendar plan
Window: 2026-06-29T00:00:00.000Z → 2026-07-06T00:00:00.000Z

Scheduled (2):
  [2026-06-29T00:00:00.000Z → 2026-06-29T00:30:00.000Z]  Renew prescription
  [2026-06-29T00:30:00.000Z → 2026-06-29T01:30:00.000Z]  Book dentist

Unscheduled (1):
  f-90  reason: does-not-fit

(dry-run — nothing written to any calendar)
```

A missing `--findings` path, an unreadable file, or a finding/interval that fails validation prints a
red message to stderr and sets a non-zero exit code **without throwing**.

### `bober calendar plan --export-ics <path>`

Slot the findings exactly as the dry-run does, then **write the scheduled plan to an RFC 5545 `.ics`
file** with **zero network egress** — a local-first export you import manually into your calendar app.
This is the user-invoked path; there is no approval gate (the manual import is the human review).

```bash
bober calendar plan --export-ics out.ics --findings ./ranked-findings.json --freebusy ./freebusy.json
```

- `--export-ics <path>` — the destination `.ics` file. The written file is a `VCALENDAR` with **one
  `VEVENT` per scheduled item**: `UID` (`<findingId>@agent-bober`), `DTSTAMP`, `DTSTART`/`DTEND` in UTC
  basic format (`YYYYMMDDTHHMMSSZ`), and `SUMMARY` (the item title, RFC 5545 TEXT-escaped). Lines use CRLF
  endings.
- `--findings` / `--freebusy` behave exactly as in `--dry-run`. The slot-fill algorithm is unchanged; the
  only difference is that the resulting plan is written to disk via the local `.ics` connector instead of
  only printed.

On success the command prints `Wrote N event(s) to <path>`. The write is the **only** filesystem write
on the calendar path and lives entirely in the `.ics` connector — there is no live calendar or network
access. Validation/I/O failures still set a non-zero exit code **without throwing**.

```text
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//agent-bober//calendar-planner//EN
BEGIN:VEVENT
UID:f-1@agent-bober
DTSTAMP:20260629T000000Z
DTSTART:20260629T000000Z
DTEND:20260629T003000Z
SUMMARY:Renew prescription
END:VEVENT
END:VCALENDAR
```

### `bober calendar plan` (live — propose through the approval gate)

With **neither** `--dry-run` **nor** `--export-ics`, `bober calendar plan` is the **live path**: it slots
the findings, **proposes** the schedule through the **existing** approval gate, and writes **zero**
calendar events until the checkpoint is approved. It writes a pending approval marker
(`.bober/approvals/<checkpointId>.pending.json`) plus a plan sidecar
(`.bober/calendar/<checkpointId>.plan.json`) and prints the `checkpointId` (= `calendar-<planId>`) and how
to approve it. There is **no auto-approve in any mode** — approval is strictly out-of-band.

```bash
bober calendar plan --findings ./ranked-findings.json --freebusy ./freebusy.json
```

```text
Proposed calendar plan
Window: 2026-06-29T00:00:00.000Z → 2026-07-06T00:00:00.000Z

Scheduled (2):
  [2026-06-29T00:00:00.000Z → 2026-06-29T00:30:00.000Z]  Renew prescription
  [2026-06-29T00:30:00.000Z → 2026-06-29T01:30:00.000Z]  Book dentist

Proposal saved. Approve to write events:
  bober approve calendar-<planId>
  /approve calendar-<planId>  (in chat)

Checkpoint ID: calendar-<planId>
```

`--findings` / `--freebusy` behave exactly as in `--dry-run`. The connector that will write the events is
read from `calendar.connector` (default `ics`) and recorded in the marker summary.

### `bober calendar apply <checkpointId>`

Write the events for a calendar plan **once it has been approved**. It detects the approved/rejected
marker for the checkpoint and calls the chosen connector's `writeEvents` **exactly once** on approval,
**never** on rejection.

```bash
bober approve calendar-<planId>            # or  /approve calendar-<planId>  in chat
bober calendar apply calendar-<planId>
```

- If the checkpoint is **approved** → reloads the plan sidecar and writes the proposed events once, then
  prints `Applied: N event(s) written.` and clears the pending marker.
- If the checkpoint is **rejected** (`/reject calendar-<planId> [feedback]`) → aborts with the feedback
  and exit 1; **no** events are written.
- If **neither** marker exists yet → prints a `Pending approval` hint and writes nothing.
- `--out <path>` overrides the `.ics` output path (ics connector only). When `calendar.connector` is
  `google`, apply refuses with an actionable message + exit 1 unless OAuth is provisioned — the Sprint 3
  `calendar.egress.cloudCalendar` axis is **not** bypassed; use the `--export-ics` fallback for
  unattended runs.

A `/tell`-style correction re-runs the deterministic slotter under the new constraint (exclude an
interval / shift the window) and **re-proposes** — again writing no events.

> **Status.** **Sprints 1–4 of 4 — COMPLETE.** `spec-20260628-calendar-planner`: the deterministic
> slotter + `bober calendar plan --dry-run` (Sprint 1), the local-first, zero-egress `.ics` export via
> `--export-ics` (Sprint 2), the **egress-gated Google Calendar MCP connector** (Sprint 3, off by default;
> writes require `calendar.egress.cloudCalendar: true` **and** a provisioned 0600 OAuth token sidecar, and
> only a non-sensitive `calendarSafeTitle` ever leaves the device), and the **approve-gated live write**
> (Sprint 4): the default `bober calendar plan` proposes through the existing approval gate (zero events
> written) and `bober calendar apply <checkpointId>` writes the events exactly once on approval / never on
> reject. Hosted Google OAuth is **unfit for unattended/cron runs** (tokens expire, re-auth is
> interactive), so the local `.ics` path stays the recommended choice for scheduled/automated use.
> Config + privacy details: [`docs/calendar.md`](docs/calendar.md).

---

## Research Commands

The **research scheduler** lets you define recurring **multi-model research jobs** — a question
plus a cadence — once, so a later scheduler can rerun it across a model set, optionally retrieve
online, and feed the results into the priority hub. Sprints 1–2 ship the **definition + execution
layers**: jobs are persisted as JSON files under `.bober/research/jobs/<jobId>.json` (not in
`bober.config.json`, not in the FactStore). Each job round-trips through `ResearchJobSchema`, and
the job id is the deterministic `sha256(question|createdAt).slice(0,16)`. The store never reads the
clock — the CLI stamps `createdAt` once at the command boundary. `bober research run <jobId>`
executes one stored job on demand across ≥2 distinct models, writing a vault note and one hub
Finding (no online retrieval yet — that is Sprint 3).

### `bober research job add --question "..." [options]`

Validate the inputs and persist one recurring research job.

```bash
bober research job add --question "What changed in the GLP-1 literature this week?" --cadence weekly --domain medical
```

- `--question <q>` (**required**) — the research question. Must be **non-empty** (a blank question is
  rejected with a Zod error).
- `--cadence <c>` (optional, default `weekly`) — recurrence cadence, a **closed enum**:
  `daily | weekly | monthly`. (It is deliberately not a cron string; next-due computation is a later
  sprint.)
- `--tier <t>` (optional) — a difficulty-tier hint for the executor (a later sprint).
- `--domain <d>` (optional) — a domain tag (e.g. `medical`, `coding`) for priority-hub routing.
- `--target-repo <r>` (optional) — a repository slug to scope the research against.
- `--online-research` (optional) — stores `onlineResearch=true`. **This does not enable any network
  call** — the online-research egress axis is not active yet; the flag is persisted for
  forward-compatibility only.

On success it prints the new `jobId`, the question, and the cadence. On a validation or IO error it
prints a red message to stderr and exits non-zero **without throwing**.

### `bober research job list`

Print every defined job, one per line, as `<jobId>  <cadence>  <question>  [<domain>]`:

```bash
bober research job list
# 3f8a1c0b9d2e4f76  weekly  What changed in the GLP-1 literature this week?  [medical]
```

When no jobs are defined it prints `No research jobs defined.`. Malformed/invalid JSON files in the
store are silently skipped — the listing never throws.

### `bober research job remove <jobId>`

Delete a job's JSON file by id:

```bash
bober research job remove 3f8a1c0b9d2e4f76
# Removed research job 3f8a1c0b9d2e4f76
```

A not-found id prints a yellow message and exits non-zero.

### `bober research run <jobId>`

Execute a stored research job **once, on demand**: query ≥2 distinct provider/model blocks, write a
markdown research note into the vault, and emit one Finding to the priority hub.

```bash
bober research run 3f8a1c0b9d2e4f76
# /path/to/vault/research/2026-06-29-3f8a1c0b9d2e.md
```

- Loads the job by id (a not-found id prints a red message and exits non-zero **without throwing**).
- Resolves **≥2 distinct provider/model blocks** from `src/fleet/tier-policy.ts` (across different
  difficulty tiers — `cheap`/`standard`/`hard`/`frontier`) and asks each the job's `question`.
- Writes a markdown note to `<vaultRoot>/research/<YYYY-MM-DD>-<marker>.md` whose frontmatter records
  `jobId`, `question`, the list of `models` queried, and a `generatedAt` timestamp; the body has one
  `### <provider>/<model>` section per model answer.
- Emits **exactly one** `kind: "watch"` Finding to the hub (`domain` from the job, default
  `research`; `evidence` = per-model contribution snippets), via the hub's `ingestFinding` writer.
- **No online/web retrieval** happens — the run uses only the injected provider clients. On-demand
  only; cadence/scheduling is a later sprint. Prints the note path on success.

> **Status.** **Sprint 2 of 5 — in progress.** `spec-20260628-research-scheduler` Sprints 1–2 ship
> the **definition + execution layers**: the `ResearchJob` schema, the clock-free JSON store under
> `.bober/research/jobs/`, `bober research job add|list|remove`, and `bober research run <jobId>`
> (single-shot multi-model run → vault note + one hub Finding). **No online egress, cadence/scheduling,
> or digest output exists yet** — those are Sprints 3–5. Defining a job with `--online-research`
> stores the flag but makes **no** network call, and a `run` performs **no** web retrieval.

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
