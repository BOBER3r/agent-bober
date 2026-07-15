# Sprint Briefing: Engine-selection seam, pipeline.engine config, and eligibility probe

**Contract:** sprint-spec-20260604-workflow-engine-1
**Generated:** 2026-06-04T00:00:00Z

---

## 0. Sprint Goal (one paragraph)

Add `pipeline.engine` to the Zod config (`z.enum(['ts','skill','workflow']).default('ts')`), mirror it in `createDefaultConfig`, and introduce a thin engine-selection seam at the frozen `runPipeline` boundary. Extract the current `runPipeline` body into a `TsPipelineEngine.run` (logic UNCHANGED) behind a new `PipelineEngine` interface. The exported `runPipeline` keeps its exact signature and now delegates to `selector.select(config).run(...)`. A default-ineligible `isWorkflowEligible` probe plus a pure `resolveEngineName` resolver downgrades `workflow → ts` (one log line) when ineligible or `mode === 'careful'`. No behavior change on the default `ts` path.

---

## 1. Target Files

### `src/config/schema.ts` (modify)

**`PipelineSectionSchema` — add the `engine` field (lines 147-188):**
```ts
export const PipelineSectionSchema = z.object({
  maxIterations: z.number().int().min(1).default(20),
  // ... existing fields ...
  mode: z.enum(["autopilot", "careful"]).default("autopilot"),   // line 156
  // ... existing fields ...
  cleanupWorktreeOnSuccess: z.boolean().default(true),           // line 186
  // ADD HERE (before closing }):
  // engine: z.enum(["ts", "skill", "workflow"]).default("ts"),
});
export type PipelineSection = z.infer<typeof PipelineSectionSchema>; // line 188
```
**Rule:** Add `engine: z.enum(["ts", "skill", "workflow"]).default("ts")` inside the `PipelineSectionSchema` object (after `cleanupWorktreeOnSuccess`, line 186). Follow the exact `.default(...)` + JSDoc-comment style used by `mode` (line 155-156) and `CheckpointMechanismSchema` (line 144-145).

**Precedent for an enum + inferred type (lines 144-145):**
```ts
export const CheckpointMechanismSchema = z.enum(["noop", "cli", "disk", "pr"]);
export type CheckpointMechanismName = z.infer<typeof CheckpointMechanismSchema>;
```
The generatorNotes say the canonical `PipelineEngineName` union lives in `workflow/engine.ts` as `'ts'|'skill'|'workflow'`. Keep the schema enum literal-identical to that union. Do NOT add a circular import from schema.ts into the workflow module — just repeat the three string literals in the `z.enum`.

**`BoberConfigSchema` + `PartialBoberConfigSchema` (lines 307-340):** No change required. `pipeline: PipelineSectionSchema` (line 314) inherits the new default. NOTE: `PartialBoberConfigSchema` (line 331) uses `.deepPartial()`, so a config file that omits `pipeline` entirely will NOT get `engine: 'ts'` injected through the *partial* schema — but the loader merges over `createDefaultConfig` output, so the default is supplied there (see defaults edit below). The evaluatorNotes require: `PipelineSectionSchema.parse({})` → `engine === 'ts'`; `PipelineSectionSchema.parse({ engine: 'bogus' })` → throws.

**Imports this file uses:** `import { z } from "zod";` (line 1) — that is the ONLY import.

**Imported by:** `src/orchestrator/pipeline.ts` (`import type { BoberConfig }`), plus virtually every module. `BoberConfig`/`PipelineSection` are the load-bearing exports — keep them stable.

**Test file:** `src/config/schema.test.ts` — **does NOT exist yet** (this sprint creates it; see §6).

---

### `src/config/schema.ts` → `createDefaultConfig` (modify, lines 348-402)

**Relevant section — the `pipeline:` block of the returned `base` config (lines 385-400):**
```ts
    pipeline: {
      maxIterations: 20,
      maxCheckpointIterations: 3,
      requireApproval: false,
      contextReset: "always",
      researchPhase: true,
      architectPhase: false,
      mode: "autopilot",
      checkpointOverrides: {},
      approvalTimeoutMs: 86_400_000,
      prPollMs: 30_000,
      allowAutopilotRiskyActions: false,
      eventQueueBound: 1000,
      worktreeRoot: ".bober/worktrees",
      cleanupWorktreeOnSuccess: true,
      // ADD: engine: "ts",
    },
```
**Rule:** Add `engine: "ts",` to this literal `pipeline` block. The `base` is typed `const base: BoberConfig` (line 354), so once `PipelineSection` requires `engine`, this literal MUST include it or typecheck fails (C5).

