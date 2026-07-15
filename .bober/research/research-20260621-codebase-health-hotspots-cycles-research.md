# Research: Codebase health — top hotspots, real circular dependencies, dead-code candidates

**Research ID:** research-20260621-codebase-health-hotspots-cycles
**Generated:** 2026-06-21T18:40:42Z
**Questions Explored:** 8
**Files Explored:** 11 (+ graph-wide hotspot/circular/dead-code queries)

> Method note: Phase 2 exploration was performed with the tokensave code-graph (per the
> repo's exploration mandate) rather than file-reading subagents. These topics map directly
> to native graph queries (`hotspots`, `circular`, `dead_code`), so findings are graph-derived
> and verified against exact source lines. The graph index was 21h stale at query time
> (1 commit behind — the TDZ-fix commit `a73526c`); all cycle/hotspot claims below were
> re-verified against current source.

---

## Architecture Overview

agent-bober is an ESM-everywhere TypeScript multi-agent harness (`"type": "module"`, `.js`
import specifiers, filesystem-as-state, provider-agnostic LLM seam). The code graph holds
**12,007 nodes / 3,772 edges** across **806 TypeScript source files** (plus 299 compiled JS
and fixtures). Edge mix: 2,630 `calls`, 1,109 `uses`, 33 `implements`.

The connectivity hotspots cluster in the **foundational lower layers** and one
**orchestration hub** — two structurally opposite shapes:

- **Stable abstraction leaves** (high incoming, ~zero outgoing): `BoberConfig`,
  `fileExists`, `LLMClient`, `SprintContract`. Many modules depend *on* them; they depend on
  almost nothing. High reference counts here are expected and healthy — they are the project's
  contracts/utilities.
- **Coordination hub** (high outgoing, ~one incoming): `runSprintCycle` (48 outgoing / 1
  incoming) and `runTsPipeline` (33 outgoing). These fan *out* into the rest of the system.

Two genuine file-level import cycles exist (one type-only, one runtime), plus one false-positive
cycle that is a `dist/` build-output duplicate.

## Existing Patterns

- **`BoberConfig`** — `src/config/schema.ts:451` (`export type BoberConfig = z.infer<typeof
  BoberConfigSchema>`). 56 incoming / 0 outgoing. A Zod-inferred type alias; the single source
  of truth for config shape, consumed pervasively. Matches the "Zod for config validation"
  principle. The schema is composed of optional sub-schemas appended additively over time
  (`medical`, `fleet`, `defaultTeam`, …), which explains the high and growing fan-in.
- **`fileExists`** — `src/utils/fs.ts:9`. A thin async wrapper: `await access(path, R_OK)` →
  `boolean`, swallowing the rejection. 51 incoming / 0 outgoing. Matches "small utility modules"
  + "no synchronous fs ops" principles. High fan-in = legitimate shared leaf utility.
- **`LLMClient`** — `src/providers/types.ts:215`. A single-method interface:
  `chat(params: ChatParams): Promise<ChatResponse>`. 50 incoming. This is the
  provider-agnostic seam mandated by principle ("All LLM interaction goes through
  `providers/types.ts`"). Concrete adapters supply the 33 `implements` edges graph-wide.
- **`runSprintCycle`** — `src/orchestrator/pipeline.ts:157`. `async` orchestration function
  with **7 positional parameters** (`contract, spec, completedContracts, projectRoot, config,
  projectContext, pipelineRunId?`), 48 outgoing / 1 incoming. Drives the generator→evaluator
  retry loop; reads `config.evaluator.maxIterations`, mutates contract status, and dispatches
  across orchestrator/state/provider modules.
- **Cycle-breaking-by-leaf-extraction** (commit `a73526c`) — shared budget constants were
  moved into a dependency-free leaf module `src/fleet/decomposer-deep-constants.ts`
  (0 relative imports, verified). Both cyclic fleet modules now import constants from the leaf
  (`critic-deep.ts:11`, `decomposer-deep.ts:10`) with in-code comments documenting the intent
  ("read budget constants from the dependency-free leaf, NOT from ./decomposer-deep.js";
  "Defined in the dependency-free leaf to avoid the critic-deep module-init TDZ cycle"). This
  removed the module-init-time TDZ but left the function-level mutual recursion intact (see Risk
  Areas).

## Key Files

| Symbol / concern | File:line | Shape |
|---|---|---|
| `BoberConfig` type | `src/config/schema.ts:451` | 56 in / 0 out (stable leaf) |
| `fileExists` | `src/utils/fs.ts:9` | 51 in / 0 out (stable leaf) |
| `LLMClient` interface | `src/providers/types.ts:215` | 50 in / 0 out (stable leaf) |
| `runSprintCycle` | `src/orchestrator/pipeline.ts:157` | 1 in / 48 out (hub) |
| `runTsPipeline` | `src/orchestrator/pipeline.ts:613` | 1 in / 33 out (hub) |
| Cycle 1 member A | `src/orchestrator/memory/fact-judge.ts:16` | type-only import of `reconcile` |
| Cycle 1 member B | `src/orchestrator/memory/reconcile.ts:12` | type-only import of `fact-judge` |
| Cycle 2 member A | `src/fleet/critic-deep.ts:4` | value import `runExpandStage` from `decomposer-deep` |
| Cycle 2 member B | `src/fleet/decomposer-deep.ts:5` | value import `runCritiqueLoop` from `critic-deep` |
| TDZ-fix leaf | `src/fleet/decomposer-deep-constants.ts` | dependency-free (0 relative imports) |

## Integration Points

**Cycle 1 — `orchestrator/memory/fact-judge.ts` ↔ `reconcile.ts` (TYPE-ONLY, both directions):**
- `fact-judge.ts:16` → `import type { ReconcileAction } from "./reconcile.js"`
- `reconcile.ts:12` → `import type { FactJudge } from "./fact-judge.js"`
- Both edges are `import type`. Under the repo's `isolatedModules`/NodeNext config these are
  fully erased at compile time, so **no JavaScript import edge exists at runtime** — there is no
  module-init order dependency and no TDZ exposure. The cycle is a graph/type-layer artifact only.

**Cycle 2 — `fleet/critic-deep.ts` ↔ `decomposer-deep.ts` (VALUE imports, both directions):**
- `critic-deep.ts:4` → `import { type Outline, runExpandStage } from "./decomposer-deep.js"`
  (`runExpandStage` is a runtime value)
- `decomposer-deep.ts:5` → `import { runCritiqueLoop } from "./critic-deep.js"` (runtime value)
- Both directions carry a runtime value import → a genuine runtime import cycle. The two
  functions call each other (critique loop re-invokes expansion; expansion path invokes the
  critique loop) — cross-module mutual recursion. Shared constants were already lifted to the
  dependency-free leaf (`decomposer-deep-constants.ts`) by `a73526c` to remove module-init TDZ.

**Cycle 3 — `dist/fleet/critic-deep.js` ↔ `dist/fleet/decomposer-deep.js` (FALSE POSITIVE):**
- `dist/` is gitignored (`.gitignore:5`). This is the compiled duplicate of Cycle 2, not a
  distinct source cycle. Excludable.

## Test Coverage

Collocated `*.test.ts` (repo convention: tests next to source):

| Module | Collocated test |
|---|---|
| `orchestrator/memory/reconcile.ts` | **yes** — `reconcile.test.ts` (366 lines) |
| `orchestrator/memory/fact-judge.ts` | **no** collocated test (exercised indirectly via reconcile) |
| `fleet/critic-deep.ts` | **yes** — `critic-deep.test.ts` (637 lines) |
| `fleet/decomposer-deep.ts` | **yes** — `decomposer-deep.test.ts` (394 lines) |
| `config/schema.ts` (`BoberConfig`) | **yes** — `schema.test.ts` (255 lines) |
| `utils/fs.ts` (`fileExists`) | **no** collocated test (51-consumer leaf util, untested directly) |
| `providers/types.ts` (`LLMClient`) | **no** collocated test (pure interface — behavior tested via adapter tests) |
| `orchestrator/pipeline.ts` (`runSprintCycle`) | **no** collocated test (covered via e2e/integration suites) |

Both Cycle-2 members are well covered (637 + 394 lines). Both Cycle-1 members are partially
covered (reconcile direct, fact-judge indirect).

## Risk Areas

- **Cycle 1 (fact-judge ↔ reconcile) — benign.** Both edges are `import type`, erased at
  compile; no runtime cycle, no TDZ. Lowest priority. The detector flags it only because it
  counts type-level file edges. It can be silenced by relocating the two shared types into a
  common types module, or left as-is with no runtime consequence.
- **Cycle 2 (critic-deep ↔ decomposer-deep) — live runtime cycle, currently safe.** Both
  directions are value imports (`runExpandStage` ↔ `runCritiqueLoop`). It does not crash today
  only because both functions are invoked lazily (inside function bodies, never at module top
  level), and `a73526c` removed the one module-init-time read (constants) into a leaf. The
  fragility is structural: any future top-level evaluation of either symbol — or moving a shared
  constant back out of `decomposer-deep-constants.ts` — re-introduces the module-init TDZ the
  commit fixed. Fully removing the cycle requires inverting one edge (e.g. injecting
  `runCritiqueLoop` into `runExpandStage` as a parameter) or hoisting the shared orchestration
  into a third module that imports both leaves.
- **`runSprintCycle` fan-out (48 outgoing) + 7 positional params.** High change-amplification
  hub: edits ripple broadly, and the positional 7-arg signature is an evolution pressure point
  (a params object is the common refactor). No collocated unit test — behavior is validated only
  through higher-level suites.
- **`fileExists` — foundational leaf, no direct test.** Pure and low-risk, but 51 call sites
  depend on a util with no collocated coverage.
- **Dead-code report is dominated by false positives.** 1,221 symbols reported, but the bulk are
  **test fixtures/factory helpers** in collocated `*.test.ts` and `tests/` (e.g. `makePending`,
  `seedSpec`, `makeFakeExecutor`, `writeMinimalConfig`) — expected, not removable. Among non-test
  `src/` entries, most are **dynamic-dispatch false positives**: checkpoint **renderers**
  (`renderResearch` `src/.../renderers/research.ts:23`, `renderPlanSpec`, `renderSprintSummary`,
  `renderGeneratorDiff`/`renderGeneratorDiffAsync`) are registered by string key in a renderer
  registry, so the static graph cannot see the dispatch edge; registry lookups (`getRenderer`,
  `getTool`) and entry points (`createBoberMCPServer`, invoked from the bin) are likewise
  unreachable to the graph but live. Symbols genuinely worth a manual caller-check before any
  removal: `stashAndRestore` (`src/utils/git.ts:153`), `saveOutline`
  (`src/state/outline-state.ts:27`), `runPlanAnswerInteractive` (`src/cli/commands/plan.ts:306`),
  `readBriefing` (`src/state/briefing-state.ts:34`), `summarizeSprint`
  (`src/orchestrator/context-handoff.ts:67`). The `dist/` entries are gitignored build output.

---

*Generated by bober.research — factual findings only, no implementation recommendations.*
