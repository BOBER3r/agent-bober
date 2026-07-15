# Sprint Briefing: In-process scoped subagents (spawn_subagent) + opt-in MCP tool bridge

**Contract:** sprint-spec-20260709-agent-loop-capability-port-10
**Generated:** 2026-07-10T00:40:00Z
**Ambiguity:** 5 (FINAL sprint of the plan)

> This sprint has TWO independent, both-opt-in features. Feature 1 (subagents)
> touches `subagents.ts` + `agentic-loop.ts`. Feature 2 (MCP bridge) touches
> `mcp-bridge.ts` + `config/schema.ts`. They share NO code except the `ToolDef`/
> `ToolHandler` types. Build them separately; the only shared invariant is
> "absent => byte-identical" (sc-10-4).

---

## 0. Key architectural findings (read first)

1. **The repo ALREADY has an SDK-based external-MCP-server bridge** — this is the
   template for Feature 2, NOT the hand-rolled JSON-RPC in `graph/mcp-client.ts`.
   See `src/mcp/external-client.ts` (`ExternalMcpServer`: spawn `{command,args}`
   MCP server → `listTools` → `callTool` → `stop`) and `src/orchestrator/observability/merge.ts`
   (`mergeObsTools` namespaces + merges, `stopAll` closes). The contract's
   reference to `graph/client.ts` is the *conceptual* handshake; the *cleanest
   reuse* is the SDK path already proven in sprint 16. The `@modelcontextprotocol/sdk`
   dep is `^1.28.0` (package.json:64).
2. **The repo's established test idiom for MCP is to inject an MCP-client-like
   interface**, NOT a raw SDK Transport. See `McpServerLike` at
   `src/vault/mcp-adapter.ts:31-37` (`{ start; listTools; callTool; stop }`) and
   the same shape at `src/hub/gmail-to-task.ts:28` and `src/calendar/google-connector.ts:34`.
   Mirror this: accept an injectable factory so tests record initialize/list/call/close
   with zero real spawn.
3. **`runAgenticLoop` is re-entrant and pure over its params** (agentic-loop.ts:368).
   Nesting is safe: the child gets its own params object and shares ONLY the
   `Budget` reference. `finish()` (agentic-loop.ts:455) is the single exit and the
   loop NEVER throws — it always resolves an `AgenticLoopResult`.
4. **Tools flow from the CALLER into the loop** (generator-agent.ts:65,121-127):
   `resolveRoleTools(...)` builds `{schemas, handlers}`, passed as `tools`/`toolHandlers`.
   The loop derives `readOnlyTools` from `tools` (agentic-loop.ts:400-402) and forwards
   `tools` to `chat` (agentic-loop.ts:518).

---

## 1. Target Files

### src/orchestrator/subagents.ts (create)

**Directory pattern:** peers in `src/orchestrator/` are kebab/lowerCamel single-file
modules (`agentic-loop.ts`, `compaction.ts`, `session-store.ts`, `loop-events.ts`).
**Most similar existing file:** `src/orchestrator/loop-events.ts` (a small typed
companion to the loop) for structure; the child-param-assembly logic mirrors the
caller assembly in `generator-agent.ts:55-74,121-132`.

**Structure template:**
```ts
import type { LLMClient, ToolDef } from "../providers/types.js";
import type { ToolHandler } from "./tools/index.js";
import type { AgenticLoopParams, AgenticLoopResult } from "./agentic-loop.js"; // TYPE-ONLY — see Pitfall 1
import { resolveModel } from "./model-resolver.js";
import { createClient } from "../providers/factory.js";

// ── Types ───────────────────────────────────────────────────────────
export interface SubagentDef {
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];        // subset of parent tool NAMES to expose
  model?: string;         // shorthand ("sonnet"/"haiku"/...) — resolved via model-resolver
  effort?: AgenticLoopParams["effort"];
  maxTurns?: number;
}

export interface BuildSubagentOpts {
  /** REQUIRED to break the import cycle — the loop passes runAgenticLoop; tests pass a fake. */
  runLoop: (p: AgenticLoopParams) => Promise<AgenticLoopResult>;
  /** Injected for tests so def.model needs no real provider/API key. Default = createClient(...). */
  clientFactory?: (model: string) => LLMClient;
}

// ── Builder ─────────────────────────────────────────────────────────
export function buildSubagentTool(
  defs: SubagentDef[],
  parentParams: AgenticLoopParams,
  opts: BuildSubagentOpts,
): { tool: ToolDef; handler: ToolHandler } { /* ... see §4 for the exact assembly ... */ }
```

---

### src/orchestrator/tools/mcp-bridge.ts (create)

**Directory pattern:** `src/orchestrator/tools/` holds `schemas.ts`, `handlers.ts`,
`executor.ts`, `index.ts`.
**Most similar existing file:** `src/mcp/external-client.ts` (`ExternalMcpServer`)
for the client lifecycle; `src/orchestrator/observability/merge.ts` for the
prefix-and-merge + `stopAll`-in-finally pattern.

