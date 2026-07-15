# Sprint Briefing: Parallel read-only tool execution (ToolDef.readOnly + executeToolBatch + per-role flag)

**Contract:** sprint-spec-20260709-agent-loop-capability-port-4
**Generated:** 2026-07-09T21:32:05Z

---

## 0. TL;DR for the Generator

Build `src/orchestrator/tools/executor.ts#executeToolBatch` and delegate the loop's serial per-tool block to it. The executor must **mirror three exact ToolResult shapes** the serial loop produces today (success / unknown-tool / thrown-handler) byte-for-byte. Add `readOnly?: boolean` to `ToolDef`, annotate ONLY `read_file`/`glob`/`grep`, add `parallelReadOnlyTools?: boolean` to `AgenticLoopParams` + the Zod generator section, and thread it from `generator-agent.ts`. Flag off (or annotation absent) => byte-identical serial. `runAgenticLoop` is the ONLY code path that executes tools — there is no second executor to touch.

---

## 1. Target Files

### src/orchestrator/tools/executor.ts (create)

**Directory pattern:** `src/orchestrator/tools/` uses **kebab/lower snake** filenames (`handlers.ts`, `schemas.ts`, `index.ts`), collocated `*.test.ts` (`handlers.test.ts`), named exports only, section banner comments `// ── Section ──`. Type-only imports use `import type`, all relative imports carry the `.js` extension (NodeNext ESM).

**Most similar existing file:** `src/orchestrator/tools/handlers.ts` (factory-of-closures + `ToolHandler` type) and the serial block in `agentic-loop.ts:409-459` (the exact logic being ported).

**Structure template (derived from handlers.ts + the serial loop):**
```ts
import type { ToolCall, ToolResult } from "../../providers/types.js";
import type { ToolHandler } from "./handlers.js";
import { logger } from "../../utils/logger.js";

export interface ToolBatch {
  toolCalls: ToolCall[];
  toolHandlers: Map<string, ToolHandler>;
  /** Names of tools annotated readOnly:true (derived once in the loop from params.tools). */
  readOnlyTools: Set<string>;
  /** When false, everything runs strictly serially (byte-identical to the old loop). */
  parallel: boolean;
  onToolUse?: (name: string, input: unknown) => void;
}

/** Never rejects. Per-tool failures become in-slot isError ToolResults. Order preserved by position. */
export async function executeToolBatch(batch: ToolBatch): Promise<ToolResult[]> { /* ... */ }
```

**Imports this file needs:**
- `type { ToolCall, ToolResult }` from `../../providers/types.js`
- `type { ToolHandler }` from `./handlers.js`
- `{ logger }` from `../../utils/logger.js` (to mirror the serial `logger.warn` calls — see Pattern 1)

**Test file:** `src/orchestrator/tools/executor.test.ts` (create — collocated, matches `handlers.test.ts`).

---

### src/orchestrator/agentic-loop.ts (modify)

NOTE: file was edited by Sprints 1 & 3 — line anchors below are CURRENT (re-read confirmed).

**Destructure params (lines 255-271)** — add `parallelReadOnlyTools`:
```ts
  const {
    client, model, systemPrompt, userMessage, tools, toolHandlers,
    maxTurns, maxTokens = 16384, effort, budget, onToolUse,
    onTurnComplete, completionCheck, maxNudges = 2, nudgeMessage,
  } = params;    // ← add parallelReadOnlyTools here
```