> NOTE: `src/config/defaults.ts` is listed in `estimatedFiles` but `createDefaultConfig` actually lives in `schema.ts` (verified — `grep` found it at `schema.ts:348`). Inspect `src/config/defaults.ts` before editing; if it has no `pipeline` literal needing the field, leave it untouched (the contract stopConditions allow `defaults.ts` "if present").

---

### `src/orchestrator/pipeline.ts` (modify) — the FROZEN seam

**`PipelineResult` interface (lines 62-76) — import this TYPE into the engine module, do NOT redefine it:**
```ts
export interface PipelineResult {
  success: boolean;
  spec: PlanSpec;
  completedSprints: SprintContract[];
  failedSprints: SprintContract[];
  totalCost?: number;
  duration: number;
  needsClarification?: boolean;
}
```

**Exported `runPipeline` signature (lines 516-520) — MUST stay byte-identical:**
```ts
export async function runPipeline(
  userPrompt: string,
  projectRoot: string,
  config: BoberConfig,
): Promise<PipelineResult> {
```
The function body runs from line 521 to the closing brace at **line 843** (the whole file tail). The body ends with a `try { ... } finally { cleanup(); }` and returns the PipelineResult at lines 833-839.

**Refactor plan (per generatorNotes):**
1. Rename the existing `export async function runPipeline(...)` body to a private `async function runTsPipeline(userPrompt, projectRoot, config): Promise<PipelineResult>` (same params, same body — UNCHANGED). Drop the `export` keyword on this inner function.
2. Define a new exported thin seam:
```ts
export async function runPipeline(
  userPrompt: string,
  projectRoot: string,
  config: BoberConfig,
): Promise<PipelineResult> {
  return selectPipelineEngine().select(config).run(userPrompt, projectRoot, config);
}
```
   (Exact selector call shape depends on your selector API in §1 below — keep the signature line identical.)
3. `TsPipelineEngine` lives where the cycle is cleanest. Options that avoid an import cycle:
   - Define `TsPipelineEngine` IN `pipeline.ts` (it needs `runTsPipeline` + `PipelineResult`, both local) implementing the `PipelineEngine` interface imported via `import type` from `workflow/engine.ts`; the selector imports `TsPipelineEngine` from `pipeline.ts`. Watch for cycle: `selector.ts` → `pipeline.ts` (for TsPipelineEngine) and `pipeline.ts` → `selector.ts` (for selectPipelineEngine). To break it, either (a) have `runPipeline` lazily import the selector, or (b) put `TsPipelineEngine` in its own file `workflow/ts-engine.ts` that imports `runTsPipeline` — which means `runTsPipeline` must be EXPORTED from pipeline.ts. Prefer (b): export `runTsPipeline` from pipeline.ts, put `TsPipelineEngine` in `workflow/ts-engine.ts`, keep `pipeline.ts → selector` the only edge back.
**Rule:** The exported `runPipeline` name, params, and `Promise<PipelineResult>` return type are FROZEN (C4). Only its body changes to a one-line delegation. Do not alter any logic inside the former body (non-goal: "Do not change the runPipeline algorithm, phase order, or any .bober/ write behavior").

**Imports `pipeline.ts` already has (relevant):**
- `import type { BoberConfig } from "../config/schema.js";` (line 13)
- `import { logger } from "../utils/logger.js";` (line 58)
All workflow-module imports you add must use the `.js` specifier and `import type` for type-only (`PipelineEngine`).

**Imported by (CRITICAL — signature must not break these):**
- `src/index.ts:94` — re-exports `runPipeline` in the public API.
- `src/mcp/run-manager.ts:14,169` — types a field as `(...) => Promise<PipelineResult> = runPipeline`.
- `src/cli/commands/run.ts:7,146` — `await runPipeline(task, projectRoot, config)`.
- `src/orchestrator/worktree.ts:15,44,143` — `pipelineFn = opts.pipelineFn ?? runPipeline`.
All four call it as `(userPrompt|task, projectRoot, config) => Promise<PipelineResult>`. Keep that contract.

**Test file:** No `pipeline.test.ts` collocated. Worktree/run-manager tests exercise it indirectly (see §7).

