# Sprint Briefing: Role-aware provider fallback for claude-code

**Contract:** sprint-spec-20260531-multi-provider-deepseek-claude-code-5
**Generated:** 2026-05-31T00:00:00Z

> HIGHEST-ambiguity sprint (ambiguityScore 5). The config shape and provider-resolution
> semantics are the load-bearing facts. Every field name + line number below was
> verified by reading the file. Do not invent field names.

---

## 0. The One-Paragraph Mental Model

`resolveRoleProviders(config)` runs at config-load time, AFTER schema validation, in
`loadConfig` (`src/config/loader.ts`). For each of 6 roles it computes the role's
*effective provider* = `config.<role>?.provider ?? resolveProviderModel(config.<role>?.model).provider`.
Tool roles = **curator, generator, evaluator, codeReview**. Prompt roles = **planner, researcher**
(there is NO `researcher` config section — see §1.5; treat researcher as planner). If a TOOL role's
effective provider is `"claude-code"`, redirect it to another configured non-claude-code provider if
one exists; otherwise THROW an error naming the role. Prompt roles on claude-code are always allowed.
Log one line per role with its final provider. Return a `Record<RoleName, string>` map.

---

## 1. Target Files

### src/config/role-providers.ts (CREATE — the core helper)

**Directory pattern:** Files in `src/config/` are kebab/lowercase TS modules with `.js` import
extensions (NodeNext ESM). Co-located tests are `*.test.ts`. Existing files: `schema.ts`,
`loader.ts`, `defaults.ts`, `index.ts` (`ls src/config/`).

**Most similar existing file:** `src/providers/preflight.ts` — it is the closest structural twin:
it takes `config: Partial<BoberConfig>`, iterates the same role sections, calls
`resolveProviderModel(section.model, section.provider)`, and uses `logger`. COPY ITS IMPORT BLOCK
AND ITS ROLE-ITERATION SHAPE. See `src/providers/preflight.ts:1-44`.

**Verbatim import block to mirror** (`src/providers/preflight.ts:1-3`):
```ts
import { resolveProviderModel } from "../orchestrator/model-resolver.js";
import { logger } from "../utils/logger.js";
import type { BoberConfig } from "../config/schema.js";
```
(For a file inside `src/config/`, the relative paths become
`../orchestrator/model-resolver.js`, `../utils/logger.js`, and `./schema.js`.)

**Verbatim role-iteration shape to mirror** (`src/providers/preflight.ts:27-44`):
```ts
export function usesOpenaiFamily(config: Partial<BoberConfig>): boolean {
  const sections = [
    config.planner,
    config.curator,
    config.generator,
    config.evaluator,
    config.codeReview,
  ];
  for (const section of sections) {
    if (!section?.model) continue;
    const { provider } = resolveProviderModel(
      section.model,
      section.provider,
    );
    if (OPENAI_FAMILY.has(provider)) return true;
  }
  return false;
}
```

---

### src/config/role-providers.test.ts (CREATE — colocated unit tests)

**Template:** `src/providers/preflight.test.ts:1-18` for vitest + logger-spy setup.
Pass plain `{...} as Partial<BoberConfig>` objects (NO filesystem). For sc-5-5 only,
go through `loadConfig` with a real temp dir (see §6 / loader.test template in §1.4).

---

### src/config/loader.ts (MODIFY — wire the call in)

**Insertion point — verbatim current tail of `loadConfig` (`src/config/loader.ts:244-259`):**
```ts
  const cfg = fullResult.data;

  // Warn when mode='careful' is combined with checkpointMechanism='noop' ...
  if (cfg.pipeline.mode === "careful" && cfg.pipeline.checkpointMechanism === "noop") {
    process.stderr.write(
      "warn: pipeline.mode='careful' with checkpointMechanism='noop' — checkpoints will auto-approve. " +
      "Did you mean 'disk' or 'cli'?\n",
    );
  }

  return cfg;
}
```

