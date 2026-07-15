# Sprint Briefing: EvaluatorPanelReconciler — pure TS majority-vote reducer

**Contract:** sprint-spec-20260604-workflow-engine-2
**Generated:** 2026-06-04T00:00:00Z

---

## 1. Target Files

### src/orchestrator/workflow/reconciler.ts (create)

**Directory pattern:** Files in `src/orchestrator/workflow/` use **kebab-case `.ts`** filenames (`engine.ts`, `eligibility.ts`, `ts-engine.ts`, `selector.ts`), ESM imports with **`.js` specifiers**, `import type` for type-only imports, and a leading **unicode box-drawing section header** comment.

**Most similar existing file:** `src/orchestrator/workflow/selector.ts` — pure functions, `import type`, `.js` specifiers, unicode header, JSDoc on each exported function.

**Section header convention** (verbatim style, `src/orchestrator/workflow/ts-engine.ts:6`, `selector.ts:7`):
```ts
// ── Reconciler ─────────────────────────────────────────────────────
```

**Exact signature required** (contract generatorNotes, line 68):
```ts
export function reconcile(
  sprintId: string,
  round: number,
  lensVerdicts: EvalResult[],
  timestamp: string,
): EvalResult
```

**Imports this file needs** (type-only, `.js` specifier):
```ts
import type { EvalResult, EvalDetail } from "../../contracts/eval-result.js";
```
> Note: `sprintId` and `round` are part of the signature per ADR-4 (`reconcile(sprintId, round, lensVerdicts)`), but `EvalResult` has NO `sprintId`/`round` fields (see §3). They are present for parity with `aggregateResults` and the future JS port; they do not appear in the returned object. Do not add them to the output (nonGoal: "Do not introduce a new EvalResult shape").

**Structure template** (based on `selector.ts` + `eval-result.ts:94` aggregateResults):
```ts
import type { EvalResult, EvalDetail } from "../../contracts/eval-result.js";

// ── Reconciler ─────────────────────────────────────────────────────

/**
 * Pure majority-vote reducer over per-lens EvalResult[] (ADR-4).
 * No Date.now / new Date / Math.random / fs — timestamp is a caller arg.
 */
export function reconcile(
  sprintId: string,
  round: number,
  lensVerdicts: EvalResult[],
  timestamp: string,
): EvalResult {
  if (lensVerdicts.length === 0) {
    throw new Error("reconcile: lensVerdicts must be non-empty");
  }
  // ... see §8 sequence
}
```

**Test file:** `src/orchestrator/workflow/reconciler.test.ts` (create — collocated, see §6).

---

### src/orchestrator/workflow/reconciler.test.ts (create)

**Most similar existing file:** `src/orchestrator/workflow/selector.test.ts` — Vitest, collocated, `import { describe, it, expect } from "vitest"`, a `makeConfig`-style fixture factory at the top under a `// ── Helpers ──` header, then grouped `describe`/`it` blocks.

**Structure template:**
```ts
import { describe, it, expect } from "vitest";
import { reconcile } from "./reconciler.js";
import { EvalResultSchema } from "../../contracts/eval-result.js";
import type { EvalResult } from "../../contracts/eval-result.js";

const TS = "2026-01-01T00:00:00.000Z"; // sentinel timestamp (evaluatorNotes)

// ── Helpers ────────────────────────────────────────────────────────

function lens(passed: boolean, over: Partial<EvalResult> = {}): EvalResult {
  return {
    evaluator: passed ? "lens-a" : "lens-b",
    passed,
    details: [],
    summary: passed ? "ok" : "nope",
    feedback: passed ? "" : "needs work",
    timestamp: TS,
    ...over,
  };
}
```
> `EvalResultSchema` is a **value** import (no `import type`); `EvalResult`/`EvalDetail` are `import type`. The reconciler module is NOT in `src/contracts/index.ts`; import directly from `../../contracts/eval-result.js`.

---

## 2. Patterns to Follow

