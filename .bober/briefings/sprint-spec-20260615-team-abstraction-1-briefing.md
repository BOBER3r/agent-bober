# Sprint Briefing: Team data model + registry + programming team as instance #1

**Contract:** sprint-spec-20260615-team-abstraction-1
**Generated:** 2026-06-15T00:00:00Z

---

## 0. TL;DR for the Generator

Create a new `src/teams/` module with three files plus one edit:

1. `src/teams/types.ts` — `Team` interface + `Role` descriptor type (no logic).
2. `src/teams/registry.ts` — `loadTeam(config, teamId?)` resolver + built-in `programming` team. Reuses `resolveRoleProviders` and `resolveEngineName` (NEVER reimplements them).
3. `src/teams/registry.test.ts` — collocated Vitest covering sc-1-4, sc-1-6, sc-1-7.
4. `src/config/schema.ts` — APPEND a `TeamConfigSchema` + two optional fields (`teams`, `defaultTeam`) to `BoberConfigSchema`. Do NOT touch `createDefaultConfig` (it must keep emitting NO teams for back-compat).

This sprint is **purely additive**: a data type + a pure resolver + optional schema fields. Zero behavior change. Do NOT wire `loadTeam` into `runPipeline`, `chat`, or the memory store this sprint.

---

## 1. Target Files

### src/teams/types.ts (create)

**Directory pattern:** `src/teams/` does not exist yet. Mirror the small two-file module pattern of `src/orchestrator/checkpoints/` (a `types.ts` holding only type/interface declarations + a `registry.ts` holding the resolver and built-ins).

**Most similar existing file:** `src/orchestrator/checkpoints/types.ts` — a pure types module: JSDoc header, exported `type`/`interface` declarations, ZERO runtime code. Follow this structure exactly.

**Structure template (based on `src/orchestrator/checkpoints/types.ts:1-60`):**
```ts
/**
 * Team data model for the domain-agnostic team abstraction (Phase 4).
 *
 * Sprint 1: pure data types only. A Team is the resolved shape the pipeline
 * needs; loadTeam (registry.ts) builds it from a BoberConfig. No execution
 * logic lives here.
 */
import type { RoleName, RoleProviderMap } from "../config/role-providers.js";
import type { PipelineEngineName } from "../orchestrator/workflow/engine.js";

// ── Role descriptor ─────────────────────────────────────────────────

/** Descriptor metadata for one of the 7 RoleName values. Does NOT drive execution this sprint. */
export interface Role {
  name: RoleName;
  displayName: string;
}

// ── Team ────────────────────────────────────────────────────────────

export interface Team {
  id: string;
  displayName: string;
  /** Sentinel ('' for the built-in programming team) that Sprint 2 maps to .bober/memory/. */
  memoryNamespace: string;
  providers: RoleProviderMap;
  pipelineShape: PipelineEngineName;
  roles: Role[];
  guardrails?: unknown;
}
```
**Import note (ESM/NodeNext):** ALL relative imports MUST use `.js` extensions even for `.ts` source. From `src/teams/`, the path to `src/config/role-providers.ts` is `"../config/role-providers.js"` and to `src/orchestrator/workflow/engine.ts` is `"../orchestrator/workflow/engine.js"`. Use `import type { ... }` (ESLint `consistent-type-imports` is enforced — principles.md:35).

---

### src/teams/registry.ts (create)

**Most similar existing file:** `src/orchestrator/checkpoints/registry.ts` — a `registry.ts` that combines a pure resolver function (`resolveCheckpointMechanismName`, lines 65-91) with built-in registration. Note the `throw new Error(\`Unknown ...: ${name}. ...\`)` pattern at lines 26-31 — mirror this exactly for the unknown-team throw.

**Reuse signatures (VERIFIED — do not reimplement):**
- `resolveRoleProviders(config: BoberConfig): RoleProviderMap` — `src/config/role-providers.ts:97`
- `resolveEngineName(config: BoberConfig): PipelineEngineName` — `src/orchestrator/workflow/selector.ts:22` (pure; returns the name without instantiating an engine)
- `type RoleName` (7-member union) — `src/config/role-providers.ts:10-17`
- `type RoleProviderMap = Record<RoleName, string>` — `src/config/role-providers.ts:19`
- `type PipelineEngineName = "ts" | "skill" | "workflow"` — `src/orchestrator/workflow/engine.ts:7`

