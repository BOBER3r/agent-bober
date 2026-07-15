# Architecture: Fleet Orchestrator Phase 2 — `--expand` Goal Decomposer

**Architecture ID:** arch-20260617-fleet-orchestrator-phase-2-expand
**Generated:** 2026-06-17T00:00:00Z
**Status:** draft

Extends: arch-20260609-fleet-orchestrator-tech-lead (Phase 1).

---

## Executive Summary

Phase 2 adds an LLM "tech-lead" decomposer that turns one high-level goal string into a Zod-valid `FleetManifest`, removing the requirement that an operator hand-author the N-child manifest JSON before the locked Phase 1 `runFleet()` (`src/fleet/index.ts:88`) can spawn children. The selected approach (Approach B) is a new lightweight `FleetDecomposer` module that makes a single structured-output call over the provider-agnostic `LLMClient`, validates directly against the unchanged `FleetManifestSchema` (`src/fleet/manifest.ts:13`), and re-prompts once on invalid JSON before failing clearly. The key tradeoff accepted is that single-shot decomposition gets no multi-turn self-correction beyond a one-reprompt budget, in exchange for honoring the "cheap single call" cost constraint; the children-only output emits no provider config and no concurrency override, so `buildChildConfig` and `mapBounded` remain the sole authorities downstream. The primary risk is an operator scripting `--yes` against an unreviewed goal and spawning real detached children; this is mitigated by a write-and-stop default that always persists the manifest to disk before any spawn can occur. Phase 2 is purely additive: `runFleet()` and the `fleet <manifest>` command stay byte-unchanged.

---

## Problem Statement

**Problem:** There is no way to turn a single high-level goal string into a runnable `FleetManifest`; an operator must hand-author the N-child manifest JSON before the built `runFleet()` pipeline (`src/fleet/index.ts:88`) can spawn any children.

**Constraints:**
- Latency: not a hard ceiling; decomposition is a one-shot interactive op (single DeepSeek call + bounded retries). The dominant cost is the N child runs that follow.
- Throughput: one manifest per invocation; child concurrency already governed downstream by `FleetManifestSchema.concurrency` (default 3, `src/fleet/manifest.ts:15`) + `mapBounded` — MUST NOT introduce a second concurrency model.
- Data volume: small; input one goal string, output manifest with N `{folder, task}` children; decomposer MUST NOT emit provider config (injected downstream by `buildChildConfig`, `src/fleet/child-config.ts:21`).
- Cost ceiling: DeepSeek on both axes — (1) decomposition call must be cheap (single bulk call + bounded retry budget); (2) spawning N real detached child processes is the dominant, irreversible cost → no child may spawn unless the operator could first inspect the manifest. No numeric dollar ceiling; the governing rule is qualitative.
- Backward compatibility (LOCKED): `runFleet()` signature/behavior unchanged; existing `fleet <manifest>` command + `--concurrency`/`--root` (`src/fleet/index.ts:133`) keep working exactly; `FleetManifestSchema`/`FleetChildSchema` (`src/fleet/manifest.ts:13,6`) is the locked output contract — decomposer output MUST pass `FleetManifestSchema.parse` (`src/fleet/manifest.ts:43`), no schema relaxation. Phase 2 surface is purely additive.

**Consumers:** Primary — a human operator using the fleet CLI (`registerFleetCommand`, wired `src/cli/index.ts:321`) who wants goal → N parallel runs without hand-writing JSON. Downstream machine consumer — the locked `runFleet()` pipeline, the sole component that spawns/aggregates child runs.

**Success Criteria:**
- Goal string → manifest passing `FleetManifestSchema.parse` with ≥1 `{folder, task}` child and no provider config from the decomposer.
- Malformed LLM JSON → validate + bounded retry, fail clearly rather than pass an invalid manifest to `runFleet`.
- No real detached child process spawned in any path where the operator could not first inspect the generated manifest.
- Existing `fleet <manifest>` command and `runFleet()` signature/behavior byte-unchanged; Phase 2 surface purely additive.
- Decomposition uses DeepSeek (`openai-compat`) via the provider-agnostic `LLMClient`/`agentic-loop` path, never leaking SDK types outside `providers/`.