**Where to insert:** AFTER `const cfg = fullResult.data;` (line 246) and AFTER the careful/noop
warning block, but BEFORE `return cfg;` (line 258). `cfg` is a fully-validated `BoberConfig` at
that point — the correct typed input for `resolveRoleProviders(cfg)`.

**How errors surface today:** `loadConfig` is `async` and uses `throw new Error(...)` throughout
(lines 144, 153, 163, 178, 241). Because the function is `async`, a thrown error becomes a rejected
Promise — so the sc-5-5 test asserts via `await expect(loadConfig(dir)).rejects.toThrow(/generator/)`.
`resolveRoleProviders` throwing synchronously inside `loadConfig` is sufficient; no try/catch needed —
let it propagate (matching the existing throw-on-invalid-config behavior).

**New import to add at top of loader.ts** (mirror line 10 style):
```ts
import { resolveRoleProviders } from "./role-providers.js";
```

**Imported by (loadConfig has 20+ call sites — DO NOT change its signature):**
- `src/index.ts:15`, `src/config/index.ts:60` (barrel re-exports)
- CLI: `src/cli/commands/{run,sprint,eval,plan,graph,impact,onboard,worktree,telemetry}.ts`
- MCP tools: `src/mcp/tools/{sprint,architect,research,plan,eval,run,brownfield,react,solidity,anchor,run-in-worktree}.ts`, `src/mcp/server.ts`
All call `await loadConfig(projectRoot)` and expect it to throw on bad config — that contract is preserved.

**Test file:** `src/config/loader.test.ts` does NOT exist yet. The sc-5-5 test may be added either
as a new `src/config/loader.test.ts` OR inside `role-providers.test.ts`. The contract estimatedFiles
lists `src/config/loader.test.ts` — prefer creating it.

---

## 1.2. EXACT Config Shape (schema.ts) — the load-bearing facts

**Top-level config object** (`src/config/schema.ts:307-325`):
```ts
export const BoberConfigSchema = z.object({
  project: ProjectSectionSchema,
  planner: PlannerSectionSchema,            // line 309 — REQUIRED
  curator: CuratorSectionSchema.optional(), // line 310 — OPTIONAL
  generator: GeneratorSectionSchema,        // line 311 — REQUIRED
  evaluator: EvaluatorSectionSchema,        // line 312 — REQUIRED
  sprint: SprintSectionSchema,
  pipeline: PipelineSectionSchema,
  commands: CommandsSectionSchema,
  graph: GraphSectionSchema.optional(),
  codeReview: CodeReviewSectionSchema.optional(), // line 317 — OPTIONAL
  observability: ObservabilitySectionSchema.optional(),
  incident: IncidentSectionSchema.optional(),
  telemetry: TelemetrySectionSchema.optional(),
});
export type BoberConfig = z.infer<typeof BoberConfigSchema>; // line 325 — THIS is the config TYPE
```

**Per-role provider/model fields (verified, with line numbers):**

| Role section | provider field | model field | model default | section optional? |
|---|---|---|---|---|
| `planner` (`PlannerSectionSchema` 83-90) | `provider: z.string().optional()` (line 87) | `model` (line 85) | `"opus"` | required |
| `curator` (`CuratorSectionSchema` 122-129) | `provider: z.string().optional()` (line 126) | `model` (line 123) | `"opus"` | **optional** |
| `generator` (`GeneratorSectionSchema` 93-101) | `provider: z.string().optional()` (line 98) | `model` (line 94) | `"sonnet"` | required |
| `evaluator` (`EvaluatorSectionSchema` 104-112) | `provider: z.string().optional()` (line 109) | `model` (line 105) | `"sonnet"` | required |
| `codeReview` (`CodeReviewSectionSchema` 132-141) | `provider: z.string().optional()` (line 137) | `model` (line 135) | `"sonnet"` | **optional** |