**Structure template:**
```ts
/**
 * Team registry + resolver (Phase 4, Sprint 1).
 *
 * loadTeam(config, teamId?) returns a resolved Team. With no id (or 'programming')
 * it returns the built-in programming team, reproducing today's provider routing
 * (resolveRoleProviders), engine (resolveEngineName), and memory path (sentinel '').
 */
import type { BoberConfig } from "../config/schema.js";
import { resolveRoleProviders } from "../config/role-providers.js";
import type { RoleName } from "../config/role-providers.js";
import { resolveEngineName } from "../orchestrator/workflow/selector.js";
import type { Role, Team } from "./types.js";

// ── Role descriptors ────────────────────────────────────────────────

/** The 7 RoleName values as descriptors. Order mirrors ALL_ROLES (role-providers.ts:38). */
const DEFAULT_ROLES: Role[] = [
  { name: "planner",    displayName: "Planner" },
  { name: "researcher", displayName: "Researcher" },
  { name: "chat",       displayName: "Chat" },
  { name: "curator",    displayName: "Curator" },
  { name: "generator",  displayName: "Generator" },
  { name: "evaluator",  displayName: "Evaluator" },
  { name: "codeReview", displayName: "Code Reviewer" },
];

// ── Resolver ────────────────────────────────────────────────────────

export function loadTeam(config: BoberConfig, teamId?: string): Team {
  // Built-in default path: no id, 'programming', or defaultTeam pointing at the builtin.
  if (teamId === undefined || teamId === "programming") {
    return buildProgrammingTeam(config);
  }

  const entry = config.teams?.[teamId];
  if (!entry) {
    throw new Error(
      `Unknown team '${teamId}'. Declare it under config.teams or use the built-in 'programming' team.`,
    );
  }

  const resolvedDefaults = resolveRoleProviders(config);
  return {
    id: teamId,
    displayName: entry.displayName ?? teamId,
    memoryNamespace: entry.memoryNamespace ?? teamId,
    // partial override: unspecified roles keep the resolved default
    providers: { ...resolvedDefaults, ...(entry.providers ?? {}) } as Record<RoleName, string>,
    pipelineShape: entry.pipelineShape ?? resolveEngineName(config),
    roles: DEFAULT_ROLES,
    guardrails: entry.guardrails,
  };
}

function buildProgrammingTeam(config: BoberConfig): Team {
  return {
    id: "programming",
    displayName: "Programming team",
    memoryNamespace: "", // sentinel: Sprint 2 maps '' -> .bober/memory/
    providers: resolveRoleProviders(config),
    pipelineShape: resolveEngineName(config),
    roles: DEFAULT_ROLES,
    guardrails: undefined,
  };
}
```
**Rule:** `buildProgrammingTeam` MUST return `providers: resolveRoleProviders(config)` and `pipelineShape: resolveEngineName(config)` verbatim so sc-1-4's deepEqual holds. Do not transform or filter them.

**Note on `defaultTeam`:** The contract's generatorNotes mention "`=== config.defaultTeam` when that points to the builtin." The minimal, safe interpretation that satisfies sc-1-4/sc-1-6/sc-1-7: treat `undefined` and `'programming'` as the builtin. `defaultTeam` is a schema field only this sprint — no test requires `loadTeam` to read it. Keep the branch logic simple (only `undefined`/`'programming'` -> builtin); over-engineering the `defaultTeam` indirection risks an infinite-loop/edge-case bug with no test coverage.

---

### src/config/schema.ts (modify)

**Relevant section — the END of `BoberConfigSchema` (lines 358-385), where you APPEND:**
```ts
// ── Full Config ─────────────────────────────────────────────────────

export const BoberConfigSchema = z.object({
  project: ProjectSectionSchema,
  // ... existing fields ...
  // ── Sprint 1: bober chat session layer ──
  chat: ChatSectionSchema.optional(),
  // <<< APPEND your two new optional fields HERE, after chat >>>
});
export type BoberConfig = z.infer<typeof BoberConfigSchema>;
```