---

### `src/orchestrator/workflow/engine.ts` (create)

**Directory pattern:** `src/orchestrator/workflow/` does not exist yet — create it. Sibling pattern is `src/orchestrator/checkpoints/` (kebab-case files, `types.ts` for interfaces, `registry.ts` for the resolver). Files are kebab-case `.ts`; type-only modules export an `interface` + a `z.infer`/union type.

**Most similar existing file:** `src/orchestrator/checkpoints/types.ts` (interface module) + `registry.ts` (resolver). Mirror their JSDoc + section-comment style.

**Structure template:**
```ts
import type { BoberConfig } from "../../config/schema.js";
import type { PipelineResult } from "../pipeline.js";

// ── Types ──────────────────────────────────────────────────────────

export type PipelineEngineName = "ts" | "skill" | "workflow";

export interface PipelineEngine {
  readonly name: PipelineEngineName;
  run(
    userPrompt: string,
    projectRoot: string,
    config: BoberConfig,
  ): Promise<PipelineResult>;
}
```
**Rule:** Use `import type` for both `BoberConfig` and `PipelineResult` (they are type-only — `consistent-type-imports` is a hard gate). The `PipelineResult` import from `../pipeline.js` is the type only, so it does not create a runtime cycle.

---

### `src/orchestrator/workflow/eligibility.ts` (create)

**Structure template:**
```ts
import type { BoberConfig } from "../../config/schema.js";

/**
 * Conservative default-ineligible workflow probe.
 * TODO(sprint-6): contact the runtime and return true only when
 * Claude Code >= 2.1.154 with Dynamic Workflows is available.
 */
export function isWorkflowEligible(_config: BoberConfig): boolean {
  return false;
}
```
**Rule:** Prefix the unused param with `_` (`_config`) — the `_` prefix is the project's only escape hatch for unused params (principles.md line 36). Returns `false` this sprint (non-goal: "Do not make the eligibility probe actually contact the runtime").

---

### `src/orchestrator/workflow/selector.ts` (create)

**Most similar existing file:** `src/orchestrator/checkpoints/registry.ts` — mirror its **pure resolver + lookup** split (`resolveCheckpointMechanismName` lines 65-91 is the pure fn; `getCheckpointMechanismFor` lines 105-120 does the lookup).

**Structure template (resolver mirrors registry.ts:65 style):**
```ts
import type { BoberConfig } from "../../config/schema.js";
import { logger } from "../../utils/logger.js";
import type { PipelineEngine, PipelineEngineName } from "./engine.js";
import { isWorkflowEligible } from "./eligibility.js";
import { TsPipelineEngine } from "./ts-engine.js"; // or wherever TsPipelineEngine lives

/**
 * Pure resolver — returns the engine name without instantiating an engine.
 * Branches:
 *   - engine unset → 'ts'
 *   - engine === 'workflow' && (!eligible || mode === 'careful') → 'ts' (downgrade, one log line)
 *   - else → engine verbatim ('ts' | 'skill' | 'workflow')
 */
export function resolveEngineName(config: BoberConfig): PipelineEngineName {
  const requested = config.pipeline?.engine ?? "ts";
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

export function selectPipelineEngine(config: BoberConfig): PipelineEngine {
  const name = resolveEngineName(config);
  // Map name → engine instance. 'skill'/'workflow' are not implemented this
  // sprint (sprint 6) — but resolveEngineName only returns them when eligible,
  // which the default-ineligible probe makes unreachable. Return TsPipelineEngine
  // for 'ts'. For now a switch with a TODO for skill/workflow is acceptable.
  return new TsPipelineEngine();
}
```
**Rule:** Exactly ONE `logger.info` downgrade line on the `workflow → ts` path (C3 asserts "exactly one downgrade log line"). Do NOT log on the plain `ts`/`skill` paths. The resolver is PURE (no side effects except the single log) — mirror the `resolveCheckpointMechanismName` purity contract (registry.ts:53-64). Decide a single public API shape and use it identically in `pipeline.ts` (the §1 pipeline edit assumed `selectPipelineEngine().select(config)`; if you instead export a flat `selectPipelineEngine(config)`, update the pipeline delegation line to match — keep ONE shape).

---

## 2. Patterns to Follow

