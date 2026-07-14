# Streaming run progress (in-place edits) + silent scheduled digest delivery

**Contract:** sprint-spec-20260628-telegram-frontend-6  ·  **Spec:** spec-20260628-telegram-frontend  ·  **Completed:** 2026-06-30

## What this sprint added

Two **outbound delivery modes** layered over the existing `sendSafe` funnel — both pure presentation,
**no run / fleet / scheduler logic added** (the diff stays inside `src/telegram/`).

**§A — Streaming progress as in-place edits.** `streamProgress` (`src/telegram/streaming.ts`) reports a
long-running operation by editing **one** status message in place as progress events arrive, instead of
posting a new message per tick. It issues **exactly one** send (the initial header) via the new
`sendSafeForEdit` chokepoint to capture the Telegram `message_id`, then **N** in-place edits via
`sendSafeEdit` on that **same** id — one per update from an **injected** `AsyncIterable<string>`. The
last update becomes the final summary edit. Because the update source is injected, tests drive a fixed
sequence and the real caller can back it with existing run-progress signals (e.g. `history.jsonl`
events) **without** this module adding any run logic.

**§B — Silent scheduled digest.** `sendDigest` (`src/telegram/digest.ts`) sends a scheduler-handed
digest payload with notifications silenced. It routes the plain text through `sendSafe` with the new
`{ silent: true }` option, which `GrammyTransport` maps to Telegram's `disable_notification`. The
adapter does **not** decide digest content or cadence — those stay owned by the research-scheduler
(`spec-20260628-research-scheduler`); this only delivers a payload handed to it, silently.

**Funnel now has four chokepoints.** `outbound.ts` gains a provider-neutral `SendOptions { silent? }`
(threaded through `sendSafe` as an **optional 4th arg**, so all Sprint 1–5 three-arg callers are
byte-compatible) and a new `EditTransport` interface plus two streaming chokepoints. So every outbound
path now leaves through one of **four** seams: `sendSafe` (text) · `sendSafeKeyboard` (inline keyboards)
· `sendSafeForEdit` (the one initial streaming send) · `sendSafeEdit` (the in-place edits). grammy stays
isolated to `bot.ts`.

## Public surface

### §A — Streaming (`src/telegram/streaming.ts`)

- `streamProgress(transport, chatId, updates, opts?)` (`src/telegram/streaming.ts:25`) — one
  `sendSafeForEdit` for the initial header (`opts.header`, default `"Working…"`) → captures the
  `message_id` → one `sendSafeEdit` per item from the injected `updates: AsyncIterable<string>`, all on
  the **same** id. Never posts a new message per tick (`nonGoal`). Calls **only** the funnel functions,
  never `transport.sendReturningId` / `transport.editMessage` directly (`sc-6-4`).

### §B — Silent digest (`src/telegram/digest.ts`)

- `sendDigest(transport, chatId, text)` (`src/telegram/digest.ts:23`) — `sendSafe(transport, chatId,
  text, { silent: true })`. Sets `disable_notification` (`sc-6-3`); routes through `sendSafe`, never a
  direct transport call (`sc-6-4`). The `text` payload is supplied by the scheduler owner — this adapter
  decides neither content nor cadence.

### Outbound funnel additions (`src/telegram/outbound.ts`)

- `SendOptions` (`src/telegram/outbound.ts:7`) — provider-neutral delivery options: `{ silent?: boolean }`.
  `GrammyTransport` maps `silent` to `disable_notification`; other transports may map it to their own
  equivalent.
- `EditTransport` (`src/telegram/outbound.ts:42`) — the streaming transport surface: `sendReturningId(chatId,
  text, opts?) => Promise<number>` and `editMessage(chatId, messageId, text) => Promise<void>`. Defined
  in `outbound.ts` (not `bot.ts`) so `streaming.ts` can import it **without** a circular dependency
  (`bot.ts` already imports from `outbound.ts`).
- `sendSafe(transport, chatId, content, opts?)` (`src/telegram/outbound.ts:61`) — gains an **optional 4th**
  `opts?: SendOptions`. `undefined` for all Sprint 1–5 callers ⇒ **no behavior change**; threads `opts`
  through to `transport.sendMessage`.
- `sendSafeForEdit(transport, chatId, content, opts?)` (`src/telegram/outbound.ts:76`) — the **only** place
  `transport.sendReturningId` is invoked. Issues the single initial streaming send and returns its
  `message_id`. `streaming.ts` must call this, not the transport directly.
- `sendSafeEdit(transport, chatId, messageId, content)` (`src/telegram/outbound.ts:90`) — the **only** place
  `transport.editMessage` is invoked. Updates one message in place per tick (never a new message).

