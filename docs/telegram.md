# Telegram Frontend

The Telegram frontend (`src/telegram/`) is the **presentation adapter** for agent-bober: a
locally-run bot that lets a whitelisted operator talk to the platform from Telegram. Sprint 1
ships the **transport + access-control spine** — a long-polling bot, a user-id whitelist,
and a single outbound funnel. Sprint 2 adds the **first domain behavior**: a message router
plus **zero-friction task capture**, so plain text from an admitted sender lands as one open
task in the shared inbox. Sprint 3 adds the **first hub-query commands** — `/today`,
`/priority`, and `/decide X vs Y` — which parse an **ephemeral** scope from the command text and
reply with a numbered ranked list from the priority hub. Sprint 4 adds the **inline-keyboard
approve / adjust / reject gate**: a `/pending` command surfaces pending approval checkpoints with
`[Approve][Adjust][Reject]` buttons whose taps write the **same** disk markers the existing
approve/reject CLI writes — no new approval mechanism. Calendar / medical command dispatch is
still deferred; an admitted sender's `/start` (and any non-text update) still gets the help stub,
and any other `/command` gets an `Unknown command` placeholder later sprints replace.

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
| `/today` · `/priority` · `/decide X vs Y` | **prioritize** → numbered ranked list (Sprint 3, below) |
| `/pending` | **approvals** → one inline-keyboard message per pending checkpoint (Sprint 4, below) |
| Any other `/command` | `Unknown command: /<name>` (placeholder for later sprints) |
| Plain text | Adjust/Reject follow-up (if stashed) → marker write; else **capture** → one-line confirmation |

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

## Scoped prioritization (Sprint 3)

Three commands ask the **priority hub** (`spec-20260628-priority-hub`) to rank findings, each with a
**different scope** parsed from the command text:

| Command | Scope | What it ranks |
|---------|-------|---------------|
| `/priority` | `{ mode:"general" }` | all pooled findings (hub relevance-filters the full pool) |
| `/today` | `{ mode:"filtered", dueWithinDays:1 }` | findings due within one day |
| `/decide X vs Y` | `{ mode:"decision", optionA:X, optionB:Y }` | only findings relevant to X or Y |

The reply is a **numbered ranked list of finding titles** in the **hub's returned order** — the
adapter never re-ranks (a hard non-goal).

### Ephemeral scope parsing

`parseScopeFromCommand(name, args)` (`src/telegram/router.ts:60`) is a **pure** function (no I/O, no
network, no clock) that derives a hub `Scope` (`src/hub/scope.ts`) from the command name + trailing
args, or returns `null`:

- `today` → `{ mode:"filtered", dueWithinDays:1 }`
- `priority` → `{ mode:"general" }`
- `decide` → split args on `/\s+vs\s+/i` and trim ⇒ `{ mode:"decision", optionA, optionB }`, but only
  when the split yields **exactly two non-empty** options (`/decide foo` or `/decide a vs b vs c` →
  `null`)
- any other name → `null`

The scope is **ephemeral** — each command re-derives it from its own text, and it is **never written
to disk** (a hard non-goal). A `null` result falls through to the `Unknown command: /<name>` stub.

### Delegation to the hub CLI (the LLM stays out of the adapter)

`handlePrioritize(name, args, query)` (`src/telegram/handlers/prioritize.ts:117`) parses the scope,
calls an **injected** `HubQuery` (`(scope) => Promise<HubResult[]>`), and returns the numbered list
(or `No findings to prioritize.` when the hub returns none). It has **no** transport access — the
loop passes its return value to `sendSafe`.

The production query, `defaultPrioritize` (`prioritize.ts:56`), invokes the **hub CLI in a
subprocess** via `execa(process.execPath, …)`:

- `decision` → `node <cliEntry> hub decide "<optionA> vs <optionB>"`
- `filtered` → `node <cliEntry> hub priority` (+ optional `--due` / `--domain` / `--tag`)
- `general` → `node <cliEntry> hub priority`

It parses the CLI's `N. <title>` stdout lines (`src/cli/commands/hub.ts:207`/`:251`) into
`HubResult[]` and **throws** on a non-zero exit (the error surfaces in the reply via `sendSafe`).
**The subprocess fully owns any LLM/model call — `src/telegram/` imports no provider and never
constructs an `LLMClient`** (evaluator-verified). This is the deliberate boundary that keeps the
adapter thin: all relevance filtering and lens-panel judging happen inside the hub subprocess.

### Control-plane rendering: titles only

The hub `Finding` has **no `summary` field**, so the reply renders **finding titles only** — no raw
domain detail leaks past `sendSafe`. Because `HubQuery` is injected, the parser and handler are
unit-testable with a fake returning fixture findings and **no subprocess at all** — no child process,
no clock, no network.