**Pattern for declaring a section schema + appending it (copy this exact style):**
Every optional section is declared as its own `export const XxxSectionSchema = z.object({...})` ABOVE `BoberConfigSchema`, then added to the object as `xxx: XxxSectionSchema.optional()` with a `// ── Sprint N: ... ──` comment. See `HistorySectionSchema` (lines 341-346) declared, then wired at line 380-381:
```ts
// ── History Section (Sprint 1 — scale-safe rotation) ─────────────────
export const HistorySectionSchema = z.object({
  maxActiveLines: z.number().int().positive().default(2000),
});
export type HistorySection = z.infer<typeof HistorySectionSchema>;
// ... later, inside BoberConfigSchema:
  // ── Sprint 1: scale-safe history rotation ──
  history: HistorySectionSchema.optional(),
```

**What to add (place the new `// ── Team Section ──` block just before `// ── Full Config ──` at line 358):**
```ts
// ── Team Section (Phase 4 — domain-agnostic team abstraction) ────────

/** Reuse the engine enum shape (mirrors PipelineSectionSchema.engine, line 220). */
export const TeamConfigSchema = z.object({
  displayName: z.string().optional(),
  /** Memory namespace segment — restricted to a safe path segment. */
  memoryNamespace: z.string().regex(/^[a-z0-9_-]+$/i).optional(),
  pipelineShape: z.enum(["ts", "skill", "workflow"]).optional(),
  /** Partial role -> provider override. Keys SHOULD be RoleName values. */
  providers: z.record(z.string(), z.string()).optional(),
  roles: z.array(z.object({ name: z.string(), displayName: z.string() })).optional(),
  guardrails: z.unknown().optional(),
});
export type TeamConfig = z.infer<typeof TeamConfigSchema>;
```
Then inside `BoberConfigSchema`, after `chat: ChatSectionSchema.optional(),`:
```ts
  // ── Phase 4: domain-agnostic team abstraction ──
  teams: z.record(z.string(), TeamConfigSchema).optional(),
  defaultTeam: z.string().optional(),
```
**Rule:** Both new fields are `.optional()` and `createDefaultConfig` does NOT emit them — a config without `teams`/`defaultTeam` must still parse (sc-1-5 back-compat). Do NOT add anything to the `createDefaultConfig` factory (lines 408-471).

**Type-compat note for `registry.ts`:** Because `providers` is typed `Record<string,string> | undefined` from Zod, the spread `{ ...resolvedDefaults, ...(entry.providers ?? {}) }` produces `Record<string,string>`. Narrow with `as Record<RoleName, string>` (= `RoleProviderMap`) as shown in the registry template. This is the only cast needed; do not loosen `RoleProviderMap`.

**`pipelineShape` enum:** Reuse the literal `z.enum(["ts", "skill", "workflow"])` — this is the same enum used at `schema.ts:220` and it is the source the `PipelineEngineName` union mirrors (`engine.ts:7` comment: "Mirrors the z.enum in PipelineSectionSchema").

**Test file:** `src/config/schema.test.ts` exists (sc-1-5 additions go here OR in `registry.test.ts`; the contract's estimatedFiles only lists `registry.test.ts`, so put the schema parse tests in `src/teams/registry.test.ts` importing `BoberConfigSchema`/`TeamConfigSchema`, OR extend `schema.test.ts`. Either is acceptable; collocating in `registry.test.ts` keeps the sprint's tests together).

**Imported by:** 60 files import from `src/config/schema` (verified `grep -rln "config/schema" src/ | wc -l` = 60). All import the `BoberConfig` type or specific section schemas. Adding two `.optional()` fields is non-breaking — see Section 7.

---

## 2. Patterns to Follow

### Section header comments (unicode box-drawing)
**Source:** `src/orchestrator/workflow/selector.ts:8`, `src/config/schema.ts:3`, `principles.md:32`
```ts
// ── Resolver ───────────────────────────────────────────────────────
```
**Rule:** Organize files with `// ── Section Name ──────` headers (em-dash `─` U+2500, not regular hyphens). Used throughout the codebase.