**THE BLOCK TO REPLACE — the per-tool serial loop (lines 409-459).** These are the EXACT result shapes `executeToolBatch` must reproduce:
```ts
    // Execute each tool and collect results
    const toolResults: ToolResult[] = [];
    const turnTools: string[] = [];

    for (const toolCall of response.toolCalls) {
      const toolName = toolCall.name;
      const toolInput = toolCall.input;
      turnTools.push(toolName);        // ← input-order name accumulation (KEEP in loop)
      allToolsCalled.push(toolName);   // ← input-order name accumulation (KEEP in loop)

      onToolUse?.(toolName, toolInput);          // ← fires for EVERY call incl. unknown tools

      const handler = toolHandlers.get(toolName);
      if (!handler) {                            // ── UNKNOWN-TOOL SHAPE ──
        logger.warn(`Unknown tool requested: "${toolName}"`);
        toolResults.push({
          toolUseId: toolCall.id,
          content: `Error: Unknown tool "${toolName}". Available tools: ${[...toolHandlers.keys()].join(", ")}`,
          isError: true,
        });
        continue;
      }

      try {                                      // ── SUCCESS SHAPE ──
        const result = await handler(toolInput);
        toolResults.push({
          toolUseId: toolCall.id,
          content: result.output,
          isError: result.isError,
        });
      } catch (err) {                            // ── THROWN-HANDLER SHAPE ──
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`Tool "${toolName}" threw: ${message}`);
        toolResults.push({
          toolUseId: toolCall.id,
          content: `Error: Tool execution failed: ${message}`,
          isError: true,
        });
      }
    }

    // Append tool results as a ToolResultMessage (user role).  ← KEEP UNCHANGED (line 452)
    const toolResultMessage: ToolResultMessage = { role: "user", toolResults };
    messages.push(toolResultMessage);
    onTurnComplete?.(turn, turnTools);
```

**Refactor recipe (keeps byte-identical semantics when flag off):**
1. Derive the read-only set ONCE, before the `for (turn...)` loop (near line 273): `const readOnlyTools = new Set(tools.filter((t) => t.readOnly === true).map((t) => t.name));`
2. Keep the two name-accumulator pushes in the loop (they must follow input order regardless of parallelism). Simplest: iterate `response.toolCalls` once to push `turnTools`/`allToolsCalled`, THEN call the executor. OR let the executor own `onToolUse` + return results and keep a tiny name-push loop.
3. Replace the per-tool body with:
   ```ts
   const toolResults = await executeToolBatch({
     toolCalls: response.toolCalls,
     toolHandlers,
     readOnlyTools,
     parallel: parallelReadOnlyTools === true,
     onToolUse,
   });
   ```
4. Leave the `ToolResultMessage` append (line 452) and `onTurnComplete` (line 458) UNCHANGED.

**CRITICAL ordering facts the executor must preserve:**
- `onToolUse` fires for **every** tool call, including unknown ones, and BEFORE the handler lookup. Move this into `executeToolBatch` (contract signature includes `onToolUse?`). Do NOT also fire it in the loop (double-fire).
- `turnTools` / `allToolsCalled` push in input order. Since the executor returns only `ToolResult[]`, the loop retains these pushes (iterate `response.toolCalls` in order).
- The returned `ToolResult[]` MUST be indexed by original position so order == input order even when a contiguous run ran under `Promise.all`.

**Imports this file uses (line 1-6):** `type ... ToolResult` from `../providers/types.js`; `type { ToolHandler }` from `./tools/index.js`; `{ logger }` from `./utils/logger.js`. Add: `{ executeToolBatch }` from `./tools/executor.js`.

**Imported by (callers of runAgenticLoop — all delegate the loop, none touch the serial block directly):** `generator-agent.ts:120`, `evaluator-agent.ts:318`, `architect-agent.ts` (5 sites), `code-reviewer-agent.ts:144`, `documenter-agent.ts:155`, `planner-agent.ts:228`, `curator-agent.ts:175`, `research-agent.ts` (2 sites). All pass `toolHandlers: toolSet.handlers`; none pass `parallelReadOnlyTools` today, so absent-key => serial (byte-identical).

**Test file:** `src/orchestrator/agentic-loop.test.ts` (exists — extend it).

---

### src/orchestrator/tools/schemas.ts (modify)

Add `readOnly: true` to EXACTLY three schemas. The `ToolDef` type lives in `src/providers/types.ts:37-44` (add the optional field there, see below).

- `readFileTool` (line 30) => add `readOnly: true`
- `globTool` (line 102) => add `readOnly: true`
- `grepTool` (line 123) => add `readOnly: true`
- LEAVE UNMARKED: `bashTool` (line 9), `writeFileTool` (line 55), `editFileTool` (line 76).

