# Multi-LLM Fleet

The fleet (`src/fleet/`) turns a single **head** agent — Claude Code, running on your
subscription — into a **tech lead** that fans out **N isolated child processes**, each a full
`agent-bober run <task>` in its own folder. Children are **heterogeneous LLMs**: the default
child runs on DeepSeek, and each child can be pushed to a stronger (or cheaper) provider with a
one-word **difficulty tier**. An optional **shared blackboard** lets children exchange findings
across a few bounded rounds; a **pure synthesis** step then bundles the run into one JSON artifact
that the head — and the Telegram `/fleet` secretary view — can read.

This guide is a setup-and-use walkthrough. It covers credentials, the manifest schema, tiers,
running a fleet, the blackboard, synthesis output, and the goal decomposers.

---

## Concept: one head, N isolated children

The head never edits code directly for a fleet run. It **spawns children** and reads their
reports. Each child is a completely independent `agent-bober` process:

- The runner (`src/fleet/runner.ts:85`) spawns every child with
  `execa(process.execPath, [<dist/cli/index.js>, "run", <task>], { cwd: <childFolder> })` — the
  parent's own Node binary and its own built CLI, **never** a bare `PATH` lookup.
- Each child has a **10-minute default timeout** and a **10 MiB** stdout/stderr buffer
  (`runner.ts:33-34`). A timeout or a spawn failure (e.g. `ENOENT`) is **captured as data**
  (`timedOut` / `spawnError` on the result) — the runner **never throws**. A crashed child is one
  `failed` row in the report, not a crashed batch.
- Children run **concurrently** up to the manifest's `concurrency` (a bounded worker pool), so a
  100-child manifest never opens 100 processes at once.

### Heterogeneous by default

