# Sprint Briefing: Fleet manifest schema, loader, and child config builder

**Contract:** sprint-spec-20260609-fleet-orchestrator-1
**Generated:** 2026-06-09T00:00:00Z

---

## 1. Target Files

All four files are `create` (no `src/fleet/` directory exists yet — verified `ls src/fleet/` → "no fleet dir").

### src/fleet/manifest.ts (create)

**Directory pattern:** New module. Sibling modules like `src/config/` use kebab-case filenames (`role-providers.ts`, `loader.ts`), Zod schemas at top, inferred types via `z.infer`, `export function`/`export const`. Follow that.
**Most similar existing file:** `src/config/schema.ts` (Zod schema + `z.infer` types + factory function) and `src/config/loader.ts` (an async `load`-style function reading a JSON file).

**Structure template (mirrors src/config/schema.ts):**
```ts
import { z } from "zod";
import { readFile } from "node:fs/promises";

// ── Schemas ──────────────────────────────────────────────
export const FleetChildSchema = z.object({
  folder: z.string().min(1),
  task: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
});
export type FleetChild = z.infer<typeof FleetChildSchema>;

export const FleetManifestSchema = z.object({
  rootDir: z.string().default("."),
  concurrency: z.number().int().min(1).default(3),
  children: z.array(FleetChildSchema).min(1),
});
export type FleetManifest = z.infer<typeof FleetManifestSchema>;

// ── Loader ───────────────────────────────────────────────
export async function load(manifestPath: string): Promise<FleetManifest> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf-8");
  } catch (err) {
    throw new Error(`Failed to read fleet manifest at "${manifestPath}": ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Fleet manifest at "${manifestPath}" is not valid JSON: ${(err as Error).message}`);
  }
  return FleetManifestSchema.parse(parsed); // ZodError naming the failing path propagates
}
```
> The contract `generatorNotes` allows `FleetManifestLoader` OR a `load` function. A bare `load` function (above) is simplest and satisfies sc-1-4. If you prefer a class, wrap the same logic in `export const FleetManifestLoader = { load }`.

**Imports this file uses:** `zod` (z); `node:fs/promises` (`readFile`).

---

### src/fleet/child-config.ts (create)

**Most similar existing file:** `src/config/schema.ts` `createDefaultConfig` (the factory it calls) and `src/config/role-providers.ts` (imports `BoberConfig` as a type, reads `provider`/`endpoint` fields).

**Structure template:**
```ts
import { createDefaultConfig, BoberConfigSchema } from "../config/schema.js";
import type { BoberConfig } from "../config/schema.js";
import type { FleetChild } from "./manifest.js";

// DeepSeek (openai-compat) provider overlay — see src/providers/factory.ts
const DEEPSEEK_PROVIDER = "openai-compat";
const DEEPSEEK_ENDPOINT = "https://api.deepseek.com";
const DEEPSEEK_MODEL = "deepseek-v4-pro";

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

  const merged: BoberConfig = { ...base, ...(child.config ?? {}) };
  return BoberConfigSchema.parse(merged); // guarantee validity by construction (sc-1-6/sc-1-7)
}
```
> `createDefaultConfig` signature is `(projectName: string, mode: ProjectMode, preset?, overrides?)` — see src/config/schema.ts:379-384. Pass `child.folder` (or `child.task`) as projectName and a mode (`"greenfield"` or `"brownfield"` — both valid; greenfield gives a lighter default strategy set).
> `child.config` is `Record<string, unknown>` (optional). Spreading it over a typed `BoberConfig` produces a wider object; `BoberConfigSchema.parse(merged)` both validates AND narrows the return type — so the function genuinely returns a `BoberConfig`. Cast the merge target if tsc complains: `const merged = { ...base, ...(child.config ?? {}) };` then `return BoberConfigSchema.parse(merged);`.

---

## 2. Patterns to Follow

