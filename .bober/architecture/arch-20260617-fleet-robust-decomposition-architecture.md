# Architecture: Fleet Orchestrator Phase 3 — Robust Decomposition (`fleet expand-deep`)

**Architecture ID:** arch-20260617-fleet-robust-decomposition
**Generated:** 2026-06-17T00:00:00Z
**Status:** draft

Extends: arch-20260609-fleet-orchestrator-tech-lead (Phase 1); arch-20260617-fleet-orchestrator-phase-2-expand (Phase 2).

---

## Executive Summary

Phase 3 adds a robust goal decomposer for very large or ambiguous goals, exposed as a new sibling subcommand `fleet expand-deep <goal>` whose engine runs two bounded LLM stages — an in-memory coarse outline (PLAN) of named sub-project areas, then an expansion (EXPAND) of that outline into a children-only `FleetManifest` validated by the existing `validateManifest` (`src/fleet/decomposer.ts:95`). The selected approach (Approach A — two-call plan-then-expand) is the simplest credible robust rung: a bounded superset of the single-shot loop with a fixed total call budget `DEEP_MAX_TOTAL_CALLS = 4`, no new on-disk contract, and no new concurrency model. The key tradeoff accepted is that the EXPAND call is not self-judged, so a shape-valid-but-coarse manifest can still pass — a bounded critique round (deferred Approach B) is the future remedy. The primary risk is degenerate/coarse children slipping through, mitigated by the unchanged write-and-stop default that forces operator review before any spawn. Phase 3 is purely additive: the Phase-2 single-shot `decomposeGoal` / `fleet expand` path, `runFleet`, `FleetManifestSchema`, and the `--yes` gate all stay byte-unchanged.

---

## Problem Statement

**Problem:** The single-shot decomposer `decomposeGoal` (`src/fleet/decomposer.ts:159-187`) issues at most two LLM calls (`maxAttempts = 1 + DECOMPOSE_MAX_RETRIES`, `DECOMPOSE_MAX_RETRIES = 1`, `decomposer.ts:40,161`) — one decomposition turn plus one shape-coercion re-prompt — so it cannot refine iteratively or self-critique; on a very large or ambiguous goal it emits too-few/too-coarse children (one giant child) or fails `FleetManifestSchema.safeParse` outright, the exact open risk recorded in the Phase 2 risk table (`arch-20260617-fleet-orchestrator-phase-2-expand-architecture.md:241`).

**Constraints:**
- Latency: Not a hard ceiling — decomposition is a one-shot interactive operation; robust mode MAY spend more wall-clock and more LLM calls than single-shot, but the call budget MUST be bounded by a fixed maximum number of `LLMClient.chat` calls (mirroring the bounded `maxAttempts` loop, `decomposer.ts:166`), never an open-ended loop. The dominant irreversible cost remains the N detached child runs spawned by `runFleet` (`src/fleet/index.ts:94`).
- Throughput: One manifest per invocation. Child concurrency is already governed downstream by `FleetManifestSchema.concurrency` (default 3, `src/fleet/manifest.ts:15`) plus `mapBounded`; robust mode MUST NOT introduce a second concurrency model and MUST NOT emit a `concurrency` value.
- Data volume: Small. Input is one goal string; output is a children-only manifest of `{folder, task}` objects. Interim artifacts (outline) are in-memory/transient and MUST NOT widen the on-disk contract — the written file stays a `FleetManifestSchema`-valid manifest.
- Cost ceiling: DeepSeek via the provider-agnostic `LLMClient` — bounded decomposition-call budget; spawning N real detached children is the dominant irreversible cost, so no child may spawn unless the operator could first inspect the manifest. Extra decomposition calls are cheap relative to one wrong child run; write-and-stop inspectability and the `--yes` spawn gate (`src/fleet/index.ts:237`) MUST be preserved unchanged.
- Backward compatibility (LOCKED — byte-identical): `runFleet` (`src/fleet/index.ts:94`); `registerFleetCommand` + the `fleet <manifest>` command and its `--concurrency`/`--root` options (`src/fleet/index.ts:312-318`, wired `src/cli/index.ts:321`); `FleetManifestSchema`/`FleetChildSchema` as the sole output contract — children-only `{folder, task}`, NO per-child `config` (`src/fleet/manifest.ts:6-17`), no schema relaxation; `buildChildConfig` DeepSeek injection. The Phase-2 single-shot path MUST also stay byte-unchanged: `decomposeGoal` + its constants (`decomposer.ts:7-40,159`) and the DEFAULT behavior of `runFleetExpand`/`fleet expand <goal>` (`src/fleet/index.ts:169,266`). All new surface is purely additive.