**Structure template (SDK path, with injectable client for tests):**
```ts
import type { ToolDef, JsonSchemaObject } from "../../providers/types.js";
import type { ToolHandler } from "./handlers.js";

/** Minimal MCP-client interface — satisfied by ExternalMcpServer AND test stubs.
 *  Mirrors McpServerLike (src/vault/mcp-adapter.ts:31-37). */
export interface McpBridgeClientLike {
  start(): Promise<void>;                                  // = initialize/connect
  listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>>;
  callTool(name: string, args: unknown): Promise<unknown>;
  close(): Promise<void>;
}

export interface McpToolBridge {
  tools: ToolDef[];
  handlers: Map<string, ToolHandler>;
  close(): Promise<void>;
}

export async function createMcpToolBridge(
  server: { command: string; args?: string[] },
  opts?: { clientFactory?: (s: { command: string; args: string[] }) => McpBridgeClientLike },
): Promise<McpToolBridge> { /* start → listTools → map to ToolDef ('mcp__' prefix) → handlers */ }

/** close() in a finally at loop end — see §Design (d). */
export async function runWithMcpBridge<T>(bridge: McpToolBridge, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } finally { await bridge.close(); }
}
```

---

### src/orchestrator/agentic-loop.ts (modify)

**Add `subagents?` to `AgenticLoopParams`** (after the `abortSignal?` field, agentic-loop.ts:144):
```ts
  /**
   * Opt-in in-process scoped subagents (sprint 10). When non-empty, a
   * `spawn_subagent` ToolDef is registered whose handler runs a NESTED
   * runAgenticLoop with fresh context, the def's scoped tool subset, per-agent
   * model/effort/maxTurns, and the SAME Budget instance. One-level cap: children
   * get `subagents: undefined`. Absent/empty => the tool list is byte-identical (sc-10-4).
   */
  subagents?: SubagentDef[];
```
Add the import at the top (value import — see Pitfall 1):
`import { buildSubagentTool, type SubagentDef } from "./subagents.js";`
Re-export the type near the loop's other exports: `export type { SubagentDef } from "./subagents.js";`

**Register the tool at the top of `runAgenticLoop`, BEFORE `readOnlyTools` is derived**
(current code destructures `tools`/`toolHandlers` as const at agentic-loop.ts:371-395,
then derives `readOnlyTools` at 400-402). Change so `tools`/`toolHandlers` become
locally-augmentable:
```ts
  // after destructuring params:
  let tools = params.tools;
  let toolHandlers = params.toolHandlers;
  if (params.subagents && params.subagents.length > 0) {
    const { tool, handler } = buildSubagentTool(params.subagents, params, {
      runLoop: runAgenticLoop,          // breaks the cycle; hoisted fn ref
    });
    tools = [...params.tools, tool];
    toolHandlers = new Map(params.toolHandlers);
    toolHandlers.set(tool.name, handler);
  }
```
When `subagents` is absent/empty, `tools === params.tools` (same reference) →
`readOnlyTools` set and every `chat` call are byte-identical (sc-10-4).

**Imports this file already uses:** `ToolDef/ToolCall/ToolResult/Message` from
`../providers/types.js`; `ToolHandler` from `./tools/index.js`; `Effort` from
`../config/schema.js`; `Budget` from `./workflow/budget.js`.
**Imported by (callers of runAgenticLoop):** `generator-agent.ts`, `evaluator-agent.ts`,
`planner-agent.ts`, `curator-agent.ts`, `architect-agent.ts`, `documenter-agent.ts`,
`code-reviewer-agent.ts`, `research-agent.ts`, `pipeline.ts`, `compaction.ts`, `index.ts`.
None pass `subagents` today → all remain byte-identical.
**Test file:** `src/orchestrator/agentic-loop.test.ts` (exists, 1770 lines).

---

### src/config/schema.ts (modify)

**Add a `ToolsSectionSchema`** near the other opt-in sections (e.g. after
`ResearchSectionSchema`, schema.ts:520-531) and attach it `.optional()` to
`BoberConfigSchema` (schema.ts:535-574). Do NOT add it to `createDefaultConfig`'s
`base` (schema.ts:604-654) — absent by default keeps config byte-identical.
See §4(e) for the exact schema.
**Test file:** the repo's config tests live under `src/config/`; add coverage there
if the Generator adds a bridge-config test (the sprint's own bridge test can also
construct the schema inline).

---

## 2. Patterns to Follow

### Pattern A — Opt-in section, default-off, `.optional()` on the root (egress-axis idiom)
**Source:** `src/config/schema.ts:522-531` (research) and `426-453` (medical)
```ts
export const ResearchSectionSchema = z.object({
  egress: z
    .object({ onlineResearch: z.boolean().default(false) })
    .optional(),
});
export type ResearchSection = z.infer<typeof ResearchSectionSchema>;
```
Attached at `schema.ts:573`: `research: ResearchSectionSchema.optional(),` and
absent from `createDefaultConfig`.
**Rule:** New config axes are `z.boolean().default(false)` inside an `.optional()`
section, attached `.optional()` to the root, and NEVER added to `createDefaultConfig` —
that is what makes "disabled by default = byte-identical" true.

