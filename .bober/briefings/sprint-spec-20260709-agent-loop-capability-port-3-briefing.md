# Sprint Briefing: Loop wiring — per-role effort, USD ceiling enforcement, config schema, cost persistence

**Contract:** sprint-spec-20260709-agent-loop-capability-port-3
**Generated:** 2026-07-10T00:00:00.000Z

---

## 0. Verified Anchors (contract line numbers had drifted after Sprint 1's edits)

The contract's anchors are approximate. These are VERIFIED against the current tree:

| Contract claim | Verified location |
|---|---|
| `ChatParams.effort` exists (`types.ts:155`) | **CONFIRMED** — `src/providers/types.ts:150-155` (`effort?: "low"\|"medium"\|"high"\|"xhigh"\|"max"`) |
| `anthropic.ts` forwards effort (~:310) | **CONFIRMED** — destructured `src/providers/anthropic.ts:227`, spread `...(effort !== undefined ? { output_config: { effort } } : {})` at `src/providers/anthropic.ts:315`. Already unit-tested (C2/C3, `anthropic.test.ts:189-217`). This sprint ONLY creates loop→ChatParams callers; do NOT touch the adapter. |
| Per-role Zod sections (~:83-129) | Planner `schema.ts:83-91`, Generator `schema.ts:93-102`, Evaluator `schema.ts:104-118`, Curator `schema.ts:138-146` |
| maxTokens spread in chat params (~:264-266) | **ACTUAL: `agentic-loop.ts:277`** (inside the params object `agentic-loop.ts:272-278`) |
| usage accumulation (~:293) | **ACTUAL: `agentic-loop.ts:299-300`** |
| max-turns return (~:406) | **ACTUAL: `agentic-loop.ts:417-428`** |
| Sprint-1 refusal/completion branch | `agentic-loop.ts:336-348` |
| Generator loop-param construction (~:115-145) | **CONFIRMED: `generator-agent.ts:115-145`** |
| Sprint-completion history event | **`event: "sprint-passed"` at `pipeline.ts:444-450`** (there is NO literal `sprint-completed`) |
| `runGenerator` call has NO try/catch (ADR-4) | `pipeline.ts:329` — confirmed; a thrown BudgetExceededError would escape uncaught |

---

## 1. Target Files

### src/config/schema.ts (modify)

**Per-role section pattern — every section is a flat `z.object` of optional fields (schema.ts:93-102):**
```ts
export const GeneratorSectionSchema = z.object({
  model: GeneratorModelSchema.default("sonnet"),
  maxTurnsPerSprint: z.number().int().min(1).default(50),
  autoCommit: z.boolean().default(true),
  branchPattern: z.string().default("bober/{feature-name}"),
  provider: z.string().optional(),
  endpoint: z.string().nullable().optional(),
  providerConfig: z.record(z.string(), z.unknown()).optional(),
});
```
Planner `:83-91`, Evaluator `:104-118`, Curator `:138-146` follow the identical shape (optional `provider/endpoint/providerConfig` tails).

**Nested-optional-object precedent (MedicalSection.egress, schema.ts:387-396) — mirror for `budget`:**
```ts
egress: z
  .object({
    cloudInference: z.boolean().default(false),
    ...
  })
  .optional(),
```

**Add (per generatorNotes):**
```ts
// Near the top-level primitives (after ContextResetSchema ~:33) or just above the section schemas:
export const EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof EffortSchema>;

export const BudgetSectionSchema = z.object({
  maxUsd: z.number().positive().nullable().optional(),
});
export type BudgetSection = z.infer<typeof BudgetSectionSchema>;
```
Then attach `effort: EffortSchema.optional()` and `budget: BudgetSectionSchema.optional()` to Planner/Curator/Generator/Evaluator sections. Keep the value union in `ChatParams.effort` (`types.ts:155`) and `EffortSchema` identical (low|medium|high|xhigh|max).

**Imported by:** `src/config/loader.ts`, `src/fleet/child-config.ts`, and every agent (`config.generator.*` reads). Additive-optional → all callers byte-identical.

**Test file:** `src/config/schema.test.ts` (exists)

---

### src/orchestrator/agentic-loop.ts (modify)

