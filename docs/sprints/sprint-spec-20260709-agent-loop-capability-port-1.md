# Refusal detection end-to-end (stopReason 'refusal' + fail-closed generator)

**Contract:** sprint-spec-20260709-agent-loop-capability-port-1  ·  **Spec:** spec-20260709-agent-loop-capability-port  ·  **Completed:** 2026-07-09

## What this sprint added

This first sprint of the agent-loop capability port makes a **provider refusal a first-class
outcome** instead of a silent success. A refusal now propagates provider-agnostically as
`StopReason "refusal"` from both adapter families (Anthropic `stop_reason: "refusal"`; the
OpenAI-family `finish_reason: "content_filter"` **and** the structured-output `message.refusal`
field), is detected at the agentic loop's completion branch as `refused: true` on
`AgenticLoopResult` (**never** thrown — ADR-5), and makes `parseGeneratorResult` **fail closed**:
a refusal that arrives after partial file writes is reported `success: false` before the
`filesWritten`-implies-success shortcut can fire. Non-refusal runs are **byte-identical** — the
`refused` key is absent (not `false`) when nothing was refused, so no existing consumer or test
changes behavior. This is additive scaffolding for the later sprints (effort, USD ceiling,
parallel read-only tools) and adds **no new dependency**.

## Public surface

- `StopReason` (`src/providers/types.ts:214`) — the open union gained a documented known value
  `"refusal"`. The union type is unchanged (`… | "error" | string`); only the doc comment now
  enumerates `"refusal"` as a recognized stop reason surfaced by the adapters.
- `normalizeStopReason` — Anthropic adapter (`src/providers/anthropic.ts:42`) — new explicit
  `case "refusal": return "refusal"` **before** the default pass-through branch.
- `normalizeStopReason` — OpenAI adapter (`src/providers/openai.ts:174`) — new
  `case "content_filter": return "refusal"`. Shared by all `openai-compat` endpoints (DeepSeek,
  Grok, Ollama, LM Studio) via `super.chat`.
- `OpenAIAdapter.chat` refusal override (`src/providers/openai.ts:455`) — a non-empty
  `choice.message.refusal` short-circuits to a `ChatResponse` with `stopReason: "refusal"` and the
  refusal text as `text`, **taking precedence** over the normal content / `finish_reason` path (the
  new `OAIMessage.refusal?: string | null` field, `openai.ts:43`).
- `AgenticLoopResult.refused?: boolean` (`src/orchestrator/agentic-loop.ts:66`) — **optional**; set
  to `true` only on a refusal via a spread-conditional (`agentic-loop.ts:347`) so the key is
  **absent** on every non-refusal path. The loop derives it (`turnStopReason === "refusal"`,
  `agentic-loop.ts:336`) at the completion branch, not in the transient-error retry path — a
  refusal is a normal, non-throwing response.
- `parseGeneratorResult(text, filesWritten, loopResult)` (`src/orchestrator/generator-agent.ts:183`)
  — **now exported** (for direct unit testing of the guard). The `loopResult` param widened with an
  optional `refused?: boolean`. Its **first statement** (`generator-agent.ts:197`) is the
  fail-closed guard: `if (loopResult.refused === true)` returns
  `{ success: false, notes: "model refused: <first 300 chars of finalText>", … }` before any JSON
  parsing or the `filesWritten` success shortcut.

There is **no** new `ChatResponse.refused` field — the loop derives the flag from `stopReason`.

## How to use / how it fits

No new command, flag, or config key. The behavior is automatic for every pipeline role and fleet
child that runs through `runAgenticLoop`:

- **Write-capable roles (generator, curator)** treat `refused` as `success: false` — a sprint whose
  provider refuses is reported as a failed sprint (with the refusal excerpt in `notes`) rather than
  a passing empty sprint, even if some files were already written.
- **Read-only / advisory roles (researcher, code-reviewer)** are unaffected by this sprint's guard —
  they surface the refusal text as their output without failing the run (ADR-5). Only
  `parseGeneratorResult` was made fail-closed here.

Provider-agnostic mapping summary:

| Provider family | Refusal signal | Mapped `StopReason` |
| --- | --- | --- |
| `anthropic` | `stop_reason: "refusal"` | `"refusal"` |
| `openai` / `openai-compat` (DeepSeek, Grok, Ollama, LM Studio) | `finish_reason: "content_filter"` **or** `message.refusal` non-empty | `"refusal"` |
| `claude-code` | untouched (text-only boundary) | — |

## Notes for maintainers

- **`refused` is a must-check field for any write-capable role (ADR-5).** A future role that commits
  work and forgets to read `refused` silently reverts to the false-pass bug this sprint closed.
  Route any budget-/refusal-truncated partial through `success: false` wherever completeness matters.
- **Absent, never `false`.** The spread-conditional (`...(refused ? { refused: true } : {})`) keeps
  the non-refusal path byte-identical — verified with `Object.hasOwn(result, "refused") === false` on
  the normal `end` and max-turns paths. Do not set `refused: false` unconditionally; that would
  change the serialized shape and break the byte-identical invariant (regression-tested).
- **The loop returns, never throws, on refusal.** `runGenerator` has no surrounding try/catch at the
  `pipeline.ts` call site (ADR-4/ADR-5), so a thrown refusal would crash the run mid-sprint. Detection
  lives at the completion branch, not in `chatWithRetry`.
- **`openai-compat.ts` and `claude-code.ts` were untouched.** `openai-compat` inherits the mapping via
  `super.chat`; `claude-code`'s text-only boundary is out of scope (nonGoal).
- **Scope.** Commit `35a2dbd` touched 9 files (+315/-2): `src/providers/{types,anthropic,openai}.ts`,
  `src/orchestrator/{agentic-loop,generator-agent}.ts` and their five collocated `*.test.ts`
  (two new: `agentic-loop.test.ts`, `generator-agent.test.ts`). No new dependency, no `ChatResponse`
  field. Full suite **3699/3699** green (3686 baseline + 13 new); all 6 required criteria (sc-1-1..1-6)
  passed iteration 1, no regressions.
- **Follow-ups (later sprints in this spec, out of scope here):** per-role effort, a USD ceiling
  (`Budget.maxUsd` / `BudgetExceededError` kind `"usd"` — see ADR-4), and parallel read-only tool
  execution. Refusal-triggered retries / re-prompting were explicitly deferred.
