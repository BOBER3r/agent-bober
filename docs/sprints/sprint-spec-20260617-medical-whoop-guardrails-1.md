# Code-enforced non-emergency refusal layer

**Contract:** sprint-spec-20260617-medical-whoop-guardrails-1  ·  **Spec:** spec-20260617-medical-whoop-guardrails  ·  **Completed:** 2026-06-17

## What this sprint added

Closes the **non-emergency content-policy refusal gap** in the medical team: the
`{kind:"refuse"}` verdict (and the `refuse` audit event) already existed in the type
surface but was **never emitted** — prescription / dosing / treatment-plan requests
fell through to `{kind:"allow"}` and were refused **prompt-only by the LLM**, not
code-enforced before any model call. This sprint makes refusal **deterministic and
pre-LLM**: a new pure/synchronous `RefusalDetector` (sibling to `RedFlagDetector`)
classifies a prompt into `prescription` / `specific-dosing` /
`individualized-treatment-plan` / `none`; `MedicalGuardrails.evaluate` now emits a
`refuse` verdict with **fixed, never-model-generated** decline text **after** the
red-flag short-circuit (so emergency precedence is preserved); and
`MedicalSopEngine.run` gained a refuse-dispatch branch that returns the canned answer
(`shortCircuit: true`), writes an IDs-only `refuse` audit entry, and reaches **zero**
numerics / retrieval / LLM. This is **Sprint 1 of the whoop-guardrails spec** — it is
self-contained, has no network, and does not touch WHOOP.

## Public surface

### `src/medical/refusal.ts` (new — pure, 0-LLM, zero imports)

- `type RefusalCategory` (`refusal.ts:14`) — `"prescription" | "specific-dosing" |
  "individualized-treatment-plan" | "none"`. Mutually exclusive; `none` means no
  refusal pattern matched.
- `interface RefusalMatch` (`refusal.ts:22`) — `{ category; ruleId? }`. `ruleId` is an
  opaque short-form ID (e.g. `rx-request-modal`, `dose-quantity-mg`, `txplan-for-me`)
  recorded in the audit — **never prompt text**; undefined when `category === "none"`.
- `const REFUSAL_PATTERNSET_VERSION` (`refusal.ts:31`) — `"refusal-2026.06.17"`. The
  versioned pattern-set identifier written to the audit log.
- `const REFUSAL_REASONS` (`refusal.ts:54`) — `Record<Exclude<RefusalCategory,"none">,
  string>`: the **fixed canned decline strings** per category. Exported so callers can
  assert byte-equality (proving the reason is not model-generated). Each is a
  *decline + see-a-licensed-clinician* message, deliberately **distinct from** the
  911/988 emergency escalations (no `"911"` / `"988"` / `"emergency"`).
- `class RefusalDetector` (`refusal.ts:159`) — `detect(prompt): RefusalMatch` plus a
  readonly `patternsetVersion`. **Pure + synchronous** (no async / fs / network / LLM
  import). Lowercases + trims the prompt and returns the first matching rule, or
  `{ category: "none" }`. Evaluation order is prescription → specific-dosing →
  treatment-plan over a conservative ~4-rules-per-category list.

### `src/medical/guardrails.ts` (extended — now emits refuse)

- `MedicalGuardrails.refusal` (`guardrails.ts:73`) — a readonly `RefusalDetector`
  instance alongside the existing `detector` (`RedFlagDetector`).
- `MedicalGuardrails.evaluate(prompt, ctx)` — after the red-flag match check (which
  early-returns `short-circuit`), now runs `this.refusal.detect(prompt)`; on a non-`none`
  category it returns `{ kind: "refuse", rule: ruleId ?? category, reason:
  REFUSAL_REASONS[category] }`. Benign prompts still return `{ kind: "allow" }`. The
  empty-prompt throw and the signature are unchanged; `GuardrailContext` stays empty
  (ADR-3).