**Locked Dependencies:** `runFleet` (`src/fleet/index.ts:88`); `registerFleetCommand` + `fleet <manifest>` (`src/fleet/index.ts:133`, wired `src/cli/index.ts:321`); `FleetManifestSchema`/`FleetChildSchema` (`src/fleet/manifest.ts:13,6`); `buildChildConfig` DeepSeek injection (`src/fleet/child-config.ts:21`); DeepSeek constants provider `openai-compat`/endpoint `https://api.deepseek.com`/model `deepseek-v4-pro` (`src/fleet/child-config.ts:7-9`); provider-agnostic LLM path `src/orchestrator/agentic-loop.ts` over `LLMClient` from `src/providers/factory.ts` validated by `validateApiKey`; principles (ESM `.js`, Zod, provider-agnostic, async fs, `.bober/` state).

---

## System Overview

Phase 2 sits entirely on top of the locked Phase 1 runner, joined to it by exactly one seam: an on-disk manifest file. A new `fleet expand <goal>` subcommand (sibling to the byte-unchanged `fleet <manifest>` command) builds a DeepSeek `LLMClient` via `createClient`, then calls the new `FleetDecomposer` module (`src/fleet/decomposer.ts`). The decomposer issues a single structured-output `LLMClient.chat` call, validates the raw text against the unmodified `FleetManifestSchema` plus a guard rejecting any child that carries a `config` key, re-prompts once on failure, and returns an in-memory children-only `FleetManifest` or throws. The subcommand assembles `rootDir`/`concurrency` from CLI options, serializes the manifest to `<root>/.bober/fleet-expand.json` (or `--out`), and prints it.

Because `runFleet()` is path-based and locked, the written file is the structural inspection point: the in-memory manifest must be serialized before `runFleet` can consume it, so inspectability is enforced by construction rather than by procedure. By default the subcommand stops after writing and prints a review hint; only an explicit `--yes` chains into `runFleet(outPath)`, which re-loads and re-validates the same file before spawning children. The decomposer emits no provider config and no concurrency override, so the locked `buildChildConfig` (DeepSeek injection) and `mapBounded` (concurrency) remain the sole downstream authorities — no second concurrency model is introduced.

---

## Component Breakdown

This Phase 2 system adds exactly three internal seams in a new module `src/fleet/decomposer.ts`, plus a goal→manifest prompt constant. It re-uses the LOCKED Phase 1 components unchanged: `runFleet` (`src/fleet/index.ts:88`), `FleetManifestSchema`/`load` (`src/fleet/manifest.ts:13,22`), and `buildChildConfig` (`src/fleet/child-config.ts:21`). The provider-agnostic `LLMClient` (`src/providers/types.ts:216`) is the only external service touched, built via `createClient` (`src/providers/factory.ts:172`).

Components challenged and rejected: a separate manifest *writer* component (writing/inspecting the manifest is the integration wiring concern; the entry point returns an in-memory `FleetManifest` the operator can inspect or persist before any spawn) and a re-wrapped LLM-client component (the existing `LLMClient.chat` seam is sufficient).

### FleetDecomposer (entry point)

**Responsibility:** Turn one high-level goal string into a single Zod-valid `FleetManifest` object (children-only) by orchestrating one LLM call plus a bounded validate/retry, returning an in-memory manifest the caller inspects or writes before any child spawns.

**Interface:**
```typescript
// src/fleet/decomposer.ts
import type { LLMClient } from "../providers/types.js";   // external service
import type { FleetManifest } from "./manifest.js";        // Phase 1, locked

type DecomposeInput = {
  goal: string;                 // the single high-level goal to decompose
  client: LLMClient;            // injected (built via createClient for DeepSeek); DI seam for tests
  model: string;                // e.g. "deepseek-v4-pro" (src/fleet/child-config.ts:9)
  maxRetries?: number;          // bounded re-prompt budget; default DECOMPOSE_MAX_RETRIES = 1
};

// Resolves with a manifest whose `children` are { folder, task } only:
//   - NO `config` per child (buildChildConfig injects DeepSeek provider downstream)
//   - `concurrency`/`rootDir` left to FleetManifestSchema defaults (mapBounded governs concurrency)
// Rejects with a single clear Error when the retry budget is exhausted (never resolves invalid/partial).
export function decomposeGoal(input: DecomposeInput): Promise<FleetManifest>;
```

