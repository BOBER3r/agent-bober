# Sprint Briefing: Team-aware pipeline-shape selection

**Contract:** sprint-spec-20260615-team-abstraction-3
**Generated:** 2026-06-15T00:00:00Z

---

## 0. The One-Paragraph Mental Model

`resolveEngineName(config)` picks a REQUESTED engine name from `config.pipeline.engine` then applies a downgrade (`workflow`→`ts` when ineligible OR mode==='careful', logging ONE line). `selectPipelineEngine(config)` maps that name to a concrete `PipelineEngine` instance. This sprint adds a team-aware variant that takes the REQUESTED name from `team.pipelineShape` instead of `config.pipeline.engine`, but **reuses the exact same downgrade + instantiation logic**. Because the programming team's `pipelineShape === resolveEngineName(config)` (set in Sprint 1, registry.ts:68), the programming path is byte-for-byte identical to today. `runPipeline` resolves the active team via `loadTeam` and threads its shape through the new selector. Keep it minimal, additive, and DO NOT touch eligibility semantics or the downgrade log lines.

---

## 1. Target Files

### src/orchestrator/workflow/selector.ts (modify)

This is the CORE of the sprint. Full current contents (64 lines) — **reuse, do not rewrite**:

**`resolveEngineName` (lines 22-37):**
```ts
export function resolveEngineName(config: BoberConfig): PipelineEngineName {
  const requested: PipelineEngineName = config.pipeline?.engine ?? "ts";

  if (requested === "workflow") {
    const eligible = isWorkflowEligible(config);
    const careful = config.pipeline?.mode === "careful";
    if (!eligible || careful) {
      logger.info(
        `Workflow engine requested but ${!eligible ? "ineligible" : "mode='careful'"}; downgrading to 'ts'.`,
      );
      return "ts";
    }
  }

  return requested;
}
```

**`selectPipelineEngine` (lines 50-63):**
```ts
export function selectPipelineEngine(config: BoberConfig): PipelineEngine {
  const name = resolveEngineName(config);
  switch (name) {
    case "ts":
      return new TsPipelineEngine();
    case "skill":
      // Skill engine deferred (non-goal this sprint); falls through to TS.
      return new TsPipelineEngine();
    case "workflow":
      // Reachable only when resolveEngineName returns 'workflow' (eligible + not careful).
      return new WorkflowEngine();
  }
}
```

**Imports already present (lines 1-6) — reuse them, add `Team` type import:**
- `import type { BoberConfig } from "../../config/schema.js";`
- `import { logger } from "../../utils/logger.js";`
- `import type { PipelineEngine, PipelineEngineName } from "./engine.js";`
- `import { isWorkflowEligible } from "./eligibility.js";`
- `import { TsPipelineEngine } from "./ts-engine.js";`
- `import { WorkflowEngine } from "./workflow-engine.js";`

**You will ADD:** `import type { Team } from "../../teams/types.js";` (Team interface lives at src/teams/types.ts:21).

**Imported by:**
- `src/orchestrator/pipeline.ts:965` — `import { selectPipelineEngine } from "./workflow/selector.js";`
- `src/teams/registry.ts:11` — `import { resolveEngineName } from "../orchestrator/workflow/selector.js";` (registry depends on `resolveEngineName` — DO NOT break its signature)
- `src/orchestrator/workflow/workflow-engine.test.ts:31` — imports `selectPipelineEngine`
- `src/orchestrator/workflow/selector.test.ts:8` — imports `resolveEngineName`

**Test file:** `src/orchestrator/workflow/selector.test.ts` (exists — extend it)

---

### src/orchestrator/workflow/selector.test.ts (modify)

Add new tests for the team-aware path. Current contents tested only `resolveEngineName` branches (see Section 6).

**Test file:** itself.

---

### src/orchestrator/pipeline.ts (modify — surgical, ~lines 963-978 only)

**Exact current call site (lines 963-978):**
```ts
// ── Engine-selection seam ──────────────────────────────────────────

import { selectPipelineEngine } from "./workflow/selector.js";

/**
 * Public entry point. Resolves the configured pipeline engine and delegates.
 * Signature is frozen — callers must not be updated when the engine changes.
 */
export async function runPipeline(
  userPrompt: string,
  projectRoot: string,
  config: BoberConfig,
  opts?: { runId?: string },
): Promise<PipelineResult> {
  return selectPipelineEngine(config).run(userPrompt, projectRoot, config, opts);
}
```