### Pure resolver + registry-lookup split
**Source:** `src/orchestrator/checkpoints/registry.ts`, lines 53-120
```ts
// Pure name resolution — no lookup, no side effects.
export function resolveCheckpointMechanismName(
  checkpointId: string,
  config: CheckpointOverrideConfig | undefined,
  cliOverride?: string,
  cliOverrideAll?: boolean,
  fallback = "noop",
): string {
  if (cliOverrideAll && cliOverride) return cliOverride;
  const perCheckpoint = config?.pipeline?.checkpointOverrides?.[checkpointId];
  if (perCheckpoint) return perCheckpoint;
  // ... tiered returns ...
  return fallback;
}
// Lookup wrapper calls the pure resolver, then maps name → impl.
export function getCheckpointMechanismFor(...): CheckpointMechanism {
  const name = resolveCheckpointMechanismName(...);
  return getCheckpointMechanism(name);
}
```
**Rule:** Keep `resolveEngineName` pure and unit-testable in isolation; let `selectPipelineEngine` (or `.select`) do the name→engine mapping.

### Zod enum field with default + JSDoc
**Source:** `src/config/schema.ts`, lines 155-156
```ts
  /** Pipeline execution mode. 'autopilot' auto-approves all checkpoints; 'careful' defaults to disk mechanism. Default: 'autopilot'. */
  mode: z.enum(["autopilot", "careful"]).default("autopilot"),
```
**Rule:** Add `engine` with the same `z.enum([...]).default(...)` shape and a one-line JSDoc above it.

### Type-only imports + `.js` specifiers
**Source:** `src/orchestrator/pipeline.ts`, lines 13-16
```ts
import type { BoberConfig } from "../config/schema.js";
import type { PlanSpec } from "../contracts/spec.js";
import { isPipelineReady } from "../contracts/spec.js";
import type { SprintContract } from "../contracts/sprint-contract.js";
```
**Rule:** Every relative import ends in `.js`; type-only imports use `import type` (consistent-type-imports hard gate). New `workflow/` files are two levels deep → `../../config/schema.js`, `../../utils/logger.js`, and one level for siblings → `./engine.js`.