**Consumers:** Primary — a human operator using the fleet CLI (`registerFleetExpandSubcommand`, `src/fleet/index.ts:266`; wired via `registerFleetCommand`, `src/cli/index.ts:321`) with a sprawling/ambiguous goal that single-shot decomposes poorly and who wants a high-quality manifest instead of one giant low-quality child. Downstream machine consumer — the locked path-based `runFleet` (`src/fleet/index.ts:94`), the sole component that spawns/aggregates child runs, which re-loads and re-validates the written manifest before any spawn.

**Success Criteria:**
- Robust mode produces a `FleetManifestSchema.parse`-valid, children-only manifest (`{folder, task}`, no `config`) for at least one class of large/ambiguous goal on which single-shot `decomposeGoal` fails validation or yields a degenerate single-child manifest — demonstrated with a scripted/fake `LLMClient`, no network.
- Total `LLMClient.chat` calls for a robust run are bounded by an explicit constant (analogous to `DECOMPOSE_MAX_RETRIES`, `decomposer.ts:40`), never unbounded; on budget exhaustion the path throws a single clear Error and writes/spawns nothing (mirroring `decomposer.ts:184-186`).
- Both modes are selectable from one CLI surface and the single-shot path stays byte-unchanged: an operator with no new flag/command gets exactly today's single-shot `fleet expand` behavior; robust mode is reached only via explicit opt-in (the `fleet expand-deep` subcommand).
- Robust mode preserves spawn-safety verbatim: the manifest is always written to `outPath` before any spawn, write-and-stop is the default, and `--yes` remains the sole spawn gate into `runFleet` (`src/fleet/index.ts:237-239`).
- All robust-mode LLM interaction uses DeepSeek `jsonObjectMode: true` (loose JSON-object mode, `decomposer.ts:87`; `types.ts:176-183`), NOT `responseSchema` strict json_schema (DeepSeek rejects it, `types.ts:179-181`), and never leaks provider/SDK types outside `src/providers/`.
- The robust path is deterministically unit-testable with an injected fake `LLMClient` returning scripted text and recording `ChatParams`, with zero network — reusing the existing `ScriptedClient` pattern (`src/fleet/decomposer.test.ts:17-35`).

**Locked Dependencies:** `runFleet` (`src/fleet/index.ts:94`); `registerFleetCommand` + `fleet <manifest>` (`src/fleet/index.ts:312-318`, wired `src/cli/index.ts:321`); `FleetManifestSchema`/`FleetChildSchema` + `load` (`manifest.ts:6,13,22`); `buildChildConfig` DeepSeek injection; the Phase-2 single-shot `decomposeGoal` + its prompt/retry constants (`decomposer.ts:7-40,159`); the default behavior of `runFleetExpand` and `registerFleetExpandSubcommand` (`src/fleet/index.ts:169,266`); the write-and-stop + `--yes` spawn gate (`src/fleet/index.ts:237`); provider-agnostic `LLMClient`/`ChatParams.jsonObjectMode` (`types.ts:216,183`) built via `createClient` (`src/fleet/index.ts:178-185`); the multi-turn coercion patterns reusable for the robust loop — `coerceJsonOutput` (`src/orchestrator/agentic-loop.ts:169`) and the 3-message `[user, assistant, user]` coercion shape (`src/orchestrator/planner-agent.ts:30`, mirrored at `decomposer.ts:66-81`); principles (ESM `.js` imports, Zod validation, provider-agnostic, async fs, `.bober/` state).

---

## System Overview

