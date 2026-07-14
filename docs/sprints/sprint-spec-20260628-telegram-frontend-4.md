# Inline-keyboard approve / adjust / reject over the existing disk-marker gate

**Contract:** sprint-spec-20260628-telegram-frontend-4  ·  **Spec:** spec-20260628-telegram-frontend  ·  **Completed:** 2026-06-30

## What this sprint added

Sprint 4 surfaces **pending approval checkpoints** in Telegram and lets a whitelisted operator
resolve them with an inline keyboard `[Approve] [Adjust] [Reject]`. The headline property is that
**no new approval mechanism is introduced** (nonGoal #1): every button tap writes the **same**
`.approved.json` / `.rejected.json` disk markers the existing `bober approve` / `bober reject` CLI
commands write (`src/state/approval-state.ts`), so calendar plans and do-bridge promotions resolve
through the **one existing gate**. A new `/pending` command lists pending markers
(`listPending`), each rendered as a message carrying its own inline keyboard. Callbacks are
**whitelist-gated** (re-checked on the callback sender id) and **pendingExists-guarded** (a tap for
a checkpoint with no `.pending.json` writes nothing — mirroring the approve CLI). Approve writes an
`ApprovedMarker` with `editDelta` **absent**; Adjust and Reject use an **ephemeral, in-memory**
per-chat state map to collect a follow-up text turn (replacement text → `editDelta`; feedback →
`RejectedMarker.feedback`). The transport gains `sendKeyboard` + `answerCallback`, and **grammy
stays isolated to `bot.ts`** — `keyboard.ts` and `approvals.ts` import zero grammy.

## Public surface

- `CallbackAction` (`src/telegram/keyboard.ts:17`) — `"approve" | "adjust" | "reject"`.
- `InlineKeyboardSpec` (`src/telegram/keyboard.ts:20`) — provider-neutral keyboard shape: rows of
  `{ text, data }` buttons. `bot.ts` converts it to grammy's `InlineKeyboard`; nothing else imports
  grammy.
- `encodeCallback(action, checkpointId)` (`src/telegram/keyboard.ts:32`) — encodes a tap into the
  compact `"<code>:<checkpointId>"` callback_data string (`a`=approve, `j`=adjust, `r`=reject).
  Designed to stay **≤ 64 bytes** (Telegram's callback_data limit) for all current checkpointId
  formats; **never truncates** (truncation would silently break the `pendingExists` lookup).
- `decodeCallback(data)` (`src/telegram/keyboard.ts:41`) — inverse of `encodeCallback`; splits on
  the **first** `:` only (checkpointIds may contain colons) and returns
  `{ action, checkpointId } | null` for unrecognised/malformed data.
- `buildApprovalKeyboard(checkpointId)` (`src/telegram/keyboard.ts:59`) — builds the one-row
  `[Approve] [Adjust] [Reject]` `InlineKeyboardSpec` for a single checkpoint.
- `PendingCallbackState` (`src/telegram/handlers/approvals.ts:32`) — `Map<chatId, { action:
  "adjust" | "reject"; checkpointId }>`: the **ephemeral, in-memory** stash for the multi-turn
  Adjust/Reject text collection. **No disk persistence** — cleared on bot restart.
- `createPendingState()` (`src/telegram/handlers/approvals.ts:34`) — constructs an empty
  `PendingCallbackState` (the default for `startPollLoop`'s 5th param).
- `handleApprovalCallback(args)` (`src/telegram/handlers/approvals.ts:54`) — handles a button tap.
  Returns `{ reply, answer }` (`reply` → `sendSafe`, `null` = send nothing; `answer` always present
  to dismiss the client spinner). Guard chain: **(1)** whitelist re-check on the callback sender id
  (`sc-4-5` — non-whitelisted ⇒ `{ reply:null, answer:"Denied" }`, writes nothing); **(2)**
  `pendingExists` guard (`sc-4-4` — no `.pending.json` ⇒ writes nothing); **(3)** Approve ⇒
  `saveApproved` an `ApprovedMarker { approvedAt, approverId }` with `editDelta` **absent**
  (byte-identical to `approve.ts`) then `deletePending`; **(4)** Adjust / Reject ⇒ stash in the
  pending map and prompt for the follow-up text.
- `handleApprovalFollowup(args)` (`src/telegram/handlers/approvals.ts:120`) — resolves a stashed
  Adjust/Reject when the **next** plain-text message arrives from that chat. Returns `null` when
  there is no stash (caller falls through to normal text routing). Adjust ⇒ `ApprovedMarker` with
  `editDelta = text`; Reject ⇒ `RejectedMarker { rejectedAt, rejecterId, feedback }` (note the
  `rejecterId` spelling). Both `deletePending` after the write (`sc-4-3`).
- `BotTransport.sendKeyboard(chatId, text, keyboard)` (`src/telegram/bot.ts`) — new transport
  method: send a message with an inline keyboard (takes the neutral `InlineKeyboardSpec`).
- `BotTransport.answerCallback(callbackQueryId, text?)` (`src/telegram/bot.ts`) — new transport
  method: acknowledge a callback query (dismisses the client loading spinner). Called for **every**
  tap, even denied/ghost ones.
- `TelegramUpdate.callback_query` (`src/telegram/bot.ts`) — minimal local callback-query subset
  (`{ id, from:{id}, message?:{chat:{id}}, data? }`) so grammy's generated types never leak.
- `/pending` command — lists pending approval checkpoints, one inline-keyboard message per marker;
  `No pending approvals.` when none.
- `startPollLoop(transport, signal, capture?, prioritize?, pending = createPendingState())`
  (`src/telegram/bot.ts`) — gains an **optional** fifth parameter (the pending-callback state) so
  the loop is testable with an injected map; existing two-arg callers (`telegram.ts:50`) compile
  unchanged.

## How to use / how it fits

Run the bot as before (`agent-bober telegram`, credentials from env). From a whitelisted account:

```
/pending             → one message per pending checkpoint, each with [Approve][Adjust][Reject]
tap Approve          → writes <id>.approved.json (approvedAt, approverId; no editDelta) → run proceeds
tap Adjust           → bot replies "Send the replacement text."; your next message becomes editDelta
tap Reject           → bot replies "Send rejection feedback."; your next message becomes feedback
```

The buttons resolve the **same** gate the CLI does: `handleApprovalCallback` /
`handleApprovalFollowup` call `saveApproved` / `saveRejected` (behind the `pendingExists` guard)
from `src/state/approval-state.ts` — the identical helpers `bober approve` / `bober reject` use. A
waiting calendar-plan or do-bridge-promotion checkpoint therefore proceeds exactly as it would from
the CLI; the Telegram surface is just a new **front door** to the one existing approval store. Every
text reply still leaves through the Sprint 1 `sendSafe` funnel; keyboard messages go through the new
`sendKeyboard` transport method (also on `BotTransport`, so the transport layer is never bypassed).

## Notes for maintainers

- **No new approval mechanism — byte-identical markers.** The evaluator confirmed the Approve
  marker is byte-identical to `approve.ts` (`editDelta` key **absent**), Adjust carries `editDelta`,
  and Reject uses the `rejecterId` spelling. **Do not** add a parallel Telegram-only marker shape or
  resolution path; route through `saveApproved`/`saveRejected` so the one gate stays canonical.
- **Whitelist guard fires first.** The callback whitelist re-check runs **before** `pendingExists`
  and before any write (`sc-4-5`). The follow-up handler re-checks the whitelist too
  (belt-and-suspenders, since the outer loop already blocks non-whitelisted messages).
- **No-pending guard mirrors the CLI.** A tap (or follow-up) for a checkpoint with no `.pending.json`
  writes no marker (`sc-4-4`), mirroring `approve.ts`'s `pendingExists` check.
- **Ephemeral multi-turn state.** `PendingCallbackState` is an in-process `Map` keyed by chatId — no
  disk, cleared on restart. The Adjust/Reject follow-up is intercepted in the message branch
  **before** `classify`, so the replacement/feedback text is **not** captured as a new inbox task. A
  `bober:` note flags extending to a shared key-value store (e.g. Redis) only if the bot ever runs
  across multiple processes.
- **grammy stays in `bot.ts`.** `keyboard.ts` and `approvals.ts` import zero grammy (principles.md
  §28/§41, evaluator-verified). `toGrammyKeyboard` (in `bot.ts`) is the **only** place grammy's
  `InlineKeyboard` is constructed. Swapping the SDK remains a `bot.ts`-only change.
- **Always acknowledge the callback.** `answerCallback` is called for every tap — including denied
  and ghost (no-pending) taps — to dismiss the client spinner. An inline-mode tap with no message
  context is acknowledged with `"Error"` and produces no reply (no chat to send to).
- **`sendSafe` invariant preserved.** Text replies still go through `sendSafe`; the only new
  transport surface is `sendKeyboard` (keyboards) + `answerCallback` (spinner ack), both on
  `BotTransport` — no handler calls `transport.sendMessage` directly.
- **No changes to `approval-state.ts`, the orchestrator, or `package.json`** (nonGoal #5; no new
  dependency).

Commit: `36514ae` — *bober(sprint-4): inline-keyboard approve/adjust/reject gate for pending
checkpoints* (5 files, +744/-12; **no** new dependency). Build/typecheck 0 errors; full suite
**3650** green (**+67 tests**: keyboard codec 10 + approvals 11 + bot-loop additions). All 5
required criteria (`sc-4-1`..`sc-4-5`) passed iteration 1; the manual `sc-4-6` (live calendar-plan
checkpoint resolved from Telegram) was not run in CI. No regressions (approve/reject/approval-state
suites green).