**What to change here (and ONLY here):**
- Add `import { selectPipelineEngineForTeam } from "./workflow/selector.js";` (or extend the existing import on line 965).
- Add `import { loadTeam } from "../teams/registry.js";`.
- Extend the `opts` object additively: `opts?: { runId?: string; teamId?: string }` — the comment says "Signature is frozen — callers must not be updated when the engine changes," so keep it backward-compatible (optional field; existing callers pass no `teamId`).
- Inside the body: resolve the team id = `opts?.teamId ?? config.defaultTeam` (both already exist; `config.defaultTeam` is `z.string().optional()` at schema.ts:402). Pass that to `loadTeam(config, teamId)`. With `teamId === undefined`, `loadTeam` returns the programming team (registry.ts:36), whose `pipelineShape === resolveEngineName(config)` → identical to today.
- Replace the body with: resolve team, then `selectPipelineEngineForTeam(team, config).run(userPrompt, projectRoot, config, opts)`.

**`runPipeline` is exported and is the public entry point** — its frozen signature must stay backward compatible. `opts` is the only safe place to add `teamId` (additive optional field).

**Imported by (callers — DO NOT break runPipeline's positional signature):**
- `src/cli/...` and orchestrator entry points call `runPipeline(userPrompt, projectRoot, config, opts?)`. Grep before final commit: `grep -rn "runPipeline(" src/ | grep -v "\.test\."`. Adding an optional `teamId` to the existing optional `opts` object is non-breaking.

**Test file:** `src/orchestrator/pipeline.ts` has NO co-located `pipeline.test.ts`. Per the contract (sc-3-6), add a runPipeline-level test. **Recommendation:** put the runPipeline team-aware assertion in `selector.test.ts` or a new `pipeline-team.test.ts`, but the simplest in-keeping approach is to assert at the `selectPipelineEngineForTeam` level (pure, no LLM) and add ONE runPipeline test that stubs the engine factory. See Section 6 for the seam.

---

## 2. Patterns to Follow

### Pattern: Pure resolver returns a NAME, selector maps name → instance
**Source:** `src/orchestrator/workflow/selector.ts`, lines 22-37 (resolver) and 50-63 (selector)
The resolver (`resolveEngineName`) is pure and does the downgrade; the selector (`selectPipelineEngine`) only does the `switch` over the name. **Mirror this split:** the new team-aware function should compute the resolved name from `team.pipelineShape` (applying the SAME downgrade), then run the SAME switch. Do not duplicate the switch — factor it or delegate.

**Recommended minimal shape (additive, reuses everything):**
```ts
// ── Team-aware resolver/selector ────────────────────────────────────

/** Resolve the engine NAME for a team: team.pipelineShape is the requested
 *  engine, then the SAME downgrade pipeline applies. */
export function resolveEngineNameForTeam(
  team: Team,
  config: BoberConfig,
): PipelineEngineName {
  const requested = team.pipelineShape;
  if (requested === "workflow") {
    const eligible = isWorkflowEligible(config);
    const careful = config.pipeline?.mode === "careful";
    if (!eligible || careful) {
      logger.info(
        `Workflow engine requested but ${!eligible ? "ineligible" : "mode='careful'"}; downgrading to 'ts'.`,
      );
      return "ts";
    }
  }
  return requested;
}

export function selectPipelineEngineForTeam(
  team: Team,
  config: BoberConfig,
): PipelineEngine {
  const name = resolveEngineNameForTeam(team, config);
  switch (name) {
    case "ts":
      return new TsPipelineEngine();
    case "skill":
      return new TsPipelineEngine();
    case "workflow":
      return new WorkflowEngine();
  }
}
```
**Rule:** The downgrade log line MUST be byte-identical to selector.ts:29-31 (a test asserts `toHaveBeenCalledTimes(1)`). To avoid drift, the CLEANEST approach is to make `resolveEngineName` delegate to a shared core, OR have `resolveEngineNameForTeam` reuse the identical block. Either is fine; just keep the log string identical.

> ALTERNATIVE the contract explicitly blesses (generatorNotes): extend `resolveEngineName` to take an optional requested-engine override: `resolveEngineName(config, requestedOverride?: PipelineEngineName)`. Then `resolveEngineNameForTeam` is just `resolveEngineName(config, team.pipelineShape)`, and `selectPipelineEngine(config)` delegates to the programming team or to the no-override path. This DRYs the downgrade block (single source of the log line). The default param keeps the existing one-arg `resolveEngineName(config)` callers (registry.ts:54, registry.ts:68, selector.test.ts) working unchanged.

### Pattern: Back-compat delegation
**Source:** contract generatorNotes + sc-3-4
**Rule:** Keep `selectPipelineEngine(config)` and `resolveEngineName(config)` working unchanged (registry.ts and many tests call them). The cleanest: `selectPipelineEngine(config)` delegates to `selectPipelineEngineForTeam(loadTeam(config), config)` OR `resolveEngineName` stays the single source the team variant reuses. **A test MUST assert the programming-team equivalence** (sc-3-4).

### Pattern: Constructor injection seam for engines (no real LLM)
**Source:** `src/orchestrator/workflow/workflow-engine.ts`, lines 40-43
```ts
constructor(
  private readonly tsEngineFactory: () => PipelineEngine = () =>
    new TsPipelineEngine(),
) {}
```
**Rule:** Engines accept an injected factory so tests pass a fake `PipelineEngine` returning a sentinel `PipelineResult` — NO real LLM. For runPipeline-level testing, the seam is: assert `selectPipelineEngineForTeam` returns the right `instanceof` (pure, no run), and/or stub `selectPipelineEngineForTeam` via `vi.mock` to return a fake engine whose `.run` returns a sentinel.

### Pattern: Section comments (project principle)
**Source:** `src/orchestrator/workflow/selector.ts:8`, `:39` (`// ── Resolver ───`, `// ── Selector ───`)
**Rule:** Use unicode box-drawing section headers `// ── Name ──────` (principles.md:32). Add a `// ── Team-aware selection ──` section.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `resolveEngineName` | `src/orchestrator/workflow/selector.ts:22` | `(config: BoberConfig): PipelineEngineName` | Pure resolver: requested engine + downgrade. REUSE — do not duplicate the downgrade block (or factor it). |
| `selectPipelineEngine` | `src/orchestrator/workflow/selector.ts:50` | `(config: BoberConfig): PipelineEngine` | Maps name → engine instance. Keep for back-compat. |
| `isWorkflowEligible` | `src/orchestrator/workflow/eligibility.ts:10` | `(_config: BoberConfig): boolean` | Eligibility probe (returns `false` today). DO NOT change. Tests mock via `vi.mock("./eligibility.js")`. |
| `loadTeam` | `src/teams/registry.ts:34` | `(config: BoberConfig, teamId?: string): Team` | Resolves the active Team; no id / 'programming' → programming team (pipelineShape === resolveEngineName(config)). |
| `TsPipelineEngine` | `src/orchestrator/workflow/ts-engine.ts:13` | `class implements PipelineEngine` | `name='ts'`; wraps `runTsPipeline`. Assert via `instanceof TsPipelineEngine`. |
| `WorkflowEngine` | `src/orchestrator/workflow/workflow-engine.ts:32` | `class implements PipelineEngine` | `name='workflow'`; injectable `tsEngineFactory`. Assert via `instanceof WorkflowEngine`. |
| `logger` | `src/utils/logger.ts` | `{ info, warn, error, debug, success }` | Logging. Tests `vi.mock("../../utils/logger.js", ...)`. Downgrade log goes through `logger.info`. |
| `createDefaultConfig` | `src/config/schema.ts` (imported in tests) | `(name, mode): BoberConfig` | Builds a default config for tests. Used by registry.test.ts:17 and workflow-engine.test.ts:44. |
| `runTsPipeline` | `src/orchestrator/pipeline.ts:573` | `(userPrompt, projectRoot, config, opts?)` | The real TS pipeline body (makes LLM calls). DO NOT call directly in tests. |

**Types to import (do not redefine):**
- `Team` — `src/teams/types.ts:21` (has `pipelineShape: PipelineEngineName`, `id`, `memoryNamespace`, `providers`, `roles`, `guardrails`).
- `PipelineEngine`, `PipelineEngineName` — `src/orchestrator/workflow/engine.ts:7,10`.
- `BoberConfig` — `src/config/schema.ts:404`.
- `PipelineResult` — `src/orchestrator/pipeline.ts:65`.

---

## 4. Prior Sprint Output

### Sprint 1 (commit 274338b): src/teams/ — Team + loadTeam
**Created:** `src/teams/types.ts` (exports `Team`, `Role`), `src/teams/registry.ts` (exports `loadTeam`).
**Key fact (registry.ts:68):** the programming team sets `pipelineShape: resolveEngineName(config)`:
```ts
function buildProgrammingTeam(config: BoberConfig): Team {
  return {
    id: "programming",
    ...
    pipelineShape: resolveEngineName(config),  // <-- registry.ts:68
    ...
  };
}
```
**Key fact (registry.ts:54):** a declared team uses `entry.pipelineShape ?? resolveEngineName(config)`.
**Connection:** Because the programming team's `pipelineShape === resolveEngineName(config)` BY CONSTRUCTION, `selectPipelineEngineForTeam(loadTeam(config), config)` is identical to `selectPipelineEngine(config)` today. This is exactly why sc-3-4 must be asserted by a test.

### Sprint 2 (commit 2d89d8c): per-team memory namespacing
**Caller pattern reference (memory.ts:48):** `loadTeam(config, undefined).memoryNamespace` — shows the `loadTeam(config, teamId?)` usage idiom. Not directly relevant to shape selection, but confirms `loadTeam` is the canonical team resolver to use in callers.

### Config schema (already present)
- `teams: z.record(z.string(), TeamConfigSchema).optional()` — schema.ts:401
- `defaultTeam: z.string().optional()` — schema.ts:402
- `TeamConfigSchema.pipelineShape: z.enum(["ts","skill","workflow"]).optional()` — schema.ts:366
These exist; you read `config.defaultTeam` and let `loadTeam` resolve. No schema change needed.

---

## 5. Relevant Documentation

### Project Principles (.bober/principles.md — hard rules for this sprint)
- **ESM `.js` extensions** on ALL imports (principles.md:27). New import: `from "../../teams/types.js"` (in selector.ts), `from "../teams/registry.js"` (in pipeline.ts).
- **`import type` for types** — `consistent-type-imports` enforced (principles.md:35). Import `Team`, `PipelineEngine`, etc. with `import type`.
- **Section comments** `// ── Name ──` (principles.md:32).
- **Vitest, collocated `*.test.ts`** (principles.md:20).
- **Strict TS, zero type errors / lint errors are hard gates** (principles.md:18-19). `noFallthroughCasesInSwitch` + `noImplicitReturns` are on — the existing switch returns in every case (no `default`), exhaustive over the union; keep that shape so the compiler verifies exhaustiveness.
- **Prefix unused params with `_`** (principles.md:36) — e.g. `isWorkflowEligible(_config)`.
- **No `any`** without justification (principles.md:40).
- **Tests must NOT make real LLM calls** (contract Tech Stack + principles.md:20) — use stubbed/injected engine factory or `vi.mock`.

### Architecture Decisions
- ADR-6 ("belt-and-suspenders") referenced in selector.ts:44 and workflow-engine.ts — the WorkflowEngine has a second runtime guard. You do not need to touch it; just preserve the selector behavior.
- No other ADR directly governs this sprint. `.bober/architecture/` exists (untracked) but is not required here.

### Other Docs
- The `runPipeline` JSDoc (pipeline.ts:967-970) says "Signature is frozen — callers must not be updated when the engine changes." Respect this: only ADD an optional `teamId` to the existing optional `opts` object.

---

## 6. Testing Patterns

### Unit Test Pattern — selector.test.ts (extend this file)
**Source:** `src/orchestrator/workflow/selector.test.ts`, lines 1-79
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../utils/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

import { logger } from "../../utils/logger.js";
import { resolveEngineName } from "./selector.js";
import type { BoberConfig } from "../../config/schema.js";

function makeConfig(pipeline: Partial<BoberConfig["pipeline"]>): BoberConfig {
  return { pipeline: { /* ...full defaults... */ engine: "ts", ...pipeline } } as BoberConfig;
}

describe("resolveEngineName", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it("returns 'ts' (downgrade) when engine='workflow' and mode='careful'", () => {
    const config = makeConfig({ engine: "workflow", mode: "careful" });
    expect(resolveEngineName(config)).toBe("ts");
    expect(logger.info).toHaveBeenCalledTimes(1);
  });
});
```
**Runner:** vitest. **Assertion style:** `expect(...).toBe(...)`, `expect(logger.info).toHaveBeenCalledTimes(1)`. **Mock approach:** `vi.mock("../../utils/logger.js", ...)` at top of file; `vi.clearAllMocks()` in `beforeEach`. **File naming:** collocated `selector.test.ts`. **Location:** co-located next to source.

> NOTE: selector.test.ts does NOT currently mock eligibility (it tests resolveEngineName where the ineligible branch comes from the real `isWorkflowEligible` returning `false`). To test the team-aware WORKFLOW-selected (eligible) case, you must force eligibility TRUE. Use the workflow-engine.test.ts pattern: `vi.mock("./eligibility.js", () => ({ isWorkflowEligible: vi.fn(() => true) }))` and `vi.mocked(isWorkflowEligible).mockReturnValue(true/false)` per test (see below).

### Engine-instance assertion + eligibility mock — workflow-engine.test.ts
**Source:** `src/orchestrator/workflow/workflow-engine.test.ts`, lines 24-26, 109, 219-239
```ts
// Force eligibility for the eligible-path tests
vi.mock("./eligibility.js", () => ({ isWorkflowEligible: vi.fn(() => true) }));
import { isWorkflowEligible } from "./eligibility.js";
import { TsPipelineEngine } from "./ts-engine.js";
// ...
beforeEach(() => { vi.mocked(isWorkflowEligible).mockReturnValue(true); });