Every child starts from a DeepSeek base — `buildChildConfig` (`src/fleet/child-config.ts:22`) sets
the **openai-compat** provider at `https://api.deepseek.com` with model `deepseek-v4-pro` on the
child's **planner, generator, and evaluator**. A per-child **tier** then overlays a different
provider block (see [Difficulty tiers](#difficulty-tiers)). So a single manifest can mix cheap
DeepSeek scouts with a frontier Opus child on the one hard sub-project.

### The head is the *only* `claude-code` agent — a build-time guard

`claude-code` is a subscription provider that drives the head, but it **cannot drive tool roles**
(curator / generator / evaluator / codeReview). The tool-role guard (`src/fleet/tool-role-guard.ts`)
resolves every child's config at **manifest-build time** and **throws a named error before any
child is spawned** if `claude-code` lands on a tool role:

```
Fleet child "auth-svc" places claude-code on tool role "generator" — claude-code cannot
drive tools. Use an api-key provider (anthropic/openai-compat) for builder roles.
```

So children must use **api-key** providers (DeepSeek, Grok/xAI, Anthropic). This check
(`assertManifest`) runs first in `runFleet`, ahead of the credential check and every spawn.

---

## Credentials (environment only, fail-fast before any spawn)

Before a single child is spawned, `runFleet` resolves each child's effective config and calls
`validateManifestCredentials` (`src/fleet/index.ts`), which reuses the same `validateApiKey`
(`src/providers/factory.ts`) the normal CLI uses. A missing key **throws immediately** (exit 1) —
no folder is scaffolded, no process is started.

| Variable | Required for | Provider / endpoint |
|----------|--------------|---------------------|
| `DEEPSEEK_API_KEY` | default children, `cheap` tier, **and** the `expand` / `expand-deep` decomposers | DeepSeek — `https://api.deepseek.com` |
| `XAI_API_KEY` | `standard` tier | Grok / xAI — `https://api.x.ai/v1` |
| `ANTHROPIC_API_KEY` | `hard` (Sonnet) and `frontier` (Opus) tiers | Anthropic |

```bash
export DEEPSEEK_API_KEY=sk-...        # default + cheap children, and the decomposers
export XAI_API_KEY=xai-...            # only if you use the standard tier
export ANTHROPIC_API_KEY=sk-ant-...   # only if you use hard / frontier tiers
```

You only need the keys for the tiers your manifest actually uses. A default-only fleet needs
just `DEEPSEEK_API_KEY`.

> **Grok model ids are placeholders.** The `grok`/`standard`-tier model ids (`grok-4`,
> `grok-4-fast` in `src/orchestrator/model-resolver.ts`) are **placeholders** — confirm the real
> xAI model ids against the current xAI catalog before any live `standard`-tier run.

---

## Manifest schema

A fleet is described by one JSON manifest, validated by the Zod `FleetManifestSchema`
(`src/fleet/manifest.ts`). A malformed manifest is a **batch-setup error** (exit 1) with a
message naming the file.

```jsonc
{
  "rootDir": ".",            // where children + .bober/ artifacts land; default "."
  "concurrency": 3,          // max children running at once; default 3, min 1
  "children": [              // at least one child required
    {
      "folder": "auth-svc",                       // required — child working dir under rootDir
      "task": "Build a JWT auth service",         // required — the `agent-bober run` task
      "tier": "hard",                             // optional — see Difficulty tiers
      "config": { }                               // optional — per-child bober.config overrides
    }
  ],
  "blackboard": {            // OPTIONAL — omit for a single-pass fleet
    "namespace": "myrun",    // required when blackboard is present
    "maxRounds": 3           // 1–3, default 3
  }
}
```

Per-child fields:

| Field | Required | Meaning |
|-------|----------|---------|
| `folder` | yes | Child working directory (resolved under `rootDir`). Gets its own `bober.config.json`. |
| `task` | yes | The task string passed to `agent-bober run <task>` inside that folder. |
| `tier` | no | `default` \| `cheap` \| `standard` \| `hard` \| `frontier` — maps the whole child to a provider block. |
| `config` | no | Top-level `bober.config.json` overrides, **shallow-merged** over the base — a child key **fully replaces** the base value (no deep merge). |

---

## Difficulty tiers

A tier (`src/fleet/tier-policy.ts`) maps a **whole child** — planner, generator, and evaluator
together — onto one provider block, overlaid on top of the DeepSeek base:

| `tier` | Provider / model | Endpoint | Env var |
|--------|------------------|----------|---------|
| `default` / absent | DeepSeek `deepseek-v4-pro` | `api.deepseek.com` | `DEEPSEEK_API_KEY` |
| `cheap` | DeepSeek `deepseek` | `api.deepseek.com` | `DEEPSEEK_API_KEY` |
| `standard` | Grok `grok` | `api.x.ai/v1` | `XAI_API_KEY` |
| `hard` | Sonnet (`claude-sonnet-4-6`) | anthropic | `ANTHROPIC_API_KEY` |
| `frontier` | Opus (`claude-opus-4-8`) | anthropic | `ANTHROPIC_API_KEY` |

When `tier` is absent or `default`, `resolveTier` returns nothing and **no overlay is applied** —
the child's config is **byte-identical** to the DeepSeek base. This is the load-bearing property
that keeps a no-tier fleet unchanged as tiers were added.

Use tiers to spend budget where it matters: `cheap` scouts to survey, a `frontier` child on the
one genuinely hard sub-project, `standard` where you want a second, differently-biased model.

---

## Running a fleet

```bash
agent-bober fleet <manifest> [--concurrency <n>] [--root <dir>]
```

- `--concurrency <n>` overrides `manifest.concurrency`.
- `--root <dir>` overrides `manifest.rootDir` (where children and `.bober/` artifacts are written).

On completion the command prints a **Fleet Summary** and **always** writes a report to
`<rootDir>/.bober/fleet-report.json`.

### Exit codes: per-child failures are data, not crashes

| Exit | When |
|------|------|
| **0** | Normal completion — **including when some or all children failed**. Per-child failures are rows in the report, never fatal. |
| **1** | A **batch-setup** error only: a bad/missing manifest, a missing credential, a `claude-code`-on-tool-role violation, or a report-write IO failure. |

### The report artifact

`fleet-report.json` (`src/fleet/reporter.ts`) is written atomically (temp file + rename, mode
`0600`) and has the shape:

```jsonc
{
  "total": 3,
  "completed": 2,
  "failed": 1,
  "other": 0,               // running / aborted / unknown
  "generatedAt": "2026-07-02T12:00:00.000Z",
  "children": [ /* one ChildOutcome per child */ ],
  "rounds": 2               // OPTIONAL — present only on a blackboard run
}
```

`rounds` is written **only** on a blackboard run; a plain single-pass fleet omits the key.

### Worked example

`fleet.json`:

```jsonc
{
  "rootDir": "./runs/payments",
  "concurrency": 2,
  "children": [
    { "folder": "schema",   "task": "Design the payments DB schema",       "tier": "cheap" },
    { "folder": "api",      "task": "Build the payments REST API",         "tier": "standard" },
    { "folder": "settle",   "task": "Write the nightly settlement engine", "tier": "frontier" }
  ]
}
```

```bash
export DEEPSEEK_API_KEY=sk-...
export XAI_API_KEY=xai-...
export ANTHROPIC_API_KEY=sk-ant-...
agent-bober fleet ./fleet.json
```

```
═══ Fleet Summary ═══

  Total:      3 children
  Completed:  2
  Failed:     1

```

Inspect `./runs/payments/.bober/fleet-report.json` for the per-child outcomes, and look inside
each child folder (`./runs/payments/schema`, `.../api`, `.../settle`) for the actual work — each
is its own git repo with its own `bober.config.json`.

---

## Inter-agent blackboard (opt-in)

Adding a `blackboard` section turns the run into a **bounded, multi-round exchange**: children can
publish findings that their siblings read on the next round. **Omit the section** and the fleet is
a single `mapBounded` pass — byte-identical to non-blackboard behavior, with no shared DB and no
synthesis file.

### One shared WAL SQLite `facts.db`

When a blackboard is configured, `runFleet` resolves an **absolute** DB path
(`resolveBlackboardPath`, `src/fleet/index.ts:47`):

```
<rootDir>/.bober/memory/<namespace>/facts.db
```

The DB is opened in **WAL** mode with a **5000 ms `busy_timeout`** (`src/fleet/shared-blackboard.ts`),
so concurrent children can write findings without `SQLITE_BUSY` deadlocks. It is a single-host
file (one machine); there is no cross-machine exchange.

### Rounds and early-stop

`executeRounds` (`src/fleet/coordinator.ts`) runs up to `maxRounds` (**hard cap 3**):

- **Round 1** scaffolds each child — creating its folder, writing its `bober.config.json`
  (including the `fleet` section below), and `git init`.
- **Rounds 2+** skip scaffolding entirely and only **re-spawn** each child, reusing the round-1
  folder.
- **Early-stop:** after any completed round beyond the first, if the blackboard gained **zero new
  `finding` facts**, the loop terminates — no point spending another round when nobody learned
  anything.

> **Scaffolder safety:** a child folder that already **exists and is non-empty** is left
> **untouched** — the scaffolder returns an error for that child rather than overwriting your
> files (`src/fleet/scaffolder.ts`). Point `rootDir` at a fresh directory for a clean run.

### How children reach the shared DB

The scaffolder writes a `fleet` block into each child's `bober.config.json`
(`src/fleet/scaffolder.ts:62`):

```jsonc
"fleet": {
  "blackboardDbPath": "/abs/path/.bober/memory/myrun/facts.db",  // absolute
  "blackboardNamespace": "myrun",
  "blackboardSubject": "auth-svc",   // = this child's folder
  "maxRounds": 3
}
```

Children then exchange findings through the CLI — the DB path is read from `config.fleet`
**only**, never re-derived from the child's cwd:

```bash
# Publish a finding under this child's own subject (default round 1)
agent-bober blackboard publish "auth uses RS256; siblings should verify with the JWKS endpoint"
agent-bober blackboard publish "schema finalized" --round 2

# Read sibling findings (default) — everything published by OTHER children
agent-bober blackboard read

# Read every finding, including this child's own
agent-bober blackboard read --all
```

Both subcommands exit **1 cleanly (no throw)** with a friendly message if the current project has
no `fleet` section — i.e. it is not part of a blackboard run (`src/cli/commands/blackboard.ts`).

### Blackboard manifest example

```jsonc
{
  "rootDir": "./runs/research",
  "concurrency": 3,
  "children": [
    { "folder": "market",  "task": "Survey the competitive landscape",   "tier": "cheap" },
    { "folder": "tech",    "task": "Assess the technical feasibility",   "tier": "standard" },
    { "folder": "synth",   "task": "Reconcile findings into a decision", "tier": "frontier" }
  ],
  "blackboard": { "namespace": "research", "maxRounds": 3 }
}
```

---

## Synthesis output (blackboard runs only)

After the rounds finish, a **pure** `collect()` (`src/fleet/synthesis.ts`) — **no LLM, no network,
no provider client** — bundles the run and writes it atomically (temp + rename, mode `0600`) to:

```
<rootDir>/.bober/fleet-synthesis.json
```

The bundle shape (`SynthesisBundle`):

```jsonc
{
  "rounds": 2,                       // the terminating round count
  "childResults": { /* the fleet-report.json object */ },
  "findings": [ /* every active 'finding' fact from the blackboard */ ]
}
```

This is exactly the artifact the Telegram **`/fleet` secretary view** reads to show one section per
agent — see [`./telegram.md`](./telegram.md). A **non-blackboard** run does **not** write this file
(and `/fleet` then replies "no recent fleet run").

---

## Goal decomposers: `fleet expand` and `fleet expand-deep`

Rather than hand-writing a manifest, you can hand a high-level goal to an **LLM decomposer** that
proposes the children for you:

```bash
agent-bober fleet expand "<goal>"       [options]
agent-bober fleet expand-deep "<goal>"  [options]
```

- **`expand`** — a single-shot decomposition. Good for clear, well-bounded goals.
- **`expand-deep`** — a robust **two-stage plan → expand** decomposition for large or ambiguous
  goals.
- **`expand-deep --critique`** — adds a **fresh-context critic gate** that re-expands a degenerate
  manifest (fail-open: it keeps the best result rather than blocking).

The decomposer runs on **DeepSeek `deepseek-v4-pro`** (openai-compat) by default, so it needs
`DEEPSEEK_API_KEY`.

Shared options:

| Option | Meaning |
|--------|---------|
| `--count <n>` | Soft target for the number of sub-projects. |
| `--provider <p>` | Override the decomposer provider (default `openai-compat`). |
| `--model <m>` | Override the decomposer model (default `deepseek-v4-pro`). |
| `--root <dir>` | `rootDir` for the generated manifest (default `.`). |
| `--concurrency <c>` | `concurrency` for the generated manifest (default `3`). |
| `--out <path>` | Where to write the manifest (default `<root>/.bober/fleet-expand.json`). |
| `--yes` | **Chain straight into `fleet run`** after writing. Without it, the command **writes and stops (exit 0)**. |

The **default is write-and-stop** so you can review before spending compute. The command prints the
manifest and a hint:

```
Manifest written to: ./.bober/fleet-expand.json
Review then run: agent-bober fleet "./.bober/fleet-expand.json"
```

Writing the manifest also writes a provenance sidecar `<out>.meta.json` (the command, goal, child
count, and whether critique ran) and preserves any prior manifest as `<out>.bak`, so a re-run
never silently clobbers a manifest you were about to run.

```bash
# Review-first (default): write the manifest, then eyeball it
agent-bober fleet expand "Build a URL shortener with an admin dashboard" --count 4

# Trust-and-go: decompose and immediately run
agent-bober fleet expand-deep "Migrate the monolith to services" --count 6 --yes
```

---

## Related docs

- [`./telegram.md`](./telegram.md) — the `/fleet` secretary view that reads
  `fleet-synthesis.json`.
- [`./providers.md`](./providers.md) — provider/model resolution, endpoints, and env-var setup in
  depth.
- [`./storage.md`](./storage.md) — the SQLite `facts.db` / blackboard storage model.
- [`./knowledge-platform.md`](./knowledge-platform.md) — the top-level platform guide that ties the
  fleet, research scheduler, hub, and Telegram frontend together.