### Pure-reducer aggregation over EvalResult[]
**Source:** `src/contracts/eval-result.ts`, lines 94-120 (`aggregateResults`)
```ts
export function aggregateResults(
  sprintId: string,
  round: number,
  results: EvalResult[],
): SprintEvaluation {
  const overallPassed = results.every((r) => r.passed);
  const feedbackParts: string[] = [];
  for (const result of results) {
    if (!result.passed) {
      feedbackParts.push(`[${result.evaluator}] FAILED: ${result.feedback}`);
    } else {
      feedbackParts.push(`[${result.evaluator}] PASSED: ${result.summary}`);
    }
  }
  const aggregateFeedback = feedbackParts.join("\n");
  return { sprintId, round, results, overallPassed, aggregateFeedback };
}
```
**Rule:** Mirror this style — iterate lenses, build string parts, `join("\n")`. BUT `reconcile` differs: it uses **strict majority** (not `every`), returns a single `EvalResult` (not `SprintEvaluation`), and takes a `timestamp` arg. Keep the logic explicit and branch-free of any IO so the sprint-3 JS port can mirror it 1:1.

### Filtering failing details
**Source:** `src/contracts/eval-result.ts`, line 141 (`formatFeedback`)
```ts
const failures = result.details.filter((d) => !d.passed);
```
**Rule:** A "failing detail" is `detail.passed === false`. The reconciler's `details` union = concat of all `details` (across lenses) where `detail.passed === false`, de-duped by `` `${criterion}␟${message}` `` (severity preserved from first occurrence — contract assumption, line 59).

### Pure function with injected dependency (no clock)
**Source:** `src/orchestrator/workflow/selector.ts`, lines 21-36 (`resolveEngineName`)
```ts
export function resolveEngineName(config: BoberConfig): PipelineEngineName {
  const requested: PipelineEngineName = config.pipeline?.engine ?? "ts";
  // ... pure branching, no IO
  return requested;
}
```
**Rule:** No `Date.now()`, `new Date()`, `Math.random()`, or `fs`. The timestamp is the `timestamp` parameter, echoed verbatim into the result.

### ESM `.js` specifiers + `import type`
**Source:** `src/orchestrator/workflow/selector.ts`, lines 1-5
```ts
import type { BoberConfig } from "../../config/schema.js";
import { logger } from "../../utils/logger.js";
import type { PipelineEngine, PipelineEngineName } from "./engine.js";
```
**Rule:** Always `.js` extension in specifiers (even though source is `.ts`); use `import type` for type-only symbols.

---

## 3. EvalResult / EvalDetail Shapes — exact fields

**EvalResultSchema** (`src/contracts/eval-result.ts:60-75`):

| Field | Type | Required? |
|-------|------|-----------|
| `evaluator` | `string` (min 1) | **required** → set to `"panel"` |
| `passed` | `boolean` | **required** |
| `score` | `number` 0-100 | optional (generatorNotes: optionally `round(100*passCount/n)`) |
| `details` | `EvalDetail[]` | **required** (may be `[]`) |
| `summary` | `string` | **required** |
| `feedback` | `string` | **required** |
| `timestamp` | `string` (`.datetime()`) | **required** → injected arg verbatim |
| `iteration`, `contractId`, `criteriaResults`, `regressions`, `designScore`, `generatorFeedback` | various | all optional — DO NOT set |

> `timestamp` must satisfy `z.string().datetime()` — an ISO-8601 UTC string like `"2026-01-01T00:00:00.000Z"`. The reducer does not validate it; the caller supplies a valid one. Use that exact sentinel in tests so `EvalResultSchema.safeParse` succeeds.

**Minimal valid EvalResult fixture** (required fields only — for test vectors):
```ts
{ evaluator: "x", passed: true, details: [], summary: "", feedback: "", timestamp: "2026-01-01T00:00:00.000Z" }
```

**EvalDetailSchema** (`src/contracts/eval-result.ts:10-17`):
```ts
{ criterion: string /*min1*/, passed: boolean, message: string, file?: string, line?: int, severity: "error"|"warning"|"info" }
```
Minimal failing detail: `{ criterion: "c1", passed: false, message: "m", severity: "error" }`.

---

## 4. Existing Utilities — DO NOT Recreate

Reviewed `src/contracts/`, `src/utils/`, `src/orchestrator/workflow/`. Relevant items:

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `EvalResultSchema` | `src/contracts/eval-result.ts:60` | `z.ZodObject` | Zod schema to `safeParse` the reconciler output against (C5). Use directly; do NOT redefine. |
| `EvalDetailSchema` | `src/contracts/eval-result.ts:10` | `z.ZodObject` | Shape of a detail; for fixtures. |
| `type EvalResult` | `src/contracts/eval-result.ts:76` | inferred | Input/output type — `import type`. |
| `type EvalDetail` | `src/contracts/eval-result.ts:18` | inferred | Detail type — `import type`. |
| `aggregateResults` | `src/contracts/eval-result.ts:94` | `(sprintId, round, EvalResult[]) => SprintEvaluation` | Existing aggregator — DO NOT call/extend; reconcile is a NEW, distinct function. Pattern reference only. |
| `formatFeedback` | `src/contracts/eval-result.ts:125` | `(SprintEvaluation) => string` | Human-format helper — not used by reconcile. |

