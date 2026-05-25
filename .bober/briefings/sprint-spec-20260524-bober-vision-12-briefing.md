# Sprint Briefing: Checkpoint feedback propagation back to responsible agents

**Contract:** sprint-spec-20260524-bober-vision-12
**Generated:** 2026-05-25T00:00:00Z

---

## 0. Critical Path-Override Up Front

The contract's `expectedChanges` list at sprint-12 names `tests/orchestrator/checkpoints/feedback-router.test.ts`. **DO NOT use that path.** The COLOCATION HARD CONSTRAINT established by Sprints 5/7-11 (see `src/orchestrator/checkpoints/checkpoints.test.ts:1-8`, `src/orchestrator/checkpoints/mechanisms/disk.test.ts:1-16`) requires:

- Router source:  `src/orchestrator/checkpoints/feedback-router.ts`
- Router tests:   `src/orchestrator/checkpoints/feedback-router.test.ts` (colocated, NOT `tests/orchestrator/...`)

The router will also need an iteration-counter helper. Either inline it in `feedback-router.ts` or place at `src/orchestrator/checkpoints/iteration-counter.ts` with colocated `.test.ts`. Pipeline wiring lives in `src/orchestrator/pipeline.ts` (the contract names `pipeline-coordinator.ts` but no such file exists — `pipeline.ts` is the actual file).

The contract also lists `.bober/runs/` as a directory to create. This directory does **not** exist yet (`ls .bober/runs/` returns ENOENT) — runtime code MUST create it before writing markers (use `mkdir -p` / `ensureDir(...)`).

---

## 1. Target Files

### `src/orchestrator/checkpoints/feedback-router.ts` (create)

**Directory pattern:** `src/orchestrator/checkpoints/*.ts` uses kebab-case filenames. Each module has a single responsibility (`registry.ts`, `noop.ts`, `sites.ts`, `types.ts`), exports named symbols only (no default), and uses an explicit `.js` extension on every import (ESM TS). See `src/orchestrator/checkpoints/registry.ts:1-7` for the canonical header style.

**Most similar existing file (for structure):** `src/orchestrator/checkpoints/registry.ts:1-91`. It is a module-level service (no class needed for pure mapping logic), with a Map for dispatch, simple typed exports, and a self-registration block at the bottom.

**Structure template (recommended skeleton):**
```ts
/**
 * Feedback router (Sprint 12).
 *
 * Maps a CheckpointId to the responsible agent and re-invokes that agent
 * with the prior feedback woven into its prompt. Per-agent adaptation
 * differs by agent role (s12-c6). The 'no-op' (gate) checkpoints abort
 * the run on rejection — they are not iteration points.
 */
import type { CheckpointId, CheckpointOutcome } from "./types.js";
// ... agent runner imports

/** Per-checkpoint responsibility table. Source-of-truth for s12-c1 + s12-c6. */
export type ResponsibleAgent =
  | "researcher" | "planner" | "generator" | "evaluator" | "gate";

export const CHECKPOINT_TO_AGENT: Record<CheckpointId, ResponsibleAgent> = {
  "post-research":         "researcher",
  "post-plan":             "planner",
  "post-sprint-contract":  "planner",
  "pre-curator":           "gate",
  "pre-generator":         "gate",
  "pre-evaluator":         "gate",
  "pre-code-reviewer":     "gate",
  "post-sprint":           "generator",
  "end-of-pipeline":       "gate",
};

export interface FeedbackRouterContext { /* runId, projectRoot, config, artifact, originalPrompt? */ }
export type RouterDecision =
  | { kind: "retry"; newPrompt: string; newArtifact?: unknown }
  | { kind: "edit-applied"; updatedArtifact: unknown }
  | { kind: "abort"; reason: RunAbortedReason };

export interface RunAbortedReason {
  reason: "CHECKPOINT_ITERATION_EXHAUSTED" | "GATE_REJECTED" | "USER_ABORT";
  checkpointId: CheckpointId;
  lastFeedback?: string;
  iterationsCompleted: number;
}

export async function routeOutcome(
  checkpointId: CheckpointId,
  outcome: CheckpointOutcome,
  iteration: number,
  ctx: FeedbackRouterContext,
): Promise<RouterDecision> { /* ... */ }

/** Per-agent prompt-augmentation strategies (s12-c6). MUST differ between agents. */
function buildPlannerRetryPrompt(...) { /* prepend clarification context */ }
function buildGeneratorRetryPrompt(...) { /* inline into generatorNotes */ }
function buildResearcherRetryPrompt(...) { /* feedback inlined into question list */ }
function buildEvaluatorRetryPrompt(...) { /* "specifically check this concern" framing */ }
```

**Imports the new file will need:**
- `type { CheckpointId, CheckpointOutcome }` from `./types.js`
- Agent invocation entrypoints (call only the ones actually exercised):
  - `runResearch` from `../research-agent.js`
  - `runPlanner` from `../planner-agent.js`
  - `runGenerator` from `../generator-agent.js`
  - `runEvaluatorAgent` from `../evaluator-agent.js`