### Pure resolver + unknown-name throw
**Source:** `src/orchestrator/checkpoints/registry.ts:24-31`
```ts
export function getCheckpointMechanism(name: string): CheckpointMechanism {
  const impl = mechanisms.get(name);
  if (!impl) {
    throw new Error(
      `Unknown checkpoint mechanism: ${name}. Registered: ${[...mechanisms.keys()].join(", ") || "(none)"}`,
    );
  }
  return impl;
}
```
**Rule:** When an id is not found, `throw new Error` with a template literal that NAMES the offending id (sc-1-7 asserts the id substring appears in the message).

### Pure resolver returning a name (not an instance)
**Source:** `src/orchestrator/workflow/selector.ts:22-37` — `resolveEngineName` returns the `PipelineEngineName` string. Reuse it directly; do not re-derive the engine from `config.pipeline?.engine`.
```ts
export function resolveEngineName(config: BoberConfig): PipelineEngineName {
  const requested: PipelineEngineName = config.pipeline?.engine ?? "ts";
  // ... workflow downgrade logic ...
  return requested;
}
```
**Rule:** `pipelineShape` for the programming team = `resolveEngineName(config)`. The default is `'ts'` (`config.pipeline.engine` defaults to `'ts'`, schema.ts:220).

### Type-only module
**Source:** `src/orchestrator/checkpoints/types.ts:1-60` (entire file is types + JSDoc, no runtime). `src/teams/types.ts` should look identical in spirit.
**Rule:** Keep `types.ts` free of runtime code; put `DEFAULT_ROLES` and `loadTeam` in `registry.ts`.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `resolveRoleProviders` | `src/config/role-providers.ts:97` | `(config: BoberConfig) => RoleProviderMap` | Resolves the effective provider for all 7 roles. Programming team's `providers` MUST be this verbatim. |
| `resolveEngineName` | `src/orchestrator/workflow/selector.ts:22` | `(config: BoberConfig) => PipelineEngineName` | Pure resolver returning `'ts'\|'skill'\|'workflow'`. Programming team's `pipelineShape`. |
| `RoleName` (type) | `src/config/role-providers.ts:10` | `'planner'\|'researcher'\|'curator'\|'generator'\|'evaluator'\|'codeReview'\|'chat'` | The 7-role union. Import; do not redeclare. |
| `RoleProviderMap` (type) | `src/config/role-providers.ts:19` | `Record<RoleName, string>` | Team `providers` type. Import; do not redeclare. |
| `PipelineEngineName` (type) | `src/orchestrator/workflow/engine.ts:7` | `'ts'\|'skill'\|'workflow'` | Team `pipelineShape` type. Import; do not redeclare. |
| `BoberConfig` (type) | `src/config/schema.ts:385` | `z.infer<typeof BoberConfigSchema>` | Config type passed to `loadTeam`. |
| `createDefaultConfig` | `src/config/schema.ts:408` | `(projectName, mode, preset?, overrides?) => BoberConfig` | Build a test config. Use in `registry.test.ts`. |
| `memoryDir` (private) | `src/state/memory.ts:15` | `(projectRoot) => join(projectRoot, ".bober", "memory")` | Current memory path. Sprint 2 will namespace it; this sprint only stores the `''` sentinel. DO NOT touch. |

**Directories reviewed:** `src/utils/` (fs, git, logger — none applicable to a pure data resolver), `src/config/`, `src/orchestrator/workflow/`, `src/orchestrator/checkpoints/`, `src/state/`. The five reuse symbols above are the load-bearing ones; everything else in `loadTeam` is plain object construction (no util needed).

---

## 4. Prior Sprint Output

