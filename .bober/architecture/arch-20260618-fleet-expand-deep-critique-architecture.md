# Architecture: Fleet Expand-Deep Self-Judged Critique Gate

**Architecture ID:** arch-20260618-fleet-expand-deep-critique
**Generated:** 2026-06-18T00:00:00Z
**Status:** draft

---

## Executive Summary

`fleet expand-deep` writes any manifest that passes the structural validateManifest gate, so a shape-valid-but-degenerate result — for example 2 children for a 12-area outline — is written and reaches the human write-and-stop review as the only defense. This architecture adds a self-judged critique gate behind a `--critique` flag (Approach A): a fresh LLM-as-critic returns a boolean `approve|reject` verdict plus free-text feedback, and on reject the manifest is re-expanded through a fresh runExpandStage seeded with that feedback, bounded by a single round and a closed-form call budget of DEEP_CRITIQUE_MAX_TOTAL_CALLS=8. The key tradeoff accepted is coarse boolean steering (rejecting graded rubric scores) in exchange for the smallest assertable parse surface and a closed-form budget. The primary risk is an extra chat call leaking onto the default no-flag path, which would break the byte-identical Phase-3 guarantee; this is held by a guarded spread and a golden regression test. On all failure modes the gate fails open or accepts-best, never throwing, so behavior degrades to current Phase-3 and never below it.

---

## Problem Statement

**Problem:** `fleet expand-deep` has no automated semantic quality gate; a shape-valid-but-degenerate manifest (2 children for a 12-area outline) passes the structural validateManifest (decomposer.ts:95-155) and is written, leaving the human write-and-stop review (index.ts:355-363) as the only defense.

**Constraints:**
- Latency: not specified as a figure (single-goal CLI; transient in-memory outline).
- Throughput: not specified (single goal per invocation).
- Data volume: not specified (one outline + one manifest, in-memory).
- Cost ceiling: proxied by a HARD explicit total-call budget constant — lineage DEEP_MAX_TOTAL_CALLS=4 (decomposer-deep.ts:74), "bounded by an explicit constant, never an open loop".
- Backward compatibility: with `--critique` ABSENT, `fleet expand-deep` must be byte-identical to Phase 3 — same decomposeGoalDeep call sequence, atomic write (index.ts:346-349), printed output, `--yes` gate, default out `.bober/fleet-expand.json`.

**Consumers:** human operator running `fleet expand-deep <goal> --critique`; downstream runFleet(outPath) behind `--yes`; the internal decomposeGoalDeep engine being wrapped.

**Success Criteria:**
- With `--critique`, a scripted under-expanded candidate (ScriptedClient, deterministic) is rejected and re-expanded into an adequately-sized manifest.
- Total LLMClient.chat calls on the `--critique` path never exceed DEEP_CRITIQUE_MAX_TOTAL_CALLS=8 for any input, including an all-reject run.
- With `--critique` absent, the call sequence, written bytes, and printed output are byte-identical to Phase 3 (zero extra chat calls).
- Every critic call uses `jsonObjectMode:true` and the manifest still passes the unchanged validateManifest before write (the critique is an additive gate).

**Locked Dependencies:** byte-locked default surface (runFleetExpandDeep index.ts:299-386 and registerFleetExpandDeepSubcommand index.ts:396-432 on the no-flag path); LOCK1 fresh critic (a separate clean LLMClient.chat, not told it authored the manifest, may not extend the 3-message EXPAND coercion); LOCK2 `--critique` boolean flag, not a sibling command; provider contract `jsonObjectMode:true` never responseSchema (types.ts:174,183); validateManifest and FleetManifestSchema unchanged children-only contract; ESM `.js` imports, provider-agnostic boundary, Zod, async `node:fs/promises`.

---

## System Overview

The critique gate is an additive wrapper placed between the existing EXPAND output and the unchanged structural validateManifest/atomic-write path of `fleet expand-deep`. When `--critique` is present, decomposeGoalDeep routes its already-validated FleetManifest into runCritiqueLoop, which asks a fresh critic (its own clean prompt, told only to "review this" third-party manifest) for a boolean verdict. An approve returns the manifest immediately; a reject within the single permitted round folds the critic's free-text feedback into a fresh runExpandStage that reuses the outline captured once during planning, re-validates structurally, and re-submits to the critic. On round exhaustion the loop accepts the best manifest (tiebreak: most children, then first-seen/baseline) and never throws, so the human write-and-stop review always receives a structurally-valid manifest.