**AgenticLoopParams (agentic-loop.ts:8-45)** — add two optional fields near `maxTokens?` (`:24`):
```ts
  /** Per-message max_tokens. Defaults to 16384. */
  maxTokens?: number;
  // ADD:
  /** Reasoning/output effort forwarded to ChatParams.effort (Anthropic only). */
  effort?: Effort;                 // import type { Effort } from "../config/schema.js"  (or inline the union)
  /** Optional per-run spend ceiling. Charged per turn; a hit ceiling ends the run gracefully. */
  budget?: Budget;                 // import type { Budget } from "./workflow/budget.js"
```

**AgenticLoopResult (agentic-loop.ts:47-67)** — add cumulative cost, mirroring the `refused?` conditional-key convention (`:61-66`):
```ts
  /** Cumulative USD cost summed across turns. Absent (not `undefined`) when no
   *  turn reported a costUsd, so cost-free runs stay byte-identical. */
  costUsd?: number;
```

**Destructure (agentic-loop.ts:239-253)** — add `effort` and `budget` to the destructured `params` (alongside `maxTokens = 16384` at `:247`).

**Spread effort into the chat params — EXACT location `agentic-loop.ts:272-278`:**
```ts
      response = await chatWithRetry(
        client,
        {
          model,
          system: systemPrompt,
          messages,
          tools: tools.length > 0 ? tools : undefined,
          maxTokens,
          ...(effort !== undefined ? { effort } : {}),   // ADD — mirror anthropic.ts:315 conditional spread
        },
        turn,
      );
```

**Charge + cost-accumulate + graceful stop — insert right AFTER usage accumulation (agentic-loop.ts:299-300):**
```ts
    // Accumulate usage
    totalInputTokens += response.usage.inputTokens;
    totalOutputTokens += response.usage.outputTokens;

    // ADD: cost accumulation (only tracks a sum when at least one turn reports cost)
    if (response.costUsd !== undefined) {
      totalCostUsd = (totalCostUsd ?? 0) + response.costUsd;
    }
    // ADD: budget charging (once per turn) — chargeUsd/chargeTokens are no-op-safe
    budget?.chargeTokens(response.usage);
    budget?.chargeUsd(response.costUsd ?? 0);
    if (budget?.exceeded()) {
      logger.warn(`Agentic loop hit budget ceiling on turn ${turn}. Returning partial result.`);
      return {
        finalText:
          finalText ||
          "Budget ceiling reached before completion. Partial result returned.",
        turnsUsed: turn,
        toolsCalled: allToolsCalled,
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
        stopReason: "budget_exceeded",
        ...(totalCostUsd !== undefined ? { costUsd: totalCostUsd } : {}),
      };
    }
```
Declare `let totalCostUsd: number | undefined;` next to `let totalInputTokens = 0;` (`:259-263`).

**Attach `...(totalCostUsd !== undefined ? { costUsd: totalCostUsd } : {})` to the OTHER return sites too** so cost surfaces on every completion path: completion/refusal return `:338-348`, max-turns return `:417-428`. (Error return `:286-295` optional — no cost accrues before first success; safe to add for consistency.)

**ADR-4 (arch-20260709-...-adr-4.md):** NEVER throw `BudgetExceededError` and NEVER call `assertWithinBudget()` from the loop — the graceful `budget_exceeded` return mirrors the existing `max_turns_exceeded` convention because `pipeline.ts:329` (`runGenerator`) has no surrounding try/catch.