No prior sprints in this plan (`dependsOn: []`). This is sprint 1 of the Team Abstraction plan. It builds on already-shipped infrastructure: `resolveRoleProviders` (config-role-providers), `resolveEngineName` (local-model-workflow-runtime), and `BoberConfigSchema` (config). These are stable, merged, and tested — treat them as fixed APIs.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
Hard rules the Generator MUST follow:
- **ESM `.js` extensions** on every relative import (NodeNext) — principles.md:27. From `src/teams/`: `"../config/schema.js"`, `"../config/role-providers.js"`, `"../orchestrator/workflow/selector.js"`, `"../orchestrator/workflow/engine.js"`, `"./types.js"`.
- **`import type { ... }`** for type-only imports — `consistent-type-imports` enforced (principles.md:35).
- **No SDK leakage:** never import `@anthropic-ai/sdk` or `openai` outside `src/providers/` (principles.md:41, sc-1-8). `src/teams/` does NOT need any provider SDK — provider routing is just strings via `resolveRoleProviders`.
- **Zod for config** — all schema validation lives in `config/schema.ts` (principles.md:29). Add `TeamConfigSchema` there, not a hand-rolled validator.
- **Small single-purpose modules** + **unicode box section comments `// ── Name ──`** (principles.md:32-33).
- **Prefix unused params with `_`** (principles.md:36) — relevant if any helper takes an unused arg.
- **No `any` without justification** — use `unknown` (principles.md:40). `guardrails` is `unknown` per the contract.
- **No synchronous fs / no fs at all this sprint** — `loadTeam` is pure (no fs, no network) per generatorNotes.

### Architecture Decisions
No ADR specific to teams. The closest precedent is the "pure-resolver" pattern referenced in `selector.ts:19-20` ("Mirrors the pure-resolver pattern of `resolveCheckpointMechanismName` at registry.ts:65"). Follow that lineage: a pure function that maps config -> resolved value, with a `throw` for unknown ids.

### Memory-path sentinel (for sc-1-4)
Current memory path = `join(projectRoot, ".bober", "memory")` — `src/state/memory.ts:15-16` (`BOBER_DIR=".bober"`, `MEMORY_DIR="memory"`). It has **no team segment today**. The programming team's `memoryNamespace` is the **sentinel `''`** (empty string) which Sprint 2 will map to this exact unsegmented path. Store `''`; do NOT touch `src/state/memory.ts` this sprint (non-goal).

---

## 6. Testing Patterns

### Unit Test Pattern
**Source:** `src/config/role-providers.test.ts:1-38` and `src/config/schema.test.ts:1-38`
```ts
import { describe, it, expect } from "vitest";
import { loadTeam } from "./registry.js";
import { resolveRoleProviders } from "../config/role-providers.js";
import { resolveEngineName } from "../orchestrator/workflow/selector.js";
import { createDefaultConfig, BoberConfigSchema } from "../config/schema.js";

describe("loadTeam — programming team (sc-1-4)", () => {
  it("returns id 'programming' with resolved providers/engine and '' memoryNamespace", () => {
    const config = createDefaultConfig("test", "greenfield");
    const team = loadTeam(config);
    expect(team.id).toBe("programming");
    expect(team.providers).toEqual(resolveRoleProviders(config));
    expect(team.pipelineShape).toBe(resolveEngineName(config));
    expect(team.memoryNamespace).toBe("");
  });
});
```
**Runner:** Vitest. **Assertion style:** `expect().toBe()` / `.toEqual()` (deepEqual) / `.toThrow(/regex/)`. **Mock approach:** `vi.mock("../utils/logger.js", ...)` ONLY if logger noise matters — `resolveRoleProviders` calls `logger.info` 7×, so consider mocking the logger as `role-providers.test.ts:7-15` does to keep test output clean (optional; not required for assertions). **File naming:** `<name>.test.ts`. **Location:** collocated (next to source).

**Fixture construction — two valid approaches (both in the repo):**
- `createDefaultConfig("test", "greenfield")` — full default config (schema.test.ts uses `BoberConfigSchema.safeParse({...})`; role-providers.test.ts uses inline `as BoberConfig`). For `loadTeam` tests, `createDefaultConfig` is cleanest because it yields a real parsed config so `resolveRoleProviders` and `resolveEngineName` behave exactly as in production.
- For sc-1-6 (declared team), build the config then attach `teams`: `const config = { ...createDefaultConfig("t","greenfield"), teams: { docs: { memoryNamespace: "docs", pipelineShape: "ts", providers: { generator: "deepseek" } } }, defaultTeam: "programming" };`

