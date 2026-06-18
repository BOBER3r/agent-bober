# Grounding-critic module (fail-closed core)

**Contract:** sprint-spec-20260618-medical-grounding-critic-1  ·  **Spec:** spec-20260618-medical-grounding-critic  ·  **Completed:** 2026-06-18

## What this sprint added

Lands the **fail-closed grounding critic** for the medical-sop pipeline as a
standalone, pure, injectable module — the risk-first crux of the feature. New file
`src/medical/retrieval/grounding-critic.ts` is structurally modelled on the fleet critic
(`src/fleet/critic-deep.ts`): the same tolerant `GroundingVerdict` shape, the same
never-throws parser, the same fresh-message-array (LOCK1) critic call, and the same
bounded retry-with-coercion loop. Its **single behavioral novelty** is the inversion at
the parse-exhaustion branch: where the fleet critic returns `{verdict:"approve"}`
(fail-**open** — `critic-deep.ts:199-201`), the grounding critic returns
`{verdict:"reject", feedback:"<unparseable critic output>"}` (fail-**closed**) — so an
unparseable critic output can never let an unverified medical answer through. The module
is **purely additive**: it is **not** yet wired into `MedicalSopEngine.run` or
`literature.ts`, adds **no** config, CLI, or audit field, and the re-synthesis loop is
deferred to Sprint 2. The app builds and the pre-existing suite is unchanged.

## Public surface

All exports live in `src/medical/retrieval/grounding-critic.ts`.

- `const GROUNDING_PARSE_MAX_RETRIES` (`grounding-critic.ts:8`) — `1`. Coercion retries
  after the first attempt.
- `const GROUNDING_MAX_LLM_CALLS` (`grounding-critic.ts:9`) — `1 + GROUNDING_PARSE_MAX_RETRIES`
  (= `2`). The hard cap on LLM calls per verdict; tests assert it is honored on the
  parse-exhaustion path.
- `const GroundingVerdictSchema` (`grounding-critic.ts:27`) — zod
  `z.object({ verdict: z.enum(["approve","reject"]), feedback: z.string() })`. Mirrors the
  fleet `CritiqueVerdictSchema`.
- `type GroundingVerdict` (`grounding-critic.ts:32`) — `z.infer<…>`:
  `{ verdict: "approve" | "reject"; feedback: string }`.
- `type ValidateGroundingResult` (`grounding-critic.ts:34`) — the tolerant-parse return:
  `{ ok: true; verdict: GroundingVerdict } | { ok: false; error: string }`.
- `function validateGroundingVerdict(rawText: string): ValidateGroundingResult`
  (`grounding-critic.ts:40`) — **NEVER throws** for any string input. Tries, in order:
  direct `JSON.parse` → markdown-fence extraction → first-brace `{…}` slice → zod
  `safeParse`; returns `{ok:true,verdict}` for valid shapes and `{ok:false,error}` for
  garbage / empty / unparseable input.
- `function buildGroundingSystemPrompt(question, answerBody, passages: Passage[]): string`
  (`grounding-critic.ts:100`) — builds the independent-reviewer system prompt that pins the
  critic to the numbered cited-passage block and instructs a **faithfulness + completeness**
  review (approve only if every claim is supported by a cited passage **and** the answer
  addresses the core of the question). `Passage` is the existing
  `src/medical/retrieval/medline-source.ts` shape `{title,text,url}`.
- `async function getGroundingVerdict({ llm, model, question, answerBody, passages }): Promise<GroundingVerdict>`
  (`grounding-critic.ts:170`) — runs the bounded retry-with-coercion loop
  (`GROUNDING_MAX_LLM_CALLS` attempts) and returns the parsed verdict on success.
  **On parse exhaustion it FAIL-CLOSED returns** `{verdict:"reject", feedback:"<unparseable critic output>"}`
  (`grounding-critic.ts:206`). Transport errors are **not** caught here — they propagate
  (Sprint 2's orchestrator maps a thrown error to abstain).

`callGroundingCritic` (the per-call helper at `grounding-critic.ts:123`) is **internal**
(not exported): it builds a **fresh** message array (first turn = a single `user` message
carrying the question + answer body + cited passages; the coercion retry uses the
3-message `[user, assistant(priorText), user(COERCION+error)]` shape) and calls
`llm.chat({ model, system, messages, jsonObjectMode: true })`. It never extends a prior
synthesis conversation (LOCK1).

## How to use / how it fits

The module is **pure given an injected `LLMClient`** — it depends only on `zod` and the
`LLMClient`/`Message` type imports from `providers/types.ts` and the `Passage` type from
`medline-source.ts`. There is **no** network, SDK, `node:net`/`node:http`, or `fetch`
import (the scoped `src/medical/**` ESLint network boundary stays green). It is **not yet
reachable at runtime** — nothing calls `getGroundingVerdict` until Sprint 2 wires it into
the grounded synthesis path. Intended use (Sprint 2): after `literature.synthesize`
produces a cited answer, hand `(question, answerBody, passages)` to `getGroundingVerdict`;
a `reject` triggers re-synthesis / abstain, an `approve` lets the cited answer through.

## Notes for maintainers

- **The fail-closed inversion is the whole point — keep it.** The only behavioral
  divergence from `src/fleet/critic-deep.ts` is `grounding-critic.ts:206`: parse exhaustion
  returns `reject`, **not** `approve`. The fleet critic fails **open** (`critic-deep.ts:201`,
  degrade-rather-than-block, ADR-3) because a bad critique there only costs a re-expand;
  here an unparseable critic must never approve an unverified medical answer. A unit test
  queues all-garbage responses and asserts `verdict === "reject"` — do not "fix" this to
  match the fleet critic.
- **`validateGroundingVerdict` must never throw.** Every parse path is wrapped; a
  parametrized test exercises raw JSON, fenced JSON, JSON-with-prose, empty string, and
  pure garbage and asserts each call returns rather than throws. Preserve this contract if
  you touch the parser.
- **The call budget is capped.** `getGroundingVerdict` makes at most
  `GROUNDING_MAX_LLM_CALLS` (= 2) LLM calls; a call-counting fake asserts the cap on the
  exhaustion path. Raising the retry count is a deliberate edit to
  `GROUNDING_PARSE_MAX_RETRIES`, not an accident.
- **Fresh message array (LOCK1).** The critic call starts from a single fresh `user` turn
  built from the question + answer + passages and never inherits the synthesis assistant
  turn — a test inspects `chat.mock.calls[0][0].messages` to assert exactly one `user`
  turn with the passages and no prior assistant turn. Keep the critique independent of the
  conversation that produced the answer.
- **Transport errors propagate by design.** This module does **not** catch network/LLM
  transport errors — it only judges parseable output. Mapping a thrown error to abstain is
  Sprint 2's orchestrator responsibility; keeping this module's responsibility narrow is
  intentional.
- **Remaining spec work (S2–S3).** Engine wiring + the re-synthesis loop land in Sprint 2;
  a configurable model/provider with cloud-inference gating and the `AuditEntry.criticVerdict`
  field land in Sprint 3. This sprint touches none of them.
