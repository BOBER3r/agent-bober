# Long-polling bot transport + user-id whitelist + outbound safe-summary funnel

**Contract:** sprint-spec-20260628-telegram-frontend-1  ·  **Spec:** spec-20260628-telegram-frontend  ·  **Completed:** 2026-06-29

## What this sprint added

Sprint 1 — the opening sprint of the **telegram-frontend** plan — lays the **transport +
access-control spine** for the Telegram presentation adapter. It adds a new `src/telegram/`
module with a pure user-id whitelist authoriser (`whitelist.ts`), a single outbound
chokepoint (`outbound.ts`), and a getUpdates **long-polling** loop with a `grammy`-backed
transport adapter (`bot.ts`), plus a new `agent-bober telegram` CLI command
(`src/cli/commands/telegram.ts`). A whitelisted operator can now run the bot locally: it
admits accounts whose numeric id is in `TELEGRAM_ALLOWED_USERS`, replies to everyone else
with a single denial that echoes their own id, and routes **every** outbound reply through
the `sendSafe` funnel. This sprint adds **no** task, hub, calendar, or medical domain logic —
the whitelisted-sender reply is a `/start` help stub later sprints replace with real command
dispatch.

## Public surface

- **`agent-bober telegram`** (`src/cli/commands/telegram.ts:16`, `registerTelegramCommand`,
  wired at `src/cli/index.ts:48` import / `:356` call) — start the local long-polling bot.
  Reads `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USERS` from `process.env`, opens a
  getUpdates loop, and blocks until Ctrl+C (`SIGINT`/`SIGTERM` abort the loop). An **absent
  `TELEGRAM_BOT_TOKEN`** prints a message naming the variable to stderr and sets
  `process.exitCode = 1` (no network call). The handler **never throws** — any startup error
  is caught, written to stderr, and turned into `exitCode = 1`.
- `parseAllowedUsers(env)` (`src/telegram/whitelist.ts:16`) — parse `TELEGRAM_ALLOWED_USERS`
  (comma-separated positive integer ids) from a given env map into an immutable
  `AllowedUsers` (`ReadonlySet<number>`). Whitespace is trimmed; empty/missing var ⇒ empty
  set; non-numeric / non-positive / non-integer tokens are **silently dropped**.
- `isAllowed(id, allowed)` (`src/telegram/whitelist.ts:32`) — `true` iff the numeric sender id
  is in the allowed set (`sc-1-3`).
- `denialReply(id)` (`src/telegram/whitelist.ts:42`) — the denial string sent to a
  non-whitelisted sender; the **exact numeric id appears verbatim** as a substring so the
  sender knows which account was rejected (`sc-1-4`).
- `TelegramTransport` (`src/telegram/outbound.ts:11`) — the provider-agnostic outbound
  interface (`sendMessage(chatId, text)`); handlers and the loop depend on this, never on a
  concrete SDK.
- `sendSafe(transport, chatId, content)` (`src/telegram/outbound.ts:27`) — **the single
  outbound chokepoint**; the only place `transport.sendMessage` is invoked (`sc-1-5`). A plain
  passthrough today, designed for later rate-limiting / audit / sanitisation extension without
  touching handlers.
- `BotTransport` (`src/telegram/bot.ts:37`) — extends `TelegramTransport` with
  `getUpdates(offset)`; the loop depends on this so tests inject a fake transport with no SDK.
- `GrammyTransport` (`src/telegram/bot.ts:48`) — the **sole** `grammy` consumer: a concrete
  `BotTransport` wrapping `Bot.api.sendMessage` / `Bot.api.getUpdates({ offset, timeout: 30 })`.
- `helpReply()` (`src/telegram/bot.ts:78`) — the `/start` help stub returned to whitelisted
  senders (later sprints replace it with real command dispatch).
- `startPollLoop(transport, signal)` (`src/telegram/bot.ts:99`) — the getUpdates long-poll
  loop: reads `TELEGRAM_ALLOWED_USERS` once at start, advances the `offset`, denies
  non-whitelisted senders (echo id) and help-replies to whitelisted ones — **all via
  `sendSafe`** — backs off 5s on a transient `getUpdates` error, and runs until the
  `AbortSignal` fires.
- `TelegramUpdate` (`src/telegram/bot.ts:20`) — the minimal local Update shape the loop
  consumes, defined locally so grammy's generated types never leak outside `bot.ts`.

## How to use / how it fits

```bash
export TELEGRAM_BOT_TOKEN=123456:ABC-your-bot-token
export TELEGRAM_ALLOWED_USERS=11111111,22222222   # comma-separated numeric Telegram ids

agent-bober telegram
# Telegram bot started — polling for updates (Ctrl+C to stop).
```

The bot uses **getUpdates long-polling only** — no server, no inbound port, no public HTTPS
URL, no webhook. Credentials come exclusively from the environment (no token or id is ever
hardcoded). Messages from accounts whose numeric id is in `TELEGRAM_ALLOWED_USERS` are
admitted (and get the `/start` help stub); every other account receives one denial reply that
echoes its own id and is otherwise ignored — this is the **control-plane boundary** later
sprints build commands behind. Every outbound byte leaves through `sendSafe`; no handler may
call `transport.sendMessage` directly.

This is the **presentation adapter** sequenced last in the knowledge-platform plan: it is the
surface that will consume the research-scheduler's morning-digest JSON
(`.bober/research/digests/<date>.json`) as a silent scheduled message and expose hub / inbox /
calendar actions to a whitelisted operator — none of which exists yet (Sprints 2–6).

## Notes for maintainers

- **Library choice: `grammy` (`^1.44.0`)** — the one new dependency this plan is permitted to
  add. It is TypeScript-native ESM (no `@types` package) and is **isolated to `bot.ts`**
  (`GrammyTransport`). The rest of `src/telegram/` and the CLI depend on
  `BotTransport` / `TelegramTransport`, not on grammy — mirroring the `providers/` adapter
  discipline (`.bober/principles.md:28`). Swapping the SDK touches `bot.ts` only.
- **Single-funnel invariant.** `transport.sendMessage` appears exactly once outside the
  adapter — inside `sendSafe` (`outbound.ts:32`); the raw SDK send (`bot.api.sendMessage`)
  appears only inside `GrammyTransport` (`bot.ts:57`). Keep new reply paths going through
  `sendSafe`; this is the seam where rate-limiting / audit / Markdown-sanitisation will land.
- **No server / no webhook.** A grep of `src/telegram/` for `listen` / `createServer` /
  `webhook` is empty by design (a hard non-goal + evaluator check). On-demand long-polling only.
- **The whitelisted reply is a stub.** `helpReply()` is intentionally a `/start` placeholder —
  there is **no** task/hub/calendar/medical logic in this sprint. Command dispatch, document
  upload, streaming, approvals, and digest delivery are Sprints 2–6.
- **Privacy posture.** Telegram is **not** end-to-end encrypted; the digest the bot will later
  push deliberately carries only non-sensitive titles/summaries (see the research-scheduler
  records). This adapter is the place to keep that boundary honest.
- **Clock / process discipline.** The loop reads `process.env` once at start; the CLI installs
  `SIGINT`/`SIGTERM` handlers that `AbortController.abort()` the loop for a clean shutdown.

Commit: `eb680c2` — *bober(sprint-1): add src/telegram/ module — grammy long-poll transport +
whitelist + sendSafe funnel* (10 files, +649; one new dep `grammy ^1.44.0`; suite **3603**
green, +20 telegram tests; all 5 required criteria passed iteration 1, `sc-1-6` live smoke
skipped).