KEY FACTS:
- The provider field is named **`provider`** on EVERY role (NOT `providerName`). Type `z.string().optional()`.
- The model field is named **`model`** on EVERY role. It always has a `.default(...)` so after full-schema
  parse the model is ALWAYS present on planner/generator/evaluator. `curator` and `codeReview` are whole-section
  optional, so `config.curator` / `config.codeReview` may be `undefined`.
- `endpoint` (nullable optional) and `providerConfig` exist on all role sections but are NOT relevant here.

**GLOBAL / DEFAULT provider field:** There is **NO top-level `provider` field** on `BoberConfigSchema`
(verified: lines 307-325 have no `provider` key). The "global/default provider" the PRD refers to is
emergent — it is whatever a role's `model` shorthand resolves to via `resolveProviderModel`. Concretely:
a user "sets claude-code as the global/default provider" by putting `provider: "claude-code"` on roles
(or via defaults). **There is no single config.provider to read.** Therefore "another configured provider
exists" must be computed by scanning the OTHER roles' effective providers (see decision algorithm §1.6).

**Existing precedent for codeReview fallback** (`src/orchestrator/code-reviewer-agent.ts:63,75`): codeReview
falls back to evaluator's model/provider when its own section is absent:
```ts
const reviewerModel = config.codeReview?.model ?? config.evaluator.model;   // line 63
config.codeReview?.provider ?? config.evaluator.provider ?? null,           // line 75
```
This is the established interpretation of "codeReview defaults to evaluator." You MAY mirror it
(read codeReview's provider/model, falling back to evaluator's) so an absent codeReview section does
not produce a spurious claude-code resolution.

---

## 1.3. resolveProviderModel — the resolver you must use

**Signature** (`src/orchestrator/model-resolver.ts:57-60`):
```ts
export function resolveProviderModel(
  model: string,
  explicitProvider?: string,
): ResolvedModel
```
**Return** (`src/orchestrator/model-resolver.ts:9-16`):
```ts
export interface ResolvedModel {
  provider: string;   // e.g. "anthropic", "openai", "openai-compat", "claude-code"
  modelId: string;
  endpoint?: string;
}
```
**Behavior (lines 61-91):** If `explicitProvider` is set, it is returned verbatim as `provider`
(line 62-64) — so `resolveProviderModel(model, "claude-code").provider === "claude-code"`. Otherwise
shorthand expansion (e.g. `"opus"` → anthropic, `"deepseek"` → openai-compat); unknown strings default
to `anthropic` (line 91). `"claude-code"` is NOT a shorthand in `SHORTHAND_MAP` (lines 22-41) — the ONLY
way a role resolves to claude-code is via an explicit `provider: "claude-code"`.

> Implication: pass `resolveProviderModel(section.model, section.provider)`. The role's effective
> provider = that call's `.provider`. This single call already implements
> `config.<role>.provider ?? <model-derived provider>` because explicitProvider wins when set.

---

## 1.4. logger API (for sc-5-4)

**Import** (`src/utils/logger.ts:87`): `import { logger } from "../utils/logger.js";`
(from `src/config/`, the singleton is at `../utils/logger.js`).

**Methods** (`src/utils/logger.ts:13-36`): `logger.info(message, ...args)`, `.success`, `.warn`,
`.error`, `.debug`. Each is `(message: string, ...args: unknown[]) => void`.

For sc-5-4 emit ONE line per role. Recommended: `logger.info(\`role \${role} -> provider \${provider}\`)`
so the test can assert the call args contain the role name and resolved provider. Use a STABLE,
greppable format. The test spies on `logger.info` (see mock pattern §6).

---

## 1.5. Is there a researcher config section? (the ambiguity)

**NO.** There is no `ResearcherSectionSchema` and no `researcher` key on `BoberConfigSchema`
(verified lines 307-325; only sections are project/planner/curator/generator/evaluator/sprint/
pipeline/commands/graph/codeReview/observability/incident/telemetry). Per generatorNotes:
"research uses planner-style config; if there is no dedicated research section, treat researcher as
planner." So the `researcher` role's effective provider = the `planner` role's effective provider.
Both planner and researcher are PROMPT roles → claude-code is always allowed for them.