**sc-1-5 schema parse pattern (mirror schema.test.ts:73-86):**
```ts
it("parses a config with teams + defaultTeam (sc-1-5)", () => {
  const result = BoberConfigSchema.safeParse({
    project: { name: "t", mode: "greenfield" },
    planner: {}, generator: {}, evaluator: { strategies: [] },
    sprint: {}, pipeline: {}, commands: {},
    teams: { docs: { memoryNamespace: "docs", pipelineShape: "ts", providers: { generator: "deepseek" } } },
    defaultTeam: "programming",
  });
  expect(result.success).toBe(true);
});
it("parses a config WITHOUT teams/defaultTeam (back-compat)", () => {
  const result = BoberConfigSchema.safeParse({
    project: { name: "t", mode: "greenfield" },
    planner: {}, generator: {}, evaluator: { strategies: [] },
    sprint: {}, pipeline: {}, commands: {},
  });
  expect(result.success).toBe(true);
});
```

**sc-1-6 merge assertion:**
```ts
const config = { ...createDefaultConfig("t","greenfield"),
  teams: { docs: { memoryNamespace: "docs", providers: { generator: "deepseek" } } } } as BoberConfig;
const team = loadTeam(config, "docs");
expect(team.providers.generator).toBe("deepseek");
expect(team.providers.planner).toBe(resolveRoleProviders(config).planner); // unspecified role unchanged
expect(team.memoryNamespace).toBe("docs");
```

**sc-1-7 throw assertion (mirror role-providers.test.ts:79):**
```ts
expect(() => loadTeam(createDefaultConfig("t","greenfield"), "nope")).toThrow(/nope/);
```

### E2E Test Pattern
Not applicable — this is a pure library module, no UI, no Playwright. (No `playwright.config.ts` relevant here.)

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| 60 files importing `src/config/schema` | `BoberConfigSchema` / `BoberConfig` type | **low** | Adding two `.optional()` fields is purely additive. `z.infer` widens the type with optional properties — no existing field changes type or becomes required. No consumer reads `.teams`/`.defaultTeam` yet, so none break. |
| `src/config/schema.test.ts` | `BoberConfigSchema` | low | Existing parse tests pass minimal configs; new optional fields don't make them fail. |
| `src/config/role-providers.ts` | (none — you only IMPORT from it) | none | You do NOT modify `resolveRoleProviders`. Read-only reuse. |
| `src/orchestrator/workflow/selector.ts` | (none — you only IMPORT from it) | none | You do NOT modify `resolveEngineName`. Read-only reuse. |
| `src/state/memory.ts` | (untouched) | none | Sprint 2's job. Do not edit. |

### Existing Tests That Must Still Pass
- `src/config/schema.test.ts` — tests `BoberConfigSchema` parse/defaults; verify still passes after adding optional `teams`/`defaultTeam` (they should not affect existing parses).
- `src/config/role-providers.test.ts` — tests `resolveRoleProviders`; must be untouched and still green (you reuse, not modify).
- `src/orchestrator/workflow/selector.test.ts` (if present) — tests `resolveEngineName`; must stay green.
- The FULL suite (`npm run test`) — evaluatorNotes require confirming nothing else changed.

### Features That Could Be Affected
- **Provider routing** — shares `resolveRoleProviders`. Verify the programming team reproduces it deep-equal (sc-1-4). No routing behavior changes because you only read it.
- **Pipeline engine selection** — shares `resolveEngineName`. The Team carries `pipelineShape` but `selectPipelineEngine`/`runPipeline` are NOT wired to it this sprint (non-goal). Verify those call sites are untouched.
- **Memory store** — shares the `.bober/memory/` path concept. The `''` sentinel is stored but NOT consumed; `src/state/memory.ts` stays byte-identical.

### Recommended Regression Checks
1. `npm run build` — zero TS errors (sc-1-1).
2. `npm run typecheck` — zero strict-mode errors (sc-1-2).
3. `npm run test` — full suite green, including new `src/teams/registry.test.ts` (sc-1-3).
4. `grep -rn '@anthropic-ai/sdk\|from "openai"' src/teams` — MUST return nothing (sc-1-8).
5. Confirm `createDefaultConfig` output still contains NO `teams`/`defaultTeam` keys (back-compat — sc-1-5).

---

## 8. Implementation Sequence