- `get refusalPatternsetVersion()` (`guardrails.ts:118`) — exposes
  `REFUSAL_PATTERNSET_VERSION` so the engine can stamp it into the refuse audit entry
  without a separate import (mirrors the existing `patternsetVersion` getter).

### `src/medical/engine.ts` (extended — refuse-dispatch branch)

- `MedicalSopEngine.run` — a new **Gate 2b** branch sits **after** the red-flag
  short-circuit branch (`engine.ts:291`). On `verdict.kind === "refuse"` it: appends a
  `refuse` audit entry (`ruleId` + `rulesetVersion` + `refusalPatternsetVersion`, IDs/
  enums only — no prompt text or health values); returns a `MedicalAnswer` with
  `body === verdict.reason`, `shortCircuit: true`, `abstained: false`, `citations: []`,
  and the disclaimer footer; and reaches **no** numerics / FactStore / retrieval / LLM.
  It mirrors the existing consent-refuse path; the `run` signature and zero-arg
  constructor are unchanged.

## How to use / how it fits

The refuse layer is entirely internal to the medical SOP — there is no new CLI or
config surface. It activates automatically inside `MedicalSopEngine.run`
(`pipelineShape "medical-sop"`, reached via `loadTeam(config, "medical")`). The
guardrail gate order is now:

```
consent (Gate 1, fail-closed)
  → red-flag short-circuit (Gate 2, emergency precedence — 0 LLM)
    → refuse (Gate 2b, non-emergency content-policy — 0 LLM)   ← NEW this sprint
      → allow (proceed to the full SOP: numerics → meds → egress → retrieval → …)
```

A prompt like *"can you prescribe me amoxicillin?"* now returns a code-enforced
`refuse` answer (canned decline + clinician referral) **before** any model call; a
prompt that contains **both** an emergency red-flag trigger **and** a refuse trigger
still short-circuits to the 911/988 escalation (red-flag wins by early return). Benign
informational prompts are unaffected — they `allow` and flow into the normal SOP.

## Notes for maintainers

- **Emergency precedence is structural, not coincidental.** The refuse check runs
  *only* after the red-flag early-return, so a dual-trigger prompt can never refuse
  ahead of an emergency escalation. A unit test asserts `kind === "short-circuit"` on a
  combined prompt — keep the ordering if you touch `evaluate`.
- **Reason text is fixed and asserted byte-equal.** `REFUSAL_REASONS` is the single
  source of the decline strings and is **never** routed through an LLM. Tests assert the
  returned `reason` is byte-identical to the constant — changing the wording is a
  deliberate edit, not a model output.
- **Conservative by design — false-negatives are accepted (ADR-3).** The patternset is
  small (~4 rules/category, plain phrase-include matching) and **never** fires on benign
  informational prompts. Novel or indirect phrasing may return `none` and fall through
  to the normal (still-guardrailed) SOP path. This is a precision-over-recall choice:
  a miss is safer than a false-positive that wrongly refuses, and refusal must **never**
  be widened into an LLM filter (research REFUTED the in-line model policy filter). Gaps
  are surfaced to a patternset revision, not patched by broadening matching here.
- **Audit stays IDs/enums only.** The `refuse` entry carries `ruleId` /
  `rulesetVersion` / `patternsetVersion` and **no** prompt substring or health value,
  consistent with the consent and short-circuit audit entries.
- **Carry-forward cleanup (low, non-blocking).** The evaluator flagged a byte-for-byte
  duplicated `sc-1-6`/`sc-1-7` `describe` block in `src/medical/engine.test.ts` (both
  copies pass; no functional impact) — a candidate for cleanup in a future sprint, not a
  bug.
- **Remaining spec work (S2–S3).** The WHOOP device-connection ingestion path + a third
  `device-connection` egress axis + the `bober medical whoop sync` CLI land in later
  sprints of `spec-20260617-medical-whoop-guardrails`; this sprint touches none of them.