### Zod schema + inferred type
**Source:** `src/config/schema.ts`, lines 56-70, 83-91
```ts
export const PlannerSectionSchema = z.object({
  maxClarifications: z.number().int().min(0).default(5),
  model: ModelChoiceSchema.default("opus"),
  provider: z.string().optional(),
  endpoint: z.string().nullable().optional(),
  providerConfig: z.record(z.string(), z.unknown()).optional(),
});
export type PlannerSection = z.infer<typeof PlannerSectionSchema>;
```
**Rule:** Define `XxxSchema = z.object({...})` then `export type Xxx = z.infer<typeof XxxSchema>;`. Use `.default(...)`, `.optional()`, `.min(1)`, `.int()`, and `z.record(z.string(), z.unknown())` exactly as shown.

### provider/endpoint/providerConfig section shape
**Source:** `src/config/schema.ts:87-89` (planner), `98-100` (generator), `109-111` (evaluator)
```ts
provider: z.string().optional(),
endpoint: z.string().nullable().optional(),
providerConfig: z.record(z.string(), z.unknown()).optional(),
```
**Rule:** `endpoint` is `string | null | undefined`. `provider` is a plain string. These three fields exist on planner, generator, AND evaluator sections — set the DeepSeek overlay on all three (sc-1-6).

### DeepSeek = openai-compat at api.deepseek.com
**Source:** `src/providers/factory.ts:244-260` and `src/orchestrator/model-resolver.ts:38, 79-85`
```ts
// factory.ts: openai-compat requires resolvedEndpoint; DeepSeek key fallback keyed on the endpoint host
case "openai-compat": {
  if (!resolvedEndpoint) throw new Error('OpenAI-compatible provider requires an endpoint. ...');
  const compatKey = apiKey ?? (resolvedEndpoint.includes("api.deepseek.com") ? process.env["DEEPSEEK_API_KEY"] : undefined);
  return new OpenAICompatAdapter(resolvedEndpoint, resolvedModelId, compatKey);
}
// model-resolver.ts:38 — deepseek shorthand → openai-compat / deepseek-v4-pro
// model-resolver.ts:79-85 — openai-compat shorthand attaches endpoint "https://api.deepseek.com"
```
**Rule:** The DeepSeek provider string is `"openai-compat"`, the endpoint is `"https://api.deepseek.com"` (no trailing path), and the model id is `"deepseek-v4-pro"`. The API key comes from `providerConfig.apiKey` OR `DEEPSEEK_API_KEY` env — but DO NOT validate the key in this sprint (out of scope; Sprint 4). Setting `provider + endpoint` is sufficient.

### Section comments
**Source:** `src/config/schema.ts:3, 72, 332`
```ts
// ── Section Name ──────────────────────────────────────────────
```
**Rule:** Use unicode box-drawing headers for long files (principles.md:32).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `createDefaultConfig` | `src/config/schema.ts:379` | `(projectName: string, mode: ProjectMode, preset?: string, overrides?: Partial<Omit<BoberConfig,"project">>): BoberConfig` | Produces a schema-valid full default config. USE THIS as the base — do not hand-build a config. |
| `BoberConfigSchema` | `src/config/schema.ts:334` | `z.object` | The validation gate (ADR-2). `.parse()` the merged result to guarantee validity. |
| `BoberConfig` (type) | `src/config/schema.ts:356` | `z.infer<typeof BoberConfigSchema>` | The return type of `buildChildConfig`. Import as `import type`. |
| `ProjectMode` (type) | `src/config/schema.ts:6` | `"greenfield" \| "brownfield"` | Mode arg for createDefaultConfig. |
| `resolveProviderModel` | `src/orchestrator/model-resolver.ts:57` | `(model: string, explicitProvider?: string): ResolvedModel` | Maps shorthand→provider/endpoint. NOT needed if you hardcode the DeepSeek overlay, but it confirms the canonical values (deepseek → openai-compat / api.deepseek.com). |
| `loadConfig` | `src/config/loader.ts` | async | Existing JSON-config loader pattern — reference for the `load()` error-handling style. Do NOT reuse for the manifest (different schema). |

Directories reviewed: `src/config/` (createDefaultConfig, schema, loader). `src/utils/` was not searched in depth — no general JSON-loader util is needed; `node:fs/promises.readFile` + `JSON.parse` + `z.parse` is the established pattern (see src/config/loader.test.ts).

