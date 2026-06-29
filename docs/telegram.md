# Telegram Frontend

The Telegram frontend (`src/telegram/`) is the **presentation adapter** for agent-bober: a
locally-run bot that lets a whitelisted operator talk to the platform from Telegram. Sprint 1
ships the **transport + access-control spine** — a long-polling bot, a user-id whitelist,
and a single outbound funnel. Sprint 2 adds the **first domain behavior**: a message router
plus **zero-friction task capture**, so plain text from an admitted sender lands as one open
task in the shared inbox. Hub / calendar / medical command dispatch is still deferred; an
admitted sender's `/start` (and any non-text update) still gets the help stub, and any other
`/command` gets an `Unknown command` placeholder later sprints replace.

---

## Posture: local long-polling, no server

The bot uses Telegram's **getUpdates long-polling** exclusively. There is:

- **no inbound HTTP server**, no `listen` / `createServer`,
- **no webhook** and **no public HTTPS URL**,
- **no open inbound port**.

`agent-bober telegram` opens an outbound `getUpdates({ offset, timeout: 30 })` loop and blocks
until Ctrl+C. This is the recommended posture for an unattended, single-operator deployment:
the process initiates every connection; nothing on the internet can reach it.

```bash
agent-bober telegram
# Telegram bot started — polling for updates (Ctrl+C to stop).
```

`SIGINT` / `SIGTERM` abort the loop cleanly via an `AbortController`. A transient `getUpdates`
error is logged to stderr and retried after a 5-second back-off; the loop never crashes the
process on a network blip.

---

## Credentials (environment only)

Both credentials are read from `process.env` — **never** hardcoded in source (mirrors
`src/medical/whoop/whoop-token.ts`):

| Variable | Required | Purpose |
|----------|----------|---------|
| `TELEGRAM_BOT_TOKEN` | yes | The bot token from [@BotFather](https://t.me/BotFather). Absent ⇒ the command prints a message naming the variable to stderr and exits non-zero **without** any network call. |
| `TELEGRAM_ALLOWED_USERS` | yes (effectively) | Comma-separated **numeric Telegram user ids** allowed to use the bot. Empty/absent ⇒ an empty allow-set ⇒ **every** account is denied. |

```bash
export TELEGRAM_BOT_TOKEN=123456:ABC-your-bot-token
export TELEGRAM_ALLOWED_USERS=11111111,22222222
```

`parseAllowedUsers` trims whitespace around each id and **silently drops** any token that is
not a positive integer, so a malformed entry quietly narrows access rather than crashing or
admitting everyone (fail-closed).

---

## Control-plane boundary: the whitelist

Access control is a **pure** authoriser (`src/telegram/whitelist.ts`, no I/O, no network):

- `parseAllowedUsers(env)` → an immutable `AllowedUsers` (`ReadonlySet<number>`).
- `isAllowed(senderId, allowed)` → `true` only when the numeric sender id is in the set.
- `denialReply(id)` → the message sent to a rejected sender; **the sender's exact numeric id
  appears verbatim** in the text, so an operator can read their own id off the denial and add
  it to `TELEGRAM_ALLOWED_USERS`.

The poll loop reads the allow-set **once at start**. For each update:

- **non-whitelisted sender** → reply with `denialReply(senderId)`, then ignore (no further
  processing);
- **whitelisted sender** → route the message (see **Message routing & capture** below).

This whitelist is the control-plane boundary every later command sits behind: nothing reaches
domain logic unless the sender is explicitly allow-listed.

---

## The outbound funnel: `sendSafe`

Every outbound reply leaves through **one** chokepoint, `sendSafe`
(`src/telegram/outbound.ts`):

```ts
export async function sendSafe(
  transport: TelegramTransport,
  chatId: number,
  content: string,
): Promise<void>;
```

Handlers **return** content strings; the caller passes them to `sendSafe`. No handler may call
`transport.sendMessage` directly. This is intentional: `sendSafe` is the single seam where
later sprints add rate-limiting, audit logging, or Markdown sanitisation without touching any
handler. The invariant is enforced and checked — `transport.sendMessage` appears exactly once
outside the SDK adapter (inside `sendSafe`, `outbound.ts:32`), and the raw grammy send
(`bot.api.sendMessage`) appears only inside the adapter (`bot.ts:57`).

### Privacy note

Telegram is **not** end-to-end encrypted. When this adapter later pushes the
research-scheduler's morning digest, that content is deliberately limited to non-sensitive
titles/summaries (see `docs/sprints/sprint-spec-20260628-research-scheduler-5.md`). Keep that
boundary honest at the `sendSafe` seam.

---

## Message routing & capture (Sprint 2)

Once a sender is admitted, the loop classifies their message with a **pure** router and dispatches:

`classify(message)` (`src/telegram/router.ts`) returns a `RoutedMessage` discriminated union — no
side effects, no network, no clock:

- a message whose first non-space character is `/` → `{ kind:"command", name, args }` (the leading
  `/` is stripped, and `name` is split from `args` on the first whitespace; `"/todo buy milk"` →
  `name:"todo"`, `args:"buy milk"`);
- anything else → `{ kind:"text", text }`, returned **verbatim** (never trimmed/parsed) so capture
  sees exactly what was typed.

The whitelisted-sender branch of `startPollLoop` then dispatches:

| Update | Reply |
|--------|-------|
| Non-text update (sticker, photo, empty) | `helpReply()` stub |
| `/start` | `helpReply()` stub |
| Any other `/command` | `Unknown command: /<name>` (Sprint 3–4 placeholder) |
| Plain text | **capture** → one-line confirmation |

### Zero-friction capture

Plain text is captured as a task with **no required fields beyond the text itself** — the handler
**never** prompts for a due date, domain, or anything else before capturing (a hard non-goal).
`handleCapture(text, capture)` (`src/telegram/handlers/capture.ts`) routes the text through an
**injected** `InboxCapture` sink and returns a confirmation that always contains the captured
title (`Captured: <title> (#<id>)`). The handler has no transport access — the loop passes its
return value to `sendSafe`.

The production sink, `defaultCapture`, persists into the **existing** task inbox
(`spec-20260628-task-inbox`) rather than reimplementing storage: it opens a `FactStore` for the
project's **default pool** (`.bober/memory/`), stamps wall-clock `now` at this boundary (the pure
`captureTask` never reads the clock), calls `captureTask(store, text, { now })` (domain omitted →
the `"inbox"` pool), and closes the store. The result is one open hub `Finding`
(`kind:"action"`, `status:"open"`, `domain:"inbox"`) — the same surface `agent-bober task list`
reads. The text becomes the title verbatim (`captureTask` trims only surrounding whitespace);
nothing parses or enriches it (AI triage stays owned by the task-inbox spec).

