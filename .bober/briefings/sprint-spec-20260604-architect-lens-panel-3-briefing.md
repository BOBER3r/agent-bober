# Sprint Briefing: TS Checkpoint 5 review panel

**Contract:** sprint-spec-20260604-architect-lens-panel-3
**Generated:** 2026-06-04T07:00:00Z

---

## 0. Sprint TL;DR

Extend `runArchitectPanel` (the panel-ON path) so that AFTER the continuation `runAgenticLoop` assembles the draft architecture + ADRs (Step 4) and BEFORE the final `return`, you:
1. **Assemble** the draft (already done — `document` + `adrs` are read back).
2. **Fan out** one PASS/FAIL review per lens via `mapBounded(panel.lenses, panel.maxConcurrent, reviewLens)`, each review built through `resolveArchLensFocus(lens)` and returning an `EvalResult`-shaped object.
3. **`reconcile(architectId, 1, lensReviews, timestamp)`** (imported verbatim from `reconciler.ts`) → panel verdict (fail-closed on tie).
4. **Surface** `lensReviews` (additive optional on `ArchitectResult`) + record a failing verdict in the assembled doc / result (do NOT silently drop a fail).

`runArchitectSingleLoop` (the OFF path) stays byte-identical — do NOT touch it.

**Exact on-path call count with CP5 added: `1 (generate) + N (scoring) + 1 (continuation) + N (reviews)` = `2 + 2N` total `runAgenticLoop` calls** (where N = `panel.lenses.length`). For 3 lenses → `2 + 6 = 8`; for 2 lenses → `2 + 4 = 6`.

---

## 1. Target Files

### src/orchestrator/architect-agent.ts (modify)

This is the ONLY production file you touch. Three edits:

#### Edit A — Add imports (top of file, lines 1-12)

Current imports:
```typescript
import type { BoberConfig } from "../config/schema.js";
import { createClient } from "../providers/factory.js";
// ...
import { synthesize } from "./workflow/synthesizer.js";
import { resolveArchLensFocus } from "./arch-lenses.js";
```
Add:
```typescript
import { reconcile } from "./workflow/reconciler.js";
import type { EvalResult } from "../contracts/eval-result.js";
```
**Rule:** `reconcile` is imported and reused verbatim (non-goal: do NOT reimplement it). Use `import type` for `EvalResult` (ESLint `consistent-type-imports`). All specifiers carry the `.js` extension.

#### Edit B — Add additive optional field to ArchitectResult (lines 24-41)

Current interface tail (lines 36-41):
```typescript
  /** Per-lens scores from the panel path (additive, optional — absent on the off path). */
  lensScores?: Array<{ lens: string; scores: Record<string, number> }>;
  /** The approach selected by synthesize().winner on the panel path (additive, optional — absent on the off path). */
  selectedApproach?: string;
}
```
Add a `lensReviews?` field mirroring the EXACT same additive pattern Sprint 2 used for `lensScores`/`selectedApproach`:
```typescript
  /** Per-lens CP5 review verdicts from the panel path (additive, optional — absent on the off path). */
  lensReviews?: Array<{ lens: string; passed: boolean; summary: string; feedback: string }>;
  /** The reconciled panel verdict for CP5 (additive, optional). false = fail-closed. */
  panelReviewPassed?: boolean;
```
**Rule:** Additive only. Both fields OPTIONAL so the off path (which never sets them) remains a valid `ArchitectResult`. Non-goal explicitly forbids any non-additive shape change. The C3 off-path test asserts these are `undefined` on the off path, so do NOT set them in `runArchitectSingleLoop`.

#### Edit C — Insert CP5 review fan-out in runArchitectPanel (between line 808 and the return at 812-821)

The continuation loop runs at **lines 707-723** and produces `continuationResult`. The doc + ADRs are read back at **lines 753-769** (`document`, `adrs`). The fallback-doc save is **lines 777-808**. The function returns at **lines 812-821**.

