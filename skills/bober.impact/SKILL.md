---
name: bober.impact
description: Analyse the impact radius of a symbol or file in the code graph — which symbols are affected and which tests cover it. Writes a markdown report to .bober/graph/impact/<slug>.md.
argument-hint: <symbol|file>
handoffs:
  - label: "Plan Feature"
    command: /bober-plan
    prompt: "Plan changes to the analysed symbol"
  - label: "Run Sprint"
    command: /bober-sprint
    prompt: "Build changes to the affected code"
---

# bober.impact — Impact Analysis Skill

You are running the **bober.impact** skill. Your job is to analyse the impact radius of a symbol or file — what other symbols depend on it and which tests cover it.

## Usage

```
/bober-impact <symbol|file>
```

Examples:
- `/bober-impact sandboxPath` — analyse a function by name
- `/bober-impact src/graph/client.ts` — analyse a file
- `/bober-impact GraphClient` — analyse a class
- `/bober-impact TokensaveCli.sync` — analyse a method

## What This Skill Produces

A markdown file at `.bober/graph/impact/<slug>.md` with three sections:

```markdown
# Impact: <target>

## Affected symbols
- `<symbol>` (<kind>) — <file>:<line>
...

## Tests covering this symbol
- `<symbol>` (<kind>) — <file>:<line>
...
```

The slug is derived from the target: lowercase, non-alphanumeric characters replaced with `-`, consecutive `-` collapsed, leading/trailing `-` stripped, truncated to 40 characters.

## Running via CLI

```bash
agent-bober impact sandboxPath
```

Output:
```
Starting graph engine...
Analysing impact for: sandboxPath
Impact report written: .bober/graph/impact/sandboxpath.md
  Affected symbols: N
  Test coverage:    N
```

## Running via MCP Tools (Alternative)

You can produce equivalent output directly using MCP tools:

1. Get impact radius: `get_impact_radius` with `{ target: "<symbol>" }`
2. Find test coverage: `query_graph` with `{ pattern: "tests_for", target: { symbol: "<symbol>", ... } }`
3. Format as markdown with the exact section headings:
   - `# Impact: <target>`
   - `## Affected symbols`
   - `## Tests covering this symbol`
4. Write to `.bober/graph/impact/<slug>.md`

## Slug Derivation Rules

```
target.toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')   // non-alphanumeric → -
  .replace(/-+/g, '-')            // collapse consecutive -
  .replace(/^-+|-+$/g, '')        // strip leading/trailing -
  .slice(0, 40)                   // max 40 chars
```

Examples:
- `sandboxPath` → `sandboxpath`
- `src/orchestrator/tools/handlers.ts` → `src-orchestrator-tools-handlers-ts`
- `MyClass.doThing` → `myclass-dothing`
- `__internal__` → `internal`

## Prerequisites

- `graph.enabled: true` in `bober.config.json`
- `tokensave` >= 6.0.0-beta.1 installed
- Graph must be initialised and synced (`agent-bober graph init && agent-bober graph sync`)

## Error Handling

- If graph.enabled=false: exits 1 with instructions to enable it
- If tokensave missing: exits 1 with install hint
- If the symbol is not found in the graph: writes a report noting no affected symbols
