---
name: bober.graph
description: Manage the code graph index — init, sync, and check status. Requires graph.enabled=true in bober.config.json and tokensave installed.
handoffs:
  - label: "Generate Onboarding Docs"
    command: /bober-onboard
    prompt: "Generate onboarding docs from the code graph"
  - label: "Analyse Impact"
    command: /bober-impact
    prompt: "Analyse the impact radius of a symbol"
---

# bober.graph — Code Graph Management Skill

You are running the **bober.graph** skill. Your job is to initialise, sync, or check the status of the code graph for this project.

The code graph is powered by `tokensave`. Once indexed, it enables semantic search, impact analysis, and onboarding document generation.

## Prerequisites

- `tokensave` >= 6.0.0-beta.1 must be installed
- `graph.enabled: true` must be set in `bober.config.json`

Install tokensave:
- macOS: `brew install aovestdipaperino/tap/tokensave`
- Linux: `cargo install tokensave`
- Windows: `scoop bucket add tokensave https://github.com/aovestdipaperino/scoop-bucket && scoop install tokensave`

## Available Subcommands

### Check prerequisites
```bash
agent-bober graph check-prereq
```
Reports whether tokensave is installed and compatible. Outputs JSON.

### Initialise the graph
```bash
agent-bober graph init
```
Runs `tokensave init --tier <languageTier>` and writes an initial manifest to `.bober/graph/manifest.json`. Run this once in a fresh checkout.

### Sync the graph
```bash
agent-bober graph sync
```
Re-indexes changed files. Use `--force` for a full re-index regardless of changes.

### Check graph status
```bash
agent-bober graph status
```
Prints whether the graph is ready, how many files are indexed, the tokensave version, and the last synced HEAD SHA.

Use `--json` for machine-readable output:
```bash
agent-bober graph status --json
```

## Step-by-Step: Fresh Setup

1. Verify prerequisites: `agent-bober graph check-prereq`
2. Enable the graph in `bober.config.json`:
   ```json
   { "graph": { "enabled": true } }
   ```
3. Initialise: `agent-bober graph init`
4. Check status: `agent-bober graph status`
5. After committing new code, sync: `agent-bober graph sync`

## Alternatively: Use MCP Tools Directly

If Claude Code is connected to the agent-bober MCP server with `exposeOnExternalMcp: true`, you can use the MCP tools:
- `semantic_search_nodes` — semantic search over the graph
- `query_graph` — trace callers, callees, imports, or test coverage
- `get_impact_radius` — find what a symbol affects
- `get_architecture_overview` — high-level structural summary
- `detect_changes` — risk-scored analysis of recent changes
- `get_review_context` — token-efficient source snippets for review

## Error Handling

- If graph.enabled=false: the commands exit 1 with a message explaining how to enable it
- If tokensave is missing: `graph init` exits 2 with a platform-aware install hint
- If the graph is stale (new commits since last sync): `graph sync` to bring it up to date