**INSERT POINT: after line 808 (after the fallback-doc block, i.e. after `document` is fully assembled) and before the `logger.success(...)` at line 810 / the `return` at 812.** At that point `document`, `adrs`, `winner`, and `architectId` all exist — that IS the assembled draft.

Current return (lines 812-821) — extend it with the new fields:
```typescript
  return {
    id: architectId,
    timestamp,
    document,
    adrs,
    componentCount,
    decisionCount,
    lensScores,
    selectedApproach: winner,
  };
```

**Imports this file uses (post-edit):** `reconcile`, `EvalResult`, plus existing `mapBounded` (private helper, lines 139-150), `resolveArchLensFocus`, `runAgenticLoop`, `logger`.

**Imported by:** `runArchitect` is the public entry. Grep for callers below (Impact Analysis §7).

**Test file:** `src/orchestrator/architect-agent.test.ts` (exists — extend it).

---

### src/orchestrator/architect-agent.test.ts (modify)

Extend the Sprint 2 vitest harness (see §6 for the full mock). Add cases for: off-path no review fan-out (call count unchanged at 1), on-path `2 + 2N` calls with peak ≤ maxConcurrent, and a 2-pass/2-fail set reconciling to `passed=false`.

---

## 2. Patterns to Follow

### Pattern: Reuse the existing mapBounded helper for the review fan-out
**Source:** `src/orchestrator/architect-agent.ts`, lines 139-150
```typescript
async function mapBounded<T, R>(
  items: T[],
  cap: number,
  fn: (x: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += cap) {
    const batch = items.slice(i, i + cap);
    out.push(...(await Promise.all(batch.map(fn))));
  }
  return out;
}
```
**Rule:** Reuse this SAME `mapBounded` for the review fan-out — do not write a second bounded-map. Chunk-batching guarantees peak concurrency ≤ cap, which is exactly what the C2 peak test verifies. Call it as `mapBounded(panel.lenses, panel.maxConcurrent, reviewLens)`.

