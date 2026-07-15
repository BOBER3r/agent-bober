# Sprint Briefing: ToolRoleGuard (build-time, fail-fast)

**Contract:** sprint-spec-20260618-fleet-tier-provider-routing-3
**Generated:** 2026-06-18T00:00:00Z

> Sprint 3 (final) of Phase A. Add a build-time guard that rejects any fleet child whose
> RESOLVED `BoberConfig` would place the `claude-code` provider on a TOOL_ROLE
> (`curator`/`generator`/`evaluator`/`codeReview`), throwing BEFORE any child spawns.
> The never-throw `validateManifest` stays UNCHANGED; the no-flag fleet path stays byte-identical.

---

## 1. Target Files

### `src/config/role-providers.ts` (modify)

Two surgical additions: (a) export a thin `isToolRole(role)` derived from `TOOL_ROLES`,
(b) add `export` to the existing `effectiveProvider`. **Do NOT touch `resolveRoleProviders`
or its throw logic.**

**The `RoleName` type (lines 10-17):**
```typescript
export type RoleName =
  | "planner"
  | "researcher"
  | "curator"
  | "generator"
  | "evaluator"
  | "codeReview"
  | "chat";
```

**The authoritative `TOOL_ROLES` constant (lines 21-25) — DO NOT re-declare this list:**
```typescript
/**
 * Roles that drive tool use — cannot use the claude-code provider.
 * Order determines which role's provider is chosen as the fallback target.
 */
const TOOL_ROLES: RoleName[] = ["curator", "generator", "evaluator", "codeReview"];
```
> `TOOL_ROLES` is currently a **module-private `const`** (no `export`). `isToolRole` is the
> public derivation of it (sc-3-3 requires `isToolRole` to AGREE with `TOOL_ROLES` membership,
> not re-declare a literal). You may leave `TOOL_ROLES` private and add `isToolRole` in the
> same module so it closes over the const directly.

**`effectiveProvider` — currently a module-private `function` (lines 49-76), NOT exported:**
```typescript
function effectiveProvider(role: RoleName, config: BoberConfig): string {
  let model: string | undefined;
  let provider: string | undefined;

  if (role === "researcher") {
    model = config.planner?.model;          // researcher shares planner section
    provider = config.planner?.provider;
  } else if (role === "codeReview") {
    model = config.codeReview?.model ?? config.evaluator?.model;     // fall back to evaluator
    provider = config.codeReview?.provider ?? config.evaluator?.provider;
  } else if (role === "chat") {
    model = config.chat?.model;
    provider = config.chat?.provider;
  } else {
    const section = config[role];           // planner | curator | generator | evaluator
    model = section?.model;
    provider = section?.provider;
  }

  const resolvedModel = model ?? "sonnet";  // optional sections may have no model
  return resolveProviderModel(resolvedModel, provider).provider;
}
```
> **CRITICAL:** `effectiveProvider` returns the RAW per-role provider (explicit `provider`
> wins, else `resolveProviderModel(model)` derives it). It does **NOT** apply the
> claude-code→fallback redirect — that redirect lives only inside `resolveRoleProviders`
> (lines 116-137). The guard WANTS the raw value: it must catch `claude-code` on a tool role
> *before* any redirect could mask it. So `effectiveProvider(role, resolved) === "claude-code"`
> is exactly the violation predicate.

**The existing throw (in `resolveRoleProviders`, lines 130-134) — reference only, DO NOT MODIFY:**
```typescript
} else {
  throw new Error(
    `Role "${role}" resolves to the claude-code provider, which cannot drive tools, ` +
    `and no alternative provider is configured. Set a per-role provider for "${role}" ` +
    `or change the default provider away from claude-code.`,
  );
}
```
> This is the **runtime** (config-load) guard, fired from `src/config/loader.ts:264` via
> `resolveRoleProviders(cfg)`. The new ToolRoleGuard **front-loads** the same invariant to
> manifest-build time (before any spawn). Note this existing throw only fires when NO
> non-claude-code fallback exists anywhere; the new guard is stricter — it rejects claude-code
> on a tool role even when a fallback exists, because the child must use an api-key provider
> for builder roles.

