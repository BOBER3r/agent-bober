# Sprint Briefing: Lens prompt catalog and per-lens verdict telemetry

**Contract:** sprint-spec-20260604-evaluator-lens-panel-2
**Generated:** 2026-06-04T00:00:00Z

---

## 1. Target Files

### src/orchestrator/eval-lenses.ts (create)

**Directory pattern:** `src/orchestrator/` files are kebab-case `.ts` modules; tests collocated as `*.test.ts`. Imports use `.js` specifiers; `import type` for types; unicode `// ── Section ──` headers (principles.md:27,32,35).

**Most similar existing file (small pure module to mirror):** `src/orchestrator/workflow/reconciler.ts` — a pure, dependency-light module with a JSDoc + unicode section header + single exported function.

**Structure template (no imports needed; pure string catalog):**
```ts
// ── Lens catalog ───────────────────────────────────────────────────

/** Built-in lens focus fragments. Each must be distinct and non-empty (C1). */
const LENS_CATALOG: Record<string, string> = {
  correctness: "Focus on whether the implementation actually satisfies each success criterion...",
  security: "Focus on injection, auth, secret handling, unsafe input...",
  regression: "Focus on whether previously working behavior still works / pre-existing tests...",
  quality: "Focus on principles violations, dead code, naming, smells...",
};

// ── Resolver ───────────────────────────────────────────────────────

/** Resolve a lens name to its focus fragment, or a generic fallback (no throw). */
export function resolveLensFocus(lens: string): string {
  return LENS_CATALOG[lens] ?? `Evaluate specifically through the '${lens}' lens.`;
}
```
**Rule:** Keep the 4 built-in fragments distinct + non-empty (C1). `resolveLensFocus` must NEVER throw on unknown strings — use `?? generic` (assumptions[3], C1).

---

### src/orchestrator/eval-lenses.test.ts (create)

**Most similar existing test:** `src/orchestrator/evaluator-agent.test.ts` (vitest, `describe/it/expect`). This catalog test needs NO mocks (pure function). Just import `resolveLensFocus`.

**Required assertions (C1):**
- The 4 built-ins (`correctness`, `security`, `regression`, `quality`) each return a non-empty string.
- The 4 built-in fragments are mutually distinct (e.g. `new Set([...]).size === 4`).
- An unknown lens (e.g. `'made-up'`) returns the generic fallback containing the lens name and does NOT throw.

```ts
import { describe, it, expect } from "vitest";
import { resolveLensFocus } from "./eval-lenses.js";
// assert distinct + non-empty built-ins; assert resolveLensFocus("made-up") includes "made-up"
```

---

### src/orchestrator/evaluator-agent.ts (modify)

**Change A — replace the Sprint-1 inline lens string with `resolveLensFocus(lens)`.**

Current inline string (evaluator-agent.ts:281-285) — REPLACE this:
```ts
    // When a lens is provided, append a focus block (on path only).
    // When lens is undefined the prompt is byte-identical to the original (C2).
    const lensBlock = lens
      ? `\n\n## Evaluation Lens: ${lens}\nFocus your judgment specifically on the ${lens} dimension; other concerns are out of scope for this judge.`
      : "";
```
New form — keep the EXACT `lens ? ... : ""` shape so `lens === undefined` stays byte-identical empty string (C2). Only the on-branch content changes to use the catalog:
```ts
    const lensBlock = lens
      ? `\n\n## Evaluation Lens: ${lens}\n${resolveLensFocus(lens)}`
      : "";