The design manifests Approach A's three commitments — boolean critic, reused runExpandStage as the re-expand seam, and accept-best-on-exhaustion — as a new module src/fleet/critic-deep.ts plus two single-field augmentations to the existing decomposer-deep.ts and index.ts. The whole feature is gated by one optional field threaded through a guarded spread so that, when absent, the decompose argument object and downstream call sequence are structurally identical to Phase 3. Every count is a constant: the budget is the closed form DEEP_CRITIQUE_MAX_TOTAL_CALLS = DEEP_MAX_TOTAL_CALLS + CRITIQUE_MAX_ROUNDS × (2 + DEEP_EXPAND_MAX_RETRIES) = 4 + 1 × (2 + 2) = 8, assertable end-to-end via ScriptedClient.calls.

---

## Component Breakdown

### CritiqueConstants

**Responsibility:** Own all fixed counts that bound the critique loop and its budget.

**Interface:**
```typescript
export const CRITIQUE_MAX_ROUNDS = 1;
export const CRITIQUE_PARSE_MAX_RETRIES = 1;
// closed form: DEEP_MAX_TOTAL_CALLS(4) + CRITIQUE_MAX_ROUNDS(1) * ((1+CRITIQUE_PARSE_MAX_RETRIES) + (1+DEEP_EXPAND_MAX_RETRIES))
export const DEEP_CRITIQUE_MAX_TOTAL_CALLS = 8;
```

**Dependencies:** []

---

### CritiqueVerdictValidator

**Responsibility:** Parse raw critic text into a typed verdict via tolerant JSON extraction plus Zod, never throwing.

**Interface:**
```typescript
import { z } from "zod";

export const CritiqueVerdictSchema = z.object({
  verdict: z.enum(["approve", "reject"]),
  feedback: z.string(),
});
export type CritiqueVerdict = z.infer<typeof CritiqueVerdictSchema>;

export type ValidateVerdictResult =
  | { ok: true; verdict: CritiqueVerdict }
  | { ok: false; error: string };

export function validateVerdict(rawText: string): ValidateVerdictResult;
```

**Dependencies:** []

---

### FreshCriticCaller

**Responsibility:** Issue the fresh-critic chat call and return a parsed verdict, bounded by a parse-retry budget and failing open on exhaustion.

**Interface:**
```typescript
export const CRITIQUE_SYSTEM_PROMPT: string;
export const CRITIQUE_COERCION_INSTRUCTION: string;

type CallCriticInput = {
  client: LLMClient;
  model: string;
  goal: string;
  outline: Outline;
  candidate: FleetManifest;
  priorText?: string;
  formattedError?: string;
};

export function callCritic(input: CallCriticInput): Promise<string>;

type GetVerdictInput = {
  client: LLMClient;
  model: string;
  goal: string;
  outline: Outline;
  candidate: FleetManifest;
};

export function getCriticVerdict(input: GetVerdictInput): Promise<CritiqueVerdict>;
```

**Dependencies:** [CritiqueVerdictValidator, CritiqueConstants]

---

### CritiqueLoopOrchestrator

**Responsibility:** Drive the bounded approve/reject/re-expand loop and return the chosen manifest, never throwing and never exceeding the call budget.

**Interface:**
```typescript
type RunCritiqueLoopInput = {
  client: LLMClient;
  model: string;
  goal: string;
  outline: Outline;
  baseline: FleetManifest;
  expandMaxRetries: number;
};

export function runCritiqueLoop(input: RunCritiqueLoopInput): Promise<FleetManifest>;
```

**Dependencies:** [FreshCriticCaller, CritiqueConstants, DeepDecomposerCore]

---

### DeepDecomposerCore

**Responsibility:** Augment decomposer-deep.ts to route into the critique loop only when `critique===true`, keeping the absent path byte-identical to Phase 3.

**Interface:**
```typescript
export interface DecomposeDeepInput {
  goal: string;
  client: LLMClient;
  model: string;
  count?: string;
  planMaxRetries?: number;
  expandMaxRetries?: number;
  critique?: boolean; // NEW; undefined/false ⇒ Phase-3 path
}

// runExpandStage gains one optional field, appended to the FIRST EXPAND
// user message only when present:
type RunExpandStageInput = {
  // ...existing fields...
  critiqueFeedback?: string; // NEW
};

export function decomposeGoalDeep(input: DecomposeDeepInput): Promise<FleetManifest>;
```

**Dependencies:** [CritiqueLoopOrchestrator]

---

### FleetExpandDeepCli

**Responsibility:** Augment index.ts to expose the `--critique` flag and thread it into the decompose call via a guarded spread, leaving all other CLI steps untouched.

