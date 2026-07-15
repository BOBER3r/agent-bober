# Sprint Briefing: TierProviderPolicy + buildChildConfig tier overlay

**Contract:** sprint-spec-20260618-fleet-tier-provider-routing-2
**Generated:** 2026-06-18T00:00:00Z

---

## 0. TL;DR for the Generator

Three production changes + their collocated tests:

1. **NEW `src/fleet/tier-policy.ts`** — `DifficultyTier` union, `RoleProviderBlock`, `TieredRoleBlock`, a `TIER_POLICY` table (cheap/standard/hard/frontier), and `tierPolicy: TierProviderPolicy` with `resolveTier()` / `knownTiers()`. `'default'` and `undefined` -> `undefined` (NO overlay). **`claude-code` must NEVER appear in any block.**
2. **MODIFY `src/fleet/manifest.ts`** — add `tier: z.enum([...]).optional()` to `FleetChildSchema` (manifest.ts:6-10).
3. **MODIFY `src/fleet/child-config.ts`** — insert an `applyTier` overlay on `base` AFTER the three DeepSeek hard-sets (child-config.ts:24-41) and BEFORE the UNCHANGED `const merged = { ...base, ...(child.config ?? {}) }` at child-config.ts:43. When the block is `undefined`, output is byte-identical to today.

The byte-identical guarantee is the critical success criterion (sc-2-5). The overlay-before-merge ordering is what preserves child.config precedence (sc-2-7).

---

## 1. Target Files

### src/fleet/tier-policy.ts (create)

**Directory pattern:** Files in `src/fleet/` are kebab-case `.ts` modules with collocated `.test.ts` (e.g. `child-config.ts` + `child-config.test.ts`, `manifest.ts` + `manifest.test.ts`). Section headers use unicode box-drawing (`// ── Name ──────`).

**Most similar existing file:** `src/fleet/child-config.ts` (imports a type from `../providers`-adjacent code via model-resolver indirection; uses unicode section headers; exports a single typed function). Also mirror `src/fleet/types.ts` for a pure type/const module.

**ProviderName source — import this exact type (factory.ts:13):**
```ts
export type ProviderName = "anthropic" | "openai" | "google" | "openai-compat" | "claude-code";
```
Import it with `import type { ProviderName } from "../providers/factory.js";` (ESM `.js` extension, `import type` — both are hard lint gates, see §5).

**Structure template (based on child-config.ts header style + contract recipe):**
```ts
import type { ProviderName } from "../providers/factory.js";

// ── Types ────────────────────────────────────────────────────────────

export type DifficultyTier = "default" | "cheap" | "standard" | "hard" | "frontier";

export interface RoleProviderBlock {
  provider: ProviderName;
  model: string;
  endpoint?: string | null;
}

export interface TieredRoleBlock {
  planner: RoleProviderBlock;
  generator: RoleProviderBlock;
  evaluator: RoleProviderBlock;
}

// ── Tier policy table ────────────────────────────────────────────────

const TIER_POLICY: Record<Exclude<DifficultyTier, "default">, TieredRoleBlock> = {
  cheap: { /* all three roles -> DeepSeek block */ },
  standard: { /* all three roles -> Grok block */ },
  hard: { /* all three roles -> anthropic Sonnet block */ },
  frontier: { /* all three roles -> anthropic Opus block */ },
};

// ── Policy API ───────────────────────────────────────────────────────

export interface TierProviderPolicy {
  resolveTier(tier?: DifficultyTier): TieredRoleBlock | undefined;
  knownTiers(): DifficultyTier[];
}

export const tierPolicy: TierProviderPolicy = {
  resolveTier(tier) {
    return tier && tier !== "default" ? TIER_POLICY[tier] : undefined;
  },
  knownTiers() {
    return ["default", "cheap", "standard", "hard", "frontier"];
  },
};
```

**Exact per-role block VALUES (see §4 for why these match a parsed config):**

| Tier | provider | model | endpoint |
|------|----------|-------|----------|
| `cheap` | `"openai-compat"` | `"deepseek"` | `"https://api.deepseek.com"` |
| `standard` | `"openai-compat"` | `"grok"` | `"https://api.x.ai/v1"` |
| `hard` | `"anthropic"` | `"sonnet"` | `null` |
| `frontier` | `"anthropic"` | `"opus"` | `null` |