The robust engine sits behind a new `fleet expand-deep <goal>` sibling subcommand attached to the `fleet` parent, registered additively immediately after `registerFleetExpandSubcommand(fleet)` inside `registerFleetCommand` (`src/fleet/index.ts:~345`). It changes no existing line: the byte-locked `fleet <manifest>` and `fleet expand <goal>` commands are untouched. The CLI action `runFleetExpandDeep` mirrors `runFleetExpand` (`src/fleet/index.ts:169`) step-for-step and differs only in calling `decomposeGoalDeep` instead of `decomposeGoal`.

`decomposeGoalDeep` (new file `src/fleet/decomposer-deep.ts`, beside the locked `decomposer.ts`) orchestrates two bounded stages. PlanStage makes one LLM call to produce a transient in-memory `Outline` of named sub-project areas, validated by `validateOutline`; the Outline is never written to disk. ExpandStage makes one LLM call to turn that Outline into raw text, then runs it through the REUSED `validateManifest` (`decomposer.ts:95`), inheriting JSON-extraction, `FleetManifestSchema.safeParse`, and the per-child config-key guard verbatim. Each stage is bounded by its own coercion-retry constant (`DEEP_PLAN_MAX_RETRIES = 1`, `DEEP_EXPAND_MAX_RETRIES = 1`), giving a fixed worst-case budget `DEEP_MAX_TOTAL_CALLS = 4 = (1+1)+(1+1)`; either stage throws on exhaustion before any file is written. The validated children-only manifest is then emitted via the reused atomic tmp+rename write to `<root>/.bober/fleet-expand.json` (the same default path as `fleet expand`), printed for review, and handed to the locked `runFleet` only behind the unchanged `--yes` gate. Both LLM calls set `jsonObjectMode: true` and never set `responseSchema`.

---

## Component Breakdown

Placement: NEW engine → `src/fleet/decomposer-deep.ts` (new file beside locked `decomposer.ts`); NEW CLI seam → `src/fleet/index.ts` (additively appended; `runFleetExpand`/`registerFleetExpandSubcommand` untouched). Single-shot `decomposeGoal` stays byte-unchanged.

Reused / Locked (verbatim, NOT redesigned): `validateManifest(rawText): ValidateResult` (`decomposer.ts:95`, exported) — the EXPAND stage parses raw text through this exact function; `FleetManifestSchema`/`FleetChildSchema` (`manifest.ts:6-17`); `createClient` (`factory.ts`, called `index.ts:178-185`) credential fail-fast; atomic tmp+rename write (`index.ts:216-219`); `runFleet` (`index.ts:94`) chained only behind `--yes`; the `--yes` gate + write-and-stop + overwrite-notice (`index.ts:221-255`); `LLMClient.chat` (`types.ts:216-222`) — every deep call sets `jsonObjectMode:true`, never `responseSchema`.

### decomposeGoalDeep (Robust Entry Point)

**Responsibility:** Orchestrate the bounded two-stage plan-then-expand flow (PLAN → EXPAND) within a fixed total LLM-call budget and return a validated children-only `FleetManifest`.

**Interface:**
```typescript
// src/fleet/decomposer-deep.ts
import type { LLMClient } from "../providers/types.js";
import type { FleetManifest } from "./manifest.js";

export interface DecomposeDeepInput {
  goal: string;                 // high-level goal (may carry a --count hint)
  client: LLMClient;            // DeepSeek built via createClient
  model: string;                // e.g. "deepseek-v4-pro"
  count?: string;               // soft target sub-project count, folded into PLAN prompt
  planMaxRetries?: number;      // default DEEP_PLAN_MAX_RETRIES
  expandMaxRetries?: number;    // default DEEP_EXPAND_MAX_RETRIES
}
// worst-case total calls = (1+planMaxRetries)+(1+expandMaxRetries) <= DEEP_MAX_TOTAL_CALLS; throws on exhaustion.
export async function decomposeGoalDeep(input: DecomposeDeepInput): Promise<FleetManifest>;
```

**Dependencies:** [PlanStage, ExpandStage]

---

### PlanStage (PLAN seam)

**Responsibility:** Produce a transient in-memory `Outline` of named sub-project areas from the goal via one bounded LLM call, never persisting it.

