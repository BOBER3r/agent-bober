# Sprint Briefing: TS Checkpoint 2 synthesis panel

**Contract:** sprint-spec-20260604-architect-lens-panel-2
**Generated:** 2026-06-04T07:00:00Z

---

## 0. The Crux (read this first)

This sprint refactors `runArchitect` (`src/orchestrator/architect-agent.ts:142`) so **Checkpoint 2 (approach selection) becomes a gated seam**:

- **Panel OFF** (`config.architect?.panel` undefined, or `!enabled`, or `lenses.length < 2`) → run TODAY's single monolithic `runAgenticLoop` path **byte-identical** and return the same `ArchitectResult`.
- **Panel ON** (`enabled && lenses.length >= 2`) → (1) generate candidate approaches via a focused LLM call, (2) `mapBounded(lenses, maxConcurrent, lens => scoreApproaches(lens))` collecting per-lens scores, (3) `synthesize(approaches, lensScores)` → ranked `winner`, (4) feed the selected winner + lensScores into a continuation that still runs CP3/CP4/CP5 and saves the architecture doc + ADR-1, producing a full `ArchitectResult` (with the additive `lensScores?` field).

**The mirror module is `src/orchestrator/evaluator-agent.ts`** — it already implements the exact off-path-guard + `mapBounded` + per-lens fan-out pattern this sprint must replicate. Copy its structure.

**`config` IS already passed to `runArchitect`** (`architect-agent.ts:142-147`, param `config: BoberConfig`), so `config.architect?.panel` is reachable at the seam. NOTE: `architect` is **optional** on the config (`schema.ts:343` `architect: ArchitectSectionSchema.optional()`), so you MUST use `config.architect?.panel` — `undefined` means OFF.

---

## 1. Target Files

### src/orchestrator/architect-agent.ts (modify)

