# Critique engine (critic-deep.ts) + opt-in threading

**Contract:** sprint-spec-20260618-fleet-expand-deep-critique-1  ·  **Spec:** spec-20260618-fleet-expand-deep-critique  ·  **Completed:** 2026-06-18

## What this sprint added

The **engine** for Phase 4 of the fleet orchestrator: a bounded, fresh-critic
critique/refine loop that an opt-in `decomposeGoalDeep({ ..., critique: true })` call
routes a structurally-valid baseline `FleetManifest` through before returning. A new module
`src/fleet/critic-deep.ts` asks an independent LLM critic for a boolean `approve | reject`
verdict plus free-text feedback; on **reject** within its single permitted round it folds that
feedback into a **fresh** `runExpandStage` re-expansion, re-validates structurally, and re-asks
the critic. On any exhaustion (parse, transport, round budget) it **fails open / accepts-best**
and never throws, so the result is never worse than the Phase-3 baseline. This sprint is
**engine-only** — there is **no CLI yet**: the `--critique` flag that exposes it on
`agent-bober fleet expand-deep` lands in Sprint 2.

## Public surface

All new symbols are additive in `src/fleet/critic-deep.ts`; the `decomposer-deep.ts` edits are
three single-field augmentations (16 insertions, 0 deletions).

- `CRITIQUE_MAX_ROUNDS = 1` / `CRITIQUE_PARSE_MAX_RETRIES = 1` / `DEEP_CRITIQUE_MAX_TOTAL_CALLS`
  (`src/fleet/critic-deep.ts:13`, `:14`, `:16`) — the loop's fixed counts. The budget is the
  closed form `DEEP_MAX_TOTAL_CALLS + CRITIQUE_MAX_ROUNDS * ((1+CRITIQUE_PARSE_MAX_RETRIES) +
  (1+DEEP_EXPAND_MAX_RETRIES))` = `4 + 1 * (2 + 2)` = **8**, asserted by a co-located audit test
  (not just a comment).
- `CRITIQUE_SYSTEM_PROMPT` / `CRITIQUE_COERCION_INSTRUCTION` (`src/fleet/critic-deep.ts:22`, `:40`)
  — the critic's **own clean prompts**. The system prompt frames the manifest as a third-party
  input ("You did NOT author this manifest"), satisfying the LOCK1 fresh-critic constraint, and
  demands a single bare JSON object.
- `CritiqueVerdictSchema` / `CritiqueVerdict` / `ValidateVerdictResult` (`src/fleet/critic-deep.ts:54`)
  — the Zod schema `{ verdict: "approve" | "reject", feedback: string }` and its discriminated-union
  validation result type, mirroring `validateOutline`'s contract.
