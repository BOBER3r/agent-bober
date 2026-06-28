# Recommendation judge-loop core — 4-lens panel, contraindication VETO, fail-closed dissent

**Contract:** sprint-spec-20260628-medical-analysis-2  ·  **Spec:** spec-20260628-medical-analysis  ·  **Completed:** 2026-06-28

## What this sprint added

The **core safety engine** for medical recommendations: a **pure, fully injectable** multi-lens
judge loop that gates a candidate recommendation through **four independent lenses**
(evidence-grader, contraindication-checker, conservative-clinician, optimization-lens),
reconciles their verdicts by **strict majority with an absolute contraindication VETO**, regenerates
on rejection up to a bounded number of rounds, and **FAILS CLOSED** (no recommendation surfaced,
per-lens dissent captured) when consensus is not reached. The whole module is orchestration over
**injected** functions — the candidate generator, the four lens `LLMClient`s, the profile context,
and the red-flag guard are all parameters. It does **no** fs / network / real-provider / FactStore
work. A new module `src/medical/recommend/` holds the shared types + budget, the four lens adapters
with a never-throwing verdict parser, and the reconcile + loop. The reactive medical engine
(`src/medical/engine.ts`) is **untouched**. **This is the CORE that Sprint 3 wires into a real
path** — provider/model assignment per lens (tier-policy), the real profile context from FactStore,
Finding emission, and the CLI all land in Sprint 3; until then the judge loop is **internal-only**
(there is **no `bober medical recommend` command yet**).

## Public surface

- `runJudgeLoop(input)` (`src/medical/recommend/judge-panel.ts:89`) — the entrypoint. Takes
  `{ question, generateCandidate, lensClients, context, redFlag, maxRounds?, now? }` and returns a
  `PanelOutcome`. Runs the **red-flag guard first** (returns `short-circuit`/`refuse` **before**
  `generateCandidate` is ever called), then loops up to `maxRounds` (default
  `MEDICAL_PANEL_MAX_ROUNDS = 3`): generate a candidate, run all four lenses, reconcile, return
  `accepted` on a clean majority or fold per-lens dissent into the next round's feedback. **Never
  throws** and **never exceeds `MEDICAL_PANEL_MAX_TOTAL_CALLS`**.
- `reconcilePanel(verdicts)` (`src/medical/recommend/judge-panel.ts:43`) — pure reconciliation:
  returns `{ accepted, reason? }`. **Step 1 (first statement):** any
  `verdicts["contraindication-checker"].veto === true` ⇒ `{ accepted: false, reason:
  "contraindication-veto" }`, an early return that runs **before** the vote count. **Step 2:**
  strict majority `approveCount > rejectCount`; a 2-2 tie falls through to `{ accepted: false,
  reason: "no-consensus" }` (fail-closed on tie).
- `getLensVerdict(input)` (`src/medical/recommend/lenses.ts:236`) — calls one injected lens client
  up to `LENS_MAX_LLM_CALLS` (= 2) times with a coercion-retry on unparseable output; **on parse
  exhaustion returns `{ verdict: "reject", veto: false }` (FAIL-CLOSED).**
- `validateLensVerdict(rawText)` (`src/medical/recommend/lenses.ts:65`) — **never-throwing**
  four-tier JSON extraction (direct parse → fenced JSON → first `{ }` block → fail), mirrors
  `validateGroundingVerdict` (`grounding-critic.ts:40-88`). Returns a discriminated
  `ValidateLensResult` (`{ ok: true; verdict }` | `{ ok: false; error }`). `LensVerdictSchema`
  (`lenses.ts:48`) is the Zod shape `{ verdict: "approve"|"reject", feedback: string, veto?:
  boolean }`.
- The four lens system-prompt builders (`src/medical/recommend/lenses.ts`):
  `buildEvidenceGraderSystemPrompt` (`:118`), `buildConservativeCliniciansSystemPrompt` (`:132`),
  `buildOptimizationLensSystemPrompt` (`:146`), `buildContraindicationCheckerSystemPrompt` (`:164`,
  the only one that asks the model for a required `veto` boolean).
- Types (`src/medical/recommend/types.ts`): `LensName` (`:35`, the union of the four lens names),
  `LensVerdict` (`:47`), `LensSpec`/`LensClients` (`:57`/`:63`, one injected `{ client, model }` per
  lens so Sprint 3 can assign a different model per lens), and the `PanelOutcome` discriminated
  union (`:129`) over `AcceptedOutcome` | `RejectedOutcome` | `ShortCircuitOutcome` | `RefuseOutcome`.