**Interface:**
```typescript
export type Outline = { areas: OutlineArea[] };               // transient, in-memory ONLY; never written
export type OutlineArea = { name: string; intent: string };   // name = free-form (NOT yet a kebab folder)

export function runPlanStage(input: {
  client: LLMClient; model: string; goal: string; count?: string; maxRetries: number;
}): Promise<Outline>;

export function validateOutline(rawText: string):
  | { ok: true; outline: Outline }
  | { ok: false; error: string };
```

**Dependencies:** [] (calls injected `LLMClient`; uses module prompt constants). Mirrors the 3-message coercion shape (`decomposer.ts:66-81`), `jsonObjectMode:true`, throws after `(1+maxRetries)` attempts.

---

### ExpandStage (OUTLINE→MANIFEST EXPAND seam)

**Responsibility:** Turn the in-memory `Outline` into raw LLM text via one bounded call and validate it through the reused `validateManifest`, returning a children-only `FleetManifest`.

**Interface:**
```typescript
import { validateManifest } from "./decomposer.js"; // REUSED verbatim

export function runExpandStage(input: {
  client: LLMClient; model: string; outline: Outline; goal: string; maxRetries: number;
}): Promise<FleetManifest>;
```

**Dependencies:** [PlanStage] (consumes `Outline`); reuses `validateManifest` (inherits JSON-extract + `FleetManifestSchema.safeParse` + config-key guard). `jsonObjectMode:true`, throws after `(1+maxRetries)` attempts.

---

### runFleetExpandDeep + registerFleetExpandDeepSubcommand (CLI seam)

**Responsibility:** Drive `fleet expand-deep <goal>`: build the client, call `decomposeGoalDeep`, atomically write the children-only manifest, and chain `runFleet` only behind the `--yes` gate — mirroring `runFleetExpand`'s DI exactly.

**Interface:**
```typescript
// src/fleet/index.ts (additive)
import { decomposeGoalDeep } from "./decomposer-deep.js";

export interface FleetExpandDeepOptions {
  count?: string; provider?: string; model?: string;
  root?: string; concurrency?: string; out?: string; yes?: boolean;
}
export interface FleetExpandDeepDeps {
  decomposeDeep?: typeof decomposeGoalDeep;
  runFleet?: typeof runFleet;
  createClient?: typeof createClient;
}
// Same six steps as runFleetExpand (index.ts:169); differs ONLY in calling decomposeGoalDeep instead of decomposeGoal.
export async function runFleetExpandDeep(
  goal: string, opts: FleetExpandDeepOptions, deps?: FleetExpandDeepDeps,
): Promise<void>;
// Attaches `expand-deep <goal>` as a sibling child of `fleet`, right after
// registerFleetExpandSubcommand(fleet) inside registerFleetCommand (index.ts:~345). Same option set as `expand`.
export function registerFleetExpandDeepSubcommand(fleet: Command): void;
```

**Dependencies:** [decomposeGoalDeep]; reuses locked `runFleet`, `createClient`, atomic-write block, `--yes` gate.

### Module Constants (in `decomposer-deep.ts` — not components)
- `DEEP_PLAN_SYSTEM_PROMPT` — emit ONLY `{ "areas": [{ "name", "intent" }] }` outline of independent sub-project areas.
- `DEEP_PLAN_COERCION_INSTRUCTION` — re-state the exact Outline JSON shape after a failed PLAN parse (3-message coercion).
- `DEEP_EXPAND_SYSTEM_PROMPT` — expand the outline into children-only `{ "children": [{ "folder", "task" }] }` (mirrors `DECOMPOSE_SYSTEM_PROMPT` rules: kebab folder, self-contained task, no config/concurrency/rootDir/provider keys).
- `DEEP_EXPAND_COERCION_INSTRUCTION` — re-state children-only manifest shape after a failed EXPAND validation.
- `DEEP_PLAN_MAX_RETRIES = 1`; `DEEP_EXPAND_MAX_RETRIES = 1`; `DEEP_MAX_TOTAL_CALLS = 4` (fixed audit constant = `(1+1)+(1+1)`).