**Dependencies:** [DecomposerLLMCall, ManifestValidator]

---

### DecomposerLLMCall (LLM-call seam)

**Responsibility:** Issue exactly one structured-output request to the provider-agnostic `LLMClient` and return its raw response text, with an optional re-prompt variant that feeds the prior text plus the Zod error back for coercion.

**Interface:**
```typescript
// src/fleet/decomposer.ts (internal; mirrors coerceJsonOutput @ src/orchestrator/agentic-loop.ts:169)
import type { LLMClient } from "../providers/types.js";   // external service

type LLMCallInput = {
  client: LLMClient;
  model: string;
  systemPrompt: string;         // = DECOMPOSE_SYSTEM_PROMPT
  goal: string;                 // user message
  priorText?: string;           // present only on a retry turn
  coercionInstruction?: string; // re-prompt via jsonObjectMode (ChatParams.jsonObjectMode, types.ts:183)
};

// Returns ChatResponse.text (a JSON document per the ChatParams.responseSchema / jsonObjectMode contract). No parsing here.
function callDecomposer(input: LLMCallInput): Promise<string>;
```

**Dependencies:** []

*Prompt location:* two module-level constants in `src/fleet/decomposer.ts` — `DECOMPOSE_SYSTEM_PROMPT` (role + exact `{ children: [{ folder, task }] }` output shape, forbidding `config`/`concurrency`/provider keys) and `DECOMPOSE_COERCION_INSTRUCTION` (field-by-field re-prompt), mirroring `PLAN_SPEC_COERCION_INSTRUCTION` (`src/orchestrator/planner-agent.ts:30`).

---

### ManifestValidator (validate/retry seam)

**Responsibility:** Extract a JSON object from raw LLM text and validate it against the LOCKED `FleetManifestSchema`, returning either the parsed `FleetManifest` or a formatted Zod-error string the caller re-prompts with.

**Interface:**
```typescript
// src/fleet/decomposer.ts (internal; mirrors parsePlanSpec @ src/orchestrator/planner-agent.ts:299-349)
import type { FleetManifest } from "./manifest.js";       // Phase 1, locked

type ValidationResult =
  | { ok: true; manifest: FleetManifest }
  | { ok: false; error: string };  // formatted issues (path: message), re-fed into the coercion re-prompt

// JSON extraction order matches parsePlanSpec: direct JSON.parse → ```json fence → first {..last} brace block.
// Then FleetManifestSchema.safeParse (manifest.ts:13); also rejects any child carrying a `config` key.
function validateManifest(rawText: string): ValidationResult;
```

**Dependencies:** []  (uses Phase 1 `FleetManifestSchema` directly — not re-created)

---

## Data Model

The decomposer produces an in-memory `FleetManifest` whose `children` carry only `{ folder, task }` — no per-child `config`, no `concurrency`, no `rootDir` (left to `FleetManifestSchema` defaults). The CLI subcommand then assembles `rootDir`/`concurrency` from options and writes the object to disk as the single source of truth.

```typescript
// Children-only shape the decomposer emits and validates (subset of Phase 1 FleetManifestSchema):
type DecomposedManifest = {
  children: Array<{
    folder: string;             // target working directory for the child run
    task: string;               // the decomposed sub-goal for that child
    // NO `config` — buildChildConfig (src/fleet/child-config.ts:21) injects DeepSeek downstream
  }>;
  // concurrency?: number;      // omitted by decomposer; FleetManifestSchema default = 3 (manifest.ts:15)
  // rootDir?: string;          // omitted by decomposer; defaulted by schema / set by CLI --root
};

