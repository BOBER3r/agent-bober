# Configurable model + cloud-inference egress gating + audit verdict

**Contract:** sprint-spec-20260618-medical-grounding-critic-3  ·  **Spec:** spec-20260618-medical-grounding-critic  ·  **Completed:** 2026-06-18

## What this sprint added

Closes the grounding-critic plan with three additive surfaces. (1) The medical
synthesis/critic model + provider is now **configurable** via an optional
`config.medical.inference` block, and (2) a cloud provider there is honoured **only**
when the existing `cloud-inference` egress axis is on — otherwise the resolver
**fails closed to the local Ollama default**, so the default posture is still byte-identical
to Sprint 2 and a medical turn still makes zero cloud egress out of the box. (3) The critic
gate's outcome is now recorded in the audit log as an IDs/enums-only `criticVerdict` field,
appended on the grounded path only and PHI-free at mode `0600`. No upstream gate, numeric,
or zero-LLM guarantee changed.

## Public surface

- `config.medical.inference` (`src/config/schema.ts:388-400`) — new optional Zod block
  `{ provider?: string; endpoint?: string; model?: string }`, all optional, a sibling of
  `medical.egress`. Absent ⇒ the local default (`openai-compat`,
  `http://localhost:11434/v1`, `llama3`).
- `buildMedicalInferenceClient(config, egress, factory?)` (`src/medical/inference.ts:31`) —
  resolves `{ client: LLMClient; model: string }` for the grounded synthesis/critic path.
  The local-vs-cloud decision lives **only** here; `createClient` (the providers factory) is
  the sole client-construction seam. `factory` is an injectable seam (defaults to the real
  `createClient`) so tests spy without real network.
- `CriticVerdict` type (`src/medical/types.ts:73`) — `'approve' | 'reject-abstained' | 'error-abstained'`.
- `AuditEntry.criticVerdict?: CriticVerdict` (`src/medical/types.ts:91`) — optional,
  IDs/enums-only, appended on the grounded path only.
- `interface GroundedResult { answer: MedicalAnswer; verdict: CriticVerdict }`
  (`src/medical/retrieval/literature.ts:52`) — `synthesizeGrounded`'s return type was
  **widened** from `MedicalAnswer` to `{ answer, verdict }` so the engine can classify the
  gate outcome for the audit. `synthesize` / `synthesizeWithFeedback` / `synthesizeGrounded`
  also gained a trailing `model: string` param (defaults to the Sprint-2 `SYNTHESIS_MODEL`
  for back-compat) so the resolved model threads through to the critic.

## How to use / how it fits

The resolver classifies "local" as `provider === "openai-compat"` **and** an endpoint
containing `localhost`; anything else is treated as cloud and gated:

- **No `inference` block** ⇒ exact local default (`openai-compat`,
  `http://localhost:11434/v1`, `llama3`) — back-compat, identical to Sprint 2.
- **`inference` points at a local provider/endpoint** ⇒ used as-is (non-egressing).
- **`inference` names a cloud provider while `medical.egress.cloudInference` is `false`
  (the default)** ⇒ **FAIL CLOSED**: the resolver ignores the cloud config and returns the
  local default, so no cloud client is ever constructed.
- **Cloud provider AND `medical.egress.cloudInference: true`** ⇒ the configured cloud
  client + model is built, and that same model threads into the grounding critic.

```jsonc
// Cloud synthesis is reachable ONLY behind the cloud-inference opt-in:
{
  "medical": {
    "egress": { "cloudInference": true },          // required — default false fails closed to local
    "inference": { "provider": "anthropic", "model": "claude-sonnet-4-5" }
  }
}
```

In `MedicalSopEngine.run`, the grounded branch (`engine.ts:399-407`) resolves its client +
model from `buildMedicalInferenceClient(config, egress)` instead of the old hardcoded
`createClient(...)`. An injected `deps.llmClient` still wins (for tests) and pins the model
to `llama3`. The branch threads the resolved `synthModel` into `synthesizeGrounded`, then
maps the returned `verdict` into the audit append (`engine.ts:421-426`):

- gate returned an approved answer ⇒ `criticVerdict: 'approve'`,
- abstained after a critic reject ⇒ `'reject-abstained'`,
- abstained after a thrown error (synth/critic transport or model unavailable) ⇒ `'error-abstained'`.

The audit line keeps its existing `event: 'answer' | 'abstain'`; `criticVerdict` is spread
in **only** when the grounded branch produced a verdict (`...(criticVerdict ? { criticVerdict } : {})`),
so non-grounded paths (consent / red-flag / refuse / numeric-only / literature-disabled)
write byte-identical entries.

## Notes for maintainers

- **Cloud is OFF by default and fails closed to local.** The gate is the existing
  `cloud-inference` egress axis — **no new axis was added** (a stated non-goal). The
  fail-closed branch (`inference.ts:44`) is the single place that decides local-vs-cloud; do
  not add a cloud fallback chain, streaming, or caching (also non-goals). The evaluator's
  sc-3-3 verified that the injected factory spy is **never** called with a cloud provider
  when `cloudInference` is off.
- **`criticVerdict` is enum-only — never free text.** It is one of the three literals, never
  the critic's feedback string or any prompt/answer/health value. The audit file stays mode
  `0600` after appending (stat-asserted, sc-3-7), and the line contains no substring of the
  prompt or answer body (sc-3-6).
- **`synthesizeGrounded` now returns `{ answer, verdict }`, not a bare `MedicalAnswer`.** Any
  future caller must destructure. The gate logic and the one-re-synthesis bound from Sprint 2
  are unchanged — only the return shape widened and the `model` param threads through.
- **Back-compat is byte-identical with no config.** sc-3-5 asserts the no-`inference` grounded
  path matches Sprint 2 exactly. The Sprint-2 grounded-gate tests were updated **mechanically**
  for the new return shape (semantic assertions preserved).
- **Tests.** New collocated `src/medical/inference.test.ts` (cloud-off ⇒ local fallback;
  cloud-on ⇒ cloud client via the factory spy; no-config ⇒ exact local default; spy never
  called with a cloud provider when off). `engine.test.ts` / `audit.test.ts` were extended for
  the `criticVerdict` value + PHI-free + `0600` assertions. Full suite: 2673 pass (6
  pre-existing cockpit E2E failures are unrelated / not a regression).
- **Plan complete.** This is the final sprint of `spec-20260618-medical-grounding-critic`
  (3 of 3). Shipping / enabling the medical team still inherits the base medical team's
  external S6.5 FFDCA §201(h) counsel + regulatory review gate (a non-engineering gate).