it("engine='ts' resolves to TsPipelineEngine", () => {
  const config = makeConfig({ engine: "ts" });
  const engine = selectPipelineEngine(config);
  expect(engine.name).toBe("ts");
  expect(engine).toBeInstanceOf(TsPipelineEngine);
});
```
**This is the EXACT assertion style for sc-3-4 / sc-3-5:** `expect(engine).toBeInstanceOf(TsPipelineEngine)` / `toBeInstanceOf(WorkflowEngine)` and `expect(engine.name).toBe("workflow")`.

### Building a Team for tests
Use `loadTeam`:
```ts
import { loadTeam } from "../../teams/registry.js";
import { createDefaultConfig } from "../../config/schema.js";

// programming team (sc-3-4):
const config = createDefaultConfig("test", "greenfield");
const team = loadTeam(config);  // pipelineShape === resolveEngineName(config)
expect(selectPipelineEngineForTeam(team, config)).toBeInstanceOf(TsPipelineEngine);

// declared 'workflow' team (sc-3-5):
const wfConfig = { ...config, teams: { medical: { pipelineShape: "workflow" } } } as BoberConfig;
const wfTeam = loadTeam(wfConfig, "medical");
// with eligibility mocked true: WorkflowEngine; mode 'careful' OR ineligible: TsPipelineEngine
```
**Reference for declared-team config construction:** `src/teams/registry.test.ts:61-64, 117-129` builds `teams: { docs: { pipelineShape: "ts", ... } }` and calls `loadTeam(config, "docs")`.

### runPipeline-level test without real LLM (sc-3-6)
The cleanest no-LLM seam: `vi.mock("./workflow/selector.js")` (or the team selector) so `selectPipelineEngineForTeam` returns a fake `PipelineEngine` whose `.run` returns a sentinel `PipelineResult`, then assert `runPipeline` called it with the team-driven engine. OR assert at the pure `selectPipelineEngineForTeam` level (preferred — no I/O) plus one thin runPipeline test verifying `loadTeam(config, opts?.teamId ?? config.defaultTeam)` is consulted and the no-team path resolves to programming. Sentinel result shape (workflow-engine.test.ts:91-99): `{ success: true, spec, completedSprints: [], failedSprints: [], duration: 0 }`.

### E2E Test Pattern
Not applicable — this is a Node CLI/library; no Playwright. (Verified: no `playwright.config.ts` relevant to this module.)

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/teams/registry.ts:11,54,68` | `resolveEngineName` | high | If you change `resolveEngineName`'s signature, keep `resolveEngineName(config)` (one-arg) working. Use a DEFAULT param if adding an override arg. registry calls it with one arg in two places. |
| `src/orchestrator/pipeline.ts:965,977` | `selectPipelineEngine` | medium | Keep `selectPipelineEngine(config)` exported and working; you're changing the runPipeline body to use the team variant, but the symbol must remain for other callers/tests. |
| `src/orchestrator/workflow/workflow-engine.test.ts:31,221-239` | `selectPipelineEngine` | medium | These tests assert `selectPipelineEngine` returns the right instance. They must stay green — do not change `selectPipelineEngine` semantics. |
| `src/orchestrator/workflow/selector.test.ts:8` | `resolveEngineName` | medium | Existing branch tests (lines 43-78) call `resolveEngineName(config)` one-arg and assert log counts. Must stay green. |
| Callers of `runPipeline` (grep `runPipeline(` in src/, e.g. cli command(s)) | `runPipeline` | medium | The positional signature `(userPrompt, projectRoot, config, opts?)` must stay; adding optional `opts.teamId` is non-breaking. Grep before commit. |

