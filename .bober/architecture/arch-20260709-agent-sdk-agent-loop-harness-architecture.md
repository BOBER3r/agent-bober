# Architecture: Agent-SDK Capability Port into the agent-bober Agent Loop

**Architecture ID:** arch-20260709-agent-sdk-agent-loop-harness
**Generated:** 2026-07-09T00:00:00Z
**Status:** draft

---

## Executive Summary

agent-bober re-implements its own multi-turn agent loop (`src/orchestrator/agentic-loop.ts`) on top of `@anthropic-ai/sdk@0.100.1` and the `claude -p` CLI, and never depends on `@anthropic-ai/claude-agent-sdk`; a thirteen-area audit shows one capability used, five partial, and seven unused. This architecture ports the four highest-leverage unexploited capabilities — refusal detection, per-role reasoning effort, a per-run USD budget ceiling, and parallel read-only tool execution — directly into the own loop rather than adopting the Agent SDK, because the provider-agnosticism HARD LAW and non-Anthropic fleet children (DeepSeek, Grok, openai-compat, local) make the SDK's `query()` engine structurally unreachable. Every addition is additive and default-off: new fields on `AgenticLoopParams`, `ChatParams`, `ChatResponse`, `ToolDef`, `Budget`, and the Zod role config schema all default to current behavior and produce byte-identical requests and artifacts when omitted. The accepted tradeoffs are that USD accuracy for token-priced providers depends on a static in-repo price table (real `total_cost_usd` is used for `claude-code`) and that the budget ceiling fires between turns rather than mid-turn. The primary risk is a mis-classified read-only tool reordering side effects, mitigated by annotating only three genuinely side-effect-free tools and defaulting every unmarked tool to serial execution.

---

## Problem Statement

**Problem:** agent-bober's own agent loop leaves nine of thirteen documented agent-loop capabilities absent or undriven — most consequentially refusal detection, per-role effort control, a USD budget ceiling, and parallel read-only tool execution — making the harness slower, blind to model refusals, and unable to bound cost in dollars.

**Meta-finding:** `rg "@anthropic-ai/claude-agent-sdk" src/` returns zero hits. The only SDK dependency is `@anthropic-ai/sdk` (`package.json:63`). The subscription path (`src/providers/claude-code.ts`) shells out to `claude -p --output-format json`, text-only by contract (CAPABILITY BOUNDARY comment `claude-code.ts:10-31`). The Agent SDK's `query()`/hooks/subagents/resume/fork surface is structurally unreachable through current adapters; each capability must be ported into agent-bober's own loop, not adopted wholesale.

**Constraints:**
- Latency: no hard SLA; measurable structural cost = strictly serial tool execution (`agentic-loop.ts:353`, `for…await`, no `Promise.all`).
- Throughput: not specified; fleet fan-out bounded by `mapBounded`/`Budget`, not the loop.
- Data volume: not specified; context bounded per-sprint by `contextReset: "always"` (`config/schema.ts:184`) + `summarizeOlderSprints` (`pipeline.ts:291`), not SDK compaction.
- Cost ceiling: none exists. `Budget` (`src/orchestrator/workflow/budget.ts`) tracks tokens + agents only, dormant-workflow-engine-scoped. `claude-code.ts:55` parses `total_cost_usd` then discards it; `ChatResponse` (`types.ts:212-224`) has no cost/session_id.
- Provider-agnosticism (HARD LAW, `.bober/principles.md`): all LLM interaction through `providers/types.ts`; never leak SDK types outside adapter files; no SDK lock-in. Ported capabilities degrade to documented no-ops on adapters lacking the surface.
- Backward compatibility: Zod config schema, `.bober/*.json`/`history.jsonl` artifacts, and the `LLMClient.chat()` contract stay readable; every new field defaults to current behavior (byte-identical when absent).
- Test suite: ~3686 tests stay green; additive-only.

