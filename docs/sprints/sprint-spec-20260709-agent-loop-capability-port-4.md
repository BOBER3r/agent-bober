# Parallel read-only tool execution (`ToolDef.readOnly` + `executeToolBatch` + per-role flag)

**Contract:** sprint-spec-20260709-agent-loop-capability-port-4  ·  **Spec:** spec-20260709-agent-loop-capability-port  ·  **Completed:** 2026-07-10

## What this sprint added

The fourth and final **architecture-backed** sprint of the agent-loop capability port replaces the
loop's strictly serial tool-call block with a **delegating executor** that runs *contiguous runs of
read-only-annotated tool calls concurrently* while everything else stays serial. Read-only-ness is a
**`ToolDef.readOnly` annotation** that travels with each tool schema (ADR-2 — the loop never
hard-codes a tool-name allow-list), with a conservative allow-list of exactly `read_file` / `glob` /
`grep` (**`bash` is never annotated**, since a shell command can mutate state). Results always keep
their **original order** and per-tool failures stay **in-slot** — the batch **never rejects**.
Everything is gated by an optional **generator-only `parallelReadOnlyTools` config flag** with **no
default**: absent/`false` is **byte-identical** to the pre-change serial for-await loop.

## Public surface

- `ToolDef.readOnly?: boolean` (`src/providers/types.ts:46`) — optional per-tool annotation. `true`
  marks a side-effect-free tool eligible for concurrent execution. **Absent means "unknown/serial"**
  (never `false`); omitting it keeps every existing tool def byte-identical.
- `readOnly: true` on exactly three schemas — `read_file` (`src/orchestrator/tools/schemas.ts:32`),
  `glob` (`:105`), `grep` (`:127`). `bash`, `write_file`, and `edit_file` stay **unmarked**.
- `executeToolBatch(batch: ToolBatch): Promise<ToolResult[]>` (`src/orchestrator/tools/executor.ts:93`)
  — the new delegating executor. Walks `toolCalls`, groups **maximal contiguous runs** where
  `parallel && readOnlyTools.has(name)` and executes each such run with `Promise.all`; everything
  else runs strictly one-at-a-time. Results are assembled **by original array position**, so the
  returned `ToolResult[]` always matches `toolCalls` order even when a run resolved out of order.
  **Never rejects.**
- `ToolBatch` interface (`src/orchestrator/tools/executor.ts:18`) — `{ toolCalls, toolHandlers,
  readOnlyTools: Set<string>, parallel: boolean, onToolUse? }`.
- `AgenticLoopParams.parallelReadOnlyTools?: boolean` (`src/orchestrator/agentic-loop.ts:44`) — new
  optional loop input; the loop passes `parallel: parallelReadOnlyTools === true` to the executor
  (`:441`) and derives `readOnlyTools` **once** from `params.tools` (`:287`).
- `GeneratorSection.parallelReadOnlyTools?: boolean` (`src/config/schema.ts:133`) —
  `z.boolean().optional()`, **no default injected**. Present **only** on `GeneratorSectionSchema`
  (unlike sprint 3's `effort`/`budget`, which sit on all four role sections). The generator
  conditional-spreads it into `runAgenticLoop` (`src/orchestrator/generator-agent.ts:59,132`), the
  same convention sprint 3 used for `effort`/`budget`.

## How to use / how it fits

Set the flag on the `generator` section in `bober.config.json`:

```jsonc
{
  "generator": {
    "provider": "anthropic",
    "model": "sonnet",
    "parallelReadOnlyTools": true   // read-only tool calls in a turn overlap; default off
  }
}
```

Behaviour when enabled: within a single turn, if the model requests e.g. `[read_file, grep,
read_file, write_file, glob]`, the executor runs the leading `read_file/grep/read_file` run
concurrently (they are contiguous and read-only), then the `write_file` serially (it breaks the
run — writes and mixed batches are **not** parallelized beyond contiguous read-only runs), then the
trailing `glob` serially. The returned `ToolResult[]` is still in `[read_file, grep, read_file,
write_file, glob]` order, keyed by `toolUseId`.

Where it plugs in: `runAgenticLoop` derives the `readOnlyTools` set from the tool schemas it was
configured with and delegates its per-tool block to `executeToolBatch`. The `ToolResultMessage`
append, `onTurnComplete`, and refusal/budget branches are unchanged. With the flag off (or for any
unmarked tool, or a `graph_*`/MCP-bridged tool that has not opted in), the loop runs exactly as it
did before this sprint.

## Notes for maintainers

- **`executeOne` mirrors the old serial block byte-for-byte.** The three result shapes —
  success (`{ toolUseId, content, isError }`), unknown-tool (`Error: Unknown tool "…". Available
  tools: …`), and thrown-handler (`Error: Tool execution failed: …`) — plus the `logger.warn`
  strings were copied from the pre-change loop and diffed against `git show 4ab7040^`. Preserve them
  if you refactor: existing loop tests and callers depend on the exact text.
- **`onToolUse` timing shifted for parallel runs.** For a concurrent run it fires **at dispatch**,
  synchronously and in original order, for the whole run *before any handler settles* (each async
  call runs synchronously up to its first `await`). Existing tests observe presence/args, not strict
  wall-clock interleaving; keep it that way.
- **Never annotate `bash` (or any mutating tool) `readOnly: true`.** ADR-2's risk: a mis-annotated
  mutating tool would allow concurrent interleaved writes. Only the three genuinely side-effect-free
  tools are annotated. `graph_*` and MCP-bridged tools (sprint 10) opt in explicitly later.
- **The flag is generator-only and has no default anywhere.** `createDefaultConfig` omits the key
  (`Object.hasOwn` is `false`); the generator spreads it only when defined. This repo's own
  `bober.config.json` does **not** set it.
- **Follow-up (evaluator advisory, low priority).** There is **no committed regression test** for a
  *mixed* batch with multiple read-only calls flanking a write tool (`[ro, ro, write, ro]`
  segmentation). The evaluator **runtime-probed** the behaviour (observed `maxConcurrent = 2`, no
  merge across the write boundary) and it passed, but a committed test would protect the
  contiguous-run non-goal. Add one in a later sprint.
- **Scope.** Two commits: `4ab7040` (implementation, 9 files: `types.ts`, `schemas.ts`,
  `executor.ts` + test, `agentic-loop.ts` + test, `config/schema.ts`, `generator-agent.ts` + test)
  and `59b4b23` (**test-only** — re-based the sc-4-2 concurrency proof on a same-run relative
  comparison, `parallel < serial * 0.7`, to remove a fixed-ms threshold that flaked under heavy
  shared-machine load; no production code changed). +17 tests (suite 3770 → 3787). All 6 required
  criteria (sc-4-1..4-6) passed iteration 1, zero sprint-caused regressions.
</content>