> No de-dup / majority-vote / detail-union helper exists in the codebase — the reconciler implements these inline (use a `Set<string>` keyed by `` `${criterion}␟${message}` ``). The `␟` (U+241F SYMBOL FOR UNIT SEPARATOR) join key is specified in generatorNotes (line 68).

---

## 5. Prior Sprint Output

### Sprint 1: Engine-selection seam + pipeline.engine config
**Created:** `src/orchestrator/workflow/{engine.ts, eligibility.ts, ts-engine.ts, selector.ts}` plus `selector.test.ts`.
- `engine.ts` exports `type PipelineEngineName = "ts" | "skill" | "workflow"` and `interface PipelineEngine` (`src/orchestrator/workflow/engine.ts:7,10`).
- `selector.ts` exports pure `resolveEngineName` and `selectPipelineEngine`.

**Connection to this sprint:** The reconciler lives in the **same directory** (`src/orchestrator/workflow/`) and follows its conventions (unicode headers, `.js` specifiers, pure functions, collocated Vitest). The reconciler does NOT import from any sprint-1 file — it only imports types from `src/contracts/eval-result.ts`. It is not yet wired into any engine (nonGoal: "Do not wire reconcile into any pipeline or script yet").

---

## 6. Testing Patterns

### Unit Test Pattern
**Source:** `src/orchestrator/workflow/selector.test.ts`
```ts
import { describe, it, expect } from "vitest";          // (selector also imports vi, beforeEach)
import { resolveEngineName } from "./selector.js";

describe("resolveEngineName", () => {
  it("returns 'ts' when engine is 'ts' (default)", () => {
    const config = makeConfig({ engine: "ts" });
    expect(resolveEngineName(config)).toBe("ts");
  });
});
```
**Runner:** Vitest. **Assertion style:** `expect(...).toBe/.toEqual/.toThrow`. **Mock approach:** `vi.mock` (NOT needed here — reconcile is pure, no logger/IO to mock). **File naming:** `reconciler.test.ts`. **Location:** collocated next to `reconciler.ts`.

**Required test vectors** (contract C1-C5 + generatorNotes):
- `n=1`: single lens passing → output `passed:true, evaluator:"panel"`; single lens failing → `passed:false` (re-stamped).
- unanimous pass (e.g. 3/3) → `passed:true`.
- unanimous fail (0/3) → `passed:false`.
- majority pass: 3 pass / 2 fail → `passed:true`.
- majority fail: 2 pass / 3 fail → `passed:false`.
- **2v2 tie → `passed:false`** (fail-closed — the critical case).
- `reconcile(..., [])` → `expect(() => reconcile("s", 1, [], TS)).toThrow()`.
- empty-detail lenses (all `details: []`) → `details: []` in output, no crash.
- detail union de-dup: two failing lenses sharing `{criterion, message}` → single detail in output.
- **timestamp echo:** pass sentinel `TS`, assert `result.timestamp === TS`.
- **zod validity (C5):** `expect(EvalResultSchema.safeParse(result).success).toBe(true)`.

### E2E Test Pattern
Not applicable — no Playwright/E2E for this pure reducer.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
Both target files are **new (create)**. `reconcile` is not yet imported anywhere.

| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| (none) | reconciler.ts | low | No existing file imports `reconciler.ts` (sprint-3 will). |
| `src/contracts/eval-result.ts` | imported BY reconciler | low | Reconciler only reads the frozen schema/types — does NOT modify eval-result.ts. Do not edit it. |

### Existing Tests That Must Still Pass
- `src/orchestrator/workflow/selector.test.ts` — sprint-1 suite; unaffected (no shared code) but lives in same dir, so the full workflow suite should stay green.
- `src/contracts/spec.test.ts`, `src/contracts/sprint-contract.test.ts` — contract suites; unaffected (eval-result.ts untouched).
- `src/orchestrator/checkpoints/renderers/eval-result.test.ts` — renders a DIFFERENT (renderer) eval shape; verify still green (eval-result.ts contract unchanged).