### Transport extension (`src/telegram/bot.ts`)

- `BotTransport extends TelegramTransport, EditTransport` (`src/telegram/bot.ts:69`) — now satisfies both the
  text and edit funnels.
- `GrammyTransport.sendMessage(chatId, text, opts?)` (`src/telegram/bot.ts:116`) — maps `opts.silent` →
  grammy's `{ disable_notification: true }` (else `undefined`), so callers stay SDK-agnostic.
- `GrammyTransport.sendReturningId(chatId, text, opts?)` (`src/telegram/bot.ts:126`) — sends via
  `bot.api.sendMessage` and returns `msg.message_id` (used only by `sendSafeForEdit`). Honors `silent` too.
- `GrammyTransport.editMessage(chatId, messageId, text)` (`src/telegram/bot.ts:140`) — edits in place via
  `bot.api.editMessageText` (used only by `sendSafeEdit`). grammy stays `bot.ts`-only.

## How to use / how it fits

Both senders are **library functions** consumed by a caller that owns the data source — they are not new
CLI commands. From inside the bot process (or a job owner holding a `BotTransport`):

```ts
// Streaming: edit ONE status message in place as progress arrives.
await streamProgress(transport, chatId, runProgressIterable, { header: "Promoting finding…" });

// Silent digest: deliver the research-scheduler payload without a notification sound.
const text = renderDigestMarkdown(digest); // owned by src/research — NOT imported here
await sendDigest(transport, chatId, text);
```

The streaming `updates` argument is an injected `AsyncIterable<string>`; the final item is the summary.
`sendDigest`'s `text` is whatever the scheduler hands over — this adapter only silences the delivery.
Every reply still leaves through a funnel chokepoint, so later rate-limiting / audit / sanitisation can
be added at one seam.

## Notes for maintainers

- **Documented seam: live do-bridge wiring is intentionally not done here (`sc-6-5`).** Wiring a real
  long-running do-bridge promotion run to `streamProgress` is left as a **documented seam** at
  `src/do-bridge/do.ts:~172–180` (after the promotion gate). The non-goal forbids adding run logic to
  this adapter, so the manual criterion `sc-6-5` (a live in-place-updating status message + a silent
  delivered digest) was **not required** and was **skipped** at evaluation — the executable surface is
  source-agnostic and consumes an injected iterable. A follow-up sprint can supply that iterable from a
  `CompletionTailer` / roster `state.json` progress field without touching `streaming.ts`.
- **`SendOptions` is an optional 4th arg — keep it that way.** The whole reason all Sprint 1–5 callers
  stayed byte-identical is that `opts` is optional and `undefined` by default. Do not make it required.
- **Four funnel chokepoints, no direct transport sends.** `sendSafe` / `sendSafeKeyboard` /
  `sendSafeForEdit` / `sendSafeEdit` are the only places the respective `transport.*` send/edit methods
  are invoked. `streaming.ts` and `digest.ts` must keep routing through them (`sc-6-4`).
- **One send + N edits — never a new message per tick.** `streamProgress` captures the id from the single
  `sendSafeForEdit` and edits that same id; do not add a per-update send (`sc-6-2`, `nonGoal`).
- **grammy stays `bot.ts`-only.** `streaming.ts`, `digest.ts`, and `outbound.ts` import **zero** grammy;
  `sendReturningId` / `editMessage` / the `disable_notification` mapping live on `GrammyTransport`.
  Swapping the SDK remains a `bot.ts`-only change.
- **Digest content/cadence is owned elsewhere.** `sendDigest` only delivers; what goes into a digest and
  when it fires belong to the research-scheduler. Keep the non-sensitive-summary-only boundary honest at
  the `sendSafe` seam (Telegram is not end-to-end encrypted).

Commit: `0c9fe11` — *bober(sprint-6): streaming in-place edits + silent digest delivery over the sendSafe
funnel* (6 files, +333/-10; **no** new dependency). Build/typecheck 0 errors; full suite **3678** green
(**+11 tests**: streaming ×7 + digest ×4). All 4 required criteria (`sc-6-1`..`sc-6-4`) passed iteration 1
(exactly one send + N edits on the same id via an injected `EditTransport` spy for N=2 and N=3; digest
sets `disable_notification` via `{ silent: true }`; both senders route only through the funnel; the
optional `SendOptions` 4th arg did not break Sprints 1–5 callers; grammy / `editMessageText` /
`message_id` isolated to `bot.ts`; no run/fleet/scheduler logic added). The manual `sc-6-5` (live
do-bridge streaming + silent digest against the running bot) is **not required** and was skipped — left
as the documented do-bridge seam above. No regressions.