### Existing Tests That Must Still Pass
- `src/orchestrator/workflow/selector.test.ts` — tests `resolveEngineName` downgrade/log-count branches. Affected because you're touching selector.ts; if you add an override param, ensure the default keeps one-arg behavior identical (same single log line).
- `src/orchestrator/workflow/workflow-engine.test.ts` — tests `selectPipelineEngine` instance selection + WorkflowEngine re-dispatch and log lines. Affected because both live in selector/engine area; downgrade log string and instance mapping must be unchanged.
- `src/orchestrator/workflow/eligibility` is consumed; do NOT modify `isWorkflowEligible` (eligibility.ts:10 returns false).
- `src/teams/registry.test.ts` — asserts `team.pipelineShape === resolveEngineName(config)` (lines 21,31). Must stay green; do not change how the programming team's shape is derived.

### Features That Could Be Affected
- **Memory namespacing (Sprint 2)** — shares `loadTeam`; you only READ `team.pipelineShape`, you do not touch `memoryNamespace`. Verify `bober memory` path resolution (memory.ts:48) still works (it calls `loadTeam(config, undefined)`).
- **Workflow engine dormancy (existing)** — the `workflow` shape only reaches `WorkflowEngine` when eligible+not-careful; in production `isWorkflowEligible` returns false so it downgrades to TS. Preserve this so no real workflow invoke is attempted.