```
Add import at top (with the other `./` imports, e.g. near line 20):
```ts
import { resolveLensFocus } from "./eval-lenses.js";
```

**Change B — emit one per-lens verdict on the PANEL path only.**

Current panel path (evaluator-agent.ts:152-161) — `lensResults` holds the per-lens `EvalResult[]` and is available BEFORE `reconcile`. Each `lensResults[i]` corresponds to `panel.lenses[i]` (same order, `mapBounded` preserves order — see helper at lines 170-181). `EvalResult.passed` exists (eval-result.ts:61). Emit verdicts here, then reconcile unchanged:
```ts
  // On path — fan out one judge per lens with bounded concurrency.
  const lensResults = await mapBounded(
    panel.lenses,
    panel.maxConcurrent,
    (lens) => runSingleLensEval(handoff, programmaticResults, projectRoot, config, lens),
  );

  const contractId = handoff.currentContract?.contractId ?? "unknown";

  // C3 — per-lens verdict telemetry (PANEL path only; index-aligned with panel.lenses).
  for (let i = 0; i < panel.lenses.length; i++) {
    await appendHistory(projectRoot, {
      timestamp: new Date().toISOString(),
      event: "eval-lens-verdict",
      phase: "evaluating",
      sprintId: contractId,
      details: { lens: panel.lenses[i], passed: lensResults[i].passed },
    });
  }

  return reconcile(contractId, 1, lensResults, new Date().toISOString());
```
Add import (near history-related imports — currently none in this file, add to top):
```ts
import { appendHistory } from "../state/history.js";
```

**CRITICAL — do NOT emit on the off path.** The off path returns early at line 149 (`return runSingleLensEval(...)`) before any emission. Leave that path untouched (C2, nonGoals[2]).

**Imports this file already uses:** `emit` from `../telemetry/emit.js` (line 19), `reconcile` from `./workflow/reconciler.js` (line 20), `EvalResult` type from `../contracts/eval-result.js` (line 4), `BoberConfig` (line 1).

**Imported by:** `src/orchestrator/pipeline.ts` (calls `runEvaluatorAgent`); confirmed via grep — `runEvaluatorAgent` is the only public export consumed by the pipeline.

**Test file:** `src/orchestrator/evaluator-agent.test.ts` (exists — Sprint 1's tests).

---

### src/orchestrator/evaluator-agent.test.ts (modify)

Extend the existing Sprint-1 test (full mock setup at lines 20-91). The off-path tests (lines 184-206) and on-path/fan-out tests (lines 208-234) must STAY GREEN (C2, C4). Add new assertions for C3.

**Mock setup to reuse / extend:** `vi.mock("../telemetry/emit.js", ...)` exists at lines 79-81. There is currently NO mock for `../state/history.js` — the generator must ADD one to spy on `appendHistory`, OR use a temp `.bober` dir (principles.md:44 prefers temp dirs over fs mocks for fs *state*; but here we want a call-spy, and the project already mocks fs-touching modules like emit — a `vi.fn` spy is consistent and the off path must make ZERO calls, which is cleanest to assert on a spy). Lowest-friction: add a `vi.mock` for history with a spy.

Add near line 81:
```ts
const appendHistorySpy = vi.fn().mockResolvedValue(undefined);
vi.mock("../state/history.js", () => ({
  appendHistory: appendHistorySpy,
}));
```
(Note: `vi.mock` is hoisted; declare the spy with `vi.fn()` at module top alongside `loopSpy`/`clientSpy`, and clear it in `beforeEach` at lines 176-182 — `appendHistorySpy.mockClear()`.)

Precedent for mocking history with a spy: `src/orchestrator/code-reviewer-agent.test.ts:42` does `appendHistory: vi.fn().mockResolvedValue(undefined)`.

**New C3 assertions:**
- ON path (e.g. 3 lenses `["correctness","security","regression"]`, `verdicts.push(true,false,true)`): assert `appendHistorySpy` called 3 times, each with `event: "eval-lens-verdict"` and `details.lens`/`details.passed` matching each lens in order.
- OFF path (panel disabled or `<2` lenses): assert `appendHistorySpy` NOT called with `event: "eval-lens-verdict"` (i.e. zero per-lens verdict records).

---

## 2. Patterns to Follow

### appendHistory call site (free-string event + details record)
**Source:** `src/orchestrator/pipeline.ts`, lines 388-394
```ts
      await appendHistory(projectRoot, {
        timestamp: new Date().toISOString(),
        event: "sprint-passed",
        phase: "complete",
        sprintId: currentContract.contractId,
        details: { iteration, feedback: evaluation.summary },
      });
