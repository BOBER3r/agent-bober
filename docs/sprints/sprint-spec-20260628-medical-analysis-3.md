# Recommendation generation end-to-end + `bober medical recommend` CLI

**Contract:** sprint-spec-20260628-medical-analysis-3  ·  **Spec:** spec-20260628-medical-analysis  ·  **Completed:** 2026-06-28

## What this sprint added

The sprint that **closes the recommendation loop**: it wires the Sprint-2 judge panel into a
**real, user-facing recommendation path**. `generateRecommendation` assembles the patient's
profile context from the `FactStore` and the SOPS medical profile, builds four per-lens
`LLMClient`s (tier-diverse providers when cloud inference is allowed, **all-local fail-closed**
otherwise), generates a candidate, gates it through the Sprint-2 `runJudgeLoop`, and emits a
**Finding** keyed by the panel outcome: an accepted recommendation becomes a `kind: "action"`
Finding stating the advice **directly with no refer-out hedging** plus an LLM-assigned
urgency/severity/confidence; a no-consensus panel becomes a `kind: "question"` Finding **flagged
for your review** carrying the per-lens dissent; a red-flag short-circuit returns the **canned
escalation and writes no Finding**. A per-outcome `AuditLog` entry (IDs/enums only) is appended.
It is exposed as a new `bober medical recommend [--goal <g>] <question>` subcommand. The Sprint-2
`runJudgeLoop` and the Sprint-1 finding-writer are **imported, not re-implemented**, and the
reactive engine (`src/medical/engine.ts`) is **untouched**.

## Public surface

- `bober medical recommend <question> [--goal <g>]` (`src/cli/commands/medical.ts:378`) — generates a
  recommendation through the 4-lens judge panel and writes a Finding note. Reads the wall clock
  **only here** (the CLI boundary) and threads it in as `now`. Prints whether the recommendation was
  **accepted** (green + finding path), **flagged for review** (yellow + finding path), **escalated**
  (red + canned response), or **refused** (yellow + reason), and exits 0 on every normal outcome; on
  an unexpected error it writes to stderr and sets `process.exitCode = 1` **without throwing**.
  Nested subcommand under `medical`, **not** a top-level command.
- `generateRecommendation(projectRoot, config, opts, deps?)` (`src/medical/recommend/recommend.ts:108`)
  — the importable entrypoint. `opts = { question: string; goal?: string; now: ISO-8601 }`. Returns a
  discriminated `RecommendOutcome { kind: "accepted" | "question" | "escalated" | "refused";
  findingPath?; cannedResponse?; reason? }` (`recommend.ts:48,50`). `deps` (`RecommendDeps`,
  `recommend.ts:66`) injects lens clients, the candidate generator, the red-flag guard, the urgency
  assigner, the finding writer, an open `FactStore`, the `EgressGuard`, a `ClientFactory`, the
  `AuditLog`, and a `ProfileCipher` so tests run with **no real network or fs**.
- `assembleRecommendationContext(projectRoot, config, opts, deps?)` (`src/medical/recommend/context.ts:48`)
  — **pure, no LLM/network**. Reads **meds** via `FactStore.getActiveFacts("medical", "patient",
  "takes-medication")` and **supplements** via the **`"dose"` predicate** (subject = supplement name,
  value = dose — *not* `"takes-supplement"`; matches the supplements writer at `supplements.ts:106-121`),
  and **conditions / allergies / goals** via `readProfile` against `<root>/.bober/medical`. Every read
  is wrapped so a missing facts dir or absent/unreadable profile **degrades to empty arrays** (functional,
  not fatal). An explicit `opts.goal` wins; otherwise it falls back to the first profile goal. Returns
  `RecommendationContext` (`context.ts:24`). Opens its own `FactStore` and closes it in `finally` unless
  one is injected (caller owns an injected store).
- `contextToString(ctx)` (`src/medical/recommend/context.ts:110`) — serializes a `RecommendationContext`
  to the plain string `runJudgeLoop` expects (`Medications: … / Supplements: … / Conditions: … /
  Allergies: … / Goal: …`, each line `none` when empty).
- `assignUrgencySeverity(llm, model, candidate, context)` (`src/medical/recommend/urgency.ts:129`) —
  **one bounded LLM call** (`jsonObjectMode`) returning `UrgencyResult { urgency, severity, confidence }`
  (`urgency.ts:30`). Uses a **never-throwing** four-tier JSON extractor (mirrors Sprint-2
  `validateLensVerdict`), **clamps `urgency`/`severity` to the integer range 1..5**, and returns the
  conservative default `{ urgency: 3, severity: 3, confidence: 0.5 }` on transport failure or unparseable
  output. By design it sits **outside the ADR-3 deterministic-numerics boundary** — these values are
  *interpretation*, not arithmetic.

## How to use / how it fits