### Pattern: Per-lens fan-out closure (model the review fn on scoreLens)
**Source:** `src/orchestrator/architect-agent.ts`, lines 541-616 (the `scoreLens` closure)
```typescript
const scoreLens = async (lens: string): Promise<{ lens: string; scores: Record<string, number> }> => {
  const lensBlock = `\n\n## Scoring Lens: ${lens}\n${resolveArchLensFocus(lens)}`;
  const scoringMessage = `You are the Bober Architect agent acting as a lens scorer...${lensBlock}
  ## Output Format
  Respond with EXACTLY this JSON ...`;
  const enhancedScoringMessage = await preflightInjector.inject("architect", null, scoringMessage);
  const scoringResult = await runAgenticLoop({
    client, model, systemPrompt,
    userMessage: enhancedScoringMessage,
    tools: toolSet.schemas, toolHandlers: toolSet.handlers,
    maxTurns: ARCHITECT_MAX_TURNS, maxTokens: 16384,
    onToolUse: (name, input) => { /* logger.debug */ },
  });
  // parse JSON from scoringResult.finalText with try/catch + fallback
  return { lens, scores };
};
```
**Rule:** Build a `reviewLens = async (lens: string): Promise<EvalResult> => {...}` closure with the same shape: build a prompt embedding `resolveArchLensFocus(lens)` AND the assembled `document`/`adrs`, ask for a PASS/FAIL verdict, call `runAgenticLoop` with the identical option block, then parse `finalText` into an `EvalResult`-shaped object with a try/catch + safe fallback (mirror lines 590-615). It must reuse the SAME `client`, `model`, `systemPrompt`, `toolSet`, `preflightInjector` already in scope in `runArchitectPanel`.

### Pattern: Defensive JSON parse with fallback
**Source:** `src/orchestrator/architect-agent.ts`, lines 590-615
```typescript
try {
  const parsed = JSON.parse(scoringResult.finalText.trim()) as unknown;
  if (typeof parsed === "object" && parsed !== null && "scores" in parsed && ...) {
    // extract
    return { lens, scores };
  }
} catch {
  // Fall through to default
}
// Fallback: equal scores
return { lens, scores: fallbackScores };
```
**Rule:** The review parser MUST never throw — on parse failure return a deterministic fallback `EvalResult`. For a fail-closed system, the safest fallback is `passed: false` (an unparseable review counts against the verdict), but match the contract intent: the C2 test feeds a parseable mock, so design the fallback to be `passed: false` with an explanatory feedback string.

### Pattern: EvalResult shape the lens reviewer must emit (what reconcile reads)
**Source:** `src/contracts/eval-result.ts`, lines 60-78
```typescript
export const EvalResultSchema = z.object({
  evaluator: z.string().min(1),
  passed: z.boolean(),
  score: z.number().min(0).max(100).optional(),
  details: z.array(EvalDetailSchema),
  summary: z.string(),
  feedback: z.string(),
  timestamp: z.string().datetime(),
  // ... enriched optional fields
});
export type EvalResult = z.infer<typeof EvalResultSchema>;
```
**Fields `reconcile` actually reads** (`reconciler.ts` lines 31-68): `passed` (counted), `details[]` (each `EvalDetail` with `criterion`, `passed`, `message`; only `passed===false` ones are unioned), `feedback` (joined for failing lenses), and it WRITES `summary`/`evaluator`/`timestamp`/`score`. So each lens reviewer object must minimally provide: `{ evaluator, passed, details: [], summary, feedback, timestamp }`. `EvalDetail` (lines 10-17) requires `{ criterion, passed, message, severity }` with `severity ∈ {"error","warning","info"}`.
**Rule:** Each `reviewLens` returns a fully-formed `EvalResult` (build `details` from the lens — a single detail `{ criterion: lens, passed, message: <reason>, severity: passed ? "info" : "error" }` is sufficient). Provide `timestamp` (any ISO string) so the object typechecks; `reconcile` ignores per-lens timestamps and echoes its own `timestamp` arg.

### Pattern: reconcile signature & semantics (reuse verbatim)
**Source:** `src/orchestrator/workflow/reconciler.ts`, lines 17-82
```typescript
export function reconcile(
  _sprintId: string,
  _round: number,
  lensVerdicts: EvalResult[],
  timestamp: string,
): EvalResult {
  if (lensVerdicts.length === 0) throw new Error("reconcile: lensVerdicts must be non-empty");
  // passCount = count of lens.passed === true
  const passed = passCount > failCount;        // fail-closed on tie
  // details = union of failing details de-duped; feedback = failing lenses joined
  return { evaluator: "panel", passed, score, details, summary, feedback, timestamp };
}
```
**Rule:** Call `reconcile(architectId, 1, lensReviews, timestamp)`. `_sprintId` and `_round` are ignored for output (assumption confirms `archId` + round `1` is safe). Returned `.passed` is the fail-closed panel verdict; 2-pass/2-fail → `passCount(2) > failCount(2)` is `false` → `passed=false`. `reconcile` THROWS on empty array, but on the on-path `panel.lenses.length >= 2` is guaranteed by the `runArchitect` gate (line 177), so the array is always non-empty.

### Pattern: Unicode section headers
**Source:** `src/orchestrator/architect-agent.ts`, lines 14, 398, 537, 620, 626
```typescript
// ── Step 1: Generate candidate approaches (CP2 only) ────────────
```
**Rule:** Mark the new CP5 review block with a header like `// ── Step 5: CP5 review fan-out + reconcile (panel verdict) ──────`. Required by principles.md line 32.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `mapBounded` | `src/orchestrator/architect-agent.ts:139` | `<T,R>(items: T[], cap: number, fn: (x:T)=>Promise<R>): Promise<R[]>` | Bounded-concurrency map (peak ≤ cap). REUSE for the review fan-out. |
| `reconcile` | `src/orchestrator/workflow/reconciler.ts:17` | `(sprintId: string, round: number, lensVerdicts: EvalResult[], timestamp: string): EvalResult` | Majority-vote reducer, fail-closed on tie, evaluator="panel". IMPORT, do not reimplement. |
| `resolveArchLensFocus` | `src/orchestrator/arch-lenses.ts:26` | `(lens: string): string` | Returns the lens focus fragment for the review prompt. Already imported. |
| `synthesize` | `src/orchestrator/workflow/synthesizer.js` (imported at architect-agent.ts:11) | used at line 622 | CP2 winner selection — leave untouched (non-goal). |
| `runAgenticLoop` | `src/orchestrator/agentic-loop.js` (imported at line 8) | LLM loop driver | Each review call goes through this (mocked in tests). |
| `logger` | `src/utils/logger.js` (imported at line 4) | `.info/.debug/.success/.warn/.phase` | Use for review-phase logging (mirror line 539 / 569). |
| `EvalResult` type | `src/contracts/eval-result.ts:79` | exported `type` | The shape each reviewer returns + what reconcile takes/returns. |
| `EvalDetail` type | `src/contracts/eval-result.ts:18` | `{ criterion, passed, message, file?, line?, severity }` | Build a per-lens detail. |