```
**Rule:** `event` is a FREE STRING (history.ts:39 `z.string().min(1)`) — `"eval-lens-verdict"` validates with NO schema change. `phase` MUST be one of the `PhaseSchema` enum (history.ts:25-34); use `"evaluating"`. `details` is `z.record(z.string(), z.unknown())` (history.ts:42) — `{ lens, passed }` is valid.

### emit call site (CLOSED enum — why NOT to use it here)
**Source:** `src/orchestrator/evaluator-agent.ts:56` and `src/orchestrator/pipeline.ts:396-401`
```ts
  void emit(projectRoot, config, "agent-spawn", { agentName: "evaluator", contractId: sprintId });
```
**Rule:** `emit`'s `eventType` is a CLOSED union `TelemetryEventType` (emit.ts:30-39) — `"eval-lens-verdict"` is NOT a member and `TelemetryEventData` (emit.ts:42-55) has NO `lens`/`passed` field. Using emit would require editing the telemetry enum + payload schema (out of the confined-diff stop condition, stopConditions[1]) AND emit is a no-op unless `config.telemetry.enabled === true` (emit.ts:75). DO NOT use emit for per-lens verdicts — use `appendHistory`.

### Pure module shape
**Source:** `src/orchestrator/workflow/reconciler.ts`, lines 1-22 (JSDoc, unicode `// ── ──` header, single named export, `.js` type import). Mirror this for `eval-lenses.ts`.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `appendHistory` | `src/state/history.ts:51` | `(projectRoot: string, entry: HistoryEntry): Promise<void>` | Durable, schema-validated JSONL history append. USE THIS for per-lens verdicts. |
| `HistoryEntry` / `HistoryEntrySchema` | `src/state/history.ts:37,44` | type `{ timestamp, event: string, phase: Phase, sprintId?, details: Record<string,unknown> }` | History entry shape; `event` is open string, `details` open record. |
| `emit` | `src/telemetry/emit.ts:69` | `(projectRoot, config, eventType: TelemetryEventType, data?: TelemetryEventData): Promise<void>` | Telemetry — CLOSED enum, do NOT use for new event types this sprint. |
| `reconcile` | `src/orchestrator/workflow/reconciler.ts:17` | `(sprintId, round, lensVerdicts: EvalResult[], timestamp): EvalResult` | Majority-vote reducer; DO NOT modify (nonGoals[0]). |
| `mapBounded` | `src/orchestrator/evaluator-agent.ts:170` | `<T,R>(items: T[], cap: number, fn): Promise<R[]>` | Bounded-concurrency map; preserves order — reuse, do NOT change. |
| `EvalResult` | `src/contracts/eval-result.ts:76` | type with `.passed: boolean` | Per-lens result; `lensResults[i].passed` is the verdict to emit. |

Utilities reviewed: `src/utils/` (git.ts, logger.ts), `src/state/` (history.ts, helpers.ts), `src/telemetry/` (emit.ts) — relevant ones above; no string-catalog helper exists (eval-lenses.ts must be created fresh).

---

## 4. Prior Sprint Output

### Sprint 1 (commit 5dc7a5e): evaluator.panel config + lens-aware runAgentEvaluation
**Modified:** `src/orchestrator/evaluator-agent.ts` — added `runAgentEvaluation` panel branch (lines 140-161), `mapBounded` helper (170-181), and `runSingleLensEval(... lens?)` with the inline lens-focus string (281-285).
**Added (config):** `config.evaluator.panel` = `{ enabled, lenses, maxConcurrent }` (used at evaluator-agent.ts:146).
**Added test:** `src/orchestrator/evaluator-agent.test.ts` with the full vi.mock harness + concurrency tracking (lines 20-91).
**Connection to this sprint:** Replace the inline string (281-285) with `resolveLensFocus(lens)`; emit per-lens verdicts from `lensResults` (153) before `reconcile` (160). The off-path early return (149) must stay untouched so C2/C4 tests remain green.