**Imports this file uses:** `resolveProviderModel` from `../orchestrator/model-resolver.js`;
`logger` from `../utils/logger.js`; `type BoberConfig` from `./schema.js`.

**Imported by (current consumers of `resolveRoleProviders` — none import `effectiveProvider` yet):**
- `src/config/loader.ts:11,264`, `src/cli/commands/chat.ts:16,32`, `src/medical/team.ts:9,54`,
  `src/teams/registry.test.ts`, `src/teams/types.ts:8` (imports `RoleName`/`RoleProviderMap` types only).
- Adding `export` to `effectiveProvider` and a new `isToolRole` export is purely additive —
  no existing consumer breaks.

**Test file:** `src/config/role-providers.test.ts` (exists — add an `isToolRole` describe block).

---

### `src/config/role-providers.test.ts` (modify)

Add a describe block for `isToolRole`. The existing file mocks the logger (lines 7-15) — keep
that. Import `isToolRole` alongside `resolveRoleProviders`. **Per sc-3-3 / evaluatorNotes:**
assert `isToolRole` for ALL 7 `RoleName` values and that the true-set equals `TOOL_ROLES`
membership (`curator`/`generator`/`evaluator`/`codeReview` → true; `planner`/`researcher`/`chat`
→ false). Since `TOOL_ROLES` is private, assert against the literal set
`["curator","generator","evaluator","codeReview"]` mapped through `isToolRole`.

---

### `src/fleet/tool-role-guard.ts` (create)

**Directory pattern:** `src/fleet/` files are kebab-less single-word or hyphenated module names
(`child-config.ts`, `tier-policy.ts`, `manifest.ts`), ESM `.js` imports, unicode `// ──` section
headers, `export function`/`export const` named exports, `import type` for types.

**Most similar existing file (structure template):** `src/fleet/tier-policy.ts` (header comment →
types → const table → exported API) and `src/fleet/child-config.ts` (imports → constants →
exported builder). Follow that shape.

**Required exports (from contract definitionOfDone + generatorNotes):**
- `type ToolRoleViolation = { childFolder: string; role: RoleName; provider: "claude-code" }`
- `function check(child: FleetChild, resolved: BoberConfig): ToolRoleViolation | null` — PURE,
  NEVER throws.
- `function assertManifest(manifest: FleetManifest): void` — THROWS a named `Error` whose message
  contains `child.folder` + `role` on the first violation.

