# Robust two-stage decomposition engine (decomposer-deep.ts)

**Contract:** sprint-spec-20260618-fleet-expand-deep-1  ·  **Spec:** spec-20260618-fleet-expand-deep  ·  **Completed:** 2026-06-18

## What this sprint added

The engine core of fleet **expand-deep** (Phase 3 of the fleet orchestrator): a new sibling
module `src/fleet/decomposer-deep.ts` that decomposes a single high-level goal into a
children-only, Zod-valid `FleetManifest` through a **bounded two-stage PLAN → EXPAND** loop
instead of Phase 2's single-shot pass. The PLAN stage makes one bounded DeepSeek call to
produce a **transient, in-memory** `Outline` (`{ areas: [{ name, intent }] }`) of independent
sub-project areas; the EXPAND stage makes one bounded call to turn that outline into a manifest,
validated through `validateManifest` **imported verbatim** from `decomposer.ts` (inheriting its
JSON-extract → `FleetManifestSchema.safeParse` → per-child `config`-key guard). Both calls set
`jsonObjectMode: true` and **never** `responseSchema` (DeepSeek rejects strict `json_schema`),
and the whole run is capped at a fixed `DEEP_MAX_TOTAL_CALLS = 4`. This sprint is
**engine-only** — no CLI, no disk IO, no network — and is additive on top of the byte-locked
Phase 2 decomposer/manifest/CLI. The user-facing `fleet expand-deep` subcommand that wraps
`decomposeGoalDeep` lands in **Sprint 2**.

## Public surface

All exports live in `src/fleet/decomposer-deep.ts`.