---

## 1.6. DECISION ALGORITHM (resolve the ambiguity precisely)

```
TOOL_ROLES   = ["curator", "generator", "evaluator", "codeReview"]
PROMPT_ROLES = ["planner", "researcher"]

effectiveProvider(role):
  if role == "researcher":            section = config.planner
  else:                               section = config[role]
  if role == "codeReview" and section is undefined:
                                      section = config.evaluator   // mirror code-reviewer-agent.ts:63/75
  model    = section?.model           // always defined for planner/generator/evaluator post-parse
  provider = section?.provider
  return resolveProviderModel(model, provider).provider   // explicitProvider wins; else model-derived

resolveRoleProviders(config):
  resolved = {}                       // Record<string,string>
  // 1. Compute raw effective providers for all 6 roles
  raw = { for each role: effectiveProvider(role) }

  // 2. Determine the fallback target: the first NON-claude-code provider among ALL roles' raw providers.
  //    "Another configured provider exists" === at least one role resolves to a provider !== "claude-code".
  fallback = first raw[r] (over a stable role order) where raw[r] !== "claude-code"   // may be undefined

  // 3. Resolve each role
  for role in all roles:
    p = raw[role]
    if PROMPT_ROLES.includes(role):
      resolved[role] = p                       // claude-code allowed, no redirect
    else: // TOOL_ROLE
      if p !== "claude-code":
        resolved[role] = p
      else if fallback is defined:
        resolved[role] = fallback              // redirect tool role off claude-code (sc-5-1)
      else:
        throw new Error(                       // sc-5-2 / sc-5-5
          `Role "${role}" resolves to the claude-code provider, which cannot drive tools, ` +
          `and no alternative provider is configured. Set a per-role provider for "${role}" ` +
          `or change the default provider away from claude-code.`)
    logger.info(`role ${role} resolved to provider ${resolved[role]}`)   // sc-5-4: one line per role
  return resolved
```

Notes on the ambiguity:
- "another configured provider" = any role (tool OR prompt) whose effective provider is non-claude-code.
  A per-role override on the offending role itself counts (then `p !== "claude-code"` and we never reach
  the fallback branch). If EVERY role lands on claude-code, no fallback exists → throw (sc-5-2/sc-5-5).
- Prefer the contract's wording "prefer the other configured provider": pick the fallback deterministically
  (stable role iteration order). Document the chosen order in a code comment.
- Per nonGoals: NEVER silently downgrade a tool role to claude-code; if no alternative, HARD-ERROR
  with the role NAME in the message. The throw message MUST contain the role name (sc-5-2 asserts it).
- Log AFTER resolution so the logged provider is the FINAL one (sc-5-4).

**Recommended signature + return type:**
```ts
export type RoleName = "planner" | "researcher" | "curator" | "generator" | "evaluator" | "codeReview";
export type RoleProviderMap = Record<RoleName, string>;
export function resolveRoleProviders(config: BoberConfig): RoleProviderMap
```
Use `BoberConfig` (the post-parse full type, schema.ts:325) since loader calls it with `cfg`. For the
unit tests that pass partial objects, cast with `as BoberConfig` (matching preflight.test.ts:26 `as Partial<BoberConfig>`).

---

## 2. Patterns to Follow

### NodeNext ESM relative imports carry `.js`
**Source:** `src/config/loader.ts:5-10`, `src/providers/preflight.ts:1-3`
```ts
import { BoberConfigSchema, PartialBoberConfigSchema, type BoberConfig } from "./schema.js";
import { resolveProviderModel } from "../orchestrator/model-resolver.js";
import { logger } from "../utils/logger.js";
```
**Rule:** All relative imports end in `.js` even though the source is `.ts`. Type-only imports use `type`.