**Consumers:** all pipeline roles (planner/curator/generator/evaluator/architect/documenter/code-reviewer/research), fleet children (execa child processes across providers), chat (`/careful` `/approve` `/pause` `/resume`), telegram frontend, IDE monitor. One loop backs all of them; a loop-level capability lands for every consumer at once.

**Success Criteria:**
- Each of the 13 capability areas has an explicit disposition: implemented-in-own-loop, deliberately-declined-with-named-constraint, or not-applicable.
- A model `refusal` stop_reason surfaces as a distinct `StopReason` instead of silently collapsing to `"end"` (fixes `anthropic.ts:32-45` default branch / loop completion branch at `agentic-loop.ts:301`).
- `effort` is settable per role via config, forwarded by `anthropic.ts:310`, byte-identical requests when unset.
- A per-run USD ceiling is enforceable by charging real `total_cost_usd`/priced usage into `Budget`, with a graceful stop when exceeded.
- Independent read-only tool calls in one turn run concurrently, with measurable wall-clock reduction vs the serial baseline at `agentic-loop.ts:353`.
- Every addition defaults off / byte-identical; the ~3686-test suite stays green.

**Locked Dependencies:** `@anthropic-ai/sdk@0.100.1` (NOT the Agent SDK); the `claude -p` text-only subscription path; the Zod config schema; the `LLMClient`/`ChatParams`/`ChatResponse` contract in `src/providers/types.ts`.

### Capability Audit (13 agent-loop areas)

| # | SDK agent-loop capability | Verdict | Evidence / gap |
|---|---------------------------|---------|----------------|
| 1 | Loop + message stream (`query()`, `SystemMessage`) | UNUSED (re-implemented) | Own loop at `agentic-loop.ts:259`; zero Agent-SDK imports |
| 2 | Turn caps (`maxTurns`) + refusal (`stop_reason` refusal) | PARTIAL | `maxTurns` re-implemented per role (`agentic-loop.ts:22,259`; `schema.ts:140,152`); refusal NOT detected — collapses to clean finish (`anthropic.ts:32-45`, loop `:301`) |
| 3 | Budget cap (`maxBudgetUsd`) | UNUSED | Zero hits; `Budget` tracks no USD; `claude-code.ts:55` discards `total_cost_usd` |
| 4 | Effort levels (per-session + per-subagent) | PARTIAL | `ChatParams.effort` (`types.ts:155`) forwarded at `anthropic.ts:310` but no caller sets it, no config field |
| 5 | Parallel tool execution (`readOnlyHint`) | UNUSED | Serial `for…await` at `agentic-loop.ts:353`; no read-only annotation on schemas |
| 6 | Context mgmt (auto-compaction, `PreCompact`, `settingSources`) | PARTIAL | Own coarse `summarizeOlderSprints` + `contextReset:"always"`; no in-context compaction |
| 7 | Sessions & continuity (`session_id`, resume/fork) | UNUSED | Chat `/resume` and do-bridge `sessionId` are run-scoped, not model-context resume; no fork |
| 8 | Hooks (`PreToolUse`/`PostToolUse`/`Stop`/`Subagent*`/`PreCompact`) | UNUSED | Zero SDK hook wiring; own checkpoint gates are loop-internal, consume context |
| 9 | Subagents (`AgentDefinition`: scoped tools/effort/model) | UNUSED (coarse re-impl) | `.md` personas + execa child processes; per-agent effort impossible today |
| 10 | Tooling (MCP in loop, ToolSearch deferral) | PARTIAL | Ships MCP server but loop never consumes `mcpServers`; `--strict-mcp-config` disables MCP for hermeticity |
| 11 | Streaming (`includePartialMessages`, mid-loop interrupt) | UNUSED | Single non-streaming `messages.create`; `/pause` acts at turn boundaries |
| 12 | Result/cost handling (`total_cost_usd`, `session_id`) | PARTIAL | Tokens + turns tracked; USD and `session_id` never surfaced |
| 13 | Model selection | USED | Per-role model config fully exploited |

