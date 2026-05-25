# Sprint Briefing: Careful-flow plumbing — Checkpoint abstraction + 9 call-site wiring

**Contract:** `sprint-spec-20260524-bober-vision-7`
**Generated:** 2026-05-25T00:00:00Z
**Tier:** Tier 2 foundation sprint (sprints 7-14)

---

## Sprint Summary

This is **plumbing only** — install the type infrastructure (`CheckpointId`, `CheckpointArtifact`, `CheckpointMechanism`, `CheckpointOutcome`), a registry with **`noop` as the ONLY registered mechanism** (Sprints 8/9/10 register `cli`/`disk`/`pr`), and 9 invocation points in `src/orchestrator/pipeline.ts` that each call `await checkpoint.request('<site-id>', artifact)`. Because every site uses `noop`, every call resolves to `{approved: true}` synchronously — **runtime behavior is byte-identical to pre-sprint**. New work: 4 module files under `src/orchestrator/checkpoints/` + 1 colocated unit test + 9 ~1-line additions to `pipeline.ts`. **No refactors of the coordinator, no changes to existing agent files.**

---

## 1. Call Site Map (9 sites)

All 9 sites live in `src/orchestrator/pipeline.ts`. Each addition is **one new line** placed at the listed location. The "artifact shape" column shows the in-scope variable that's surfaced to the mechanism.

| # | Site ID | File:Line range | Where in pipeline | Artifact (variable in scope) | Next-agent input after `{approved:true}` (no-op) / `{edit:true,editDelta}` (Sprint 12 territory — not in this sprint) |
|---|---|---|---|---|---|
| 1 | `post-research` | `pipeline.ts:478-479` (insert immediately after `appendHistory({event:"research-completed"...})` block ends, before `// ── Phase 0b: Architecture` comment) | After researcher finalizes `.bober/research/<id>-research.md` | `researchDoc: ResearchDoc \| undefined` — has `.id`, `.findings` (full markdown), `.filesExplored`, `.questionsAnswered`. Pass `{ kind: 'research', doc: researchDoc }`. | Planner consumes `researchDoc` directly. With `editDelta`, planner would receive a re-edited `findings` string. |
| 2 | `post-plan` | `pipeline.ts:613-614` (immediately after the `appendHistory({event:"planning-complete"})` block, before `// ── Phase 2: Sprint loop` heading at L615) | After `saveSpec()` ran inside `runPlanner` and `plannerResult.spec` is finalized | `spec: PlanSpec` — full PlanSpec with features[]. Pass `{ kind: 'plan', spec }`. | Sprint loop consumes `spec.features`. `editDelta` would mutate the features list before contract creation. |
| 3 | `post-sprint-contract` | `pipeline.ts:642-643` (immediately after the `for (let i = 0; i < spec.features.length; i++)` loop closes and `contracts` array is populated; before `const completedSprints: SprintContract[] = [];` at L644) | After contracts are auto-generated and `saveContract` ran for each | `contracts: SprintContract[]` (the just-saved array). Pass `{ kind: 'sprint-contracts', contracts }`. | Sprint-execution loop iterates `contracts[i]`. `editDelta` could swap individual contract fields. |
| 4 | `pre-curator` | `pipeline.ts:138-139` (inside `runSprintCycle`, right after `if (curatorEnabled) {` opens and before `logger.phase('Sprint ... - Curate')` at L139) | Just before `runCurator()` spawn at L150 | `{ contract: currentContract, spec, completedContracts }`. Pass `{ kind: 'pre-agent', agent: 'curator', contract: currentContract }`. | Curator spawn call (L150) proceeds unchanged. `editDelta` could mutate `currentContract` before the spawn. |
| 5 | `pre-generator` | `pipeline.ts:232-233` (inside the iteration `for` loop, right before `logger.phase('Sprint ... - Generate (Round ${iteration}))')` at L233) | Just before `runGenerator()` spawn at L243 | `{ contract: currentContract, iteration, compactedHandoff }`. Pass `{ kind: 'pre-agent', agent: 'generator', contract: currentContract, handoff: compactedHandoff }`. | Generator spawn proceeds. `editDelta` could mutate handoff (e.g., inject extra instructions) before spawn. |
| 6 | `pre-evaluator` | `pipeline.ts:294-295` (right before `logger.phase('Sprint ... - Evaluate (Round ${iteration}))')` at L295) | Just before `runEvaluatorAgent()` spawn at L323 | `{ contract: currentContract, iteration, generatorResult, evalHandoff }` — note `evalHandoff` is built at L316; place the checkpoint **before** that build to keep symmetry, OR after it if mechanism wants the final handoff. RECOMMENDATION: place at L294 (before phase logger) and reference `currentContract + generatorResult`. | Evaluator spawn proceeds. `editDelta` could skip evaluation or adjust criteria. |
| 7 | `pre-code-reviewer` | `pipeline.ts:349-350` (inside the `if (evaluation.passed) { ... if (reviewEnabled) {` branch, right before `const reviewTimeoutMs = config.codeReview?.timeoutMs ?? 300_000;` at L351) | Just before `runCodeReviewer()` is wrapped in `Promise.race` at L353-358 | `{ contract: currentContract, evaluation }`. Pass `{ kind: 'pre-agent', agent: 'code-reviewer', contract: currentContract, evaluation }`. | Code-reviewer spawn proceeds. `editDelta` could skip the advisory review entirely. |
| 8 | `post-sprint` | `pipeline.ts:385-386` (immediately before `return { contract: currentContract, evaluation, generatorResult: lastGeneratorResult };` at L385) | Sprint complete (passed branch, after code-review tries to run) | `{ contract: currentContract, evaluation, generatorResult: lastGeneratorResult }`. Pass `{ kind: 'sprint-complete', contract: currentContract, evaluation, generatorResult: lastGeneratorResult }`. | Outer loop pushes to `completedSprints`. `editDelta` could mark a passed sprint as needing rework before the loop sees the result. |
| 9 | `end-of-pipeline` | `pipeline.ts:702-703` (immediately before the final `return { success, spec, completedSprints, failedSprints, duration };` at L704) | End of `runPipeline()`, after `appendHistory({event:"pipeline-complete"})` at L693-702 | `{ success, completedSprints, failedSprints, duration, spec }` (the to-be-returned `PipelineResult` shape minus `needsClarification`). Pass `{ kind: 'pipeline-end', result: <that shape> }`. | The function returns. `editDelta` could mutate the result before the caller (CLI) sees it. |