**Interface:**
```typescript
export interface FleetExpandDeepOptions {
  // ...existing fields...
  critique?: boolean; // NEW
}

// registerFleetExpandDeepSubcommand adds: .option("--critique", "...")
// runFleetExpandDeep threads: ...(opts.critique ? { critique: true } : {})
export function runFleetExpandDeep(
  goal: string,
  opts: FleetExpandDeepOptions,
): Promise<void>;
```

**Dependencies:** [DeepDecomposerCore]

---

## Data Model

All critique-loop state is transient in-memory and single-process; nothing new is persisted. The on-disk contract is the unchanged children-only FleetManifestSchema written atomically by the existing CLI.

```typescript
// Existing, unchanged — captured once during planning, reused across rounds:
type OutlineArea = { name: string; intent: string };
type Outline = { areas: OutlineArea[] };

// New, never persisted — exists only inside runCritiqueLoop:
type CritiqueVerdict = {
  verdict: "approve" | "reject";
  feedback: string;
};
```

---

## API Contracts

| Method | Input | Output | Error Cases |
|--------|-------|--------|-------------|
| validateVerdict | rawText: string | ValidateVerdictResult | Returns `{ok:false,error}` on non-extractable/non-Zod-valid text; never throws |
| callCritic | CallCriticInput | Promise<string> | Transport throw from LLMClient.chat propagates to caller (caught by loop → accept-best) |
| getCriticVerdict | GetVerdictInput | Promise<CritiqueVerdict> | On parse exhaustion after (1+CRITIQUE_PARSE_MAX_RETRIES) calls, fails OPEN returning `{verdict:"approve",feedback:""}` |
| runCritiqueLoop | RunCritiqueLoopInput | Promise<FleetManifest> | Never throws; on exhaustion accepts best (tiebreak most children, then baseline); total chat ≤ 8 |
| decomposeGoalDeep | DecomposeDeepInput | Promise<FleetManifest> | `critique` absent ⇒ Phase-3 path (≤4 chat); present ⇒ ≤8 chat |
| runFleetExpandDeep | (goal, FleetExpandDeepOptions) | Promise<void> | Credential failure synchronous at createClient before any IO |

---

## Integration Strategy

### Data Flow

```
Operator → runFleetExpandDeep(goal, { critique: true })
  → decomposeGoalDeep({ ..., critique: true })
    → runPlanStage()                    // outline captured ONCE, reused across rounds
    → runExpandStage()                  // STRUCTURAL gate: validateManifest (decomposer-deep.ts:303)
    → runCritiqueLoop({ outline, baseline })
        → getCriticVerdict(...)         // SEMANTIC gate, fresh critic, jsonObjectMode:true
            approve → return baseline
            reject + rounds left → runExpandStage({ critiqueFeedback }) // re-validate, re-critic
            exhausted → accept BEST (most children, else baseline)
    → returns FleetManifest to index.ts:325
  → ATOMIC WRITE rename(tmp, outPath) (index.ts:349)
  → printed output, --yes gate (unchanged)
Operator reviews written manifest (write-and-stop)
```

With `--critique` absent: zero critic calls, ≤4 chat calls — byte-identical to Phase 3. With `--critique` present: ≤8 chat calls (DEEP_CRITIQUE_MAX_TOTAL_CALLS). The critic call sits strictly AFTER validateManifest and strictly BEFORE the atomic write.

### Consistency Model

Strong / single-process sequential. All loop state is in-memory and strictly sequential — there are no concurrent writers and no cache. The outline is captured once and reused across rounds (no second PLAN call), which is what holds the budget at 8. The manifest is durable only at the `rename` step; nothing is written until the critic has approved or accept-best has chosen. ScriptedClient tests pin the exact call order and count.

### External Dependencies

| Service | Used By | Failure Mode | Fallback |
|---------|---------|--------------|----------|
| DeepSeek via LLMClient.chat | FreshCriticCaller, DeepDecomposerCore | Credential missing | Synchronous failure at createClient before any IO |
| DeepSeek via LLMClient.chat | FreshCriticCaller | Transport throw mid-loop | Caught by runCritiqueLoop → accept-best, never throws |
| DeepSeek via LLMClient.chat | FreshCriticCaller | Unparseable critic output | validateVerdict `{ok:false}` → parse-retry → fail-open approve |