### Singleton logger usage
**Source:** `src/utils/logger.ts`, line 87 + `src/orchestrator/pipeline.ts`, line 58
```ts
export const logger = new Logger();          // logger.ts:87
import { logger } from "../utils/logger.js"; // pipeline.ts:58 (use ../../ from workflow/)
```
`logger.info(message: string, ...args)` (logger.ts:13). Use `logger.info(...)` for the single downgrade line.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `logger` (singleton) | `src/utils/logger.ts:87` | `Logger` instance; `logger.info(msg, ...args): void` (line 13) | Use for the single downgrade log line. Do NOT `console.log`. |
| `resolveCheckpointMechanismName` | `src/orchestrator/checkpoints/registry.ts:65` | `(checkpointId, config, cliOverride?, cliOverrideAll?, fallback?) => string` | Reference template for the pure-resolver pattern (mirror, don't import). |
| `getCheckpointMechanism` | `src/orchestrator/checkpoints/registry.ts:24` | `(name: string) => CheckpointMechanism` | Reference template for name→impl registry lookup. |
| `createDefaultConfig` | `src/config/schema.ts:348` | `(projectName, mode, preset?, overrides?) => BoberConfig` | The default-config factory — add `engine: "ts"` to its `pipeline` literal (lines 385-400). |
| `PipelineSectionSchema` | `src/config/schema.ts:147` | `z.object({...})` | Add the `engine` field here. |
| `BoberConfigSchema` / `BoberConfig` | `src/config/schema.ts:307,325` | Zod schema + `z.infer` type | The config type the engine `run(...)` consumes; import as `import type`. |
| `PartialBoberConfigSchema` | `src/config/schema.ts:331` | `BoberConfigSchema.deepPartial().extend(...)` | Loader's partial parser — note `deepPartial` does NOT apply defaults; verify behavior in evaluator note. |

> Utilities reviewed: `src/utils/*` (logger.ts, git.ts, fs.ts), `src/orchestrator/checkpoints/*`. No string-enum resolver or engine-selector helper exists today — this sprint creates the first one. Do NOT recreate `logger` or a config-default factory.

---

## 4. Prior Sprint Output

No prior sprints completed (`dependsOn: []`). This is sprint 1 of the plan. It builds only on the existing frozen codebase: `runPipeline` (pipeline.ts:516), `PipelineResult` (pipeline.ts:62), `PipelineSectionSchema`/`createDefaultConfig` (schema.ts:147,348), and the `registry.ts` resolver pattern.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
Hard gates that MUST hold (C5):
- **TS strict mode**, zero type errors (line 18). `noUnusedLocals`/`noUnusedParameters` are on → prefix unused params with `_` (line 36).
- **ESLint flat config, `consistent-type-imports` enforced** (line 19, 35) → use `import type` for `BoberConfig`, `PipelineResult`, `PipelineEngine`, `PipelineEngineName`.
- **ESM everywhere, `.js` import specifiers** (line 27).
- **Zod for all config validation** (line 29) — the `engine` field goes in the Zod schema, not hand-rolled.
- **Vitest, tests collocated** (`*.test.ts` next to `*.ts`) (line 20).
- **Section comments** with box-drawing headers `// ── Name ──────` (line 32) — used in pipeline.ts (line 60), logger.ts (line 3), schema.ts (line 3).
- **Conventional commit:** `bober(sprint-1): add engine-selection seam + pipeline.engine config` (generatorNotes; principles line 34).

### Architecture Decisions
`.bober/architecture/arch-20260603-adopt-claude-code-dynamic-workflows-architecture.md` — Sprint 1 implements the "PipelineEngine" seam + `pipeline.engine` config. The selector mirrors `registry.ts` (`resolveCheckpointMechanismName` line 65 — pure resolver + lookup). The seam is the exported `runPipeline` (pipeline.ts:516); `PipelineResult` (pipeline.ts:62). The TS engine path stays byte-for-byte intact as the universal fallback.

### Other Docs
None additionally required for this sprint.

---

## 6. Testing Patterns

### Unit Test Pattern — pure resolver (mirror for `selector.test.ts`)
**Source:** `src/orchestrator/checkpoints/registry.test.ts`, lines 18-57
```ts
import { describe, it, expect } from "vitest";
import { resolveCheckpointMechanismName } from "./registry.js";

describe("resolveCheckpointMechanismName — mode-based default tier (s14-c2)", () => {
  it("mode='careful' + no checkpointMechanism → resolves to 'disk'", () => {
    const config = { pipeline: { mode: "careful" as const } };
    expect(resolveCheckpointMechanismName("post-research", config)).toBe("disk");
  });
});
```
Build inline plain-object configs with `as const` for enum literals. For `selector.test.ts`, construct a minimal `BoberConfig`-shaped object (cast `as BoberConfig` if you only populate `pipeline`) and assert each branch of `resolveEngineName`: unset→`ts`, `workflow`+ineligible→`ts`, `careful`+`workflow`→`ts`, `ts`→`ts`, `skill`→`skill`.

### Asserting the single downgrade log line (mock the logger)
**Source:** `src/config/loader.test.ts`, lines 8-23
```ts
import { describe, it, expect, vi } from "vitest";
vi.mock("../../utils/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));
import { logger } from "../../utils/logger.js";
// ... in a test:
//   resolveEngineName({ pipeline: { engine: "workflow" } } as BoberConfig);
//   expect(logger.info).toHaveBeenCalledTimes(1);
```
**IMPORTANT:** the mock path is relative to the TEST file. `selector.test.ts` is in `src/orchestrator/workflow/`, so the logger path is `"../../utils/logger.js"` (NOT `"../utils/logger.js"` as in loader.test.ts which is one level up). Verify the relative depth before writing the `vi.mock` string — a wrong path makes the mock silently no-op and `toHaveBeenCalledTimes(1)` will fail.

### Schema test (`src/config/schema.test.ts` — NEW file)
**Runner:** vitest. **Assertion:** `expect`. **Location:** collocated. **File naming:** `<name>.test.ts`.
Template (C1):
```ts
import { describe, it, expect } from "vitest";
import { PipelineSectionSchema } from "./schema.js";

describe("PipelineSectionSchema.engine", () => {
  it("defaults engine to 'ts' when omitted", () => {
    expect(PipelineSectionSchema.parse({}).engine).toBe("ts");
  });
  it("rejects an unknown engine string", () => {
    expect(() => PipelineSectionSchema.parse({ engine: "bogus" })).toThrow();
  });
  it("accepts 'workflow'", () => {
    expect(PipelineSectionSchema.parse({ engine: "workflow" }).engine).toBe("workflow");
  });
});
```
**Mock approach:** none needed for the schema test (pure Zod parse). **No fs, no temp dirs.**

### E2E Test Pattern
Not applicable — this is a CLI/library project with no Playwright config. Verification is `npm run typecheck`, `npm run build`, and Vitest unit suites.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/index.ts:94` | `runPipeline` (public re-export) | low | Public API export name unchanged → import still resolves. |
| `src/mcp/run-manager.ts:14,169` | `runPipeline` typed as `(...) => Promise<PipelineResult>` | medium | The default-assigned function type must still match `runPipeline`'s signature exactly. |
| `src/cli/commands/run.ts:7,146` | `await runPipeline(task, projectRoot, config)` | medium | 3-arg call shape and `Promise<PipelineResult>` return preserved. |
| `src/orchestrator/worktree.ts:15,44,143` | `pipelineFn ?? runPipeline`; imports `PipelineResult` | medium | `runPipeline` assignable to `pipelineFn` field; `PipelineResult` still exported from pipeline.ts. |
| every config consumer | `BoberConfig`, `PipelineSection` (schema.ts) | medium | Adding a `.default()` field is backward-compatible (no required field added to callers); literal `pipeline` blocks typed `BoberConfig` (e.g. createDefaultConfig:354) MUST add `engine`. |

### Existing Tests That Must Still Pass
- `src/config/loader.test.ts` — parses configs through the loader; verify a config without `engine` still loads (default applies via createDefaultConfig merge).
- `src/config/role-providers.test.ts` — builds configs; ensure adding a defaulted field doesn't break parse.
- `src/orchestrator/checkpoints/registry.test.ts` and the rest of `checkpoints/*.test.ts` — unaffected (pattern source only); must stay green.
- `src/orchestrator/worktree*` tests (if any) and `src/mcp/run-manager` tests — they assert `runPipeline`'s signature/usage indirectly; the frozen signature must not change.

### Features That Could Be Affected
- **Pipeline run (CLI `bober run`)** — shares `runPipeline`. Verify the default `ts` path produces identical behavior (same .bober/ writes, same phase order). The contract's C5 references "the documented flaky tool-count baseline" — tolerate ONLY that, no new failures.
- **MCP server run-manager** — shares `runPipeline` as an injectable fn. Verify type-assignability.

### Recommended Regression Checks (run after implementation)
1. `npm run typecheck` → exit 0 (C5).
2. `npm run build` → exit 0 (C5).
3. `npx vitest run src/config/schema.test.ts src/orchestrator/workflow/selector.test.ts` → new tests green (C1, C3).
4. `npx vitest run src/config/ src/orchestrator/` → existing suites green (no new failures beyond the documented flaky tool-count baseline).
5. `git diff --name-only` → changes confined to `src/config/schema.ts`, `src/config/defaults.ts` (only if it had a pipeline literal), `src/orchestrator/pipeline.ts`, and new `src/orchestrator/workflow/*` files. NO `agents/*.md`, `contracts/`, or `providers/types.ts` changes (non-goal).
6. `grep -n "export async function runPipeline" src/orchestrator/pipeline.ts` → signature line still `(userPrompt: string, projectRoot: string, config: BoberConfig,): Promise<PipelineResult>`.

---

## 8. Implementation Sequence

1. **`src/config/schema.ts`** — Add `engine: z.enum(["ts","skill","workflow"]).default("ts")` to `PipelineSectionSchema` (after line 186); add `engine: "ts"` to the `pipeline` literal in `createDefaultConfig` (lines 385-400).
   - Verify: `npx vitest run` of a quick `PipelineSectionSchema.parse({})` → `engine === "ts"`; typecheck of createDefaultConfig literal passes.
2. **`src/config/defaults.ts`** — Inspect; add `engine: "ts"` only if it holds a `pipeline` literal that now fails typecheck. Otherwise leave untouched.
   - Verify: typecheck clean.
3. **`src/orchestrator/workflow/engine.ts`** (create) — `PipelineEngineName` union + `PipelineEngine` interface; `import type` `BoberConfig` (`../../config/schema.js`) and `PipelineResult` (`../pipeline.js`).
   - Verify: typecheck resolves the `PipelineResult` import with no cycle error.
4. **`src/orchestrator/workflow/eligibility.ts`** (create) — `isWorkflowEligible(_config): boolean` → `false` with sprint-6 TODO.
   - Verify: lint clean (`_config` prefix), typecheck clean.
5. **`src/orchestrator/pipeline.ts`** — Rename body to `export async function runTsPipeline(...)` (UNCHANGED logic); add `TsPipelineEngine` (in `workflow/ts-engine.ts` importing `runTsPipeline`, to avoid the selector↔pipeline cycle); redefine exported `runPipeline` as the thin delegation. Keep the signature byte-identical.
   - Verify: `grep` the export signature matches §7 check 6; typecheck clean.
6. **`src/orchestrator/workflow/selector.ts`** (create) — pure `resolveEngineName(config)` (one `logger.info` on downgrade) + `selectPipelineEngine`/`.select` returning a `PipelineEngine`. Wire `pipeline.ts`'s `runPipeline` to call it (settle on ONE API shape).
   - Verify: resolver branches return expected names; no cycle.
7. **`src/config/schema.test.ts`** (create) — default + reject-unknown + accept-workflow (C1).
   - Verify: `npx vitest run src/config/schema.test.ts` green.
8. **`src/orchestrator/workflow/selector.test.ts`** (create) — branch coverage + `logger.info` called exactly once on `workflow→ts` (mock logger at `../../utils/logger.js`) (C3).
   - Verify: `npx vitest run src/orchestrator/workflow/selector.test.ts` green.
9. **Run full verification** — `npm run typecheck`, `npm run build`, `npx vitest run src/config/ src/orchestrator/`.

---

## 9. Pitfalls & Warnings

- **`createDefaultConfig` lives in `schema.ts:348`, NOT `defaults.ts`.** The contract's `estimatedFiles` lists `defaults.ts`, but the default-config factory is in schema.ts. Edit the schema.ts `pipeline` literal (lines 385-400). Touch `defaults.ts` only if its own literal fails typecheck.
- **Import-cycle trap.** `selector.ts` needs `TsPipelineEngine`, and `pipeline.ts` needs the selector. If `TsPipelineEngine` lives in `pipeline.ts`, you get `pipeline ⇄ selector`. Break it by putting `TsPipelineEngine` in `workflow/ts-engine.ts` and EXPORTING `runTsPipeline` from `pipeline.ts`; then the only edge back into pipeline.ts from the workflow module is the `import type { PipelineResult }` (type-only, erased at runtime) plus `import { runTsPipeline }` into ts-engine.ts. Keep `pipeline.ts → selector` as the single runtime cycle edge, and make `runPipeline` import the selector at the top (no lazy import needed if ts-engine.ts is the only thing importing runTsPipeline).
- **`import type` is a hard gate.** `BoberConfig`, `PipelineResult`, `PipelineEngine`, `PipelineEngineName` are all type-only → `import type`. A plain `import` of these will fail `consistent-type-imports` lint (C5).
- **Exactly ONE downgrade log line.** C3 asserts `logger.info` is called once on `workflow→ts`. Do not log on the `ts`/`skill` paths and do not double-log (e.g. once in `resolveEngineName` and again in `select`). Log only inside the resolver's downgrade branch.
- **The vi.mock logger path differs by file depth.** `loader.test.ts` (in `src/config/`) mocks `"../utils/logger.js"`. `selector.test.ts` (in `src/orchestrator/workflow/`) must mock `"../../utils/logger.js"`. A wrong path → mock no-ops → `toHaveBeenCalledTimes(1)` fails.
- **Do NOT change runPipeline's algorithm.** Moving the body into `runTsPipeline` must be a pure cut-and-paste rename. No reordering of phases, no changes to `.bober/` writes, no signature change (non-goals + C4).
- **`PartialBoberConfigSchema` uses `.deepPartial()`** (schema.ts:331) which strips `.default()` from nested fields. The `engine` default is reliably applied through `PipelineSectionSchema.parse` (the C1 test target) and through `createDefaultConfig`. Don't assume the partial loader path injects `engine: 'ts'`; the merge over `createDefaultConfig` supplies it.
- **`skill`/`workflow` engines are out of scope (sprint 6).** `select` returning a `TsPipelineEngine` for everything is acceptable this sprint because the default-ineligible probe makes `resolveEngineName` unreachable for `workflow`. Leave a clear TODO; do NOT implement `WorkflowEngine.run` (non-goal).
- **Keep section-comment headers.** New files should use `// ── Section ──────` headers matching pipeline.ts:60 / logger.ts:3 / schema.ts:3.