- Budget constants (`src/medical/recommend/types.ts`): `LENS_PARSE_MAX_RETRIES = 1` (`:13`),
  `LENS_MAX_LLM_CALLS = 2` (`:16`), `MEDICAL_PANEL_MAX_ROUNDS = 3` (`:19`), and
  **`MEDICAL_PANEL_MAX_TOTAL_CALLS = 27`** (`:26`) — the closed-form worst-case LLM-call bound
  `MEDICAL_PANEL_MAX_ROUNDS × (1 generate + 4 lenses × LENS_MAX_LLM_CALLS) = 3 × (1 + 4×2) = 27`.

## How to use / how it fits

The module is **library-only this sprint** — there is no CLI and no Finding emission yet. A caller
(Sprint 3) injects everything:

```ts
import { runJudgeLoop } from "../medical/recommend/judge-panel.js";

const outcome = await runJudgeLoop({
  question,                       // patient question (also fed to the red-flag guard FIRST)
  generateCandidate,             // (prevFeedback?) => Promise<string> — injected generator
  lensClients,                   // { evidenceGrader, contraindicationChecker, ... }: one LLMClient+model per lens
  context,                       // profile context string (Sprint 3 builds this from FactStore)
  redFlag,                       // GuardrailSet — evaluate() runs before any candidate is generated
  // maxRounds defaults to MEDICAL_PANEL_MAX_ROUNDS (3)
});

switch (outcome.outcome) {
  case "accepted":      // { recommendation, verdicts, rounds } — strict majority, no veto
  case "rejected":      // { reason: "contraindication-veto" | "no-consensus", dissent, verdicts, rounds }
  case "short-circuit": // red-flag matched — { rule, cannedResponse } (generateCandidate NEVER called)
  case "refuse":        // policy refusal — { rule, reason } (generateCandidate NEVER called)
}
```

`PanelOutcome.accepted` carries the **raw candidate string** as `recommendation` — **not** a
Finding. Finding emission, urgency/severity assignment, and the user-facing command are Sprint 3's
job. This loop sits **alongside** the reactive SOP engine and the Sprint-1 proactive review pass; it
shares the medical module's red-flag guardrail contract (`GuardrailSet` / `GuardrailVerdict` from
`src/medical/types.ts`).

## Notes for maintainers

- **Safety invariant #1 — FAIL-CLOSED inversion (independently verified in source by the
  evaluator).** Both the per-lens parse-exhaustion tail (`getLensVerdict`, `lenses.ts:267-270`) and
  the post-loop exhaustion tail (`runJudgeLoop`, `judge-panel.ts:213-216`) **reject** rather than
  accept. This deliberately **mirrors `grounding-critic.ts:203-206`** and **inverts the fleet
  critic's accept-on-exhaustion / fail-open** (`critic-deep.ts:199-201` for parse, `:274-277` for
  the loop). The inversion intent is documented in-code with explicit `grounding-critic.ts` vs
  `critic-deep.ts` line references (an evaluator-required, NonGoal-#3 guarantee). A thrown lens
  client is likewise caught and counted as a **reject** (`judge-panel.ts:173-182`), inverting
  `critic-deep.ts`'s break-to-accept-best on throw — the loop **resolves without throwing** even
  when every lens throws.
- **Safety invariant #2 — the absolute contraindication VETO (independently verified in source).**
  `reconcilePanel`'s **first statement** is the veto check with an early return
  (`judge-panel.ts:44-47`), so it is **structurally impossible** for a vote majority to override a
  veto under any code path (NonGoal #4). 3 approvals + 1 veto ⇒ rejected with reason
  `contraindication-veto`. Only the contraindication-checker lens populates `veto`.
- **Bounded call budget.** The worst case (every round rejects, every lens needs its parse-retry) is
  `MEDICAL_PANEL_MAX_TOTAL_CALLS = 27`; a test asserts the loop's actual call count never exceeds
  it. `now` is an accepted parameter but the loop reads no wall clock itself.
- **Tie semantics.** A 2-2 split is **not** acceptance — strict majority requires `approveCount >
  rejectCount`, so a tie fails closed to `no-consensus`.
- **Purity is enforced, not just claimed.** The module imports no provider factory, no `node:fs`,
  and touches no network or FactStore — the four lens clients, the candidate generator, the profile
  context, and the red-flag guard are all injected. The evaluator confirmed no existing file was
  modified and `engine.ts` is not in the commit.
- **Scope.** Commit `fb467c6`: **5 new files** (`types.ts`, `lenses.ts`, `judge-panel.ts` + two
  collocated `*.test.ts`, 43 tests), purely additive, no new deps. All 7 required criteria
  (sc-2-1..sc-2-7) passed iteration 1; full suite **3072** green (+43, baseline 3029). Eval
  `eval-sprint-spec-20260628-medical-analysis-2-1` → **pass** (7/7 required).