Example after change:
```ts
export const readFileTool: ToolDef = {
  name: "read_file",
  readOnly: true,
  description: "Read a file's contents. ...",
  input_schema: { /* unchanged */ },
};
```
`TOOL_SCHEMAS` map (line 155-162) needs no change.

**Test file:** none for schemas.ts today; add assertions in `executor.test.ts` (sc-4-1: three `true`, `bash`/`write_file`/`edit_file` `=== undefined`).

---

### src/providers/types.ts (modify — the ToolDef type)

`ToolDef` is at **lines 37-44**. Add the optional annotation additively:
```ts
export interface ToolDef {
  name: string;
  /** True for side-effect-free tools eligible for parallel execution (ADR-2). Absent => serial. */
  readOnly?: boolean;
  description: string;
  input_schema: JsonSchemaObject;
}
```
`ToolResult` (lines 64-71) and `ToolCall` (lines 49-56) are the types the executor consumes — do NOT modify them.

---

### src/config/schema.ts (modify)

Sprint 3 added `effort` + `budget` to four role sections. Add `parallelReadOnlyTools` next to them. **Minimum for sc-4-5** is `GeneratorSectionSchema` (lines 115-128), since only the generator entry point threads it:
```ts
export const GeneratorSectionSchema = z.object({
  model: GeneratorModelSchema.default("sonnet"),
  maxTurnsPerSprint: z.number().int().min(1).default(50),
  autoCommit: z.boolean().default(true),
  branchPattern: z.string().default("bober/{feature-name}"),
  provider: z.string().optional(),
  endpoint: z.string().nullable().optional(),
  providerConfig: z.record(z.string(), z.unknown()).optional(),
  effort: EffortSchema.optional(),
  budget: BudgetSectionSchema.optional(),
  /** When true, contiguous read-only tool calls in a turn run concurrently (ADR-2). Default off. */
  parallelReadOnlyTools: z.boolean().optional(),   // ← ADD
});
```
Optional (no `.default(true)` — MUST default false/absent). `createDefaultConfig` (lines 612-617) sets no such field, so all existing configs parse unchanged (sc-4-5). Sprint 3's other three sections (Planner 101-113, Evaluator 130-148, Curator 168-180) may receive the same field for consistency, but only the generator threads it — adding it there without threading leaves it inert (still additive/valid). Keep scope tight: generator section is required, others optional.

**Test file:** `src/config/schema.test.ts` if present (check); sc-4-5 is also provable via the generator-agent spy test.

---

### src/orchestrator/generator-agent.ts (modify)

Sprint 3's threading pattern is the template. Read the config value near line 58, spread conditionally into `runAgenticLoop` near lines 129-130:
```ts
// near line 56-58 (alongside effort/budget reads):
const parallelReadOnly = config.generator.parallelReadOnlyTools;

// inside runAgenticLoop({ ... }) near lines 128-130, matching the conditional-spread convention:
...(effort !== undefined ? { effort } : {}),
...(budget !== undefined ? { budget } : {}),
...(parallelReadOnly !== undefined ? { parallelReadOnlyTools: parallelReadOnly } : {}),
```
Use conditional spread (NOT an unconditional `parallelReadOnlyTools: false`) so the invocation stays byte-identical when the flag is absent — the existing sc-3-6 test asserts `Object.hasOwn(passedParams, "budget") === false`, and sc-4-5's spy test will assert the same shape for this key.

Also add `parallelReadOnlyTools?: boolean` to `AgenticLoopParams` (`agentic-loop.ts:10-55`), next to `budget?` at line 34, with a doc comment.

**Test file:** `src/orchestrator/generator-agent.test.ts` (exists — extend the `runGenerator — effort/budget loop wiring` describe block).

---

## 2. Patterns to Follow