**Scorecard:** USED 1 · PARTIAL 5 · UNUSED 7.

---

## System Overview

The design adds four capabilities to the single loop that backs every consumer, following Approach A (minimal high-value port). Reasoning effort is threaded from `config.<role>.effort` through `AgenticLoopParams` into `ChatParams`, where only `AnthropicAdapter` spreads it into `output_config.effort`; other adapters ignore it, sending nothing new on the wire. Each adapter computes a per-request USD figure on its own `ChatResponse` — `claude-code` from its authoritative `total_cost_usd`, token-priced adapters via the pure `CostMeter` — and the loop charges that figure into an optional per-run `Budget` alongside existing token accounting. When the USD ceiling is reached the loop breaks gracefully with `stopReason: "budget_exceeded"`, mirroring the existing `max_turns_exceeded` return rather than throwing. A provider refusal surfaces as `refused: true` / `stopReason: "refusal"`, which write-capable roles map to `success: false`. Finally, a turn's tool calls run through `ReadOnlyToolExecutor`, which executes a contiguous run of annotated read-only calls concurrently and every other call serially while preserving original order.

Because every new field is optional and defaults to current behavior, omitting all of them yields byte-identical requests, artifacts, and control flow for pipeline roles, fleet children (separate processes via `buildChildConfig`, `child-config.ts:22`), chat, and telegram. No SDK type crosses an adapter boundary, preserving the provider-agnosticism HARD LAW.

**Deferred capabilities disposition (the 7 UNUSED areas):** Area 1 (loop re-implementation) is intentional — the own loop is what enables provider-agnosticism; adopting `query()` is rejected in ADR-1. Area 3 (USD cap) is the one UNUSED area this port closes. Areas 7 (sessions/fork), 8 (hooks), and 11 (streaming/mid-loop interrupt) are deferred: none maps to a named Checkpoint 1 constraint, and each would require re-touching the shared loop, violating the additive-only / ~3686-tests-green constraint (Approach B rejected). Area 9 (SDK subagents) is deferred because per-agent effort is delivered via config here without the SDK, and fleet children on non-Anthropic providers cannot consume `AgentDefinition`. Area 10 (MCP-in-loop) is deferred because `--strict-mcp-config` hermeticity is a deliberate existing choice, not a gap. Each deferred area retains its audit verdict as its standing disposition until a named constraint requires it.

---

## Component Breakdown

### AgenticLoop

**Responsibility:** Runs the multi-turn conversation loop and is the single site that forwards `effort`, surfaces a refusal, charges an optional `Budget`, and delegates tool execution to the `ReadOnlyToolExecutor`.

**Interface:**
```typescript
type Effort = "low" | "medium" | "high" | "xhigh" | "max";

interface AgenticLoopParams {
  // ...existing fields unchanged (agentic-loop.ts:8-45)
  effort?: Effort;                 // NEW; unset → not forwarded
  budget?: Budget;                 // NEW; absent → no USD ceiling
  parallelReadOnlyTools?: boolean; // NEW; false/undefined → serial
}

interface AgenticLoopResult {
  // ...existing fields unchanged (agentic-loop.ts:47-61)
  refused?: boolean;               // NEW
  costUsd?: number;                // NEW
  stopReason: string;              // may now be "refusal" | "budget_exceeded"
}

function runAgenticLoop(params: AgenticLoopParams): Promise<AgenticLoopResult>;
```

**Dependencies:** [Budget, ReadOnlyToolExecutor, ProviderAdapters]

---

### Budget (extended)

**Responsibility:** Accounts spend across a run and now enforces an optional USD ceiling alongside the existing token and agent ceilings.

**Interface:**
```typescript
interface BudgetOptions {
  // ...existing token/agent options
  maxUsd?: number | null;          // NEW; null/absent → uncapped
}

interface Budget {
  chargeUsd(usd: number): void;    // NaN/negative/undefined guarded → 0
  get usdSpent(): number;
  remainingUsd(): number;          // Infinity when uncapped
  exceeded(): boolean;             // also true when remainingUsd() === 0
  assertWithinBudget(): void;      // also throws kind "usd"
}

type BudgetExceededKind = "tokens" | "agents" | "usd";
```