Dependency order: types -> schema field (needed by registry's config type) -> registry -> tests.

1. **`src/teams/types.ts`** — define `Role` and `Team` interfaces. Import `RoleName`/`RoleProviderMap` (type-only from `../config/role-providers.js`) and `PipelineEngineName` (type-only from `../orchestrator/workflow/engine.js`).
   - Verify: `npm run typecheck` — file compiles, no unused imports.
2. **`src/config/schema.ts`** — add `TeamConfigSchema` (+ `TeamConfig` type export) just before `// ── Full Config ──`; append `teams` + `defaultTeam` optional fields inside `BoberConfigSchema` after `chat`. Do NOT touch `createDefaultConfig`.
   - Verify: `npx vitest run src/config/schema.test.ts` still green; `BoberConfig` type now has optional `teams?`/`defaultTeam?`.
3. **`src/teams/registry.ts`** — implement `DEFAULT_ROLES`, `buildProgrammingTeam`, and `loadTeam`. Reuse `resolveRoleProviders` and `resolveEngineName`; throw a named error for unknown ids.
   - Verify: `npm run typecheck` — the `as Record<RoleName, string>` cast on the merged providers compiles; no SDK imports.
4. **`src/teams/registry.test.ts`** — collocated Vitest covering sc-1-4 (programming team deep-equal), sc-1-5 (schema parse with/without teams), sc-1-6 (partial provider merge), sc-1-7 (unknown-team throw). Build configs via `createDefaultConfig`; pure (no fs/network).
   - Verify: `npx vitest run src/teams/registry.test.ts` green.
5. **Run full verification** — `npm run build`, `npm run typecheck`, `npm run test`, and the sc-1-8 grep.

---

## 9. Pitfalls & Warnings

- **Do NOT reimplement `resolveRoleProviders` or `resolveEngineName`.** The programming team's `providers`/`pipelineShape` MUST be the exact return values so sc-1-4's `.toEqual`/`.toBe` holds. Re-deriving them risks subtle drift (e.g., the claude-code fallback logic in `resolveRoleProviders`).
- **`.js` extensions, not `.ts`.** ESM/NodeNext: `import ... from "../config/role-providers.js"` (the source is `.ts` but the import path uses `.js`). Omitting the extension or using `.ts` fails the build.
- **`import type` vs `import`.** `Team`, `Role`, `RoleName`, `RoleProviderMap`, `PipelineEngineName`, `BoberConfig` are type-only -> `import type`. `resolveRoleProviders`, `resolveEngineName`, `createDefaultConfig` are runtime values -> plain `import`. Mixing these trips `consistent-type-imports` (lint gate).
- **`memoryNamespace: ''` for the builtin, not `'programming'`.** sc-1-4 expects the documented sentinel that maps to the CURRENT unsegmented `.bober/memory/` path. Per generatorNotes the builtin uses `''`. (A non-empty value would imply a `.bober/memory/programming/` subdir, which is Sprint 2 — wrong here.) For NAMED teams, `memoryNamespace = entry.memoryNamespace ?? teamId` (non-empty).
- **Do NOT modify `createDefaultConfig`.** Back-compat (sc-1-5) requires the default config to emit NO `teams`/`defaultTeam`. Adding them there would break the "config WITHOUT either still parses + default omits them" expectation.
- **Zod `providers` typing.** `z.record(z.string(), z.string())` yields `Record<string,string>`, not `Record<RoleName,string>`. The spread merge needs the `as Record<RoleName, string>` cast (= `RoleProviderMap`). Do not widen `RoleProviderMap` or add `any`.
- **Do NOT wire `loadTeam` into `runPipeline`/`chat`/memory.** Non-goals. A thin call site is allowed ONLY if needed to compile (it isn't — this is a standalone module). If you add one, the default path (`loadTeam(config)`) must reproduce today's behavior exactly.
- **No SDK, no fs, no network in `src/teams/`.** sc-1-8 greps for SDK imports; generatorNotes require pure functions. Provider routing is just strings.
- **`guardrails` is `unknown`/optional and unused.** Forward-compat only (medical is Phase 6). Store it; do not validate or enforce it.
- **Briefing test placement:** the contract's `estimatedFiles` lists `src/teams/registry.test.ts` (not `schema.test.ts`). Put sc-1-5 schema-parse tests in `registry.test.ts` (importing `BoberConfigSchema`/`TeamConfigSchema` from `../config/schema.js`) to keep the sprint's tests collocated, OR extend `schema.test.ts` — both pass the gate, but `registry.test.ts` matches the estimated files.