---

## 5. Relevant Documentation

### Project Principles (.bober/principles.md)
- ESM `.js` specifiers on all relative imports (line 27) — use `./eval-lenses.js`, `../state/history.js`.
- `import type { ... }` for type-only imports (line 35, eslint `consistent-type-imports`).
- Unicode box-drawing section headers `// ── Section ──` (line 32).
- No sync fs; `node:fs/promises` only (line 42) — `appendHistory` already complies.
- No fs mocks for fs STATE — tests needing fs state use temp dirs (line 44). For a call-count spy on `appendHistory`, a `vi.fn` mock is consistent with existing tests (code-reviewer-agent.test.ts:42).
- Tests collocated `*.test.ts` next to source (line 20).
- Conventional commit: `bober(sprint-2): add lens prompt catalog + per-lens verdict telemetry`.

### Architecture Decisions
Reconciler is a pure ADR-4 reducer (reconciler.ts:5) — do NOT change its semantics (nonGoals[0]).

---

## 6. Testing Patterns

### Unit Test Pattern
**Source:** `src/orchestrator/evaluator-agent.test.ts`
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
// spies declared at top so vi.mock (hoisted) can close over them:
const loopSpy = vi.fn(async () => ({ finalText: JSON.stringify({...}), turnsUsed: 1, toolsCalled: [], usage: {...}, stopReason: "end_turn" as const }));
vi.mock("./agentic-loop.js", () => ({ runAgenticLoop: loopSpy }));
vi.mock("../telemetry/emit.js", () => ({ emit: vi.fn().mockResolvedValue(undefined) }));
beforeEach(() => { loopSpy.mockClear(); /* ... */ });
describe("...", () => { it("...", async () => {
  const { runEvaluatorAgent } = await import("./evaluator-agent.js");
  await runEvaluatorAgent(handoff, "/tmp/test-proj", config);
  expect(loopSpy).toHaveBeenCalledTimes(1);
}); });
```
**Runner:** vitest. **Assertion:** `expect`. **Mock:** `vi.mock` (hoisted; declare spies as top-level `const = vi.fn()`). **File naming:** `*.test.ts` collocated. **Per-lens verdict in the mock:** the existing `verdicts: boolean[]` FIFO queue (test lines 25, 33) drives each lens's `passed` — push verdicts in lens order, then assert `appendHistorySpy` received matching `details.passed` per lens.

**Key reuse:** `makeConfig({ enabled, lenses, maxConcurrent })` helper (test lines 163-172) builds a full BoberConfig with a panel override. Dynamic `await import("./evaluator-agent.js")` is required so module-level mocks apply.

### E2E Test Pattern
Not applicable — no Playwright; this is a pure-logic / orchestration sprint.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/orchestrator/pipeline.ts` | `runEvaluatorAgent` (evaluator-agent.ts) | low | Signature of `runEvaluatorAgent` is UNCHANGED — only internal helpers change. Verify pipeline still calls it the same way. |
| `src/orchestrator/evaluator-agent.test.ts` | `runEvaluatorAgent` internals + mocks | medium | Adding a `../state/history.js` mock must not break existing off/on-path call-count tests (lines 184-234). |
| `src/state/history.ts` consumers (loadHistory readers) | history JSONL format | low | New `event: "eval-lens-verdict"` validates against open schema; `loadHistory` skips nothing (history.ts:91 safeParse). No reader assumes a closed event set. |

### Existing Tests That Must Still Pass
- `src/orchestrator/evaluator-agent.test.ts` — C2 off-path (lines 184-206, exactly one judge call), C3 on-path concurrency (208-234), C4 fail-closed reconcile (236-276). All must stay green (C2, C4).
- Any test importing `history.ts` (e.g. `code-reviewer-agent.test.ts` mocks appendHistory) — unaffected; schema unchanged.

### Features That Could Be Affected
- **Evaluator panel (Sprint 1)** — shares `evaluator-agent.ts`. Verify off path makes exactly one call and emits NO verdicts; on path emits exactly one verdict per lens, order-aligned.