**Dependencies:** []

---

### CostMeter (new, pure)

**Responsibility:** Maps a single request's `(provider, model, tokenUsage)` to a USD estimate via a static per-1M-token price table, returning `undefined` for any model with no matching row.

**Interface:**
```typescript
type PriceRow = { inputPerMillion: number; outputPerMillion: number };
type PriceTable = Record<string, PriceRow>; // key `${provider}:${modelPrefix}`

interface CostMeter {
  estimateCostUsd(input: {
    provider: ProviderName;
    model: string;
    usage: TokenUsage;
  }): number | undefined; // longest-prefix match; undefined if none
}
```
Pure, no I/O; `claude-code` never consults it.

**Dependencies:** []

---

### ProviderAdapters (deltas)

**Responsibility:** Recognize a refusal stop reason and populate `ChatResponse.costUsd` on each adapter's normalized response, keeping all SDK types inside adapter files.

**Interface:**
```typescript
interface ChatResponse {
  // ...existing fields unchanged (types.ts:212-224)
  costUsd?: number;                // NEW
}
// StopReason open union (types.ts:207) gains "refusal";
// normalizeStopReason gains an explicit case "refusal".
// anthropic/openai/openai-compat call CostMeter.estimateCostUsd;
// claude-code sets parsed total_cost_usd; LLMClient.chat() signature unchanged.
```

**Dependencies:** [CostMeter]

---

### ReadOnlyToolExecutor (new)

**Responsibility:** Executes a turn's tool calls, running a contiguous run of read-only calls concurrently and every other call serially, while preserving original tool-call order in the returned results.

**Interface:**
```typescript
interface ToolDef {
  // ...existing fields
  readOnly?: boolean; // absent → NOT read-only → serial
}

interface ReadOnlyToolExecutor {
  executeToolBatch(input: {
    toolCalls: ToolCall[];
    toolHandlers: Record<string, ToolHandler>;
    readOnlyTools: Set<string>;
    parallel: boolean;
    onToolUse?: (call: ToolCall) => void;
  }): Promise<ToolResult[]>; // order-preserved by toolUseId; never rejects
}
```
`read_file`/`glob`/`grep` marked `readOnly: true` in `schemas.ts`; `bash`/`write_file`/`edit_file` unmarked. `parallel=false` or unmarked → byte-identical serial. Per-tool throw → in-slot `isError` `ToolResult` (mirrors `:379-387`); unknown tool → `isError` (mirrors `:362-369`).

**Dependencies:** []

---

### RoleConfigSchema (Zod deltas)

**Responsibility:** Adds the optional per-role `effort` and `budget.maxUsd` Zod fields that let a caller drive the four capabilities without hard-coding.

**Interface:**
```typescript
const EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]).optional();
const BudgetSectionSchema = z
  .object({ maxUsd: z.number().positive().nullable().optional() })
  .optional();
// Each per-role section (schema.ts:83-129) additively gains: effort, budget.
// Role entry points (e.g. runGenerator, generator-agent.ts:115) read
// config.<role>.effort → AgenticLoopParams.effort and construct
// new Budget({ maxUsd }) only when maxUsd != null.
```

**Dependencies:** []

---

## Data Model

No new persistent data model is required beyond optional config keys and additive `history.jsonl` fields. All new types are in-memory or config-schema extensions; every field is optional and byte-identical when absent.

