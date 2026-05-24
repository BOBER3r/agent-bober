---
name: bober.onboard
description: Generate onboarding documentation from the code graph — architecture overview, hotspots, knowledge gaps, and communities. Writes 5 markdown files to .bober/onboarding/.
handoffs:
  - label: "Analyse Impact"
    command: /bober-impact
    prompt: "Analyse the impact radius of a hotspot symbol"
  - label: "Plan Feature"
    command: /bober-plan
    prompt: "Plan a feature using onboarding context"
---

# bober.onboard — Onboarding Documentation Skill

You are running the **bober.onboard** skill. Your job is to generate a complete set of onboarding documents for this codebase using the code graph.

## What This Skill Produces

Five markdown files in `.bober/onboarding/`:

1. **README.md** — entry point with links to all other documents
2. **architecture-overview.md** — public API per module, sorted alphabetically
3. **hotspots.md** — high-complexity symbols worth reviewing (table with score + reason)
4. **knowledge-gaps.md** — potentially unused (dead code) + public APIs without internal callers
5. **communities.md** — module groupings by community

## Prerequisites

- `graph.enabled: true` in `bober.config.json`
- `tokensave` >= 6.0.0-beta.1 installed
- Graph must be initialised (`agent-bober graph init`)

## Running via CLI

```bash
agent-bober onboard
```

This command:
1. Starts a short-lived tokensave engine
2. Queries the graph for status, hotspots, dead code, circular deps, module APIs, and file inventory
3. Passes results to the OnboardingComposer renderer
4. Writes all 5 files to `.bober/onboarding/`
5. Prints a summary table with file paths and sizes

Expected output:
```
Starting graph engine...
Querying code graph...
Writing artifacts to .bober/onboarding/...

Onboarding artifacts written:

  .bober/onboarding/README.md                     <size> bytes
  .bober/onboarding/architecture-overview.md      <size> bytes
  .bober/onboarding/hotspots.md                   <size> bytes
  .bober/onboarding/knowledge-gaps.md             <size> bytes
  .bober/onboarding/communities.md                <size> bytes

5 files written (<total> bytes total)
```

## Running via MCP Tools (Alternative)

You can also produce equivalent onboarding content directly using the MCP tools:

1. Get architecture overview: `get_architecture_overview`
2. Find hotspots: `semantic_search_nodes` with query `"hotspots high complexity"`
3. Find dead code: `semantic_search_nodes` with query `"dead code unused symbols"`
4. Find communities: `list_communities` (if available) or `get_architecture_overview`

Format the results using the same structure as the generated documents and write to `.bober/onboarding/`.

## Re-running

The command is safe to re-run. Files with the generation marker are updated in-place (preserving any content you wrote above the marker). Files without the marker are refused to prevent overwriting manual edits.

To force a fresh generation, delete the files in `.bober/onboarding/` and re-run.

## Error Handling

- If graph.enabled=false: exits 1 with instructions to enable it
- If tokensave missing: exits 1 with install hint
- If a file lacks the generation marker: exits with an error explaining which file needs attention