Utilities reviewed: `src/utils/` (logger), `src/orchestrator/workflow/` (reconciler, synthesizer), `src/orchestrator/` (arch-lenses, agentic-loop), `src/contracts/` (eval-result) — all relevant ones listed; no new util needed.

---

## 4. Prior Sprint Output

### Sprint 1 (7de08b5): synthesize + arch-lenses + config
**Created:** `src/orchestrator/arch-lenses.ts` — exports `resolveArchLensFocus(lens): string` (the focus fragment for each lens). `architect.panel` config (optional) added to `config/schema.ts`.
**Connection:** CP5 review prompts embed `resolveArchLensFocus(lens)` exactly like CP2 scoring does (line 542).

### Sprint 2 (6f82cea + 1d02543): panel gate + on/off branch
**Created/modified:** `src/orchestrator/architect-agent.ts` — `runArchitect` gate (lines 168-181), `runArchitectSingleLoop` (off path, lines 190-396), `runArchitectPanel` (on path, lines 408-822), private `mapBounded` (lines 139-150). `ArchitectResult` gained additive optional `lensScores` + `selectedApproach` (lines 36-41).
**Connection:** Sprint 3 extends `runArchitectPanel` ONLY (CP5 review after Step 4 continuation). Mirror the additive-field pattern (`lensScores`) to add `lensReviews`. The `mapBounded` + per-lens-closure + JSON-parse-with-fallback patterns from Sprint 2's scoring phase are the templates for the review phase. Off path stays byte-identical.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM everywhere** — all imports use `.js` extensions (line 27). `import { reconcile } from "./workflow/reconciler.js"`.
- **`import type`** — `consistent-type-imports` enforced (line 35). Use `import type { EvalResult }`.
- **Unicode section headers** — `// ── Section ──` (line 32).
- **No real LLM in tests** — mock `createClient`/`runAgenticLoop` (consistent with existing test, and contract non-goal line 21).
- **Tests collocated** `*.test.ts` next to source (line 20) — already satisfied.
- **No sync fs** (`node:fs/promises` only) — N/A here, all fs is behind mocked `state/index.js`.
- **Prefix unused params with `_`** (line 36) — note `reconcile` already uses `_sprintId`/`_round`.

### Architecture Decisions
ADR-4 referenced in `reconciler.ts:6` ("Pure majority-vote reducer over per-lens EvalResult[]"). The reconciler is intentionally pure (no `Date.now`/`new Date`/`Math.random`/fs) — the caller supplies `timestamp`. So you must compute `timestamp` (`new Date().toISOString()`, already done at line 771) and pass it in. No other arch docs directly govern this sprint.

### Other Docs
None beyond principles relevant to this sprint.

---

## 6. Testing Patterns

### Unit Test Pattern
**Source:** `src/orchestrator/architect-agent.test.ts` (the FULL existing Sprint 2 harness)