```typescript
type Effort = "low" | "medium" | "high" | "xhigh" | "max";

type BudgetOptions = {
  // existing token/agent ceilings...
  maxUsd?: number | null; // null/absent → uncapped
};

type PriceRow = { inputPerMillion: number; outputPerMillion: number };
type PriceTable = Record<string, PriceRow>; // key `${provider}:${modelPrefix}`

// Adapter-normalized response gains one optional field:
type ChatResponseDelta = { costUsd?: number };

// Tool definition gains one optional flag:
type ToolDefDelta = { readOnly?: boolean };

// Per-role config additive delta:
type RoleConfigDelta = {
  effort?: Effort;
  budget?: { maxUsd?: number | null };
};

// history.jsonl / sprint report additive (optional) field:
type SprintCostDelta = { costUsd?: number };
```

---

## API Contracts

| Method | Input | Output | Error Cases |
|--------|-------|--------|-------------|
| `runAgenticLoop` | `AgenticLoopParams` (+`effort?`, `budget?`, `parallelReadOnlyTools?`) | `AgenticLoopResult` (+`refused?`, `costUsd?`; `stopReason` may be `"refusal"`/`"budget_exceeded"`) | API error → `stopReason:"error"` (existing `:288`). USD ceiling → `stopReason:"budget_exceeded"` + partial result, never throws. Refusal → `refused:true`, never throws. |
| `LLMClient.chat` | `ChatParams` (+`effort?`, already at `types.ts:155`) | `ChatResponse` (+`costUsd?`) | Provider throw → `chatWithRetry` (`:105`): transient retried ≤5×, else rethrown → `stopReason:"error"`. Non-Anthropic given `effort` → silently ignored (nothing on wire). |
| `Budget.chargeUsd` | `usd: number` | `void` | None. NaN/negative/undefined guarded → 0 (no false ceiling trip). |
| `Budget.remainingUsd` | — | `number` | None. `Infinity` when `maxUsd` null/omitted. |
| `Budget.exceeded` | — | `boolean` | None. Now also true when `remainingUsd() === 0`. |
| `CostMeter.estimateCostUsd` | `{ provider, model, usage }` | `number \| undefined` | Unknown `provider:model` prefix → `undefined` (fail-open). `provider "claude-code"` → `undefined` (never consulted). |
| `ReadOnlyToolExecutor.executeToolBatch` | `{ toolCalls, toolHandlers, readOnlyTools, parallel, onToolUse }` | `Promise<ToolResult[]>` (order-preserved by `toolUseId`) | Never rejects. Per-tool throw → `isError` `ToolResult` in same slot (mirrors `:379-387`). Unknown tool → `isError` (mirrors `:362-369`). |

---

## Integration Strategy

### Data Flow

```
Config load (RoleConfigSchema) → role entry point (e.g. runGenerator, generator-agent.ts:40)
  reads config.<role>.effort + config.<role>.budget.maxUsd
  constructs Budget({ maxUsd }) only when maxUsd != null
  → runAgenticLoop({ ...existing, effort?, budget?, parallelReadOnlyTools? })  (agentic-loop.ts:230)
    per turn:
      → chatWithRetry(client, { model, system, messages, tools, maxTokens, effort })  (agentic-loop.ts:264)
        → LLMClient.chat(params)  (providers/types.ts:239)
          → AnthropicAdapter.chat: spreads output_config.effort when set (anthropic.ts:310);
              costUsd = CostMeter.estimateCostUsd({provider,model,usage})
          → ClaudeCodeAdapter.chat: costUsd = parsed total_cost_usd (claude-code.ts:55); ignores effort
          → OpenAI/Google adapters: ignore effort; costUsd = CostMeter estimate or undefined
        ← ChatResponse { text, toolCalls, stopReason, usage, costUsd? }
      accumulate usage (agentic-loop.ts:293)
      budget?.chargeTokens(usage); budget?.chargeUsd(response.costUsd ?? 0)
      if budget?.exceeded() → break, return { ...partial, stopReason: "budget_exceeded" }   (mirrors max_turns return :406)
      if stopReason === "refusal" → return { ...partial, refused: true, stopReason: "refusal" }  (at completion branch :301)
      else if stopReason !== "tool_use" → normal completion return (existing :328)
      else tool_use:
        → ReadOnlyToolExecutor.executeToolBatch({ toolCalls, toolHandlers, readOnlyTools, parallel, onToolUse })  (replaces :353-388)
            contiguous readOnly runs via Promise.all (order-preserved); write tools stay serial
        ← ToolResult[]  (append as ToolResultMessage :392) → next turn
  ← AgenticLoopResult { finalText, turnsUsed, toolsCalled, usage, stopReason, refused?, costUsd? }
→ parseGeneratorResult(finalText, filesWritten, loopResult)  (generator-agent.ts:181)
    if loopResult.refused === true → GeneratorResult { success:false, notes:"model refused..." }  (overrides filesWritten→success:true at :260)
→ pipeline sprint runner: if (!generatorResult.success) retry / needs-rework  (pipeline.ts:336)
→ Budget instance holds authoritative usdSpent → surfaced in history.jsonl / sprint report
```
Fleet children read config via `buildChildConfig` (`child-config.ts:22`) in separate processes; new optional fields default-off → byte-identical for pipeline roles, fleet children, chat, telegram.