### throw-on-error in async loader
**Source:** `src/config/loader.ts:241-243`
```ts
throw new Error(`Config validation failed after merging defaults:\n${issues}`);
```
**Rule:** loadConfig surfaces failures by `throw new Error(...)`; in an async fn this rejects the Promise.
Let `resolveRoleProviders`'s throw propagate unchanged.

### Role iteration over the same 5 sections
**Source:** `src/providers/preflight.ts:28-34`
**Rule:** The canonical tool-role section list in this codebase is planner/curator/generator/evaluator/codeReview.
This sprint splits them: curator/generator/evaluator/codeReview are tool roles; planner (+researcher) are prompt roles.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---|---|---|---|
| `resolveProviderModel` | `src/orchestrator/model-resolver.ts:57` | `(model: string, explicitProvider?: string) => ResolvedModel` | Maps a role's model+provider to `{provider, modelId, endpoint?}`. USE for effective-provider. |
| `ResolvedModel` (type) | `src/orchestrator/model-resolver.ts:9` | `{provider, modelId, endpoint?}` | Return type of above. |
| `logger` | `src/utils/logger.ts:87` | singleton `Logger` with `.info/.warn/.error/.debug/.success` | Per-role log lines (sc-5-4). |
| `BoberConfig` (type) | `src/config/schema.ts:325` | `z.infer<typeof BoberConfigSchema>` | The typed config input for resolveRoleProviders. |
| `loadConfig` | `src/config/loader.ts:141` | `(projectRoot: string) => Promise<BoberConfig>` | The wiring point; invoke helper before its `return cfg`. |
| `preflightOpenaiPeer` | `src/providers/preflight.ts:56` | `(config: Partial<BoberConfig>, importer?) => Promise<string|null>` | NEVER-throws openai-peer hint. Bonus non-gating wire (see §9). |
| `ProviderName` (type) | `src/providers/factory.ts:13` | union incl. `"claude-code"` | The provider-name union; `"claude-code"` is a valid value. |

**Searched & none applicable for the core algorithm:** `src/utils/` (only `logger.ts` relevant);
no existing role→provider mapper exists — this helper is genuinely new.

---

## 4. Prior Sprint Output

### Sprint 2: resolveProviderModel
**File:** `src/orchestrator/model-resolver.ts` — exports `resolveProviderModel`, `resolveModel`, type `ResolvedModel`.
**Connection:** This sprint calls `resolveProviderModel(model, provider)` to compute each role's effective provider.

### Sprint 3: preflightOpenaiPeer (not yet wired)
**File:** `src/providers/preflight.ts` — exports `preflightOpenaiPeer`, `usesOpenaiFamily`, `OPENAI_PEER_HINT`, type `OpenaiImporter`.
**Connection:** Structural twin to copy. OPTIONAL bonus: loader.ts may `await preflightOpenaiPeer(cfg)` (never throws) near the resolveRoleProviders call — see §9.

### Sprint 4: claude-code provider
**File:** `src/providers/factory.ts` / `src/providers/claude-code.ts` — `ProviderName` union includes `"claude-code"` (factory.ts:13).
**Connection:** `"claude-code"` is the exact provider string this sprint detects and redirects/blocks.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` read for this sprint. Governing facts come from the contract's `assumptions`
and `generatorNotes` (quoted inline in §1.6) and `nonGoals` (no silent downgrade; hard-error names role;
never block planner/researcher; do not change createClient signature).

### Architecture Decisions
`.bober/architecture/` exists but no ADR is specific to role-provider fallback. The PRD US-006 wording
("another configured provider") is encoded in §1.6.

### Other Docs
Tech stack (contract): TypeScript strict NodeNext ESM, Zod config schema, Vitest, logger in src/utils/logger.ts.

---

## 6. Testing Patterns

### Unit test — logger spy via vi.mock (USE THIS for sc-5-1..sc-5-4)
**Source:** `src/providers/preflight.test.ts:1-18`
```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveRoleProviders } from "./role-providers.js";
import { logger } from "../utils/logger.js";
import type { BoberConfig } from "../config/schema.js";