---

## Data Model

No NEW persistent entity is added. The only file written is the existing `FleetManifestSchema`-valid manifest at `<root>/.bober/fleet-expand.json`. The PLAN-stage `Outline` is a transient in-memory value passed directly from PlanStage to ExpandStage within one `decomposeGoalDeep` call; it has no loader, no schema file, and no CLI surface (see ADR-3).

```typescript
// Transient, in-memory ONLY — never serialized to disk
type OutlineArea = { name: string; intent: string };
type Outline = { areas: OutlineArea[] };

// The ONLY on-disk artifact — a FleetManifestSchema-valid, children-only manifest.
// Written verbatim via the reused atomic tmp+rename block (index.ts:216-219).
// No per-child `config`, no `concurrency` emitted by the engine.
type WrittenManifest = {
  rootDir: string;                          // = opts.root, assembled at CLI layer (index.ts:200-204)
  concurrency: number;                      // default 3 from FleetManifestSchema (manifest.ts:15)
  children: Array<{ folder: string; task: string }>;  // the engine's sole contribution
};
```

---

## API Contracts

| Method | Input | Output | Error Cases |
|--------|-------|--------|-------------|
| `decomposeGoalDeep` | `{ goal; client: LLMClient; model; count?; planMaxRetries?; expandMaxRetries? }` | `Promise<FleetManifest>` (children-only) | PLAN budget exhaustion → throws "deep plan failed after N attempts"; EXPAND budget exhaustion → throws "deep expand failed after N attempts"; `client.chat` rejection propagates |
| `runPlanStage` | `{ client; model; goal; count?; maxRetries }` | `Promise<Outline>` | all `(1+maxRetries)` attempts fail `validateOutline` → throws with accumulated lastError; `client.chat` rejection propagates |
| `validateOutline` | `rawText: string` | `{ ok:true; outline }` \| `{ ok:false; error }` | never throws; `{ ok:false }` when no JSON object or areas shape invalid |
| `runExpandStage` | `{ client; model; outline; goal; maxRetries }` | `Promise<FleetManifest>` | all attempts fail REUSED `validateManifest` → throws with accumulated lastError; child config-key rejection is the per-attempt error; `client.chat` rejection propagates |
| `validateManifest` (REUSED `decomposer.ts:95`) | `rawText: string` | `{ ok:true; manifest }` \| `{ ok:false; error }` | no valid JSON → `{ok:false}`; `FleetManifestSchema` violation → `{ok:false}` + zod issues; any child with `config` → `{ok:false}` guard error |
| `runFleetExpandDeep` (CLI action) | `goal, opts: FleetExpandDeepOptions, deps?` | `Promise<void>` | missing `DEEPSEEK_API_KEY` → `createClient` throws BEFORE write; `decomposeGoalDeep` throw propagates (no file written); write IO failure propagates; with `--yes`, `runFleet` setup errors propagate |
| `createClient` (REUSED `factory.ts:172`) | `(provider, endpoint, apiKey?, model, role)` | `LLMClient` | synchronous throw via `validateApiKey` when `DEEPSEEK_API_KEY` unset — pre-IO, pre-write |
| `runFleet` (REUSED `index.ts:94`) | `manifestPath: string` (= written outPath) | `Promise<FleetReport{total;completed;failed;other}>` | batch-setup throws (bad manifest, per-child `validateApiKey`, spawn failure); reachable ONLY under `--yes` |

---

## Integration Strategy

### Data Flow