---

## Inline approve/adjust/reject (Sprint 4)

Sprint 4 surfaces **pending approval checkpoints** in Telegram and lets a whitelisted operator
resolve them with an inline keyboard — **without introducing any new approval mechanism**.

### The `/pending` command

`/pending` lists pending approval markers via `listPending` (`src/state/approval-state.ts`) and
renders **one message per pending checkpoint**, each carrying its own inline keyboard:

```
[promote-3f9c1a2b…]
Promote finding to do-bridge?
Artifact: promotion
      [ Approve ]  [ Adjust ]  [ Reject ]
```

When nothing is pending the bot replies `No pending approvals.` Each message text is built from the
marker's `checkpointId`, `prompt`, and (if present) `artifact.type`.

### The same gate — byte-identical markers (NO new mechanism)

This is the load-bearing property: a button tap writes the **exact same** `.approved.json` /
`.rejected.json` disk markers the existing `bober approve` / `bober reject` CLI commands write
(`src/state/approval-state.ts`). The handler calls the **same** `saveApproved` / `saveRejected`
helpers behind the **same** `pendingExists` guard. So **calendar plans and do-bridge promotions
resolve through the one existing gate** — Telegram is just a new front door to the canonical approval
store, never a parallel path. The evaluator confirmed:

- **Approve** ⇒ `ApprovedMarker { approvedAt, approverId }` with the `editDelta` key **absent**
  (byte-identical to `approve.ts`).
- **Adjust** ⇒ `ApprovedMarker` carrying the operator's replacement text as `editDelta` (steer).
- **Reject** ⇒ `RejectedMarker { rejectedAt, rejecterId, feedback }` (note the `rejecterId`
  spelling).

### Guards: whitelist first, then pendingExists

`handleApprovalCallback` (`src/telegram/handlers/approvals.ts:54`) runs a guard chain before any
write:

1. **Whitelist re-check on the callback sender id.** A tap from a non-whitelisted account writes
   nothing and triggers no resolution — the whitelist guard fires **first**, before `pendingExists`
   and before any disk write (`sc-4-5`).
2. **`pendingExists` guard.** A tap for a checkpoint with no matching `.pending.json` on disk writes
   no marker (`sc-4-4`), mirroring the approve CLI's `pendingExists` check.

The callback is **always** acknowledged (`answerCallback`) to dismiss the client's loading spinner —
even on denied or ghost (no-pending) taps. An inline-mode tap with no message context is acknowledged
with `Error` and gets no reply (there is no chat to send to).

### Ephemeral multi-turn state for Adjust / Reject

Plain Approve resolves in one tap. **Adjust** and **Reject** need a second turn (the replacement
text / feedback), so the tap stashes `{ action, checkpointId }` in a **per-chat in-memory map**,
`PendingCallbackState` (`Map<chatId, …>`, `approvals.ts:32`) — **no disk persistence**, cleared on
bot restart. The **next** plain-text message from that chat is intercepted by
`handleApprovalFollowup` (`approvals.ts:120`) **before** `classify`, so the follow-up text is **not**
captured as a new inbox task; it instead writes the Adjust/Reject marker and clears the stash. When
there is no stash for the chat the handler returns `null` and the loop falls through to normal text
routing (capture / command dispatch). A `bober:` note flags moving the map to a shared key-value
store only if the bot ever runs across multiple processes.

### Transport extension: `sendKeyboard` + `answerCallback` (grammy still `bot.ts`-only)

`BotTransport` gains two methods — `sendKeyboard(chatId, text, keyboard)` (send a message with an
inline keyboard, taking the **provider-neutral** `InlineKeyboardSpec`) and
`answerCallback(callbackQueryId, text?)` (acknowledge a tap). `TelegramUpdate` gains a minimal local
`callback_query` subset so grammy's generated types never leak. The poll loop processes a
`callback_query` update **before** the message branch.

Crucially, **grammy stays isolated to `bot.ts`**: `keyboard.ts` and `handlers/approvals.ts` import
**zero** grammy (principles.md §28/§41) — they speak the neutral `InlineKeyboardSpec` and the
`encode/decodeCallback` codec. The only place grammy's `InlineKeyboard` is constructed is
`toGrammyKeyboard` inside `bot.ts`, so swapping the SDK stays a `bot.ts`-only change. Text replies
still leave through `sendSafe`; keyboard messages go through `sendKeyboard` — both on `BotTransport`,
so the transport layer is never bypassed.

### callback_data codec (≤ 64 bytes)

`keyboard.ts` carries a compact codec because Telegram caps `callback_data` at **64 bytes (UTF-8)**.
`encodeCallback(action, checkpointId)` produces `"<code>:<checkpointId>"` (`a`=approve, `j`=adjust,
`r`=reject); `decodeCallback` splits on the **first** `:` only (checkpointIds may contain colons) and
returns `null` for malformed data. The checkpointId is **never truncated** — truncation would
silently break the `pendingExists` lookup.

