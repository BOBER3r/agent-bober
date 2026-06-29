# Plain text → zero-friction task inbox capture

**Contract:** sprint-spec-20260628-telegram-frontend-2  ·  **Spec:** spec-20260628-telegram-frontend  ·  **Completed:** 2026-06-29

## What this sprint added

Sprint 2 puts the **first domain behavior** behind the Sprint 1 transport spine: a whitelisted
operator can now type any free-text message to the bot and it lands as one open task in the
shared inbox pool, with the message text as its title and **no other required fields**. Two new
files do this — a **pure message router** (`router.ts`) that separates slash-commands from plain
text, and a **zero-friction capture handler** (`handlers/capture.ts`) that funnels plain text into
the existing task inbox (`spec-20260628-task-inbox`) through an injected sink. The poll loop in
`bot.ts` is rewired so plain text → capture (confirmation reply), `/start` → the existing help
stub, and any **other** `/command` → an `Unknown command` placeholder reserved for Sprints 3–4.
Every reply still leaves through the Sprint 1 `sendSafe` funnel; the handler never touches the
transport.

## Public surface

- `classify(message)` (`src/telegram/router.ts:29`) — **pure** classifier returning a
  `RoutedMessage` discriminated union. A message whose first non-space character is `/` is a
  command; the leading `/` is stripped and the name is split from the trailing args on the first
  whitespace (`"/start"` → `{ kind:"command", name:"start", args:"" }`; `"/todo buy milk"` →
  `{ kind:"command", name:"todo", args:"buy milk" }`). Everything else is
  `{ kind:"text", text: message }` — the message is returned **verbatim** (no trim/lowercase/parse)
  so the capture handler sees exactly what was typed (`sc-2-2`).
- `RoutedMessage` (`src/telegram/router.ts:10`) — the union type:
  `{ kind:"command"; name:string; args:string } | { kind:"text"; text:string }`.
- `InboxCapture` (`src/telegram/handlers/capture.ts:18`) — the injected inbox-sink type,
  `(text: string) => Promise<{ id?: string; title: string }>`. Production passes `defaultCapture`;
  unit tests pass a fake that records calls without opening a `FactStore` (`sc-2-3`/`sc-2-4`).
- `defaultCapture(text)` (`src/telegram/handlers/capture.ts:35`) — the production `InboxCapture`.
  It resolves the project root (falling back to `process.cwd()`), `ensureFactsDir`s the **default
  pool** (`.bober/memory/`, no namespace), stamps wall-clock `now` **at this boundary** (so the
  pure `captureTask` never calls the clock), opens a `FactStore`, persists via
  `captureTask(store, text, { now })` (domain omitted → the `"inbox"` pool), and `close()`s the
  store in a `finally`. Imports `captureTask` directly (Option A of the briefing's hybrid rule,
  because the task-inbox module exports it) — **no** `execa` shell-out.
- `handleCapture(text, capture)` (`src/telegram/handlers/capture.ts:60`) — captures `text` as one
  task via the injected `capture` and returns a one-line confirmation that **always contains the
  captured title** (`Captured: <title> (#<id>)`, or `Captured: <title>` when the sink returns no
  id). Zero-friction: it **never** prompts for a due date, domain, or any other field before
  capturing (`sc-2-4`). It has **no** transport access — the caller passes the returned string to
  `sendSafe`.
- `startPollLoop(transport, signal, capture = defaultCapture)` (`src/telegram/bot.ts:102`) — gains
  an **optional** third parameter (the inbox sink, default `defaultCapture`) so the loop is
  testable with a fake. For a whitelisted sender it now routes via `classify`: empty / non-text
  updates (stickers, photos) fall back to `helpReply()`; a `/start` command returns `helpReply()`;
  any other command returns `Unknown command: /<name>` (the Sprint 3–4 stub); plain text is
  captured and the confirmation is replied — **all through `sendSafe`**.

## How to use / how it fits

Run the bot exactly as in Sprint 1 (`agent-bober telegram`, credentials from env). Then, from a
whitelisted account:

```
renew passport          → bot replies "Captured: renew passport (#<id>)"   (one open inbox task)
/start                  → bot replies the help stub                        (unchanged)
/todo buy milk          → bot replies "Unknown command: /todo"             (Sprint 3–4 stub)
```

The captured task is a hub `Finding` (`kind:"action"`, `status:"open"`) in the **default pool**
with `domain:"inbox"` and no domain tag — the same surface `agent-bober task list` reads, so a
message typed to the bot appears in the CLI inbox (the manual `sc-2-5` end-to-end check). Because
`captureTask` is the single capture path, this sprint **reuses** the task-inbox feature rather than
reimplementing storage, dedup, or `FactStore` logic. The message text becomes the title verbatim
(`captureTask` trims only surrounding whitespace); nothing parses or enriches it — AI triage stays
owned by `spec-20260628-task-inbox`.

## Notes for maintainers

- **Command dispatch is still a stub.** Only `/start` is wired (to `helpReply()`); every other
  `/command` returns `Unknown command: /<name>`. A `bober:` marker in `bot.ts` flags the
  single-level `if` to be replaced with a **command-registry map** once Sprints 3+ add real
  hub/inbox/calendar query commands. Capture intentionally only fires on **non-command** text, so a
  message beginning with `/` produces **zero** inbox tasks (a hard non-goal + stop condition).
- **One `FactStore` per message.** `defaultCapture` opens and closes a fresh `FactStore` on every
  captured message (a `bober:` marker notes this). It is correct but not pooled — swap for a
  long-lived store + connection pool if bot throughput ever grows beyond a few messages/second.
- **Clock at the boundary.** `defaultCapture` stamps `now` and passes it into the pure
  `captureTask`; the router and `handleCapture` never read the clock, so the whole path is
  deterministic under an injected sink (no real time, no filesystem in tests).
- **`sendSafe` invariant preserved.** `handleCapture` returns a string; the loop sends it via
  `sendSafe`. No new direct `transport.sendMessage` call was added (evaluator-verified) — keep new
  reply paths going through the funnel.

Commit: `e936eea` — *bober(sprint-2): router + zero-friction capture handler for Telegram
plain-text messages* (5 files, +242/-2; **no** new dependency). Build/typecheck 0 errors; **30
telegram tests** green (router 6 + capture 4 + Sprint 1 outbound 7 + whitelist 13). All 4 required
criteria (`sc-2-1`..`sc-2-4`) passed iteration 1; the manual `sc-2-5` (`agent-bober task list`
visibility) was not run in CI. The one suite failure
(`src/medical/engine.test.ts` MedlinePlus 5 s-timeout axis) was confirmed **pre-existing** on the
Sprint 1 tree — not a regression.
