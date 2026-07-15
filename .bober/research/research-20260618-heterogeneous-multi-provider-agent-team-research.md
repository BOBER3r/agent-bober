# Research: Heterogeneous multi-provider agent team with a difficulty-triaging head model

**Research ID:** research-20260618-heterogeneous-multi-provider-agent-team
**Generated:** 2026-06-18T17:30:00Z
**Questions Explored:** 7
**Files Explored:** 11

---

## Architecture Overview

The repo already contains the "head model decomposes a goal → spawns N child agents" loop, but the children are **OS-process-isolated** and **single-provider by default**.

- **Head decomposition:** `fleet expand-deep` (`src/fleet/decomposer-deep.ts`) runs PLAN (`runPlanStage` → coarse `Outline` of `{name,intent}` areas) → EXPAND (`runExpandStage` → `FleetManifest` of `{folder,task}` children), optionally gated by a fresh-context critic (`src/fleet/critic-deep.ts`).
- **Spawning:** `FleetCoordinator.execute(manifest)` (`src/fleet/coordinator.ts:29`) runs `mapBounded(manifest.children, manifest.concurrency, runChild)`. Each `runChild` → `Scaffolder.scaffold` (writes the child's folder + `bober.config.json`) → `ChildRunner.run` which `execa(nodeBin, [cliEntry, "run", child.task], {cwd, reject:false, timeout, maxBuffer})` (`src/fleet/runner.ts`). **A child receives only a task string + a cwd. There is no shared channel, no messaging, no mid-flight result exchange between siblings.**
- **Per-child config:** `buildChildConfig(child)` (`src/fleet/child-config.ts:20`) starts from `createDefaultConfig`, hard-sets planner/generator/evaluator to **DeepSeek**, then `merged = {...base, ...(child.config ?? {})}` (shallow merge) and `BoberConfigSchema.parse(merged)`. The scaffolder serializes this to the child's `bober.config.json` (`src/fleet/scaffolder.ts:57-58`), which the spawned `agent-bober run` reads from its cwd.
- **Provider routing:** `createClient` / `resolveProviderModel` (`src/orchestrator/model-resolver.ts:56`) + per-role resolution in `src/config/role-providers.ts`.

So the substrate for (a) head decomposition and (b) per-child heterogeneous providers exists; (c) inter-agent exchange does **not**.

## Existing Patterns

- **Per-child provider override (the heterogeneity seam):** `child.config` in the manifest is a `z.record(z.string(), z.unknown()).optional()` (`src/fleet/manifest.ts:6-9`) that shallow-merges over the DeepSeek default in `buildChildConfig` (`child-config.ts:43`). A child carrying `{"config":{"generator":{"provider":"anthropic","model":"claude-..."}}}` would run a different provider — but the merge is **shallow** (a `config.generator` key fully replaces the base `generator`, not deep-merges).
- **Provider shorthands:** `SHORTHAND_MAP` (`model-resolver.ts:11`) maps `opus/sonnet/haiku→anthropic`, `gpt-4.1/o3→openai`, `gemini-*→google`, `deepseek*→openai-compat` **with `endpoint:"https://api.deepseek.com"` attached**. `resolveProviderModel` honors an explicit provider, an `ollama/` prefix (→ localhost openai-compat), then the shorthand map, else defaults to anthropic.
- **API-key injection:** `validateApiKey` (`factory.ts:85`) requires `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY|GEMINI_API_KEY` per provider; `openai-compat` keys are optional **except** `endpoint.includes("api.deepseek.com")` which requires a key. `claude-code` requires no key (subscription).
- **Role-provider map:** `RoleProviderMap = Record<RoleName,string>` where `RoleName = planner|researcher|curator|generator|evaluator|codeReview|chat` (`role-providers.ts:10-19`); `effectiveProvider(role,config)` resolves each.
- **Bounded concurrency:** `mapBounded(items, cap, fn)` (`scheduler.ts:174`) is a semaphore-capped `Promise.all` — the standard fan-out primitive, reused by the fleet.
- **Bi-temporal fact store:** `FactStore` (`src/state/facts.ts:136`) — namespaced SQLite (`factsDbPath(projectRoot, namespace)`), `recordFact` / `getActiveFacts(scope, subject, predicate)`. Append-with-supersede.
- **Event tailing:** `EventStreamManager` (`src/mcp/event-stream.ts:69`) watches/backfills `.bober/history.jsonl` + telemetry per subscription — a read/observe backbone (bober/events), not a write bus.

## Key Files

| File | Role | Anchors |
|---|---|---|
| `src/fleet/decomposer-deep.ts` | Head PLAN→EXPAND decomposer | `decomposeGoalDeep`, `runPlanStage`, `runExpandStage`, `DEEP_EXPAND_SYSTEM_PROMPT` |
| `src/fleet/critic-deep.ts` | Fresh-context manifest critic | `getCriticVerdict`, `runCritiqueLoop` |
| `src/fleet/manifest.ts` | `FleetChild={folder,task,config?}` schema | `FleetChildSchema:6`, `FleetManifestSchema:13` |
| `src/fleet/child-config.ts` | Manifest child → BoberConfig (DeepSeek default + shallow merge) | `buildChildConfig:20` |
| `src/fleet/scaffolder.ts` | Writes child `bober.config.json` to disk | `scaffold` (`:57-58`) |
| `src/fleet/coordinator.ts` | Bounded fan-out spawn | `execute:29`, `runChild` |
| `src/fleet/runner.ts` | `execa agent-bober run <task>` child process | `ChildRunner.run`, `ChildRunSpec`, `ChildSpawnResult` |
| `src/providers/factory.ts` | `ProviderName` + `createClient` + `validateApiKey` | `ProviderName:12`, `validateApiKey:85`, `createClient:171` |
| `src/providers/claude-code.ts` | `claude -p` subscription adapter | (whole file) |
| `src/orchestrator/model-resolver.ts` | `SHORTHAND_MAP` + `resolveProviderModel` | `SHORTHAND_MAP:11`, `resolveProviderModel:56` |
| `src/config/role-providers.ts` | Per-role provider resolution + tool/prompt split | `RoleName:10`, `TOOL_ROLES:25`, `PROMPT_ROLES:31`, `effectiveProvider:48` |

## Integration Points

- **Provider-by-difficulty (gap 1):** The decomposer EXPAND prompt (`decomposer-deep.ts` `DEEP_EXPAND_SYSTEM_PROMPT`) **explicitly forbids** emitting `config`, `concurrency`, `rootDir`, or `provider` keys — children are `{folder,task}` only. To let the head model assign a provider by difficulty, either (a) add a `tier`/`difficulty` field to the EXPAND output schema + a post-EXPAND mapping `tier → child.config.{planner,generator,evaluator}` provider block, or (b) relax the prohibition and let the head emit `child.config` directly. The PLAN stage's coarse `{name,intent}` areas are the natural place to reason about difficulty. There is **no existing difficulty/sizing primitive** emitted per task (config `sprint.sprintSize` is global, not per-child).
- **Grok/xAI (gap 2):** Three touch-points, mirroring DeepSeek: (1) `SHORTHAND_MAP` add `grok*` → `{provider:"openai-compat", modelId, endpoint:"https://api.x.ai/v1"}`; (2) `validateApiKey` add an `endpoint.includes("api.x.ai")` branch requiring `XAI_API_KEY`; (3) `createClient`'s `openai-compat` case currently injects `DEEPSEEK_API_KEY` only for `api.deepseek.com` (`factory.ts:251-255`) — add a parallel `api.x.ai` → `XAI_API_KEY` branch. xAI is OpenAI-wire-compatible, so `OpenAICompatAdapter` itself needs no change.
- **Inter-agent exchange (gap 3):** Children are isolated processes in **separate cwds**, so any shared state needs a **shared path**, not in-process passing. The two reusable seams: (a) a **shared `FactStore` namespace** used as a blackboard — agents `recordFact` findings and `getActiveFacts` to read siblings' (requires pointing every child at one shared `facts.db`, not its own folder's); (b) `EventStreamManager` tailing a shared `history.jsonl` for observation only. The coordinator already collects each child's `ChildExecution` result after exit, which is the natural point for a head-model **synthesis** pass over child outputs.
- **claude-code routing constraint:** `TOOL_ROLES = [curator, generator, evaluator, codeReview]` "cannot use the claude-code provider" (claude-code cannot drive tools); `PROMPT_ROLES = [planner, researcher, chat]` allow it unconditionally (`role-providers.ts:21-31`). This directly bounds where `claude -p` can sit (see Risk Areas).