### Features That Could Be Affected
- **Sprint 3 (JS port + drift gate)** — will port this exact logic. Keep `reconcile` logic explicit, branch-simple, and free of TS-only constructs that don't translate to plain JS (no fancy generics in the body, no external utils). This minimizes drift the `EngineConformanceHarness` must reconcile (ADR-4 Risk, line 19).

### Recommended Regression Checks
1. `npx vitest run src/orchestrator/workflow/reconciler.test.ts` — all vectors green (esp. 2v2 tie → `passed:false`, empty → throw).
2. `npx vitest run src/orchestrator/workflow` — sprint-1 selector suite still green.
3. `npm run typecheck` — exit 0.
4. `npm run build` — exit 0.
5. `git diff --name-only` — confined to the two new `reconciler*.ts` files only.

---

## 8. Implementation Sequence

1. **reconciler.ts** — create with unicode header + `import type { EvalResult, EvalDetail }`.
   - Verify: file exists, `npm run typecheck` parses the signature.
2. **reconciler.ts — guard** — `if (lensVerdicts.length === 0) throw new Error("reconcile: lensVerdicts must be non-empty")`.
   - Verify: empty-input throw test will pass.
3. **reconciler.ts — vote** — `const n = lensVerdicts.length; const passCount = lensVerdicts.filter(l => l.passed === true).length; const passed = passCount > (n - passCount);` (strict majority, fail-closed on tie).
   - Verify: 2v2 → `passed=false`; 3v2 → `passed=true`.
4. **reconciler.ts — details union** — concat `details` from lenses where the detail `passed === false`, de-dup with a `Set<string>` keyed `` `${d.criterion}␟${d.message}` ``, preserving first occurrence.
   - Verify: duplicate detail collapses to one.
5. **reconciler.ts — summary/feedback** — `summary = \`Panel verdict: ${passCount}/${n} lenses passed\``; `feedback` = failing lenses' `feedback` joined with `"\n"`, or `"All lenses passed."` when `passed`. Optionally `score = Math.round((100 * passCount) / n)`.
   - Verify: feedback non-empty when there are failing lenses.
6. **reconciler.ts — assemble** — return `{ evaluator: "panel", passed, details, summary, feedback, timestamp, ...(score !== undefined ? { score } : {}) }`. Single-lens path may instead return the lens spread with `evaluator:"panel", timestamp` overridden (generatorNotes "re-stamped").
   - Verify: `EvalResultSchema.safeParse(result).success === true`.
7. **reconciler.test.ts** — create all vectors from §6 incl. zod `safeParse` and timestamp-echo assertions.
   - Verify: `npx vitest run src/orchestrator/workflow/reconciler.test.ts` green.
8. **Run full verification** — `npm run typecheck` (exit 0), `npm run build` (exit 0), `npx vitest run src/orchestrator/workflow` (green).

---

## 9. Pitfalls & Warnings

- **Do NOT generate the timestamp** inside the reducer (no `new Date().toISOString()`). The `timestamp` arg is echoed verbatim — assert this with a sentinel (`"2026-01-01T00:00:00.000Z"`). (nonGoal line 50, evaluatorNotes line 69.)
- **Do NOT add `sprintId`/`round` to the output object** — `EvalResult` has no such fields; including them is fine for TS structurally only if extra-key-stripping is off, but `EvalResultSchema` is `z.object` (NOT strict), so extra keys would pass safeParse — STILL omit them to keep output canonical and the JS port faithful.
- **Strict majority is `passCount > failCount`**, equivalently `passCount > n - passCount`. Do NOT use `>=` (that would make ties pass and violate C2 fail-closed).
- **`EvalResultSchema` is a value import**, not `import type` — you call `.safeParse` on it in the test.
- **eval-result.ts is the frozen contract** — do NOT edit it; reconciler imports from `../../contracts/eval-result.js` directly (it is exported from `src/contracts/index.ts:60+` too, but the generatorNotes prescribe the direct path).
- **Keep the body plain-JS-portable** (no TS-only runtime constructs) so sprint-3's JS port and the conformance harness match — ADR-4 names drift as the key risk (line 19).
- **`.js` specifiers required** — `import ... from "./reconciler.js"` in the test, even though the file is `reconciler.ts`. Omitting `.js` breaks ESM.
- **Detail de-dup key** uses `␟` (U+241F) per generatorNotes; any unique separator works, but `criterion`/`message` are arbitrary strings so a separator unlikely to appear in content is safest.