---

## SDK isolation: `grammy` behind the transport wrapper

The chosen Telegram Bot API library is **[grammy](https://grammy.dev) (`^1.44.0`)** — the one
new dependency this plan adds. It is TypeScript-native ESM (no separate `@types` package). It
is kept **behind the transport wrapper**, exactly like the LLM `providers/` adapters
(`.bober/principles.md:28`):

- `TelegramTransport` (`outbound.ts`) — outbound interface (`sendMessage`).
- `BotTransport` (`bot.ts`) — `TelegramTransport` + `getUpdates(offset)` + `sendKeyboard(chatId,
  text, keyboard)` + `answerCallback(callbackQueryId, text?)` (the Sprint 4 additions); the loop
  depends on this.
- `GrammyTransport` (`bot.ts`) — the **only** file that imports `grammy`; a concrete
  `BotTransport` wrapping `Bot.api`. `toGrammyKeyboard` here is the sole place grammy's
  `InlineKeyboard` is constructed.
- `TelegramUpdate` (`bot.ts`) — a minimal local Update shape (now including a `callback_query`
  subset), defined locally so grammy's generated types never leak outside `bot.ts`.

Because the loop, the funnel, and the CLI all depend on the interfaces (not on grammy), the
whole module is unit-testable with an injected fake transport and **no network access** — and
swapping the SDK is a `bot.ts`-only change.

---

## Module map

| File | Role |
|------|------|
| `src/telegram/whitelist.ts` | Pure authoriser: `parseAllowedUsers` / `isAllowed` / `denialReply` (+ `AllowedUsers` type). No I/O. |
| `src/telegram/outbound.ts` | `TelegramTransport` interface + the `sendSafe` outbound funnel (single chokepoint). |
| `src/telegram/router.ts` | Pure `classify(message)` → `RoutedMessage` (`command` vs `text`) + pure `parseScopeFromCommand(name, args)` → hub `Scope` \| `null` (`/today`/`/priority`/`/decide`). No I/O. |
| `src/telegram/handlers/capture.ts` | `handleCapture` (zero-friction capture via an injected `InboxCapture` sink) + production `defaultCapture` (persists via `captureTask`). |
| `src/telegram/handlers/prioritize.ts` | `handlePrioritize` (numbered ranked list via an injected `HubQuery`, title-only render) + production `defaultPrioritize` (execa → `hub priority`/`hub decide` subprocess; the subprocess owns all LLM calls). |
| `src/telegram/keyboard.ts` | Pure, **zero-grammy** inline-keyboard builder + callback_data codec: `CallbackAction`, `InlineKeyboardSpec`, `encodeCallback`/`decodeCallback` (`"<code>:<checkpointId>"`, ≤ 64 bytes, never truncates), `buildApprovalKeyboard`. |
| `src/telegram/handlers/approvals.ts` | `handleApprovalCallback` (whitelist-first + `pendingExists` guard chain → `saveApproved`/`saveRejected`, **byte-identical markers**) + `handleApprovalFollowup` (resolves a stashed Adjust/Reject from the next text turn) + ephemeral `PendingCallbackState` map (`createPendingState`). No grammy, no new approval mechanism. |
| `src/telegram/bot.ts` | `BotTransport` (now + `sendKeyboard`/`answerCallback`) + `GrammyTransport` adapter (sole grammy import; `toGrammyKeyboard` here only), `helpReply` stub, and the `startPollLoop` getUpdates loop (callback_query branch → approvals; `classify` → capture / prioritize / `/pending` / command dispatch). |
| `src/cli/commands/telegram.ts` | `registerTelegramCommand` — the `agent-bober telegram` command (env credential read, SIGINT/SIGTERM shutdown, never-throw). |

User-facing usage lives in [`COMMANDS.md`](../COMMANDS.md) under **Telegram Commands**.

---

## Roadmap (deferred to later sprints)

Sprint 1 shipped transport + whitelist + funnel; Sprint 2 added message routing + zero-friction
task capture; Sprint 3 added the scoped hub-priority commands (`/today`, `/priority`,
`/decide X vs Y`); Sprint 4 added the inline-keyboard approve/adjust/reject gate (`/pending`) over
the existing disk-marker approval store. Still to come (Sprints 5–6): the remaining command dispatch
for inbox/calendar actions (replacing the `Unknown command` stub), document upload, streaming
replies, and **silent scheduled delivery of the research-scheduler morning digest**
(`.bober/research/digests/<date>.json`). Each new reply path must return content through
`sendSafe` (or `sendKeyboard`), and each new command must sit behind the `isAllowed` whitelist.