## Test Coverage

- **Fleet:** `src/fleet/*.test.ts` — `child-config.test.ts`, `coordinator.test.ts`, `runner.test.ts`, `scaffolder.test.ts`, `manifest.test.ts`, `decomposer*.test.ts`, `critic-deep.test.ts`, `expand*.test.ts`, `manifest-write.test.ts` (the fleet suite runs ~203 green per prior records).
- **Providers:** `src/providers/claude-code.test.ts`, plus adapter tests; `factory`/`model-resolver` are exercised indirectly (the context tool reported no dedicated `model-resolver.test.ts`).
- **Role map:** `src/config/role-providers.ts` has associated tests for `effectiveProvider`/`resolveRoleProviders` (fallback ordering, tool-role/claude-code interplay).
- **State seams:** `FactStore` is covered by `src/state/facts.test.ts`; `EventStreamManager` by MCP/event-stream tests. `ChildRunner` tests inject a stub CLI entry + bad node bin to exercise spawn-failure paths (no real child process in unit tests).

## Risk Areas

- **`claude-code` cannot be a builder child (highest-impact constraint).** `claude -p` is prompt-only — it can be the **head/planner/researcher/chat**, but `TOOL_ROLES` (generator/evaluator/curator/codeReview) "cannot use the claude-code provider" (`role-providers.ts:21-25`). So "Claude head spawns Claude children that *build*" is only partially possible: a Claude *builder* child must use the **anthropic API-key** provider, not the subscription CLI. The subscription is best used for the head/triage/research roles.
- **Children are isolated OS processes, not in-process agents.** Each is `agent-bober run <task>` in its own cwd with its own `bober.config.json` and its own `.bober/`. "Agents discussing / exchanging info" cannot be a shared object — it must be a shared on-disk channel (a common `FactStore` db path or a shared dir). The result a head model gets back is the child's exit code + captured stdout (`ChildSpawnResult`), not a structured object — a synthesis layer would need to parse/collect child artifacts.
- **Isolation is deliberate; free discussion was previously rejected.** Prior research (`.bober/research/20260614-chattable-team-of-agents-platform.md`) concluded CrewAI-style hierarchical self-orchestration "is documented to fail" and that bober's encoded SOP pipeline is the recommended pattern. A *bounded* blackboard exchange (write-fact / read-fact, capped rounds) aligns with that finding; a live free-form agent chat does not.
- **Decomposer prohibition on `config`/`provider`.** Adding provider-by-difficulty means changing a prompt that is currently hard-locked against emitting those keys, plus the never-throw validators (`validateManifest`) that guard child shape. A post-EXPAND mapping layer avoids touching the LLM contract.
- **Grok key plumbing is multi-site.** Missing any of the three touch-points (shorthand, `validateApiKey`, `createClient` key injection) yields a silent no-key 401 at child runtime. The fleet's `validateManifestCredentials` (`index.ts:45`) pre-checks child credentials and would need to recognize the xAI endpoint too.
- **No difficulty primitive exists.** "Difficulty" must be invented (a tier enum from the head model). There is no objective signal to validate the head's triage against, so mis-tiering (cheap model on a hard task) is silent until the child's output quality drops — argues for a critic/verify pass on tier assignment.
- **Shared FactStore concurrency.** `FactStore` is single-process SQLite (better-sqlite3, synchronous); N children writing one shared `facts.db` concurrently needs WAL mode / a locking story not currently exercised (today each run owns its own db).

---

*Generated by bober.research — factual findings only, no implementation recommendations.*