> The same `RoleProviderBlock` is used for all three roles within a tier (planner == generator == evaluator), per the contract recipe (generatorNotes: "cheap: all three roles -> {provider:'openai-compat', model:'deepseek', endpoint:'https://api.deepseek.com'}", etc.).

> **Model id choice:** The contract's generatorNotes explicitly specify `model:'deepseek'`, `model:'grok'`, `model:'sonnet'`, `model:'opus'` (the model-resolver shorthands, NOT full ids). These are the resolver keys in `src/orchestrator/model-resolver.ts:27` (`sonnet`), `:24` (`opus`), `:38` (`deepseek`), `:42` (`grok`) — all valid. Tests in sc-2-6 assert provider+endpoint and a Sonnet/Opus *model* — using the shorthand string `"sonnet"`/`"opus"` satisfies "a Sonnet model"/"an Opus model". Use the shorthands.

---

### src/fleet/manifest.ts (modify)

**Relevant section (lines 6-11) — add ONE field to `FleetChildSchema`:**
```ts
export const FleetChildSchema = z.object({
  folder: z.string().min(1),
  task: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
  // ── ADD THIS LINE ──
  tier: z.enum(["default", "cheap", "standard", "hard", "frontier"]).optional(),
});
export type FleetChild = z.infer<typeof FleetChildSchema>;
```
Keep `config` field. `FleetManifestSchema` (manifest.ts:13-17) is UNCHANGED — it already wraps `FleetChildSchema` in `z.array(...)`.

**Imports this file uses:** `readFile` from `node:fs/promises`; `z` from `zod`. No new imports needed.

**Imported by (FleetChild / FleetManifest consumers — all keep working because `tier` is optional & additive):**
- `src/fleet/child-config.ts` (imports `type FleetChild`) — the only consumer that reads `child.tier` (you add that read).
- `src/fleet/scaffolder.ts:5,57` — calls `buildChildConfig(child)`; passes `child` through to it. No change needed: a child with `tier` flows through transparently.
- `src/fleet/decomposer.ts` / `decomposer-deep.ts` — EMIT children with only `folder`+`task` (decomposer.ts:21 "Each child carries ONLY folder and task"). The decomposer has a guard rejecting a `config` key (decomposer.ts:142-150) but does NOT reject `tier`; an absent `tier` is fine. **Do NOT touch the decomposer (nonGoal).**
- `src/fleet/coordinator.ts`, `index.ts`, `manifest-write.ts`, `expand*.ts`, `critic-deep.ts` — consume `FleetManifest`; unaffected by an optional additive field.

**Test file:** `src/fleet/manifest.test.ts` (EXISTS, 91 lines) — add tier parse cases here.

---

### src/fleet/child-config.ts (modify)

**EXACT current body (the whole file is 45 lines — these are the load-bearing parts):**

Constants (child-config.ts:5-9):
```ts
const DEEPSEEK_PROVIDER = "openai-compat";
const DEEPSEEK_ENDPOINT = "https://api.deepseek.com";
const DEEPSEEK_MODEL = "deepseek-v4-pro";
```

DeepSeek hard-set + merge + parse (child-config.ts:21-45) — insert the overlay between line 41 and line 43:
```ts
export function buildChildConfig(child: FleetChild): BoberConfig {
  const base = createDefaultConfig(child.folder, "greenfield");

  base.planner = {
    ...base.planner,
    model: DEEPSEEK_MODEL,
    provider: DEEPSEEK_PROVIDER,
    endpoint: DEEPSEEK_ENDPOINT,
  };
  base.generator = {
    ...base.generator,
    model: DEEPSEEK_MODEL,
    provider: DEEPSEEK_PROVIDER,
    endpoint: DEEPSEEK_ENDPOINT,
  };
  base.evaluator = {
    ...base.evaluator,
    model: DEEPSEEK_MODEL,
    provider: DEEPSEEK_PROVIDER,
    endpoint: DEEPSEEK_ENDPOINT,
  };

  // ◀── INSERT THE TIER OVERLAY HERE (after :41, before :43) ──▶

  const merged = { ...base, ...(child.config ?? {}) };   // ← UNCHANGED (child-config.ts:43)
  return BoberConfigSchema.parse(merged);                // ← UNCHANGED (child-config.ts:44)
}
```

