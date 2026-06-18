# Gated synthesis flow + engine wiring

**Contract:** sprint-spec-20260618-medical-grounding-critic-2  ·  **Spec:** spec-20260618-medical-grounding-critic  ·  **Completed:** 2026-06-18

## What this sprint added

Makes the Sprint-1 grounding critic **live in the medical-sop pipeline** for the first
time. A new `synthesizeGrounded` (in `src/medical/retrieval/literature.ts`) composes the
existing `synthesize` primitive with the critic into a **fail-closed gate**: synthesize →
critique → if rejected, **one** re-synthesis with the critic's feedback → re-critique →
**abstain** on a second reject or on **any** thrown transport/model error at any step. The
engine's grounded branch (`engine.ts:403`) now calls `synthesizeGrounded` instead of the
bare `synthesize`, so a cited answer must pass an independent faithfulness + completeness
review before it can reach the user. Every upstream gate stays **zero-LLM** — only the
grounded-synthesis branch now makes more than one LLM call, and the whole gate is bounded
by `GROUNDED_GATE_MAX_LLM_CALLS`. No config, CLI, or `AuditEntry.criticVerdict` field this
sprint (those are Sprint 3).

## Public surface

All changes live in `src/medical/retrieval/literature.ts` (the new gate) and
`src/medical/engine.ts` (the one-line swap).

- `async function synthesizeGrounded(query, outcome, llm, footer)` (`literature.ts:259`) —
  the fail-closed gate. For a non-`grounded` `RetrievalOutcome` it delegates straight to
  `synthesize` (the `disabled` / `abstain` cases are already handled there). For a
  `grounded` outcome it runs: (1) `synthesize`; if it abstained, return it. (2)
  `getGroundingVerdict` on the answer body + `outcome.passages`; on `approve`, return the
  answer. (3) `synthesizeWithFeedback` — **one** re-synthesis with the critic's feedback
  appended to the system prompt. (4) `getGroundingVerdict` again; return the re-synthesized
  answer on `approve`, else the canned abstain. Every `synthesize` / critic call is wrapped
  so a thrown error maps to `abstainAnswer` (fail-closed).
- `const GROUNDED_GATE_MAX_LLM_CALLS` (`literature.ts:187`) — the worst-case LLM-call
  budget for the gate, **computed from** the Sprint-1 constant:
  `1 (synth) + GROUNDING_MAX_LLM_CALLS (critic) + 1 (re-synth) + GROUNDING_MAX_LLM_CALLS (re-critic)`
  (= 6 today). A reject→reject call-counting test asserts the cap.
- `engine.ts:403` — the grounded branch now calls
  `synthesizeGrounded(userPrompt, outcome, llmClient, footer)` (was `synthesize(...)`). The
  import at `engine.ts:29` changed from `synthesize` to `synthesizeGrounded`. The lazy
  `LLMClient` construction (`engine.ts:400-402`) and the numeric / disabled else-branch are
  untouched.

Module-private helpers (not exported), both in `literature.ts`:

- `abstainAnswer(footer)` (`literature.ts:194`) — the canned abstain `MedicalAnswer`
  (`abstained: true`, `citations: []`, `shortCircuit: false`, disclaimer footer present,
  body = *"I cannot provide a sufficiently-supported answer grounded in the retrieved
  literature…"*). Returned on second-reject and on every caught error.
- `synthesizeWithFeedback(query, outcome, llm, footer, feedback)` (`literature.ts:211`) —
  `synthesize` for the grounded case with **one** extra system-prompt line
  (`Address this reviewer feedback while staying grounded ONLY in the passages: <feedback>`);
  it pins to the same `outcome.passages` and reuses `buildSynthesisSystem` /
  `passagesToCitations`.

## How to use / how it fits

`synthesizeGrounded` is the drop-in replacement for `synthesize` on the engine's grounded
branch — it has the **same** `(query, outcome, llm, footer)` signature, threads the same
lazily-constructed local `LLMClient` (default Ollama `llama3`) and disclaimer footer, and
returns a `MedicalAnswer` whose shape (abstained vs. cited, footer attached) the rest of
the SOP already understands. The audit event is unchanged: `MedicalSopEngine.run` still
appends `answer` for a non-abstained result and `abstain` otherwise, based only on the
returned `MedicalAnswer.abstained` — the critic verdict is **not** yet recorded (Sprint 3).

Outcomes a caller now sees on the grounded path:

- **First critique approves** → the original cited answer is returned unchanged (≥ 1
  citation intact).
- **Reject → re-synthesize → approve** → the **re-synthesized** answer is returned (distinct
  body, still ≥ 1 citation).
- **Reject → reject**, or **any** thrown error from `synthesize` / the critic at any step →
  the canned abstain (`abstained: true`, `citations: []`, footer present). An exception
  **never** escapes, and an ungrounded answer is **never** returned.

## Notes for maintainers

- **Fail-closed everywhere — keep the try/catch wrappers.** Every `synthesize` and every
  `getGroundingVerdict` call in `synthesizeGrounded` is wrapped so a thrown
  transport/model error returns `abstainAnswer`, not a propagated exception and not an
  ungrounded answer. `getGroundingVerdict` itself **propagates** transport errors (by
  Sprint-1 design); this gate is the layer that maps them to abstain. Tests inject fakes
  that throw at each step and assert an abstained answer.
- **Exactly one re-synthesis round — do not add more.** The spec caps the gate at a single
  re-synth + re-critique. `GROUNDED_GATE_MAX_LLM_CALLS` is **computed** from
  `GROUNDING_MAX_LLM_CALLS`, not a literal, so it tracks future changes to the critic
  budget — keep it derived.
- **Every non-grounded path stays zero-LLM.** The consent-refuse, red-flag short-circuit,
  content-policy refuse, numeric-only (`sampleCount > 0`), and literature-disabled paths
  construct **no** critic and make **no** LLM call. `engine.test.ts` keeps all 11 zero-LLM
  negative assertions (a spy `LLMClient` that throws if called); only the grounded happy-path
  count changed `1 → 2` (synth + critic) at `engine.test.ts:913`, with a queued critic-approve
  mock. Preserve those spy assertions if you touch the engine.
- **New collocated tests.** `src/medical/retrieval/grounded-gate.test.ts` (12 tests) covers
  approve-first, reject→approve, reject→reject→abstain, throw-at-synth / throw-at-critic, and
  the call cap.
- **No new network/SDK import.** `synthesizeGrounded` depends only on the injected
  `LLMClient` and the Sprint-1 grounding-critic module; the scoped `src/medical/**` ESLint
  network boundary stays green.
- **Remaining spec work (S3).** A configurable model/provider with cloud-inference gating
  and the `AuditEntry.criticVerdict` audit field land in Sprint 3; this sprint touches
  neither.