### Recommended Regression Checks
1. `npm run build` — zero TS errors (sc-3-1).
2. `npm run typecheck` — zero strict-mode errors (sc-3-2).
3. `npm run test` — all pass, including selector.test.ts, workflow-engine.test.ts, eligibility, registry.test.ts (sc-3-3).
4. Targeted: `npx vitest run src/orchestrator/workflow/selector.test.ts src/orchestrator/workflow/workflow-engine.test.ts src/teams/registry.test.ts` — must be green.
5. `grep -rn "runPipeline(" src/ | grep -v "\.test\."` — confirm no caller breaks from the additive `opts.teamId`.

---

## 8. Implementation Sequence

1. **src/orchestrator/workflow/selector.ts** — Add team-aware selection. Two viable approaches (pick the DRYer one):
   - (a) Add `resolveEngineNameForTeam(team, config)` + `selectPipelineEngineForTeam(team, config)` reusing the SAME downgrade block and switch; OR
   - (b) Extend `resolveEngineName(config, requested?: PipelineEngineName)` with a default `requested = config.pipeline?.engine ?? "ts"`, then `resolveEngineNameForTeam = (team, config) => resolveEngineName(config, team.pipelineShape)` and `selectPipelineEngineForTeam` runs the switch. Keep `selectPipelineEngine(config)` exported (delegates to programming team or no-override path).
   - Add `import type { Team } from "../../teams/types.js";`.
   - Add section comment `// ── Team-aware selection ──`.
   - **Verify:** `npm run typecheck` clean; the downgrade `logger.info(...)` string is byte-identical to selector.ts:29-31.