// What the CLI subcommand actually writes to <root>/.bober/fleet-expand.json:
type WrittenManifest = {
  rootDir: string;              // = opts.root ?? "."
  concurrency: number;          // = opts.concurrency ?? 3
  children: Array<{ folder: string; task: string }>;
};
```

The written manifest is consumed unchanged by the locked `runFleet(outPath)`, which produces the Phase 1 `PortfolioReport` (defined in arch-20260609-fleet-orchestrator-tech-lead; written to `<rootDir>/.bober/fleet-report.json`). Phase 2 adds no new persistent entity beyond the `<root>/.bober/fleet-expand.json` manifest file.

---

## API Contracts

| Endpoint / Method | Input | Output | Error Cases |
|-------------------|-------|--------|-------------|
| `fleet expand <goal>` (CLI action) | `goal: string`, `opts: { count?, provider?, model?, root?, concurrency?, out?, yes? }` | exit 0 + written manifest at `outPath` (+ PortfolioReport printed if `--yes`) | exit 1 if `DEEPSEEK_API_KEY` unset (pre-IO), if decomposition exhausts retry budget, if manifest write IO fails, or (with `--yes`) on any `runFleet` batch-setup error |
| `decomposeGoal(input)` | `{ goal; client: LLMClient; model; maxRetries? }` | `Promise<FleetManifest>` (children-only `{folder,task}`) | throws if `LLMClient.chat` errors, if `safeParse` fails after ≤2 calls, or if any child carries a `config` key — never resolves invalid |
| `runFleet(manifestPath, options?)` (REUSED, locked) | `manifestPath: string` | `Promise<PortfolioReport>` | throws on bad/missing manifest file, missing child credentials (`validateManifestCredentials`), or report-write IO; per-child failures are report data, not throws |
| `createClient(...)` for decomposer (REUSED) | `("openai-compat", DEEPSEEK_ENDPOINT, undefined, DEEPSEEK_MODEL, "FleetDecomposer")` | `LLMClient` | throws via `validateApiKey` (`factory.ts:131-138`) if `DEEPSEEK_API_KEY` unset |

Option semantics: `--count <n>` is a soft hint embedded in the decomposition prompt (final count is whatever validates). `--provider`/`--model` override the decomposer's OWN LLM (default DeepSeek `openai-compat` + `deepseek-v4-pro`); they do NOT set child provider config — children stay config-free and inherit DeepSeek via `buildChildConfig` at spawn. `--root <dir>` sets the written manifest's `rootDir` and default `outPath` dir. `--concurrency <c>` sets the written manifest's `concurrency`. `--out <path>` overrides the write location (default `<root>/.bober/fleet-expand.json`). `--yes` is the sole spawn-chaining trigger.

---

## Integration Strategy

### Data Flow

```
Operator → `bober fleet expand "<goal>" [--count N] [--provider p] [--model m] [--root dir] [--concurrency c] [--out path] [--yes]`
  → registerFleetExpandSubcommand.action(goal, opts)
    → createClient("openai-compat", DEEPSEEK_ENDPOINT, undefined, DEEPSEEK_MODEL, "FleetDecomposer")   // factory.ts:172 → validateApiKey factory.ts:216 → THROWS if DEEPSEEK_API_KEY unset (fail-fast, pre-IO, pre-spawn)
    → decomposeGoal({ goal, client, model, maxRetries })            // src/fleet/decomposer.ts
        → DecomposerLLMCall: client.chat({ ..., jsonObjectMode: true })   // 1st structured call
        → ManifestValidator: FleetManifestSchema.safeParse(raw) + reject-any-child-with-config-key
           ├─ valid   → return FleetManifest (children-only {folder,task})
           ├─ invalid → DecomposerLLMCall #2 with DECOMPOSE_COERCION_INSTRUCTION (1 re-prompt, ≤2 calls total)
           └─ still invalid → throw (never resolves invalid; ADR-3 retry contract)
    → assemble final manifest: { rootDir: opts.root ?? ".", concurrency: opts.concurrency ?? 3, children }   // CLI applies --root/--concurrency to the WRITTEN object, not via runFleet options
    → writeFile(outPath, JSON.stringify(manifest, null, 2))         // outPath = opts.out ?? "<root>/.bober/fleet-expand.json"
    → console.log(manifest) + print outPath + print review hint
    → branch on --yes:
        ├─ NO --yes (DEFAULT, SAFE): STOP. Print: `Review then run: bober fleet "<outPath>"`. process.exitCode = 0. NO SPAWN.
        └─ --yes (escape hatch): runFleet(outPath)   // src/fleet/index.ts:88 — path-based, locked, byte-unchanged; re-loads + re-validates the SAME written file
              → load(outPath) → validateManifestCredentials → coordinator.execute → aggregator → reporter.build/write → PortfolioReport
              → print Fleet Summary → process.exitCode = 0