### Recommended Regression Checks
1. `npx tsc --noEmit` exits 0 (C5).
2. `npm run build` exits 0 (C5).
3. `npx eslint src/` exits 0 (C5) — confirm `import type` used for `EvalResult`/`HistoryEntry`, `.js` specifiers, no unused vars.
4. `npx vitest run src/orchestrator/evaluator-agent.test.ts src/orchestrator/eval-lenses.test.ts` — all green.
5. `npx vitest run` — full suite green except the documented flaky tool-count baseline (C5).
6. Manually confirm off-path branch (evaluator-agent.ts:147-150) has NO appendHistory call between it and the early return.

---

## 8. Implementation Sequence

1. **src/orchestrator/eval-lenses.ts** (create) — `LENS_CATALOG` (4 distinct non-empty fragments) + `resolveLensFocus(lens): string` with generic fallback.
   - Verify: import compiles; no deps; pure function.
2. **src/orchestrator/eval-lenses.test.ts** (create) — assert 4 built-ins distinct + non-empty; unknown lens → generic fallback, no throw (C1).
   - Verify: `npx vitest run src/orchestrator/eval-lenses.test.ts` green.
3. **src/orchestrator/evaluator-agent.ts** (modify) — add imports (`resolveLensFocus` from `./eval-lenses.js`, `appendHistory` from `../state/history.js`); replace inline lensBlock (281-285) with `resolveLensFocus(lens)`; add the per-lens `appendHistory` loop in the panel branch BEFORE `reconcile` (after line 159), index-aligned with `panel.lenses`. Leave off-path early return (149) untouched.
   - Verify: `npx tsc --noEmit` clean; off path unchanged.
4. **src/orchestrator/evaluator-agent.test.ts** (modify) — add `appendHistorySpy` + `vi.mock("../state/history.js")`; clear it in `beforeEach`; assert ON path emits one `eval-lens-verdict` per lens (correct lens + passed), OFF path emits none (C3, C2).
   - Verify: existing C2/C4 tests still green.
5. **Run full verification** — `npx tsc --noEmit`, `npm run build`, `npx eslint src/`, `npx vitest run` (C5).

---

## 9. Pitfalls & Warnings

- **DO NOT use `emit()` for the verdict** — its `TelemetryEventType` is a CLOSED union (emit.ts:30-39) with no `eval-lens-verdict` and no `lens`/`passed` payload field; it's also a no-op unless `telemetry.enabled`. Adding to it violates the confined-diff stop condition. Use `appendHistory` (open `event` string, open `details` record).
- **`phase` must be a valid `PhaseSchema` enum** (history.ts:25-34) — use `"evaluating"`, NOT a free string. A wrong phase throws `Invalid history entry` (history.ts:62).
- **NEVER emit on the off path** — the early `return` at evaluator-agent.ts:149 must remain the first thing the off path does. Off-path tests (C2) assert exactly one judge call and the new test must assert zero verdict records.
- **Keep the `lens ? ... : ""` shape** when wiring `resolveLensFocus` — `lens === undefined` must yield `""` so the off-path prompt stays byte-identical (C2). Do NOT call `resolveLensFocus(lens)` when `lens` is undefined.
- **Index alignment:** `mapBounded` (evaluator-agent.ts:170-181) preserves input order, so `lensResults[i]` corresponds to `panel.lenses[i]`. Iterate by index, not by re-deriving lens names.
- **vi.mock is hoisted** — declare `appendHistorySpy` as a top-level `const = vi.fn()` (like `loopSpy` at test line 28), reference it inside the `vi.mock` factory, and clear it in `beforeEach` (lines 176-182). Defining the spy inside `describe` will fail hoisting.
- **Do NOT touch** reconciler.ts, combine logic, config schema, the telemetry/history Zod schemas, workflow engine, agents/*.md, or providers/types.ts (nonGoals[0,3], stopConditions[1]).
- **No `any`** — use `unknown` + narrowing if needed; eslint warns on `no-explicit-any` (principles.md:40).