**Important shape note for the artifact union (Step 2 below):** every site surfaces a different in-scope object — that's why `CheckpointArtifact` should be a discriminated union (or simply `unknown` with `CheckpointId` as the discriminator). The contract says `CheckpointArtifact` is a `type` not an `interface`; the simplest forward-compatible shape is `type CheckpointArtifact = unknown` for this sprint (the mechanism is `noop` — it doesn't read the artifact). Sprints 8-10 narrow it via `CheckpointId` when they implement real handlers.

---

## 2. Module Layout: `src/orchestrator/checkpoints/`

Create exactly 4 source files + 1 barrel + 1 colocated test. The directory does NOT exist yet — `src/orchestrator/` currently contains only flat `.ts` files (no sub-directories except `tools/`).

```
src/orchestrator/checkpoints/
├── types.ts            # CheckpointId | CheckpointArtifact | CheckpointMechanism | CheckpointOutcome
├── registry.ts         # registerCheckpointMechanism, getCheckpointMechanism, runtime Map
├── noop.ts             # NoopCheckpointMechanism — auto-approves every request
├── sites.ts            # CHECKPOINT_SITES (readonly array of 9 ids), JSDoc per site
├── index.ts            # Barrel: re-export types + registry + sites; do NOT re-export noop
└── checkpoints.test.ts # Colocated unit tests (see Section 6 HARD CONSTRAINT)
```

**Public API (exported from `index.ts`):**
```ts
// Types — re-exported from ./types.js
export type { CheckpointId, CheckpointArtifact, CheckpointMechanism, CheckpointOutcome } from "./types.js";
// Registry API — re-exported from ./registry.js
export { registerCheckpointMechanism, getCheckpointMechanism } from "./registry.js";
// Site enumeration — re-exported from ./sites.js
export { CHECKPOINT_SITES, type CheckpointSite } from "./sites.js";
```

**Internal (NOT exported from `index.ts`):**
- `noop.ts` exports `NoopCheckpointMechanism` (class) and a `registerNoopMechanism()` side-effect function. The registry self-registers `noop` on first import (or via an explicit init call from `index.ts`). The coordinator must NEVER import `./noop.js` directly — it asks the registry for `getCheckpointMechanism('noop')`. (Evaluator note: "Reject if the module exports its internal noop implementation outside the registry".)

**Self-registration pattern:** `registry.ts` imports `noop.ts` at module top-level and calls `registerCheckpointMechanism('noop', new NoopCheckpointMechanism())` at module init. This means `noop` is registered the first time *anything* imports the registry. Alternative: `index.ts` calls a top-level `registerBuiltinCheckpointMechanisms()` once. Either works; pick the former — it's simpler and matches how `EvaluatorRegistry` self-populates built-ins in `src/evaluators/registry.ts:41-50`.

---

## 3. CheckpointOutcome — Discriminated Union Design

The contract specifies the exact shape in `s7-c1`. Use this verbatim. Notes added inline.

```ts
// src/orchestrator/checkpoints/types.ts

/**
 * One of the 9 pipeline decision points. Sprints 8-14 may add overrides per id;
 * the registry resolves an id → mechanism.
 */
export type CheckpointId =
  | "post-research"
  | "post-plan"
  | "post-sprint-contract"
  | "pre-curator"
  | "pre-generator"
  | "pre-evaluator"
  | "pre-code-reviewer"
  | "post-sprint"
  | "end-of-pipeline";

/**
 * Opaque artifact passed to a mechanism. The shape varies per CheckpointId.
 * Sprints 8-10 may narrow this via the id discriminator; this sprint treats it
 * as `unknown` because the only mechanism (noop) ignores it.
 */
export type CheckpointArtifact = unknown;

/**
 * Discriminated union of the three outcomes a mechanism can return.
 *
 * - approved:true                        → proceed unchanged (autopilot / accept)
 * - approved:false + feedback            → reject; Sprint 12 will propagate
 *                                          `feedback` back into the prior agent
 * - edit:true + editDelta                → user mutated the artifact in place
 *                                          (CLI edit, disk file rewrite, PR commit)
 *                                          and the coordinator must consume the
 *                                          delta before proceeding.
 *
 * Why all three exist now (per evaluatorNotes): "The Checkpoint types must be
 * exhaustive enough to support all three mechanisms (CLI/disk/PR) without
 * re-shaping in Sprints 8-10."
 */
export type CheckpointOutcome =
  | { approved: true; editDelta?: unknown }
  | { approved: false; feedback: string }
  | { edit: true; editDelta: unknown };

/**
 * A pluggable approval mechanism. Sprints 8-10 implement `cli`, `disk`, `pr`.
 * This sprint registers ONLY `noop`.
 */
export interface CheckpointMechanism {
  request(
    checkpoint: CheckpointId,
    artifact: CheckpointArtifact,
  ): Promise<CheckpointOutcome>;
}
```