### Consistency Model

Mixed; each axis is strongly consistent within a run. **USD spend:** strong, single-writer — `Budget` is charged once per turn on the main loop path, the Node event loop serializes turns, and tool handlers never touch `Budget`, so parallel execution cannot race it. **Refusal:** strong, provider-sourced. **Effort:** strong, config-sourced. **Read-only classification:** strong, static at tool-registration time.

### Source of Truth

| Concern | Source of truth | Derived views |
|---------|-----------------|---------------|
| Money spent this run | `Budget.usdSpent` (per-run instance) | `costUsd` on `AgenticLoopResult`; `history.jsonl` |
| Per-call cost | Adapter: real `total_cost_usd` (claude-code) else `CostMeter` estimate | `ChatResponse.costUsd` |
| Refusal | Provider `stopReason` (normalized) | `AgenticLoopResult.refused`; `GeneratorResult.success=false` |
| Reasoning effort | `config.<role>.effort` | `ChatParams.effort` → `output_config.effort` |
| Tool read-only-ness | `ToolDef.readOnly` annotation | `readOnlyTools` set passed to executor |

### External Dependencies

| Service | Used By | Failure Mode | Fallback |
|---------|---------|--------------|----------|
| Anthropic Messages API (`output_config.effort`) | AnthropicAdapter | API rejects effort (400) → `chatWithRetry` non-transient rethrow → `stopReason:"error"` | effort sent only when configured; default omits → byte-identical |
| `claude -p --output-format json` CLI (`total_cost_usd`) | ClaudeCodeAdapter | Older CLI omits `total_cost_usd` → `costUsd` undefined | Charge 0 (fail-open); token ceiling still bounds; text-only boundary unchanged |
| OpenAI / OpenAI-compat (DeepSeek, xAI) & Google APIs | respective adapters | No cost field in response | `CostMeter` estimate, or undefined when unpriced |
| `CostMeter.PriceTable` (static, in-repo) | CostMeter | Prices stale vs provider repricing | Real cost for claude-code; documented pricing date; guardrail-not-billing semantics |

---

## Architecture Decision Records

- [ADR-1: Port High-Value Agent-Loop Capabilities into the Own Loop, Not the Agent SDK](.bober/architecture/arch-20260709-agent-sdk-agent-loop-harness-adr-1.md)
- [ADR-2: Declare Tool Read-Only Classification as a ToolDef Schema Annotation](.bober/architecture/arch-20260709-agent-sdk-agent-loop-harness-adr-2.md)
- [ADR-3: Compute Per-Request USD Cost in the Adapter, Not the Loop or Budget](.bober/architecture/arch-20260709-agent-sdk-agent-loop-harness-adr-3.md)
- [ADR-4: Budget-Exceeded Is a Graceful In-Loop Stop, Not a Thrown Error](.bober/architecture/arch-20260709-agent-sdk-agent-loop-harness-adr-4.md)
- [ADR-5: Refusal Is Fail-Closed for Write-Capable Roles, Fail-Open Surfacing for Read-Only Roles](.bober/architecture/arch-20260709-agent-sdk-agent-loop-harness-adr-5.md)