- For edit-delta application:
  - `writeFile`, `rename`, `readFile`, `mkdir` from `node:fs/promises`
  - `join`, `dirname` from `node:path`
- `ensureDir` from `../../utils/fs.js`
- `logger` from `../../utils/logger.js`

---

### `src/orchestrator/pipeline.ts` (modify)

**Relevant sections — checkpoint call sites that the router must replace/wrap:**

There are 9 call sites today, all of the form:
```ts
await getCheckpointMechanism("noop").request("<id>", <artifact>);
```
Their outcomes are silently discarded. The Sprint 12 work converts each into:

```ts
const outcome = await getCheckpointMechanismFor("<id>", config, "noop").request("<id>", <artifact>);
const decision = await routeOutcome("<id>", outcome, iter, { runId, projectRoot, config, artifact, originalPrompt });
if (decision.kind === "abort") { await writeAbortMarker(...); return /* clean exit */; }
if (decision.kind === "edit-applied") { artifact = decision.updatedArtifact; /* proceed */ }
if (decision.kind === "retry") { /* re-invoke responsible agent; loop with iteration++ */ }
```

The 9 sites (exact lines in current `pipeline.ts`):
- `pipeline.ts:140`   — `"pre-curator"`   gate
- `pipeline.ts:235`   — `"pre-generator"` gate (inside iteration loop)
- `pipeline.ts:298`   — `"pre-evaluator"` gate (inside iteration loop)
- `pipeline.ts:355`   — `"pre-code-reviewer"` gate
- `pipeline.ts:390`   — `"post-sprint"` → generator iterates
- `pipeline.ts:485`   — `"post-research"` → researcher iterates
- `pipeline.ts:621`   — `"post-plan"` → planner iterates
- `pipeline.ts:651`   — `"post-sprint-contract"` → planner iterates
- `pipeline.ts:713`   — `"end-of-pipeline"` gate

Reference snippet (`pipeline.ts:483-486`):
```ts
researchDoc = await runResearch(userPrompt, projectRoot, config);
// ... appendHistory ...
await getCheckpointMechanism("noop").request("post-research", researchDoc);
```

**Imports already in scope:** `getCheckpointMechanism` (line 35). Add: `getCheckpointMechanismFor`, `routeOutcome`, `writeAbortMarker`, `writeCompletionMarker`, `type RunAbortedReason`.

**Tests for `pipeline.ts`:** No colocated test exists today (`ls src/orchestrator/pipeline.test.ts` → does not exist). The pipeline is integration-tested via the live `bober run` only. Keep Sprint 12 unit tests scoped to the router module and a small wiring-level test (e.g., mocked outcome → router invoked correctly) — do not aim for full pipeline coverage.

---

### `src/config/schema.ts` (modify)

**Relevant section (lines 143-150) — `PipelineSectionSchema`:**
```ts
export const PipelineSectionSchema = z.object({
  maxIterations: z.number().int().min(1).default(20),
  requireApproval: z.boolean().default(false),
  contextReset: ContextResetSchema.default("always"),
  researchPhase: z.boolean().default(true),
  architectPhase: z.boolean().default(false),
});
```

**Sprint 12 edit — add the field:**
```ts
maxCheckpointIterations: z.number().int().min(1).default(3),
```
Place it directly under `maxIterations` to keep iteration-related fields together. Default is `3` per the contract description.

**Also update `src/config/defaults.ts` (lines 282-288, 187-194, 218-224)** — the three `pipeline:` literal blocks must NOT mention `maxCheckpointIterations` unless you want a non-default; Zod `.default(3)` makes the literal unnecessary. Adding the literal would require updating `createDefaultConfig`'s base too. Simplest: rely on the Zod default and DO NOT touch `defaults.ts`. Verify by running `npm run typecheck` after the schema edit — the optional field will be inferred on `BoberConfig.pipeline`.

**Test file:** `src/config/schema.test.ts` does not exist; the schema is exercised by integration tests. Add a small unit test inside `feedback-router.test.ts` to assert that `BoberConfigSchema.parse({...minimum...}).pipeline.maxCheckpointIterations === 3`.

---

### `src/orchestrator/checkpoints/renderers/sprint-contract.ts` (modify — s12-c5)

**Relevant section (lines 26-62)** — current renderer signature accepts `unknown` and ignores any iteration metadata. To satisfy s12-c5 ("iteration metadata is surfaced in checkpoint prompts: artifact summary at iteration 2+ includes a 'Previous feedback' section"), extend the input shape:

```ts
interface SprintContractLike {
  // ...existing fields...
  iterationMeta?: {
    currentIteration: number;       // 2+ when shown
    maxIterations: number;
    priorRejections: { iteration: number; feedback: string }[];
  };
}
```

In `renderSprintContract`, append (after the `### Depends on` block) a section when `c.iterationMeta?.currentIteration > 1`:

```ts
if (im && im.currentIteration > 1 && im.priorRejections.length > 0) {
  lines.push(``, `### Previous feedback (iteration ${im.currentIteration} of ${im.maxIterations})`);
  for (const r of im.priorRejections) {
    lines.push(`- _iteration ${r.iteration}:_ ${r.feedback}`);
  }
}
```

Apply the same pattern to OTHER renderers used by iterating checkpoints — at minimum `renderResearch` (`renderers/research.ts:24-52`) and `renderPlanSpec` (`renderers/plan.ts`). The router or pipeline wiring is responsible for attaching `iterationMeta` to the artifact before passing it to `mechanism.request(...)`.

**Tests for renderers:** colocated, e.g. `renderers/sprint-contract.test.ts:1-92`. Extend existing tests with a new `it("shows Previous feedback section at iteration 2+", ...)` case.

---

### `.bober/runs/` (create at runtime)

Not a checked-in directory — the orchestrator must `ensureDir(join(projectRoot, ".bober", "runs"))` before writing any of:
- `.bober/runs/<runId>.aborted.json`
- `.bober/runs/<runId>.completed.json`
- `.bober/runs/<runId>/edits/<checkpointId>.original.<ext>` (for reversibility of applied edit deltas; per evaluatorNotes)

**Atomic write pattern (per evaluatorNotes — half-written marker files must never exist):**
```ts
const tmp = `${markerPath}.tmp`;
await writeFile(tmp, JSON.stringify(payload, null, 2) + "\n", "utf-8");
await rename(tmp, markerPath); // POSIX rename is atomic on same filesystem
```

Add `runs` to the `SUBDIRS` constant in `src/state/index.ts:75` so that `ensureBoberDir` provisions it alongside the other 9 subdirectories.

---

## 2. Patterns to Follow

### Pattern A — ESM imports use explicit `.js` (TypeScript ESM)
**Source:** `src/orchestrator/checkpoints/registry.ts:1-6`
```ts
import { join } from "node:path";
import type { CheckpointMechanism } from "./types.js";
import { NoopCheckpointMechanism } from "./noop.js";
```
**Rule:** Every relative import in `src/` ends in `.js`. Type-only imports use `import type`. Node built-ins use the `node:` prefix.

### Pattern B — Module-level dispatch table (registry pattern)
**Source:** `src/orchestrator/checkpoints/registry.ts:18-22`, `src/orchestrator/checkpoints/renderers/registry.ts:43-69`
```ts
const mechanisms = new Map<string, CheckpointMechanism>();
export function registerCheckpointMechanism(name: string, impl: CheckpointMechanism): void { ... }
export function getCheckpointMechanism(name: string): CheckpointMechanism { ... }
```
**Rule:** When mapping string keys to behavior, use a module-level `Map<string, T>` plus `register`/`get` helpers — NOT a class. Self-register built-ins at module bottom. The feedback-router's per-agent strategies (s12-c6) can follow either an inline switch or a strategy-Map; the precedent favors `Map` when external extension is expected, inline `switch` when only internal use is expected.

### Pattern C — JSDoc header naming the sprint and prior precedent
**Source:** `src/orchestrator/checkpoints/mechanisms/disk.ts:1-11`
```ts
/**
 * Disk-marker blocking checkpoint mechanism.
 *
 * ...what it does...
 *
 * Sprint 9 — colocated in mechanisms/ per Sprint 7+8 precedent.
 */
```
**Rule:** Every new module starts with a doc-comment explaining the responsibility, the sprint that introduced it, and any colocation justification.

### Pattern D — Optional injected dependencies for testability
**Source:** `src/orchestrator/checkpoints/mechanisms/disk.ts:55-62`
```ts
constructor(
  private readonly approvalsDir: string,
  private readonly options: DiskMechanismOptions = {},
  private readonly now: () => number = () => Date.now(),
) {}
```
**Rule:** Functions/classes that depend on `Date.now()`, the filesystem, or external services accept those as constructor-injected (or last-positional optional) parameters with sensible defaults. Tests then pass a fake `now`, a temp directory, or a mock agent runner.

### Pattern E — Discriminated-union result types
**Source:** `src/orchestrator/checkpoints/types.ts:46-49`, `src/orchestrator/planner-agent.ts:109-111`
```ts
export type CheckpointOutcome =
  | { approved: true; editDelta?: unknown }
  | { approved: false; feedback: string }
  | { edit: true; editDelta: unknown };