vi.mock("../utils/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

afterEach(() => { vi.clearAllMocks(); });
```
**Passing config objects** (`src/providers/preflight.test.ts:24-27`): build plain objects and cast:
```ts
const config = { generator: { model: "sonnet", provider: "claude-code" } } as BoberConfig;
```
- **sc-5-1:** generator `{model:"sonnet", provider:"claude-code"}` + e.g. evaluator default (anthropic) →
  `resolveRoleProviders(cfg).generator === "anthropic"` (redirected).
- **sc-5-2:** EVERY role provider `"claude-code"` (or default-claude-code) → `expect(() => resolveRoleProviders(cfg)).toThrow(/generator/)`.
- **sc-5-3:** planner+researcher resolve to claude-code, others non-claude-code → no throw; `.planner === "claude-code"`.
- **sc-5-4:** after a successful call, `expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("generator"))`
  and `expect.stringContaining(resolvedProvider)`. Asserting `logger.info.mock.calls` length === 6 also valid.

**Runner:** vitest. **Assertion:** `expect`. **Mock:** `vi.mock` + `vi.fn()`. **Naming:** `*.test.ts` co-located.

### sc-5-5 — real temp config through loadConfig (NO fs mock)
**Source:** `src/cli/commands/config.test.ts:7-40` (temp-dir + writeMinimalConfig pattern)
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./loader.js";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-roleprov-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

it("sc-5-5: load rejects when a tool role is stuck on claude-code", async () => {
  const config = {
    project: { name: "p", mode: "brownfield" },
    planner: { provider: "claude-code" },
    generator: { provider: "claude-code" },
    evaluator: { strategies: [], provider: "claude-code" },
    curator: { provider: "claude-code" },
    codeReview: { provider: "claude-code" },
  };
  await writeFile(join(tmpDir, "bober.config.json"), JSON.stringify(config), "utf-8");
  await expect(loadConfig(tmpDir)).rejects.toThrow(/generator|curator|evaluator|codeReview/);
});
```
> NOTE: if you `vi.mock` the logger in `loader.test.ts`, mock the path RELATIVE to loader.ts, i.e.
> `vi.mock("../utils/logger.js", ...)`. To make EVERY role land on claude-code, set `provider:"claude-code"`
> on planner/generator/evaluator/curator/codeReview so the fallback scan finds no alternative.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|---|---|---|---|
| 20+ CLI/MCP call sites of `loadConfig` (see §1.1 list) | `loader.ts` loadConfig | medium | A config that previously loaded must STILL load. resolveRoleProviders must NOT throw for any normal anthropic/openai config (only when a tool role has nowhere to go). |
| `src/config/index.ts:60`, `src/index.ts:15` | barrel re-exports loadConfig | low | Signature unchanged (still `Promise<BoberConfig>`). Optionally re-export `resolveRoleProviders` from `src/config/index.ts`. |
| existing fixtures / default configs | loadConfig | medium | `createDefaultConfig` (schema.ts:348) produces no `provider` fields → all roles resolve via model shorthand to anthropic → never throws. Verify. |

### Existing Tests That Must Still Pass
- `src/cli/commands/config.test.ts` — exercises config writing/migration; does not call loadConfig with claude-code, so unaffected, but confirm green.
- `src/providers/preflight.test.ts` — tests preflight role iteration; unaffected (no shared mutable state) but the logger mock pattern is shared knowledge.
- `src/providers/factory.test.ts` — claude-code provider creation (lines 163-180); unaffected by config layer.
- `src/discovery/config-generator.test.ts` — config generation; verify still green.
- Any test that calls `loadConfig` on a real config (search shows MCP/CLI command tests) must still resolve — ensure default (no-provider) configs never hit the throw path.

### Features That Could Be Affected
- **OpenAI-peer preflight (Sprint 3)** — shares `loader.ts` if you add the bonus wire; ensure it is awaited and never throws (§9).
- **codeReview fallback to evaluator** — shares the `config.codeReview?.provider ?? config.evaluator.provider` semantics (`code-reviewer-agent.ts:75`). Keep resolveRoleProviders consistent so codeReview is not falsely flagged claude-code when its section is absent.