**`ArchitectResult` interface (lines 22-35) — add ONE additive optional field:**
```ts
export interface ArchitectResult {
  id: string;
  timestamp: string;
  document: string;
  adrs: string[];
  componentCount: number;
  decisionCount: number;
  // ADD (additive, optional — a result without it still validates, C3):
  // lensScores?: Array<{ lens: string; scores: Record<string, number> }>;
}
```
Match the SynthesisResult input shape: `Array<{ lens: string; scores: Record<string, number> }>` (mirrors synthesize's 2nd param at `synthesizer.ts:53-56`).

**`runArchitect` signature (lines 142-147) — DO NOT change the signature:**
```ts
export async function runArchitect(
  userPrompt: string,
  projectRoot: string,
  config: BoberConfig,
  researchDoc?: string,
): Promise<ArchitectResult>
```

**The single monolithic flow (the OFF path you must preserve byte-identical):**
- `generateArchitectId(userPrompt)` → `architectId` (line 150)
- tool/prompt setup: `getGraphState`/`getGraphDeps`/`resolveRoleTools` (156-158), `assembleSystemPrompt` (160)
- `createClient(config.planner.provider ?? null, config.planner.endpoint ?? null, config.planner.providerConfig, config.planner.model, "Architect")` (lines 162-168) — NOTE: architect uses `config.planner.*`, NOT `config.architect.*`, for the client.
- `resolveModel(config.planner.model)` (170)
- `researchSection` built from `truncateResearch(researchDoc)` (172-174)
- `autonomousMessage` — the big 5-checkpoint prompt template (lines 176-232). CP2 = "Checkpoint 2: Approach Selection" (lines 203-204).
- PreflightContextInjector graph injection → `enhancedMessage` (239-241)
- **THE ONE `runAgenticLoop` CALL** (lines 243-259): `{ client, model, systemPrompt, userMessage: enhancedMessage, tools, toolHandlers, maxTurns: ARCHITECT_MAX_TURNS, maxTokens: 16384, onToolUse }`
- token-usage capture (268-280)
- `parseArchitectResponse(result.finalText)` → `raw` (282)
- read back doc via `readArchitecture` (286-288); read back ADRs via `readADRs` (296-297)
- componentCount/decisionCount derivation (302-306)
- fallback doc save if `!document` (309-338)
- final `return { id, timestamp, document, adrs, componentCount, decisionCount }` (342-349)

**RECOMMENDED SEAM STRUCTURE.** The lowest-disruption shape that keeps the OFF path byte-identical: extract the EXISTING body (lines 150-349, everything from `generateArchitectId` through the return) into a private helper `runArchitectSingleLoop(userPrompt, projectRoot, config, researchDoc): Promise<ArchitectResult>` with the body moved verbatim. Then `runArchitect` becomes:
```ts
export async function runArchitect(userPrompt, projectRoot, config, researchDoc?): Promise<ArchitectResult> {
  const panel = config.architect?.panel;
  if (!panel?.enabled || panel.lenses.length < 2) {
    return runArchitectSingleLoop(userPrompt, projectRoot, config, researchDoc); // OFF: verbatim
  }
  return runArchitectPanel(userPrompt, projectRoot, config, panel, researchDoc); // ON: panel flow
}
```
This guarantees the OFF path is the identical code with identical `runAgenticLoop` invocation (single call), which is what the C1 test asserts. Keep `logger.phase("Architect Phase")` placement consistent (currently line 148) — put it inside `runArchitect` before the branch OR inside both helpers; pick one and be consistent so a test counting calls is not confused.

**The ON path (`runArchitectPanel`) must STILL produce a full ArchitectResult.** It still needs a `runAgenticLoop`-driven continuation for CP3/CP4/CP5 + doc/ADR save. Recommended: (1) one focused `runAgenticLoop` call asking ONLY for 2-3 candidate approaches (CP2 format) → parse approach identifiers; (2) `mapBounded(panel.lenses, panel.maxConcurrent, lens => oneScoringRunAgenticLoopCall(lens))` → per-lens `{ lens, scores }`; (3) `synthesize(approaches, lensScores)` → `winner`; (4) a continuation `runAgenticLoop` call that runs CP1+CP3+CP4+CP5 and assembles/saves the doc + ADR-1 with the selected `winner` and lensScores threaded into the prompt — reuse as much of the existing `autonomousMessage` template as possible (parameterize the CP2 block to say "the approach has already been selected: <winner>"). Return the same shape PLUS `lensScores`.

**Imports this file uses:** `BoberConfig` (type), `createClient`, `saveArchitecture`/`readArchitecture`/`readADRs`, `logger`, `resolveModel`, `assembleSystemPrompt`, `resolveRoleTools`/`getGraphState`/`getGraphDeps`, `runAgenticLoop`, `PreflightContextInjector`, `graphPipelineLifecycle` (lines 1-10). **ADD:** `import { synthesize } from "./workflow/synthesizer.js";` and `import { resolveArchLensFocus } from "./arch-lenses.js";` and `import type { SynthesisResult } from "./workflow/synthesizer.js";` if needed.

**Imported by (callers — see Impact Analysis §7):**
- `src/orchestrator/pipeline.ts:30,593` — calls `runArchitect(userPrompt, projectRoot, config, researchDoc?.findings)` and reads `.decisionCount` / `.id`.
- `src/mcp/tools/architect.ts:11,75` — calls `runArchitect(task, projectRoot, config, researchDoc)`.

**Test file:** `src/orchestrator/architect-agent.test.ts` — DOES NOT EXIST (you create it).

---

### src/orchestrator/architect-agent.test.ts (create)

**Directory pattern:** colocated `*.test.ts` next to source (principles.md:20). 
**Most similar existing file:** `src/orchestrator/evaluator-agent.test.ts` — mirror its mock harness EXACTLY (see §6).
**Structure template:** see §6 Testing Patterns — copy the vi.mock block, the concurrency-counter `loopSpy`, and the three test groups (off single-call, on call-count + peak<=maxConcurrent, result-shape with/without lensScores).

---

## 2. Patterns to Follow

### Off-path guard + bounded fan-out (THE pattern to mirror)
**Source:** `src/orchestrator/evaluator-agent.ts`, lines 142-175
```ts
const panel = config.evaluator.panel;
if (!panel.enabled || panel.lenses.length < 2) {
  // Off path — single judge call, byte-identical to the original behavior.
  return runSingleLensEval(handoff, programmaticResults, projectRoot, config);
}
// On path — fan out one judge per lens with bounded concurrency.
const lensResults = await mapBounded(
  panel.lenses,
  panel.maxConcurrent,
  (lens) => runSingleLensEval(handoff, programmaticResults, projectRoot, config, lens),
);
```
**Rule:** Guard first, return the unchanged single path on OFF; fan out via `mapBounded` on ON. For architect, the guard is `config.architect?.panel` (optional) so use `!panel?.enabled || panel.lenses.length < 2`.

### mapBounded — REUSE this exact implementation (do NOT invent new concurrency)
**Source:** `src/orchestrator/evaluator-agent.ts`, lines 184-195
```ts
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
**Rule:** Copy this helper verbatim into architect-agent.ts (it is module-private in evaluator-agent.ts and NOT exported, so you cannot import it — duplicate it as a private helper). Chunk-based batching guarantees peak concurrency <= cap, which the C2 concurrency-counter test asserts.

### Per-lens scoring call (mirror runSingleLensEval shape)
**Source:** `src/orchestrator/evaluator-agent.ts`, lines 204-336 (esp. 297-299, 316-330)
```ts
const lensBlock = lens
  ? `\n\n## Evaluation Lens: ${lens}\n${resolveLensFocus(lens)}`
  : "";
// ... build userMessage ...
const result = await runAgenticLoop({ client, model, systemPrompt, userMessage: enhancedMessage, tools, toolHandlers, maxTurns, maxTokens: 16384, onToolUse });
```
**Rule:** For architect, append a lens focus block using `resolveArchLensFocus(lens)` (NOT resolveLensFocus). Each lens call is ONE runAgenticLoop call so the C2 test's `loopSpy` call-count == lenses.length (plus the generate-approaches call and continuation call — see Pitfalls §9 about counting).

### synthesize call (sprint-1, pure ranking)
**Source:** `src/orchestrator/workflow/synthesizer.ts`, lines 53-56
```ts
export function synthesize(
  approaches: string[],
  lensScores: Array<{ lens: string; scores: Record<string, number> }>,
): SynthesisResult
```
**Rule:** Pass the approach identifiers and the per-lens `{ lens, scores }` array from `mapBounded`; use `synthesize(...).winner` as the selected approach. `SynthesisResult` (lines 7-33) has `{ winner, ranking, graftedIdeas, dissent }`. `synthesize` THROWS if `approaches` is empty (line 57-59) — ensure approaches is non-empty before calling.

### resolveArchLensFocus (sprint-1, never throws)
**Source:** `src/orchestrator/arch-lenses.ts`, lines 26-31
```ts
export function resolveArchLensFocus(lens: string): string {
  return ARCH_LENS_CATALOG[lens] ??
    `Evaluate this architecture specifically through the '${lens}' lens.`;
}
```
**Rule:** Known lenses (scalability, security, cost, operability, maintainability, reversibility) get catalog text; unknown custom strings get a generic non-empty fallback. Never throws.

### createClient invocation (architect uses planner config)
**Source:** `src/orchestrator/architect-agent.ts`, lines 162-168
```ts
const client = createClient(
  config.planner.provider ?? null,
  config.planner.endpoint ?? null,
  config.planner.providerConfig,
  config.planner.model,
  "Architect",
);
```
**Rule:** All panel-path LLM calls (generate-approaches, per-lens scoring, continuation) must use the SAME `config.planner.*` client construction — do NOT read `config.architect.*` for provider/model (architect section only carries `panel`).

### Section headers
**Source:** `src/orchestrator/architect-agent.ts:12`, `evaluator-agent.ts:26,128,177`
```ts
// ── Constants ──────────────────────────────────────────────────────
```
**Rule:** Use unicode box-drawing `// ── Name ──` headers (principles.md:32).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `synthesize` | `src/orchestrator/workflow/synthesizer.ts:53` | `(approaches: string[], lensScores: Array<{lens,scores}>) => SynthesisResult` | Pure ranking reducer → winner/ranking/dissent. Use for CP2 winner. |
| `resolveArchLensFocus` | `src/orchestrator/arch-lenses.ts:26` | `(lens: string) => string` | Lens → focus prompt fragment (6 built-ins + fallback). |
| `mapBounded` | `src/orchestrator/evaluator-agent.ts:184` | `<T,R>(items, cap, fn) => Promise<R[]>` | Bounded-concurrency map (chunk batching). PRIVATE — copy, don't import. |
| `createClient` | `src/providers/factory.ts` (imported at `architect-agent.ts:2`) | `(provider, endpoint, providerConfig, model, label?) => Client` | Provider-agnostic LLM client. |
| `runAgenticLoop` | `src/orchestrator/agentic-loop.ts:31` returns `AgenticLoopResult` | `(params: AgenticLoopParams) => Promise<{finalText, turnsUsed, toolsCalled, usage, stopReason}>` | Multi-turn tool loop. |
| `resolveModel` | `src/orchestrator/model-resolver.js` (`architect-agent.ts:5`) | `(model: string) => string` | Resolve model alias. |
| `assembleSystemPrompt` | `src/orchestrator/agent-loader.js` (`architect-agent.ts:6`) | `(role, agentName, projectRoot, graphState) => Promise<string>` | Build system prompt. |
| `resolveRoleTools` / `getGraphState` / `getGraphDeps` | `src/orchestrator/tools/index.js` (`architect-agent.ts:7`) | — | Tool set + graph state resolution. |
| `parseArchitectResponse` | `src/orchestrator/architect-agent.ts:81` (private) | `(text: string) => RawArchitectResult` | Parse architect JSON output. Reuse in panel continuation. |
| `generateArchitectId` / `truncateResearch` | `src/orchestrator/architect-agent.ts:39,60` (private) | — | Already in-file; reuse. |

Utilities reviewed: `src/utils/` (logger, git, fs), `src/orchestrator/workflow/`, `src/orchestrator/`. The four core building blocks for this sprint are synthesize, resolveArchLensFocus, mapBounded (copy), and runAgenticLoop.

---

## 4. Prior Sprint Output

### Sprint 1 (commit 7de08b5): Architect lens-panel foundations
**Created:** `src/orchestrator/workflow/synthesizer.ts` — exports `synthesize(approaches, lensScores): SynthesisResult` and `interface SynthesisResult { winner, ranking, graftedIdeas, dissent }`.
**Created:** `src/orchestrator/arch-lenses.ts` — exports `resolveArchLensFocus(lens): string` over 6 lenses + fallback.
**Modified:** `src/config/schema.ts` — added `ArchitectSectionSchema` (line 122-129) with `panel: { enabled, lenses, maxConcurrent }`, wired as `architect: ArchitectSectionSchema.optional()` (line 343).
**Connection to this sprint:** The ON path imports `synthesize` + `resolveArchLensFocus` from these modules (DO NOT modify them — nonGoal). The seam gate reads `config.architect?.panel` (optional ⇒ `?.`). `panel` shape: `{ enabled: boolean; lenses: string[]; maxConcurrent: number }` with defaults `{ enabled:false, lenses:[], maxConcurrent:4 }`.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM everywhere** — all imports use `.js` extensions for NodeNext (line 27). New imports: `"./workflow/synthesizer.js"`, `"./arch-lenses.js"`.
- **`import type`** — `consistent-type-imports` enforced (line 35). Import `SynthesisResult`/`BoberConfig` as `import type`.
- **Strict TS** — `noUnusedLocals`/`noUnusedParameters`; prefix unused with `_` (line 36).
- **No `any`** — use `unknown` + narrowing (line 40).
- **Colocated tests, Vitest** (line 20). **No real LLM/network in tests** — mock createClient + runAgenticLoop.
- **Unicode section headers** `// ── Name ──` (line 32).
- **Conventional commit:** `bober(sprint-2): add TS architect Checkpoint 2 synthesis panel`.

### Architecture Decisions
ADR-5 (graph-prompt decoration) and ADR-8/ADR-9 (graph tool gating + preflight injection) are referenced inline in architect-agent.ts (lines 154-160, 236-241). Keep those calls intact in BOTH paths (they are part of byte-identical OFF behavior).

---

## 6. Testing Patterns

### Unit Test Pattern (mirror evaluator-agent.test.ts)
**Source:** `src/orchestrator/evaluator-agent.test.ts`

**The concurrency-counter loopSpy (lines 22-53)** — copy this pattern:
```ts
let active = 0;
let peak = 0;
const loopSpy = vi.fn(async () => {
  active++;
  peak = Math.max(peak, active);
  await new Promise<void>((r) => setTimeout(r, 5)); // force overlap
  active--;
  return {
    finalText: JSON.stringify({ /* architect JSON output */ }),
    turnsUsed: 1, toolsCalled: [], usage: { inputTokens: 0, outputTokens: 0 },
    stopReason: "end_turn" as const,
  };
});
const clientSpy = vi.fn(() => ({} as never));
```

**The vi.mock block (lines 57-97)** — architect needs these mocks (drop evaluator-only ones, KEEP graph/state mocks):
```ts
vi.mock("./agentic-loop.js", () => ({ runAgenticLoop: loopSpy }));
vi.mock("../providers/factory.js", () => ({ createClient: clientSpy }));
vi.mock("./model-resolver.js", () => ({ resolveModel: () => "claude-test" }));
vi.mock("./agent-loader.js", () => ({ assembleSystemPrompt: vi.fn().mockResolvedValue("SYS") }));
vi.mock("./tools/index.js", () => ({
  resolveRoleTools: () => ({ schemas: [], handlers: new Map() }),
  getGraphState: () => ({ enabled: false, engineHealth: "disabled" }),
  getGraphDeps: () => undefined,
}));
vi.mock("../graph/preflight-injector.js", () => ({
  PreflightContextInjector: class { async inject(_r, _c, m: string) { return m; } },
}));
vi.mock("../graph/pipeline-lifecycle.js", () => ({
  graphPipelineLifecycle: { getGraphClient: () => null },
}));
```
**ALSO mock `../state/index.js`** (architect calls `saveArchitecture`/`readArchitecture`/`readADRs` and the token-usage `../graph/token-usage.js` dynamic import). Mock `readArchitecture`→resolves a doc string, `readADRs`→resolves `[]`, `saveArchitecture`→resolves; and `vi.mock("../graph/token-usage.js", () => ({ TokenUsageLog: class { async append() {} } }))`. These are dynamically `await import(...)`'d (architect-agent.ts:269,287,296) — vi.mock hoisting still intercepts dynamic imports.

**Config builder (lines 169-178)** — adapt for architect:
```ts
function makeConfig(panelOverride?: { enabled: boolean; lenses: string[]; maxConcurrent: number }): BoberConfig {
  const base = createDefaultConfig("test-project", "brownfield");
  return panelOverride === undefined ? base : { ...base, architect: { panel: panelOverride } };
}
```
NOTE: `architect` is optional — for the OFF "unset" case pass `undefined` (no `architect` key).

**Off-path single-call assertion (lines 192-197):**
```ts
it("panel undefined → exactly one runAgenticLoop call (single-loop branch)", async () => {
  const config = makeConfig(undefined);
  const { runArchitect } = await import("./architect-agent.js");
  await runArchitect("build a thing", "/tmp/test-proj", config);
  expect(loopSpy).toHaveBeenCalledTimes(1);
});
```

**On-path call-count + peak concurrency (lines 216-227):**
```ts
it("3 lenses → per-lens scoring calls, peak concurrency <= maxConcurrent=2", async () => {
  const config = makeConfig({ enabled: true, lenses: ["scalability","security","cost"], maxConcurrent: 2 });
  const { runArchitect } = await import("./architect-agent.js");
  await runArchitect("build a thing", "/tmp/test-proj", config);
  // assert: scoring-phase calls == 3 (see Pitfalls about total loopSpy count incl generate+continuation)
  expect(peak).toBeLessThanOrEqual(2);
});
```

**Runner:** vitest. **Assertion style:** `expect`. **Mock approach:** `vi.mock` (module-level hoisted). **File naming:** `architect-agent.test.ts` colocated. **beforeEach** resets `active=0; peak=0; loopSpy.mockClear(); clientSpy.mockClear();` (lines 182-189).

### E2E Test Pattern
Not applicable — this is a backend orchestrator module; no Playwright/E2E.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/orchestrator/pipeline.ts:593` | `runArchitect` | low | Calls `runArchitect(userPrompt, projectRoot, config, researchDoc?.findings)`, reads `.id`/`.decisionCount`. Signature unchanged + result shape additive ⇒ safe. |
| `src/mcp/tools/architect.ts:75` | `runArchitect` | low | Calls `runArchitect(task, projectRoot, config, researchDoc)`. Signature/shape preserved ⇒ safe. |

Risk is LOW because the signature is unchanged and `lensScores?` is additive-optional. The HIGH risk is internal: accidentally altering OFF-path behavior (see §9).

### Existing Tests That Must Still Pass
- `src/orchestrator/evaluator-agent.test.ts` — the mirror; must stay green (you do not touch evaluator-agent.ts). Verify `mapBounded` duplication in architect does not break it.
- Any `pipeline`/`mcp` tests that import architect — run full `npx vitest run` and tolerate ONLY the documented pre-existing skipped baseline (C4).
- No prior architect test exists (you create the first), so there is no architect regression suite to preserve — but the OFF path must behaviorally equal the prior monolithic code.

### Features That Could Be Affected
- **Evaluator lens panel** (sibling feature) — shares the `mapBounded` + panel-config idiom. They are independent modules; just keep the duplicated `mapBounded` byte-identical to the evaluator's so behavior matches.
- **Sprint 3 (CP5 review panel)** — builds on this seam. Keep CP5 unchanged this sprint (nonGoal).

### Recommended Regression Checks
1. `npx tsc --noEmit` exits 0.
2. `npm run build` exits 0.
3. `npx eslint src/` exits 0 (watch `consistent-type-imports`, unused vars).
4. `npx vitest run` — full suite green except documented pre-existing skips; `evaluator-agent.test.ts` and the new `architect-agent.test.ts` both pass.
5. Confirm `synthesizer.ts`, `arch-lenses.ts`, `reconciler.ts` are UNMODIFIED (`git diff --stat` shows only `architect-agent.ts` + `architect-agent.test.ts`).

---

## 8. Implementation Sequence

1. **`ArchitectResult` interface** (`architect-agent.ts:22-35`) — add `lensScores?: Array<{ lens: string; scores: Record<string, number> }>;`.
   - Verify: `npx tsc --noEmit` still clean; existing callers compile.
2. **Add imports** — `synthesize` from `"./workflow/synthesizer.js"`, `resolveArchLensFocus` from `"./arch-lenses.js"` (and `import type { SynthesisResult }` if referenced).
   - Verify: no unused-import lint error.
3. **Copy `mapBounded`** as a private helper into architect-agent.ts (verbatim from `evaluator-agent.ts:184-195`).
   - Verify: generic types compile under strict mode.
4. **Extract OFF path** — move the current body (lines 150-349) verbatim into `async function runArchitectSingleLoop(userPrompt, projectRoot, config, researchDoc?): Promise<ArchitectResult>`.
   - Verify: behavior unchanged; OFF test would still see exactly one `runAgenticLoop` call.
5. **Add the seam in `runArchitect`** — read `config.architect?.panel`; `if (!panel?.enabled || panel.lenses.length < 2) return runArchitectSingleLoop(...)`.
   - Verify: OFF unit test (one loop call) passes.
6. **Implement `runArchitectPanel`** — generate-approaches call → `mapBounded(panel.lenses, panel.maxConcurrent, lens => scoreCall(lens))` → `synthesize(approaches, lensScores)` → continuation call building doc+ADR-1 with `winner` → return full `ArchitectResult` incl `lensScores`.
   - Verify: ON test sees lenses.length scoring calls, peak<=maxConcurrent, selected == `synthesize().winner`.
7. **Create `architect-agent.test.ts`** — mirror evaluator harness (§6); add mocks for `../state/index.js` + `../graph/token-usage.js`; write OFF single-call, ON call-count/peak, result-shape (with/without lensScores) tests.
   - Verify: `npx vitest run src/orchestrator/architect-agent.test.ts` green.
8. **Full verification** — `npx tsc --noEmit`, `npm run build`, `npx eslint src/`, `npx vitest run`.

---

## 9. Pitfalls & Warnings

- **OFF byte-identical is the #1 risk.** Move the existing body verbatim into `runArchitectSingleLoop`; do NOT "tidy" it. The C1 test asserts exactly ONE `runAgenticLoop` call on OFF. Any extra LLM call (even a refactored prompt build) breaks byte-identical equivalence.
- **`config.architect` is OPTIONAL.** Use `config.architect?.panel` and `!panel?.enabled`. Reading `config.architect.panel` (no `?.`) throws on the common case where the architect section is absent. The evaluator uses `config.evaluator.panel` (non-optional) — do NOT copy that; architect's is optional (`schema.ts:343`).
- **Architect client uses `config.planner.*`, not `config.architect.*`.** The architect section only carries `panel`. All ON-path LLM calls must use `config.planner.provider/endpoint/providerConfig/model` + `"Architect"` label (lines 162-168).
- **`mapBounded` is module-private in evaluator-agent.ts** — you CANNOT import it. Copy it verbatim. Do not invent a new concurrency primitive.
- **loopSpy total call count on ON path.** The ON path makes generate-approaches (1) + per-lens scoring (lenses.length) + continuation (1) calls. The C2 test asserts the SCORING-phase count == lenses.length — assert on a structure that isolates scoring calls, or assert `peak <= maxConcurrent` (only the scoring phase runs concurrently; generate + continuation are sequential and won't raise peak above maxConcurrent if maxConcurrent>=1). Be explicit in the test about which calls you count; the contract C2 says "call-count == lenses.length" referring to scoring calls.
- **`synthesize` throws on empty `approaches`** (`synthesizer.ts:57`). Guard: if generate-approaches yields zero, fall back gracefully (or guarantee >=1 in the prompt parse).
- **Dynamic imports are mocked too.** Architect uses `await import("../state/index.js")` (287,296) and `await import("../graph/token-usage.js")` (269). vi.mock hoisting intercepts these — mock them in the test or the OFF path will hit real fs.
- **Do not modify** `synthesizer.ts`, `arch-lenses.ts`, `reconciler.ts`, CP1/CP3/CP4 behavior, the doc save path, or the native surface (nonGoals). Confine the diff to `architect-agent.ts` + `architect-agent.test.ts`.
- **`reconcile()` is NOT used here.** CP2 is ranking (synthesize → winner), not pass/fail (reconcile is the evaluator's panel). Do not import reconcile.
- **Git hygiene:** stage only `src/orchestrator/architect-agent.ts` and `src/orchestrator/architect-agent.test.ts` with explicit paths; never `git add -A`; stay on the feature branch.