### Pattern 1 — Exact serial error/success ToolResult shapes (MIRROR BYTE-FOR-BYTE)
**Source:** `src/orchestrator/agentic-loop.ts`, lines 422-447
```ts
// unknown tool:
toolResults.push({ toolUseId: toolCall.id,
  content: `Error: Unknown tool "${toolName}". Available tools: ${[...toolHandlers.keys()].join(", ")}`,
  isError: true });
// success:
toolResults.push({ toolUseId: toolCall.id, content: result.output, isError: result.isError });
// thrown handler:
const message = err instanceof Error ? err.message : String(err);
toolResults.push({ toolUseId: toolCall.id, content: `Error: Tool execution failed: ${message}`, isError: true });
```
**Rule:** The executor's wrapped handler must produce these three shapes character-for-character (same template strings, same `[...toolHandlers.keys()].join(", ")` ordering, same `isError` values). Also mirror the two `logger.warn` calls (`Unknown tool requested: "${toolName}"` and `Tool "${toolName}" threw: ${message}`). sc-4-3 compares the parallel error result against a serial-path fixture.

### Pattern 2 — Conditional-spread param threading (byte-identical when absent)
**Source:** `src/orchestrator/generator-agent.ts` lines 129-130; mirrored in `agentic-loop.ts` line 297 (`...(effort !== undefined ? { effort } : {})`).
**Rule:** New optional params are spread only when defined so the object shape (and `Object.hasOwn`) stays identical to pre-change for the default path.

### Pattern 3 — Additive optional field on a shared interface
**Source:** `src/providers/types.ts` lines 37-44 (ToolDef), and `AgenticLoopParams.refused?`/`costUsd?` doc-comment style at `agentic-loop.ts:71-82`.
**Rule:** Mark new fields `?:` optional with a JSDoc explaining the "absent => old behavior" contract; never widen required surface.

### Pattern 4 — Zod optional per-role config field
**Source:** `src/config/schema.ts` lines 108-111 & 123-126 (`effort: EffortSchema.optional()`, `budget: BudgetSectionSchema.optional()`).
**Rule:** `.optional()` with NO default; `createDefaultConfig` omits it; existing fixtures parse unchanged.

### Pattern 5 — ScriptedLoopClient fake LLM for loop tests
**Source:** `src/orchestrator/agentic-loop.test.ts` lines 16-30
```ts
class ScriptedLoopClient implements LLMClient {
  private idx = 0; callCount = 0; lastParams?: ChatParams;
  constructor(private readonly responses: ChatResponse[]) {}
  async chat(params: ChatParams): Promise<ChatResponse> {
    this.callCount += 1; this.lastParams = params;
    const r = this.responses[Math.min(this.idx, this.responses.length - 1)];
    this.idx += 1; return r;
  }
}
const base = { toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
```
**Rule:** Drive `runAgenticLoop` tests with scripted `ChatResponse[]`; a turn with `stopReason: "tool_use"` + `toolCalls` triggers the tool block, a following `stopReason: "end"` turn ends it. Use this for the loop-level integration proof (flag on => concurrent; flag off => serial order preserved).

### Pattern 6 — vi.hoisted + runAgenticLoop spy (config-threading proof)
**Source:** `src/orchestrator/generator-agent.test.ts` lines 23-44, 200-245
```ts
const { loopSpy, clientSpy } = vi.hoisted(() => ({ loopSpy: vi.fn(async () => ({ /* fake result */ })), clientSpy: vi.fn(() => ({} as never)) }));
vi.mock("./agentic-loop.js", () => ({ runAgenticLoop: loopSpy }));
// ...
const passedParams = loopSpy.mock.calls[0][0] as Record<string, unknown>;
expect(Object.hasOwn(passedParams, "budget")).toBe(false);   // template for the flag assertions
```
**Rule:** For sc-4-5, add cases: config WITHOUT the flag => `Object.hasOwn(passedParams, "parallelReadOnlyTools") === false`; config WITH `{ parallelReadOnlyTools: true }` => `passedParams.parallelReadOnlyTools === true`. Reuse the existing `makeConfig` helper (line 189).

### Pattern 7 — performance.now() wall-clock timing test (no fake timers)
**Source:** `src/graph/preflight-injector-bench.test.ts` lines 1-14
```ts
import { performance } from "node:perf_hooks";
// ...
const t0 = performance.now();
await work();
const elapsed = performance.now() - t0;
expect(elapsed).toBeLessThan(THRESHOLD);
```
**Rule:** Measure real elapsed with `performance.now()` from `node:perf_hooks`. Do NOT enable vitest fake timers in these tests (see Pitfalls) — genuine `setTimeout` overlap requires real timers.