**Exact insertion to add (between line 41 and the `const merged` line):**
```ts
  const block = tierPolicy.resolveTier(child.tier);
  if (block) {
    base.planner = { ...base.planner, ...block.planner };
    base.generator = { ...base.generator, ...block.generator };
    base.evaluator = { ...base.evaluator, ...block.evaluator };
  }
```
When `child.tier` is `undefined` or `"default"`, `resolveTier` returns `undefined`, the `if` is skipped, and `base` is unchanged -> the function output is byte-identical to today (sc-2-5). Because this mutates `base` BEFORE the `const merged = { ...base, ...(child.config ?? {}) }` line, an explicit `child.config.<role>` still fully replaces the role (shallow-merge semantics: a top-level key in child.config overwrites the whole role object) -> child.config wins (sc-2-7).

**New import to add at the top of child-config.ts:**
```ts
import { tierPolicy } from "./tier-policy.js";
```
(Existing imports at child-config.ts:1-3 stay: `BoberConfigSchema`/`createDefaultConfig` value imports from `../config/schema.js`, `type BoberConfig` from `../config/schema.js`, `type FleetChild` from `./manifest.js`.)

**Imported by:**
- `src/fleet/scaffolder.ts:4,57` — `JSON.stringify(buildChildConfig(child), null, 2)` writes the per-child `bober.config.json`. Signature `buildChildConfig(child: FleetChild): BoberConfig` is UNCHANGED, so the scaffolder is unaffected.
- `src/fleet/index.ts` — re-exports / wires fleet.

**Test file:** `src/fleet/child-config.test.ts` (EXISTS, 56 lines) — add tier overlay + byte-identical + precedence tests here.

---

## 2. Patterns to Follow

### Pattern A — Zod schema + inferred type, collocated
**Source:** `src/fleet/manifest.ts`, lines 6-11
```ts
export const FleetChildSchema = z.object({
  folder: z.string().min(1),
  task: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
});
export type FleetChild = z.infer<typeof FleetChildSchema>;
```
**Rule:** Define the schema, then `export type X = z.infer<typeof XSchema>`. Use `z.enum([...]).optional()` for a closed, optional set (matches sc-2-3: a value outside the enum is a `ZodError`).

### Pattern B — Per-role section shape uses `provider`/`endpoint`/`model`
**Source:** `src/config/schema.ts`, lines 83-118 (Planner/Generator/Evaluator sections)
```ts
// PlannerSectionSchema (and Generator/Evaluator are structurally the same for these 3 fields)
model: ModelChoiceSchema.default("opus"),        // generator/evaluator default "sonnet"
provider: z.string().optional(),                  // plain string, NOT a closed enum
endpoint: z.string().nullable().optional(),       // <-- nullable AND optional
```
**Rule:** A role section's `endpoint` is `z.string().nullable().optional()`. So `endpoint: null` and `endpoint: undefined` (omitted) are BOTH valid for an anthropic role. `provider` is `z.string().optional()` — it accepts any string, so `ProviderName` literals all parse. See §4 for the byte-identical implication.

### Pattern C — ESM `.js` import + `import type`
**Source:** `src/fleet/child-config.ts`, lines 1-3
```ts
import { BoberConfigSchema, createDefaultConfig } from "../config/schema.js";
import type { BoberConfig } from "../config/schema.js";
import type { FleetChild } from "./manifest.js";
```
**Rule:** Every relative import ends in `.js`. Type-only imports use `import type` (ESLint `consistent-type-imports` is a hard gate — principles.md:35).