### Integration Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Extra chat call leaks onto the default no-flag path, breaking Phase-3 byte-identity | critical | Guarded spread `...(opts.critique?{critique:true}:{})` plus golden regression test pinning the Phase-3 call sequence and written bytes |
| Total call ceiling exceeded on the `--critique` path | critical | All-constant bounded counters; closed-form DEEP_CRITIQUE_MAX_TOTAL_CALLS=8; all-reject 8-response ScriptedClient test |
| Fail-open masks a degenerate manifest | high | Logged each parse failure; structural validateManifest gate still held; human write-and-stop backstop |
| responseSchema leaks into a critic call → DeepSeek 400 | high | Spy test asserts `responseSchema===undefined && jsonObjectMode===true` on every critic call |
| Critic primed as the author (violates LOCK1) | high | Own CRITIQUE_SYSTEM_PROMPT, clean message array, candidate presented as a third-party "review this" |
| Reused outline when the PLAN itself is the defect | medium | Documented limitation; re-plan deferred (see Open Questions); plan-level defect surfaces in human write-and-stop |
| Accept-best tiebreak picks a worse manifest | medium | With CRITIQUE_MAX_ROUNDS=1 the baseline (first-seen) wins ties; result is never worse than Phase 3 |
| Verdict parse drifts from validateOutline | medium | validateVerdict structurally mirrors validateOutline (decomposer-deep.ts:107-155); shared-shape test |

---

## Architecture Decision Records

- [ADR-1: Critique/refine loop structure — boolean critic, reused runExpandStage re-expand, accept-best-on-exhaustion](.bober/architecture/arch-20260618-fleet-expand-deep-critique-adr-1.md)
- [ADR-2: Opt-in `critique` field on DecomposeDeepInput preserves byte-identical Phase-3 default](.bober/architecture/arch-20260618-fleet-expand-deep-critique-adr-2.md)
- [ADR-3: Verdict parse surface mirrors validateOutline; coercion budget closed-form and fail-open](.bober/architecture/arch-20260618-fleet-expand-deep-critique-adr-3.md)
- [ADR-4: Reuse runExpandStage as the re-expand seam instead of a new re-expand component](.bober/architecture/arch-20260618-fleet-expand-deep-critique-adr-4.md)
- [ADR-5: Critic call placed after validateManifest, before atomic write](.bober/architecture/arch-20260618-fleet-expand-deep-critique-adr-5.md)

---

## Risk Assessment

| Risk | Severity | Owner | Mitigation |
|------|----------|-------|------------|
| Extra chat call leaks onto the default no-flag path | critical | FleetExpandDeepCli | Guarded spread + golden regression test pinning Phase-3 sequence and bytes |
| Call ceiling exceeded on `--critique` path | critical | CritiqueLoopOrchestrator | Closed-form DEEP_CRITIQUE_MAX_TOTAL_CALLS=8; all-reject 8-response ceiling test |
| responseSchema leaks into a critic call → DeepSeek 400 | high | FreshCriticCaller | Spy test asserts responseSchema===undefined && jsonObjectMode===true |
| Critic primed as author (LOCK1 breach) | high | FreshCriticCaller | Own system prompt, clean array, third-party "review this" framing |
| Fail-open silently no-ops a degenerate manifest | high | FreshCriticCaller | Log each parse failure; structural gate + human write-and-stop backstop |
| Reused outline cannot fix a plan-level defect | medium | DeepDecomposerCore | Documented; re-plan deferred; surfaces in human write-and-stop |
| Accept-best tiebreak picks a worse manifest | medium | CritiqueLoopOrchestrator | Rounds=1 → baseline wins ties; never worse than Phase 3 |
| Verdict parse drifts from validateOutline | medium | CritiqueVerdictValidator | Mirror validateOutline shape; shared-shape test |

---

## Open Questions

- **Re-plan as a future round-type for plan-level degeneracy (Risk: reused outline cannot fix a plan-level defect):** Assumed out of scope — re-expansion reuses the single planned outline, so a degenerate root-cause in the PLAN is not correctable by the loop. If this assumption is wrong (plan-level degeneracy is common), a future re-plan round-type would be needed, raising the budget beyond 8.
- **Whether CRITIQUE_MAX_ROUNDS should rise to 2 for more correction headroom:** Assumed 1 round is sufficient because a single feedback-seeded re-expansion corrects the modeled degenerate case. If one round proves too few in practice, raising to 2 increases DEEP_CRITIQUE_MAX_TOTAL_CALLS from 8 to 12.
- **Graded rubric (Approach B) as a future upgrade if boolean steering proves too coarse:** Assumed boolean `approve|reject`+feedback steers re-expansion adequately, chosen for the smallest assertable parse surface. If boolean feedback is too coarse to correct under-expansion reliably, a per-dimension rubric with a threshold would replace the boolean verdict at the cost of a wider numeric parse surface.
