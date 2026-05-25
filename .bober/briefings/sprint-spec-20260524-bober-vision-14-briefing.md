# Sprint Briefing: Careful-flow mode selection + per-checkpoint mechanism overrides (Sprint 14 — TIER 2 CLOSER)

**Contract:** sprint-spec-20260524-bober-vision-14
**Generated:** 2026-05-25T00:00:00Z

> **Read this first.** Three high-risk facts before you touch any code:
> 1. The contract's s14-c1 says `pipeline.approvalTimeoutMs` (Sprint 9) and `pipeline.prPollMs` (Sprint 10) are "already added — verify present." **They are NOT present in the schema.** Audit grep returned 0 hits in `src/config/schema.ts`. You MUST add these fields too, or s14-c1 fails on verification.
> 2. The existing `getCheckpointMechanismFor()` in `src/orchestrator/checkpoints/registry.ts:66-74` ONLY handles `override → global → fallback`. You must EXTEND it to honor a new `mode`-based default (autopilot→noop, careful→disk) when both override and global are unset. The signature change must remain backwards compatible (do not break the existing s10-c5 tests in `src/orchestrator/checkpoints/mechanisms/pr.test.ts:530-593`).
> 3. The pipeline's mechanism-name resolution casts via `as unknown as { pipeline?: { checkpointMechanism?: string } }` at `src/orchestrator/pipeline.ts:148-151` and `pipeline.ts:515-517`. After your schema additions these casts become real types — clean them up OR they'll fail typecheck if you remove the index signature in `CheckpointOverrideConfig`.

---

## 1. Target Files

### `src/config/schema.ts` (modify)

**Current `PipelineSectionSchema` (lines 143-152):**
```typescript
export const PipelineSectionSchema = z.object({
  maxIterations: z.number().int().min(1).default(20),
  /** Maximum times the router re-invokes a responsible agent after rejection. Default 3, min 1, max 10. */
  maxCheckpointIterations: z.number().int().min(1).max(10).default(3),
  requireApproval: z.boolean().default(false),
  contextReset: ContextResetSchema.default("always"),
  researchPhase: z.boolean().default(true),
  architectPhase: z.boolean().default(false),
});
export type PipelineSection = z.infer<typeof PipelineSectionSchema>;
```

**Fields s14-c1 mandates be present** (✓ = already there, ➕ = you add):
| Field | Status | Action |
|-------|--------|--------|
| `maxCheckpointIterations` | ✓ line 146 | leave alone |
| `mode` | ➕ | add enum `'autopilot' \| 'careful'`, default `'autopilot'` |
| `checkpointMechanism` | ➕ | add enum `'noop' \| 'cli' \| 'disk' \| 'pr'`, OPTIONAL (defaults computed at runtime per mode) |
| `checkpointOverrides` | ➕ | add `z.record(z.string(), enum-or-string).default({})` |
| `approvalTimeoutMs` | ➕ MISSING despite s14-c1 wording | add `z.number().int().positive().default(86_400_000)` (24hrs) |
| `prPollMs` | ➕ MISSING despite s14-c1 wording | add `z.number().int().positive().default(30_000)` |

**Imports this file uses:** `import { z } from "zod"` only.
**Test file:** `tests/config/graph-schema.test.ts` (exists — uses `BoberConfigSchema.safeParse`; pattern in Section 6).

**Also update `createDefaultConfig` factory at lines 247-300:** the `pipeline:` block at lines 284-291 needs new fields with their defaults (`mode: "autopilot"`, `checkpointOverrides: {}`, `approvalTimeoutMs: 86_400_000`, `prPollMs: 30_000`). The `checkpointMechanism` field stays OPTIONAL (undefined → resolved by mode).

**Also update `src/config/defaults.ts` (lines 188-227):** both `greenfieldBase.pipeline` and `brownfieldBase.pipeline` blocks need the same new fields added to keep `deepMerge` happy.

---

### `src/orchestrator/checkpoints/registry.ts` (modify)

**Current `getCheckpointMechanismFor` (lines 54-74) — three-tier resolver:**
```typescript
export function getCheckpointMechanismFor(
  checkpointId: string,
  config: CheckpointOverrideConfig | undefined,
  fallback = "noop",
): CheckpointMechanism {
  const override = config?.pipeline?.checkpointOverrides?.[checkpointId];
  const global = config?.pipeline?.checkpointMechanism;
  return getCheckpointMechanism(override ?? global ?? fallback);
}
```

**Current `CheckpointOverrideConfig` interface (lines 43-52):**
```typescript
export interface CheckpointOverrideConfig {
  pipeline?: {
    checkpointMechanism?: string;
    checkpointOverrides?: Record<string, string>;
    [key: string]: unknown; // structural compat with BoberConfig
  };
}
```

**Sprint 14 must extend the resolver to a 4-tier order (NEW: mode-based default between global and fallback):**
1. `cliOverrideAll && cliOverride` → `cliOverride` (force-all)
2. `config.pipeline.checkpointOverrides[checkpointId]` (per-checkpoint config override)
3. `cliOverride` (per-run flag, if no per-checkpoint config override)
4. `config.pipeline.checkpointMechanism` (global config default, if set)
5. Mode default: `config.pipeline.mode === 'careful' ? 'disk' : 'noop'`
6. `fallback` param (back-compat hatch for callers that pass one)

The generatorNotes pseudo-code (in the contract JSON) is the canonical resolution; copy that algorithm.