### Pattern 8 — collocated tools test file structure
**Source:** `src/orchestrator/tools/handlers.test.ts` lines 10-17 (`import { describe, it, expect } from "vitest"`, import SUT via `./handlers.js`, `describe`/`it` blocks). Mirror this for `executor.test.ts`.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `ToolHandler` (type) | `src/orchestrator/tools/handlers.ts:21-23` | `(input: Record<string, unknown>) => Promise<{ output: string; isError: boolean }>` | The handler contract the executor invokes. Import as `type`. |
| `ToolResult` (type) | `src/providers/types.ts:64-71` | `{ toolUseId: string; content: string; isError?: boolean }` | The batch return element shape. |
| `ToolCall` (type) | `src/providers/types.ts:49-56` | `{ id: string; name: string; input: Record<string, unknown> }` | Input element the executor walks. |
| `ToolDef` (type) | `src/providers/types.ts:37-44` | `{ name; description; input_schema; readOnly?: boolean(NEW) }` | Where the `readOnly` annotation lives. |
| `logger` | `src/utils/logger.ts` (imported at `agentic-loop.ts:6`) | `logger.warn(msg)` etc. | Mirror the serial `logger.warn` calls in the executor. |
| `TOOL_SCHEMAS` | `src/orchestrator/tools/schemas.ts:155-162` | `Record<string, ToolDef>` | Registry of the 6 schemas (annotate 3, no map change). |
| `createToolHandlers` | `src/orchestrator/tools/handlers.ts:358-371` | `(projectRoot) => Map<string, ToolHandler>` | Real handler factory (not needed by executor tests — use fakes). |
| `resolveRoleTools` / `buildToolSet` | `src/orchestrator/tools/index.ts:176 / 84` | `(role, root, ctx?, deps?) => ToolSet` | Where `tools`/`handlers` come from; the loop derives `readOnlyTools` from `params.tools`. |
| `budgetFromMaxUsd` | `src/orchestrator/workflow/budget.ts` (imported `generator-agent.ts:10`) | `(maxUsd?) => Budget \| undefined` | Sprint 3's threading precedent (NOT needed this sprint, but same file/section). |
| `createDefaultConfig` | `src/config/schema.ts` (used `generator-agent.test.ts:190`) | `(name, mode) => BoberConfig` | Build config fixtures in tests. |

**Directories reviewed:** `src/orchestrator/tools/` (handlers, schemas, index), `src/orchestrator/workflow/` (budget), `src/utils/` (logger), `src/providers/` (types). No existing "run tools in parallel"/"batch executor" util exists — `grep -rn "Promise.all" src/orchestrator/tools` returns nothing; this is genuinely new. `mapBounded` (fleet) exists but is a fan-out helper for child runs, NOT tool-call execution — do NOT repurpose it.

---

## 4. Prior Sprint Output

### Sprint 1 (35a2dbd): refusal detection
**Modified:** `agentic-loop.ts` — added `refused?` to `AgenticLoopResult` + the refusal branch at line 384; `generator-agent.ts` `parseGeneratorResult` fail-closed guard.
**Connection:** established the `refused?`/`Object.hasOwn` "absent => byte-identical" doc-comment convention this sprint copies for `parallelReadOnlyTools`/`readOnly`.

### Sprint 3 (b9c936c): loop wiring — effort/budget
**Modified:** `agentic-loop.ts` (`effort?`/`budget?` on `AgenticLoopParams` lines 27-34, per-turn charging lines 331-348, conditional `effort` spread line 297), `config/schema.ts` (`EffortSchema` 40, `BudgetSectionSchema` 48, effort/budget on 4 role sections), `generator-agent.ts` (reads config, conditional spread 129-130), plus `budgetFromMaxUsd`.
**Connection:** THIS sprint's `parallelReadOnlyTools` sits next to Sprint 3's `effort`/`budget` in the schema and threads through `generator-agent.ts` with the identical conditional-spread pattern. The tests to extend already contain Sprint 3's spy-based wiring cases (`generator-agent.test.ts:200-245`).