- `decomposeGoalDeep(input): Promise<FleetManifest>` (`src/fleet/decomposer-deep.ts:319`) — public entrypoint. Runs `runPlanStage` then `runExpandStage(outline)` (PLAN strictly precedes EXPAND, never parallel) and resolves only with a schema-valid, config-free manifest. Defaults `planMaxRetries` / `expandMaxRetries` from the constants.
- `DecomposeDeepInput` interface (`src/fleet/decomposer-deep.ts:81`) — `{ goal: string; client: LLMClient; model: string; count?: string; planMaxRetries?: number; expandMaxRetries?: number }`.
- `runPlanStage({ client, model, goal, count?, maxRetries }): Promise<Outline>` (`src/fleet/decomposer-deep.ts:243`) — bounded PLAN loop (`maxAttempts = 1 + maxRetries`). Returns the validated `Outline`; on exhaustion **throws** `Error("deep plan failed after N attempt(s):\n<lastError>")` and never reaches EXPAND.
- `runExpandStage({ client, model, outline, goal, maxRetries }): Promise<FleetManifest>` (`src/fleet/decomposer-deep.ts:280`) — bounded EXPAND loop validating each response via the **imported** `validateManifest`. On exhaustion **throws** `Error("deep expand failed after N attempt(s):\n<lastError>")`.
- `validateOutline(rawText): { ok: true; outline } | { ok: false; error }` (`src/fleet/decomposer-deep.ts:107`) — **never throws**. Reuses the same JSON-extraction strategy as `validateManifest` (direct `JSON.parse` → ` ```json ` fence → first-`{` to last-`}` block), then checks shape against a local `OutlineSchema` (`areas` array ≥1 item, each non-empty `name` + string `intent`). Returns a tagged result so the caller routes failures into the coercion retry.
- `Outline` / `OutlineArea` types (`src/fleet/decomposer-deep.ts:78-79`) — `{ areas: OutlineArea[] }` and `{ name: string; intent: string }`. Transient, in-memory only — never serialized, no on-disk contract.
- `DEEP_PLAN_SYSTEM_PROMPT` (`:8`) / `DEEP_PLAN_COERCION_INSTRUCTION` (`:24`) — PLAN prompts instructing the model to emit exactly `{ "areas": [{ "name", "intent" }] }` (free-form `name`, ≥1 area, **no** kebab folders/slugs — coarse planning only).
- `DEEP_EXPAND_SYSTEM_PROMPT` (`:38`) / `DEEP_EXPAND_COERCION_INSTRUCTION` (`:55`) — EXPAND prompts mirroring `DECOMPOSE_SYSTEM_PROMPT`'s rules: emit `{ "children": [{ "folder", "task" }] }` (kebab `folder`, self-contained `task`, ≥1 child, no `config`/`concurrency`/`rootDir`/`provider` keys).
- `DEEP_PLAN_MAX_RETRIES = 1` (`:71`), `DEEP_EXPAND_MAX_RETRIES = 1` (`:72`), `DEEP_MAX_TOTAL_CALLS = 4` (`:74`) — the fixed budget: `(1 + DEEP_PLAN_MAX_RETRIES) + (1 + DEEP_EXPAND_MAX_RETRIES)`.

## How to use / how it fits

`decomposeGoalDeep` is the robust alternative to Phase 2's `decomposeGoal` for very large or
ambiguous goals where the single-shot pass yields one giant low-quality child or fails
validation. Sprint 2's `fleet expand-deep <goal>` CLI will wrap it the same way `fleet expand`
wraps `decomposeGoal` — owning `createClient` / `DEEPSEEK_API_KEY`, the atomic manifest write,
and the write-and-stop `--yes` spawn gate. Today the module is consumed only by its collocated
tests via an injected fake `LLMClient`; nothing in the runtime pipeline or CLI calls it yet.

```ts
import { decomposeGoalDeep } from "./fleet/decomposer-deep.js";

// `client` is any LLMClient (real DeepSeek wiring + CLI are Sprint 2; tests inject a fake).
const manifest = await decomposeGoalDeep({
  goal: "Build a multi-tenant SaaS platform with billing, auth, and an admin console",
  client,
  model: "deepseek-chat",
  count: "5", // optional soft target folded into the PLAN prompt
});
// PLAN → in-memory Outline of areas → EXPAND → manifest.children === [{ folder, task }, ...].
// rootDir/concurrency come from FleetManifestSchema defaults; children never carry `config`.
```

The bounded loop and 3-message `[user, assistant, user]` coercion shape are copied **in spirit**
from `callDecomposer` / `decomposeGoal` in `src/fleet/decomposer.ts`, adapted for two prompts
(Outline, then children-only manifest). `validateManifest` and `FleetManifestSchema` /
`FleetChildSchema` (`src/fleet/manifest.ts`) are reused verbatim — not relaxed or re-created.

## Notes for maintainers

- **The Phase-2 path is byte-locked, not extended.** `decomposer.ts` (`decomposeGoal`, its
  prompts, `DECOMPOSE_MAX_RETRIES`), `manifest.ts` (`FleetManifestSchema` / `FleetChildSchema`),
  `index.ts`, and `providers/` are unchanged — verified by the evaluator (commit `960e287`
  adds only `decomposer-deep.ts` + its test). `validateManifest` is **imported** from
  `./decomposer.js`, never copied; that import is the seam that keeps the EXPAND output contract
  identical to single-shot (including the `config`-key guard).
- **Fixed call budget.** `DEEP_MAX_TOTAL_CALLS = 4` is structural: each stage runs
  `maxAttempts = 1 + maxRetries`, and the budget is the sum. A fully-failing run records at most
  4 `client.chat` calls; a PLAN exhaustion stops at 2 (EXPAND never runs, no leak past the stage
  boundary). To widen the budget, raise the per-stage `DEEP_*_MAX_RETRIES` constants — the
  comment at `decomposer-deep.ts:73` marks this as the intended upgrade path.
- **`jsonObjectMode: true`, never `responseSchema`** — DeepSeek rejects strict `json_schema`.
  The tests assert both the presence of `jsonObjectMode` and the absence of `responseSchema` on
  **both** the PLAN and EXPAND calls; keep that invariant if the provider knob is refactored.
- **The Outline is transient.** It exists only in memory between PLAN and EXPAND — no loader,
  no schema file, no CLI, never serialized. The written on-disk contract stays a
  `FleetManifestSchema`-valid manifest, unchanged from Phase 2.
- **Intentional limitations (deferred).** The EXPAND call is **not self-judged**, so a
  shape-valid-but-coarse manifest can still pass — a bounded critique round (Approach B) is the
  recorded future remedy. There is also no hard `--count` cap. The unchanged write-and-stop
  default forces operator review before any spawn, which is the mitigation.
- The architecture for this phase is `.bober/architecture/arch-20260617-fleet-robust-decomposition-*`
  (extends Phase 1 `arch-20260609-fleet-orchestrator-tech-lead-*` and Phase 2
  `arch-20260617-fleet-orchestrator-phase-2-expand-*`).
</content>
</invoke>