```bash
# Ask for a recommendation; the panel decides accept / flag-for-review / escalate:
bober medical recommend --goal "optimize energy" "what should I do about my high LDL"
#   Recommendation accepted
#     finding: /abs/.bober/medical/vault/findings/<id>.md
```

Or call the entrypoint directly (e.g. from a future scheduler), injecting the clock at the boundary:

```ts
import { generateRecommendation } from "../medical/recommend/recommend.js";

const result = await generateRecommendation(projectRoot, config, {
  question: "what should I do about my high LDL",
  goal: "optimize energy",
  now: new Date().toISOString(), // clock read ONLY at this boundary
});
// result.kind: "accepted" | "question" | "escalated" | "refused"
```

The closed loop, in order:

1. **Red-flag first.** `runJudgeLoop` evaluates the `MedicalGuardrails` red-flag guard **before any
   candidate is generated**. A match returns the canned escalation, appends a `short-circuit` audit
   entry, and **writes no Finding**.
2. **Context.** `assembleRecommendationContext` reads meds/supplements from the `FactStore` and
   conditions/allergies/goals from the profile, defaulting to empty when absent.
3. **Lenses.** Four per-lens clients are built — distinct tier providers (cheap/standard/hard/frontier)
   **only when `cloud-inference` egress is allowed**, otherwise all four lenses + the candidate
   generator resolve via `buildMedicalInferenceClient` to the local Ollama model.
4. **Judge loop.** `runJudgeLoop` (Sprint 2) generates a candidate and reconciles the four verdicts by
   strict majority with the absolute contraindication veto.
5. **Finding emission + audit.** Accepted ⇒ `kind: "action"` Finding (`assignUrgencySeverity` fills
   urgency/severity, `confidence:<x>` tag) + `answer` audit entry. No-consensus ⇒ `kind: "question"`
   Finding flagged for review with the dissent + `abstain` audit entry. Escalation/refusal ⇒ canned
   response, **no Finding** + `short-circuit`/`refuse` audit entry.

This is the **proactive recommendation surface**; it sits **alongside** the reactive `bober chat
medical` SOP engine, which is unchanged. Findings land in the canonical vault `findings/` dir via the
Sprint-1 writer; cross-repo ranking of action Findings is owned by `spec-20260628-priority-hub`.

## Notes for maintainers

- **Evaluator-verified invariant #1 — fail-closed model selection (sc-3-5).** When
  `egress.isAllowed("cloud-inference")` is `false`, the entire cloud tier branch is **skipped** and all
  four lenses **and** the candidate generator resolve through `buildMedicalInferenceClient` to the local
  openai-compat model at `localhost:11434`. The evaluator spied the `ClientFactory` and confirmed it was
  **never** called with `anthropic` / `x.ai` / `deepseek` — **no cloud client is constructed** when cloud
  inference is off (NonGoal #2). The injectable `deps.clientFactory` is threaded through *both* the
  cloud-on tier path and the fail-closed local path so this is provable in source.
- **Evaluator-verified invariant #2 — no refer-out hedging on accepted Findings (sc-3-2).** The accepted
  `kind: "action"` Finding's title and evidence carry the recommendation text **directly**; no
  "consult a licensed healthcare professional" style hedging is inserted. The test negative-asserts the
  absence of that phrase against the written markdown.
- **Audit stays PHI-free (NonGoal #3).** Every outcome appends exactly one `AuditLog` entry with
  IDs/enums only (`event: "answer" | "abstain" | "short-circuit" | "refuse"`, plus `ruleId` /
  `rulesetVersion` for guard hits). No recommendation text and no health values are ever written to the
  audit log.
- **Idempotent Finding ids.** Both emitted Findings use the deterministic Sprint-1
  `findingId("medical", question, "recommend-action" | "recommend-question")` — `now` is **not** part of
  the id, so re-asking the same question overwrites the same note instead of creating duplicates.
- **Supplement predicate gotcha.** Supplements are read with predicate **`"dose"`** (the predicate the
  supplements writer actually uses), **not** the contract's paraphrase `"takes-supplement"`. Future
  readers extending the context assembler must match `supplements.ts`.
- **`engine.ts` is no-touch.** The red-flag short-circuit + canned-escalation pattern was **copied**
  (not imported) from `engine.ts:250-289`, and `runJudgeLoop` was imported from Sprint 2 — `engine.ts`
  is not in the commit (evaluator-confirmed via `git diff`).
- **Scope.** Commit `3b2abb9`: 3 new `src/medical/recommend/*` modules (`context.ts`, `urgency.ts`,
  `recommend.ts`) + 3 collocated `*.test.ts` (25 new tests across context/urgency/recommend) + the
  additive `medical recommend` CLI subcommand. No new deps. All 6 required criteria (sc-3-1..sc-3-6) +
  the optional sc-3-7 passed iteration 1; full suite **3097** green (+25, baseline 3072). Eval
  `eval-sprint-spec-20260628-medical-analysis-3-1` → **pass** (7/7).