---

## 4. Prior Sprint Output

No prior sprints completed (`dependsOn: []`). This sprint is the deterministic foundation; Sprints 2-4 (scaffolding, fan-out, CLI) consume `FleetManifest`, `FleetChild`, `load`, and `buildChildConfig` from this module.

---

## 5. Relevant Documentation

### Project Principles (.bober/principles.md)
- **ESM everywhere:** every relative import ends in `.js` (e.g. `from "../config/schema.js"`, `from "./manifest.js"`). (line 27)
- **Zod for config validation:** runtime config uses `z.parse()`; no hand-rolled validation. (line 29)
- **No synchronous fs:** all fs via `node:fs/promises`. No `readFileSync`. (line 42)
- **No test mocks for filesystem:** tests create temp dirs and clean up. (line 44)
- **Use `import type`:** `consistent-type-imports` is enforced — types via `import type {...}`. (line 35)
- **No `any`:** use `unknown` + narrowing. (line 40)
- **No SDK leakage:** never import provider SDKs outside `providers/` adapters. (line 41) — this sprint touches no SDKs; just set string fields.
- **Section comments:** unicode box-drawing headers. (line 32)

### Architecture Decisions
ADR-2 (config-validity risk) is referenced in the contract: `createDefaultConfig` + `BoberConfigSchema` are the source of schema-correct defaults and the validation gate. This sprint tackles that risk by building from the factory and `.parse()`-ing the result. No standalone ADR file required for this sprint.

### Other Docs
`CLAUDE.md` global rule: tokensave is initialised — irrelevant to generation.

---

## 6. Testing Patterns