**Suite baseline:** 3770 green — full suite must stay green (sc-4-4).

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` at repo root affecting this sprint was loaded; the governing constraints are encoded in the contract nonGoals + ADR-2.

### Architecture Decisions — ADR-2 (`.bober/architecture/arch-20260709-agent-sdk-agent-loop-harness-adr-2.md`)
- Read-only classification is a `ToolDef.readOnly?: boolean` annotation, NOT a name allow-list inside the loop. The loop derives `readOnlyTools` FROM the annotations and stays catalog-agnostic.
- Mark ONLY `read_file`/`glob`/`grep`; `bash`/`write_file`/`edit_file` stay unmarked; `graph_*` tools opt in LATER (NOT this sprint — see contract assumptions).
- Absent annotation => serial => byte-identical. Provider-agnosticism HARD LAW forbids baking a concrete tool catalog into the generic loop.

### Contract nonGoals (hard rules)
- NEVER annotate `bash` read-only. Do NOT parallelize write tools or mixed batches (only contiguous read-only runs). Do NOT hard-code a name allow-list in the loop. Do NOT enable the flag by default anywhere.

---

## 6. Testing Patterns

### Unit Test Pattern (loop-level, ScriptedLoopClient)
**Source:** `src/orchestrator/agentic-loop.test.ts` (see Pattern 5). Runner **vitest 3.0.5** (`package.json:16` `"test": "vitest"`), assertion style `expect(...)`, mocks via `vi.fn`/`vi.mock`/`vi.hoisted`, tests **collocated** as `*.test.ts`, no global setup file (no `vitest.config.ts` — defaults apply, real timers by default).

### Executor unit tests (new file — sc-4-2 / sc-4-3 / sc-4-4)
Direct-call `executeToolBatch` with **fake handlers**; no LLM needed. Concurrency proof (sc-4-2):
```ts
import { describe, it, expect, vi } from "vitest";
import { performance } from "node:perf_hooks";
import { executeToolBatch } from "./executor.js";

const delayed = (ms: number, out: string) => async () => {
  await new Promise((r) => setTimeout(r, ms));
  return { output: out, isError: false };
};

it("sc-4-2: read-only calls overlap when parallel; order preserved", async () => {
  const handlers = new Map([
    ["read_file", delayed(50, "a")], ["glob", delayed(50, "b")], ["grep", delayed(50, "c")],
  ]);
  const calls = [
    { id: "t1", name: "read_file", input: {} },
    { id: "t2", name: "glob", input: {} },
    { id: "t3", name: "grep", input: {} },
  ];
  const t0 = performance.now();
  const results = await executeToolBatch({ toolCalls: calls, toolHandlers: handlers,
    readOnlyTools: new Set(["read_file", "glob", "grep"]), parallel: true });
  const elapsed = performance.now() - t0;
  expect(elapsed).toBeLessThan(120);                       // vs ~150ms serial
  expect(results.map((r) => r.toolUseId)).toEqual(["t1", "t2", "t3"]); // order preserved
  expect(results.map((r) => r.content)).toEqual(["a", "b", "c"]);
});
```
Meaningful-fixture guard (evaluatorNotes): run the SAME batch with `parallel: false` and assert `elapsed >= 140`.

In-slot error containment (sc-4-3): make the MIDDLE handler throw / middle tool unknown, assert its slot `isError:true` with the exact serial message shape (`Error: Tool execution failed: <msg>` or `Error: Unknown tool "<name>". Available tools: ...`), neighbors normal, and the promise RESOLVES (never rejects). Compare against a hand-built serial-path fixture string.

Serial-fallback order (sc-4-4): with `parallel: false`, record handler invocation order (push into an array inside each fake) and assert it equals input order; also assert an unmarked-tool batch with `parallel:true` stays serial.

Annotation coverage (sc-4-1):
```ts
import { readFileTool, globTool, grepTool, bashTool, writeFileTool, editFileTool } from "./schemas.js";
expect(readFileTool.readOnly).toBe(true);
expect(globTool.readOnly).toBe(true);
expect(grepTool.readOnly).toBe(true);
expect(bashTool.readOnly).toBeUndefined();
expect(writeFileTool.readOnly).toBeUndefined();
expect(editFileTool.readOnly).toBeUndefined();
```

### Config-threading test (sc-4-5)
Extend `generator-agent.test.ts` using the existing `loopSpy` + `makeConfig` (Pattern 6). Assert absent-key byte-identity and `passedParams.parallelReadOnlyTools === true` when set.

### E2E Test Pattern
Not applicable — this is a pure orchestration/unit sprint (no Playwright surface).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/orchestrator/agentic-loop.ts` (serial block) | itself | **high** | The refactor is the crux — any drift from the three exact ToolResult shapes or from input-order name accumulation breaks byte-identity. |
| `src/providers/types.ts` (ToolDef) | consumed by every adapter + tools | **low** | Adding OPTIONAL `readOnly?` cannot break structural consumers; verify no adapter does exhaustive key checks (none do — `input_schema` allows extra keys, types.ts:24-26). |
| `generator-agent.ts` + 7 other agents calling `runAgenticLoop` | `AgenticLoopParams` | **low** | New param is optional; absent => serial. None currently pass it, so no behavior change. |
| `src/config/schema.ts` (GeneratorSection) | `createDefaultConfig`, every config load | **low** | Optional field, no default => existing configs parse unchanged (sc-4-5). |
| `src/orchestrator/tools/schemas.ts` | `TOOL_SCHEMAS`, `buildToolSet`, `resolveRoleTools` | **low** | Adding `readOnly:true` is additive; the adapters ignore unknown ToolDef keys. |

