# Red-flag emergency short-circuit (Gate 2, 0 LLM calls)

**Contract:** sprint-spec-20260616-medical-team-3  ·  **Spec:** spec-20260616-medical-team  ·  **Completed:** 2026-06-16

## What this sprint added

The headline safety guarantee for the medical team: **Gate 2 — a deterministic,
zero-LLM emergency short-circuit.** A new pure/synchronous `RedFlagDetector`
(`src/medical/red-flag.ts`) classifies a prompt into one of five emergency
categories (`cardiac` / `stroke` / `anaphylaxis` / `self-harm` / `overdose`) or
`none`, using conservative case-insensitive phrase matching over a versioned
pattern set — **no imports, no async, no I/O, no model.** The S1–S2 allow-only
`GuardrailSet` stub is replaced by a real `MedicalGuardrails`
(`src/medical/guardrails.ts`) whose `evaluate` runs the detector first and
returns a `short-circuit` verdict carrying a **canned 911/988 escalation** on any
match (988 for self-harm/overdose, 911 otherwise), and throws on an empty prompt.
`MedicalSopEngine.run` now runs this guardrail **immediately after the Gate 1
consent check and before any numerics or LLM work**: a match returns the canned
escalation `MedicalAnswer` (`shortCircuit: true`) plus a PHI-free `short-circuit`
audit entry and reaches **zero** downstream calls. `MedicalSopDeps` also gained
real `llmClient?: LLMClient` and `numerics?` injection slots — the carry-forward
fix from Sprint 2 that makes the "never called" guarantee enforceable by spies.

## Public surface

- `RedFlagDetector` (`src/medical/red-flag.ts:195`) — pure/sync emergency classifier.
  - `detect(prompt: string): RedFlagMatch` (`red-flag.ts:203`) — lowercases + trims the
    prompt, tests it against an ordered conservative rule list, returns the first match
    (`{ category, ruleId }`) or `{ category: "none" }`. Evaluation order is
    self-harm → overdose → cardiac → stroke → anaphylaxis so the correct hotline
    (988 vs 911) wins. Identical input always yields an identical `RedFlagMatch`.
  - `readonly patternsetVersion` (`red-flag.ts:196`) — equals `PATTERNSET_VERSION`.
- `PATTERNSET_VERSION` (`src/medical/red-flag.ts:36`) — `"redflag-2026.06.16"`; the
  versioned pattern-set identifier recorded in the audit log (ADR-2).
- `RedFlagCategory` (`src/medical/red-flag.ts:15`) — `"cardiac" | "stroke" |
  "anaphylaxis" | "self-harm" | "overdose" | "none"`.
- `RedFlagMatch` (`src/medical/red-flag.ts:24`) — `{ category: RedFlagCategory; ruleId?: string }`
  (`ruleId` is undefined only for `none`).
- `MedicalGuardrails` (`src/medical/guardrails.ts:65`) — real `GuardrailSet` implementation
  wrapping `RedFlagDetector`.
  - `evaluate(prompt, ctx): GuardrailVerdict` (`guardrails.ts:80`) — **throws** on an
    empty/whitespace prompt (sc-3-8); a red-flag match returns
    `{ kind: "short-circuit", rule: ruleId, cannedResponse: escalationFor(category) }`;
    otherwise `{ kind: "allow" }`. The `refuse` branch (non-emergency code-enforced
    refusals) is a documented placeholder deferred to S6.
  - `readonly rulesetVersion` (`guardrails.ts:66`) — equals `GUARDRAIL_RULESET_VERSION`.
  - `readonly detector` (`guardrails.ts:72`) — the wrapped `RedFlagDetector` (read-only).
  - `get patternsetVersion(): string` (`guardrails.ts:101`) — re-exposes `PATTERNSET_VERSION`
    so the engine reads it off the guardrail without a separate import.
- `GUARDRAIL_RULESET_VERSION` (`src/medical/guardrails.ts:22`) — `"guardrail-2026.06.16"`.
- `MedicalSopDeps` (`src/medical/engine.ts:29`) — DI seam gained three optional slots:
  `guardrails?: GuardrailSet`, `llmClient?: LLMClient`, and `numerics?: () => unknown`.
  Production leaves them undefined and `run()` defaults `guardrails` to
  `new MedicalGuardrails()`; the zero-arg `new MedicalSopEngine()` contract is preserved.