```
Operator: agent-bober fleet expand-deep "<goal>" [--count N] [--out P] [--yes] ...
  -> registerFleetExpandDeepSubcommand.action(goal, opts)   # thin wrapper, mirrors expand action
    -> runFleetExpandDeep(goal, opts, deps?)
      # STEP 1 - credential fail-fast BEFORE any FS write or LLM IO
      -> client = createClient("openai-compat","https://api.deepseek.com",undefined,model,"FleetDecomposer")
           # validateApiKey (factory.ts:216) throws synchronously if DEEPSEEK_API_KEY missing -> nothing written, nothing spawned
      # STEP 2 - decomposeGoalDeep within fixed budget DEEP_MAX_TOTAL_CALLS=4
      -> decomposeGoalDeep({ goal, client, model, count, planMaxRetries, expandMaxRetries })
           # PLAN (chat #1, jsonObjectMode:true)
           -> runPlanStage(... maxRetries=1): loop 0..2; validateOutline; on ok return Outline (IN MEMORY);
                on exhaustion throw "deep plan failed" (nothing written/spawned)
           # Outline { areas: { name; intent }[] } held in memory; NO disk hand-off
           # EXPAND (chat #2, jsonObjectMode:true)
           -> runExpandStage(... maxRetries=1): serialize Outline; loop 0..2; REUSED validateManifest
                (JSON-extract + safeParse + config-key guard); on ok return manifest;
                on exhaustion throw "deep expand failed" (nothing written/spawned)
           return manifest   # total calls <= DEEP_MAX_TOTAL_CALLS=4
      # STEP 3 - assemble { rootDir: root, concurrency, children }  (identical to runFleetExpand index.ts:200-204)
      # STEP 4 - atomic write (REUSED index.ts:216-219): outPath = opts.out ?? join(root,".bober","fleet-expand.json");
                 ensureDir; tmp write; rename; overwrite notice if pre-existed
      # STEP 5 - print manifest + "Review then run: agent-bober fleet \"<outPath>\""
      # STEP 6 - --yes gate (REUSED index.ts:237-255): if opts.yes -> runFleet(outPath) + Fleet Summary;
                 else process.exitCode=0 (write-and-stop, no spawn)
```

Invariants: (a) credential check precedes all IO; (b) both stages throw before STEP 4 so budget exhaustion writes/spawns nothing; (c) `Outline` is the only in-memory inter-stage hand-off; (d) the written file is the only on-disk hand-off into `runFleet`, reachable only under `--yes`.

### Consistency Model

Single-writer, last-write-wins on a shared default path; no concurrency model introduced (PLAN strictly precedes EXPAND, neither parallelized). In-memory outline only. Sole on-disk hand-off = the written manifest at `outPath`, re-read + re-validated by `runFleet` via `manifest.load`. Shared default path with `expand` (`<root>/.bober/fleet-expand.json`, `index.ts:207`): `expand` then `expand-deep` on defaults is last-write-wins (second overwrites first, overwrite notice prints, no merge); acceptable because the file is re-readable/re-validatable and review-then-run is required; `--out` is the escape hatch (see ADR-4).

### External Dependencies

