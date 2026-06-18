# FleetDecomposer module (goal → validated manifest)

**Contract:** sprint-spec-20260617-fleet-expand-decomposer-1  ·  **Spec:** spec-20260617-fleet-expand-decomposer  ·  **Completed:** 2026-06-17

## What this sprint added

The risk-first core of fleet **expand** (Phase 2 of the fleet orchestrator): a new pure
module `src/fleet/decomposer.ts` whose `decomposeGoal({ goal, client, model, maxRetries })`
turns **one** high-level goal string into a children-only, Zod-valid `FleetManifest` via a
single DeepSeek `LLMClient.chat` call plus at most **one** bounded coercion re-prompt. The
call uses `jsonObjectMode: true` and deliberately **does not** set `responseSchema` (DeepSeek
rejects strict `json_schema`); a per-child guard rejects any child carrying a `config` key
*beyond* what `FleetManifestSchema.safeParse` would catch. This sprint is purely additive on
the merged Phase 1 runner — **no CLI, no spawn, no network, no fs**. The user-facing
`fleet expand` subcommand that consumes `decomposeGoal` lands in Sprint 2; for now this is an
internal building block proven entirely against a fake `LLMClient`.

## Public surface

- `decomposeGoal(input): Promise<FleetManifest>` (`src/fleet/decomposer.ts:159`) — entrypoint. Calls the LLM once, validates, and on a validation failure re-prompts exactly `maxRetries` times (default `1`, so ≤2 total `client.chat` calls). Resolves only with a schema-valid, config-free manifest; on final failure **throws** `Error("Fleet decomposition failed after N attempt(s):\n<formatted Zod issues>")` — it never resolves with an invalid or partial manifest.
- `DecomposeInput` interface (`src/fleet/decomposer.ts:44`) — `{ goal: string; client: LLMClient; model: string; maxRetries?: number }`.
- `validateManifest(rawText): { ok: true; manifest } | { ok: false; error }` (`src/fleet/decomposer.ts:95`) — internal seam. Extracts JSON (direct `JSON.parse` → ` ```json ` fence → first-`{` to last-`}` block), runs `FleetManifestSchema.safeParse`, then applies the config-key guard via `Object.prototype.hasOwnProperty.call(child, "config")` (`decomposer.ts:144`). Returns a tagged result so the caller routes any failure into the coercion retry.
- `DECOMPOSE_SYSTEM_PROMPT` (`src/fleet/decomposer.ts:7`) — tech-lead system prompt instructing the model to emit exactly `{ "children": [{ "folder", "task" }] }` (kebab-case `folder`, self-contained `task`, ≥1 child) and forbidding `config` / `concurrency` / `rootDir` / `provider` keys.
- `DECOMPOSE_COERCION_INSTRUCTION` (`src/fleet/decomposer.ts:24`) — re-prompt body that restates the required shape; the retry turn appends the prior assistant text + the formatted Zod error as a 3-message `[user, assistant, user]` array.
- `DECOMPOSE_MAX_RETRIES = 1` (`src/fleet/decomposer.ts:40`) — default retry budget.
- `callDecomposer(input)` (`src/fleet/decomposer.ts:57`) — internal one-call seam; returns `response.text` only (no parsing). First turn is a single user message; the retry turn is the 3-message coercion shape.

## How to use / how it fits

`decomposeGoal` is the structured-output core that Sprint 2's `fleet expand` CLI will wrap —
the CLI will own `createClient` / `DEEPSEEK_API_KEY`, manifest file writing, and any
`runFleet` chaining. Today the module is consumed only by its collocated tests via an
injected fake client; nothing in the runtime pipeline calls it yet.

```ts
import { decomposeGoal } from "./fleet/decomposer.js";

// `client` is any LLMClient (real DeepSeek wiring is Sprint 2; tests inject a fake).
const manifest = await decomposeGoal({
  goal: "Build a todo app with an API server and a web frontend",
  client,
  model: "deepseek-chat",
});
// manifest.children === [{ folder, task }, ...]; rootDir/concurrency come from
// FleetManifestSchema defaults. Children never carry a `config` key.
```

The JSON-extraction + coercion-retry shape intentionally mirrors `parsePlanSpec` /
`PLAN_SPEC_COERCION_INSTRUCTION` in `src/orchestrator/planner-agent.ts`, so the two
structured-output paths stay consistent. `FleetManifestSchema` / `FleetChildSchema`
(`src/fleet/manifest.ts`) are reused verbatim — not relaxed or re-created.

## Notes for maintainers

- **The config-key guard runs *in addition to* `safeParse`, by design.** `FleetChildSchema.config`
  is optional (`src/fleet/manifest.ts:9`), so `safeParse` alone would *accept* a child with a
  `config` key; the explicit `hasOwnProperty` check is what makes decomposed children
  folder/task-only. Do not fold it into the schema without re-checking the Phase 1 manifest
  loader, which legitimately allows `config` on hand-authored manifests.
- **`jsonObjectMode: true`, never `responseSchema`** — DeepSeek rejects strict `json_schema`.
  The tests assert both the presence of `jsonObjectMode` and the absence of `responseSchema`
  on every `chat` call; keep that invariant if the provider knob is refactored.
- **Retry accounting:** `maxAttempts = 1 + maxRetries`. Bad-then-good is exactly 2 calls;
  bad-then-bad is 2 calls then a throw; `maxRetries: 0` makes a single attempt with no retry.
  No hard cap on child count and no two-call plan-then-expand — out of scope this plan.
- **No Phase 1 file was touched** (`manifest.ts`, `index.ts`, `child-config.ts`, `runner.ts`,
  etc. are unchanged) — verified by the evaluator. The architecture for this phase is
  `.bober/architecture/arch-20260617-fleet-orchestrator-phase-2-expand-*`.