---

## Risk Assessment

| Risk | Severity | Owner | Mitigation |
|------|----------|-------|------------|
| Thrown `BudgetExceededError` escapes uncaught (`runGenerator` at `pipeline.ts:329` has no try/catch) → crashes run mid-sprint | critical | AgenticLoop | USD enforcement is a graceful break/return with `stopReason:"budget_exceeded"` (mirrors `max_turns_exceeded :406`); loop NEVER throws (ADR-4) |
| Refusal after partial write reported as successful sprint (`parseGeneratorResult` returns `success:true` whenever `filesWritten.size > 0`, `generator-agent.ts:260`) | high | ProviderAdapters | `parseGeneratorResult` checks `loopResult.refused` FIRST; refused → `success:false` regardless of `filesWritten` (fail-closed for writers, ADR-5) |
| CostMeter price table drifts from real billing → ceiling fires early/late | medium | CostMeter | Real `total_cost_usd` for claude-code; longest-prefix `PriceTable` with as-priced date comment; documented as guardrail not billing |
| Unknown model → `estimateCostUsd` undefined → USD axis never trips → unbounded on that axis | medium | CostMeter | Fail-open by design (never falsely stop work); token ceiling still bounds; one-time warning when `maxUsd` set but model unpriced |
| Parallel read-only tool exception desyncs result array or rejects batch | medium | ReadOnlyToolExecutor | `executeToolBatch` maps by `toolUseId`, preserves input order; handler rejection → in-slot `isError` `ToolResult`; batch settles, never rejects |
| New `stopReason` values break future consumers switching on `stopReason` | low | AgenticLoop | No current code reads `AgenticLoopResult.stopReason` outside the loop; `StopReason` already `\| string` (`types.ts:207`); document open union requiring default branch |
| `effort` forwarded to a provider rejecting `output_config` (400) | low | ProviderAdapters | Only `AnthropicAdapter` forwards it behind existing conditional spread (`anthropic.ts:310`); other adapters ignore the field |
| Budget shared across parallel fleet children double-counts | low | Budget | `Budget` is per-run/per-role instance; fleet children are separate processes via `buildChildConfig` (`child-config.ts:22`) |
| New optional config keys break older binaries reading shared `bober.config.json` | low | RoleConfigSchema | All new Zod fields optional default-off; older schema ignores unknown keys; byte-identical-when-absent holds |
| `costUsd` double-charged (adapter + loop re-estimate) | low | ProviderAdapters | Cost computed exactly once in adapter (ADR-3); loop only sums `response.costUsd`, never calls `CostMeter` |

---

## Open Questions

- **Real per-provider price values need confirmation at build time.** The `CostMeter.PriceTable` must be populated with as-of-dated per-1M-token rates for Anthropic, OpenAI, DeepSeek, xAI/Grok, and Google. Assumption: placeholder rows ship with a pricing-date comment and unknown models return `undefined` (fail-open). Memory notes Grok model ids are placeholders (`grok-4`) — confirm real xAI ids and rates before enabling a USD ceiling on Grok, or the axis silently never trips for those children.
- **Whether `costUsd` should also be persisted per-sprint in the `history.jsonl` schema.** Assumption: `costUsd` is surfaced on `AgenticLoopResult` and MAY be written as an optional additive field; if a persisted-per-sprint field is wanted, it must be added additively (optional) so older readers stay compatible. If this assumption is wrong and a required field is added, older binaries reading shared artifacts break.
- **Whether openai-compat children (DeepSeek/xAI) should get `effort` mapped to their reasoning params later.** Assumption: for this port, only `AnthropicAdapter` forwards `effort`; other adapters ignore it (nothing on wire). If a later requirement maps `effort` to DeepSeek/xAI reasoning parameters, that is an additive per-adapter delta and does not change this architecture's contracts.
