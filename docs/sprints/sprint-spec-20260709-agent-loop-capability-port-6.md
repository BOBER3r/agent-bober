# Loop session persistence, resume and fork (`.bober/sessions/`)

**Contract:** sprint-spec-20260709-agent-loop-capability-port-6  ·  **Spec:** spec-20260709-agent-loop-capability-port  ·  **Completed:** 2026-07-10

## What this sprint added

Opt-in **model-context continuity** for agent-bober's own `runAgenticLoop`. When
`AgenticLoopParams.session` is present, the loop persists its provider-agnostic transcript (the
`Message[]` union) plus metadata to `.bober/sessions/<sessionId>.json` **after every turn** —
crash-resumable, including the completion turn's final assistant text (which the in-loop `messages`
array never receives). `resumeSession()` loads a persisted transcript so a **new** loop invocation
continues with full prior context; `forkSession()` copies a transcript to a new id so approaches can
branch **without mutating the original**. Both fail soft — a missing or corrupt session returns a
**typed `{ error }`** result and never silently starts an empty session. Omitting `session` writes
no files and leaves loop behavior **byte-identical** (paired deep-equal `AgenticLoopResult` test +
full suite 3802 → 3832). No config schema surface; **no pipeline role auto-enables sessions** — this
is a programmatic API only.

## Public surface

New module **`src/orchestrator/session-store.ts`** (mirrors `src/research/job-store.ts`: `ensureDir`,
Zod `safeParse` before write and on read, `null`-on-missing-or-malformed never-throw, async fs only):

- `SessionRecordSchema` / `SessionRecord` (`src/orchestrator/session-store.ts:81`, type `:90`) —
  `{ sessionId, model, createdAt, updatedAt, turnsUsed, messages: Message[] }`, Zod-validated.
- `MessageSchema` (`:72`) — an authored Zod mirror of the `Message` union (`src/providers/types.ts`);
  there was no existing schema. **Variant order matters:** `AssistantMessageSchema` (with `toolCalls`)
  precedes `TextMessageSchema` in the union, or an assistant message with tool calls silently loses
  them on round-trip.
- `SessionStore` (`:141`) — `path(id)` (`:156`), `now()` (`:151`, injected clock), `save(record)`
  (`:173`, Zod-validates before write, preserves `createdAt` from any existing file), `load(id)`
  (`:205`, returns `null` on missing/corrupt/schema-invalid — the fail-soft primitive),
  `fork(id, newId)` (`:224`, writes ONLY the new file, source read-only). Constructed with
  `{ projectRoot, now? }` — sessions live under `<projectRoot>/.bober/sessions/`.
- `sessionForkId(sessionId, now)` (`:119`) — deterministic sha256-derived fork id (no argless
  `randomUUID()`/`Date.now()`), used when `forkSession` gets no explicit `newId`.

Threaded onto the loop (`src/orchestrator/agentic-loop.ts`):

- `AgenticLoopParams.session?: { store: SessionStore; sessionId: string }` (`:101`) — opt-in per-turn
  persistence.
- `AgenticLoopParams.initialMessages?: Message[]` (`:107`) — a prior transcript seeded **ahead of**
  `userMessage` (loop resume).
- `resumeSession(store, sessionId)` (`:664`) — `Promise<{ initialMessages, sessionId } | { error }>`.
  Never throws; the error branch never starts the loop.
- `forkSession(store, sessionId, newId?)` (`:684`) — `Promise<string>`, returns the new id.

Barrel exports in `src/index.ts`: `resumeSession`, `forkSession`, `SessionStore`, `type SessionRecord`.

## How to use / how it fits

All three surfaces are **programmatic** `runAgenticLoop` / helper calls — nothing was added to
`config/schema.ts` and no CLI subcommand exists yet (session `list`/`rm` CLI is an explicit
follow-up):

```ts
import { runAgenticLoop, resumeSession, forkSession, SessionStore } from "agent-bober";

const store = new SessionStore({ projectRoot });

// First run — persist per turn to .bober/sessions/chat-42.json
await runAgenticLoop({
  /* ...client, tools, handlers... */
  userMessage: "start",
  session: { store, sessionId: "chat-42" },
});

// Later, in a fresh process — continue with full prior context
const resumed = await resumeSession(store, "chat-42");
if ("error" in resumed) {
  // missing / corrupt — handle, never silently empty
} else {
  await runAgenticLoop({
    /* ... */
    userMessage: "keep going",
    initialMessages: resumed.initialMessages, // seeded ahead of userMessage
    session: { store, sessionId: "chat-42" },  // new turns append to the same file
  });
}

// Branch an approach without touching the original transcript
const forkId = await forkSession(store, "chat-42"); // deterministic id if newId omitted
```

Where it plugs in: the loop calls an internal `persistSession()` closure at **every** turn-body
completion point (tool turn, completion including final assistant text, `budget_exceeded`, API error,
max-turns). The closure is a no-op when `session` is absent, so calling it unconditionally keeps the
no-session path byte-identical. `resumeSession` only reads; the loop appends.

## Notes for maintainers

- **This is a DIFFERENT layer from the two existing "session/resume" concepts — keep the names
  distinct (contract nonGoal):**
  - `.bober/sessions/` here = the **own agentic loop's model-context transcript** (resume/fork of the
    `Message[]` conversation).
  - The chat **`/resume`** command + `src/chat/conversation-store.ts` (`.bober/chat/`) is a
    **run-scoped chat** layer — unrelated store, unrelated command.
  - do-bridge's `sessionId` (e.g. `do-<findingId>`) is a **spawned-run id**, not a transcript.
  This sprint does not replace or touch either; the source header of `session-store.ts` calls this
  out explicitly.
- **Persistence never crashes a run.** A `store.save()` throw mid-run is caught and `logger.warn`-logged;
  the loop resolves normally. **Follow-up (evaluator advisory, low priority):** there is **no committed
  test** for the `store.save()`-throws fail-soft path — the try/catch was verified correct via an
  evaluator ad-hoc script against the built dist, but a future try/catch removal would not be caught by
  CI. Add a `ThrowingStore` fake test asserting the loop resolves normally when `session.store.save`
  rejects, when `agentic-loop.test.ts` is next touched.
- **`turnsUsed` is the current invocation's local counter, not cumulative across a resume lineage**
  (per generatorNotes) — a resumed run's file shows that run's turn count, not old + new turns.
- **`save()` re-reads the existing file on every call** to preserve `createdAt` (an O(1) extra read
  per turn, ceiling-commented in source). If this ever needs to avoid the read, cache `createdAt` in
  the caller and pass it through.
- **`MessageSchema` must stay in sync with the `Message` union** in `src/providers/types.ts`, and the
  `AssistantMessageSchema`-before-`TextMessageSchema` union ordering must be preserved (a round-trip
  trap covered by a dedicated test in `session-store.test.ts`).
- **Scope.** One commit `c51b28b`, 5 files (new `session-store.ts` + test, `agentic-loop.ts` + test,
  `index.ts`). `src/providers/types.ts` was **not** touched — the `Message` union is already
  JSON-serializable as-is. +30 tests (suite 3802 → 3832). All 6 required criteria (sc-6-1..6-6) passed
  iteration 1. Compaction/dedup of transcripts is explicitly deferred to sprint 7.