Because the sink is injected, the router and capture handler are unit-testable with a fake that
records calls and **never opens a `FactStore`** — no filesystem, no clock, no network.

---

## SDK isolation: `grammy` behind the transport wrapper

The chosen Telegram Bot API library is **[grammy](https://grammy.dev) (`^1.44.0`)** — the one
new dependency this plan adds. It is TypeScript-native ESM (no separate `@types` package). It
is kept **behind the transport wrapper**, exactly like the LLM `providers/` adapters
(`.bober/principles.md:28`):

- `TelegramTransport` (`outbound.ts`) — outbound interface (`sendMessage`).
- `BotTransport` (`bot.ts`) — `TelegramTransport` + `getUpdates(offset)`; the loop depends on
  this.
- `GrammyTransport` (`bot.ts`) — the **only** file that imports `grammy`; a concrete
  `BotTransport` wrapping `Bot.api`.
- `TelegramUpdate` (`bot.ts`) — a minimal local Update shape, defined locally so grammy's
  generated types never leak outside `bot.ts`.

Because the loop, the funnel, and the CLI all depend on the interfaces (not on grammy), the
whole module is unit-testable with an injected fake transport and **no network access** — and
swapping the SDK is a `bot.ts`-only change.

---

## Module map

| File | Role |
|------|------|
| `src/telegram/whitelist.ts` | Pure authoriser: `parseAllowedUsers` / `isAllowed` / `denialReply` (+ `AllowedUsers` type). No I/O. |
| `src/telegram/outbound.ts` | `TelegramTransport` interface + the `sendSafe` outbound funnel (single chokepoint). |
| `src/telegram/router.ts` | Pure `classify(message)` → `RoutedMessage` (`command` vs `text`). No I/O. |
| `src/telegram/handlers/capture.ts` | `handleCapture` (zero-friction capture via an injected `InboxCapture` sink) + production `defaultCapture` (persists via `captureTask`). |
| `src/telegram/bot.ts` | `BotTransport` + `GrammyTransport` adapter (sole grammy import), `helpReply` stub, and the `startPollLoop` getUpdates loop (now `classify` → capture / command dispatch). |
| `src/cli/commands/telegram.ts` | `registerTelegramCommand` — the `agent-bober telegram` command (env credential read, SIGINT/SIGTERM shutdown, never-throw). |

User-facing usage lives in [`COMMANDS.md`](../COMMANDS.md) under **Telegram Commands**.

---

## Roadmap (deferred to later sprints)

Sprint 1 shipped transport + whitelist + funnel; Sprint 2 added message routing + zero-friction
task capture. Still to come (Sprints 3–6): real command dispatch for hub/inbox/calendar actions
(replacing the `Unknown command` stub), document upload, streaming replies, approvals, and
**silent scheduled delivery of the research-scheduler morning digest**
(`.bober/research/digests/<date>.json`). Each new reply path must return content through
`sendSafe`, and each new command must sit behind the `isAllowed` whitelist.