### Existing Tests That Must Still Pass
- `src/orchestrator/agentic-loop.test.ts` — refusal (sc-1-3/5), effort forwarding (sc-3-2), budget ceiling + cumulative cost (sc-3-3/3-4). These exercise the tool block via `noop` handlers; the delegated executor MUST keep their `toolsCalled`/results identical (e.g. `expect(result.toolsCalled).toEqual(["noop"])`).
- `src/orchestrator/generator-agent.test.ts` — refusal guard + effort/budget wiring (sc-3-6); new flag cases extend the same describe block.
- `src/orchestrator/tools/handlers.test.ts` — `sandboxPath`; unaffected but must stay green.
- The FULL suite (3770) — sc-4-4 requires all loop/tool tests pass unchanged.

### Features That Could Be Affected
- **Every agent role** (planner/generator/evaluator/architect/curator/documenter/code-reviewer/researcher) runs through `runAgenticLoop`. Because the flag is off unless generator config sets it, all roles keep serial semantics. Verify by NOT threading the flag into non-generator entry points this sprint (scope).
- **Graph-gated tools** (`graph_*` via `resolveRoleTools`, tools/index.ts:221-243) are unmarked (`readOnly` absent) => always serial. Confirm you do NOT annotate them (contract assumption).

### Recommended Regression Checks
1. `npm run typecheck` (`tsc --noEmit`) — catches the new optional-field types and executor signature.
2. `npm run build` (`tsc`) — sc-4-6.
3. `npx vitest run src/orchestrator/agentic-loop.test.ts src/orchestrator/generator-agent.test.ts src/orchestrator/tools/` — targeted loop/tools/executor tests.
4. `npx vitest run` (or `npm test -- --run`) — full suite, must remain green (3770 baseline).

---

## 8. Implementation Sequence

1. **src/providers/types.ts** — add `readOnly?: boolean` to `ToolDef` (lines 37-44).
   - Verify: `npm run typecheck` still passes (no consumer breaks).
2. **src/orchestrator/tools/schemas.ts** — add `readOnly: true` to `readFileTool`, `globTool`, `grepTool` only.
   - Verify: `readFileTool.readOnly === true`, `bashTool.readOnly === undefined`.
3. **src/orchestrator/tools/executor.ts** — create `executeToolBatch` + `ToolBatch` interface. Group maximal contiguous runs where `parallel && readOnlyTools.has(name)`; run each such run via `Promise.all` over wrapped handlers (each wrapper try/catches into the EXACT serial shapes, fires `onToolUse` at dispatch); everything else strictly sequential (`await` each). Assemble results by original index so order == input order. Never reject.
   - Verify: unit tests sc-4-1/2/3/4 pass; compare error strings against the serial fixture.
