# Sprint Briefing: Additive pipeline plumbing + medical team registration

**Contract:** sprint-spec-20260616-medical-team-1
**Generated:** 2026-06-16T18:05:00Z

> Sprint 1 of 7 for Phase 6 (Medical Team). This is PLUMBING + SKELETON ONLY. Add a `medical-sop`
> `PipelineEngineName` member, widen the two Zod enums that mirror it, extend BOTH selector switches
> exhaustively, and create a new `src/medical/` module (types + stub engine + `buildMedicalTeam`) plus a
> registry branch for a built-in `medical` team. HARD requirement: byte-zero impact on `ts|skill|workflow`
> and the programming team. NO gates, store, numerics, ingestion, egress, retrieval, or LLM calls this sprint.

---

## 1. Target Files

### `src/orchestrator/workflow/engine.ts` (modify)

This is the single source of truth for the engine-name union. The whole file (19 lines):

```typescript
// src/orchestrator/workflow/engine.ts:1-18
import type { BoberConfig } from "../../config/schema.js";
import type { PipelineResult } from "../pipeline.js";

// ── Types ──────────────────────────────────────────────────────────

/** Well-known orchestration engine names. Mirrors the z.enum in PipelineSectionSchema. */
export type PipelineEngineName = "ts" | "skill" | "workflow";   // ← add | "medical-sop"

/** Interface every pipeline engine implementation must satisfy. */
export interface PipelineEngine {
  readonly name: PipelineEngineName;
  run(
    userPrompt: string,
    projectRoot: string,
    config: BoberConfig,
    opts?: { runId?: string },
  ): Promise<PipelineResult>;
}
```

**Change:** line 7 → `export type PipelineEngineName = "ts" | "skill" | "workflow" | "medical-sop";`
**Note:** `PipelineEngine` is an INTERFACE (line 10) — `MedicalSopEngine` uses `implements PipelineEngine`, NOT `extends`. The architecture doc's `extends` (architecture.md:52) is shorthand; the contract assumption #1 confirms `implements`.
**Imported by:** `selector.ts:3`, `ts-engine.ts:4`, `workflow-engine.ts:6`, `conformance.ts:6`, `types.ts:7,10` (re-export), `teams/types.ts:9`.
**Test file:** none directly (`engine.ts` is types only); exercised by `selector.test.ts` and `registry.test.ts`.

---

### `src/config/schema.ts` (modify) — TWO Zod enums must be widened in lockstep

There are exactly TWO `z.enum(["ts", "skill", "workflow"])` occurrences (verified by grep):

```typescript
// src/config/schema.ts:219-220  (PipelineSectionSchema.engine)
/** Orchestration engine. 'ts' runs the built-in TypeScript pipeline (default). ... */
engine: z.enum(["ts", "skill", "workflow"]).default("ts"),
```

```typescript
// src/config/schema.ts:360-371  (TeamConfigSchema)
export const TeamConfigSchema = z.object({
  displayName: z.string().optional(),
  memoryNamespace: z.string().regex(/^[a-z0-9_-]+$/i).optional(),
  /** Orchestration engine shape for this team. Mirrors the z.enum in PipelineSectionSchema. */
  pipelineShape: z.enum(["ts", "skill", "workflow"]).optional(),   // ← line 366, add "medical-sop"
  providers: z.record(z.string(), z.string()).optional(),
  roles: z.array(z.object({ name: z.string(), displayName: z.string() })).optional(),
  guardrails: z.unknown().optional(),
});
```

**Change:** widen BOTH `z.enum` arrays to include `"medical-sop"` (line 220 AND line 366). The contract's sc-1-4 and evaluatorNotes explicitly check that the SECOND enum (line 220) is also widened, not just line 366 — DO NOT widen only the team one. The doc comment on `engine.ts:7` and `schema.ts:365` says they mirror each other; keep all three (TS union + 2 Zod enums) in sync.
**`createDefaultConfig`** lives at `schema.ts:427` — DO NOT make it emit any `teams`/`defaultTeam` (back-compat; `registry.test.ts:108-112` asserts both are undefined). Widening the enum does not change the default config.
**Test file:** schema is tested in `src/teams/registry.test.ts` (the `BoberConfigSchema / TeamConfigSchema` block, lines 51-113).

---

### `src/orchestrator/workflow/selector.ts` (modify) — BOTH switches, never-guard intact

`tsconfig.json:22` sets `noFallthroughCasesInSwitch: true` and the union widening makes the switches
non-exhaustive → compile error unless you add a returning `case "medical-sop":`. There is currently NO
`default` clause in either switch (that is what makes them exhaustive over the union).

**Switch 1 — `selectPipelineEngine(config)` (selector.ts:51-64).** This reads `config.pipeline.engine`,
which can never legitimately be `medical-sop`. Add a DEFENSIVE branch that falls through to TS:

```typescript
// src/orchestrator/workflow/selector.ts:51-64 (current)
export function selectPipelineEngine(config: BoberConfig): PipelineEngine {
  const name = resolveEngineName(config);
  switch (name) {
    case "ts":
      return new TsPipelineEngine();
    case "skill":
      return new TsPipelineEngine();
    case "workflow":
      return new WorkflowEngine();
    // ADD: case "medical-sop": return new TsPipelineEngine();  (defensive — config.pipeline.engine is never medical-sop)
  }
}
```

**Switch 2 — `selectPipelineEngineForTeam(team, config)` (selector.ts:103-118).** Add the real branch:

```typescript
// src/orchestrator/workflow/selector.ts:103-118 (current)
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
    // ADD: case "medical-sop": return new MedicalSopEngine();
  }
}
```

**`resolveEngineNameForTeam` (selector.ts:75-93) needs NO change.** It returns `team.pipelineShape`
verbatim (line 79 `const requested = team.pipelineShape;` → line 92 `return requested;`) for every value
except `"workflow"` (only workflow is conditionally downgraded). So `"medical-sop"` flows through unchanged
(contract assumption #2, verified). Same for `resolveEngineName` (selector.ts:23-38) — no change.
**New import to add:** `import { MedicalSopEngine } from "../../medical/engine.js";` (alongside existing `TsPipelineEngine`/`WorkflowEngine` imports at lines 5-6).
**Imported by:** `pipeline.ts:1006` imports `selectPipelineEngineForTeam`; `pipeline.ts:1037` calls `selectPipelineEngineForTeam(team, config).run(...)`.
**Test file:** `src/orchestrator/workflow/selector.test.ts` (exists — see §6).

---

### `src/teams/registry.ts` (modify) — register a built-in `medical` team

Mirror the `buildProgrammingTeam` pattern. Current relevant sections:

```typescript
// src/teams/registry.ts:34-37 (loadTeam dispatch head)
export function loadTeam(config: BoberConfig, teamId?: string): Team {
  if (teamId === undefined || teamId === "programming") {
    return buildProgrammingTeam(config);
  }
  // ADD a branch: if (teamId === "medical") return buildMedicalTeam(config);
  //   ... then the existing config.teams?.[teamId] lookup at line 40
```

```typescript
// src/teams/registry.ts:62-72 (the pattern to mirror)
function buildProgrammingTeam(config: BoberConfig): Team {
  return {
    id: "programming",
    displayName: "Programming team",
    memoryNamespace: "",
    providers: resolveRoleProviders(config),
    pipelineShape: resolveEngineName(config),
    roles: DEFAULT_ROLES,
    guardrails: undefined,
  };
}
```

**Change:** add `if (teamId === "medical") return buildMedicalTeam(config);` to `loadTeam` (after the
`programming` branch, before the `config.teams?.[teamId]` lookup at line 40). Import
`buildMedicalTeam` from `../medical/team.js`. `DEFAULT_ROLES` (registry.ts:17-25) is the 7-role array — the
medical team reuses it (the contract's generatorNotes say `roles: <descriptors>`; reuse `DEFAULT_ROLES`).
**`buildMedicalTeam`** itself lives in `src/medical/team.ts` (see §1 create), NOT in registry.ts — registry only wires the dispatch.
**Imported by:** `cli/commands/chat.ts:19`, `cli/commands/memory.ts:35`, `cli/commands/facts.ts:19`, `pipeline.ts:1007`.
**Test file:** `src/teams/registry.test.ts` (exists — add medical-team assertions or rely on `src/medical/team.test.ts`).

---

### `src/medical/types.ts` (create)

**Directory pattern:** `src/medical/` does not exist yet. Follow sibling module conventions
(`src/teams/types.ts`, `src/orchestrator/workflow/types.ts`): kebab-case-free single-word file names
(`types.ts`, `engine.ts`, `team.ts`), unicode box-drawing section headers (principles.md:32 —
`// ── Section ──────`), `import type` for type-only imports (consistent-type-imports is enforced,
principles.md:35), `.js` extensions on all relative imports (NodeNext).
**Most similar existing file:** `src/teams/types.ts` (pure data types, no logic).
**Structure template** (define the GuardrailSet type family + shared medical types per architecture Data Model, architecture.md:183-238):

```typescript
// src/medical/types.ts (skeleton — NO LLM/SDK imports)

// ── Guardrail verdict ───────────────────────────────────────────────
export type GuardrailVerdict =
  | { kind: "allow" }
  | { kind: "short-circuit"; rule: string; cannedResponse: string }
  | { kind: "refuse"; rule: string; reason: string };

// ── Guardrail context + set ─────────────────────────────────────────
export interface GuardrailContext {
  /* placeholder — real fields land in S3 */
}

export interface GuardrailSet {
  evaluate(prompt: string, ctx: GuardrailContext): GuardrailVerdict;
  readonly rulesetVersion: string;
}

// ── Medical answer (shape only; engine returns PipelineResult this sprint) ──
export interface Citation { /* placeholder for S7 */ }
export interface MedicalAnswer {
  body: string;
  abstained: boolean;
  citations: Citation[];
  disclaimerFooter: string;
  shortCircuit: boolean;
}
```

Then a trivial GuardrailSet implementation (either here or in team.ts) that returns `{ kind: "allow" }`
and carries a `rulesetVersion` string — real logic is S3 (nonGoals, contract line 64). The GuardrailVerdict
union MUST match architecture.md:219-222 exactly (3 variants: allow / short-circuit / refuse).

---

### `src/medical/engine.ts` (create) — MedicalSopEngine stub

**Most similar existing file:** `src/orchestrator/workflow/ts-engine.ts` (the simplest `implements PipelineEngine`).
**Structure template:**

```typescript
// src/medical/engine.ts (stub — zero LLM calls, zero SDK imports)
import type { BoberConfig } from "../config/schema.js";
import type { PipelineResult } from "../orchestrator/pipeline.js";
import type { PipelineEngine, PipelineEngineName } from "../orchestrator/workflow/engine.js";
import { createSpec } from "../contracts/spec.js"; // OR hand-build a PlanSpec

export class MedicalSopEngine implements PipelineEngine {
  readonly name: PipelineEngineName = "medical-sop";

  async run(
    _userPrompt: string,
    _projectRoot: string,
    _config: BoberConfig,
    _opts?: { runId?: string },
  ): Promise<PipelineResult> {
    // Stub: trivial placeholder result. Real SOP (gates/numerics/retrieval) lands in S2/S3/S6.
    return { success: true, spec: <PlanSpec>, completedSprints: [], failedSprints: [], duration: 0 };
  }
}
```

**`PipelineResult` required fields (pipeline.ts:67-81):** `success: boolean`, `spec: PlanSpec`,
`completedSprints: SprintContract[]`, `failedSprints: SprintContract[]`, `duration: number`. Optional:
`totalCost?`, `needsClarification?`. The `spec` field is mandatory — use `createSpec(title, description, [])`
from `src/contracts/spec.ts:189` to build a minimal valid `PlanSpec` (it fills all defaults and timestamps),
OR construct one inline. Mark unused params with the `_` prefix (principles.md:36; ESLint errors otherwise).
**Use `readonly name: PipelineEngineName = "medical-sop"`** — note `ts-engine.ts:14` uses this exact form
(not `as const`); follow it so the type matches the interface.

---

### `src/medical/team.ts` (create) — buildMedicalTeam

**Most similar existing file:** `buildProgrammingTeam` in `src/teams/registry.ts:62-72`.
**Structure template:**

```typescript
// src/medical/team.ts
import type { BoberConfig } from "../config/schema.js";
import { resolveRoleProviders } from "../config/role-providers.js";
import type { Team } from "../teams/types.js";
import type { GuardrailSet, GuardrailVerdict, GuardrailContext } from "./types.js";

// ── Built-in medical guardrails (stub allow-all; real logic S3) ─────
const MEDICAL_RULESET_VERSION = "0.0.0";
function buildMedicalGuardrails(): GuardrailSet {
  return {
    rulesetVersion: MEDICAL_RULESET_VERSION,
    evaluate(_prompt: string, _ctx: GuardrailContext): GuardrailVerdict {
      return { kind: "allow" };
    },
  };
}

// ── buildMedicalTeam ────────────────────────────────────────────────
export function buildMedicalTeam(config: BoberConfig): Team {
  return {
    id: "medical",
    displayName: "Medical team",
    memoryNamespace: "medical",
    providers: resolveRoleProviders(config),
    pipelineShape: "medical-sop",
    roles: /* reuse the 7-role descriptors — see note */,
    guardrails: buildMedicalGuardrails(),
  };
}
```

**Roles note:** `DEFAULT_ROLES` is currently a non-exported `const` in `registry.ts:17`. Either (a) export it
from registry.ts and import it into team.ts, OR (b) inline the 7 `Role` descriptors in team.ts. Option (a) is
DRYer and the contract's generatorNotes leave it open (`roles: <descriptors>`). If exporting, add `export`
to `const DEFAULT_ROLES` at registry.ts:17 and import `{ DEFAULT_ROLES }` — this is additive and safe.
**`guardrails` slot is `?: unknown`** today (`teams/types.ts:29`); assigning a concrete `GuardrailSet` is
type-compatible (unknown accepts anything). DO NOT change the `Team.guardrails` field type — keep it
`?: unknown` so other teams' `undefined` stays valid (contract assumption #4). sc-1-6 only requires the
runtime object exposes `rulesetVersion` + `evaluate`.

---

### `src/medical/engine.test.ts` + `src/medical/team.test.ts` (create)

Collocated `*.test.ts` next to source (principles.md:20). See §6 for the exact vitest patterns to mirror.

---

## 2. Patterns to Follow

### Pattern: `implements PipelineEngine` with `readonly name`
**Source:** `src/orchestrator/workflow/ts-engine.ts:13-24`
```typescript
export class TsPipelineEngine implements PipelineEngine {
  readonly name: PipelineEngineName = "ts";
  run(userPrompt, projectRoot, config, opts?): Promise<PipelineResult> {
    return runTsPipeline(userPrompt, projectRoot, config, opts);
  }
}
```
**Rule:** MedicalSopEngine uses `implements PipelineEngine`, declares `readonly name: PipelineEngineName = "medical-sop"`, and matches the frozen `run(userPrompt, projectRoot, config, opts?)` signature.

### Pattern: exhaustive switch with no default (never-guard via noFallthroughCasesInSwitch)
**Source:** `src/orchestrator/workflow/selector.ts:53-63` and `108-117`
```typescript
switch (name) {
  case "ts":       return new TsPipelineEngine();
  case "skill":    return new TsPipelineEngine();
  case "workflow": return new WorkflowEngine();
}
```
**Rule:** Each case `return`s (no fallthrough). Adding the union member without a returning case is a compile error — add `case "medical-sop": return ...;` to BOTH switches. Do NOT add a `default:`; the lack of default is what enforces exhaustiveness.

### Pattern: built-in team builder
**Source:** `src/teams/registry.ts:62-72` (`buildProgrammingTeam`)
**Rule:** A built-in team is a plain object literal returned from a `buildXxxTeam(config)` function: `id`, `displayName`, `memoryNamespace`, `providers: resolveRoleProviders(config)`, `pipelineShape`, `roles`, `guardrails`. `loadTeam` dispatches to it by id BEFORE the `config.teams` lookup.

### Pattern: discriminated-union result type
**Source:** architecture.md:219-222 (Data Model) — `GuardrailVerdict`
**Rule:** Use a `kind`-discriminated union (`{ kind: "allow" } | { kind: "short-circuit"; ... } | { kind: "refuse"; ... }`). Matches the codebase's `RetrievalOutcome`-style unions and Zod-friendly literals.

### Pattern: section headers + `.js` extensions + `import type`
**Source:** `src/teams/types.ts:1-30`, principles.md:27,32,35
```typescript
import type { PipelineEngineName } from "../orchestrator/workflow/engine.js";
// ── Team ─────────────────────────────────────────────────────────────
export interface Team { /* ... */ }
```
**Rule:** All relative imports end in `.js` (NodeNext). Type-only imports use `import type`. Use unicode box-drawing `// ── ... ──` section headers in every new file.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `resolveRoleProviders` | `src/config/role-providers.ts:97` | `(config: BoberConfig): RoleProviderMap` | Resolves the role→provider map; use VERBATIM in `buildMedicalTeam` (same as programming team) |
| `resolveEngineName` | `src/orchestrator/workflow/selector.ts:23` | `(config: BoberConfig): PipelineEngineName` | Pure engine-name resolver for config path — DO NOT touch |
| `resolveEngineNameForTeam` | `src/orchestrator/workflow/selector.ts:75` | `(team: Team, config: BoberConfig): PipelineEngineName` | Returns `team.pipelineShape` verbatim except downgrades `workflow` — medical-sop passes through, NO change |
| `loadTeam` | `src/teams/registry.ts:34` | `(config: BoberConfig, teamId?: string): Team` | Team resolver — add a `medical` dispatch branch |
| `createSpec` | `src/contracts/spec.ts:189` | `(title, description, features[], options?): PlanSpec` | Build a minimal valid `PlanSpec` for the stub `PipelineResult.spec` |
| `TsPipelineEngine` | `src/orchestrator/workflow/ts-engine.ts:13` | `class implements PipelineEngine` | The `implements PipelineEngine` template; defensive return in switch 1 |
| `WorkflowEngine` | `src/orchestrator/workflow/workflow-engine.ts:32` | `class implements PipelineEngine` | Existing engine in switch 2 — leave untouched |
| `DEFAULT_ROLES` | `src/teams/registry.ts:17` | `const Role[]` (currently NOT exported) | The 7 role descriptors; export + reuse for the medical team, or inline |
| `RoleProviderMap` / `RoleName` | `src/config/role-providers.ts:10,19` | `type` | Provider/role typing for the Team |
| `Team` / `Role` | `src/teams/types.ts:14,21` | `interface` | The Team data model the new team must satisfy |
| `PipelineResult` | `src/orchestrator/pipeline.ts:67` | `interface` | Stub engine return type — required fields: success, spec, completedSprints, failedSprints, duration |
| `logger` | `src/utils/logger.ts` | `{ info, warn, error, debug, success }` | Logging (NOT needed in the stub; engine makes no log/LLM calls) |

Utilities reviewed: `src/config/`, `src/orchestrator/workflow/`, `src/teams/`, `src/utils/`, `src/contracts/`. No `src/lib`, `src/helpers`, `src/shared`, or `src/common` directories exist in this tree.

---

## 4. Prior Sprint Output

No prior sprints in THIS spec (`dependsOn: []`). The relevant prior work is the merged Team abstraction (Phase 4):

### Phase 4 — domain-agnostic Team abstraction (on main)
**Provides:** `Team`/`Role` (`src/teams/types.ts`), `loadTeam` + `buildProgrammingTeam` (`src/teams/registry.ts`), `TeamConfigSchema` + `teams`/`defaultTeam` config keys (`src/config/schema.ts:361-403`), `selectPipelineEngineForTeam` + `resolveEngineNameForTeam` (`src/orchestrator/workflow/selector.ts:75-118`), and `runPipeline(opts.teamId)` wiring (`src/orchestrator/pipeline.ts:1018-1038`).
**Connection to this sprint:** the medical team is the SECOND built-in team — it extends exactly the seams Phase 4 left open: the `pipelineShape` enum, both selector switches, the `Team.guardrails` slot, and the `loadTeam` dispatch. Do NOT introduce a new abstraction; reuse `Team`/`loadTeam`/`selectPipelineEngineForTeam` as-is.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM/NodeNext:** all relative imports use `.js` extensions; no CommonJS (line 27).
- **Provider-agnostic:** NEVER import `@anthropic-ai/sdk` or `openai` outside `providers/` adapters (lines 28, 41) — directly relevant to sc-1-8 (no SDK under `src/medical`).
- **Zod for config:** all config schemas in `config/schema.ts`; runtime via `z.parse()` (line 29).
- **Section comments:** unicode box-drawing headers `// ── Name ──` (line 32).
- **Small single-purpose modules** (line 33) — split `src/medical/` into `types.ts` / `engine.ts` / `team.ts`.
- **`import type`** enforced by `consistent-type-imports` (line 35); **`_`-prefix** unused params (line 36).
- **Collocated tests** `*.test.ts` next to source (line 20); **Vitest** (line 20).
- **No `any` without justification** — prefer `unknown` + narrowing (line 40).
- **No sync fs** — `node:fs/promises` only (line 42); the stub touches NO fs anyway (tests must be pure).

### Architecture Decisions (`.bober/architecture/arch-20260616-medical-team-*`)
- **ADR-1** (`adr-1.md`): medical team is a NEW `medical-sop` pipelineShape + concrete GuardrailSet in `Team.guardrails`, in-process numerics, opt-in egress. Consequence (adr-1.md:17): `PipelineEngineName` (engine.ts:7), the `pipelineShape` Zod enum (schema.ts:366), and `selectPipelineEngineForTeam` (selector.ts:103-118) each gain ONE additive branch; existing `ts|skill|workflow` + programming team stay byte-identical. THIS sprint executes exactly that additive change.
- **architecture.md:51-56**: `MedicalSopEngine` shape (`readonly name: "medical-sop"`, `run(...): Promise<PipelineResult>`). The doc's `extends PipelineEngine` is shorthand — use `implements` (contract assumption #1).
- **architecture.md:62-66**: `GuardrailSet { evaluate(prompt, ctx): GuardrailVerdict; readonly rulesetVersion: string }` — define the TYPE only this sprint (real evaluate logic is S3, nonGoals line 64).
- **architecture.md:172-177**: `buildMedicalTeam(config): MedicalTeam` with `pipelineShape: "medical-sop"`.
- **architecture.md:183-238 (Data Model)**: `GuardrailVerdict` (3-variant union), `MedicalAnswer`, etc. — define the TYPES; do not implement behavior.
- **ADR-2/3/4/5/6/7**: red-flag gate, numerics whitelist, health store, chat-spawn, egress axes, FactStore meds — ALL deferred to S2-S7. Out of scope this sprint.

### Other Docs (`docs/teams.md`)
- `docs/teams.md:14-23` documents the 3 team axes (providers / memoryNamespace / pipelineShape) and that the built-in programming team is always available. The `pipelineShape` table (line 19) currently lists only `ts|skill|workflow` — this sprint adds a code-registered `medical` team (NOT a config-declared one), so docs need not change to pass gates (doc update can be a later sprint). `docs/teams.md:179` describes the `loadTeam` dispatch order you are extending.

---

## 6. Testing Patterns

### Unit Test Pattern — selector tests
**Source:** `src/orchestrator/workflow/selector.test.ts:1-44`
```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../utils/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));
vi.mock("./eligibility.js", () => ({ isWorkflowEligible: vi.fn(() => false) }));

import { selectPipelineEngineForTeam, selectPipelineEngine } from "./selector.js";
import { loadTeam } from "../../teams/registry.js";
import { createDefaultConfig } from "../../config/schema.js";
import { TsPipelineEngine } from "./ts-engine.js";

it("programming team with engine 'ts' selects TsPipelineEngine", () => {
  const config = createDefaultConfig("test", "greenfield");
  const team = loadTeam(config);          // load BEFORE clearing mocks
  vi.clearAllMocks();
  const engine = selectPipelineEngineForTeam(team, config);
  expect(engine).toBeInstanceOf(TsPipelineEngine);
});
```
**Tests to add (in `src/medical/engine.test.ts` and/or selector.test.ts):**
- `selectPipelineEngineForTeam(buildMedicalTeam(config), config)` is `instanceof MedicalSopEngine` AND `.name === "medical-sop"` (sc-1-5).
- `selectPipelineEngine(config)` for engine `'ts'`/`'workflow'` returns the SAME engine class as before — regression (sc-1-7). Mock `isWorkflowEligible` to toggle the workflow path.

### Unit Test Pattern — registry / schema tests
**Source:** `src/teams/registry.test.ts:1-32`
```typescript
import { describe, it, expect, vi } from "vitest";
import { loadTeam } from "./registry.js";
import { resolveRoleProviders } from "../config/role-providers.js";
import { resolveEngineName } from "../orchestrator/workflow/selector.js";
import { createDefaultConfig, BoberConfigSchema, TeamConfigSchema } from "../config/schema.js";

vi.mock("../utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

it("returns programming team unchanged (regression)", () => {
  const config = createDefaultConfig("test", "greenfield");
  const team = loadTeam(config);
  expect(team.id).toBe("programming");
  expect(team.providers).toEqual(resolveRoleProviders(config));   // deep-equal
  expect(team.pipelineShape).toBe(resolveEngineName(config));
  expect(team.memoryNamespace).toBe("");
});
```
**Tests to add (in `src/medical/team.test.ts`):**
- `loadTeam(config, "medical")` → `id === "medical"`, `pipelineShape === "medical-sop"`, `guardrails` is a non-undefined object exposing `rulesetVersion` (string) and `evaluate` (function) (sc-1-6).
- `loadTeam(config)` (no id) still deep-equals the programming team: `providers` deep-equal `resolveRoleProviders(config)`, `pipelineShape === resolveEngineName(config)`, `memoryNamespace === ""` (sc-1-7 regression).
- Zod: `TeamConfigSchema.safeParse({ pipelineShape: "medical-sop" }).success === true` AND `{ pipelineShape: "bogus" }.success === false` (sc-1-4). Confirms the team enum widened.
- Zod: a config with `pipeline.engine: "medical-sop"`... NOT required — but the evaluator checks the SECOND enum (schema.ts:220) widened, so a `PipelineSectionSchema` parse of `{ engine: "medical-sop" }` succeeding is a good assertion.

**Runner:** vitest. **Assertion style:** `expect(...).toBe/.toEqual/.toBeInstanceOf`. **Mock approach:** `vi.mock(...)` (always mock `../utils/logger.js` since `resolveRoleProviders` logs 7 lines/call — see registry.test.ts:9). **File naming:** `<name>.test.ts`. **Location:** collocated next to source. **No vitest.config.* file** — config is in `package.json`/`vite`-default; tests run via `npm run test`.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/orchestrator/workflow/selector.ts` | `engine.ts` (`PipelineEngineName`) | high | The two switches go non-exhaustive on union widening → compile error UNLESS both gain a returning `medical-sop` case. This is the linchpin. |
| `src/orchestrator/workflow/ts-engine.ts:14` | `PipelineEngineName` | low | `readonly name: PipelineEngineName = "ts"` still valid (widening a union never invalidates a narrower literal). No change. |
| `src/orchestrator/workflow/workflow-engine.ts:33` | `PipelineEngineName` | low | Same — `"workflow"` still assignable. No change. |
| `src/orchestrator/workflow/conformance.ts:77,79` | `PipelineEngineName[]` | low | Uses the union as an array param type, NO exhaustive switch — widening is safe. No change. |
| `src/orchestrator/workflow/types.ts:10,63` | re-exports `PipelineEngineName` | low | `export type { PipelineEngineName }` re-export auto-includes the new member (`isolatedModules` is fine with `export type`). No change. |
| `src/teams/types.ts:27` | `PipelineEngineName` | low | `pipelineShape: PipelineEngineName` auto-accepts `"medical-sop"`. No change. |
| `src/teams/registry.ts:34` | `loadTeam` callers below | medium | Adding the `medical` dispatch branch must NOT change the `undefined`/`"programming"`/unknown-id paths. Keep the order: programming → medical → config lookup → throw. |
| `src/cli/commands/{chat,memory,facts}.ts` | `loadTeam` | low | They call `loadTeam(config, undefined)`/`loadTeam(config, team)`. New `medical` branch is additive; existing calls unaffected. Verify no path now routes a CLI call into the stub unexpectedly. |
| `src/orchestrator/pipeline.ts:1037` | `selectPipelineEngineForTeam` | medium | For a `medical` team this now returns `MedicalSopEngine`; for programming/ts/skill/workflow it is byte-identical. The stub `.run()` returns a trivial result — ensure no production path invokes it this sprint (no default team is `medical`). |

### Existing Tests That Must Still Pass
- `src/orchestrator/workflow/selector.test.ts` — covers `resolveEngineName`, `selectPipelineEngine`, `selectPipelineEngineForTeam` for ts/skill/workflow + programming-team equivalence. Adding the `medical-sop` cases MUST leave these green (the new case is unreachable for these tests).
- `src/teams/registry.test.ts` — covers `loadTeam` programming/declared/unknown-id + schema parse. The new `medical` branch + enum widening must not break the existing `pipelineShape: "ts"` parse or the "rejects bogus" expectations (there is currently no negative-enum test, so widening is safe).
- `src/orchestrator/workflow/conformance.test.ts`, `workflow-engine.test.ts` — exercise `PipelineEngineName`; verify they still typecheck/pass (they don't switch exhaustively on the union).
- The FULL suite (~2300+ tests per project memory) must remain green — run `npm run test`.

### Features That Could Be Affected
- **Programming team / `runPipeline`** — shares `loadTeam`, `selectPipelineEngineForTeam`, `selector.ts`. Verify byte-identical behavior: `loadTeam(config)` deep-equals the programming team; `selectPipelineEngine(config)` for ts/workflow returns the same class. This is sc-1-7 and a HARD requirement.
- **`workflow` engine path** — shares both selector switches. Verify the `workflow` branch (eligible vs downgrade) is untouched (the `medical-sop` defensive case in switch 1 must NOT alter workflow/ts/skill returns).
- **CLI `bober chat` / `memory` / `facts`** — share `loadTeam`. Verify the new `medical` id resolves but no existing invocation changes.

### Recommended Regression Checks
1. `npm run typecheck` — confirms BOTH switches stay exhaustive with the `never` guard intact (a missing case is a compile error here).
2. `npm run build` — clean tsc output (sc-1-1, sc-1-2).
3. `npm run test` — full suite green, including the new `src/medical/*.test.ts` (sc-1-3).
4. `grep -rn "@anthropic-ai/sdk\|from \"openai\"\|from 'openai'" src/medical` → must return NOTHING (sc-1-8).
5. Manually confirm `selectPipelineEngine(config)` for engine `'ts'`/`'skill'`/`'workflow'` returns the same engine classes as before (the defensive `medical-sop` case must not be reachable on the config path).

---

## 8. Implementation Sequence

1. **`src/medical/types.ts`** (create) — define `GuardrailVerdict`, `GuardrailContext`, `GuardrailSet`, `MedicalAnswer`, `Citation`. No imports beyond standalone types. Pure.
   - Verify: `npm run typecheck` compiles the new file in isolation.
2. **`src/orchestrator/workflow/engine.ts`** (modify) — add `| "medical-sop"` to `PipelineEngineName` (line 7).
   - Verify: typecheck — the two selector switches now ERROR (non-exhaustive). This error is expected and proves exhaustiveness; fix in step 4.
3. **`src/config/schema.ts`** (modify) — widen BOTH `z.enum(["ts","skill","workflow"])` to add `"medical-sop"` (line 220 AND line 366). Leave `createDefaultConfig` (line 427) emitting no teams.
   - Verify: `TeamConfigSchema.safeParse({ pipelineShape: "medical-sop" }).success === true`.
4. **`src/medical/engine.ts`** (create) — `MedicalSopEngine implements PipelineEngine`, `readonly name = "medical-sop"`, stub `run` returning a minimal `PipelineResult` (use `createSpec` for `spec`). No LLM/SDK imports.
   - Verify: class typechecks against the `PipelineEngine` interface.
5. **`src/orchestrator/workflow/selector.ts`** (modify) — import `MedicalSopEngine`; add `case "medical-sop": return new MedicalSopEngine();` to `selectPipelineEngineForTeam` (switch 2) and `case "medical-sop": return new TsPipelineEngine();` (defensive) to `selectPipelineEngine` (switch 1). No `default:` clause.
   - Verify: typecheck clean — both switches exhaustive again; ts/skill/workflow returns unchanged.
6. **`src/medical/team.ts`** (create) — `buildMedicalTeam(config): Team` with `pipelineShape: "medical-sop"`, `providers: resolveRoleProviders(config)`, `guardrails: <GuardrailSet>`, reusing role descriptors. Stub guardrails return `{ kind: "allow" }`.
   - Verify: returns a `Team`; `pipelineShape === "medical-sop"`; `guardrails.rulesetVersion` is a string.
7. **`src/teams/registry.ts`** (modify) — add `if (teamId === "medical") return buildMedicalTeam(config);` after the programming branch (before line 40). If reusing `DEFAULT_ROLES`, add `export` to it (line 17).
   - Verify: `loadTeam(config, "medical").id === "medical"`; `loadTeam(config)` still returns programming team.
8. **`src/medical/engine.test.ts`** (create) — assert `MedicalSopEngine.name === "medical-sop"`, `instanceof` via `selectPipelineEngineForTeam`, and stub `run` resolves to a `PipelineResult` with `success` + `spec`. Mock logger; no fs/network.
   - Verify: tests pass.
9. **`src/medical/team.test.ts`** (create) — assert `loadTeam(config, "medical")` fields (sc-1-6); programming-team regression deep-equal (sc-1-7); Zod parse of `pipelineShape: "medical-sop"` succeeds and `"bogus"` fails (sc-1-4). Mock logger.
   - Verify: tests pass.
10. **Run full verification** — `npm run build`, `npm run typecheck`, `npm run test`; then `grep -rn "@anthropic-ai/sdk\|openai" src/medical` returns nothing (sc-1-8).

---

## 9. Pitfalls & Warnings

- **TWO Zod enums, not one.** The contract title says "schema.ts:366" but the evaluatorNotes (sc-1-4) AND `engine.ts:7`'s doc comment require widening the OTHER enum at `schema.ts:220` (`PipelineSectionSchema.engine`) too. Widen BOTH or the evaluator fails.
- **`noFallthroughCasesInSwitch: true` (tsconfig.json:22) + no `default:`** is the exhaustiveness mechanism. Adding the union member without a returning case in EACH switch is a compile error. Do NOT add a `default:` clause to "fix" it — that would silently absorb future members and defeat the never-guard. Add an explicit `case "medical-sop": return ...;` to both.
- **Switch 1 (`selectPipelineEngine`) gets a DEFENSIVE branch only.** `config.pipeline.engine` can never legitimately be `medical-sop` (it is the programming/config path). Return `new TsPipelineEngine()` there so the switch stays exhaustive WITHOUT changing any real programming behavior. Do NOT return `MedicalSopEngine` from switch 1.
- **`resolveEngineNameForTeam` and `resolveEngineName` need NO edit.** They return the requested value verbatim except for the `workflow` downgrade. Touching them risks the byte-identical regression (sc-1-7). Leave them alone.
- **`implements`, not `extends`.** `PipelineEngine` is an interface (engine.ts:10). The architecture doc's `class MedicalSopEngine extends PipelineEngine` is shorthand — use `implements`.
- **`PipelineResult.spec` is mandatory.** Don't return `{ success: true }` alone — it won't typecheck. Required fields: `success`, `spec` (a `PlanSpec` — use `createSpec`), `completedSprints: []`, `failedSprints: []`, `duration: 0`.
- **No SDK imports under `src/medical` (sc-1-8).** Never import `@anthropic-ai/sdk` or `openai`. The stub engine makes ZERO LLM calls — it does not even import a provider/`LLMClient`. Keep it pure.
- **Keep `Team.guardrails` typed `?: unknown`.** Do NOT change `teams/types.ts:29` to `GuardrailSet`. Assigning a concrete `GuardrailSet` to an `unknown` slot is valid; narrowing the field type would break the programming team's `guardrails: undefined` and every config-declared team (contract assumption #4).
- **`createDefaultConfig` must still emit no `teams`/`defaultTeam`.** `registry.test.ts:108-112` asserts both are undefined. Widening the enum does not affect this — just don't add team defaults.
- **`DEFAULT_ROLES` is currently NOT exported** (registry.ts:17). If you reuse it in team.ts, add `export` (additive, safe). Otherwise inline the 7 role descriptors.
- **Tests must be pure** (no fs, no network) — the contract's generatorNotes mandate it. Always `vi.mock("../utils/logger.js", ...)` because `resolveRoleProviders` emits 7 info log lines per call (see registry.test.ts:9 and selector.test.ts:3-5).
- **`src/medical/` does not exist yet** — you are creating the directory. Match sibling conventions (single-word file names, section headers, `.js` import extensions).