## How to use / how it fits

The detector and guardrail are pure and free-standing — `RedFlagDetector.detect`
and `MedicalGuardrails.evaluate` can be called directly:

```ts
const guardrails = new MedicalGuardrails();
const verdict = guardrails.evaluate("I think I'm having a heart attack", {});
// => { kind: "short-circuit", rule: "cardiac-heart-attack",
//      cannedResponse: "This may be a medical emergency. Call 911 ... now." }
```

Inside `MedicalSopEngine.run` the gate ordering is now:
(1) Gate 1 consent (S2) → (2) **Gate 2 `guardrails.evaluate(userPrompt, {})`**.
On a `short-circuit` verdict the engine appends a `short-circuit` audit entry
(`{ event, ruleId, rulesetVersion, patternsetVersion }` — IDs/enums only, no
prompt text), returns a `MedicalAnswer` whose `body` is the canned escalation with
the disclaimer footer and `shortCircuit: true`, and reaches **no** numerics/LLM.
On `allow` it falls through to the existing placeholder normal path. Tests inject
spy `llmClient`/`numerics` fakes through `MedicalSopDeps` and assert both are never
called on a short-circuit — the same `this.deps.llmClient` / `this.deps.numerics`
fields the real SOP will route through in S4/S6. `team.ts:buildMedicalGuardrails`
now returns `new MedicalGuardrails()` instead of the allow-all stub, so the
built-in `medical` team carries the real guardrail.

## Notes for maintainers

- **Carry-forward (S6) — residual hollow sc-2-4 assertions.** The original Sprint 2
  fail-closed test in `engine.test.ts` still constructs `llmSpy`/`numericsSpy` but
  does **not** inject them into the engine constructor, so those specific
  assertions remain structurally hollow. The new consent-ordering invariant test
  added this sprint injects spies properly through `MedicalSopDeps` and provides
  the genuine guarantee — the seam is correct. When S6 touches `engine.test.ts`,
  either inject the spies into the sc-2-4 ctor via `llmClient`/`numerics` or remove
  the dead assertions. (Non-blocking; eval verdict was PASS.)
- **Carry-forward (S6.5 counsel / patternset revision) — advisory red-flag
  false-negatives.** Per ADR-2 the pattern set deliberately favors escalation
  reliability over paraphrase coverage, so novel/indirect phrasing may return
  `none` and fall through to the (still-guardrailed) normal path. Known advisory
  gaps observed by the evaluator: `"I want to end it all"` → `none`,
  `"my chest hurts and I cannot breathe"` → `none`, and `"myocardial infarction"`
  → `none`. These are **not** a Sprint 3 failure (sc-3-4 requires one
  representative prompt per category, which passes); surface them to the patternset
  revision and the external S6.5 counsel review, and consider expanding the
  cardiac/self-harm phrasings in a future `PATTERNSET_VERSION` bump.
- **Escalation strings are never model-generated.** `ESCALATION_911` /
  `ESCALATION_988` are fixed constants returned verbatim. Detection is
  deterministic and local only — do not route red-flag classification through an
  LLM (an explicit non-goal).
- **`patternsetVersion` is read off the guardrail via a runtime `in` check.** The
  engine writes `guardrails.patternsetVersion` into the audit entry using
  `"patternsetVersion" in guardrails` rather than coupling to the concrete
  `MedicalGuardrails` type, so a custom `GuardrailSet` without the getter simply
  omits the field.
- **`refuse` branch is a placeholder.** Real content-policy refusals (treatment
  plans, prescriptions, etc.) land in S6 and must follow the same "IDs/enums only
  in the audit" rule with a dedicated ruleset.
- **No SDK/network in the safety path.** Both `red-flag.ts` and `guardrails.ts`
  import nothing from `src/providers` or any network module (asserted by
  source-read tests, sc-3-5 / sc-3-8).