### Pattern B — External MCP server: spawn → listTools → callTool → close
**Source:** `src/mcp/external-client.ts:42-103`
```ts
this.transport = new StdioClientTransport({
  command: this.provider.mcpCommand,
  args: this.provider.mcpArgs ?? [],
  env: { ...(process.env as Record<string,string>), ...(this.provider.mcpEnv ?? {}) },
  stderr: "pipe",
});
this.client = new Client({ name: "agent-bober-obs-client", version: "0.13.0" }, { capabilities: {} });
await this.client.connect(this.transport);
// ...
const res = await this.client.listTools();           // { tools: [{name, description, inputSchema}] }
// ...
return await this.client.callTool({ name, arguments: (args as Record<string,unknown>) ?? {} });
```
**Rule:** Use the SDK `Client` + `StdioClientTransport`; the SDK performs the
`initialize`/`tools/list`/`tools/call` handshake for you. Do NOT hand-roll JSON-RPC.

### Pattern C — Injectable MCP-client interface for tests (no real spawn)
**Source:** `src/vault/mcp-adapter.ts:31-37`
```ts
export interface McpServerLike {
  start(): Promise<void>;
  listTools(): Promise<ToolDescriptor[]>;
  callTool(name: string, args: unknown): Promise<unknown>;
  stop(): Promise<void>;
}
```
**Rule:** Depend on a small interface, not the concrete `ExternalMcpServer`/SDK
`Client`. Default the factory to the real SDK client; tests pass a recording stub.

### Pattern D — Unwrap an SDK `callTool` result (`content[].text`)
**Source:** `src/incident/resolution-verify.ts:250-274` and `src/graph/mcp-client.ts:79-100`
```ts
// The MCP SDK callTool returns { content: [{type:'text', text:...}], isError }.
const candidate = raw as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
const text = (candidate.content ?? []).filter(c => c?.type === "text").map(c => c.text ?? "").join("");
```
**Rule:** A bridged tool handler joins the `type:"text"` content entries into a
string and maps SDK `isError` onto `ToolHandler`'s `isError`.

### Pattern E — Namespaced tool merge (prefix to avoid collisions)
**Source:** `src/orchestrator/observability/merge.ts:55-57,100-106`
```ts
export function namespaceToolName(providerName: string, toolName: string): string {
  return `obs__${providerName}__${toolName}`;
}
```
**Rule:** Bridged tools get a `mcp__` name prefix (contract). Store the upstream
name so the handler calls `callTool` with the ORIGINAL name, not the prefixed one.

### Pattern F — `ToolDef` JSON-schema declaration idiom
**Source:** `src/orchestrator/tools/schemas.ts:9-28` (bashTool) and `30-54` (readFileTool)
```ts
export const readFileTool: ToolDef = {
  name: "read_file",
  readOnly: true,                                   // OMIT this for spawn_subagent + mcp__ tools
  description: "Read a file's contents. ...",
  input_schema: {
    type: "object" as const,
    properties: { file_path: { type: "string", description: "..." } },
    required: ["file_path"],
  },
};
```
**Rule:** `type: "object" as const`, `properties` with `{ type, description }`,
`required: [...]`. Do NOT set `readOnly` on `spawn_subagent` or `mcp__` tools
(unknown side effects → serial per ADR-2; loop only parallelizes `readOnly === true`,
agentic-loop.ts:400-402).

### Pattern G — Adapt a foreign tool descriptor → ToolDef + ToolHandler
**Source:** `src/orchestrator/tools/index.ts:222-243` (graph tools → ToolDef/ToolHandler)
```ts
const graphSchemas: ToolDef[] = graphBobTools.map((t) => ({
  name: t.name, description: t.description, input_schema: t.inputSchema as ToolDef["input_schema"],
}));
const graphHandlerMap = new Map<string, ToolHandler>(graphBobTools.map((t) => [
  t.name,
  async (input) => {
    try { const output = await t.handler(input); return { output, isError: false }; }
    catch (err) { return { output: err instanceof Error ? err.message : String(err), isError: true }; }
  },
]));
```
**Rule:** This is the exact shape to mirror for `mcp__` tools: map descriptor→ToolDef,
wrap the call in a try/catch returning `{ output, isError }` (never throw from a handler).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---|---|---|---|
| `createClient` | `src/providers/factory.ts:192` | `(provider?, endpoint?, providerConfig?, model?, role?) => LLMClient` | Build a provider-agnostic client; infers provider from model shorthand when `provider` omitted. Use for `def.model` child client. |
| `resolveModel` | `src/orchestrator/model-resolver.ts:106` | `(choice: string) => string` | Shorthand → provider-native model ID (e.g. `"sonnet"→"claude-sonnet-4-6"`). Use for the child loop's `model`. |
| `resolveProviderModel` | `src/orchestrator/model-resolver.ts:61` | `(model, explicitProvider?) => {provider, modelId, endpoint?}` | Full resolution incl. endpoint (Grok/DeepSeek/Ollama). `SHORTHAND_MAP` at model-resolver.ts:22. |
| `runAgenticLoop` | `src/orchestrator/agentic-loop.ts:368` | `(params: AgenticLoopParams) => Promise<AgenticLoopResult>` | The nested loop the subagent handler awaits. Pass as `runLoop`. |
| `Budget` (`.chargeTokens/.chargeUsd/.exceeded/.usdSpent/.tokensSpent`) | `src/orchestrator/workflow/budget.ts:40-113` | shared-by-reference accountant | Pass `parentParams.budget` (SAME instance) to the child so spend is combined (sc-10-2). |
| `ExternalMcpServer` | `src/mcp/external-client.ts:30` | `class` w/ `start/listTools/callTool/stop` | The SDK-backed MCP client to wrap (or mirror) for the bridge. |
| `McpServerLike` | `src/vault/mcp-adapter.ts:31` | interface `{start,listTools,callTool,stop}` | The inject-for-tests interface to reuse/mirror. |
| `namespaceToolName` | `src/orchestrator/observability/merge.ts:55` | `(provider, tool) => string` | Reference for the prefix convention (bridge uses `mcp__` instead of `obs__<name>__`). |
| `ToolHandler` (type) | `src/orchestrator/tools/handlers.ts:21` | `(input: Record<string,unknown>) => Promise<{output:string; isError:boolean}>` | The exact return shape every handler must produce. |
| `ToolDef` / `JsonSchemaObject` (types) | `src/providers/types.ts:37,19` | interfaces | Provider-agnostic tool schema; `readOnly?` at types.ts:46. |
| `budgetFromMaxUsd` | `src/orchestrator/workflow/budget.ts:148` | `(maxUsd) => Budget \| undefined` | Not needed here (child shares the parent Budget), but do not build a new Budget for the child. |