**The mock loop response (lines 26-51)** returns ONE JSON blob whose union of keys parses for every phase:
```typescript
const loopSpy = vi.fn(async () => {
  active++; peak = Math.max(peak, active); _callCount++;
  await new Promise<void>((r) => setTimeout(r, 5));  // async gap → observable concurrency
  active--;
  return {
    finalText: JSON.stringify({
      architectureId: "arch-test",
      approaches: ["approach-A", "approach-B"],     // parsed by generate phase
      lens: "scalability",                           // parsed by scoring phase
      scores: { "approach-A": 80, "approach-B": 60 },// parsed by scoring phase
      componentCount: 2, decisionCount: 1,
      title: "Test Architecture", summary: "A test architecture.",
      adrPaths: [], documentPath: ".bober/architecture/arch-test-architecture.md",
    }),
    turnsUsed: 1, toolsCalled: [], usage: { inputTokens: 0, outputTokens: 0 },
    stopReason: "end_turn" as const,
  };
});
```

**CRITICAL — the mock blob must now ALSO parse as a per-lens REVIEW verdict.** Add `passed` and `feedback` keys to the same JSON so the review parser succeeds:
```typescript
finalText: JSON.stringify({
  // ... existing keys ...
  passed: true,            // review phase: lens verdict
  feedback: "looks good",  // review phase: lens feedback
}),
```
Because the SAME blob is returned for every `runAgenticLoop` call, design your review parser to read `passed`/`feedback` from the top-level JSON. With a constant `passed:true` blob, every lens passes → `reconcile` returns `passed=true` (use this for the "happy path" on-path test). For the **2-pass/2-fail fail-closed test**, you must make the mock return different verdicts per call. Two viable approaches:

1. **Per-call counter in the mock** (preferred — minimal change): have `loopSpy` track a call index and, for the 4 review calls in a 4-lens run, return `passed: index < 2 ? true : false`. Since `mapBounded` preserves order and review calls are the LAST 2N... no — simplest is a dedicated test that swaps `loopSpy` implementation via `loopSpy.mockImplementation(...)` for that one test, returning alternating `passed`.
2. **Build lensReviews directly and call reconcile** in a focused unit test (verifying the fail-closed math) WITHOUT going through `runArchitect` — but the contract C2 wants the assertion through the panel path, so prefer approach 1.

**Runner:** vitest. **Assertion style:** `expect(...)`. **Mock approach:** `vi.mock(...)` module mocks + `vi.fn()` spies (lines 55-89). **File naming:** `*.test.ts` collocated. **Setup:** `beforeEach` resets `active/peak/_callCount` and `mockClear()` (lines 109-115).

**Existing call-count assertions to UPDATE (lines 167, 180, 193):** these currently assert `1+N+1`. With CP5 reviews they become `2 + 2N`:
```typescript
// 3 lenses: WAS expect(loopSpy).toHaveBeenCalledTimes(5)  → NOW 2+2*3 = 8
expect(loopSpy).toHaveBeenCalledTimes(8);
// 2 lenses: WAS 4 → NOW 2+2*2 = 6
expect(loopSpy).toHaveBeenCalledTimes(6);
// 4 lenses maxConcurrent=2: WAS 6 → NOW 2+2*4 = 10
expect(loopSpy).toHaveBeenCalledTimes(10);
```
The off-path C1 tests (lines 122,129,136,143) stay `toHaveBeenCalledTimes(1)` — the review fan-out must NOT run on the off path. This IS the C1 regression assertion.

**Peak concurrency:** the existing `peak` counter (line 30) already spans all calls; since reviews also go through `mapBounded(panel.lenses, panel.maxConcurrent, ...)`, the same `peak <= maxConcurrent` assertion holds — but verify the generate/continuation single calls don't overlap reviews (they're sequential `await`s, so they won't).