4. **src/orchestrator/agentic-loop.ts** — add `parallelReadOnlyTools?: boolean` to `AgenticLoopParams` (near line 34) + destructure (255-271); derive `readOnlyTools` once from `tools` before the turn loop; replace the 409-459 per-tool body with the `executeToolBatch` call; keep name-accumulator pushes in input order; keep `ToolResultMessage` append + `onTurnComplete` unchanged.
   - Verify: existing `agentic-loop.test.ts` (refusal/effort/budget) still green — proves byte-identical serial path.
5. **src/config/schema.ts** — add `parallelReadOnlyTools: z.boolean().optional()` to `GeneratorSectionSchema` (115-128).
   - Verify: `createDefaultConfig("x","brownfield")` parses; existing config fixtures unchanged.
6. **src/orchestrator/generator-agent.ts** — read `config.generator.parallelReadOnlyTools`, conditional-spread into `runAgenticLoop` (near 128-130).
   - Verify: `generator-agent.test.ts` spy cases (absent => no key; set => `=== true`).
7. **executor.test.ts / agentic-loop.test.ts / generator-agent.test.ts** — add/extend tests (sc-4-1..4-5).
   - Verify: targeted vitest run green.
8. **Full verification** — `npm run build` && `npm run typecheck` && `npx vitest run` (full suite green, 3770 baseline).

---

## 9. Pitfalls & Warnings

- **Fake-timer trap (sc-4-2):** vitest does NOT enable fake timers by default (no `vitest.config.ts`, no global setup). But do NOT add `vi.useFakeTimers()` in the concurrency test — fake timers make `setTimeout` resolve without real elapsed time, so `performance.now()` would show ~0ms and the overlap proof is meaningless. Use REAL timers; keep delays small (~50ms) so the suite stays fast. (`src/graph/hook-handler.test.ts` and `src/mcp/external-client.test.ts` use fake timers but are isolated files — no cross-file contamination.)
- **onToolUse must NOT double-fire:** the serial loop fires `onToolUse` at `agentic-loop.ts:419`. Move it into `executeToolBatch` (contract signature includes it) and remove it from the loop — firing in both places would double-invoke it and break existing tests / progress logging.
- **onToolUse fires for unknown tools too** (before the handler lookup) — the executor must fire it for every call regardless of whether a handler exists.
- **Name accumulation stays input-ordered:** `turnTools`/`allToolsCalled` are pushed in `response.toolCalls` order today. Keep that order in the loop even when a run executed concurrently — otherwise `result.toolsCalled` ordering assertions (e.g. `toEqual(["noop"])`) break.
- **Mirror error strings EXACTLY:** copy the template literals verbatim, including `[...toolHandlers.keys()].join(", ")` for the unknown-tool list and `Error: Tool execution failed: ${message}` for throws. sc-4-3 compares against a serial-path fixture char-for-char.
- **Result ordering under Promise.all:** `Promise.all` preserves array order of its input, but you must build the wrapped-promise array in original slot order AND write results back to their original positions when interleaving parallel runs with serial items. Index by position, do not `push` in completion order.
- **Do NOT touch `graph_*` tools** (`resolveRoleTools` in tools/index.ts) — leaving `readOnly` absent keeps them serial per ADR-2's opt-in-later model.
- **Do NOT annotate `bash`** under any circumstance (nonGoal / ADR-2 risk).
- **No default-true anywhere:** the Zod field must be `.optional()` with no default; `createDefaultConfig` must not emit it. A `.default(true)` would silently parallelize every generator run and violate byte-identity.
- **NodeNext ESM:** every relative import in the new `executor.ts` needs the `.js` extension (e.g. `../../providers/types.js`, `./handlers.js`) or `tsc` fails.
- **Anchor drift:** `agentic-loop.ts` was edited by Sprints 1 & 3; the serial block is at CURRENT lines 409-459 (contract's ~353-388 is stale). Re-locate by the `for (const toolCall of response.toolCalls)` pattern, not by line number.