Directories reviewed for reuse: `src/orchestrator/tools/`, `src/mcp/`, `src/providers/`,
`src/orchestrator/observability/`, `src/vault/`, `src/graph/`, `src/orchestrator/workflow/`.

---

## 4. Critical Design Decisions (resolved with evidence)

### (a) Child client when `def.model` is set — RECOMMENDATION: injectable `clientFactory`, default = `createClient`
The caller builds clients via `createClient(provider, endpoint, providerConfig, modelShorthand)`
(generator-agent.ts:69-74) and the loop's `model` via `resolveModel(shorthand)`
(generator-agent.ts:55). Mirror that for the child:
- `def.model` set → `client = opts.clientFactory(def.model)`, `model = resolveModel(def.model)`.
- `def.model` absent → inherit `parentParams.client` and `parentParams.model`.
- Default `clientFactory = (m) => createClient(undefined, undefined, undefined, m)`
  (provider inferred from the shorthand via `resolveProviderModel`, model-resolver.ts:80-92).
**Tradeoff:** the default reuses the real factory (needs a resolvable provider + API
key at spawn). Making `clientFactory` injectable lets `subagents.test.ts` supply a
fake child `LLMClient` (the ScriptedLoopClient, agentic-loop.test.ts:22) so tests never
construct a real provider. This matches the repo's inject-for-tests idiom (Pattern C).