**Required signature change** — add OPTIONAL cliOverride params (do NOT remove the existing 3-arg form — `pipeline.ts` and 5 tests in `pr.test.ts:541-575` call it with 2-3 args):
```typescript
export function getCheckpointMechanismFor(
  checkpointId: string,
  config: CheckpointOverrideConfig | undefined,
  fallback?: string,
  cliOverride?: string,
  cliOverrideAll?: boolean,
): CheckpointMechanism
```

Or — preferred — extract pure resolution to a sibling function `resolveCheckpointMechanismName(...): string` that returns the name; `getCheckpointMechanismFor` then just looks it up in the registry. This lets the pipeline snapshot the resolved name once per run (evaluatorNotes "snapshot at run start") and pass it to `runWithAudit` for audit logging.

**Imported by (10 sites — all must keep working):**
- `src/orchestrator/pipeline.ts:36` (the orchestrator — 9 call-sites at lines 169, 271, 341, 405, 447, 560, 703, 740, 810)
- `src/orchestrator/checkpoints/mechanisms/pr.test.ts:31` (s10-c5 resolver tests — MUST still pass)
- `src/orchestrator/checkpoints/index.ts:16` (barrel — re-exports `getCheckpointMechanismFor` and `CheckpointOverrideConfig`)

**Test file:** colocated. The s10-c5 tests at `src/orchestrator/checkpoints/mechanisms/pr.test.ts:530-593` are the regression suite. Add NEW tests covering mode-based defaults (autopilot→noop, careful→disk, careful+explicit-pr → pr) either in `pr.test.ts` or a new `registry.test.ts` colocated next to `registry.ts`.

---

### `src/cli/commands/run.ts` + `src/cli/index.ts` (modify)

**Current `RunCommandOptions` (run.ts lines 13-17):**
```typescript
export interface RunCommandOptions {
  verbose?: boolean;
  provider?: string;
}
```

**Current `runRunCommand` config override pattern (run.ts lines 80-89) — this is the exact idiom to mirror:**
```typescript
if (options.provider) {
  config = {
    ...config,
    planner: { ...config.planner, provider: options.provider },
    generator: { ...config.generator, provider: options.provider },
    evaluator: { ...config.evaluator, provider: options.provider },
  };
  logger.info(`Provider override: ${options.provider}`);
}
```

**Sprint 14 additions to `RunCommandOptions`:**
```typescript
mode?: "autopilot" | "careful";       // --mode
checkpoint?: string;                   // --checkpoint=<mechanism>
checkpointAll?: boolean;               // --checkpoint-all
```

**Mirror the provider-override block to apply per-run flags AFTER loadConfig (run.ts:72), BEFORE the pipeline runs:**
```typescript
if (options.mode) {
  config = { ...config, pipeline: { ...config.pipeline, mode: options.mode } };
}
if (options.checkpoint && options.checkpointAll) {
  // --checkpoint-all overrides per-checkpoint overrides → drop overrides + set global
  config = { ...config, pipeline: { ...config.pipeline, checkpointMechanism: options.checkpoint, checkpointOverrides: {} } };
} else if (options.checkpoint) {
  // --checkpoint alone wins over global default, but per-checkpoint overrides still apply.
  config = { ...config, pipeline: { ...config.pipeline, checkpointMechanism: options.checkpoint } };
}
```

This is the SIMPLEST way to satisfy s14-c2/c3/c4 without re-plumbing every getCheckpointMechanismFor call-site. The config snapshot already happens implicitly because `loadConfig(projectRoot)` (line 72) returns a value object, and `runPipeline(task, projectRoot, config)` at line 107 passes that snapshot through — no file re-reads during the run. (Satisfies evaluatorNotes "snapshot at run start".)

**Current run-command registration (index.ts lines 181-197):**
```typescript
program
  .command("run [task]")
  .description("Run the full autonomous pipeline (plan + sprint loop)")
  .option(
    "--provider <name>",
    "Override AI provider for all roles (anthropic, openai, google, openai-compat)",
  )
  .action(async (task?: string, cmdOpts?: { provider?: string }) => {
    const opts = program.opts<{ verbose?: boolean; config?: string }>();

    const projectRoot = await resolveProjectRoot(opts.config);
    await runRunCommand(task, projectRoot, {
      verbose: opts.verbose,
      provider: cmdOpts?.provider,
    });
  });
```

**Add three commander `.option(...)` calls + thread them through:**
```typescript
.option("--mode <mode>", "Pipeline mode: 'autopilot' (default) or 'careful'")
.option("--checkpoint <mechanism>", "Default checkpoint mechanism: noop|cli|disk|pr")
.option("--checkpoint-all", "Apply --checkpoint to ALL checkpoints, overriding config's per-checkpoint overrides")
```
…and pass through to `runRunCommand`:
```typescript
.action(async (task?: string, cmdOpts?: { provider?: string; mode?: "autopilot" | "careful"; checkpoint?: string; checkpointAll?: boolean }) => {
  // …
  await runRunCommand(task, projectRoot, {
    verbose: opts.verbose,
    provider: cmdOpts?.provider,
    mode: cmdOpts?.mode,
    checkpoint: cmdOpts?.checkpoint,
    checkpointAll: cmdOpts?.checkpointAll,
  });
});
```

**Precedence in help output:** evaluatorNotes flags this — make the `--checkpoint-all` description spell out that it overrides per-checkpoint config too. Otherwise users will be confused. The description string above already does this.

**Test file:** no `src/cli/commands/run.test.ts` exists. Add lightweight unit tests for the override merging — pure function shape, no need for child-process spawning. Look at `src/cli/commands/approve.test.ts` for the colocated-test pattern.

---