### Pattern D — Unicode section headers
**Source:** `src/fleet/child-config.ts`, lines 5, 11; `src/config/schema.ts:3,72`
```ts
// ── DeepSeek / openai-compat constants ──────────────────────────────
```
**Rule:** Organize files with `// ── Section Name ──────` box-drawing headers (principles.md:32).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `ProviderName` | `src/providers/factory.ts:13` | `type = "anthropic"\|"openai"\|"google"\|"openai-compat"\|"claude-code"` | The closed provider union — `RoleProviderBlock.provider` must be this type. Import it; do NOT redefine. |
| `BoberConfigSchema` | `src/config/schema.ts:405` | `z.object({...})` | Validates the full config. Used in `BoberConfigSchema.parse(merged)` and in tests to build the EXPECTED config (defaults applied). |
| `createDefaultConfig` | `src/config/schema.ts:458` | `(projectName, mode, preset?, overrides?) => BoberConfig` | Builds the default config base. `buildChildConfig` already calls it with `(child.folder, "greenfield")`. Use it to build the expected config in the deep-equal test. |
| `FleetChild` / `FleetChildSchema` | `src/fleet/manifest.ts:6,11` | zod object + inferred type | The child shape you extend with `tier`. |
| `buildChildConfig` | `src/fleet/child-config.ts:21` | `(child: FleetChild) => BoberConfig` | The function under test; you add the overlay inside it. |
| `resolveProviderModel` | `src/orchestrator/model-resolver.ts:61` | `(model, explicitProvider?) => ResolvedModel` | Confirms shorthand -> provider/endpoint at RUNTIME (createClient uses it). NOT called by tier-policy or child-config (those carry the provider/endpoint explicitly), but it is the source of truth that `grok`->`api.x.ai/v1`, `deepseek`->`api.deepseek.com`, `sonnet`->anthropic, `opus`->anthropic. |
| `isXaiEndpoint` | `src/providers/factory.ts:83` | `(endpoint?) => boolean` | Matches the `api.x.ai` host. NOT needed in this sprint — informational (it's why the standard tier endpoint must be `https://api.x.ai/v1`). |

Utilities reviewed: `src/utils/` (fs/git/logger — not applicable to a pure mapping module), `src/config/schema.ts`, `src/providers/factory.ts`, `src/orchestrator/model-resolver.ts`, `src/fleet/*`. No string/object merge helper exists or is needed — use the spread `{ ...base.role, ...block.role }` already used at child-config.ts:24,30,36.

---

## 4. CRITICAL — Why the Byte-Identical Guarantee Holds (sc-2-5)

The contract's #1 risk is that adding the overlay changes the no-tier output. It does NOT, because:

- `resolveTier(undefined)` and `resolveTier("default")` both return `undefined` (the `tier && tier !== "default"` guard), so the `if (block)` body never runs.
- `base` is therefore exactly what it was at child-config.ts:41 — the three DeepSeek hard-sets.
- `const merged = { ...base, ...(child.config ?? {}) }` and `BoberConfigSchema.parse(merged)` are textually unchanged.

**Building the EXPECTED config in the deep-equal test** — mirror what `buildChildConfig` does (do NOT hand-write the whole object; let `createDefaultConfig` + the same hard-sets supply the defaults so fields match exactly):
```ts
import { createDefaultConfig, BoberConfigSchema } from "../config/schema.js";

function expectedDeepSeekConfig(folder: string): BoberConfig {
  const base = createDefaultConfig(folder, "greenfield");
  for (const role of ["planner", "generator", "evaluator"] as const) {
    base[role] = {
      ...base[role],
      model: "deepseek-v4-pro",
      provider: "openai-compat",
      endpoint: "https://api.deepseek.com",
    };
  }
  return BoberConfigSchema.parse({ ...base });   // parse so defaults (panel{}, etc.) match the SUT
}
// ...
expect(buildChildConfig({ folder: "x", task: "t" })).toEqual(expectedDeepSeekConfig("x"));
```
> Both sides go through `BoberConfigSchema.parse`, so zod-applied defaults (e.g. `evaluator.panel`, `pipeline.*`) are present identically on both. `.toEqual` (deep structural) is the assertion.

**Anthropic-tier endpoint and the parsed config (hard/frontier):** `endpoint` on a role section is `z.string().nullable().optional()` (schema.ts:88,99,110). The default base role objects from `createDefaultConfig` (schema.ts:470-490) DO NOT set `endpoint` at all (it's absent/undefined). For `hard`/`frontier`, the recipe sets `endpoint: null`. After the spread `{ ...base.planner, ...block.planner }`, `endpoint` becomes `null`. `BoberConfigSchema.parse` ACCEPTS `null` (nullable). So in sc-2-6 the parsed anthropic role will have `endpoint === null`. If you instead set `endpoint: undefined` in the block, the spread leaves `endpoint` absent and the parsed role has no `endpoint` key. **The contract recipe says `endpoint: null` for anthropic tiers — use `null`** and assert `endpoint` is `null` (or simply assert `provider === "anthropic"` and the model, per evaluatorNotes sc-2-6 which checks provider+endpoint+model). Be consistent so the test matches the block.

---

## 5. Relevant Documentation

### Project Principles (.bober/principles.md)
- **ESM everywhere; `.js` import extensions** (principles.md:27) — every relative import ends `.js`.
- **Provider-agnostic interfaces** (principles.md:28) — do NOT import an SDK; `RoleProviderBlock.provider` uses the `ProviderName` union from the factory, not an SDK type. (sc-2-8: "no new SDK/network imports".)
- **Zod for config validation** (principles.md:29) — the `tier` field is a `z.enum`, not hand-rolled.
- **Section comments** with unicode box headers (principles.md:32).
- **`import type`** enforced by `consistent-type-imports` (principles.md:35) — import `ProviderName`, `BoberConfig`, `FleetChild`, `TieredRoleBlock` etc. as `import type`.
- **Collocated tests** `*.test.ts` next to `*.ts` (principles.md:20) — `tier-policy.test.ts` lives beside `tier-policy.ts`.
- **Prefix unused params with `_`** (principles.md:36).

### Architecture Decisions
- **ADR-2** (`.bober/architecture/arch-20260618-heterogeneous-multi-provider-agent-team-adr-2.md`): The tier->provider mapping is a deterministic POST-EXPAND step in `buildChildConfig`, applied BEFORE the shallow-merge at child-config.ts:43; the decomposer/EXPAND prompt is FROZEN. `resolveTier` returns `undefined` for default/absent tier (no overlay). This briefing implements exactly ADR-2.

### Sprint 1 (dependency) output
Grok wired as `openai-compat` at `https://api.x.ai/v1`: shorthands `grok`/`grok-4`/`grok-4-fast` in `model-resolver.ts:42-44`; `isXaiEndpoint()`+`XAI_API_KEY` in `factory.ts:83,151,276`. So the `standard` tier block legitimately routes to Grok via `provider:'openai-compat'` + `endpoint:'https://api.x.ai/v1'` + model `'grok'`. Commit b739ef1.

---

## 6. Testing Patterns

### Unit Test Pattern — pure module (tier-policy.test.ts)
**Source style:** `src/fleet/child-config.test.ts:1-9` (vitest, `describe`/`it`/`expect`, direct import of the SUT)
```ts
import { describe, expect, it } from "vitest";
import { tierPolicy } from "./tier-policy.js";

describe("tierPolicy.resolveTier()", () => {
  it("returns undefined for 'default' and undefined", () => {
    expect(tierPolicy.resolveTier("default")).toBeUndefined();
    expect(tierPolicy.resolveTier(undefined)).toBeUndefined();
  });
  it("maps standard -> Grok openai-compat at api.x.ai/v1", () => {
    const b = tierPolicy.resolveTier("standard");
    expect(b?.generator.provider).toBe("openai-compat");
    expect(b?.generator.endpoint).toBe("https://api.x.ai/v1");
  });
  it("maps hard -> anthropic Sonnet, frontier -> anthropic Opus", () => {
    expect(tierPolicy.resolveTier("hard")?.generator.provider).toBe("anthropic");
    expect(tierPolicy.resolveTier("frontier")?.generator.provider).toBe("anthropic");
  });
  it("never places claude-code on any role", () => {
    for (const t of ["cheap", "standard", "hard", "frontier"] as const) {
      const b = tierPolicy.resolveTier(t)!;
      for (const role of [b.planner, b.generator, b.evaluator])
        expect(role.provider).not.toBe("claude-code");
    }
  });
});
```
> evaluatorNotes also wants a literal grep: there must be NO `"claude-code"` literal anywhere in tier-policy.ts. (sc-2-4 / nonGoal.)

### Unit Test Pattern — schema parse (manifest.test.ts additions)
**Source style:** `src/fleet/manifest.test.ts:17-49` loads from a temp file. For pure schema parse you can also import `FleetChildSchema` directly (simpler, no fs). Match sc-2-3:
```ts
import { FleetChildSchema } from "./manifest.js";
// with each enum value:
expect(() => FleetChildSchema.parse({ folder: "x", task: "t", tier: "standard" })).not.toThrow();
// without tier (still valid):
expect(FleetChildSchema.parse({ folder: "x", task: "t" }).tier).toBeUndefined();
// invalid tier -> ZodError:
expect(() => FleetChildSchema.parse({ folder: "x", task: "t", tier: "bogus" })).toThrow();
```
> The existing temp-file `load()` tests at manifest.test.ts:17-90 MUST still pass unchanged (a no-tier manifest parses field-for-field as before — sc-2-3).

### Unit Test Pattern — child-config overlay + byte-identical + precedence
**Source style:** `src/fleet/child-config.test.ts:5-55` (`buildChildConfig({ folder, task, ... })` then assert on `result.<role>.provider/endpoint`).
- Byte-identical (sc-2-5): build expected via `createDefaultConfig` (see §4) and `expect(buildChildConfig({folder:"x",task:"t"})).toEqual(expectedDeepSeekConfig("x"))`.
- Per-tier (sc-2-6):
```ts
const r = buildChildConfig({ folder: "x", task: "t", tier: "standard" });
expect(r.generator.provider).toBe("openai-compat");
expect(r.generator.endpoint).toBe("https://api.x.ai/v1");
// tier "hard" -> r.generator.provider === "anthropic", model is a Sonnet ("sonnet")
// tier "frontier" -> "anthropic" + Opus ("opus");  tier "cheap" -> DeepSeek
```
- child.config precedence (sc-2-7):
```ts
const r = buildChildConfig({
  folder: "x", task: "t", tier: "standard",
  config: { generator: { provider: "anthropic", model: "sonnet" } },
});
expect(r.generator.provider).toBe("anthropic");   // child.config wins over the tier block
```

**Runner:** vitest. **Assertion style:** `expect(...).toBe/.toEqual/.toThrow/.toBeUndefined`. **Mock approach:** none — pure functions, no fs/network mocks. **File naming:** `<name>.test.ts`. **Location:** collocated (same `src/fleet/` dir).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/fleet/scaffolder.ts` | `buildChildConfig`, `FleetChild` | low | Signature unchanged; passes child through. A child with `tier` flows transparently; scaffold writes the tier-overlaid config. |
| `src/fleet/child-config.ts` | `tier-policy.ts` (new), `FleetChild` | medium | New import + overlay; must remain byte-identical when tier absent. |
| `src/fleet/index.ts` | re-exports fleet | low | Confirm no re-export of a removed/renamed symbol (you only ADD). |
| `src/fleet/decomposer.ts` / `decomposer-deep.ts` | `FleetChildSchema` (via safeParse) | low | Decomposer emits only folder+task and rejects a `config` key (decomposer.ts:142-150) — it does NOT reject/emit `tier`. Optional `tier` does not affect it. **Do NOT modify (nonGoal).** |
| `src/fleet/manifest-write.ts`, `coordinator.ts`, `runner.ts`, `expand*.ts`, `critic-deep.ts` | `FleetManifest`/`FleetChild` | low | Optional additive field; no shape break. |

### Existing Tests That Must Still Pass
- `src/fleet/child-config.test.ts` (current 4+2 tests, child-config.test.ts:5-55) — tests no-tier DeepSeek defaults; MUST pass unchanged (proves byte-identical).
- `src/fleet/manifest.test.ts` (manifest.test.ts:17-90) — temp-file `load()` of no-tier manifests; MUST pass unchanged.
- `src/fleet/scaffolder.test.ts` — exercises `buildChildConfig` output written to disk; verify the written config is still valid.
- `src/fleet/decomposer.test.ts`, `decomposer-deep.test.ts`, `expand*.test.ts`, `index.test.ts`, `coordinator.test.ts` — fleet suite; must stay green.

### Features That Could Be Affected
- **Fleet scaffolding** (`bober fleet <manifest>`) — shares `buildChildConfig`. Verify a tier-less manifest produces the identical per-child `bober.config.json` as before.
- **`fleet expand` decomposer** — shares `FleetChildSchema`. Verify the config-key guard (decomposer.ts:142-150) still rejects `config` and is untouched.

### Recommended Regression Checks (run after implementation)
1. `npm run build` (sc-2-1) — zero TS errors.
2. `npm run typecheck` (sc-2-1) — strict, zero errors.
3. `npm run test -- src/fleet` — fleet suite green; specifically `child-config.test.ts` + `manifest.test.ts` pass unchanged. Then `npm run test` (full) — only the 6 known cockpit-integration MCP failures allowed (sc-2-2).
4. `npm run lint` (sc-2-8) — zero errors; confirm `consistent-type-imports` and `.js` extensions are clean.
5. `grep -n "claude-code" src/fleet/tier-policy.ts` returns NOTHING (sc-2-4 / nonGoal).
6. Confirm `git diff --stat` touches ONLY `tier-policy.ts` (new), `tier-policy.test.ts` (new), `manifest.ts`, `manifest.test.ts`, `child-config.ts`, `child-config.test.ts` (sc-2-8 confinement). `ProviderName` (factory.ts:13) UNCHANGED.

---

## 8. Implementation Sequence

1. **src/fleet/tier-policy.ts** (types + table + policy; no deps except `ProviderName`).
   - Verify: `npx tsc --noEmit` compiles; `ProviderName` imported with `import type` and `.js`.
2. **src/fleet/tier-policy.test.ts** (resolveTier per tier; default/undefined -> undefined; standard endpoint == api.x.ai/v1; hard/frontier -> anthropic; no `"claude-code"` literal anywhere).
   - Verify: `npm run test -- src/fleet/tier-policy.test.ts` green.
3. **src/fleet/manifest.ts** (add `tier: z.enum([...]).optional()` to `FleetChildSchema`; keep `config`).
   - Verify: `FleetChild` type now has optional `tier`; existing manifest tests still pass.
4. **src/fleet/manifest.test.ts** (parse with each enum value, without tier, and `tier:'bogus'` -> ZodError).
   - Verify: `npm run test -- src/fleet/manifest.test.ts` green; the existing `load()` tests untouched and passing.
5. **src/fleet/child-config.ts** (add `import { tierPolicy } from "./tier-policy.js";`; insert the `const block = tierPolicy.resolveTier(child.tier); if (block) {...}` overlay between :41 and the UNCHANGED `const merged` line). Do NOT touch `const merged` or `BoberConfigSchema.parse`.
   - Verify: existing child-config tests pass unchanged (byte-identical) BEFORE adding new ones.
6. **src/fleet/child-config.test.ts** (deep-equal byte-identical no-tier via `expectedDeepSeekConfig`; per-tier provider/endpoint/model; child.config-wins-over-tier precedence).
   - Verify: `npm run test -- src/fleet/child-config.test.ts` green.
7. **Run full verification** — `npm run build`, `npm run typecheck`, `npm run lint`, `npm run test` (only 6 known cockpit failures permitted).

---

## 9. Pitfalls & Warnings

- **`'default'` is in the enum but maps to NO overlay.** `resolveTier("default")` MUST return `undefined` (guard: `tier && tier !== "default"`). It is a valid manifest value, but produces the DeepSeek-default config. Do not add a `default` entry to `TIER_POLICY`.
- **`TIER_POLICY` key type is `Record<Exclude<DifficultyTier, "default">, TieredRoleBlock>`** — exclude `'default'` so the table has exactly four keys (cheap/standard/hard/frontier). Indexing `TIER_POLICY[tier]` is only reached after the `tier !== "default"` guard, so it is type-safe.
- **Overlay MUST run BEFORE `const merged` (child-config.ts:43)** — that ordering is the entire mechanism for child.config precedence (sc-2-7). Inserting it after the merge would let the tier block override an explicit child.config (WRONG). nonGoal: "Do NOT alter the `merged` line itself (apply the overlay BEFORE it)."
- **anthropic-tier endpoint = `null`, not a string.** Role `endpoint` is `z.string().nullable().optional()` (schema.ts:88,99,110). `null` parses fine. Don't set a bogus endpoint string on anthropic tiers; the AnthropicAdapter does not use an endpoint.
- **NEVER `claude-code` in any tier block.** Children build (TOOL_ROLES). evaluatorNotes greps `tier-policy.ts` for the literal `claude-code` — it must be absent. (nonGoals lines 61-62.)
- **Do NOT recreate `ProviderName`.** Import it from `src/providers/factory.ts:13` (it is exported there). `RoleProviderBlock.provider: ProviderName`. (sc-2-8: ProviderName unchanged, no new SDK imports.)
- **Deep-equal test must parse BOTH sides through `BoberConfigSchema`** so zod defaults (panel `{}`, pipeline fields) match. Hand-writing the full expected object risks a missing default field and a false `.toEqual` failure.
- **Do NOT touch the decomposer / EXPAND prompt / `validateManifest`** (nonGoals line 63). The decomposer's `config`-key guard (decomposer.ts:142-150) is separate and stays.
- **Use `npm run` scripts, not raw `tsc`/`vitest`**, for the gate commands (sc-2-1/2/8 name `npm run build|typecheck|test|lint`).