```
**Rule:** Multi-branch return values use a discriminated union (literal-typed tag field). Callers MUST narrow on the tag. The `RouterDecision` (`retry | edit-applied | abort`) MUST follow this exact pattern.

### Pattern F — Errors-as-values for resolution failures
**Source:** `src/orchestrator/checkpoints/registry.ts:25-32`
```ts
const impl = mechanisms.get(name);
if (!impl) {
  throw new Error(
    `Unknown checkpoint mechanism: ${name}. Registered: ${[...mechanisms.keys()].join(", ") || "(none)"}`,
  );
}
```
**Rule:** Programmer-error conditions throw `Error` with a message that lists valid alternatives. Recoverable conditions (timeout, missing optional field) return a result type.

### Pattern G — Atomic file writes via tmp+rename
**Source:** Not currently in `src/` (`grep -rn "rename" src/` → no results). The disk mechanism does NOT do atomic write today (`disk.ts:98-102`). The evaluatorNotes explicitly require atomic writes for the abort marker — **this sprint must introduce the pattern**:
```ts
const tmp = `${path}.tmp`;
await writeFile(tmp, content, "utf-8");
await rename(tmp, path);
```

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---|---|---|---|
| `ensureDir` | `src/utils/fs.ts:46` | `(path: string) => Promise<void>` | Recursive mkdir; use before any `writeFile` to `.bober/runs/`. |
| `writeJson` | `src/utils/fs.ts:34-40` | `(path: string, data: unknown) => Promise<void>` | Pretty-printed JSON write; does NOT do atomic tmp+rename — extend it or write inline atomic logic. |
| `readJson<T>` | `src/utils/fs.ts:24-27` | `(path: string) => Promise<T>` | JSON parse from disk. |
| `fileExists` | `src/utils/fs.ts:10-16` | `(path: string) => Promise<boolean>` | Existence check via `access(R_OK)`. |
| `logger` | `src/utils/logger.ts` | `{ info, warn, error, debug, success, phase, progress }` | Standard logger; ALL router state changes log via this. |
| `getCheckpointMechanism` | `src/orchestrator/checkpoints/registry.ts:24` | `(name: string) => CheckpointMechanism` | Resolves mechanism by name. |
| `getCheckpointMechanismFor` | `src/orchestrator/checkpoints/registry.ts:61` | `(checkpointId, config, fallback?) => CheckpointMechanism` | Per-checkpoint override resolution — pipeline edits should USE THIS, not the plain `getCheckpointMechanism`. |
| `CHECKPOINT_SITES` | `src/orchestrator/checkpoints/sites.ts:23-78` | `readonly CheckpointSite[]` | The 9 enumerated checkpoint sites. |
| `render` (renderer registry dispatch) | `src/orchestrator/checkpoints/renderers/registry.ts:75-88` | `(artifact: unknown) => string` | Per-`type` markdown renderer — attach `iterationMeta` to the artifact BEFORE calling `mechanism.request(...)` so renderers can show prior feedback. |
| `appendHistory` | `src/state/history.ts` (re-exported via `src/state/index.ts:21`) | `(projectRoot, HistoryEntry) => Promise<void>` | Append to `.bober/history.jsonl`. Use for `checkpoint-rejected`, `checkpoint-retry`, `run-aborted`, `run-completed` events. |
| `ensureBoberDir` | `src/state/index.ts:79` | `(projectRoot: string) => Promise<void>` | Provisions `.bober/{contracts,specs,...}`. **Extend `SUBDIRS` (line 75) with `"runs"`.** |
| `saveContract` | `src/state/sprint-state.ts:38` | `(projectRoot, SprintContract) => Promise<void>` | Validates+writes; reuse if edit-delta updates a sprint-contract artifact. |
| `saveSpec` | `src/state/plan-state.ts:22` | `(projectRoot, PlanSpec) => Promise<void>` | Validates+writes plan spec; reuse if edit-delta updates a plan-spec artifact. |
| `saveResearch` | `src/state/research-state.ts:139` | `(projectRoot, ResearchDoc) => Promise<void>` | Writes `.bober/research/<id>.md`; reuse for research edit-delta. |
| `savePending`/`saveApproved`/`saveRejected` | `src/state/approval-state.ts:49,106,122` | `(projectRoot, id, marker) => Promise<void>` | Already used by disk mechanism — DO NOT recreate when wiring checkpoint feedback into the approvals dir. |

**No JSON-patch library is installed** (`grep "json-patch" package.json` → empty). Per generatorNotes, when an edit-delta is a JSON patch, the router has two viable paths:
1. **Recommended:** treat edit-delta as a full replacement of the artifact (the artifact JSON is small — specs/contracts are under a few KB). Detect by examining `editDelta` shape (string → markdown replacement; object with `op`/`path`/`value` arrays → JSON patch). If JSON patch is needed and no lib is installed, install `fast-json-patch` (~30KB) — but FIRST check if simple replacement covers the test cases the contract demands. The contract's s12-c3 test ("provide an edit delta for a sprint contract, verify the contract file on disk is updated") only requires that *some* form of edit application works; full replacement is the simpler path.
2. **Avoid:** rolling a hand-coded JSON patch applier.

---

## 4. Prior Sprint Output

### Sprint 7: `src/orchestrator/checkpoints/{types,registry,sites,noop,index}.ts`
**Key exports:** `CheckpointId`, `CheckpointArtifact`, `CheckpointMechanism`, `CheckpointOutcome` (`types.ts:13,29,46,55`); `registerCheckpointMechanism`, `getCheckpointMechanism` (`registry.ts:20,24`); `CHECKPOINT_SITES` (`sites.ts:23`); `NoopCheckpointMechanism` (`noop.ts:10`).
**Connection:** Sprint 12 consumes `CheckpointOutcome` to discriminate {approved:true} | {approved:false, feedback} | {edit:true, editDelta}, and walks `CHECKPOINT_SITES`/`CheckpointId` to validate that the router's mapping is exhaustive. **The shape is FROZEN by the type union — do not add a fourth variant; just route.**

### Sprints 8 / 9 / 10: CLI / disk / PR checkpoint mechanisms
**Created:** `src/orchestrator/checkpoints/mechanisms/{cli,disk,pr}.ts`.
**Connection:** The router is mechanism-agnostic — it only consumes the `CheckpointOutcome` returned by whatever mechanism is registered. Sprint 12 does NOT modify the three mechanisms. It DOES add `getCheckpointMechanismFor("<id>", config, "noop")` in place of `getCheckpointMechanism("noop")` at every pipeline call site so config overrides land before the router runs.

### Sprint 10: `getCheckpointMechanismFor` + `CheckpointOverrideConfig`
**Created:** `src/orchestrator/checkpoints/registry.ts:61-69`, `CheckpointOverrideConfig` (`registry.ts:40-47`).
**Connection:** Use this for the 9 pipeline call-site replacements — it cleanly accepts `BoberConfig` due to the structural-subset interface.

### Sprint 11: `src/orchestrator/checkpoints/renderers/`
**Created:** `renderers/{research,plan,sprint-contract,curator-briefing,generator-diff,eval-result,code-review,sprint-summary,pipeline-summary}.ts`, plus `renderers/registry.ts` and `renderers/_util.ts`.
**Connection:** Sprint 12 extends the sprint-contract / research / plan renderers to surface `iterationMeta.priorRejections` (s12-c5). The router or pipeline must attach this metadata to the artifact passed into `mechanism.request(...)` so the renderer picks it up. The `applyLineCap` and other `_util.ts` helpers are reusable for any new renderer additions.

---

## 5. Relevant Documentation

### Project Principles
**No `.bober/principles.md` file found.** `ls /Users/bober4ik/agent-bober/.bober/principles.md` → ENOENT. The project's de-facto principles come from sprint briefings + the contract precision rules in `src/contracts/sprint-contract.ts:1-34` (literal-following warnings).

### Architecture Decisions
**No `.bober/architecture/` directory found** for this project. Relevant prior ADR-style guidance is inline in sprint briefings (briefings/ has only the sprint-11 briefing).

### Other Docs
- **`/Users/bober4ik/CLAUDE.md`** — top-level project instructions mandate using the `code-review-graph` MCP for exploration. (Curator did not invoke graph tools because none are registered for this Bober repo; standard filesystem grep was used.)
- **`README.md`** at project root and **`CHANGELOG.md`** — Bober is publishable as an npm CLI; do not break the `"bin"` entry (`dist/cli/index.js`). The build artifact is `dist/` (tsc compile); src files MUST be valid TypeScript ESM.
- **`agents/*.md`** — agent slugs are `bober-{researcher,planner,curator,generator,evaluator,architect,code-reviewer}` (verified via `grep "^name:" agents/*.md`). The router's `CHECKPOINT_TO_AGENT` should use the unprefixed role names (`researcher`, `planner`, `generator`, `evaluator`) to match the existing `assembleSystemPrompt(role, slug, ...)` first-arg convention in `planner-agent.ts:137` and `research-agent.ts:80,87`.

---

## 6. Testing Patterns

### Unit Test Pattern
**Runner:** Vitest (`package.json: "test": "vitest"`).
**Assertion style:** `expect(...).toEqual(...)`, `expect(...).toContain(...)`, `expect(...).toBe(...)`.
**Mock approach:** Constructor injection (see Pattern D) — no `vi.mock` global mocks in the checkpoints suite; tests pass stub objects directly.
**Test file naming:** `<module>.test.ts`, colocated next to the module.
**Location:** Colocated, NOT `tests/`. Hard constraint reaffirmed in `src/orchestrator/checkpoints/mechanisms/disk.test.ts:1-16` and `src/orchestrator/checkpoints/checkpoints.test.ts:1-8`.

**Reference example — sprint-contract renderer test (`src/orchestrator/checkpoints/renderers/sprint-contract.test.ts:34-92`):**
```ts
import { describe, it, expect } from "vitest";
import { renderSprintContract } from "./sprint-contract.js";

const SAMPLE_CONTRACT = {
  type: "sprint-contract",
  contractId: "sprint-spec-20260524-bober-vision-10",
  // ...
};

describe("renderSprintContract (s11-c5)", () => {
  it("shows contractId", () => {
    const out = renderSprintContract(SAMPLE_CONTRACT);
    expect(out).toContain("## Sprint Contract: `sprint-spec-20260524-bober-vision-10`");
  });
  // ...
});
```

**Reference example — temp-directory + timing test (`src/orchestrator/checkpoints/mechanisms/disk.test.ts:18-145`):**
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskCheckpointMechanism } from "./disk.js";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-disk-cp-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

it("returns { approved: true } when .approved.json appears", async () => {
  const m = new DiskCheckpointMechanism(tmpDir, { pollMs: 10 });
  const id = "post-research" as CheckpointId;
  setTimeout(async () => { await writeApproved(tmpDir, id); }, 30);
  const outcome = await m.request(id, { type: "research-doc" });
  expect(outcome).toEqual({ approved: true });
});
```

**Use this pattern for the s12-c7 tests:** create a temp `.bober/runs` directory per test, write fixture artifacts (small JSON specs), inject a stub `agentRunner` into the router, and assert on (a) prompt-augmentation per agent, (b) iteration counter, (c) edit-delta application to disk, (d) `!!abort` early exit, (e) `.bober/runs/<runId>.aborted.json` shape.

### E2E Test Pattern
**Not applicable.** No Playwright config at the repo root (`ls playwright.config.* e2e/` → none). Sprint 12 is internal orchestrator wiring; all tests are unit/integration in vitest.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|---|---|---|---|
| `src/orchestrator/pipeline.ts` | Modified by sprint 12 | **HIGH** | Pipeline is the central runtime; every prior sprint flows through it. Verify the 9 call sites still compile, that the `noop` mechanism is still the default (per s12-c8 — all existing strategies pass), and that `interrupted` SIGINT handling still wins over router iteration. |
| `src/orchestrator/checkpoints/renderers/sprint-contract.ts` | Modified for s12-c5 | LOW-MEDIUM | Existing tests in `sprint-contract.test.ts` assert on output strings; ensure new "Previous feedback" section is APPENDED, not interleaved, so the existing 8 tests still pass. |
| `src/orchestrator/checkpoints/renderers/research.ts` + `plan.ts` | (Maybe) modified for s12-c5 | LOW | Same as above — additive section, do not reorder. |
| `src/config/schema.ts` | Modified (add field) | LOW | Field has a default → all existing `bober.config.json` files remain valid. Verify by re-parsing the in-repo `bober.config.json` if present. |
| `src/state/index.ts` | Modified to add `"runs"` to `SUBDIRS` | LOW | Side-effect: `ensureBoberDir` now creates one extra dir; harmless. |
| Anything importing `./checkpoints/index.ts` | Currently only `src/orchestrator/pipeline.ts:35` (verified by `grep -rn "from.*checkpoints" src/`) | LOW | Only one importer — barrel additions are safe. |

### Existing Tests That Must Still Pass
- `src/orchestrator/checkpoints/checkpoints.test.ts` — noop default, registry resolution. Router must NOT break the default noop pathway.
- `src/orchestrator/checkpoints/mechanisms/cli.test.ts`, `disk.test.ts`, `pr.test.ts` — mechanism behavior. Sprint 12 does not touch these; verify they still pass.
- `src/orchestrator/checkpoints/renderers/*.test.ts` (9 files) — renderer outputs. Especially `sprint-contract.test.ts`, `research.test.ts`, `plan.test.ts` if you extend them.
- `src/orchestrator/agent-loader.test.ts`, `model-resolver.test.ts`, `code-reviewer-agent.test.ts` — unrelated; verify unchanged.
- `src/contracts/spec.test.ts`, `src/contracts/sprint-contract.test.ts` — must still pass since spec/contract shapes are unchanged.

### Features That Could Be Affected
- **Sprint 13 — Audit log of approvals/edits** (next sprint, per dependsOn order). Sprint 12's abort/completion markers and edit-original backups are sprint 13's input. Pick file shapes that sprint 13 can extend (e.g., include `runId`, `checkpointId`, `iteration`, `feedback`, `editDelta`).
- **Sprint 14 — config wiring** is already partially live via `getCheckpointMechanismFor`. Sprint 12 must use the `For` variant in pipeline.ts.
- **All existing sprints that pass through the pipeline** — they MUST behave identically when noop is the configured mechanism (always-approved). The router's "approved" path must be a pure pass-through.

### Recommended Regression Checks
After implementation, the Generator MUST verify:
1. `npm run typecheck` exits 0.
2. `npm run lint` exits 0.
3. `npm run test` exits 0 — all prior tests pass, plus new router tests cover the 5 s12-c7 cases.
4. `npm run build` exits 0 (tsc compile, since the CLI bin depends on `dist/`).
5. **Behavioral smoke test** — running the noop mechanism via the existing pipeline must still complete every checkpoint with `{ approved: true }` (no iteration, no abort), and the pipeline result for an existing repo should be byte-identical to pre-sprint-12 for the autopilot default. Verify by inspecting the `checkpoints.test.ts` outputs.
6. The 9 callsites in `pipeline.ts` all use `getCheckpointMechanismFor` (not the plain `getCheckpointMechanism`) — `grep -c "getCheckpointMechanism(" src/orchestrator/pipeline.ts` should be 0; `grep -c "getCheckpointMechanismFor" src/orchestrator/pipeline.ts` should be ≥ 9.
7. The `CHECKPOINT_TO_AGENT` map covers all 9 IDs from `CheckpointId` — add an `assertNever`-style exhaustiveness check, or a unit test that iterates `CHECKPOINT_SITES` and asserts each `site.id` has an entry.
8. `.bober/runs/` directory is created by `ensureBoberDir`.

---

## 8. Implementation Sequence

1. **`src/config/schema.ts`** — add `maxCheckpointIterations: z.number().int().min(1).default(3)` to `PipelineSectionSchema`.
   - Verify: `npm run typecheck` passes.
2. **`src/state/index.ts`** — append `"runs"` to the `SUBDIRS` tuple at line 75.
   - Verify: `npm run typecheck` passes; `ensureBoberDir(<tmp>)` creates `.bober/runs/`.
3. **`src/orchestrator/checkpoints/feedback-router.ts`** (new) — emit:
   - `ResponsibleAgent` union and `CHECKPOINT_TO_AGENT` map (s12-c1 mapping).
   - `RunAbortedReason` type (s12-c2 structured reason).
   - `RouterDecision` discriminated union (`retry | edit-applied | abort`).
   - `routeOutcome(checkpointId, outcome, iteration, ctx)` main function:
     - Handle `!!abort` prefix at the start of `feedback` (s12-c4, case-SENSITIVE — document this choice). Also check `process.env.BOBER_CHECKPOINT_ABORT_TOKEN` and abort if its value (non-empty) is found anywhere in `feedback`.
     - On `outcome.edit === true`: apply the delta to the source file (markdown → full replacement; JSON → full replacement, or JSON-patch if a lib is added). Backup original to `.bober/runs/<runId>/edits/<checkpointId>.original.<ext>` BEFORE write. Return `{ kind: "edit-applied", updatedArtifact }`.
     - On `outcome.approved === false`: if `CHECKPOINT_TO_AGENT[id] === "gate"` → return `{ kind: "abort", reason: { reason: "GATE_REJECTED", ... } }`. Otherwise, if `iteration >= maxCheckpointIterations` → `{ kind: "abort", reason: { reason: "CHECKPOINT_ITERATION_EXHAUSTED", checkpointId, lastFeedback, iterationsCompleted: iteration } }`. Otherwise build the per-agent retry prompt and return `{ kind: "retry", newPrompt, newArtifact? }`.
   - Per-agent strategies as separate functions (s12-c6): `buildPlannerRetryPrompt`, `buildGeneratorRetryPrompt`, `buildResearcherRetryPrompt`, `buildEvaluatorRetryPrompt`. EACH must produce a textually distinct envelope — different section heading, different placement (prepend vs inline-into-generatorNotes vs as-research-question), different framing language. The evaluatorNotes explicitly flag that "if every agent gets identical 'append feedback' treatment, the differentiation is fake."
   - Helper `writeAbortMarker(projectRoot, runId, reason)` and `writeCompletionMarker(projectRoot, runId, summary)` — both use tmp+rename atomic write.
   - Verify: `npm run typecheck` passes.
4. **`src/orchestrator/checkpoints/feedback-router.test.ts`** (new, colocated) — 5+ test groups for s12-c7:
   - (a) `reject → re-invoke with feedback → approve in iteration 2`
   - (b) `reject 3x → abort with CHECKPOINT_ITERATION_EXHAUSTED`
   - (c) `edit delta applied → file updated → backup written → kind === "edit-applied"`
   - (d) `feedback starting with "!!abort" → kind === "abort", reason === "USER_ABORT"` (and the env-var variant)
   - (e) `per-agent adaptation`: assert that the planner retry prompt and the generator retry prompt are DIFFERENT strings (substring-distinct) given identical feedback input
   - Plus: gate checkpoint rejection → abort (not retry); per-checkpoint iteration counters are independent.
   - Verify: `npm run test feedback-router` passes.
5. **`src/orchestrator/checkpoints/renderers/sprint-contract.ts`** (modify) — add `iterationMeta` optional field + "Previous feedback" section (s12-c5).
   - Extend `sprint-contract.test.ts` with a test case verifying the new section appears only at `currentIteration > 1`.
   - Optional: do the same for `renderers/research.ts` and `renderers/plan.ts`. Per s12-c5, only ONE renderer demonstrating the pattern is strictly needed.
   - Verify: `npm run test sprint-contract` passes.
6. **`src/orchestrator/pipeline.ts`** (modify) — at each of the 9 sites:
   - Switch `getCheckpointMechanism("noop")` → `getCheckpointMechanismFor("<id>", config, "noop")`.
   - For agent-iterating checkpoints (`post-research`, `post-plan`, `post-sprint-contract`, `post-sprint`), wrap the call in a `while (true)` loop that:
     - Calls the mechanism;
     - Calls `routeOutcome(...)` with iteration counter;
     - On `retry` → re-invokes the responsible agent (planner / generator / researcher / evaluator), bumps iteration;
     - On `edit-applied` → replaces in-memory artifact, persists to disk via the right save helper (`saveSpec` / `saveContract` / `saveResearch`), breaks the loop;
     - On `abort` → writes `.bober/runs/<runId>.aborted.json`, appends history, returns a graceful PipelineResult with `success: false`.
   - For gate checkpoints (`pre-curator`, `pre-generator`, `pre-evaluator`, `pre-code-reviewer`, `end-of-pipeline`), one call only; on `abort` decision write the abort marker and return.
   - On successful pipeline completion (existing happy path), write `.bober/runs/<runId>.completed.json`.
   - Choose a `runId` — reuse `spec.specId + "-" + Date.now()` or pass through `process.env.BOBER_RUN_ID` if set; document the choice in the JSDoc.
   - Verify: `npm run typecheck` + `npm run build` + manual smoke (`bober run --help` doesn't crash on import).
7. **Run full verification:** `npm run typecheck && npm run lint && npm run test && npm run build`. All four MUST exit 0 (s12-c8).

---

## 9. Pitfalls & Warnings

- **Test path mismatch:** The contract names `tests/orchestrator/checkpoints/feedback-router.test.ts` but `tests/` is NOT the project convention. Use the COLOCATED path `src/orchestrator/checkpoints/feedback-router.test.ts`. Add a comment in the test file's header explaining the override (see `checkpoints.test.ts:1-8` for the precedent comment).
- **pipeline-coordinator.ts does not exist** — the contract references it, but the actual file is `src/orchestrator/pipeline.ts`. Modify that file.
- **`.bober/runs/` does not exist** at the start of the sprint. `ensureBoberDir` must be extended (add `"runs"` to `SUBDIRS` in `src/state/index.ts:75`) before any code attempts to write the abort marker. Calling `writeFile(...)` without first `mkdir`-ing will ENOENT.
- **9 noop call sites must remain semantically identical when `noop` is registered** (s12-c8: existing eval strategies pass). The router's `approved:true` branch must be a no-op pass-through — do not add iteration logic to that branch.
- **No `fast-json-patch` installed.** If you need JSON-patch semantics for edit-delta, choose between: (a) full replacement (recommended for sprint 12 — keeps the dep surface clean); (b) installing `fast-json-patch` explicitly via `npm install fast-json-patch`. Document the choice in the router's JSDoc.
- **Atomic writes are mandatory** for abort/completion markers (evaluatorNotes). Never `writeFile(markerPath, ...)` directly; always `writeFile(tmp, ...)` then `rename(tmp, markerPath)`. POSIX rename is atomic on the same filesystem. Note: `disk.ts:98-102` does NOT do this for its pending file; do NOT use it as a model.
- **Edit-delta REVERSIBILITY** (evaluatorNotes): always back up the original artifact to `.bober/runs/<runId>/edits/<checkpointId>.original.<ext>` BEFORE applying the edit. Without the backup, a user who rejects with `!!abort` immediately after an edit cannot recover the prior state (git history is unreliable for un-committed artifacts).
- **`!!abort` case-sensitivity** must be DOCUMENTED in the code, whichever you choose. The contract description is ambiguous; the evaluatorNotes say "must be CASE-INSENSITIVE or at least documented as case-sensitive." Pick one and write a JSDoc comment + matching test. Recommendation: case-SENSITIVE prefix match (`feedback.startsWith("!!abort")`) — easier to reason about and matches how shell convention markers (`#!`) work.
- **Per-checkpoint iteration counter independence** (evaluatorNotes): a separate `Map<CheckpointId, number>` keyed by checkpoint, not a single counter. A test must explicitly verify that exhausting iteration on `post-sprint` for sprint-1 does NOT pre-exhaust `post-sprint` for sprint-2 (i.e., the counter resets per `(runId, checkpointId, sprintIndex)` tuple, not per `checkpointId` globally — `post-sprint` fires inside the per-sprint loop). Choose your keying scheme carefully and document it.
- **Per-agent adaptation must be REALLY different** (evaluatorNotes): the evaluator will read the router code and verify that the 4 retry-prompt builders are NOT a single `prompt + "\n\n" + feedback` function with a rename. Use different headers, different placement, different language style. Recommended differentiation:
  - **Planner:** prepend a `## Plan revision request (iteration N)` block ABOVE the original user prompt; instruct the planner to update the spec.
  - **Generator:** mutate the in-memory sprint contract by appending the feedback to `generatorNotes`, then re-invoke with the same handoff (the generator already reads `generatorNotes` from the contract).
  - **Researcher:** append a new question to the question list (`"Address the prior reviewer concern: <feedback>"`) and re-invoke ONLY Phase 2; do NOT re-run Phase 1.
  - **Evaluator:** prepend `## Concern from prior round\nPlease specifically check: <feedback>\n\n` to the evaluator handoff issues array.
- **Gate-checkpoint outcomes:** rejection of a gate (`pre-*` and `end-of-pipeline`) MUST abort the run, NOT retry. The `CHECKPOINT_TO_AGENT[id] === "gate"` branch in `routeOutcome` is the single source of truth — there is no agent to re-invoke for these. Test this explicitly.
- **SIGINT interrupt handling** in `pipeline.ts:73-92` uses a module-level `interrupted` flag. The router's retry loop MUST check `interrupted` between iterations, otherwise pressing Ctrl-C during an iterating checkpoint will wait for the full iteration. Mirror the existing pattern at `pipeline.ts:183-186`.
- **Avoid creating a new `pipeline-coordinator.ts`** to "match" the contract's `expectedChanges`. That would split runtime control across two files. Modify `pipeline.ts` in place.
- **Renderer changes are ADDITIVE.** Existing tests assert on exact substring matches; adding a new section after `### Depends on` is safe, but inserting between existing sections or reordering them WILL break tests. Always append.
- **Do not regress autopilot behavior** (s12-c8). The default config (`noop` mechanism) must pass through every checkpoint with `{ approved: true }` and never hit the router's retry/abort branches. Test this by running an existing successful sprint scenario after sprint 12 is in place — output should be identical.
