# Free-text guidance injection: /tell <runId> <text> + additive pipeline read point

**Contract:** sprint-spec-20260615-chat-interrupt-approve-steer-4  ·  **Spec:** spec-20260615-chat-interrupt-approve-steer  ·  **Completed:** 2026-06-15

## What this sprint added

The **steer** half of mid-flight human-in-the-loop control: a human can now feed a
running pipeline free-text guidance, not just approve or reject a gate. A new
`runId`-keyed guidance channel (`.bober/runs/<runId>/guidance.jsonl`) is appended by a
`/tell <runId> <text>` slash command (and a natural-language `tell run X to …`
classifier action); the pipeline drains that channel at one **additive** read point per
sprint iteration and injects the drained text into the next agent's handoff. Guidance is
advisory context only — it appends to `handoff.issues`, never edits files or overrides the
contract. It applies only at the **next** checkpoint boundary, never mutates an in-flight
agent call, and does **not** require careful mode. With no guidance queued (or no runId)
the pipeline behaves byte-for-byte as before (the `pipeline.ts:571` invariant block and
`runTsPipeline` are untouched).

## Public surface

- `safeSegment(runId): boolean` (`src/state/guidance.ts:48`) — path-traversal guard.
  Rejects empty, `/`, `\`, `..`, a leading `.`, and absolute paths (Unix `/…` or Windows
  `C:\…`). Validated **before** any path is built, so a malicious runId can never escape
  `.bober/runs`.
- `hasRunDir(projectRoot, runId): Promise<boolean>` (`src/state/guidance.ts:66`) —
  unknown-run guard; `access`-checks `.bober/runs/<runId>/`. Returns `false` (never throws)
  if absent. Mirrors `approval-state.ts:pendingExists`.
- `appendGuidance(projectRoot, runId, text): Promise<void>` (`src/state/guidance.ts:87`) —
  validates `safeSegment(runId)` first (throws a clear error if unsafe), `ensureDir`s the
  run dir, then `appendFile`s one JSON line `{ ts, text, consumed: false }` to
  `guidance.jsonl`. Append-only; each call writes exactly one complete JSONL line.
- `drainGuidance(projectRoot, runId): Promise<string[]>` (`src/state/guidance.ts:120`) —
  reads all lines, collects the `text` of entries where `consumed !== true`, then
  **atomically** rewrites the file (temp-file + `rename`, mirroring `run-state.ts:41-52`)
  with **every** entry marked `consumed: true`, and returns the drained texts in order.
  Missing/unreadable file → `[]` (never throws — safe to call on every sprint). A second
  drain → `[]` (all entries already consumed). Malformed lines are skipped, not lost.
- `injectGuidanceIntoHandoff(handoff, guidanceTexts): ContextHandoff`
  (`src/orchestrator/pipeline.ts:138`) — **pure, exported.** When `guidanceTexts` is empty
  it returns the **same** `handoff` reference (`===`, the no-op invariant); otherwise it
  returns a new handoff with `…guidanceTexts.map(g => `Human guidance: ${g}`)` appended to
  `handoff.issues`. Exported for direct unit testing.
- `/tell <runId> <text>` slash command (`src/chat/slash-commands.ts:116`) — the line
  remainder after the runId is captured as the guidance text (spacing preserved). Missing
  runId or empty text → `Usage: /tell <runId> <text>`. Dispatched via a new optional
  `tellHandler` (the **last** `dispatch(...)` param, `src/chat/slash-commands.ts:58`), so
  existing callers keep working; absent handler → `"Tell is unavailable."`
- `HELP_TEXT` (`src/chat/slash-commands.ts:24`) — `/help` now lists
  `/tell <runId> <text>`.
- `ClassifierAction` union (`src/chat/turn-classifier.ts:17`) — extended additively with
  `{ action: "tell"; runId: string; text: string }`, backed by a matching Zod
  discriminated-union member (`turn-classifier.ts:39`) and parsed by
  `parseClassifierAction` (`turn-classifier.ts:104`). The classifier prompt advertises the
  shape; stays in loose-JSON mode (DeepSeek-safe), consistent with the existing actions.
- `ChatSession.handleTell(runId, text)` (`src/chat/chat-session.ts:362`, private) — shared
  by the slash path and the NL `tell` action. Guards with `hasRunDir` (unknown run →
  `No such run: <runId>`, writes nothing), then `appendGuidance`; an `appendGuidance` throw
  (e.g. unsafe runId) is caught and surfaced as `Failed to queue guidance: <message>`. On
  success → `Queued guidance for run <runId>.` Never reaches the LLM.

## How to use / how it fits

Queue guidance for a known run from inside `bober chat`; it is applied at that run's next
sprint boundary:

```
> build a settings page          # detached run launches (Sprint 1), shows under /runs
> /tell run-1718... prefer Zod over hand-rolled validation
  → "Queued guidance for run run-1718..."