2. **src/orchestrator/pipeline.ts** — Wire `runPipeline` (lines 971-978):
   - Add `import { loadTeam } from "../teams/registry.js";` and `selectPipelineEngineForTeam` (extend the line 965 import).
   - Extend `opts` to `opts?: { runId?: string; teamId?: string }`.
   - Body: `const teamId = opts?.teamId ?? config.defaultTeam; const team = loadTeam(config, teamId); return selectPipelineEngineForTeam(team, config).run(userPrompt, projectRoot, config, opts);` (pass `opts` through; the engines' `run` only reads `opts.runId`).
   - **Verify:** `npm run build`; no-team path → `loadTeam(config, undefined)` → programming team → identical to today.

3. **src/orchestrator/workflow/selector.test.ts** — Extend with team-aware tests:
   - sc-3-4: `loadTeam(config)` programming team with engine 'ts' → `selectPipelineEngineForTeam` returns `instanceof TsPipelineEngine`, and equals `selectPipelineEngine(config)`'s instance type. Assert equivalence explicitly.
   - sc-3-5: declared team `pipelineShape: 'workflow'` + eligibility mocked TRUE → `instanceof WorkflowEngine`; same team + ineligible (default) OR `mode: 'careful'` → `instanceof TsPipelineEngine`, `logger.info` called once.
   - Use `vi.mock("./eligibility.js", () => ({ isWorkflowEligible: vi.fn(() => true) }))` + `vi.mocked(...).mockReturnValue(...)` per test (workflow-engine.test.ts:24-26,109 pattern). Keep `vi.mock("../../utils/logger.js")` for log assertions.
   - **Verify:** `npx vitest run src/orchestrator/workflow/selector.test.ts`.

4. **runPipeline-level test (sc-3-6)** — Add a test (in selector.test.ts or a new collocated `pipeline-team.test.ts`) that stubs the selector so `selectPipelineEngineForTeam` returns a fake engine returning a sentinel `PipelineResult`; assert the active team's shape drives selection and the no-team call resolves to programming. NO real LLM — sentinel only.
   - **Verify:** test passes with no network/LLM.

5. **Run full verification** — `npm run build`, `npm run typecheck`, `npm run test`.

---

## 9. Pitfalls & Warnings

- **DO NOT change the downgrade log string.** selector.test.ts:58,65,71 and workflow-engine.test.ts assert `logger.info` is called exactly once on downgrade. If you duplicate the block, copy the string `Workflow engine requested but ${...}; downgrading to 'ts'.` exactly (selector.ts:29-31). Best to share a single source.
- **DO NOT change `resolveEngineName`'s one-arg call contract.** registry.ts:54,68 and selector.test.ts call `resolveEngineName(config)`. If you add a parameter, make it optional with a default so existing calls compile and behave identically.
- **DO NOT modify `isWorkflowEligible`** (eligibility.ts:10). It is a non-goal; the team's shape only chooses the REQUESTED name — eligibility/careful still gate it (contract assumptions).
- **The `switch` has no `default` and is exhaustive over `PipelineEngineName`** (selector.ts:52-62). `noFallthroughCasesInSwitch` + `noImplicitReturns` are on. Keep every case returning; mirror this exact structure in the team variant or the build fails.
- **`runPipeline`'s signature is "frozen"** (pipeline.ts:967-970). Only ADD an optional `teamId` inside the existing optional `opts` object — do not add positional params and do not break existing callers (`grep "runPipeline("`).
- **No real LLM in tests** (contract + principles.md:20). Do NOT call `runTsPipeline` (pipeline.ts:573) or a real `TsPipelineEngine.run` in tests — use sentinel/fake factory (workflow-engine.test.ts:122-123) or assert at the pure `selectPipelineEngineForTeam` level (`instanceof` checks do not invoke `.run`).
- **`'skill'` falls through to TS** (selector.ts:55-57) — preserve this; do not add a skill engine (non-goal).
- **`config.defaultTeam` may be undefined** — `loadTeam(config, undefined)` returns the programming team (registry.ts:36). That is the intended no-team default ('programming'). Do not special-case it.
- **Import paths:** from `selector.ts`, the Team type is `../../teams/types.js`; from `pipeline.ts`, registry is `../teams/registry.js`. Use `.js` extensions and `import type` for types (principles.md:27,35).
- **Use `loadTeam`, not hand-rolled team resolution** — it already encodes the programming-team default and the declared-team `pipelineShape ?? resolveEngineName` fallback (registry.ts:54,68).