### Recommended Regression Checks
1. `npm run build` exits 0 (sc-5-6).
2. `npm run lint` exits 0 (sc-5-6).
3. `npm test` — full suite green, especially `src/config/`, `src/providers/`, `src/cli/commands/`.
4. Manually confirm a default config (no provider fields) loads without throwing.

---

## 8. Implementation Sequence

1. **src/config/role-providers.ts** — define `RoleName`, `RoleProviderMap`, the TOOL_ROLES / PROMPT_ROLES
   constants, the `effectiveProvider` helper, and `resolveRoleProviders(config: BoberConfig)`. Implement §1.6
   algorithm. Import `resolveProviderModel`, `logger`, `type BoberConfig` with `.js` extensions.
   - Verify: file compiles in isolation; throw message contains the role name.
2. **src/config/role-providers.test.ts** — add sc-5-1..sc-5-4 with the vi.mock logger pattern (§6).
   - Verify: `npx vitest run src/config/role-providers.test.ts` green; logger.info called 6×.
3. **src/config/loader.ts** — add `import { resolveRoleProviders } from "./role-providers.js";`; call
   `resolveRoleProviders(cfg);` after line 246 (`const cfg = fullResult.data;`) / after the careful-noop
   warning, before `return cfg;` (line 258). (Optionally also `await preflightOpenaiPeer(cfg)` — §9.)
   - Verify: build passes; normal configs still load.
4. **src/config/loader.test.ts** — add sc-5-5 (real temp dir, claude-code-on-every-role config → rejects).
   - Verify: `await expect(loadConfig(dir)).rejects.toThrow(/<role>/)`.
5. **(Optional) src/config/index.ts** — re-export `resolveRoleProviders` for discoverability.
6. **Run full verification** — `npm run build`, `npm run lint`, `npm test`.

---

## 9. Pitfalls & Warnings

- **There is NO top-level `config.provider`.** "Default/global provider" is emergent from each role's
  `model` shorthand. Do not write `config.provider` — it does not exist (schema.ts:307-325). Determine
  "another configured provider" by scanning roles' effective providers (§1.6).
- **`provider` is the field name, `model` is the field name** — on EVERY role. Not `providerName`, not `llm`.
- **`curator` and `codeReview` sections are optional** (`.optional()`, schema.ts:310,317) — guard with
  `config.curator?` / `config.codeReview?`. For codeReview-absent, mirror the evaluator fallback
  (`code-reviewer-agent.ts:63,75`) so an absent section doesn't fabricate a claude-code resolution.
- **There is NO `researcher` config section** — treat researcher as planner (§1.5). Do not invent
  `config.researcher`.
- **`"claude-code"` is NOT a shorthand** in SHORTHAND_MAP (model-resolver.ts:22-41). A role only resolves
  to claude-code via an explicit `provider: "claude-code"`. So in tests, set the `provider` field.
- **Pass the FULL `BoberConfig` (`cfg`)** into the helper in loader.ts (post-parse, line 246), not the partial.
- **Do not change `loadConfig`'s signature** — 20+ callers depend on `Promise<BoberConfig>`.
- **Throw message MUST name the offending role** (sc-5-2 / sc-5-5 assert on the role name). Use the literal
  role key (e.g. `"generator"`, `"codeReview"`).
- **Log AFTER final resolution** (sc-5-4 wants the finally-resolved provider, not the raw one).
- **Bonus preflight wire is NON-GATING:** `preflightOpenaiPeer` (preflight.ts:56) NEVER throws and returns a
  string|null. If you wire it, `await` it and ignore/return the value — it must not gate config load. It is
  noted in the handoff but is OPTIONAL; the contract's estimatedFiles do not include preflight.ts, so keep
  changes minimal unless build/lint stays green.
- **NodeNext `.js` extension** on all relative imports or build fails.