### Example new test — fail-closed verdict
```typescript
it("C2: 2 pass + 2 fail → panel verdict reconciles to passed=false (fail-closed)", async () => {
  const lenses = ["scalability", "security", "cost", "operability"];
  const config = makeConfig({ enabled: true, lenses, maxConcurrent: 4 });
  // Make the 4 review calls (the LAST 4 of the 2+2*4=10 calls) return 2 pass / 2 fail.
  // Simplest: count review calls by detecting the review-phase prompt, or alternate after
  // the (2 + lenses.length) non-review calls. Swap loopSpy impl for this test.
  const { runArchitect } = await import("./architect-agent.js");
  const result = await runArchitect("build a thing", "/tmp/test-proj", config);
  expect(result.panelReviewPassed).toBe(false);          // fail-closed on 2-2 tie
  expect(result.lensReviews).toHaveLength(4);
});
```

### E2E Test Pattern
Not applicable — no Playwright in this repo (CLI/library only, principles.md line 48).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/orchestrator/architect-agent.test.ts` | `architect-agent.ts` (ArchitectResult, runArchitect) | high | Call-count assertions (lines 167/180/193) MUST update to `2+2N`; off-path stays 1. |
| callers of `runArchitect` / `ArchitectResult` | `architect-agent.ts` exports | low | Changes are additive-optional only; consumers reading `lensScores`/`selectedApproach` are unaffected. Run grep below to confirm. |
| `src/orchestrator/workflow/reconciler.ts` | imported BY architect-agent now | none | reconcile is reused unchanged — do NOT edit (non-goal line 19). |
| `src/orchestrator/arch-lenses.ts` | imported BY architect-agent | none | resolveArchLensFocus reused unchanged (non-goal). |

Run to confirm no other consumer breaks:
```
grep -rn "runArchitect\|ArchitectResult" src/ --include=*.ts | grep -v architect-agent
```

### Existing Tests That Must Still Pass
- `src/orchestrator/architect-agent.test.ts` — Sprint 2 tests. The C1 off-path tests (1 call) and C2 on-path tests (you UPDATE the counts to `2+2N`) and C3 shape tests must all stay green. The `selectedApproach`/`lensScores` assertions are unaffected by the additive `lensReviews`.
- `src/orchestrator/workflow/reconciler.test.ts` (if present) — reconcile is untouched; must stay green. Confirm via `grep -rl reconcile src/orchestrator/workflow/*.test.ts`.
- `src/orchestrator/workflow/synthesizer.test.ts` (if present) — synthesize untouched.
- `src/orchestrator/arch-lenses.test.ts` (if present) — untouched.

### Features That Could Be Affected
- **CP2 synthesis panel (Sprint 2)** — shares `runArchitectPanel`. Verify CP2 (generate + scoring + synthesize) still runs unchanged BEFORE your CP5 block; the winner selection and `selectedApproach`/`lensScores` outputs must be identical.
- **Off path (`runArchitectSingleLoop`)** — must be byte-identical. Do NOT touch lines 190-396.

### Recommended Regression Checks
1. `npx tsc --noEmit` → exit 0 (additive optional fields typecheck; `import type` correct).
2. `npx eslint src/` → exit 0 (consistent-type-imports, no unused vars).
3. `npm run build` → exit 0.
4. `npx vitest run src/orchestrator/architect-agent.test.ts` → all green (off-path=1 call, on-path=2+2N, fail-closed=false).
5. `npx vitest run` → full suite green (only the documented pre-existing skipped baseline tolerated).
6. Manually diff `runArchitectSingleLoop` (lines 190-396) vs Sprint-2 state → zero changes.

---

## 8. Implementation Sequence

1. **architect-agent.ts — imports (lines 1-12)** — add `import { reconcile } from "./workflow/reconciler.js"` and `import type { EvalResult } from "../contracts/eval-result.js"`.
   - Verify: `npx tsc --noEmit` finds the symbols.
2. **architect-agent.ts — ArchitectResult (lines 36-41)** — add additive optional `lensReviews?` and `panelReviewPassed?`.
   - Verify: off-path C3 test still sees them `undefined`.
3. **architect-agent.ts — CP5 review block in runArchitectPanel (insert after line 808, before return at 812)** — build `reviewLens` closure (model on `scoreLens` lines 541-616) embedding `resolveArchLensFocus(lens)` + assembled `document`/`adrs`, returning a parsed `EvalResult`; `const lensReviews = await mapBounded(panel.lenses, panel.maxConcurrent, reviewLens);`; `const verdict = reconcile(architectId, 1, lensReviews, timestamp);`.
   - Verify: review fan-out is INSIDE `runArchitectPanel` only; `runArchitectSingleLoop` untouched.
4. **architect-agent.ts — record verdict + extend return (lines 810-821)** — if `!verdict.passed`, append a `panel review: FAIL` note + failing-lens feedback to `document` (and re-save via `saveArchitecture` if you want it persisted), set `panelReviewPassed: verdict.passed`, and map `lensReviews` into the result's `{ lens, passed, summary, feedback }` shape. Do NOT silently drop a fail.
   - Verify: a failing verdict is observable on the result and/or doc.
5. **architect-agent.test.ts — extend mock blob** — add `passed: true, feedback: "..."` to the loopSpy JSON so reviews parse.
   - Verify: existing on-path tests still parse all phases.
6. **architect-agent.test.ts — update call counts** — change `5→8`, `4→6`, `6→10` (=`2+2N`); keep off-path at `1`; add 2-pass/2-fail fail-closed test.
   - Verify: `npx vitest run src/orchestrator/architect-agent.test.ts`.
7. **Run full verification** — `npx tsc --noEmit`, `npm run build`, `npx eslint src/`, `npx vitest run` all exit 0.

---

## 9. Pitfalls & Warnings

- **Call-count math:** CP5 adds N review calls. Total on-path = `1 (generate) + N (scoring) + 1 (continuation) + N (reviews)` = **`2 + 2N`**, NOT `1+N+1+N` written carelessly. For 3 lenses = 8, 2 lenses = 6, 4 lenses = 10. The existing tests assert the OLD `2+N` totals — you MUST update lines 167/180/193 or they fail.
- **Off path must stay 1 call.** The C1 tests assert `toHaveBeenCalledTimes(1)`. If you accidentally add review logic to `runArchitectSingleLoop` or to the shared `runArchitect` gate, the off-path tests break. Keep CP5 strictly inside `runArchitectPanel`.
- **`reconcile` throws on empty array** (reconciler.ts:23). On-path `panel.lenses.length >= 2` is guaranteed by the gate (line 177), so the array is non-empty — but if you ever call reconcile elsewhere, guard it.
- **Fail-closed tie:** `passed = passCount > failCount` (STRICT majority). 2-2 → false. 2-pass/1-fail (odd) → true. The fail-closed test needs an EVEN split (use 4 lenses: 2+2).
- **Mock blob reuse:** the SAME JSON is returned for ALL phases. Adding `passed`/`feedback` keys is harmless to the generate/scoring/continuation parsers (they only read their own keys), but the review parser must read top-level `passed`. For per-call-varying verdicts, swap `loopSpy.mockImplementation` within the single fail-closed test (then `loopSpy.mockClear()` in `beforeEach` resets it — re-set the default in that test or rely on the module-level default being restored; note vitest `mockClear` does NOT restore implementation, so prefer `mockImplementation` inside the test and let `beforeEach`'s `mockClear` not reset impl — set the default impl explicitly if needed).
- **`import type` for EvalResult** — importing it as a value triggers ESLint `consistent-type-imports` error (hard gate, principles.md line 19/35).
- **`.js` specifiers** — `./workflow/reconciler.js` and `../contracts/eval-result.js`, NOT `.ts` (ESM NodeNext, hard build gate).
- **Do NOT edit reconciler.ts, synthesizer.ts, arch-lenses.ts, config/schema.ts** — all non-goals. CP2 (Sprint 2) block is also off-limits except as the structural template.
- **EvalDetail severity enum** — must be one of `"error" | "warning" | "info"` (eval-result.ts:5). A typo'd severity fails Zod/typecheck if you validate, and at minimum fails the type.
- **timestamp for reconcile** — reuse the already-computed `timestamp` (line 771, `new Date().toISOString()`) so the review block sits after line 771's declaration. If you insert before line 771, hoist the `timestamp` computation.