### `tests/integration/careful-flow.test.ts` (create)

**Directory pattern:** `tests/` is the OUTSIDE-`src` test root. Existing siblings: `tests/orchestrator/`, `tests/config/`, `tests/graph/`, `tests/cli/`. **`tests/integration/` does not yet exist — create it.** Files in `tests/` use `import ... from "../../src/..."` (see `tests/orchestrator/curator-turn-count.test.ts:22-25`).

**Note on `tsconfig.json`:** `rootDir: "src"` and `include: ["src/**/*"]` mean `tests/` is excluded from `tsc --noEmit`. Vitest typechecks via its own transpile — but use ESM `.js` extensions on relative imports and `"node:..."` for builtins (matches every existing test).

**Most similar existing files to use as templates:**
- `src/orchestrator/checkpoints/mechanisms/disk.test.ts` — the `mkdtemp/rm` tmpdir lifecycle + polling pattern for disk-marker resolution. Lines 18-37 are the canonical setup.
- `tests/graph/hook-integration.test.ts:7-30` — `mkdtemp(join(tmpdir(), "bober-..."))` + `beforeEach/afterEach` cleanup pattern for tests that need a full project fixture.

**Structure template (skeleton — implement, don't paste):**
```typescript
/**
 * Tier 2 careful-flow end-to-end integration test (s14-c6).
 *
 * Scaffolds a tmpdir bober project with mode='careful' + mechanism='disk',
 * starts runPipeline() in-process, polls .bober/approvals/ for pending markers,
 * writes .approved.json files to unblock, and asserts run completion + audit log.
 *
 * In-process (not child process) for simpler error reporting and faster iteration.
 * The disk mechanism polls every 2s by default — override via DiskMechanismOptions
 * if you can re-construct the registry mechanism; otherwise expect ~2s per checkpoint.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, readdir, access } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPipeline } from "../../src/orchestrator/pipeline.js";
import { loadConfig } from "../../src/config/loader.js";

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "bober-careful-flow-"));
  // Write a minimal bober.config.json with mode='careful' and checkpointMechanism='disk'.
  // ALSO consider: stub the agent runners so the test isn't burning real LLM tokens.
  // Easiest approach: vi.mock the runResearch / runPlanner / runGenerator / runEvaluator
  // modules to return canned PlanSpec / GeneratorResult / EvaluationRunResult shapes.
  // This is acceptable for s14-c6 — the test is exercising the DISK mechanism +
  // approval dance, not the agents themselves.
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

describe("careful-flow end-to-end (s14-c6)", () => {
  it("disk-mechanism approval dance: write .approved.json → run completes → audit log written", async () => {
    // 1. Write fixture config + (minimal) project state into projectRoot.
    // 2. Start runPipeline() in the background — DO NOT await yet.
    // 3. Poll projectRoot/.bober/approvals/*.pending.json every 100ms.
    // 4. For each new pending file, write the matching .approved.json
    //    (shape: { approvedAt, approverId, [editDelta] }; see src/state/approval-state.ts:34-38).
    // 5. Await the pipeline promise. Assert success.
    // 6. Assert .bober/runs/<runId>.completed.json exists.
    // 7. Assert .bober/audits/<runId>.jsonl has at least N JSONL lines (one per checkpoint).
  });
});
```

**Two valid implementation strategies — pick ONE:**

**Strategy A — child process (matches generatorNotes literally):**
- `spawn` the built CLI: `node dist/cli/index.js run "test task" --mode=careful --checkpoint=disk`
- Pro: real CLI exercise; matches generatorNotes step list verbatim.
- Con: requires `npm run build` to have run; test is slow (~20-30s); flakier in CI.

**Strategy B — in-process (recommended by generatorNotes "in-process is simpler"):**
- Call `runPipeline(task, projectRoot, config)` directly; vi.mock the agent runners (`runResearch`, `runPlanner`, `runGenerator`, `runEvaluatorAgent`, `runCurator`, `runCodeReviewer`) to return canned artifacts.
- Pro: fast, deterministic, no build dependency. Pre-existing tests like `tests/orchestrator/curator-turn-count.test.ts:27-32` already use the vi.mock pattern.
- Con: mocking 6 modules is tedious; you're not testing the real CLI.

**Either way the THIRD-PARTY input remains real:** the test writes real `.approved.json` files to a real `.bober/approvals/` directory and the DiskCheckpointMechanism reads them — that's what s14-c6 is verifying. Don't mock the disk mechanism.

**Note about disk-mechanism construction:** `src/orchestrator/checkpoints/registry.ts:83-86` instantiates `DiskCheckpointMechanism` with `process.cwd()` at module-load time — NOT the runtime `projectRoot`. For an in-process test, you have two options:
  - `process.chdir(projectRoot)` in beforeEach (with restoration in afterEach). The registry's already-constructed instance will then use the right path on each `request()` call because `mkdir({ recursive: true })` runs every call (disk.ts:73).
  - OR: re-call `registerCheckpointMechanism("disk", new DiskCheckpointMechanism(join(projectRoot, ".bober", "approvals")))` at test start to replace the singleton.

Both are valid. `process.chdir` is one line and matches how a real user invokes `bober run` from their project root.

---

## 2. Patterns to Follow

### Schema additions in PipelineSection
**Source:** `src/config/schema.ts:143-152` (current shape) and lines 174-207 for the `GraphSectionSchema` (well-formed example of a complex section with `z.enum`, `z.number().int().positive()`, defaults, and `.default({...})`).

**Rule:** EVERY new field gets a `.default(...)` AND a JSDoc `/** Default X; …purpose. */`. Optional fields use `.optional()` (the resolver fills them in at runtime). Use `z.enum(["a", "b"])` for closed sets; `z.record(z.string(), z.enum([...]))` for the `checkpointOverrides` map.

### Commander option definitions
**Source:** `src/cli/index.ts:181-197` for the existing `run` registration; `src/cli/commands/approve.ts:33-83` for `.option("--edit <path>", ...)` pattern; `src/cli/commands/list-approvals.ts:39-44` for `.option("--json", ...)` boolean flag.

```typescript
// src/cli/index.ts:181-188
program
  .command("run [task]")
  .description("…")
  .option("--provider <name>", "Override AI provider for all roles (anthropic, openai, google, openai-compat)")
```

**Rule:** Boolean flags use `.option("--flag", "desc")`; value flags use `.option("--flag <value>", "desc")`. Hyphenated long names map to camelCase keys in the action handler (e.g. `--checkpoint-all` → `cmdOpts.checkpointAll`). Add `Override` or default-mentioning text to the description.

### Config override in run command
**Source:** `src/cli/commands/run.ts:80-89` (the provider-override block).
```typescript
if (options.provider) {
  config = {
    ...config,
    planner: { ...config.planner, provider: options.provider },
    // …
  };
  logger.info(`Provider override: ${options.provider}`);
}
```
**Rule:** Spread to clone immutably. Log via `logger.info` so users see the override applied. Apply BEFORE any agent runs.

### Disk-marker checkpoint resolution dance (the s14-c6 critical pattern)
**Source:** `src/orchestrator/checkpoints/mechanisms/disk.ts:104-169` (poll loop) and `src/state/approval-state.ts:106-117` (writing approval markers).

```typescript
// src/state/approval-state.ts:106-117 — the canonical marker writer
export async function saveApproved(
  projectRoot: string,
  id: string,
  m: ApprovedMarker,
): Promise<void> {
  await ensureDir(approvalsDir(projectRoot));
  await writeFile(
    approvedPath(projectRoot, id),
    JSON.stringify(m, null, 2) + "\n",
    "utf-8",
  );
}
```
Use this helper in the integration test — DO NOT hand-roll the path/format (consistency + correct shape: `{ approvedAt, approverId, [editDelta] }`).

### Zod refine() for warnings vs errors (s14-c5)
**Source:** No existing precedent in `src/config/schema.ts`. **Use this pattern:**
```typescript
// Hard error (unknown mechanism name) → z.enum (already handled by schema)
// Warning cases (e.g., careful + noop) → use .superRefine that logs warn but never adds an issue.
// Or: simpler approach — do warning checks in src/config/loader.ts AFTER successful parse.

// In loader.ts, after fullResult.data is built:
const cfg = fullResult.data;
if (cfg.pipeline.mode === "careful" && cfg.pipeline.checkpointMechanism === "noop") {
  process.stderr.write("warn: pipeline.mode='careful' with checkpointMechanism='noop' — checkpoints will auto-approve. Did you mean 'disk' or 'cli'?\n");
}
```
**Rule:** zod `z.enum([...])` covers s14-c5(c) (unknown mechanism name → hard error). zod `.refine()`/`.superRefine()` can add issues but cannot easily emit a non-fatal warning. Easiest: emit warnings via `process.stderr.write` from `loadConfig` AFTER schema parse (mirrors `pr.ts:403` `process.stderr.write` warning style). The gh-availability warning (s14-c5(b)) is already handled inside `PrCheckpointMechanism.request()` at `src/orchestrator/checkpoints/mechanisms/pr.ts:208-211` — DO NOT duplicate it in config validation.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `loadConfig` | `src/config/loader.ts:141` | `(projectRoot: string) => Promise<BoberConfig>` | Discover, parse, validate, deep-merge with defaults. Already returns a snapshot. |
| `configExists` | `src/config/loader.ts:90` | `(projectRoot: string) => Promise<boolean>` | Used by `run.ts:42` to early-exit. |
| `createDefaultConfig` | `src/config/schema.ts:247` | `(name, mode, preset?, overrides?) => BoberConfig` | Factory for full config; update its `pipeline` block when adding fields. |
| `getDefaults` | `src/config/defaults.ts:240` | `(mode, preset?) => Partial<BoberConfig>` | The `pipeline` blocks in `greenfieldBase` / `brownfieldBase` need new fields too. |
| `getCheckpointMechanism` | `src/orchestrator/checkpoints/registry.ts:24` | `(name: string) => CheckpointMechanism` | Lookup by registered name. Throws on unknown. |
| `getCheckpointMechanismFor` | `src/orchestrator/checkpoints/registry.ts:66` | `(id, config?, fallback?) => CheckpointMechanism` | **EXTEND THIS** — add mode-based default tier. |
| `registerCheckpointMechanism` | `src/orchestrator/checkpoints/registry.ts:20` | `(name, impl) => void` | Used in tests to swap implementations. |
| `savePending`, `saveApproved`, `saveRejected`, `pendingExists`, `listPending`, `deletePending` | `src/state/approval-state.ts:49-155` | various | Filesystem helpers for `.bober/approvals/*.json` markers — use these in integration test. |
| `runWithAudit` | `src/orchestrator/checkpoints/audit.ts:275` | `(opts) => Promise<T>` | Wraps mechanism.request() with audit accounting. Already wired at all 9 pipeline call-sites + feedback-router. Reads `opts.mechanism: MechanismName` for the audit name — pass the resolved name. |
| `writeCompletionMarker` | `src/orchestrator/checkpoints/feedback-router.ts:387` | `(projectRoot, runId, summary) => Promise<void>` | Writes `.bober/runs/<runId>.completed.json`. The integration test asserts on this file. |
| `findProjectRoot` | `src/utils/fs.js` | `() => Promise<string \| null>` | Walks upward from cwd; CLI commands use this. |
| `ensureBoberDir` | `src/state/index.ts:87` | `(projectRoot: string) => Promise<void>` | Creates `.bober/` skeleton; `run.ts:92` and `pipeline.ts:521` already call it. |
| `logger.warn`, `logger.info`, `logger.error` | `src/utils/logger.ts` | various | Use for runtime messages; goes through chalk colorization. |
| `process.stderr.write` | builtin | `(s: string) => boolean` | Direct stderr — use for config-validation warnings to keep them out of `logger.info` info-level filter (matches `pr.ts:208-211` precedent). |
| `BoberConfigSchema.safeParse` | `src/config/schema.ts:212` | `(input: unknown) => SafeParseResult` | Use in backwards-compat test (s14-c7) — feed the real on-disk `bober.config.json` and assert success. |
| `PartialBoberConfigSchema` | `src/config/schema.ts:230` | (zod schema) | Sibling to `BoberConfigSchema`; what `loadConfig` actually validates against first. |

---

## 4. Prior Sprint Output

### Sprint 9: Disk-marker checkpoint mechanism
**Created:** `src/orchestrator/checkpoints/mechanisms/disk.ts` exporting `DiskCheckpointMechanism`. `src/state/approval-state.ts` exporting all the marker helpers. `src/cli/commands/{approve,reject,list-approvals}.ts`.
**Connection:** s14-c6 integration test consumes the entire Sprint 9 surface — DiskMechanism polls for `.approved.json` files that the test writes via `saveApproved()`.

### Sprint 10: Registry override hook + PR mechanism
**Created:** `getCheckpointMechanismFor(id, config, fallback)` in `registry.ts:66`. `CheckpointOverrideConfig` interface in `registry.ts:43`. `PrCheckpointMechanism` in `mechanisms/pr.ts`.
**Connection:** Sprint 14 EXTENDS the resolver — adding a `mode`-based default tier between the global default and the fallback. The interface signature must remain back-compat with the 5 existing test cases at `pr.test.ts:530-593`.

### Sprint 12: maxCheckpointIterations + feedback router
**Created:** `pipeline.maxCheckpointIterations` schema field (line 146). `feedback-router.ts` with `routeOutcome`, `runCheckpointWithFeedback`, `writeCompletionMarker`, `writeAbortMarker`, `ABORT_TOKEN`.
**Connection:** Sprint 14 verifies `maxCheckpointIterations` is already present (it is — line 146). The integration test should assert the completion marker `writeCompletionMarker` produces.

### Sprint 13: Approval audit trail
**Created:** `src/orchestrator/checkpoints/audit.ts` with `runWithAudit`, `recordApproval`, `resolveApproverId`, `MechanismName`. `pipeline.ts` was updated to wrap all 9 checkpoint sites with `runWithAudit`.
**Connection:** Sprint 14's integration test asserts `.bober/audits/<runId>.jsonl` is written (s14-c6). The audit relies on the orchestrator passing the correct `mechanism: MechanismName` — currently `pipeline.ts:149-151` and `:515-517` cast through `unknown` to read `checkpointMechanism`. After your schema additions you can use direct typed access (or leave the cast — but at least the types are now real).

---

## 5. Relevant Documentation

### Project Principles
**No `.bober/principles.md` exists.** The Sprint 14 contract (`.bober/contracts/sprint-spec-20260524-bober-vision-14.json`) plus the evaluatorNotes serve this role for this sprint.

### Architecture Decisions
**No `.bober/architecture/` directory.** The architectural seam for this sprint is documented inline in:
- `registry.ts:34-65` (override resolver contract)
- `checkpoints/index.ts` (barrel — public API surface)
- `sites.ts:1-22` (checkpoint site contract)

### Other Docs
- Spec file: `.bober/specs/spec-20260524-bober-vision.json` — Tier 2 closer context (this sprint completes Tier 2 per evaluatorNotes "Tier 2 COMPLETION GATE").
- Prior briefings in `.bober/briefings/sprint-spec-20260524-bober-vision-{9,10,12,13}-briefing.md` are valuable cross-references for the Tier 2 patterns.

### Coding conventions (extracted from existing files)
- ESM: every relative import ends in `.js` (e.g., `from "../../src/config/loader.js"`)
- Node builtins use `"node:"` prefix: `import { readFile } from "node:fs/promises"`
- Named exports only (no default exports)
- Strict TypeScript: `noUnusedLocals`, `noUnusedParameters`, `strict: true` (tsconfig.json:21-23)
- JSDoc comments on every exported symbol
- File headers describe purpose + sprint provenance (e.g., `* Sprint 9 — colocated CLI command per Sprint 8/10 precedent.`)

---

## 6. Testing Patterns

### Unit Test Pattern (colocated)
**Source:** `src/cli/commands/approve.test.ts` (CLI command test) and `src/orchestrator/checkpoints/checkpoints.test.ts` (registry test).
```typescript
// src/orchestrator/checkpoints/mechanisms/disk.test.ts:18-37 — tmpdir lifecycle
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-disk-cp-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });
```
**Runner:** vitest 3.0.5 (`package.json:93`).
**Assertion style:** `expect(...).toBe`, `.toEqual`, `.toMatch`, `.toThrow`.
**Mock approach:** `vi.mock("../../src/foo/bar.js", () => ({ ... }))` for module-level mocks; `vi.spyOn` for method-level.
**File naming:** `<file>.test.ts` colocated next to the production file (e.g., `disk.test.ts` next to `disk.ts`).
**Location:** Colocated (within `src/`) for unit tests; under `tests/<topic>/` for cross-cutting/integration. Sprint 9+ briefings call this a HARD CONSTRAINT — keep colocated:separate >= 1:1 for production code.

### Config-parse Test Pattern
**Source:** `tests/config/graph-schema.test.ts:31-100`.
```typescript
import { BoberConfigSchema, PartialBoberConfigSchema } from "../../src/config/schema.js";

it("BoberConfigSchema accepts no graph section (backcompat invariant)", () => {
  const minimalNoGraph = {
    project: { name: "test", mode: "brownfield" },
    planner: {},
    generator: {},
    evaluator: { strategies: [] },
    sprint: {},
    pipeline: {},     // ← s14-c7 will assert this empty-pipeline still parses
    commands: {},
  };
  const result = BoberConfigSchema.safeParse(minimalNoGraph);
  expect(result.success).toBe(true);
});
```
**Use this exact shape for s14-c7** — feed the real `bober.config.json` (no pipeline.mode etc.) via `readFile` + `JSON.parse` then `BoberConfigSchema.safeParse`. The current `bober.config.json` (`/Users/bober4ik/agent-bober/bober.config.json:55-61`) has `pipeline: { maxIterations: 40, requireApproval: false, contextReset, researchPhase, architectPhase }` — NO mode/checkpointMechanism/checkpointOverrides. After your changes it MUST still parse with defaults filled in: `mode="autopilot"`, `checkpointMechanism=undefined`, `checkpointOverrides={}`, `maxCheckpointIterations=3`, `approvalTimeoutMs=86_400_000`, `prPollMs=30_000`.

### Integration Test Pattern (tmpdir + spawned process or in-process pipeline)
**Source:** `tests/graph/hook-integration.test.ts:1-83` — the only existing integration test in the repo. Uses `skipIf(!hasTokensave)` pattern, tmpdir setup, real binary invocation with `spawnSync`.
```typescript
// tests/graph/hook-integration.test.ts:22-30 — setup pattern
let tmp: string;
beforeEach(async () => { tmp = await mkdtemp(join(tmpdir(), "bober-hook-int-")); });
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });
```

For s14-c6, **prefer in-process** (generatorNotes "in-process is simpler and avoids CLI build complexity"). Mock the agent runners using `vi.mock` (precedent: `tests/orchestrator/curator-turn-count.test.ts:27-32`) so the test runs in ~5s instead of minutes.

### E2E Test Pattern (Playwright)
**Not applicable.** No `playwright.config.ts` exists. This is a CLI/Node test surface only.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/orchestrator/pipeline.ts` | `getCheckpointMechanismFor` (`registry.ts:66`) | **HIGH** | All 9 call-sites at lines 169, 271, 341, 405, 447, 560, 703, 740, 810 use the 3-arg form `(checkpointId, config, "noop")`. If you change the signature, keep the 3-arg form valid (add new params as OPTIONAL trailing args). The `config as unknown as { pipeline?: { checkpointMechanism?: string } }` casts at lines 149-151 and 515-517 should be cleaned up once the schema has `checkpointMechanism` as a real field — but the cast still compiles, so this is opportunistic. |
| `src/orchestrator/checkpoints/mechanisms/pr.test.ts:530-593` | `getCheckpointMechanismFor` | **HIGH** | 5 s10-c5 test cases. Each calls `getCheckpointMechanismFor(id, config)` or `(id, config, "noop")`. They MUST still pass identically — the new mode-default tier only fires when `checkpointMechanism` is unset AND there's no per-checkpoint override, so adding the tier preserves prior behaviour. |
| `src/orchestrator/checkpoints/registry.ts:43-52` (`CheckpointOverrideConfig`) | direct use in `getCheckpointMechanismFor` + `pipeline.ts` casts | MEDIUM | If you add `mode?: "autopilot" \| "careful"` to this interface, the cast in `pipeline.ts:149` and `:515` should keep working (interface widening). |
| `src/config/loader.ts:214-221` | `PipelineSectionSchema` defaults | MEDIUM | The default-pipeline literal at lines 214-221 hand-writes all 6 current fields. If you add new defaulted fields to schema, this literal must be updated too OR rely on zod's `.default()` to fill them in after deep-merge. (Safer to update both for clarity.) |
| `src/config/defaults.ts:188-227` | `BoberConfigSchema` shape | MEDIUM | `greenfieldBase` and `brownfieldBase` `pipeline` blocks must include the new fields OR rely on zod defaults — but partial overrides go through `deepMerge` so missing keys stay missing. Safer to include them explicitly. |
| `src/config/schema.ts:284-291` (`createDefaultConfig`) | `BoberConfig` type | MEDIUM | The literal at lines 284-291 is `BoberConfig`-typed; adding required fields without defaults breaks this. Use `.default()` in schema and the literal stays compatible. |
| `tests/config/graph-schema.test.ts` | `BoberConfigSchema` | LOW | Tests don't reference pipeline.mode — your additions should not break them. |
| `templates/*/bober.config.json` (5 files) | `PartialBoberConfigSchema` | LOW | Existing brownfield/preset templates omit `pipeline` entirely OR have minimal `pipeline:{}`. `PartialBoberConfigSchema` already accepts this (s14-c7 invariant). |

### Existing Tests That Must Still Pass
- `src/orchestrator/checkpoints/mechanisms/pr.test.ts:530-593` — s10-c5 resolver tests (5 cases). Adding a mode-default tier only affects the path where both `override` and `global` are unset, which falls back to the explicit `fallback` param in those tests — back-compat preserved.
- `src/orchestrator/checkpoints/checkpoints.test.ts:20-44` — basic registry tests (4 cases). Untouched by schema/resolver changes.
- `tests/config/graph-schema.test.ts:31-100` — config parse tests for templates. Adding optional `pipeline` fields with defaults won't break templates that omit them.
- `src/orchestrator/checkpoints/feedback-router.test.ts` — uses `runWithAudit` and `routeOutcome`. Untouched.
- `src/orchestrator/checkpoints/audit.test.ts` — checks `recordApproval` + `runWithAudit`. Untouched.
- `src/orchestrator/checkpoints/mechanisms/disk.test.ts` — DiskCheckpointMechanism unit tests. Untouched.
- `src/orchestrator/checkpoints/mechanisms/cli.test.ts` — CliCheckpointMechanism unit tests. Untouched.

### Features That Could Be Affected
- **Sprint 13 audit logging** — shares the `runWithAudit` API. The pipeline currently reads `checkpointMechanism` via an unsafe cast; your schema additions make this a real field. Audit records' `mechanism` field will now reflect the user's config explicitly. Verify audit entries still write correctly during the s14-c6 integration test.
- **Sprint 12 feedback-router** — `runCheckpointWithFeedback` and `routeOutcome`. Not directly touched; per-checkpoint iteration count is unaffected.
- **`bober sprint` command** (`src/cli/commands/sprint.ts`) — does NOT take checkpoint flags. evaluatorNotes only mention `bober run`; `bober sprint` is a separate command that runs ONE sprint without the full pipeline. Leave it alone.
- **Existing repo config (`bober.config.json`)** — backwards-compat invariant: with NO new fields set, `pipeline.mode` defaults to `'autopilot'`, `checkpointMechanism` is undefined → mode default → `'noop'` → all checkpoints auto-approve (current behavior). s14-c7 verifies this.

### Recommended Regression Checks
After implementation, the Generator MUST verify:
1. `npx vitest run src/orchestrator/checkpoints/mechanisms/pr.test.ts` → all s10-c5 tests still pass.
2. `npx vitest run tests/config/graph-schema.test.ts` → all template configs still parse.
3. `npx vitest run src/orchestrator/checkpoints/` → all colocated checkpoint tests pass.
4. `npx vitest run tests/integration/careful-flow.test.ts` → new s14-c6 test passes.
5. `npm run typecheck` → exit 0. (Will likely flag unused params or casts you can now remove.)
6. `npm run lint` → exit 0.
7. `npm run build` → exit 0.
8. **Manual back-compat check (s14-c7):** in a node REPL or one-off test:
   ```typescript
   import { readFile } from "node:fs/promises";
   import { BoberConfigSchema } from "./src/config/schema.js";
   const raw = await readFile("./bober.config.json", "utf-8");
   const result = BoberConfigSchema.safeParse(JSON.parse(raw));
   console.log(result.success, result.success ? result.data.pipeline : result.error.issues);
   // EXPECT: success=true, pipeline.mode='autopilot', checkpointMechanism=undefined, checkpointOverrides={}
   ```
9. **CLI help inspection:** after `npm run build`, run `node dist/cli/index.js run --help` and verify the three new flags appear with clear precedence wording.

---

## 8. Implementation Sequence

1. **`src/config/schema.ts`** — add 5 new fields to `PipelineSectionSchema` (mode, checkpointMechanism, checkpointOverrides, approvalTimeoutMs, prPollMs). Update `createDefaultConfig`'s pipeline block. Update `PipelineSection` type (auto via `z.infer`).
   - Verify: `npx tsc --noEmit` exit 0; `src/config/index.ts` re-exports still work.
2. **`src/config/defaults.ts`** — add the same 5 fields to `greenfieldBase.pipeline` and `brownfieldBase.pipeline` (mode/checkpointOverrides/approvalTimeoutMs/prPollMs at minimum; `checkpointMechanism` stays undefined).
   - Verify: `npx vitest run tests/config/graph-schema.test.ts` passes.
3. **`src/config/loader.ts`** — update the default-pipeline literal at lines 214-221 to include the new fields (`mode: "autopilot" as const, checkpointOverrides: {}, approvalTimeoutMs: 86_400_000, prPollMs: 30_000`). Add the warn-on-careful+noop check AFTER successful schema parse.
   - Verify: `npx vitest run` passes; manual `BoberConfigSchema.safeParse` on `bober.config.json` returns success.
4. **`src/orchestrator/checkpoints/registry.ts`** — extend `CheckpointOverrideConfig` with `mode?: "autopilot" | "careful"`. Add a sibling pure resolver `resolveCheckpointMechanismName(checkpointId, config, cliOverride?, cliOverrideAll?, fallback?): string` implementing the 6-tier logic. Modify `getCheckpointMechanismFor` to delegate to the resolver and add optional `cliOverride`/`cliOverrideAll` trailing params.
   - Verify: `npx vitest run src/orchestrator/checkpoints/mechanisms/pr.test.ts` passes (5 s10-c5 tests). Add 3-5 NEW tests for mode-based defaults.
5. **`src/orchestrator/checkpoints/index.ts`** — re-export the new `resolveCheckpointMechanismName` symbol if you create it.
   - Verify: `npx vitest run src/orchestrator/checkpoints/`.
6. **`src/cli/commands/run.ts`** — extend `RunCommandOptions` with `mode`, `checkpoint`, `checkpointAll`. Add the config-override block after `loadConfig` mirroring the provider-override pattern at lines 80-89. Log applied overrides via `logger.info`.
   - Verify: `npm run typecheck`; manually invoke `runRunCommand` from a test or by reading the code.
7. **`src/cli/index.ts`** — add three `.option(...)` declarations to the `run` command at lines 181-197. Update the action handler's type and pass-through.
   - Verify: `npm run build` exits 0; `node dist/cli/index.js run --help` shows the three flags with clear precedence wording.
8. **`tests/integration/careful-flow.test.ts`** (create new directory `tests/integration/`) — write the s14-c6 end-to-end test. Strategy: in-process `runPipeline` with mocked agent runners + real DiskCheckpointMechanism. Poll for `.pending.json`, write `.approved.json` via `saveApproved`, await pipeline, assert completion marker + audit log.
   - Verify: `npx vitest run tests/integration/careful-flow.test.ts` passes within ~10s.
9. **Add backwards-compat test (s14-c7)** — colocated next to existing `tests/config/graph-schema.test.ts` OR add to an existing file there. Test: load the REAL repo `bober.config.json` via `BoberConfigSchema.safeParse` and assert `success === true`; verify defaults are filled in.
   - Verify: `npx vitest run tests/config/`.
10. **Run full verification** — `npm run typecheck && npm run lint && npm run build && npm run test`. Exit 0 across all four.

---

## 9. Pitfalls & Warnings

- **MISSING FIELDS DESPITE CONTRACT SAYING OTHERWISE.** s14-c1 says `pipeline.approvalTimeoutMs` (Sprint 9) and `pipeline.prPollMs` (Sprint 10) are "already added — verify present." Grep confirms they are NOT in `src/config/schema.ts`. You MUST add them. The verifier will read the schema and demand all 6 fields.
- **`getCheckpointMechanismFor` signature MUST stay back-compat.** 9 call-sites in `pipeline.ts` use the 3-arg `(id, config, "noop")` form, and 5 test cases at `pr.test.ts:541-575` use the 2-arg `(id, config)` form. Add new params as OPTIONAL trailing args, NOT as required positional args.
- **Registry's DiskCheckpointMechanism is constructed at module-load with `process.cwd()`** (`registry.ts:83-86`). For the integration test, either `process.chdir(projectRoot)` in beforeEach (with restore in afterEach) OR re-register a fresh instance via `registerCheckpointMechanism("disk", new DiskCheckpointMechanism(...))` BEFORE invoking the pipeline. The `mkdir({ recursive: true })` in disk.ts:73 means each request will create the right dir at runtime — but the cached approvalsDir is fixed.
- **`tsconfig.json` excludes `tests/`** (rootDir: src, include: src/**/*). The new `tests/integration/careful-flow.test.ts` will NOT be typechecked by `npm run typecheck` — only vitest typechecks it. Keep types clean; vitest will fail at runtime on type errors.
- **`tests/` files use relative imports with `.js` extensions** (e.g., `import { runPipeline } from "../../src/orchestrator/pipeline.js"`). ESM strict — `.js` is REQUIRED even though the source is `.ts`.
- **Zod `.refine()` cannot emit a non-fatal warning.** It can add an issue (fails parse). For s14-c5 (a) and (b) warnings, emit via `process.stderr.write` from `src/config/loader.ts` AFTER successful parse. Don't try to make zod do this.
- **`pipeline.checkpointMechanism` must stay OPTIONAL** in the schema (s14-c1 says "default computed at runtime per mode"). If you give it a `.default("noop")`, the mode-based default tier in the resolver will NEVER fire — the schema default will always be present. Optional + runtime default is the correct pattern.
- **DO NOT mock the disk mechanism in the integration test.** evaluatorNotes: "must produce real `.pending.json` files and the test harness must write real `.approved.json` files to unblock — otherwise the test isn't testing the integration."
- **`writeChains` in `audit.ts:82` is process-global module state.** The integration test re-uses this across multiple checkpoints in one run. Should be fine, but if you write multiple runs in one test, use distinct `runId`s.
- **`config` is mutated by the run-command override block (run.ts).** That's intentional — the snapshot happens at `loadConfig()` time; subsequent mutations are local to `runRunCommand`'s scope. `runPipeline(task, projectRoot, config)` receives the modified config and never re-reads from disk. evaluatorNotes "snapshot at run start" is already satisfied by this pattern; no extra plumbing needed.
- **Per-checkpoint overrides in config win over `--checkpoint` (but NOT over `--checkpoint-all`).** This is s14-c4's precedence requirement. The resolver's tier ordering enforces this if you follow generatorNotes' pseudo-code: per-checkpoint config override before CLI override before global config.
- **The `bober run` command does NOT accept a task as a positional arg always.** Lines 183 says `[task]` (optional); if omitted, line 53-66 in `run.ts` prompts interactively. For the integration test, ALWAYS pass a task string OR pre-populate the prompt to avoid hanging on `prompts({...})`. If using in-process strategy, calling `runRunCommand("test task", projectRoot, opts)` skips the prompt.
- **The 5 `templates/*/bober.config.json` files should NOT need updates** — they all use `PartialBoberConfigSchema` which already accepts missing pipeline fields. But verify by running `tests/config/graph-schema.test.ts` after your changes.
- **`process.chdir` between tests can leak.** If you use chdir in the integration test, save the original cwd in beforeEach and restore in afterEach — otherwise subsequent tests run in a deleted directory and fail mysteriously.