**Structure template (assembled from verified shapes — adapt, don't paste blind):**
```typescript
// ── fleet/tool-role-guard.ts ──────────────────────────────────────────
//
// Build-time guard: reject any fleet child whose RESOLVED BoberConfig would
// place the claude-code provider on a TOOL_ROLE (curator/generator/evaluator/
// codeReview). Front-loads the runtime invariant from config/loader.ts:264 to
// manifest-build time so no child is spawned on a violation.

import { isToolRole, effectiveProvider } from "../config/role-providers.js";
import type { RoleName } from "../config/role-providers.js";
import { buildChildConfig } from "./child-config.js";
import type { FleetChild, FleetManifest } from "./manifest.js";
import type { BoberConfig } from "../config/schema.js";

// ── Types ─────────────────────────────────────────────────────────────

export type ToolRoleViolation = {
  childFolder: string;
  role: RoleName;
  provider: "claude-code";
};

// All RoleName values to iterate; gate on isToolRole (derives from TOOL_ROLES).
const ALL_ROLES: RoleName[] = [
  "planner", "researcher", "curator", "generator", "evaluator", "codeReview", "chat",
];

// ── check (pure, never throws) ────────────────────────────────────────

export function check(child: FleetChild, resolved: BoberConfig): ToolRoleViolation | null {
  for (const role of ALL_ROLES) {
    if (!isToolRole(role)) continue;
    if (effectiveProvider(role, resolved) === "claude-code") {
      return { childFolder: child.folder, role, provider: "claude-code" };
    }
  }
  return null;
}

// ── assertManifest (throws on first violation) ────────────────────────

export function assertManifest(manifest: FleetManifest): void {
  for (const child of manifest.children) {
    const resolved = buildChildConfig(child);
    const v = check(child, resolved);
    if (v) {
      throw new Error(
        `Fleet child "${v.childFolder}" places claude-code on tool role "${v.role}" — ` +
        `claude-code cannot drive tools. Use an api-key provider (anthropic/openai-compat) ` +
        `for builder roles.`,
      );
    }
  }
}
```
> The generatorNotes also allow hard-coding the tool-role loop as
> `(["curator","generator","evaluator","codeReview"] as RoleName[])`. PREFER the
> `isToolRole`-gated `ALL_ROLES` form above — it derives from the authoritative list (sc-3-3
> nonGoal: "Do NOT re-declare the tool-role list"). `check` returns the FIRST tool role in
> iteration order that resolves to claude-code (curator before generator before evaluator…).

---

### `src/fleet/tool-role-guard.test.ts` (create)

Collocated. Mirror the style of `src/fleet/child-config.test.ts` / `tier-policy.test.ts` (plain
`describe`/`it`/`expect`, no logger mock needed since the guard doesn't log). Cover:
`check` returns a `ToolRoleViolation` for a child with `config.generator.provider="claude-code"`;
`check` returns `null` for a clean/tiered child and is wrapped in
`expect(() => check(...)).not.toThrow()`; `assertManifest` throws naming folder+`generator` for the
bad manifest; `assertManifest` does NOT throw for a clean manifest (including one with `tier`-carrying
children). **See §6 for how to construct the resolved config and §9 pitfall on Zod-parsing it.**

---

### `src/fleet/index.ts` (modify) — wire `assertManifest` into the fail-fast phase

**Exact current fail-fast region in `runFleet` (lines 98-116):**
```typescript
  // 1. Load + validate manifest
  const manifest = await load(manifestPath);

  // 2. Apply options overrides (shallow copy to avoid mutating the parsed object)
  const effectiveManifest = {
    ...manifest,
    ...(options?.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    ...(options?.rootDir !== undefined ? { rootDir: options.rootDir } : {}),
  };

  // 3. Credential fail-fast BEFORE any spawn
  validateManifestCredentials(effectiveManifest);    // <-- line 109

  // 4. Execute → aggregate
  const coordinator = deps?.coordinator ?? new FleetCoordinator();     // <-- line 112
  ...
  const executions = await coordinator.execute(effectiveManifest);     // <-- line 116
```

**EXACT insertion point:** add `assertManifest(effectiveManifest);` in step 3, immediately
ADJACENT to `validateManifestCredentials(effectiveManifest)` (line 109) — BOTH must run before
`coordinator.execute` (line 116). Place it either just before or just after the credential call;
both are pre-spawn. Recommended (catch the structural violation before the credential loop):
```typescript
  // 3. Build-time + credential fail-fast BEFORE any spawn
  assertManifest(effectiveManifest);                 // throws if claude-code on a tool role
  validateManifestCredentials(effectiveManifest);
```
Add the import near the other `./` fleet imports (lines 14-23):
```typescript
import { assertManifest } from "./tool-role-guard.js";
```
> Do NOT move it after `coordinator.execute`. Do NOT add it to `runFleetExpand`/`runFleetExpandDeep`
> (those chain into `runFleet`, which already runs the guard). `validateManifestCredentials`
> (lines 46-70) stays UNCHANGED.

**Test file:** `src/fleet/index.test.ts` (exists — add a pre-spawn-throw test, see §6).

---

## 2. Patterns to Follow

### ESM `.js` imports + `import type`
**Source:** `src/fleet/child-config.ts`, lines 1-4
```typescript
import { BoberConfigSchema, createDefaultConfig } from "../config/schema.js";
import type { BoberConfig } from "../config/schema.js";
import type { FleetChild } from "./manifest.js";
import { tierPolicy } from "./tier-policy.js";
```
**Rule:** Every relative import ends in `.js`; types are imported with `import type` (ESLint
`consistent-type-imports` is a hard gate — principles.md:35).

### Unicode section headers
**Source:** `src/fleet/index.ts`, lines 1-8, 31, 39, 72
```typescript
// ── fleet/index.ts ────────────────────────────────────────────────────
// ── DI seam ───────────────────────────────────────────────────────────
// ── Credential fail-fast ──────────────────────────────────────────────
```
**Rule:** Organize files with `// ── Section Name ──` box-drawing headers (principles.md:32).

### Named-export pure functions over a const table
**Source:** `src/fleet/tier-policy.ts`, lines 73-82
```typescript
export const tierPolicy: TierProviderPolicy = {
  resolveTier(tier?: DifficultyTier): TieredRoleBlock | undefined {
    return tier && tier !== "default" ? TIER_POLICY[tier] : undefined;
  },
  ...
};
```
**Rule:** Prefer named `export function`/`export const`; the guard exports flat functions
(`check`, `assertManifest`) like `child-config.ts` exports `buildChildConfig`.

### Error thrown with an actionable, role-naming message
**Source:** `src/config/role-providers.ts`, lines 130-134 (the analogous runtime throw)
```typescript
throw new Error(
  `Role "${role}" resolves to the claude-code provider, which cannot drive tools, ` +
  `and no alternative provider is configured. ...`,
);
```
**Rule:** The thrown `Error` message must name the offending entity (here `child.folder` + `role`)
and explain the fix (use an api-key provider). sc-3-5 asserts the message CONTAINS folder + role.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `effectiveProvider` | `src/config/role-providers.ts:49` | `(role: RoleName, config: BoberConfig): string` | Raw per-role provider (no fallback redirect). EXPORT it; the guard's violation predicate. |
| `TOOL_ROLES` | `src/config/role-providers.ts:25` | `RoleName[]` (module-private) | Authoritative tool-role list. `isToolRole` MUST derive from this. |
| `RoleName` | `src/config/role-providers.ts:10` | `type` (exported) | The 7-role union the guard iterates. |
| `buildChildConfig` | `src/fleet/child-config.ts:22` | `(child: FleetChild): BoberConfig` | Tier-aware (Sprint 2). `assertManifest` calls it per child to get the RESOLVED config. |
| `FleetChild` / `FleetManifest` | `src/fleet/manifest.ts:12,19` | Zod-inferred types | Guard input types. `FleetChild` has `{folder, task, config?, tier?}`. |
| `BoberConfig` / `BoberConfigSchema` | `src/config/schema.ts:435,405` | `type` / Zod schema | The resolved config type + parser. |
| `createDefaultConfig` | `src/config/schema.ts:458` | `(folder, kind)` (used by buildChildConfig) | Builds the Zod-valid base — used indirectly via buildChildConfig in tests. |
| `tierPolicy.resolveTier` | `src/fleet/tier-policy.ts:76` | `(tier?: DifficultyTier): TieredRoleBlock \| undefined` | Sprint 2 tier overlay; no tier ever yields claude-code. |
| `resolveProviderModel` | `src/orchestrator/model-resolver.js` | `(model, provider) -> {provider, ...}` | Already used inside `effectiveProvider`; do NOT call directly. |

> Utilities reviewed in `src/utils/`, `src/fleet/`, `src/config/`: there is NO existing
> "tool role assertion" / "manifest guard" helper — `tool-role-guard.ts` does not exist yet
> (verified `ls`). The guard is genuinely new; everything else is reused.

---

## 4. Prior Sprint Output

### Sprint 1: Grok/xAI openai-compat wiring (commit b739ef1)
**Touched:** model-resolver SHORTHAND_MAP, `providers/factory.ts` (xAI key arm), and
`validateManifestCredentials`. **Connection:** none direct — the guard does not touch Grok wiring
(nonGoal/outOfScope). It only matters that `effectiveProvider` may now resolve `openai-compat`
for Grok models, which is NOT claude-code, so the guard passes them.

### Sprint 2: `tier-policy.ts` + `FleetChild.tier` + tier-aware `buildChildConfig` (commit 6e25a5f)
**Created/modified:** `src/fleet/tier-policy.ts` (exports `tierPolicy`, `DifficultyTier`,
`TieredRoleBlock`), `src/fleet/manifest.ts:10` (added optional `tier` enum to `FleetChildSchema`),
`src/fleet/child-config.ts:44-49` (overlays the tier block).
**Connection to this sprint (CRITICAL):** `buildChildConfig(child)` now yields the RESOLVED
`BoberConfig` the guard inspects via `effectiveProvider`. **No tier in `TIER_POLICY`
(tier-policy.ts:50-71) ever sets `provider: "claude-code"`** — `cheap`/`standard` use
`openai-compat`, `hard`/`frontier` use `anthropic`. So a tiered child NEVER trips the guard.
The guard's REAL job (see §6) is catching a hand-authored `child.config` that sets claude-code.
sc-3-5/sc-3-7 require a tiered-but-clean manifest to pass `assertManifest` with no throw.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM everywhere**, `.js` import extensions (line 27). **`import type`** enforced (line 35).
- **Zod for config validation** — runtime uses `z.parse()`; no hand-rolled validation (line 29).
  `buildChildConfig` already `BoberConfigSchema.parse(...)`es; the guard inspects the parsed result.
- **Tests collocated** `*.test.ts` next to `*.ts` (line 20). **Section comments** `// ──` (line 32).
- **Strict TS** (line 18) and **zero lint errors** (line 19) are hard gates. **No `any` without
  justification** (line 40) — the test fakes use `as unknown as` casts (see §6), which is the
  established pattern, not raw `any`.

### Architecture (`arch-20260618-heterogeneous-multi-provider-agent-team-architecture.md`)
- **ToolRoleGuard component (lines 119-136):** declares the exact interface this sprint builds —
  `isToolRole(role)`, `effectiveProvider(child, role)`, `check(child, resolved) -> ToolRoleViolation|null`,
  `assertManifest(manifest): void // THROWS`. `ToolRoleViolation = {childFolder, role, provider}`.
- **CP4 risk (line 317):** *"claude-code lands on a tool role via runtime fallback, not caught at
  build (`src/config/loader.ts:262-263`)"* — severity **critical**. Mitigation: *"`assertManifest`
  THROWS in the fail-fast credential phase, outside never-throw validateManifest (ADR-1)."* This
  sprint IS that mitigation.
- **Data flow (lines 270-272):** ordering is `ToolRoleGuard.assertManifest(manifest)` →
  `validateManifestCredentials(manifest)` → `coordinator.execute`. Both checks are pre-spawn.
- **Backward-compat (line 285):** *"No-flag path: every new branch is gated on `undefined`…
  byte-identical."* A clean manifest must pass with no throw and no side effects (sc-3-7).
- **Success criterion (line 30):** claude-code NEVER on `[curator, generator, evaluator, codeReview]`
  — enforced at build/fail-fast time (`role-providers.ts:25`), runtime-enforced at `loader.ts:262-263`.

---

## 6. Testing Patterns

### Unit Test Pattern (collocated, vitest)
**Source:** `src/config/role-providers.test.ts`, lines 1-37 (config-as-cast + describe/it/expect)
```typescript
import { describe, it, expect } from "vitest";
import { resolveRoleProviders } from "./role-providers.js";
import type { BoberConfig } from "./schema.js";

describe("sc-5-1: ...", () => {
  it("generator with explicit provider=anthropic resolves to anthropic", () => {
    const config = {
      planner: { model: "opus", provider: "claude-code" },
      generator: { model: "sonnet", provider: "anthropic" },
      evaluator: { model: "sonnet", provider: "claude-code", strategies: [] },
      ...
    } as BoberConfig;
    const result = resolveRoleProviders(config);
    expect(result.generator).toBe("anthropic");
  });
});
```
**Runner:** vitest. **Assertion:** `expect(...).toBe / .not.toThrow / .toThrow(/regex/)`.
**Mock approach:** logger mocked via `vi.mock("../utils/logger.js", ...)` (role-providers.test.ts:7).
The GUARD does not log, so its test needs NO logger mock. **File naming:** `*.test.ts` collocated.

> **How `check`/`assertManifest` tests should build the resolved config:** call
> `buildChildConfig(child)` for the real path (tier-aware, Zod-parsed), e.g.
> `const resolved = buildChildConfig({ folder: "x", task: "t", config: { generator: { model: "sonnet", provider: "claude-code" } } });`
> then `expect(check({folder:"x",task:"t"} as FleetChild, resolved)).toEqual({childFolder:"x", role:"generator", provider:"claude-code"})`.
> For `assertManifest`, pass a full `FleetManifest` `{ rootDir, concurrency, children: [...] }` and
> `expect(() => assertManifest(m)).toThrow(/x.*generator|generator.*x/)`. For the clean case use a
> plain or `tier:"cheap"` child and `expect(() => assertManifest(m)).not.toThrow()`.

### runFleet DI test pattern (for the pre-spawn-throw test — sc-3-6)
**Source:** `src/fleet/index.test.ts`, lines 194-215 (the existing "throws before any spawn" test)
```typescript
it("throws before any spawn when DeepSeek key is missing", async () => {
  const manifestPath = await writeManifest(tmpDir, {
    rootDir: tmpDir, concurrency: 1,
    children: [{ folder: "child-a", task: "build something" }],
  });

  let executeCalled = false;
  const fakeCoord = {
    async execute(_m: FleetManifest): Promise<ChildExecution[]> {
      executeCalled = true;
      return [];
    },
  } as unknown as FleetCoordinator;

  await expect(runFleet(manifestPath, {}, { coordinator: fakeCoord })).rejects.toThrow(
    /DEEPSEEK_API_KEY/,
  );
  expect(executeCalled).toBe(false);
});
```
**This is the EXACT template for sc-3-6.** Clone it: write a manifest with a child carrying
`config: { generator: { model: "sonnet", provider: "claude-code" } }`, inject `fakeCoord` (the
`executeCalled` flag), `await expect(runFleet(path, {}, { coordinator: fakeCoord })).rejects.toThrow(/generator/)`,
then `expect(executeCalled).toBe(false)`.

> **DI seam:** `runFleet(manifestPath, options?, deps?)` (index.ts:93-97); `deps.coordinator`
> overrides the real `FleetCoordinator` (index.ts:112: `deps?.coordinator ?? new FleetCoordinator()`).
> `makeFakeCoordinator` (index.test.ts:29-41) returns `{ coord, calls }` recording manifests —
> you can also assert `expect(calls).toHaveLength(0)` instead of a bespoke flag.

> **IMPORTANT for the bad-manifest test:** set `DEEPSEEK_API_KEY` so the test fails on the GUARD,
> not on credentials. Either set `process.env["DEEPSEEK_API_KEY"]` in `beforeEach` (as the sc-4-6
> block does at index.test.ts:71) OR put `assertManifest` BEFORE `validateManifestCredentials`
> (recommended insertion in §1) so the claude-code violation throws first regardless. With
> `assertManifest` first, a child whose `generator.provider="claude-code"` throws the tool-role
> error before any credential check.

### E2E Test Pattern
N/A — agent-bober is a CLI/library with no UI (principles.md:48). No Playwright. Unit tests only.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/config/loader.ts:11,264` | `role-providers.ts` (`resolveRoleProviders`) | low | Only imports `resolveRoleProviders`, untouched. Adding exports is additive. |
| `src/cli/commands/chat.ts:16,32` | `role-providers.ts` | low | Same — `resolveRoleProviders` only. |
| `src/medical/team.ts:9,54`, `src/teams/types.ts:8` | `role-providers.ts` | low | `resolveRoleProviders` / `RoleName` types — untouched. |
| `src/fleet/index.ts` (runFleet) consumers | new `assertManifest` call | medium | `runFleetExpand`/`runFleetExpandDeep` (index.ts:168,293) chain into `runFleet`; a clean manifest must still pass. Existing index.test.ts sc-4-6/4-7 manifests are all DeepSeek/default → no claude-code → guard passes silently. |
| `src/fleet/child-config.ts` | called by `assertManifest` | low | Read-only call; `buildChildConfig` unchanged. |

### Existing Tests That Must Still Pass (unchanged)
- `src/fleet/index.test.ts` — sc-4-6 (end-to-end fakes, lines 63-173), sc-4-7 (credential fail-fast,
  lines 175-241), sc-4-8 (registerFleetCommand, lines 243-265). **All use clean DeepSeek/default
  manifests** → `assertManifest` must pass them with no throw. Verify after inserting the call.
- `src/config/role-providers.test.ts` — sc-5-1..sc-5-4 (lines 21-205) exercise `resolveRoleProviders`;
  the existing throw logic MUST stay byte-identical (you only ADD exports). Verify all pass.
- `src/fleet/child-config.test.ts`, `src/fleet/tier-policy.test.ts` — Sprint 2 tier tests; the guard
  imports `buildChildConfig` read-only, so these stay green.

### Features That Could Be Affected
- **Fleet run / expand / expand-deep** — share `runFleet`. Verify the no-flag path stays
  byte-identical (clean manifest → no throw, no side effects). The guard adds ZERO behavior for
  clean manifests (arch line 285).
- **Tier routing (Sprint 2)** — shares `buildChildConfig`. Verify tiered (`cheap`/`standard`/`hard`/
  `frontier`) children pass `assertManifest` (no tier yields claude-code).

### Recommended Regression Checks (concrete, runnable)
1. `npm run build` — zero TS errors (sc-3-1).
2. `npm run typecheck` — strict-mode clean (sc-3-1).
3. `npm run lint` — zero errors; confirm `consistent-type-imports` and unused-var rules pass (sc-3-8).
4. `npm run test` — full suite green; only the 6 known cockpit-integration MCP failures allowed (sc-3-2).
5. `git diff src/config/role-providers.ts` — confirm `resolveRoleProviders` body (lines 97-145,
   especially the throw at 130-134) is UNCHANGED; only `export` added to `effectiveProvider` +
   new `isToolRole` (sc-3-7).
6. `git diff src/fleet/index.ts` — confirm `validateManifestCredentials` (lines 46-70) is byte-identical;
   only the `assertManifest` import + one call line added (sc-3-7/sc-3-8).
7. Targeted: `npx vitest run src/fleet/index.test.ts src/config/role-providers.test.ts src/fleet/tool-role-guard.test.ts`.

---

## 8. Implementation Sequence (dependency-ordered)

1. **`src/config/role-providers.ts`** — add `export` keyword to `function effectiveProvider`
   (line 49); add `export function isToolRole(role: RoleName): boolean { return TOOL_ROLES.includes(role); }`
   near `TOOL_ROLES`. Touch NOTHING else.
   - Verify: `npm run typecheck` clean; `resolveRoleProviders` body unchanged (git diff).
2. **`src/config/role-providers.test.ts`** — add `isToolRole` describe block (all 7 roles; true-set
   equals tool-role membership).
   - Verify: `npx vitest run src/config/role-providers.test.ts` green.
3. **`src/fleet/tool-role-guard.ts`** — create per §1 template. Imports: `isToolRole`,
   `effectiveProvider`, `type RoleName` from `../config/role-providers.js`; `buildChildConfig` from
   `./child-config.js`; `type FleetChild, FleetManifest` from `./manifest.js`; `type BoberConfig`
   from `../config/schema.js`. Export `ToolRoleViolation`, `check` (pure), `assertManifest` (throws).
   - Verify: `npm run typecheck` clean; no `any`; `.js` extensions; `import type` for all types.
4. **`src/fleet/tool-role-guard.test.ts`** — create: `check` violation (claude-code on generator) /
   `null` (clean+tiered) / `.not.toThrow()`; `assertManifest` throw (folder+role in message) / clean
   no-throw. Build resolved configs via `buildChildConfig`.
   - Verify: `npx vitest run src/fleet/tool-role-guard.test.ts` green.
5. **`src/fleet/index.ts`** — add `import { assertManifest } from "./tool-role-guard.js";` and call
   `assertManifest(effectiveManifest);` in step 3 adjacent to (recommended: just before)
   `validateManifestCredentials(effectiveManifest)` — BOTH before `coordinator.execute` (line 116).
   `validateManifestCredentials` body UNCHANGED.
   - Verify: existing `src/fleet/index.test.ts` (sc-4-6/4-7/4-8) still green (clean manifests pass).
6. **`src/fleet/index.test.ts`** — add sc-3-6 test: bad manifest (`config.generator.provider="claude-code"`)
   + injected fake coordinator → `rejects.toThrow(/generator/)` AND `executeCalled === false`. Set
   `DEEPSEEK_API_KEY` in the test (or rely on guard-first ordering).
   - Verify: `npx vitest run src/fleet/index.test.ts` green.
7. **Run full verification** — `npm run build` && `npm run typecheck` && `npm run lint` && `npm run test`
   (only 6 known cockpit MCP failures permitted).

---

## 9. Pitfalls & Warnings

- **`effectiveProvider` returns the RAW provider, NOT the redirected one.** That is exactly what the
  guard needs — `claude-code` on a tool role must be caught BEFORE `resolveRoleProviders`'s fallback
  redirect (role-providers.ts:124-128) could mask it. Do NOT call `resolveRoleProviders` from the guard.
- **`TOOL_ROLES` is module-private (no `export`).** Per nonGoal/sc-3-3, `isToolRole` must DERIVE from
  it, not re-declare a literal. Put `isToolRole` in `role-providers.ts` so it closes over the const.
  Do NOT export `TOOL_ROLES` if you can avoid it; `isToolRole` is the public surface.
- **claude-code reaches a tool role ONLY via `child.config`, never via a tier.** No `TIER_POLICY`
  entry (tier-policy.ts:50-71) sets `provider:"claude-code"`. So EVERY guard test that triggers a
  violation MUST construct it via `child.config.generator.provider="claude-code"` (or curator/
  evaluator/codeReview), NOT via `tier`. The clean/no-throw tests should still include a `tier`-carrying
  child to prove tiers pass (sc-3-5/sc-3-7).
- **`buildChildConfig` Zod-parses (`BoberConfigSchema.parse`, child-config.ts:52).** When building a
  resolved config in tests, prefer calling `buildChildConfig` over hand-crafting a `BoberConfig`
  literal — a hand-crafted literal must satisfy the strict schema (e.g. `evaluator.strategies: []`,
  see role-providers.test.ts:29). Going through `buildChildConfig` guarantees a valid resolved config.
- **`validateManifest` (never-throw) MUST stay UNCHANGED.** The contract repeatedly distinguishes
  the never-throw `validateManifest` from the new throwing `assertManifest`. They are SEPARATE: do
  NOT add throwing logic to `manifest.ts`'s `FleetManifestSchema.parse` path or to
  `validateManifestCredentials`. The guard is its own module + its own call.
- **No-flag path byte-identical (sc-3-7).** A clean manifest must pass `assertManifest` with no throw
  and no side effects (no logging, no mutation). `check`/`assertManifest` do not log — keep it that way.
- **Insertion ordering matters for the test.** If you place `assertManifest` AFTER
  `validateManifestCredentials`, the sc-3-6 test must set `DEEPSEEK_API_KEY` (else the credential
  check throws first and the test asserts the wrong error). Placing `assertManifest` FIRST
  (recommended) makes the tool-role error fire before credentials, simplifying the test.
- **Do NOT wire the guard into `runFleetExpand`/`runFleetExpandDeep` directly.** They chain into
  `runFleet` (index.ts:231-232, 361-362), which runs the guard. Adding it again would double-check.
- **ESLint hard gates:** `import type` for ALL type-only imports (`RoleName`, `FleetChild`,
  `FleetManifest`, `BoberConfig`); `.js` on every relative import; no `any` (use the established
  `as unknown as FleetCoordinator` cast for fakes, index.test.ts:39). Unused params get `_` prefix.
- **No new SDK/network imports (sc-3-8).** The guard is pure config inspection — import only from
  `../config/role-providers.js`, `./child-config.js`, `./manifest.js`, `../config/schema.js`.