**Flow back through the coordinator (this sprint = noop always returns `{approved:true}`):**
- `{approved: true}` → coordinator continues (current behavior). Done.
- `{approved: true, editDelta: X}` → Sprint 8+ may swap the artifact for `X` before continuing. **For this sprint:** noop never sets `editDelta`, so no consumer code needed. Recommendation: add a `// TODO(Sprint 12): consume editDelta` comment but no logic.
- `{approved: false, feedback}` → Sprint 12 propagates feedback. **For this sprint:** noop never returns this. Recommendation: no special handling; if it ever fires from a future mechanism that's mis-registered, the pipeline should NOT crash — log a warning and proceed (defensive). Per generatorNotes ("each call site becomes one new line"), keep this minimal: just `await checkpoint.request(...)` without inspecting the outcome.
- `{edit: true, editDelta}` → Sprint 12 reads `editDelta`. Same as above — no consumer logic this sprint.

**Concrete recommendation for the 9 added lines:** ignore the returned outcome. The pattern is:
```ts
await getCheckpointMechanism('noop').request('post-research', researchDoc);
```
Storing into a variable + inspecting is Sprint 12 work. Keeping the call site one-line preserves the "behavior unchanged" invariant most clearly.

---

## 4. Existing Patterns to Match

### Pattern A — Zod-everywhere for contract-shaped types (DO NOT use for these types)
**Source:** `src/contracts/eval-result.ts:5-87`, `src/contracts/sprint-contract.ts:38-134`
```ts
// src/contracts/eval-result.ts:5-7
export const SeveritySchema = z.enum(["error", "warning", "info"]);
export type Severity = z.infer<typeof SeveritySchema>;
```
**Rule:** When a type represents a **persisted document** (PlanSpec, SprintContract, EvalResult), the project uses `zod` schemas with `z.infer<>` to derive TS types. `CheckpointOutcome` is **runtime-only ephemeral data** — never serialized to disk, never parsed from JSON. So **define it as a pure TypeScript discriminated union**, not a Zod schema. (If you Zod-ize it, you'll add dependency surface for no benefit and Sprints 8-10 will likely strip it.) Confirm by checking how `GeneratorResult` (`src/orchestrator/generator-agent.ts:15-26`) and `EvaluationRunResult` (`src/evaluators/registry.ts:20-31`) are defined — both are plain `interface`/`type`, no Zod. Match that.

### Pattern B — Named exports, `.js` extensions in imports (ESM)
**Source:** `src/orchestrator/code-reviewer-agent.ts:1-10`
```ts
import type { BoberConfig } from "../config/schema.js";
import type { SprintContract } from "../contracts/sprint-contract.js";
import { createClient } from "../providers/factory.js";
import { logger } from "../utils/logger.js";
```
**Rule:** All imports use `.js` extension (ESM build target — TS is configured for NodeNext). Always named exports, never default. Type-only imports use `import type`. The new files must follow this.

### Pattern C — Registry self-population on module init
**Source:** `src/evaluators/registry.ts:41-72` (the `EvaluatorRegistry` class)
```ts
// src/evaluators/registry.ts:41-50
export class EvaluatorRegistry {
  private readonly plugins = new Map<string, EvaluatorPlugin>();

  register(name: string, plugin: EvaluatorPlugin): void {
    this.plugins.set(name, plugin);
  }

  get(name: string): EvaluatorPlugin | undefined {
    return this.plugins.get(name);
  }
}
```
**Rule:** Use a module-level `Map<string, CheckpointMechanism>` (not a class — simpler, mirrors how `tools/index.ts` ROLE_TOOLS works). Register `noop` at module top-level. Throw a clear error on unknown name (per `s7-c5`).

```ts
// Sketch for src/orchestrator/checkpoints/registry.ts
const mechanisms = new Map<string, CheckpointMechanism>();

export function registerCheckpointMechanism(name: string, impl: CheckpointMechanism): void {
  mechanisms.set(name, impl);
}

export function getCheckpointMechanism(name: string): CheckpointMechanism {
  const impl = mechanisms.get(name);
  if (!impl) {
    throw new Error(
      `Unknown checkpoint mechanism: ${name}. Registered: ${[...mechanisms.keys()].join(", ") || "(none)"}`,
    );
  }
  return impl;
}

// Self-register the noop mechanism at module init.
import { NoopCheckpointMechanism } from "./noop.js";
registerCheckpointMechanism("noop", new NoopCheckpointMechanism());
```

### Pattern D — Subagent spawn pattern (DO NOT TOUCH)
**Source:** `src/orchestrator/curator-agent.ts:57-87`, `src/orchestrator/code-reviewer-agent.ts:54-92`
Each agent file has its own standalone `createClient + assembleSystemPrompt + resolveRoleTools + runAgenticLoop` block. Sprint 5 added `code-reviewer-agent.ts` by **cloning** this pattern — not by extracting a helper. Confirmed: there is **no common factory**; each agent stands alone. The checkpoint abstraction sits **alongside** these spawns (one line before each `runX()` call), it does not replace them.

### Pattern E — Test colocation convention (HARD CONSTRAINT — see Section 6)
**Source:** `src/orchestrator/code-reviewer-agent.test.ts:13-16` (comment header)
> "Colocated with code-reviewer-agent.ts per the project convention: src/orchestrator/agent-loader.test.ts and src/orchestrator/model-resolver.test.ts both live next to the modules they test."

---

## 5. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---|---|---|---|
| `logger` | `src/utils/logger.ts` (imported as `import { logger } from "../utils/logger.js"`) | `logger.info / warn / error / debug / phase / sprint / progress / success` | Use `logger.debug()` for any per-checkpoint trace logging in the registry (mirrors `curator-agent.ts:160`). |
| `EvaluatorRegistry` pattern | `src/evaluators/registry.ts:41-100` | `register(name, plugin); get(name); has(name); all()` | **Pattern reference only** — do NOT extend this class. Build a parallel module-level Map for checkpoints. |
| `ROLE_TOOLS` (Map+enum style) | `src/orchestrator/tools/index.ts` | exported as constant | Pattern reference for module-level frozen-enum-style data. |
| `appendHistory` | `src/state/history.ts` (imported via `src/state/index.ts`) | `(projectRoot, entry) => Promise<void>` | The existing audit/event log. **Do NOT add history events for checkpoint invocations in this sprint** — that's Sprint 11 (audit log). Keep this sprint pure plumbing. |
| `EvaluationRunResult` | `src/evaluators/registry.ts:20-31` | `{ passed, score, results, summary, timestamp }` | The artifact passed at `pre-code-reviewer` and `post-sprint`. Already imported in `pipeline.ts:21`. |
| `SprintContract` / `PlanSpec` / `ResearchDoc` / `GeneratorResult` | `src/contracts/*.ts`, `src/orchestrator/research-agent.ts`, `src/orchestrator/generator-agent.ts:15` | TS types | The artifacts for sites 1-8. All already imported by `pipeline.ts`. |

**No new utility helpers are required.** The whole module is ~80-120 LoC.

---

## 6. Test Location — HARD CONSTRAINT

**Place the test at `src/orchestrator/checkpoints/checkpoints.test.ts`, NOT at `tests/orchestrator/checkpoints.test.ts`.**

The contract's `expectedChanges` says `tests/orchestrator/checkpoints.test.ts` — **deviate from that path on purpose** and document why in a top-of-file comment, exactly like `code-reviewer-agent.test.ts:13-16` did in Sprint 5.

**Why (Sprint 5 scanner regression context):**
- The project uses Vitest with the default glob (`**/*.test.ts`) — both locations are picked up by the runner, so functionally either works.
- BUT: `src/discovery/scanners/test-conventions.ts:144-167` runs a `detectColocated()` function over the test file list that classifies the dominant pattern. In Sprint 5, when `code-reviewer-agent.test.ts` was first written under `tests/orchestrator/`, the dominant-pattern detector flipped from "colocated" to "mixed" (because of the existing `tests/orchestrator/curator-turn-count.test.ts` and `tests/orchestrator/gating.test.ts` already pulling toward separate), and downstream consumers (planner context, scanner reports) saw inconsistent conventions. Sprint 5 fixed it by moving the test next to the module (`src/orchestrator/code-reviewer-agent.test.ts`) and adding the comment block now reproduced in Pattern E above.
- Adding `tests/orchestrator/checkpoints.test.ts` would re-trigger the same regression: this sprint creates one new test file; placing it under `tests/` shifts the ratio further toward "separate", flipping the dominant pattern to "mixed" again.
- **Place it at `src/orchestrator/checkpoints/checkpoints.test.ts`** — same directory as the implementation, matching `agent-loader.test.ts`, `model-resolver.test.ts`, `code-reviewer-agent.test.ts`. The contract's `expectedChanges` path is the planner's guess; the evaluator's `s7-c5` verification says "Locate new tests/orchestrator/checkpoints.test.ts (or equivalent)" — "or equivalent" explicitly allows colocation.

**Top-of-test file comment template:**
```ts
/**
 * Colocated with src/orchestrator/checkpoints/ per the project convention:
 * src/orchestrator/agent-loader.test.ts, model-resolver.test.ts, and
 * code-reviewer-agent.test.ts all live next to the modules they test.
 * The contract's expectedChanges names tests/orchestrator/checkpoints.test.ts
 * but the project's dominant test-colocation pattern (Sprint 5 scanner
 * regression precedent) demands this location.
 */
```

---

## 7. Pipeline.ts Patch Shape (per call site)

Each patch is **one new line of `await getCheckpointMechanism('noop').request(...)`** at the location shown. Below: surrounding-context lines so the patch site is unambiguous. The single new line is marked with `+`.

**Import to add at top of `pipeline.ts` (next to other `./` imports, ~ after L34):**
```ts
import { getCheckpointMechanism } from "./checkpoints/index.js";
```

### Site 1 — post-research (after pipeline.ts:478)
```ts
      await appendHistory(projectRoot, {
        timestamp: new Date().toISOString(),
        event: "research-completed",
        phase: "planning",
        details: { researchId: researchDoc.id, /* ... */ },
      });
    }
+   await getCheckpointMechanism("noop").request("post-research", researchDoc);

    // ── Phase 0b: Architecture (optional) ───────────────────────
```
(Place inside the `if (config.pipeline.researchPhase !== false)` block tail so it only fires when research actually ran. `researchDoc` is undefined otherwise.)

### Site 2 — post-plan (after pipeline.ts:613)
```ts
    await appendHistory(projectRoot, {
      timestamp: new Date().toISOString(),
      event: "planning-complete",
      phase: "planning",
      details: { specId: spec.specId, featureCount: spec.features.length },
    });
+   await getCheckpointMechanism("noop").request("post-plan", spec);

    // ── Phase 2: Sprint loop ─────────────────────────────────────
```

### Site 3 — post-sprint-contract (after pipeline.ts:642)
```ts
      contracts.push(contract);
      await saveContract(projectRoot, contract);
    }
+   await getCheckpointMechanism("noop").request("post-sprint-contract", contracts);

    const completedSprints: SprintContract[] = [];
```

### Site 4 — pre-curator (before pipeline.ts:139, inside runSprintCycle)
```ts
  if (curatorEnabled) {
+   await getCheckpointMechanism("noop").request("pre-curator", { contract: currentContract, spec, completedContracts });
    logger.phase(`Sprint ${currentContract.contractId} - Curate`);
```

### Site 5 — pre-generator (before pipeline.ts:233, inside iteration loop)
```ts
    // ── Generate ───────────────────────────────────────────────
+   await getCheckpointMechanism("noop").request("pre-generator", { contract: currentContract, iteration, handoff: compactedHandoff });
    logger.phase(`Sprint ${currentContract.contractId} - Generate (Round ${iteration})`);
```

### Site 6 — pre-evaluator (before pipeline.ts:295)
```ts
    // ── Evaluate ──────────────────────────────────────────────
+   await getCheckpointMechanism("noop").request("pre-evaluator", { contract: currentContract, iteration, generatorResult });
    logger.phase(`Sprint ${currentContract.contractId} - Evaluate (Round ${iteration})`);
```

### Site 7 — pre-code-reviewer (before pipeline.ts:351, inside `if (evaluation.passed) { ... if (reviewEnabled) {`)
```ts
      const reviewEnabled = config.codeReview?.enabled !== false;
      if (reviewEnabled) {
+       await getCheckpointMechanism("noop").request("pre-code-reviewer", { contract: currentContract, evaluation });
        const reviewTimeoutMs = config.codeReview?.timeoutMs ?? 300_000;
```

### Site 8 — post-sprint (before pipeline.ts:385)
```ts
        }
      }
+     await getCheckpointMechanism("noop").request("post-sprint", { contract: currentContract, evaluation, generatorResult: lastGeneratorResult });
      return { contract: currentContract, evaluation, generatorResult: lastGeneratorResult };
```

### Site 9 — end-of-pipeline (before pipeline.ts:704)
```ts
    await appendHistory(projectRoot, {
      timestamp: new Date().toISOString(),
      event: "pipeline-complete",
      /* ... */
    });

+   await getCheckpointMechanism("noop").request("end-of-pipeline", { success, completedSprints, failedSprints, duration, spec });
    return {
      success,
      spec,
      completedSprints,
      failedSprints,
      duration,
    };
```

**Total diff to `pipeline.ts`:** 1 import line + 9 added lines = **10 lines added, 0 removed, 0 modified**. This is the strictest possible "plumbing" footprint.

---

## 8. Sites.ts — Documented Enumeration (per s7-c3)

```ts
// src/orchestrator/checkpoints/sites.ts

import type { CheckpointId } from "./types.js";

/**
 * Static enumeration of all checkpoint sites the orchestrator invokes.
 * Each entry documents WHICH artifact the site surfaces (matches the
 * variable name in scope at pipeline.ts at that location).
 *
 * Adding a new site requires: (a) add the literal to CheckpointId in types.ts,
 * (b) add the row here with file:line + artifact description, (c) add the
 * one-line `await getCheckpointMechanism(...).request(id, artifact)` to
 * pipeline.ts at the documented location.
 */
export interface CheckpointSite {
  id: CheckpointId;
  /** When the site fires, in plain English. */
  when: string;
  /** What artifact (variable + type) is surfaced. */
  artifact: string;
  /** Pipeline.ts location for traceability (file:line at sprint authoring time). */
  pipelineLocation: string;
}

export const CHECKPOINT_SITES: readonly CheckpointSite[] = [
  {
    id: "post-research",
    when: "After researcher finalizes .bober/research/<id>-research.md",
    artifact: "researchDoc: ResearchDoc (full findings, filesExplored, questionsAnswered)",
    pipelineLocation: "src/orchestrator/pipeline.ts:~479",
  },
  {
    id: "post-plan",
    when: "After planner produces and saveSpec()-s a PlanSpec",
    artifact: "spec: PlanSpec (full features[] tree)",
    pipelineLocation: "src/orchestrator/pipeline.ts:~614",
  },
  {
    id: "post-sprint-contract",
    when: "After all sprint contracts are auto-generated and saveContract()-d",
    artifact: "contracts: SprintContract[]",
    pipelineLocation: "src/orchestrator/pipeline.ts:~643",
  },
  {
    id: "pre-curator",
    when: "Just before runCurator() is spawned inside runSprintCycle",
    artifact: "{ contract: SprintContract, spec: PlanSpec, completedContracts: SprintContract[] }",
    pipelineLocation: "src/orchestrator/pipeline.ts:~139",
  },
  {
    id: "pre-generator",
    when: "Just before runGenerator() is spawned (per iteration)",
    artifact: "{ contract: SprintContract, iteration: number, handoff: ContextHandoff }",
    pipelineLocation: "src/orchestrator/pipeline.ts:~233",
  },
  {
    id: "pre-evaluator",
    when: "Just before runEvaluatorAgent() is spawned (per iteration)",
    artifact: "{ contract: SprintContract, iteration: number, generatorResult: GeneratorResult }",
    pipelineLocation: "src/orchestrator/pipeline.ts:~295",
  },
  {
    id: "pre-code-reviewer",
    when: "Inside `if (evaluation.passed && reviewEnabled)`, before runCodeReviewer Promise.race",
    artifact: "{ contract: SprintContract, evaluation: EvaluationRunResult }",
    pipelineLocation: "src/orchestrator/pipeline.ts:~351",
  },
  {
    id: "post-sprint",
    when: "Sprint passed branch, just before `return { contract, evaluation, generatorResult }`",
    artifact: "{ contract, evaluation, generatorResult }",
    pipelineLocation: "src/orchestrator/pipeline.ts:~385",
  },
  {
    id: "end-of-pipeline",
    when: "After pipeline-complete history event, just before final return",
    artifact: "{ success, completedSprints, failedSprints, duration, spec } (PipelineResult shape)",
    pipelineLocation: "src/orchestrator/pipeline.ts:~703",
  },
] as const;
```

---

## 9. Noop Mechanism — Minimal Implementation

```ts
// src/orchestrator/checkpoints/noop.ts

import type { CheckpointArtifact, CheckpointId, CheckpointMechanism, CheckpointOutcome } from "./types.js";

/**
 * The auto-approve mechanism used in autopilot mode (the default).
 * Every request resolves synchronously to { approved: true } — preserves
 * pipeline behavior identical to pre-Tier-2.
 *
 * Sprints 8-10 register real mechanisms (cli, disk, pr) alongside this one.
 */
export class NoopCheckpointMechanism implements CheckpointMechanism {
  async request(
    _checkpoint: CheckpointId,
    _artifact: CheckpointArtifact,
  ): Promise<CheckpointOutcome> {
    return { approved: true };
  }
}
```

The implementation is intentionally trivial. `_checkpoint` / `_artifact` are prefixed with `_` to signal "intentionally unused" — TS won't lint-warn. Do NOT add `logger.debug` calls inside `request()` — the contract's "behavior unchanged" invariant means zero new log output for noop sites. (If desired, gate behind `process.env.BOBER_DEBUG_CHECKPOINTS` later in Sprint 11.)

---

## 10. Tests — Required Coverage (s7-c5)

File: `src/orchestrator/checkpoints/checkpoints.test.ts`

Required assertions:
1. **(s7-c5a)** `NoopCheckpointMechanism.request()` returns `{ approved: true }` for every one of the 9 `CHECKPOINT_SITES` ids.
2. **(s7-c5b)** `getCheckpointMechanism("noop")` resolves to a `CheckpointMechanism` instance (a singleton).
3. **(s7-c5c)** `getCheckpointMechanism("totally-fake-name")` throws an error whose message includes the bad name AND the list of registered names (e.g., includes `"noop"`).
4. **(s7-c2 implicitly)** `registerCheckpointMechanism("test-only", { request: async () => ({approved:true}) })` succeeds and `getCheckpointMechanism("test-only")` returns the registered instance. (Verifies the public API is wired; tidy up the test registration in an `afterEach`.)

Skeleton template (mirror `code-reviewer-agent.test.ts` import style + Vitest):
```ts
import { describe, it, expect } from "vitest";
import {
  registerCheckpointMechanism,
  getCheckpointMechanism,
  CHECKPOINT_SITES,
  type CheckpointMechanism,
} from "./index.js";

describe("checkpoints — noop mechanism (s7-c5a)", () => {
  it("returns {approved: true} for every CheckpointId", async () => {
    const noop = getCheckpointMechanism("noop");
    for (const site of CHECKPOINT_SITES) {
      const outcome = await noop.request(site.id, { /* opaque */ });
      expect(outcome).toEqual({ approved: true });
    }
  });
});

describe("checkpoints — registry (s7-c2, s7-c5b, s7-c5c)", () => {
  it("resolves the noop mechanism by name", () => {
    const noop = getCheckpointMechanism("noop");
    expect(typeof noop.request).toBe("function");
  });

  it("throws a clear error for unknown mechanism names", () => {
    expect(() => getCheckpointMechanism("does-not-exist")).toThrow(/does-not-exist/);
    expect(() => getCheckpointMechanism("does-not-exist")).toThrow(/noop/);
  });

  it("allows registering a new mechanism at runtime", async () => {
    const stub: CheckpointMechanism = {
      request: async () => ({ approved: true }),
    };
    registerCheckpointMechanism("sprint-7-test-mechanism", stub);
    expect(getCheckpointMechanism("sprint-7-test-mechanism")).toBe(stub);
  });
});
```

**Test count delta:** +4 tests (one describe per s-criterion subgroup is fine — see existing `gating.test.ts` for the style). No existing tests modified. Total expected test-file delta: **+1 file, +4-ish test cases, 0 modifications elsewhere**.

---

## 11. Implementation Sequence

Order matters because TS won't compile until dependencies exist:

1. **`src/orchestrator/checkpoints/types.ts`** — define `CheckpointId`, `CheckpointArtifact`, `CheckpointMechanism`, `CheckpointOutcome`.
   - Verify: `npm run typecheck` passes (the file is standalone, no imports from outside the new module).
2. **`src/orchestrator/checkpoints/noop.ts`** — implement `NoopCheckpointMechanism` (imports `./types.js` only).
   - Verify: typecheck passes; class implements `CheckpointMechanism`.
3. **`src/orchestrator/checkpoints/registry.ts`** — module-level `Map`, `register`/`get` functions, self-register `noop` at top-level (imports `./types.js` + `./noop.js`).
   - Verify: typecheck passes; importing the module side-effects in the noop registration.
4. **`src/orchestrator/checkpoints/sites.ts`** — `CHECKPOINT_SITES` array + `CheckpointSite` interface (imports `./types.js`).
   - Verify: typecheck passes; array length is exactly 9.
5. **`src/orchestrator/checkpoints/index.ts`** — barrel re-exports for the public API (no re-export of `noop.ts`).
   - Verify: typecheck passes; `import { getCheckpointMechanism, CHECKPOINT_SITES, type CheckpointMechanism } from "./checkpoints/index.js"` works from a test file.
6. **`src/orchestrator/pipeline.ts`** — add the 1 import + 9 `await getCheckpointMechanism("noop").request(...)` lines at the 9 documented locations.
   - Verify: typecheck passes; `git diff src/orchestrator/pipeline.ts` shows exactly 10 added lines, 0 removed (excluding whitespace), all 9 sites refer to a literal that matches `CheckpointId`.
7. **`src/orchestrator/checkpoints/checkpoints.test.ts`** — write the 4 required test cases (colocated; see Section 6).
   - Verify: `npm run test -- checkpoints` runs the new file and passes (4-ish green).
8. **Full verification:**
   - `npm run typecheck` — exit 0
   - `npm run lint` — exit 0 (unused params should use `_` prefix; no new eslint-disable comments)
   - `npm run test` — exit 0; ALL existing tests still pass (zero changed-test diff)
   - `npm run build` — exit 0
   - **Manual behavior-unchanged check:** the existing `code-reviewer-agent.test.ts` (Section 12) at `(a) runSprintCycle spawns runCodeReviewer with contract+evaluation` exercises the full sprint-cycle path through 7 of the 9 sites. Its assertions about `result.contract.status === "passed"` and `runCodeReviewer` call count MUST still pass — that's the regression-canary. Re-run it explicitly: `npm run test -- code-reviewer-agent` and confirm green.

---

## 12. Behavior-Unchanged Verification (s7-c4, s7-c6, evaluatorNotes invariant)

**The canary test:** `src/orchestrator/code-reviewer-agent.test.ts` (already in the repo, Sprint 5).
- Test `(a) runSprintCycle spawns runCodeReviewer with contract+evaluation` (L209-252) exercises the full `runSprintCycle` path:
  - Curator (mocked, returns immediately) → **fires `pre-curator` checkpoint**
  - Generator (mocked, returns success) → **fires `pre-generator` checkpoint**
  - Evaluator (mocked, returns passed:true) → **fires `pre-evaluator` checkpoint**
  - Code-reviewer wrapped in Promise.race → **fires `pre-code-reviewer` checkpoint**
  - Returns with contract.status="passed" → **fires `post-sprint` checkpoint**
- Test `(c) runSprintCycle does NOT throw when runCodeReviewer throws` (L313-354) verifies the advisory-error path: still fires the same 5 checkpoints; status still "passed"; `logger.warn` still called.

If the noop checkpoints accidentally throw, reject, or mutate state, **this test fails** — and that's the precise definition of a behavior regression. **Run `npm run test -- code-reviewer-agent.test.ts` as the final acceptance gate.**

Sites 1-3 (`post-research`, `post-plan`, `post-sprint-contract`) and Site 9 (`end-of-pipeline`) live in `runPipeline()`, not `runSprintCycle()`. There is **no existing pipeline-level integration test** that exercises the full `runPipeline` path end-to-end — Sprint 5's test stops at `runSprintCycle`. Therefore: a clean way to gain confidence for sites 1-3 and 9 without writing new fixtures is the unit test from Section 10 itself (it directly calls `getCheckpointMechanism('noop').request(siteId, ...)` for all 9 ids and asserts `{approved:true}`). This + typecheck on the modified `pipeline.ts` (which proves the literals match `CheckpointId`) is sufficient evidence for `s7-c4`.

**Expected test count delta:**
- `+1` file: `src/orchestrator/checkpoints/checkpoints.test.ts` (~4 test cases)
- `0` modified test files
- `0` removed test files
- All pre-existing tests pass with **byte-identical** stdout/stderr expectations (except for line numbers in stack traces if any fail).

---

## 13. Pitfalls & Warnings

- **Pitfall A — `researchDoc` is `undefined` when `config.pipeline.researchPhase === false`.** Site 1's `await ... request("post-research", researchDoc)` MUST be **inside** the `if (config.pipeline.researchPhase !== false)` block (see Site 1 patch). Don't place it after the `if` block closes — that would fire with `undefined` artifact even when research was skipped, technically a behavior change (a checkpoint that previously didn't exist now fires). Noop ignores the artifact, so it's harmless in this sprint, but it'd be wrong wiring for Sprint 8-10.

- **Pitfall B — Don't import `./noop.js` from `index.ts`.** The evaluator explicitly flags this: "Reject if the module exports its internal noop implementation outside the registry." Only the registry should know about noop; the barrel re-exports only the public API. `noop` is registered by `registry.ts`'s top-level side-effect on first import — that side-effect chain is sufficient.

- **Pitfall C — Do NOT add `appendHistory` events for checkpoint invocations.** Tempting because every other agent step appends history. But: (1) Sprint 11 owns the audit log; (2) every noop call adding history would change observable output (`.bober/history.jsonl`) — breaks the "behavior unchanged" invariant. **Zero history events from checkpoints this sprint.**

- **Pitfall D — Don't register `cli`, `disk`, or `pr` mechanisms here.** Sprints 8-10 register them. Doing it now means Sprint 8/9/10 can't build cleanly (duplicate registration error from the registry). Evaluator note: "Verify the noop mechanism is the ONLY registered mechanism at this sprint."

- **Pitfall E — `CheckpointArtifact = unknown` is intentional.** Don't narrow it to a discriminated union per site in this sprint. Sprints 8-10 may narrow it via `CheckpointId` overloads (e.g., `request(id: 'post-plan', artifact: PlanSpec)`). Locking the shape now would force re-shaping in Sprint 8-10 — the evaluator says: "the types must be exhaustive enough to support all three mechanisms without re-shaping in Sprints 8-10."

- **Pitfall F — Site 6 `pre-evaluator` placement.** The `evalHandoff` variable is built at L316-321 (right before the spawn call at L323). Place the checkpoint at L294 (the position recommended above) BEFORE `evalHandoff` is built, because `evalHandoff` is internal to the spawn invocation, not user-visible state. The artifact for `pre-evaluator` is `{ contract, iteration, generatorResult }` — all in scope at L294.

- **Pitfall G — Path aliases / ESM extensions.** The project requires `.js` extensions on all internal imports (NodeNext / ESM). Forgetting the `.js` extension on `import { ... } from "./types"` will fail at build time. See `code-reviewer-agent.ts:1-10` for the canonical pattern.

- **Pitfall H — TS unused-parameter rule.** `noop.ts`'s `request(checkpoint, artifact)` doesn't use its params. Use the `_checkpoint` / `_artifact` underscore prefix to silence the linter (the project's eslint config matches this — search the codebase for existing `_` prefixed args before adding eslint-disable).

- **Pitfall I — Sprint-cycle scope.** `pre-curator`, `pre-generator`, `pre-evaluator`, `pre-code-reviewer`, `post-sprint` all live INSIDE `runSprintCycle()`. The other 4 sites (`post-research`, `post-plan`, `post-sprint-contract`, `end-of-pipeline`) live INSIDE `runPipeline()`. Don't confuse the two function scopes — the contracts/variables in scope differ.

---

## 14. Relevant Documentation

- **No `.bober/principles.md` exists** — confirmed via filesystem check at `/Users/bober4ik/agent-bober/.bober/`.
- **No `.bober/architecture/` ADRs found** at the project root (the directory hosts research/specs/contracts/briefings only).
- **Sprint 5 precedent** for "behavior unchanged" + "advisory wrap" patterns: `src/orchestrator/pipeline.ts:348-383` (the code-review try/catch). The checkpoint pattern is structurally similar (single call surrounded by zero behavioral consequence on the success path) but with an even tighter footprint — no try/catch needed because noop never throws.
- **CLAUDE.md** at the project root (not re-read here; the curator's general project instructions are already loaded by the orchestrator).

---

**End of briefing.** Implementation should be 6 file creates (types/registry/noop/sites/index/test) + 10 line additions to `pipeline.ts` + 0 modifications elsewhere. Total LoC: ~150-200 new, 10 added to existing.