**Test file:** `src/orchestrator/agentic-loop.test.ts` (exists — Sprint 1's ScriptedLoopClient)

---

### src/orchestrator/generator-agent.ts (modify)

**GeneratorResult (generator-agent.ts:16-27)** — add optional cost:
```ts
  usage?: { inputTokens: number; outputTokens: number };
  /** Cumulative USD cost for this generation run, when known. Absent otherwise. */
  costUsd?: number;
```

**Config reads (generator-agent.ts:52-53)** currently:
```ts
  const model = resolveModel(config.generator.model);
  const maxTurns = config.generator.maxTurnsPerSprint;
  // ADD:
  const effort = config.generator.effort;                        // Effort | undefined
  const maxUsd = config.generator.budget?.maxUsd ?? null;
  const budget = maxUsd != null ? new Budget({ maxUsd }) : undefined;  // value import of Budget
```

**runAgenticLoop call (generator-agent.ts:115-145)** — pass BOTH conditionally so absent config → identical params object:
```ts
  const result = await runAgenticLoop({
    client, model, systemPrompt,
    userMessage: enhancedMessage,
    tools: toolSet.schemas,
    toolHandlers: toolSet.handlers,
    maxTurns,
    maxTokens: 16384,
    ...(effort !== undefined ? { effort } : {}),
    ...(budget !== undefined ? { budget } : {}),
    onToolUse: (name, input) => { ... },   // unchanged
    completionCheck: (text) => looksLikeGeneratorReport(text),
    nudgeMessage: "...",
    maxNudges: 3,
  });
```

**parseGeneratorResult (generator-agent.ts:183-301)** — add `costUsd?: number` to the `loopResult` param type (`:186-192`) and surface it on the returned GeneratorResult objects via conditional spread `...(loopResult.costUsd !== undefined ? { costUsd: loopResult.costUsd } : {})`. The existing test fixture `loop` (`generator-agent.test.ts:11`, no costUsd) MUST keep yielding results with no costUsd key.

**Shared-helper note (sc-3-6 "plus a shared helper the other roles can adopt"):** minimum viable = wire the generator. Optionally extract a tiny pure helper (e.g. `budgetFromMaxUsd(maxUsd: number | null | undefined): Budget | undefined`) the other role agents (`curator-agent.ts:175`, `evaluator-agent.ts:318`, `planner-agent.ts:228`) can later adopt — but DO NOT wire those roles this sprint (out of scope; keeps their param objects byte-identical).

**Test file:** `src/orchestrator/generator-agent.test.ts` (exists)

---

### src/orchestrator/pipeline.ts (modify)

**Sprint-completion event — `event: "sprint-passed"` at pipeline.ts:444-450:**
```ts
      await appendHistory(projectRoot, {
        timestamp: new Date().toISOString(),
        event: "sprint-passed",
        phase: "complete",
        sprintId: currentContract.contractId,
        details: {
          iteration,
          feedback: evaluation.summary,
          ...(lastGeneratorResult?.costUsd !== undefined
            ? { costUsd: lastGeneratorResult.costUsd }
            : {}),   // ADD — additive; byte-identical when absent
        },
      });
```
`lastGeneratorResult` is declared at `pipeline.ts:183` and assigned from `runGenerator(...)` at `pipeline.ts:334`. `HistoryEntry.details` is `z.record(z.string(), z.unknown())` (`history.ts:43`) so `costUsd` round-trips without a schema change.

**Test file:** none directly (`pipeline.ts` has only `pipeline-run-id / .guidance / .pause` tests). See §6 for the testable seam for sc-3-5.

---

## 2. Patterns to Follow

### Conditional-key spread (the byte-identical-when-absent invariant)
**Source:** `src/orchestrator/agentic-loop.ts:347` and `src/providers/anthropic.ts:315,351,361`
```ts
...(refused ? { refused: true } : {})                        // agentic-loop.ts:347
...(effort !== undefined ? { output_config: { effort } } : {})   // anthropic.ts:315
...(costUsd !== undefined ? { costUsd } : {})                 // anthropic.ts:351,361
```
**Rule:** Every new optional field is added via `...(cond ? { key } : {})` so omission produces NO key (never `key: undefined`). This is the project-wide additive convention — reuse it for `effort`, `budget`, `costUsd`, and the history `costUsd`.

### Optional Zod section, attached to the top-level config
**Source:** `src/config/schema.ts:414-426` (FleetSectionSchema) + attachment `src/config/schema.ts:524`
```ts
export const FleetSectionSchema = z.object({ ... });
// ...
fleet: FleetSectionSchema.optional(),   // in BoberConfigSchema :494-533
```
**Rule:** Define the schema + `z.infer` type, then attach with `.optional()`. For `effort`/`budget` you attach the FIELDS to existing per-role sections (not a new top-level section).

### Graceful in-loop stop via resolved return (never throw)
**Source:** `src/orchestrator/agentic-loop.ts:417-428` (max_turns_exceeded)
```ts
return {
  finalText: finalText || "Max turns exceeded. ...",
  turnsUsed: maxTurns,
  toolsCalled: allToolsCalled,
  usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
  stopReason: "max_turns_exceeded",
};
```
**Rule:** The `budget_exceeded` return is a copy of this shape with `stopReason: "budget_exceeded"` and `turnsUsed: turn` (the current turn, NOT maxTurns).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---|---|---|---|
| `Budget` (class) | `src/orchestrator/workflow/budget.ts:40-139` | `new Budget({ maxUsd?, maxTokens?, maxAgents? })` | Per-run accountant. Import as VALUE in generator-agent, as TYPE in agentic-loop params. |
| `Budget.chargeTokens` | `budget.ts:49-52` | `(usage: TokenUsage): void` | Adds input+output tokens. |
| `Budget.chargeUsd` | `budget.ts:65-68` | `(usd: number): void` | Adds USD; **no-op on non-finite/negative** — safe to pass `costUsd ?? 0`. |
| `Budget.exceeded` | `budget.ts:107-113` | `(): boolean` | True once any configured ceiling (tokens/agents/usd) is reached. Uncapped axes never trip. |
| `Budget.assertWithinBudget` | `budget.ts:119-138` | `(): void` (throws) | DO NOT call from the loop (ADR-4). Leave intact for future workflow-interpreter use. |
| `BudgetExceededError` | `budget.ts:29-38` | `class extends Error` | DO NOT throw from the loop. Leave intact. |
| `appendHistory` | `src/state/history.ts:80-100` | `(projectRoot, entry: HistoryEntry): Promise<void>` | Appends a JSONL line; validates against `HistoryEntrySchema`. `details` is `z.record` — arbitrary keys OK. |
| `loadHistory` | `src/state/history.ts:107-128` | `(projectRoot): Promise<HistoryEntry[]>` | Reads archive+active; skips malformed lines. Use in sc-3-5 round-trip. |
| `estimateCostUsd` | `src/providers/cost-meter.ts:86` | `({ provider, model, usage }): number \| undefined` | Sprint-2 cost source; already wired inside anthropic.ts. Do NOT call from the loop — the loop consumes `response.costUsd`. |
| `logger` | `src/utils/logger.ts` | `.warn/.debug/...` | Used at the budget-stop log line (mirror `:413-415`). |

**Utilities reviewed:** `src/utils/`, `src/orchestrator/workflow/`, `src/state/`, `src/providers/` — the above are the relevant set; no new helper is required (an optional `budgetFromMaxUsd` shim is a nicety, not a duplication).

---

## 4. Prior Sprint Output

### Sprint 1 (35a2dbd): refusal detection
**Modified:** `agentic-loop.ts` (added `AgenticLoopResult.refused?` `:66` + refusal branch `:336-348`), `generator-agent.ts` (exported `parseGeneratorResult`, refusal fail-closed guard `:197-206`).
**Created:** `agentic-loop.test.ts` (ScriptedLoopClient), `generator-agent.test.ts`.
**Connection:** Your `costUsd?` on the result and `budget_exceeded` return REUSE the exact `refused?` conditional-key convention and the ScriptedLoopClient test harness. The refusal branch sits at `:336-348` — your budget stop inserts EARLIER, right after usage accumulation at `:300`, so it fires before the completion/refusal branch on any turn.

### Sprint 2 (8d68248/c73b95d/d5c8b9d/73053c0): cost substrate
**Created:** `src/providers/cost-meter.ts` (`estimateCostUsd`, `PRICE_TABLE`). **Modified:** `ChatResponse.costUsd` populated in all adapters (`types.ts:231-238`; anthropic `:336,351,361`); `Budget` gained the `maxUsd` USD axis (`budget.ts:25,65-68,99-104,132-137`) with `kind: "usd"`.
**Connection:** The loop reads `response.costUsd` (Sprint-2 output) and charges `budget.chargeUsd(...)` / accumulates `totalCostUsd`. **Budget has ZERO production callers today — this sprint (generator-agent.ts) creates the first.**

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` consulted for this sprint beyond the contract; the governing constraint is the additive/byte-identical-when-absent invariant repeated in every success criterion.

### Architecture Decisions
`.bober/architecture/arch-20260709-agent-sdk-agent-loop-harness-adr-4.md` — **Budget-exceeded is a graceful in-loop stop, not a thrown error.** Loop returns a partial `AgenticLoopResult` with `stopReason: "budget_exceeded"`; never throws, never calls `assertWithinBudget`. Rationale: `runGenerator` at `pipeline.ts:329` has no try/catch. Adapters treating `"budget_exceeded"` as `success: false` is the future mitigation (not required this sprint — generator's parse path already returns whatever the loop resolves).

### Other Docs
`budget.ts:1-12` header calls Budget "the run-level accountant the interpreter (Sprint 3) charges" — that interpreter wiring never landed; there are NO current `new Budget` / `assertWithinBudget` / `.exceeded()` production callers (grep-verified). So no fail-fast semantics exist to break.

---

## 6. Testing Patterns

### Unit Test Pattern — ScriptedLoopClient (loop tests)
**Source:** `src/orchestrator/agentic-loop.test.ts:15-25`
```ts
class ScriptedLoopClient implements LLMClient {
  private idx = 0;
  constructor(private readonly responses: ChatResponse[]) {}
  async chat(_params: ChatParams): Promise<ChatResponse> {
    const r = this.responses[Math.min(this.idx, this.responses.length - 1)];
    this.idx += 1;
    return r;
  }
}
const base = { toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
```
**For sc-3-2 (effort on the wire):** extend the client to CAPTURE params, e.g. `lastParams?: ChatParams; async chat(params) { this.lastParams = params; ... }`, then assert `client.lastParams?.effort === "high"` when `effort` is passed and `Object.hasOwn(client.lastParams!, "effort") === false` when not. (Adapter-level output_config test already exists at `anthropic.test.ts:189-217` — the loop test proves forwarding.)
**For sc-3-3 (budget stop):** script two `tool_use` turns each with `costUsd`, provide a `noop` tool + handler (mirror `agentic-loop.test.ts:50-80`), pass `budget: new Budget({ maxUsd: 1.0 })` with per-turn cost `0.6`; assert `result.stopReason === "budget_exceeded"`, `result.turnsUsed === 2`, and add a call counter to assert `chat` was NOT called a 3rd time.
**For sc-3-4 (cumulative cost):** one run with `costUsd`-bearing responses → `result.costUsd` equals the sum; one run with none → `Object.hasOwn(result, "costUsd") === false`.
**Runner:** vitest · **Assertion:** `expect` + `Object.hasOwn` for key-presence · **Location:** co-located `*.test.ts`.

### Unit Test Pattern — schema round-trip
**Source:** `src/config/schema.test.ts:128-235` (fleet optional-section suite) + minimalBase fixture `:129-137`
```ts
const minimalBase = {
  project: { name: "test-project", mode: "greenfield" },
  planner: {}, generator: {}, evaluator: { strategies: [] },
  sprint: {}, pipeline: {}, commands: {},
};
const result = BoberConfigSchema.safeParse(minimalBase);
expect(result.success).toBe(true);
```
**For sc-3-1:** (a) parse `minimalBase` → assert `result.data.generator.effort === undefined` and `.budget === undefined` (no defaults injected); (b) parse a config with `generator: { effort: "high", budget: { maxUsd: 5 } }` → assert values; (c) assert `budget.maxUsd: -1` and `effort: "bogus"` are rejected (`safeParse().success === false`); (d) `budget: { maxUsd: null }` is accepted. Import `EffortSchema`/`BudgetSectionSchema` alongside existing imports (`schema.test.ts:2-11`).

### Unit Test Pattern — history round-trip (sc-3-5 testable seam)
**Source:** `src/state/history.test.ts:1-30`
```ts
tmpDir = await mkdtemp(join(tmpdir(), "bober-history-test-"));
await mkdir(join(tmpDir, ".bober"), { recursive: true });
await appendHistory(tmpDir, { timestamp: ..., event: "sprint-passed", phase: "complete",
  sprintId: "s1", details: { iteration: 1, feedback: "ok", costUsd: 0.42 } });
const [entry] = await loadHistory(tmpDir);
expect(Object.hasOwn(entry.details, "costUsd")).toBe(true);
```
**For sc-3-5:** append one `sprint-passed` entry whose `details` includes `costUsd` and one whose `details` omits it; `loadHistory` and assert `Object.hasOwn(details, "costUsd")` true/false respectively. This proves the additive persistence contract at the `appendHistory` seam that `pipeline.ts:444` uses. (There is no `pipeline.test.ts` harness to drive the full pipeline; test the seam, not the mega-function.)

### Anthropic request-payload spy (reference only — DO NOT re-add adapter tests)
**Source:** `src/providers/anthropic.test.ts:24-34,189-217`
```ts
const createMock = vi.fn();
vi.mock("@anthropic-ai/sdk", () => { class FakeAnthropic { messages = { create: createMock }; } return { default: FakeAnthropic }; });
// C2: expect(req.output_config).toEqual({ effort: "max" });
// C3: expect(JSON.stringify(req)).not.toContain("output_config");
```
Already covers the on-wire effort behavior — your job is the loop→ChatParams hop, not the adapter.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|---|---|---|---|
| `src/config/loader.ts`, `src/fleet/child-config.ts` | `BoberConfigSchema` | low | New fields are optional → parse unchanged. `buildChildConfig` inherits shared schema (out of scope, no plumbing). |
| 13 `runAgenticLoop` callers (`evaluator-agent.ts:318`, `curator-agent.ts:175`, `planner-agent.ts:228`, `architect-agent.ts:276/466/558/694/833`, `code-reviewer-agent.ts:144`, `documenter-agent.ts:155`, `research-agent.ts:117/298`) | `AgenticLoopParams` | low | `effort`/`budget` are OPTIONAL params → every existing caller compiles and behaves identically. Only `generator-agent.ts:115` is wired this sprint. |
| `src/orchestrator/generator-agent.ts:197-278` (parseGeneratorResult) | `AgenticLoopResult` | medium | Adding `costUsd?` to the `loopResult` param type must keep the Sprint-1 `loop` fixture (no costUsd) yielding results with NO costUsd key. |
| `src/orchestrator/pipeline.ts:444` sprint-passed | `HistoryEntry.details` (z.record) | low | Conditional `costUsd` spread; `details` accepts arbitrary keys — no schema change. |

### Existing Tests That Must Still Pass
- `src/orchestrator/agentic-loop.test.ts` — Sprint-1 refusal/max-turns tests. The no-budget path must be byte-identical (all four tests pass unchanged). Especially `sc-1-5: max_turns_exceeded ... no 'refused' key` and `sc-1-5: normal completion ... no 'refused' key` — your `costUsd` conditional-spread must not add a key when no cost is present.
- `src/orchestrator/generator-agent.test.ts` — `parseGeneratorResult` refusal-guard tests; the `loop` fixture (`:11`) has no costUsd → results must have no costUsd key.
- `src/config/schema.test.ts` — all existing section suites; new optional fields must not perturb them.
- `src/providers/anthropic.test.ts` — C2/C3 effort tests already green; unaffected (adapter untouched).
- `src/state/history.test.ts` — appendHistory/loadHistory round-trip; unaffected.
- `src/config/loader.test.ts`, `src/fleet/child-config.test.ts` — full-config parse; unaffected by optional additions.

### Features That Could Be Affected
- **Fleet child config** — `buildChildConfig` inherits the shared schema; adding optional per-role fields is safe and requires NO fleet plumbing (explicit outOfScope).
- **All non-generator role agents** — share `runAgenticLoop`; leaving them un-wired keeps their param objects byte-identical (they never pass `effort`/`budget`).

### Recommended Regression Checks
1. `npm run typecheck` — clean (sc-3-7).
2. `npm run build` — clean (sc-3-7).
3. `npx vitest run src/config/schema.test.ts src/orchestrator/agentic-loop.test.ts src/orchestrator/generator-agent.test.ts src/state/history.test.ts src/providers/anthropic.test.ts` — targeted green.
4. `npm test` — full suite (baseline 3731) green with the new tests added.

---

## 8. Implementation Sequence

1. **src/config/schema.ts** — add `EffortSchema` + `BudgetSectionSchema` (+ exported types); attach `effort`/`budget` optional fields to Planner/Curator/Generator/Evaluator sections.
   - Verify: `npx vitest run src/config/schema.test.ts` (write sc-3-1 tests first or alongside).
2. **src/orchestrator/agentic-loop.ts** — extend `AgenticLoopParams` (`effort`, `budget`) and `AgenticLoopResult` (`costUsd?`); destructure both; spread `effort` in the chat params at `:277`; declare `totalCostUsd`; after usage accumulation (`:300`) accumulate cost + `budget?.chargeTokens/chargeUsd` + `budget?.exceeded()` graceful return; attach `costUsd` conditional spread to the completion (`:338-348`) and max-turns (`:417-428`) returns.
   - Verify: `npx vitest run src/orchestrator/agentic-loop.test.ts` — Sprint-1 tests still green + new sc-3-2/3/4 tests.
3. **src/orchestrator/generator-agent.ts** — add `costUsd?` to `GeneratorResult` and to the `parseGeneratorResult` `loopResult` param; read `config.generator.effort`/`config.generator.budget?.maxUsd`; construct `Budget` only when `maxUsd != null`; pass `effort`/`budget` via conditional spread; surface `result.costUsd` conditionally.
   - Verify: `npx vitest run src/orchestrator/generator-agent.test.ts` — refusal tests still green + sc-3-6 (no keys when config lacks them).
4. **src/orchestrator/pipeline.ts** — add conditional `costUsd` into the `sprint-passed` event `details` at `:444-450` from `lastGeneratorResult?.costUsd`.
   - Verify: `npm run build` (no direct test; covered by the history round-trip seam in §6).
5. **Tests (sc-3-1..sc-3-6)** — schema round-trip, effort-on-wire (loop capture), budget graceful stop, cumulative cost, generator no-keys-when-absent, history round-trip.
   - Verify: targeted vitest green.
6. **Run full verification** — `npm run build`, `npm run typecheck`, `npm test`.

---

## 9. Pitfalls & Warnings

- **NEVER throw / NEVER `assertWithinBudget()` from the loop (ADR-4).** `pipeline.ts:329` has no try/catch — an escaping `BudgetExceededError` crashes the run. Use the graceful `budget_exceeded` return only.
- **Budget-stop placement matters for `turnsUsed`.** Insert the charge+check right after usage accumulation (`:300`) so `turnsUsed: turn` reflects the crossing turn and `chat` is not called again. Placing it later (after tool execution) would let the loop do a full extra turn before stopping.
- **Do NOT touch `anthropic.ts`.** `effort → output_config.effort` already exists (`:315`) and is tested (C2/C3). Adding another forward would double-apply.
- **`effort` must NOT reach non-Anthropic wires.** You only spread `effort` into `ChatParams`; each adapter decides. OpenAI/openai-compat adapters ignore `ChatParams.effort` — verify no adapter change is needed (none is). sc-3-2 asserts the openai request never carries effort.
- **Conditional keys, never `key: undefined`.** Use `...(cond ? { key } : {})` everywhere (effort, budget, costUsd, history costUsd). A `costUsd: undefined` would fail the `Object.hasOwn`/byte-identical assertions in sc-3-4/sc-3-5.
- **`chargeUsd` swallows bad input** (`budget.ts:65-68` no-ops on non-finite/negative) — pass `response.costUsd ?? 0`; don't pre-guard.
- **Cost sum vs. budget charge are independent.** `totalCostUsd` (result field) tracks ONLY turns that reported `costUsd` (absent-when-none). `budget.chargeUsd(costUsd ?? 0)` always charges (0 when absent). Keep the two accumulations separate — don't reuse `budget.usdSpent` for `AgenticLoopResult.costUsd` (a run with a budget but no per-turn cost would then wrongly emit `costUsd: 0`).
- **Do NOT set effort/budget in this repo's own `bober.config.json`** (dogfooding declined — nonGoal).
- **`HistoryEntry.details` is `z.record`** — `costUsd` needs no schema change; do not widen `HistoryEntrySchema`.
- **`Effort` type import in agentic-loop.ts** creates a config→orchestrator type edge. If that feels wrong, inline the union `"low"|"medium"|"high"|"xhigh"|"max"` on the param (it already matches `ChatParams.effort` at `types.ts:155`). Either is acceptable; keep ONE source of truth for the enum values.