```

Key seam: the on-disk manifest path is the ONLY hand-off into `runFleet`. Because `runFleet` is path-based, the in-memory decomposed manifest MUST be serialized to `outPath` before `runFleet` can consume it — inspectability is structural, not procedural.

### Consistency Model

Strong / single-writer throughout — no distributed or eventual state. The decomposed manifest is produced in-process, written to a single file path, and that file is the single source of truth consumed by `runFleet`. No concurrent writers to `outPath`; two `expand` invocations on the same default path = last-write-wins (mitigated by `--out`). The decomposer is stateless across calls (the ≤2-call retry is in-process). No shared mutable state between the expand path and the locked `fleet`/`runFleet` path beyond the on-disk JSON file.

### Integration Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Operator runs `--yes` in automation against an unreviewed goal, spawning real children | high | `--yes` opt-in, off by default; manifest ALWAYS written to `outPath` before spawn even with `--yes`, so inspectable post-hoc; document `--yes` as automation-only escape hatch (ADR-5) |
| LLM emits a child carrying a `config` key (provider/credential injection vector) | high | `ManifestValidator` guard rejects ANY child with a `config` key before the manifest is written — invalid manifests never reach disk or `runFleet` |
| Default `outPath` collides with a prior expand and silently overwrites a manifest under review | medium | Print resolved `outPath` every run; support `--out`; write is atomic JSON, never appends |
| Decomposition produces a valid-but-nonsensical manifest (e.g. one giant child) and `--yes` spawns it | medium | Default path STOPS for human review; `--count` biases granularity; per-child failures surface as report data |
| Adding the `expand` subcommand inadvertently alters `fleet <manifest>` parsing | medium | Subcommand pattern identical to `registerWorktreeCommand` (`worktree.ts:24-29`); `fleet <manifest>` line 135 stays byte-identical; registration tests |
| `DEEPSEEK_API_KEY` present for decomposer but child credential check later fails in `runFleet`, wasting the decomposition call | low | Decomposer and children use the same DeepSeek key path; divergence near-impossible; `validateManifestCredentials` fails fast before spawn |

### External Dependencies

| Service | Used By | Failure Mode | Fallback |
|---------|---------|--------------|----------|
| DeepSeek API (`api.deepseek.com`, `child-config.ts:8`) | `FleetDecomposer` (one call + ≤1 re-prompt) and every child via `runFleet` | Network/4xx/5xx from `LLMClient.chat`; missing `DEEPSEEK_API_KEY` | Decomposer throws → CLI exits 1 before any write/spawn; key absence caught by `validateApiKey` pre-IO |
| Filesystem (`<root>/.bober/fleet-expand.json`; Phase 1's `<rootDir>/.bober/fleet-report.json`) | expand-path manifest write; `runFleet` report write | Write permission denied / disk full / missing `.bober` dir | Manifest-write failure → exit 1 before spawn; report-write failure is a `runFleet` batch-setup throw |
| agent-bober child binary | `runFleet` → `FleetCoordinator.execute` (Phase 1, unchanged) | Per-child process failure | Recorded as `ChildOutcome` data in `PortfolioReport`; never throws the batch |

---

## Architecture Decision Records

- [ADR-1: Lightweight FleetDecomposer over Planner Reuse](.bober/architecture/arch-20260617-fleet-orchestrator-phase-2-expand-adr-1.md)
- [ADR-2: Decomposer emits children-only; reuse locked FleetManifestSchema as the validator](.bober/architecture/arch-20260617-fleet-orchestrator-phase-2-expand-adr-2.md)
- [ADR-3: Validate/retry contract — one bounded coercion re-prompt, then fail clearly](.bober/architecture/arch-20260617-fleet-orchestrator-phase-2-expand-adr-3.md)
- [ADR-4: Fleet Expand CLI Surface — Distinct `fleet expand <goal>` Subcommand](.bober/architecture/arch-20260617-fleet-orchestrator-phase-2-expand-adr-4.md)
- [ADR-5: Fleet Expand Spawn Safety Gate — Write-and-Stop Default, `--yes` Escape Hatch](.bober/architecture/arch-20260617-fleet-orchestrator-phase-2-expand-adr-5.md)

---

## Risk Assessment

| Risk | Severity | Owner | Mitigation |
|------|----------|-------|------------|
| Operator scripts `--yes` against an unreviewed goal and spawns real detached children | high | FleetExpand CLI | `--yes` off by default; manifest always written to `outPath` before any spawn, so auditable post-hoc; documented automation-only (ADR-5) |
| LLM emits a child with a `config` key, silently overriding `buildChildConfig` provider injection | high | ManifestValidator | Explicit config-key guard rejects such children before any write; prompt forbids `config`/`concurrency`/provider keys (ADR-2) |
| Single-shot decomposition under-performs on large/ambiguous goals, yielding low-quality children | medium | FleetDecomposer | `--count` biases granularity; default write-and-stop forces human review; Approach C (plan-then-expand) recorded as escalation path (ADR-1) |
| Default `outPath` overwrites a manifest already under review | medium | FleetExpand CLI | Resolved `outPath` printed each run; `--out` override; write is whole-file JSON, never appends |
| Parent/child commander registration alters locked `fleet <manifest>` arg parsing | medium | FleetExpand CLI | Mirror proven `registerWorktreeCommand` pattern (`worktree.ts:24-29`); line 135 byte-identical; registration tests (ADR-4) |
| Retry budget raised high by operator erodes the cheap-call guarantee | low | FleetDecomposer | `DECOMPOSE_MAX_RETRIES` default fixed at 1; budget documented as a bounded knob, not an open loop (ADR-3) |

---

## Open Questions

- `--count` semantics — target vs cap: It is assumed `--count <n>` is a soft target hint embedded in the prompt and the validated child count may differ. If instead operators expect a hard cap (or exact-N), the decomposer would need a post-validation count check and a re-prompt or truncation policy. If the assumption is wrong, an operator passing `--count 5` and receiving 8 children would view it as a contract violation.
- Config-key guard scope — unknown top-level manifest keys: The guard rejects any child carrying a `config` key. Open whether it should also warn or reject on unexpected top-level manifest keys (e.g. a model-invented `provider` at manifest root). `FleetManifestSchema` strips/ignores unknowns by default unless `.strict()`; if a model adds a benign-looking top-level key, it is silently dropped rather than surfaced. Assumed acceptable for now; revisit if drops mask intent.
- `--yes` TTY requirement: Open whether `--yes` should additionally require (or refuse) a TTY. Assumed no TTY check — `--yes` is explicitly the non-interactive automation hatch, so requiring a TTY would defeat its purpose. If the safety posture tightens, a `process.stdout.isTTY` guard could force interactive confirmation when a terminal is present.
- Pre-existing `<root>/.bober/fleet-expand.json`: Assumed last-write-wins overwrite with the resolved path printed every run (no prompt, no backup). Open whether a pre-existing file under review should trigger a confirmation prompt, a timestamped filename, or a `--force` requirement. If the assumption is wrong, a second `expand` could clobber a manifest an operator was mid-review on; `--out` is the current escape.