- `validateVerdict(rawText): ValidateVerdictResult` (`src/fleet/critic-deep.ts:67`) — tolerant
  parse (direct → ` ```json ` fence → first-brace fallback → `safeParse`) that **never throws**;
  returns `{ ok: false, error }` for empty/non-JSON text, a bad verdict enum, or missing feedback.
- `callCritic(input): Promise<string>` (`src/fleet/critic-deep.ts:119`) — one critic chat call.
  Builds a **fresh message array** (never extends the EXPAND conversation), uses
  `jsonObjectMode: true` and **never** sets `responseSchema`; the coercion retry uses the
  3-message `[user, assistant, user]` shape.
- `getCriticVerdict(input): Promise<CritiqueVerdict>` (`src/fleet/critic-deep.ts:166`) — drives up
  to `1 + CRITIQUE_PARSE_MAX_RETRIES` (= 2) parse attempts and **fails open**: after two
  unparseable responses it returns `{ verdict: "approve", feedback: "" }` rather than throwing or
  blocking.
- `runCritiqueLoop(input): Promise<FleetManifest>` (`src/fleet/critic-deep.ts:206`) — the
  orchestrator. `approve` returns the current manifest; `reject` (with rounds left) re-expands via
  a **fresh** `runExpandStage({ critiqueFeedback })` and re-critiques; on round/transport/expand
  exhaustion it **accepts-best** (tiebreak: most children, else first-seen baseline) and **never
  throws**. Total `chat` calls never exceed `DEEP_CRITIQUE_MAX_TOTAL_CALLS` = 8.
- `decomposer-deep.ts` additive edits (`src/fleet/decomposer-deep.ts`): `DecomposeDeepInput.critique?`
  (opt-in flag; `undefined`/`false` ⇒ unchanged Phase-3 path); `callExpand` / `runExpandStage` gain
  an optional `critiqueFeedback?` appended to the **first** EXPAND user turn only when present; and
  `decomposeGoalDeep` routes into `runCritiqueLoop` **only** when `input.critique === true`.

## How to use / how it fits

The critique gate sits strictly **after** the structural `validateManifest` gate and (in the
eventual CLI) strictly **before** the atomic write. It is wired through the engine entry point only:

```ts
import { decomposeGoalDeep } from "./fleet/decomposer-deep.js";

// Phase-3 path (default) — plan → expand → return, zero critic calls, ≤4 chat calls:
const baseline = await decomposeGoalDeep({ goal, client, model });

// Phase-4 opt-in — plan → expand → critique-loop → return, ≤8 chat calls:
const refined = await decomposeGoalDeep({ goal, client, model, critique: true });
```

When `critique` is absent or `false`, the call sequence and emitted bytes are **byte-identical to
Phase 3** (the evaluator confirmed a 2-call scripted run matches Phase 3 exactly, with zero critic
calls). The outline produced by `runPlanStage` is captured **once** and reused across the baseline
expand and every re-expand round — there is no second PLAN call, which is what holds the budget at 8.

## Notes for maintainers

- **No CLI shipped this sprint.** The `--critique` flag on `agent-bober fleet expand-deep`, the
  `FleetExpandDeepOptions.critique?` option, and the guarded spread in `runFleetExpandDeep` are
  **Sprint 2** (the finale). Do not document a CLI flag against this sprint. `COMMANDS.md` is
  intentionally untouched.
- **Purely additive, Phase-2/3 byte-locked.** Only `src/fleet/critic-deep.ts` (new),
  `src/fleet/critic-deep.test.ts` (new), and `src/fleet/decomposer-deep.ts` (additive, **0 deleted
  lines**) changed. `decomposer.ts`, `manifest.ts` (`FleetManifestSchema`), `src/fleet/index.ts`
  (the `fleet` / `expand` / `expand-deep` CLI), and `providers/` are byte-unchanged.
- **Never worse than Phase 3.** Every failure mode degrades gracefully — fail-open on parse
  exhaustion, accept-best on transport/expand/round exhaustion — and `runCritiqueLoop` never
  throws. With `CRITIQUE_MAX_ROUNDS = 1` the baseline wins accept-best ties, so a critique run
  cannot return a manifest worse than the Phase-3 baseline.
- **`responseSchema` is never set on a critic call**; both critic calls use `jsonObjectMode: true`
  with `responseSchema === undefined` (spy-asserted), per the DeepSeek provider contract.
- **Re-expansion reuses the single planned outline.** A plan-level degeneracy (a defective PLAN)
  is **not** correctable by the loop; that is a documented limitation (a future re-plan round-type
  would raise the budget beyond 8). The human write-and-stop review remains the backstop.
- **Deferred upgrade paths** (recorded in the architecture, not built here): raising
  `CRITIQUE_MAX_ROUNDS` to 2 (budget 8 → 12), and a graded per-dimension rubric (Approach B) if
  boolean steering proves too coarse.
- This phase's architecture is in `.bober/architecture/` under
  `arch-20260618-fleet-expand-deep-critique-*` (ADR-1: loop structure / boolean critic /
  accept-best; ADR-2: opt-in `critique` field preserves byte-identical Phase-3 default; ADR-3:
  verdict parse surface mirrors `validateOutline`, closed-form fail-open coercion budget; ADR-4:
  reuse `runExpandStage` as the re-expand seam; ADR-5: critic placed after `validateManifest`,
  before the atomic write). It extends Phase 1 `arch-20260609-fleet-orchestrator-tech-lead-*`,
  Phase 2 `arch-20260617-fleet-orchestrator-phase-2-expand-*`, and Phase 3
  `arch-20260617-fleet-robust-decomposition-*`.
