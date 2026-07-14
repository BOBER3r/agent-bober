# Chat intent-detection capture

**Contract:** sprint-spec-20260628-task-inbox-5  ·  **Spec:** spec-20260628-task-inbox  ·  **Completed:** 2026-06-29

## What this sprint added

Sprint 5 teaches `bober chat` to **recognise a plain task statement as a new-task intent** and
capture it into the hub pool without an answer round-trip. The turn classifier gains one **additive**
`{action:'capture-task', task}` variant, and the chat session gains a `handleCaptureTask` branch that
opens a `FactStore` and writes the task through the **sprint-1 `captureTask`** (the single capture
write path) — emitting a short `Captured task: <text>` confirmation instead of invoking the Answerer.
Typing `renew passport` into chat now files an open `action` Finding; a **question** still routes to
`answer`; a **decision/scope statement** ("I'm deciding between X and Y") is explicitly **not** treated
as a task. The classifier keeps its never-throw fallback to `{action:'answer'}` on any parse failure.

## Public surface

- `ClassifierAction` — `'capture-task'` member (`src/chat/turn-classifier.ts:21`) — the discriminated-
  union variant `{ action: "capture-task"; task: string }`, added alongside the existing
  `answer`/`spawn`/`steer`/`approve`/`reject`/`tell`/`pause`/`resume` members (all unchanged). The
  matching Zod schema option is `z.object({ action: z.literal("capture-task"), task: z.string() })`
  (`src/chat/turn-classifier.ts:45`), and the parse branch that maps it through is at
  `src/chat/turn-classifier.ts:93`.
- **Classifier system-prompt rules** (`src/chat/turn-classifier.ts:160`) — two added instruction lines:
  one describing `capture-task` as the choice for a NEW personal task/to-do the user states (an
  imperative like "renew passport", "book dentist", "call the bank"), and one that routes a
  decision/scope statement ("I'm deciding between X and Y", "should I do A or B?") to `answer`, NOT
  `capture-task`, so prioritization phrasing is never mistaken for a task.
- `ChatSession.handleCaptureTask(task)` (`src/chat/chat-session.ts:465`, private) — the dispatch
  target for a `capture-task` turn (wired at `src/chat/chat-session.ts:290`). Trims the task text
  (empty → `Nothing to capture …`), stamps `now = new Date().toISOString()` at the boundary, opens a
  namespace `FactStore`, calls `captureTask(store, title, { now })`, closes the store in a `finally`,
  and returns `Captured task: <title>`. It does **not** call the Answerer. **Never throws** — a
  persistence failure becomes a `Failed to capture task: <message>` reply.

## How to use / how it fits

```text
$ bober chat
> renew passport
Captured task: renew passport          # filed as an open action Finding in the hub pool

> what runs are active?                 # still routed to the answerer (a question, not a task)
…roster summary…

> I'm deciding between Postgres and SQLite   # scope/decision framing → answer, NOT captured
…answer…
```

The captured item is an **ordinary active `action` Finding** in the unified hub pool — the exact row
shape `bober task add` writes — so it immediately shows up in `bober task list`, `bober hub list`,
and is eligible for ranking by `priority` / `decide` / `bober chat hub`. The capture path is the
**same `captureTask` reused from Sprint 1**; this sprint adds *intent detection*, not a second write
path. Classification still flows through the existing `TurnClassifier` → `ChatSession` dispatch, so
every other chat intent (spawn a run, steer, approve/reject, pause/resume, answer) is unaffected.

## Notes for maintainers

- **Additive only.** The `capture-task` variant is a *new* union member; every existing classifier
  action parses exactly as before, and the `FALLBACK = { action: "answer" }` on any parse failure is
  byte-identical. If you extend the classifier, keep the fallback intact (`turn-classifier.ts`).
- **Single write path.** Capture reuses `captureTask` from `src/hub/task-inbox.js` — do **not**
  re-implement persistence in the chat layer. `handleCaptureTask` mirrors the never-throw style of the
  other `handle*` methods (a write failure is an error reply, not an exception).
- **Clock stays at the boundary.** The only `new Date()` is in `handleCaptureTask`; `captureTask` and
  the store stay clock-free (`now` is injected). Preserve that if you touch the capture path.
- **No Answerer on capture.** A `capture-task` turn must **not** call the Answerer — `sc-5-4` proves
  this with a one-shot LLM client that throws on a second call (`llm.calls === 1`). Keep capture a
  pure deterministic write + confirmation; LLM-based triage of captured tasks is a later concern.
- **Scope-statements are not tasks.** The decision/scope-framing rule is load-bearing: prioritization
  phrasing routes to `answer`, so `/priority`-style framing in chat is never silently captured. Do not
  weaken that prompt line.

## Scope

Commit `3846c50`: 4 files changed, **+135 / -1** — `src/chat/turn-classifier.ts` (+10: the union
member, the schema option, the parse branch, and two system-prompt lines) and
`src/chat/chat-session.ts` (+31: the `capture-task` dispatch case, `handleCaptureTask`, and the
`FactStore`/`captureTask` imports), plus the collocated `turn-classifier.test.ts` (+5 tests) and the
new `chat-session-capture.test.ts` (`sc-5-4`, driven against an in-memory `FactStore`). **No** new
dependency. All five criteria (`sc-5-1..sc-5-5`) passed on iteration 1 (**zero reworks**); eval
`eval-sprint-spec-20260628-task-inbox-5-1` → **pass** (5/5, 4/4 required), full suite **3303 → 3309**
green, build + typecheck + lint clean (0 errors).