### (b) EXACT child `AgenticLoopParams` assembly
| Field | Value | Justify |
|---|---|---|
| `client` | `def.model ? clientFactory(def.model) : parentParams.client` | per-agent model override (sc-10-2) |
| `model` | `def.model ? resolveModel(def.model) : parentParams.model` | resolved ID for the adapter |
| `systemPrompt` | `def.systemPrompt` | FRESH role prompt (sc-10-1) |
| `userMessage` | `task` (from tool input) | the delegated task |
| `tools` | `parentParams.tools.filter(t => def.tools.includes(t.name))` | scoped subset; child sees ONLY these (sc-10-1) |
| `toolHandlers` | `new Map([...parentParams.toolHandlers].filter(([n]) => def.tools.includes(n)))` | handlers for the scoped subset |
| `maxTurns` | `def.maxTurns ?? 10` | per-agent override w/ sane default (generatorNotes) |
| `effort` | `def.effort` | per-agent effort (sprint 3 dependsOn); omit key when undefined |
| `budget` | **`parentParams.budget` (SAME instance)** | combined spend; child cannot out-spend parent ceiling (sc-10-2) |
| `parallelReadOnlyTools` | **inherit** `parentParams.parallelReadOnlyTools` | RECOMMEND inherit — pure read-only perf flag, safe |
| `abortSignal` | **inherit** `parentParams.abortSignal` | RECOMMEND inherit — aborting the parent must cancel in-flight child (S9, agentic-loop.ts:144) |
| `maxTokens` | inherit `parentParams.maxTokens` | harmless; keeps per-message cap consistent |
| `subagents` | **`undefined`** | HARD one-level cap (nonGoal #1) |
| `session` | **EXCLUDE** | keyed by sessionId; sharing would overwrite the parent's session file (session-store, agentic-loop.ts:421-439). Child is ephemeral. |
| `compaction` | **EXCLUDE** | parent-context concern; child is fresh + bounded (maxTurns 10) |
| `onEvent` | **EXCLUDE** | child turn numbers reset; would corrupt the parent's event stream. Parent sees only spawn_subagent's own tool-start/tool-end (agentic-loop.ts:730-740) |
| `hooks` | **EXCLUDE** | parent veto/observe hooks operate on parent toolUseIds; child is opaque |
| `onTextDelta` | **EXCLUDE** | child deltas would stream into the parent's callback and corrupt parent text (agentic-loop.ts:502-508) |
| `onToolUse`/`onTurnComplete`/`completionCheck`/`maxNudges`/`nudgeMessage` | **EXCLUDE** | parent-progress callbacks; `completionCheck` is generator-JSON-specific and would wrongly nudge the child |
| `initialMessages` | **EXCLUDE** | the whole point is fresh context — no parent turns (sc-10-1) |

**Result → tool result mapping** (handler returns `{output, isError}`; never throws):
```ts
const r = await runLoop(childParams);
if (r.refused || r.stopReason === "refusal")        return { output: `Subagent '${name}' refused: ${r.finalText}`, isError: true };
if (r.stopReason === "budget_exceeded")             return { output: `Subagent '${name}' stopped: budget_exceeded. ${r.finalText}`, isError: true };
if (r.stopReason === "error" || r.stopReason === "aborted")
                                                    return { output: `Subagent '${name}' ${r.stopReason}: ${r.finalText}`, isError: true };
return { output: r.finalText, isError: false };
```
Unknown `name` (before running anything): `{ output: "Unknown subagent 'X'. Valid: a, b, c", isError: true }` (sc-10-3).

### (c) Where `spawn_subagent` is registered — RECOMMENDATION: INSIDE `runAgenticLoop`
Register at the top of `runAgenticLoop` when `params.subagents?.length` (see §1 code).
Rationale: the handler needs `parentParams` = the loop's own `params`, which only the
loop has; and callers get the capability for free by passing `subagents`. Byte-identical
when absent because `tools`/`toolHandlers` keep their original reference (sc-10-4).
Pass `runLoop: runAgenticLoop` into `buildSubagentTool` (the function is hoisted, so the
self-reference is valid) — this is what lets `subagents.ts` avoid a runtime import of
`agentic-loop.ts` and thus breaks the import cycle (Pitfall 1).

### (d) MCP-bridge lifecycle — RECOMMENDATION: the loop does NOT own the bridge; a composition helper does
The bridge is created by the CONSUMER (reads `config.tools.mcpBridge.enabled`), so the
loop must stay hermetic (nonGoal #2). Precedent: `resolution-verify.ts:219-240` and
`deploy/spawn.ts:75` create servers via `mergeObsTools`, use them in a `try`, and call
`stopAll(servers)` in a `finally`. Mirror that with `runWithMcpBridge(bridge, fn)`
(§1 template): `try { return await fn(); } finally { await bridge.close(); }`.
The caller does: build toolset → if `config.tools?.mcpBridge?.enabled` then
`bridge = await createMcpToolBridge(config.tools.mcpBridge.server)` and merge
`bridge.tools`/`bridge.handlers` into the toolset → `runWithMcpBridge(bridge, () => runAgenticLoop({... tools, toolHandlers ...}))`.
"close() at loop end (finally)" is satisfied because `runAgenticLoop` resolves exactly
once (its `finish()` single-exit, agentic-loop.ts:455) and the `finally` fires after it.
Only construct the bridge when `enabled === true` at the CALL SITE — never at config parse.
**Tradeoff vs. threading the bridge into the loop:** passing the bridge into `runAgenticLoop`
would let the loop own the `finally`, but it breaks loop hermeticity and forces every
caller to know about MCP. The composition helper keeps the loop pure and is directly
testable (the bridge test drives `runWithMcpBridge` with a stub and asserts `close()`
was called once).

### (e) `spawn_subagent` input schema + `ToolsSectionSchema` (exact shapes)
`spawn_subagent` ToolDef (Pattern F idiom; NOT readOnly):
```ts
{
  name: "spawn_subagent",
  description: "Delegate a bounded subtask to a fresh-context subagent. Pass the "
    + "configured subagent `name` and the `task` text. The subagent runs with only "
    + "its own scoped tools and returns a summary as this tool's result.",
  input_schema: {
    type: "object" as const,
    properties: {
      name: { type: "string", description: "Configured subagent to run. Valid names: " + defs.map(d => d.name).join(", ") },
      task: { type: "string", description: "The task/instruction passed as the subagent's user message." },
    },
    required: ["name", "task"],
  },
}
```
`ToolsSectionSchema` (config/schema.ts — Pattern A idiom):
```ts
// ── Tools Section (Sprint 10 — opt-in MCP tool bridge, default off) ──
export const McpBridgeServerSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
});
export const ToolsSectionSchema = z.object({
  mcpBridge: z
    .object({
      enabled: z.boolean().default(false),
      server: McpBridgeServerSchema,
    })
    .optional(),
});
export type ToolsSection = z.infer<typeof ToolsSectionSchema>;
```
Attach at BoberConfigSchema (after `research:`, schema.ts:573):
`tools: ToolsSectionSchema.optional(),`. Do NOT touch `createDefaultConfig`.

---

## 5. Prior Sprint Output (dependsOn)

### Sprint 3 (hard dependsOn): per-message `effort` on `ChatParams`
**Created:** `EffortSchema` (`src/config/schema.ts:40`, `type Effort`), `ChatParams.effort`
(`src/providers/types.ts:162`), `AgenticLoopParams.effort` (agentic-loop.ts:40), and the
`Budget` USD ceiling wiring (`budgetFromMaxUsd`, budget.ts:148).
**Connection:** `SubagentDef.effort` rides `ChatParams.effort`; the child loop forwards
`effort` exactly as the parent does (agentic-loop.ts:520). Only the Anthropic adapter
honors it; others ignore it (types.ts:159-162).

### Sprint 9: `abortSignal`
**Created:** `AgenticLoopParams.abortSignal` (agentic-loop.ts:144), `AbortedError`
(agentic-loop.ts:219), and the graceful `stopReason:"aborted"` return.
**Connection:** the child inherits `parentParams.abortSignal` so a parent abort ends the
child at its next boundary; a child that returns `stopReason:"aborted"` surfaces as an
`isError` tool result (§4b).

### Sprints 5-8: events/hooks/session/compaction/streaming
All optional `AgenticLoopParams` fields (agentic-loop.ts:93-130). The child EXCLUDES them
(§4b). These are the fields whose absence keeps the child hermetic.

---

## 6. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM everywhere** — all imports use `.js` extensions (NodeNext). (principles.md:27)
- **Provider-agnostic interfaces** — never leak SDK types outside adapter files.
  The bridge wraps `@modelcontextprotocol/sdk` types INSIDE `mcp-bridge.ts` behind the
  `McpBridgeClientLike` interface; do not re-export SDK types. (principles.md:28,41)
- **Zod for config** — the `ToolsSectionSchema` must be a Zod schema in `config/schema.ts`. (principles.md:29)
- **`import type` for types** — `consistent-type-imports` is enforced; the
  `AgenticLoopParams`/`AgenticLoopResult` import in `subagents.ts` MUST be `import type`. (principles.md:35)
- **Section comments** — use `// ── Name ──────` unicode box headers. (principles.md:32)
- **Prefix unused params with `_`.** (principles.md:36)
- **Tests collocated `*.test.ts`, Vitest, temp dirs for fs (no fs mocks).** (principles.md:20,44)

### Architecture Decisions
- **ADR-2 (conservative serial default):** only `readOnly === true` tools parallelize
  (agentic-loop.ts:397-402). `spawn_subagent` and `mcp__` tools are NOT readOnly → serial.
  (`.bober/architecture/` ADRs; nonGoal #3.)
- **ADR-4 (budget ends gracefully, never throws):** the loop charges the Budget per turn
  and returns `budget_exceeded` (agentic-loop.ts:577-578,632-648). A shared child Budget
  therefore stops the child at the same ceiling — no throw.

### Other Docs
No new dependency is introduced — `@modelcontextprotocol/sdk@^1.28.0` (package.json:64)
and `execa`/`glob` (already deps) cover everything. grammy/SDK lock-in rules do not apply
because the SDK is used inside `mcp-bridge.ts` behind an interface.

---

## 7. Testing Patterns

### Unit test pattern
**Source:** `src/orchestrator/agentic-loop.test.ts:22-34`
```ts
class ScriptedLoopClient implements LLMClient {
  private idx = 0;
  callCount = 0;
  lastParams?: ChatParams;
  constructor(private readonly responses: ChatResponse[]) {}
  async chat(params: ChatParams): Promise<ChatResponse> {
    this.callCount += 1;
    this.lastParams = params;
    const r = this.responses[Math.min(this.idx, this.responses.length - 1)];
    this.idx += 1;
    return r;
  }
}
const base = { toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
```
**Runner:** vitest (`package.json:16 "test": "vitest"`). **Assertions:** `expect(...)`.
**File naming:** co-located `*.test.ts`. **Mocks:** hand-rolled classes implementing
`LLMClient`; `vi` only for spies. **Temp dirs:** `mkdtemp(join(tmpdir(), ...))` +
`rm(..., {recursive:true})` in `afterEach` (agentic-loop.test.ts:865-871).

### Test recipe — parent/child distinction by system prompt (sc-10-1)
A single scripted client can branch on `params.system` to act as parent vs child, or use
one client per role. Parent scripts a `spawn_subagent` tool_use; the child client asserts
its FIRST request carries ONLY the scoped tool defs and NO parent messages:
```ts
let childFirstParams: ChatParams | undefined;
const client = new (class implements LLMClient {
  async chat(p: ChatParams): Promise<ChatResponse> {
    if (p.system === "PARENT-PROMPT") {
      // turn 1: ask to spawn; turn 2 (after tool result): finish
      return /* tool_use spawn_subagent {name:'writer', task:'do X'} then 'end' */;
    }
    // child (system === def.systemPrompt)
    childFirstParams ??= p;                 // record the child's first request
    return { text: "child summary", toolCalls: [], stopReason: "end", usage: {inputTokens:2,outputTokens:2} };
  }
})();
// after run: assert childFirstParams.tools are ONLY the scoped subset,
// childFirstParams.messages === [{role:'user', content:'do X'}]  (fresh, no parent turns),
// and the parent's 2nd request's last tool result === "child summary".
```
Note the ScriptedLoopClient repeats its LAST response once exhausted (test:30) — for a
shared client, script enough distinct turns or key off `p.system`.

### Test recipe — shared Budget ceiling crossing (sc-10-2/sc-10-3)
```ts
const budget = new Budget({ maxUsd: 0.01 });     // src/orchestrator/workflow/budget.ts:40
// parent + child both charge THIS instance; set the child's scripted response
// costUsd high enough to cross → child returns stopReason:"budget_exceeded",
// parent sees an isError tool result naming it; assert budget.usdSpent includes child turns.
```
The loop charges `budget.chargeUsd(response.costUsd ?? 0)` per turn (agentic-loop.ts:578)
and returns `budget_exceeded` at agentic-loop.ts:632-648. (`ChatResponse.costUsd` is
optional, types.ts:266.)

### Test recipe — MCP bridge with a stub client (sc-10-5)
Inject `clientFactory` returning a recording stub implementing `McpBridgeClientLike`:
```ts
const calls: string[] = [];
const stub: McpBridgeClientLike = {
  async start() { calls.push("start"); },
  async listTools() { calls.push("listTools"); return [{ name: "echo", description: "e", inputSchema: { type: "object", properties: {} } }]; },
  async callTool(name, args) { calls.push(`callTool:${name}`); return { content: [{ type: "text", text: "ok" }] }; },
  async close() { calls.push("close"); },
};
const bridge = await createMcpToolBridge({ command: "x", args: [] }, { clientFactory: () => stub });
// assert bridge.tools[0].name === "mcp__echo", bridge.tools[0].readOnly === undefined
// (Object.hasOwn(bridge.tools[0], "readOnly") === false),
// a handler round-trips ("ok"), then runWithMcpBridge(bridge, async()=>{}) → calls ends with "close" exactly once.
```

### Test recipe — double off-by-default (sc-10-4)
```ts
// no subagents: run once with and once without → deep-equal the tool list the client saw.
// default config: assert the injected clientFactory / transport factory was NEVER called
// (spy fn, expect(spy).not.toHaveBeenCalled()) — nothing spawned. (cf. calendar test:94,133.)
```

---

## 8. Impact Analysis — Affected Features, Files & Tests

### Files that may break
| File | Depends on | Risk | What to check |
|---|---|---|---|
| `src/orchestrator/agentic-loop.ts` (11 callers) | new `subagents?` field + tool-registration branch | **medium** | All existing callers omit `subagents` → the `tools`/`toolHandlers` local must keep the SAME reference when absent so `readOnlyTools` + every `chat` call is byte-identical. |
| `src/config/schema.ts` (all config consumers) | new optional `tools:` root key | **low** | `.optional()` + absent from `createDefaultConfig` → `BoberConfigSchema.parse` of any existing config is unchanged. |
| `src/orchestrator/generator-agent.ts` and other 10 loop callers | pass params to `runAgenticLoop` | **low** | They never set `subagents`; verify no accidental required-field breakage on `AgenticLoopParams`. |
| `src/orchestrator/tools/index.ts` (`ToolHandler` re-export) | bridge imports `ToolHandler` | **low** | Import `ToolHandler` from `./handlers.js` (index.ts:5,14) — the canonical source. |

### Existing tests that must still pass
- `src/orchestrator/agentic-loop.test.ts` (1770 lines) — covers refusal (sc-1-x),
  effort forwarding (sc-3-2), sessions, compaction, streaming, budget. The subagents
  change MUST NOT alter any of these; the "no subagents ⇒ byte-identical tool list"
  invariant is the guard.
- `src/mcp/external-client.test.ts` — `ExternalMcpServer` behavior (start/listTools/callTool/not-started).
- `src/orchestrator/observability/merge.test.ts` — `mergeObsTools`/`stopAll`/`namespaceToolName`.
- `src/config/schema` tests (config parse/defaults) — the new optional section must not
  change existing parsed output.
- `src/vault/mcp-adapter.test.ts`, `src/hub/gmail-to-task.test.ts`,
  `src/calendar/google-connector.test.ts` — confirm the injectable-MCP idiom you mirror
  still compiles against `McpServerLike`.

### Features that could be affected
- **Observability MCP (sprint 16)** — shares `@modelcontextprotocol/sdk` + `StdioClientTransport`.
  Reuse the SDK path but do NOT modify `external-client.ts`/`merge.ts`; add the bridge as a
  NEW module. Verify obs tests stay green.
- **Fleet / claude-code child path** — nonGoal #2: do NOT register the bridge on the
  hermetic claude-code child path or fleet children. The bridge is only wired where a
  consumer explicitly reads `config.tools.mcpBridge.enabled`.

### Recommended regression checks (runnable)
1. `npm run typecheck` (`tsc --noEmit`) — zero errors (strict mode, principles.md:18).
2. `npm run build` (`tsc`) — clean (sc-10-6).
3. `npx vitest run src/orchestrator/agentic-loop.test.ts src/orchestrator/subagents.test.ts src/orchestrator/tools/mcp-bridge.test.ts` — new + loop tests.
4. `npx vitest run src/mcp src/orchestrator/observability src/config` — MCP/config regression.
5. `npm test` (full suite; baseline 3870 green) — nothing regresses.

---

## 9. Implementation Sequence (dependency-ordered)

1. **`src/config/schema.ts`** — add `McpBridgeServerSchema` + `ToolsSectionSchema` + `type ToolsSection`;
   attach `tools: ToolsSectionSchema.optional()` to `BoberConfigSchema`. Do NOT touch `createDefaultConfig`.
   - Verify: `npm run typecheck`; a quick `BoberConfigSchema.parse({...existing})` yields no `tools` key.
2. **`src/orchestrator/tools/mcp-bridge.ts`** — `McpBridgeClientLike`, `McpToolBridge`,
   `createMcpToolBridge` (start→listTools→map to `mcp__`-prefixed ToolDef, NOT readOnly;
   handler unwraps `content[].text` + maps `isError`), `runWithMcpBridge`. Default clientFactory
   wraps SDK `Client`+`StdioClientTransport` behind the interface.
   - Verify: bridge unit test with the stub client (§7) passes; `readOnly` absent on bridged tools.
3. **`src/orchestrator/subagents.ts`** — `SubagentDef`, `BuildSubagentOpts`, `buildSubagentTool`
   (unknown-name guard → isError; child param assembly per §4b; result→tool-result mapping per §4b).
   `import type` for `AgenticLoopParams`/`AgenticLoopResult` (no runtime import of the loop).
   - Verify: `buildSubagentTool` returns `{ tool, handler }`; handler with an injected fake
     `runLoop` returns `{output, isError}` and never throws.
4. **`src/orchestrator/agentic-loop.ts`** — add `subagents?: SubagentDef[]` to `AgenticLoopParams`;
   `import { buildSubagentTool } from "./subagents.js"` + `export type { SubagentDef }`; register the
   tool at the top of `runAgenticLoop` when `params.subagents?.length` (augment local `tools`/`toolHandlers`).
   - Verify: with no `subagents`, the tool list the client sees is deep-equal to baseline (sc-10-4).
5. **`src/orchestrator/subagents.test.ts`** — sc-10-1 (fresh scoped context + summary return),
   sc-10-2 (shared Budget + overrides), sc-10-3 (refusal/budget/error → isError, loop continues),
   sc-10-4 half (no subagents ⇒ byte-identical). Use `ScriptedLoopClient` + a fake `runLoop`/`clientFactory`.
6. **`src/orchestrator/tools/mcp-bridge.test.ts`** — sc-10-5 (bridged prefixed ToolDefs, round-trip,
   `readOnly` absent, `close()` once in finally via `runWithMcpBridge`) + sc-10-4 half (default config ⇒
   factory never called / nothing spawned).
7. **Optionally extend `src/orchestrator/agentic-loop.test.ts`** — one integration test proving the
   registered `spawn_subagent` appears only when `subagents` is passed.
8. **Full verification** — `npm run build` && `npm run typecheck` && `npm test` (baseline 3870 green).

---

## 10. Pitfalls & Warnings

1. **Import cycle (subagents.ts ↔ agentic-loop.ts).** `agentic-loop.ts` needs the VALUE
   `buildSubagentTool`; if `subagents.ts` also imports the VALUE `runAgenticLoop`, you get a
   runtime value cycle. BREAK IT: `subagents.ts` imports the loop TYPES only (`import type`)
   and receives `runLoop` via `BuildSubagentOpts` (the loop passes `runAgenticLoop` — a hoisted
   function declaration, so the self-reference is legal). This keeps one-directional runtime deps.
2. **sc-10-4 byte-identical is a REFERENCE test.** When `subagents` is absent, do NOT clone
   `tools`/`toolHandlers` — keep `tools = params.tools` (same reference) so `readOnlyTools`
   (agentic-loop.ts:400) and every `chat` `tools` arg (agentic-loop.ts:518) are unchanged.
3. **Do NOT mark `spawn_subagent` or `mcp__` tools `readOnly`.** The loop only parallelizes
   `readOnly === true` (agentic-loop.ts:400-402); leaving it absent = serial (ADR-2, nonGoal #3).
   Tests assert `Object.hasOwn(tool, "readOnly") === false`.
4. **Child MUST get `subagents: undefined`** (one-level cap, nonGoal #1). Also EXCLUDE
   session/compaction/onEvent/hooks/onTextDelta/initialMessages (§4b) — passing any of them
   corrupts the parent's session file / event stream / streamed text.
5. **Handlers must NEVER throw.** `ToolHandler` returns `{output, isError}` (handlers.ts:21).
   A child refusal/budget/error/abort is an `isError` result (sc-10-3), not a thrown error —
   the parent loop continues and decides. Wrap the child run + bridge callTool in try/catch.
6. **Bridge lifecycle: construct ONLY when `enabled === true` at the CALL SITE, never at parse.**
   `close()` runs in a `finally` via `runWithMcpBridge` (§4d) — the loop stays hermetic.
   `disabled` (default) must spawn NOTHING: tests assert the injected factory is never called.
7. **Do NOT leak SDK types** (principles.md:28,41). Keep `@modelcontextprotocol/sdk` imports
   inside `mcp-bridge.ts`, behind `McpBridgeClientLike`. Do not re-export SDK `Client`/`Transport`.
8. **Unwrap `callTool` correctly.** The SDK returns `{ content: [{type:'text', text}], isError }`
   (resolution-verify.ts:250-274). Join `type:'text'` entries; map `isError`. Some servers put a
   staleness/warning line first (mcp-client.ts:79-100) — join ALL text entries, don't assume `[0]`.
9. **`model` field is required on `AgenticLoopParams`.** The child must always set `model`
   (`resolveModel(def.model)` or `parentParams.model`) — do not omit it.
10. **Use `.js` import extensions + `import type`** everywhere (principles.md:27,35); `consistent-type-imports`
    is a hard lint gate. `type: "object" as const` in every `input_schema` (schemas.ts idiom).