| Service | Used By | Failure Mode | Fallback |
|---------|---------|--------------|----------|
| DeepSeek API (api.deepseek.com via openai-compat `LLMClient`) | `runPlanStage` (#1) + `runExpandStage` (#2) per deep run; per-child under `--yes` | missing/invalid `DEEPSEEK_API_KEY` → synchronous `validateApiKey` throw at STEP 1; network/5xx/timeout → `client.chat` rejection; malformed-but-200 JSON → caught by `validateOutline`/`validateManifest`, consumes a bounded retry then throws | credential: set env + rerun (no partial state); transient: rerun (write-and-stop = no spawn occurred); exhaustion: thrown error with accumulated validation message |
| Local filesystem (`<root>/.bober/`, manifest write) | STEP 4 atomic write | `ensureDir`/`writeFile`/`rename` IO error → propagates AFTER decompose; tmp may remain but `outPath` never half-written (rename atomic) | error to operator; no `runFleet` spawn (write precedes `--yes` gate); fix path/permissions + rerun |
| agent-bober child binary (spawned by REUSED `runFleet`) | STEP 6 ONLY under `--yes` | child spawn/exec failure, per-child credential failure, non-completion → reflected in `FleetReport.failed`/`.other` | default write-and-stop avoids spawning; under `--yes` partial completion reported in Fleet Summary; re-run via `agent-bober fleet "<outPath>"` after fixing children |

---

## Architecture Decision Records

- [ADR-1: Robust Decomposition Engine — Two-Call Plan-Then-Expand](.bober/architecture/arch-20260617-fleet-robust-decomposition-adr-1.md)
- [ADR-2: New `decomposer-deep.ts` module vs extending `decomposer.ts`](.bober/architecture/arch-20260617-fleet-robust-decomposition-adr-2.md)
- [ADR-3: `Outline` kept in-memory-only vs persisted](.bober/architecture/arch-20260617-fleet-robust-decomposition-adr-3.md)
- [ADR-4: Default Output Path — shared `fleet-expand.json`](.bober/architecture/arch-20260617-fleet-robust-decomposition-adr-4.md)
- [ADR-5: CLI coexistence — distinct `fleet expand-deep` sibling subcommand](.bober/architecture/arch-20260617-fleet-robust-decomposition-adr-5.md)

---

## Risk Assessment

| Risk | Severity | Owner | Mitigation |
|------|----------|-------|------------|
| Degenerate/coarse children still slip through — Approach A does not self-critique (deferred ADR-1 risk) | high | ExpandStage / engine | write-and-stop DEFAULT forces operator review of the printed manifest before any spawn; bounded cost; a self-judging critique round is a FUTURE phase (deferred Approach B) |
| EXPAND fails to inherit the config-key guard (children leak per-child `config`) | high | ExpandStage | `runExpandStage` feeds raw text to REUSED `validateManifest` verbatim — guard + safeParse inherited; unit test with a child-with-config asserts guard error + coercion retry |
| Budget exhaustion leaves a partial manifest on disk or spawns children | high | decomposeGoalDeep / CLI seam | both stage loops throw BEFORE STEP 4; STEP 1 credential check precedes IO; unit test injects always-invalid `ScriptedClient` and asserts reject with NO file and NO `runFleet` invocation |
| Default `outPath` collision: `expand` & `expand-deep` share `fleet-expand.json` (last-write-wins) | medium | CLI seam | atomic tmp+rename prevents torn files; overwrite notice; `--out` separates outputs (ADR-4) |
| Registering `expand-deep` perturbs the byte-locked `fleet <manifest>` / `fleet expand` lines | critical | CLI seam | `registerFleetExpandDeepSubcommand(fleet)` called AFTER `registerFleetExpandSubcommand(fleet)`; only ADDS `.command("expand-deep <goal>")`, touches no existing line; byte/diff assertion on locked spans |
| One of the two new calls uses `responseSchema` (strict) instead of `jsonObjectMode` (DeepSeek rejects) | critical | PlanStage / ExpandStage | both `runPlanStage` + `runExpandStage` pass `jsonObjectMode:true`, never `responseSchema`; unit test asserts captured `ChatParams` has `jsonObjectMode===true` and `responseSchema===undefined` on BOTH calls |
| Inter-stage drift: malformed Outline serializes into a confusing EXPAND prompt, wasting budget | medium | PlanStage | `validateOutline` gates the Outline before EXPAND; EXPAND only runs on a shape-valid Outline |

---

## Open Questions

- **Bounded critique round (deferred Approach B):** If plan-then-expand still under-expands (e.g. the model emits 2 children for a 12-area outline), do we add a bounded generate→critique→revise round? Assumed NOT for Phase 3 because Approach A's fixed-constant budget and least-new-state win at the YAGNI gate. If the assumption is wrong (operators routinely see coarse manifests despite an outline), this reopens ADR-1 to add a `CRITIQUE_MAX_ROUNDS`-bounded stage.
- **Shared-vs-distinct default output path (ADR-4 revisit trigger):** `expand` and `expand-deep` share `<root>/.bober/fleet-expand.json` (last-write-wins). Assumed acceptable because outputs are format-identical and `--out` is the escape hatch. If a real coexistence need emerges (operators routinely want both manifests side-by-side without remembering `--out`), revisit ADR-4 to add a distinct `fleet-expand-deep.json` default.
- **`--count` as soft-target vs hard-cap (inherited from Phase 2):** `count` is folded into the PLAN prompt as a soft target, not enforced as a hard child-count cap. Assumed soft because the schema has no count field and enforcing a cap would add post-validation truncation logic. If operators expect `--count N` to guarantee exactly N children, this needs an explicit decision in a follow-up (and likely a deterministic cap step), not a prompt hint.
