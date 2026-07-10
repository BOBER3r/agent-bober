# In-process scoped subagents (spawn_subagent) + opt-in MCP tool bridge

**Contract:** sprint-spec-20260709-agent-loop-capability-port-10  ·  **Spec:** spec-20260709-agent-loop-capability-port  ·  **Completed:** 2026-07-10

## What this sprint added

The final two capability areas of the spec, both **opt-in** and **default-off / byte-identical when
absent**. (1) **In-process scoped subagents:** `AgenticLoopParams.subagents` registers a single
`spawn_subagent` tool whose handler runs a **nested** `runAgenticLoop` with a **fresh** message
history, a **scoped** tool subset (filtered from the parent's own `tools`/`toolHandlers` by name),
optional per-agent `model`/`effort`/`maxTurns` overrides, and the **SAME parent `Budget` instance** —
so a child's spend is visible in the combined total and a child can never out-spend a parent ceiling.
Only the child's `finalText` returns to the parent (as the tool result), so the parent's context grows
by the summary alone. A child that refuses, exceeds budget, errors, or is aborted comes back as an
`isError` tool result naming the stop reason — **never a throw** — and the parent loop continues.
Children always get `subagents: undefined` (a **one-level hard cap**, mirroring the Workflow rule).
(2) **Opt-in MCP tool bridge:** a new `config.tools.mcpBridge` axis (default `false`) can expose a
configured MCP server's tools as `mcp__`-prefixed loop `ToolDef`s, routed through the repo's existing
`@modelcontextprotocol/sdk` client transport. Disabled (the default) spawns nothing and changes
nothing; the loop itself stays **hermetic** — it never owns MCP lifecycle, so a consumer composes the
bridge in explicitly. This sprint **completes the spec (10/10 sprints, all iteration-1 passes).**

## Public surface

- `SubagentDef` (`src/orchestrator/subagents.ts:32`) — the programmatic subagent declaration:
  `{ name, description, systemPrompt, tools: string[], model?, effort?, maxTurns? }`. `tools` are the
  **parent's tool names** the child is scoped to; `model` is a shorthand (e.g. `"haiku"`) that
  resolves its own client, else the child inherits the parent's client/model; `maxTurns` defaults to
  `10`. Re-exported (type only) from `src/orchestrator/agentic-loop.ts:22`.
- `AgenticLoopParams.subagents?: SubagentDef[]` (`src/orchestrator/agentic-loop.ts:158`) — the loop
  knob. When present and non-empty, `runAgenticLoop` registers `spawn_subagent` into a **local** copy
  of the tool set before deriving `readOnlyTools`; absent/empty leaves `tools`/`toolHandlers` pointing
  at the **same references** as `params.tools`/`params.toolHandlers` (sc-10-4 byte-identity).
- `spawn_subagent` tool (`src/orchestrator/subagents.ts:113`) — input schema `{ name: string, task:
  string }`; the model picks a configured subagent by `name` and passes the `task` text as the child's
  user message. Not marked `readOnly` (a subagent may itself write — ADR-2). Unknown `name` →
  `isError` result listing valid names, **without** running a child loop.
- `buildSubagentTool(defs, parentParams, opts)` (`src/orchestrator/subagents.ts:103`) — builds the
  `{ tool, handler }` pair. `opts.runLoop` (required) injects the loop's own `runAgenticLoop` reference
  to break the runtime import cycle (subagents.ts imports the loop's **types only**);
  `opts.clientFactory` is injectable so `def.model` needs no real provider/API key under test.
- `config.tools.mcpBridge` (`src/config/schema.ts:543` `ToolsSectionSchema`, `:536`
  `McpBridgeServerSchema`) — optional `{ enabled: boolean (default false), server: { command: string,
  args: string[] } }`, attached as `tools?` on `BoberConfigSchema` (`:600`). **Not** added to
  `createDefaultConfig` — the disabled default is byte-identical.
- `createMcpToolBridge(server, opts?)` (`src/orchestrator/tools/mcp-bridge.ts:136`) — starts the
  configured MCP server, lists its tools, and returns `{ tools: ToolDef[], handlers, close() }`. Tools
  are `mcp__`-prefixed (namespace-collision guard) and **never** marked `readOnly` (unknown upstream
  side effects → serial per ADR-2). `opts.clientFactory` injects a stub so tests never spawn a process.
- `runWithMcpBridge(bridge, fn)` (`src/orchestrator/tools/mcp-bridge.ts:191`) — the consumer-side
  composition helper: runs `fn` with the bridge's tools available and closes the MCP connection in a
  `finally` regardless of how `fn` resolves/rejects.
- `McpBridgeClientLike` (`src/orchestrator/tools/mcp-bridge.ts:38`) — injectable MCP-client interface
  (`start`/`listTools`/`callTool`/`close`), satisfied by the real SDK-backed `SdkMcpBridgeClient` and
  by test stubs alike (mirrors `McpServerLike`).

## How to use / how it fits

**Subagents** are a programmatic surface on `runAgenticLoop` (exported from the `agent-bober` barrel).
A parent loop declares one or more subagents; the model delegates a bounded subtask via the
`spawn_subagent` tool:

```ts
import { runAgenticLoop } from "agent-bober";

const result = await runAgenticLoop({
  /* ...client, model, tools, toolHandlers... */
  userMessage: "Research X, then summarize",
  budget: sharedBudget,               // the child charges THIS same instance
  subagents: [
    {
      name: "researcher",
      description: "Reads files and greps to answer a scoped question.",
      systemPrompt: "You are a focused researcher. Return a tight summary.",
      tools: ["read_file", "grep", "glob"], // subset of the PARENT's tool names
      model: "haiku",                       // optional per-agent model
      maxTurns: 6,                          // optional; default 10
    },
  ],
});
```

The child runs with a **fresh** history (no parent turns) and **only** its scoped tools; the parent's
next turn receives the child's `finalText` as the `spawn_subagent` tool result (or an `isError`
summary if it refused / hit budget / errored / was aborted).

**The MCP bridge is not yet wired into any automated call site.** `runAgenticLoop` deliberately never
constructs the bridge (that would break its hermeticity). A **future consumer sprint** is expected to
read `config.tools?.mcpBridge?.enabled === true` at its own call site, build the bridge, merge its
tools/handlers into the loop's params, and wrap the loop in `runWithMcpBridge` for guaranteed
teardown:

```ts
import { createMcpToolBridge, runWithMcpBridge } from "agent-bober/dist/orchestrator/tools/mcp-bridge.js";

if (config.tools?.mcpBridge?.enabled) {
  const bridge = await createMcpToolBridge(config.tools.mcpBridge.server);
  await runWithMcpBridge(bridge, () =>
    runAgenticLoop({ /* ...params, tools: [...tools, ...bridge.tools], toolHandlers: merged... */ }),
  );
}
```

Both features sit alongside the earlier extensions (events/hooks, sessions, compaction, streaming,
interrupt): additive, programmatic-first, and inert until a consumer opts in.

## Notes for maintainers

- **One-level cap is structural, not advisory.** The child's params always set `subagents: undefined`
  (`src/orchestrator/subagents.ts:177`). Recursive subagent nesting is a nonGoal.
- **Child param inherit/exclude table.** The child **inherits** `budget` (same reference),
  `parallelReadOnlyTools`, `abortSignal`, and `maxTokens`; it **excludes** `session`, `compaction`,
  `onEvent`, `hooks`, `onTextDelta`, `initialMessages`, and the `onToolUse`/`onTurnComplete`/
  `completionCheck`/`maxNudges`/`nudgeMessage` callbacks (a fresh, opaque, ephemeral run — passing any
  of these would corrupt the parent's session file, event stream, or streamed text). See
  `src/orchestrator/subagents.ts:159-184` and its unit test's field-by-field table.
- **Import-cycle discipline.** `subagents.ts` imports **only the loop's types**
  (`AgenticLoopParams`/`AgenticLoopResult`); the loop passes its own `runAgenticLoop` reference in via
  `BuildSubagentOpts.runLoop`. Keep the runtime dependency one-directional (agentic-loop.ts →
  subagents.ts) — do not add a value import back the other way.
- **Bridge reuses the existing dependency.** `SdkMcpBridgeClient` wraps the already-present
  `@modelcontextprotocol/sdk` `Client` + `StdioClientTransport` (the same path as
  `src/mcp/external-client.ts`'s `ExternalMcpServer`) — `package.json` was **not** touched; no new dep.
- **Bridge tools call the ORIGINAL upstream name.** The `mcp__` prefix exists only for the loop's own
  tool list; the handler strips it and calls the un-prefixed name on the MCP server
  (`src/orchestrator/tools/mcp-bridge.ts:162-171`). Multi-part text results are joined across all
  `type:'text'` content entries (some servers prepend a staleness/warning line).
- **Barrel-export gap (not a bug).** `runAgenticLoop`/`AgenticLoopParams` are exported from the
  `agent-bober` barrel, so `subagents` is usable via that param. But the **named** `SubagentDef` type,
  `buildSubagentTool`, `createMcpToolBridge`, and `runWithMcpBridge` are **not** in `src/index.ts` — a
  consumer wiring the bridge imports them via a deep path (`.../orchestrator/tools/mcp-bridge.js`). If a
  future consumer sprint promotes these to the public API, add barrel exports then.
- **Hermeticity invariant.** `agentic-loop.ts` never mentions MCP; `claude-code.ts` and the fleet child
  paths are untouched (`--strict-mcp-config` stays). The bridge is never registered on those paths
  (nonGoal #2).

## Spec follow-ups (accumulated, low priority)

Non-blocking advisories surfaced by the evaluators across the spec; recorded here as the spec's
close-out. None gate the completed sprints — each is a durable-test or doc hardening for a future pass:

- **S4 — mixed-batch executor test.** Add a permanent test that a batch mixing read-only and
  write-capable tool calls stays serial across the write boundary (the maximal-contiguous-run split).
- **S5 — executor-level hook-dispatch tests.** Add tests asserting `preToolUse` veto / `postToolUse`
  observe fire correctly at the `executeToolBatch` seam (not only at the loop level).
- **S6 — `store.save`-throws fail-soft test.** Add a durable regression that a throwing
  `SessionStore.save` during `persistSession()` does not crash the loop.
- **S7 — compaction thrash caveat + combined test.** Add a JSDoc caveat about per-request-trigger
  anti-thrash behavior, and a session+compaction combined test (compaction mutating a persisted
  transcript).
- **S8 — streaming + structured-output guard.** The streaming delta-join can differ from the final
  text under forced `tool_choice` / structured output; add a guard/test (currently untested and noted).
- **S9 — session + abort combined test.** Add a permanent regression that all three abort exits
  persist the transcript at the last completed turn with a session enabled (ad-hoc verified only).
- **S10 — MCP bridge consumer wiring.** No automated call site invokes `createMcpToolBridge` yet; a
  future consumer sprint reads `config.tools.mcpBridge.enabled` and composes the bridge into a loop.

## Scope

One commit — `288fc4f` — touching exactly the estimated files: new `src/orchestrator/subagents.ts`
(+ test), new `src/orchestrator/tools/mcp-bridge.ts` (+ test), `src/orchestrator/agentic-loop.ts`
(+ test), `src/config/schema.ts` (+ test). `package.json` untouched (no new dep). +33 tests (subagents
12, mcp-bridge 8, agentic-loop integration 6, schema 6); full suite **3870 → 3903**. All 6 required
criteria (sc-10-1..10-6) passed iteration 1.