### Unit Test Pattern
**Source:** `src/config/loader.test.ts:1-33`
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "./manifest.js";

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-fleet-"));
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});
```
**Runner:** vitest
**Assertion style:** `expect(...)`. For thrown async errors use `await expect(fn()).rejects.toThrow(/regex/)` (see loader.test.ts:50).
**Mock approach:** `vi.mock` ONLY for logger if you emit logs; NEVER mock fs (principles.md:44). This module emits no logs, so no mock needed.
**File naming:** `*.test.ts` collocated next to source.
**Location:** co-located (`src/fleet/manifest.test.ts`, `src/fleet/child-config.test.ts`).

**Required test cases (from success criteria):**
- sc-1-4: write a valid manifest JSON to tmpDir, `load()` it, assert returned shape (rootDir default ".", concurrency default 3, children populated).
- sc-1-5 (four invalid paths): (a) missing file → `load(join(tmpDir,"nope.json"))` rejects; (b) bad JSON → write `"{not json"` → rejects mentioning JSON; (c) empty children `[]` → rejects (Zod `.min(1)`); (d) `concurrency: 0` → rejects. Assert the error message names the field/path.
- sc-1-6: `BoberConfigSchema.parse(buildChildConfig({folder:"x",task:"t"}))` does not throw; assert `result.generator.provider === "openai-compat"`, `result.planner.provider === "openai-compat"`, `result.evaluator.provider === "openai-compat"`, and endpoint `=== "https://api.deepseek.com"`.
- sc-1-7: `buildChildConfig({folder:"x",task:"t",config:{commands:{build:"npm run build"}}})` → assert merged top-level key (`commands`) is the child value and an untouched key (e.g. `generator.provider`) still equals the base; result still parses.

> No E2E/Playwright applicable — this is a pure library module.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| (none yet) | — | low | This is a brand-new `src/fleet/` module. No existing file imports from it. |
| `src/config/schema.ts` | imported BY new files | low | Read-only import of `createDefaultConfig`/`BoberConfigSchema`/`BoberConfig`. No modification of schema.ts — do NOT edit it. |

### Existing Tests That Must Still Pass
- `src/config/schema.test.ts` — covers createDefaultConfig + BoberConfigSchema; must remain green (you are only consuming these, not changing them).
- `src/config/loader.test.ts` — the pattern source; unchanged.
- Entire suite (sc-1-8): no existing file is modified, so the only risk is a compile error in the new files breaking `tsc`-based test discovery.

### Features That Could Be Affected
- **Fleet Orchestrator (this plan, later sprints)** — share `src/fleet/manifest.ts` + `child-config.ts`. Keep exports stable: `FleetManifestSchema`, `FleetChildSchema`, `FleetManifest`, `FleetChild`, `load` (or `FleetManifestLoader`), `buildChildConfig`. Sprints 2-4 will import these names.

### Recommended Regression Checks
1. `npm run build` (tsc) — zero errors.
2. `npx tsc --noEmit` — zero type errors (sc-1-2).
3. `npm run lint` (or `npx eslint src/fleet`) — zero errors (consistent-type-imports, no unused, `.js` extensions).
4. `npm test` — full vitest suite, zero failures (sc-1-8); confirm new `src/fleet/*.test.ts` pass.

---

## 8. Implementation Sequence

1. **src/fleet/manifest.ts** — define `FleetChildSchema`, `FleetManifestSchema`, inferred types, and async `load()`.
   - Verify: `npx tsc --noEmit` compiles; imports use `.js` and `import type` where applicable.
2. **src/fleet/child-config.ts** — import from `../config/schema.js` and `./manifest.js`; implement `buildChildConfig` with DeepSeek overlay + shallow merge + `BoberConfigSchema.parse`.
   - Verify: compiles; `buildChildConfig({folder:"x",task:"t"})` returns without throwing in a quick scratch check (or rely on the test).
3. **src/fleet/manifest.test.ts** — valid load + four invalid-load cases using `mkdtemp`/`rm` (no fs mock).
   - Verify: `npx vitest run src/fleet/manifest.test.ts` green.
4. **src/fleet/child-config.test.ts** — base config validity (sc-1-6) + shallow-merge case (sc-1-7).
   - Verify: `npx vitest run src/fleet/child-config.test.ts` green.
5. **Run full verification** — `npm run build`, `npx tsc --noEmit`, `npm run lint`, `npm test`.

---

## 9. Pitfalls & Warnings

- **DO NOT edit `src/config/schema.ts`.** Only consume `createDefaultConfig`, `BoberConfigSchema`, `BoberConfig`. Editing it risks breaking `schema.test.ts` and many dependents.
- **`endpoint` must be `"https://api.deepseek.com"`** (no `/v1`, no trailing slash). factory.ts:131/255 keys the DeepSeek API-key fallback on the substring `api.deepseek.com`. The Ollama path uses `/v1`; DeepSeek does NOT.
- **Provider string is `"openai-compat"`, not `"deepseek"`.** `"deepseek"` is only a model SHORTHAND (model-resolver.ts:38); the provider name in `ProviderName` is `openai-compat` (factory.ts:13).
- **Shallow merge only.** `{ ...base, ...child.config }` — a child key like `generator` REPLACES the whole base `generator` object (no deep merge). This is intentional (nonGoals + sc-1-7). Document it, do not deep-merge.
- **`.parse()` narrows the type.** When you spread `child.config` (`Record<string, unknown>`) over `base`, the merged object is wider than `BoberConfig`. `BoberConfigSchema.parse(merged)` returns a true `BoberConfig` and also enforces sc-1-7's "still validates". If tsc objects to the merge target type, type it as the spread literal and let `.parse` produce the typed return.
- **Do NOT validate `DEEPSEEK_API_KEY`** in this sprint (outOfScope — Sprint 4 fail-fast). Setting provider/endpoint is enough; `BoberConfigSchema` does not require a key.
- **ESM `.js` extensions on every relative import** (`../config/schema.js`, `./manifest.js`) — eslint will error otherwise.
- **`import type` for `BoberConfig`, `FleetChild`, `ProjectMode`** — values (`createDefaultConfig`, `BoberConfigSchema`, `z`, `readFile`) are regular imports. `consistent-type-imports` is enforced.
- **Let Zod/JSON errors propagate** with a wrapping message naming the manifest path (sc-1-5). Do not swallow them or return a default.