```

Natural language routes through the same handler:

```
> tell run run-1718... to add integration tests for the API layer
  → "Queued guidance for run run-1718..."
```

The detached run's pipeline, on its next sprint iteration, calls
`drainGuidance(projectRoot, pipelineRunId)` at the single
`// ── Phase 2 guidance injection (additive) ──` block (`src/orchestrator/pipeline.ts:290`),
between the `compactedHandoff` build and the `runGenerator` call, and feeds the resulting
`injectedHandoff` to the generator. Each queued line surfaces to the generator as a
`Human guidance: <text>` entry in `handoff.issues`. Guidance is drained exactly once
(the next sprint sees an already-consumed file and a no-op `[]`).

`pipelineRunId` is the same id chat threads via `--run-id` (`pipeline.ts:618` /
`run.ts`), so chat and pipeline agree on the channel key. Unknown runs are rejected at the
chat layer before any write; careful mode is **not** required — guidance can be queued for
any known run and is drained at whatever boundary that run next executes.

## Notes for maintainers

- **Path-traversal guard is validate-before-build (load-bearing).** `safeSegment` runs in
  `appendGuidance` *before* any `join`, so an unsafe runId (`../evil`, `/etc/x`, a leading
  dot, a separator) throws and writes nothing — it can never produce a path outside
  `.bober/runs`. Do not let a refactor move path construction ahead of the guard or drop a
  rejected case.
- **Atomic drain-then-consume is load-bearing.** `drainGuidance` returns unconsumed texts
  *and* rewrites the whole file with every entry `consumed: true` via temp-file + `rename`
  (same pattern as `run-state.ts`). This makes drain idempotent: a second drain returns
  `[]`, so guidance is injected at most once and a partial write cannot lose or
  double-inject entries. The redrain-returns-`[]` semantics back sc-4-5; keep the rewrite
  atomic.
- **Reference-identity no-op is the additive invariant (load-bearing).**
  `injectGuidanceIntoHandoff` returns the *same* `handoff` object when `guidanceTexts` is
  empty — sc-4-7 asserts this with `toBe` (reference identity), not just deep-equal. With
  no guidance the generator receives the exact handoff it would have received in Phase 1.
  Do not let an "always spread" refactor break the `===` no-op.
- **Additive-pipeline discipline.** The committed `pipeline.ts` diff is `+34/-1`: a single
  guarded injection block plus the one-line `compactedHandoff → injectedHandoff`
  substitution at the `runGenerator` call. No phase was reordered; `runTsPipeline` and the
  `:571` invariant block are untouched (verified via `git numstat` + grep). When extending
  the pipeline, keep guidance a read-only drain at a clearly-commented boundary.
- **Injection happens *after* the gate (intentional).** The `pre-generator` checkpoint /
  audit at `pipeline.ts:307` still passes the **pre-injection** `compactedHandoff`, while
  `runGenerator` (`:319`) receives `injectedHandoff`. So a human approving the
  `pre-generator` gate approves the handoff the generator was going to get *before*
  guidance is woven in; the drained guidance is then layered on for the actual generate
  call. This is deliberate — keep the checkpoint payload and the generator payload distinct
  if you touch this site.
- **Advisory only, next-boundary only.** Guidance appends to `handoff.issues`; it never
  edits files, overrides the contract, or mutates an in-flight agent call. It is consumed
  at the next boundary that executes, not pushed mid-call.
- **Non-goals honored.** No pause/resume (Sprint 5), no marker/channel hygiene or e2e docs
  (Sprint 6). Protected files (`disk.ts`, `approval-state.ts`, `feedback-router.ts`) are
  untouched.

## How it was verified

Build, typecheck, and lint clean (0 errors, 2 pre-existing warnings). Full suite: 2086
passed / 3 skipped across 175 files, **+38** new collocated tests
(`src/state/guidance.test.ts`, `src/orchestrator/pipeline.guidance.test.ts`,
`src/chat/slash-commands.test.ts`, `src/chat/chat-session-steer.test.ts`). All 8 required
success criteria passed on iteration 1 with zero attributable regressions
(`eval-sprint-spec-20260615-chat-interrupt-approve-steer-4-1`). Covered: `appendGuidance`
writes the `{ts,text,consumed:false}` entry for a known run, no-ops with a clear error for
an unknown run, and rejects a `../`-bearing runId before any write (sc-4-4); drain returns
both seeded texts then `[]` on redrain with the file reflecting consumed state (sc-4-5);
the pipeline boundary surfaces seeded guidance into the generator's handoff via a stub
(sc-4-6); the no-guidance case returns the identical handoff by reference (sc-4-7); and the
stubbed-classifier NL `tell` writes the guidance entry plus `/help` listing `/tell`
(sc-4-8).
