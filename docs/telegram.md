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
approve/reject CLI writes — no new approval mechanism. Sprint 5 adds **document-upload medical
ingest behind a mandatory per-upload opt-in**: a document message defers the download until an
explicit Yes, names the local medical store in the prompt, hands the file to the existing
`src/medical` ingest exactly once, and replies with a non-sensitive count only — and it **unifies
the outbound keyboard funnel** so every keyboard message leaves through one `sendSafeKeyboard`
chokepoint. Sprint 6 adds **two outbound delivery modes over the same funnel**: **streaming** — a
long-running operation reports progress by editing **one** status message in place (one initial send
via `sendSafeForEdit`, then N in-place edits via `sendSafeEdit` on the same id) instead of posting a
message per tick — and a **silent scheduled digest** (`sendDigest`) sent with notifications disabled
(`SendOptions{silent}` → `disable_notification`). Sprint 7 — the **final** sprint — adds the
**multi-LLM "secretary" `/fleet` view**: a read-only renderer (`renderFleetView`) that reads the
head-written `.bober/fleet-synthesis.json` artifact, groups findings by per-agent `FactRecord.subject`,
and emits one section per agent (label + one-line summary + round + confidence + count). The same
renderer feeds **both** the on-demand `/fleet` command **and** the Sprint 6 streaming path
(`streamFleetView`), and `SynthesisBundle` / `FactRecord` are **type-only** imports so the bot keeps
zero runtime coupling to `src/fleet` / `better-sqlite3`. With Sprint 7 the plan is **complete (7/7
sprints)** — see [**Plan complete**](#plan-complete-77-sprints) below. An admitted sender's `/start`
(and any non-document, non-text update) still gets the help stub, and any other `/command` gets an
`Unknown command` placeholder (full inbox/calendar action dispatch was deferred — see the close-out).

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

## The outbound funnel: four chokepoints in `outbound.ts`

Every outbound reply leaves through a chokepoint in `src/telegram/outbound.ts`. As of Sprint 6 there
are **four**: **text** through `sendSafe`, **inline keyboards** through `sendSafeKeyboard`, and the
**streaming** pair `sendSafeForEdit` (the one initial status send) + `sendSafeEdit` (the in-place
edits). The first two:

```ts
export async function sendSafe(
  transport: TelegramTransport,
  chatId: number,
  content: string,
): Promise<void>;

export async function sendSafeKeyboard(
  transport: KeyboardTransport,
  chatId: number,
  content: string,
  keyboard: InlineKeyboardSpec,
): Promise<void>;
```

Handlers **return** content strings; the caller passes them to `sendSafe`. No handler may call
`transport.sendMessage` directly. This is intentional: `sendSafe` is the single seam where
later sprints add rate-limiting, audit logging, or Markdown sanitisation without touching any
handler. The invariant is enforced and checked — `transport.sendMessage` appears exactly once
outside the SDK adapter (inside `sendSafe`, `outbound.ts:32`), and the raw grammy send
(`bot.api.sendMessage`) appears only inside the adapter (`bot.ts:57`).

### Keyboard funnel now unified (Sprint 5 — seam gap closed)

Sprint 4 introduced the inline keyboard but sent it via `transport.sendKeyboard` **directly in the
poll loop**, so keyboards bypassed a unified funnel (a seam gap the Sprint-4 record noted). **Sprint
5 closes it:** `sendSafeKeyboard` (`outbound.ts:56`) is now the **sole** place
`transport.sendKeyboard` is invoked. Both keyboard surfaces — the `/pending` approvals keyboard
(retrofitted) and the new upload opt-in keyboard — route through it. So text **and** keyboards each
have a single control-plane chokepoint (`sendSafe` / `sendSafeKeyboard`); later sprints can add
keyboard-message filtering / audit / rate-limiting at `sendSafeKeyboard` without touching the loop or
any handler. `KeyboardTransport` (`outbound.ts:23`) is a minimal `{ sendKeyboard }` interface defined
in `outbound.ts` so `sendSafeKeyboard` can live there **without importing from `bot.ts`** (which would
be a circular import — `bot.ts` already imports from `outbound.ts`); `BotTransport` satisfies it
structurally.

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

## Document upload → medical ingest opt-in (Sprint 5)

Sprint 5 lets a whitelisted operator upload a document (e.g. a lab PDF) and have it ingested into the
**existing** `src/medical` store — but **only behind a mandatory per-upload consent gate**, because
Telegram is **not** end-to-end encrypted.

### The per-upload consent gate — download is deferred until Yes

When a document message arrives, `registerUpload` (`src/telegram/handlers/upload.ts:92`) **does not
download anything**. It stashes `{ fileId, fileName, chatId }` in an ephemeral in-memory map keyed by
the message id, and returns an opt-in prompt that **names the local ingest destination and discloses
the non-E2E nature of Telegram** (`buildUploadPrompt`, `upload.ts:77`):

```
Telegram is not end-to-end encrypted. Send "labs.pdf" to the LOCAL medical ingest
(.bober/medical (local health store))? Nothing is processed until you tap Yes.
            [ Yes ]   [ No ]
```

The prompt and a `[Yes][No]` keyboard (`buildUploadKeyboard`, `keyboard.ts:87`) are sent via
`sendSafeKeyboard`. The file is fetched **only after an explicit Yes** — there is no download, no temp
file, and no medical code reached until the operator confirms (`sc-5-2`).

### Yes / No resolution

`handleUploadCallback` (`upload.ts:126`) resolves the tap. The callback codec adds `confirm`→`y` and
`cancel`→`n` to the existing `a`/`j`/`r` set, and the poll loop **decodes first** to route
`confirm`/`cancel` taps here (and `a`/`j`/`r` taps to the approvals handler). The guard order is:

1. **Whitelist re-check** on the callback sender id — a tap from a non-whitelisted account ingests
   nothing (`{ reply:null, answer:"Denied" }`).
2. **Decode + stash lookup** — the stash is consumed **single-shot** (a duplicate tap is a no-op); a
   missing stash replies `Upload expired or already handled.` and ingests nothing.
3. **No (`cancel`)** ⇒ `Discarded — nothing was ingested.` — **no download, no ingest** (`sc-5-4`).
4. **Yes (`confirm`)** ⇒ `mkdtemp` a temp dir → download the file (injected `download`) → hand the
   local path to the **existing medical ingest exactly once** (injected `ingest`) → reply with a
   **count only** → remove the temp dir in a **`finally`**.

### Count-only reply — no PHI leaves through Telegram

The post-ingest reply is a **non-sensitive integer count** —
`Imported <N> results into local medical store.` — parsed from the ingest result. **No marker values,
names, or other raw PHI are ever echoed** (`nonGoal #3`, `sc-5-5`). The temp file is **always removed**
in a `finally`, so no PHI bytes persist on disk after ingest (`nonGoal #4`).

### Guards stay authoritative in the subprocess (not duplicated)

The production ingest, `defaultMedicalIngest` (`upload.ts:190`), invokes the medical pipeline in a
**subprocess** via `execa(process.execPath, [cliEntry, "medical", "import", filePath], …)` (mirroring
`defaultPrioritize`). The medical `EgressGuard` / `ConsentGate` / `AuditLog` run **inside that child
process** — they are **not** duplicated, bypassed, or weakened in `src/telegram/` (`nonGoal #5`). The
adapter reimplements **no** medical parsing or storage; it just gates consent and shells out. The
ingest and download functions are **injected**, so the handler is unit-testable with spies (no network,
no disk, no real medical pipeline).

### grammy stays `bot.ts`-only

The download itself is the one new grammy surface: `BotTransport.downloadDocument(fileId, destPath)`
(`bot.ts:79`, impl `:150`) resolves the file path via `bot.api.getFile`, fetches the Telegram file
endpoint, and writes bytes via `node:fs/promises` — no `@grammyjs/files` plugin needed. It lives on
`GrammyTransport` so grammy types never leak outside `bot.ts`. `TelegramUpdate.message` gains a minimal
local `document` subset; `startPollLoop` gains an **optional** 6th `uploads` param (the pending-upload
state) so the loop is testable with an injected map, and existing callers compile unchanged.

---

## Streaming progress + silent digest (Sprint 6)

Sprint 6 adds **two outbound delivery modes** over the existing funnel — both pure presentation, with
**no run, fleet, or scheduler logic** added (the diff stays inside `src/telegram/`).

### Streaming: one status message, edited in place

`streamProgress(transport, chatId, updates, opts?)` (`src/telegram/streaming.ts:25`) reports a
long-running operation by editing **one** status message in place as progress arrives, instead of
posting a new message per tick (a hard non-goal):

- **one send** — `sendSafeForEdit` (`outbound.ts:76`) issues the initial header (`opts.header`, default
  `"Working…"`) and returns its Telegram `message_id`;
- **N edits** — for each item from the injected `updates: AsyncIterable<string>`, `sendSafeEdit`
  (`outbound.ts:90`) replaces that **same** message in place. The last update is the final summary.

The update source is **injected** as an `AsyncIterable<string>`, so unit tests drive a fixed sequence
(the evaluator verified exactly **one** send + **N** edits on the same id for N=2 and N=3 via an injected
`EditTransport` spy), and the real caller can back it with existing run-progress signals (e.g.
`history.jsonl` events) **without** this module adding any run logic. `streamProgress` calls **only** the
funnel functions — never `transport.sendReturningId` / `transport.editMessage` directly.

> **Live do-bridge wiring is a documented seam, not built here.** Wiring a real long-running do-bridge
> promotion run to `streamProgress` is left as a seam at `src/do-bridge/do.ts` (after the promotion gate).
> The non-goal forbids run logic in this adapter, so the manual criterion (a live in-place-updating status
> message) was not required and was skipped at evaluation. A follow-up sprint supplies the iterable
> without touching `streaming.ts`.

### Silent digest: notifications disabled

`sendDigest(transport, chatId, text)` (`src/telegram/digest.ts:23`) delivers a scheduler-handed digest
payload silently: it calls `sendSafe(transport, chatId, text, { silent: true })`, and `GrammyTransport`
maps `silent` to Telegram's `disable_notification`. The adapter decides **neither content nor cadence** —
those stay owned by the research-scheduler (`spec-20260628-research-scheduler`); this only delivers a
payload handed to it, with the notification sound off.

### `SendOptions` + `EditTransport`: the funnel grows two seams, stays backward-compatible

- `SendOptions { silent?: boolean }` (`outbound.ts:7`) is the provider-neutral delivery-options type.
  `sendSafe` gains it as an **optional 4th argument** (`outbound.ts:61`), so **every** Sprint 1–5 three-arg
  caller compiles and behaves unchanged (`opts` is `undefined` ⇒ no behavior change; evaluator-verified
  against the existing outbound tests). `GrammyTransport.sendMessage` maps `silent` →
  `{ disable_notification: true }`.
- `EditTransport { sendReturningId, editMessage }` (`outbound.ts:42`) is the streaming transport surface,
  defined in `outbound.ts` (**not** `bot.ts`) so `streaming.ts` can import it without a circular
  dependency. `BotTransport` now `extends TelegramTransport, EditTransport` (`bot.ts:69`), and
  `GrammyTransport` gains `sendReturningId` (returns `msg.message_id`, `bot.ts:126`) and `editMessage`
  (`bot.api.editMessageText`, `bot.ts:140`). grammy stays `bot.ts`-only throughout — `streaming.ts`,
  `digest.ts`, and `outbound.ts` import **zero** grammy.

So every outbound path now leaves through one of **four** funnel chokepoints —
`sendSafe` · `sendSafeKeyboard` · `sendSafeForEdit` · `sendSafeEdit` — the seams later sprints extend with
rate-limiting / audit / sanitisation.

---

## Multi-LLM secretary `/fleet` view (Sprint 7)

Sprint 7 adds a **read-only "secretary" view** of the most recent fleet run — what each LLM/agent
produced — surfaced two ways from **one** renderer. It is a **thin read+render adapter**: **no run /
fleet / scheduler logic** is added and **no npm dependency** is introduced (the diff stays inside
`src/telegram/`).

### The renderer: `renderFleetView` (PURE, one section per agent)

`renderFleetView(bundle)` (`src/telegram/fleet-view.ts:67`) is **pure** — no IO, no throw, deterministic.
It reads the head-written `SynthesisBundle { rounds, childResults, findings }` (the on-disk
`.bober/fleet-synthesis.json` shape, from `src/fleet/synthesis.ts`) and returns `string[]`:

- **index `0` is the header** — `Fleet Run — Rounds: <rounds> | Total findings: <n>` — which carries
  `bundle.rounds` (`sc-7-4`);
- **each subsequent element is one agent section**, produced by grouping `bundle.findings` by
  `FactRecord.subject` (the per-agent `childFolder` set at `publish()` in `shared-blackboard.ts`). Each
  section shows the subject (agent label), `Summary:` = the **latest** finding's value collapsed to one
  line, then `Round: <rounds> | Confidence: <c> | Findings: <count>`.

```
Fleet Run — Rounds: 2 | Total findings: 3

grok-child
Summary: anomaly found in Q3 ledger
Round: 2 | Confidence: 0.90 | Findings: 2

deepseek-child
Summary: schema mismatch detected
Round: 2 | Confidence: 0.70 | Findings: 1
```

**The round comes from `bundle.rounds`** (the run-level count) for both the header and every section —
`FactRecord` has **no `round` field** (round is dropped at `publish()`), so `finding.round` is never
referenced. "Latest" within a group = max `tCreated` (ISO-8601 strings sort lexicographically). An empty
`findings` array returns `[header]` only.

### Type-only imports: zero runtime coupling to `src/fleet` / `better-sqlite3`

`SynthesisBundle` (from `../fleet/synthesis.js`) and `FactRecord` (from `../state/facts.js`) are imported
with `import type` and **erased at compile**. The evaluator confirmed the compiled
`dist/telegram/fleet-view.js` has **zero** runtime references to `fleet/synthesis`, `state/facts`, or
`better-sqlite3` — so the bot process never drags `better-sqlite3` in through the fleet view. The shape of
`fleet-synthesis.json` is the on-disk contract; the adapter reads the JSON artifact, never the live
blackboard.

### The `/fleet` command: whitelist-gated before any read

`handleFleet(senderId, allowed, reader?)` (`src/telegram/fleet-view.ts:115`) returns a plain string for the
caller to pass through `sendSafe` (no transport access). The sequence:

1. **Whitelist gate FIRST.** A non-whitelisted sender gets `denialReply(senderId)` and the injected reader
   is **never called** (`sc-7-6`) — no synthesis file is read for a denied sender.
2. **Read the bundle** via the injected `SynthesisReader` (`fleet-view.ts:30`, default
   `defaultSynthesisReader`).
3. **Absent or empty** (`null` or zero findings) ⇒ a friendly
   `No recent fleet run. Run a fleet command with --blackboard to see per-agent findings here.` — **never a
   throw** (`sc-7-3`).
4. **Non-empty** ⇒ `renderFleetView(bundle).join("\n\n")`.

`defaultSynthesisReader` (`fleet-view.ts:40`) reads `<projectRoot>/.bober/fleet-synthesis.json` via
`node:fs/promises` + `JSON.parse`, returning `null` on `ENOENT` **or** parse failure (a non-blackboard run
leaves the file absent by design). Because the reader is injected, the handler is unit-testable with a fake
that drives fixtures or asserts it is never called — no disk, no SDK, no network. `startPollLoop` gains an
**optional 7th** `fleetReader` param (default `defaultSynthesisReader`), so all existing callers compile
unchanged.

### One renderer feeds both `/fleet` and streaming

`streamFleetView(transport, chatId, bundle)` (`src/telegram/streaming.ts:55`) streams the per-agent
sections as in-place edits to **one** message. It calls the **same** `renderFleetView` to produce the
sections, then feeds them into `streamProgress` via an **accumulating** async generator (each yield appends
the next section, so the message grows from header to full summary in place). Because both surfaces share
the renderer, the **one-line truncation** baked into `renderFleetView` (`oneLine()`, `MAX_LINE_LENGTH =
120`) applies to **both** — a verbatim / over-long finding value is collapsed to its first line and capped,
so it **never reaches the transport** via either `/fleet` or the streaming path (`sc-7-5`). All output
still leaves through the `sendSafe` funnel.

---

## SDK isolation: `grammy` behind the transport wrapper

The chosen Telegram Bot API library is **[grammy](https://grammy.dev) (`^1.44.0`)** — the one
new dependency this plan adds. It is TypeScript-native ESM (no separate `@types` package). It
is kept **behind the transport wrapper**, exactly like the LLM `providers/` adapters
(`.bober/principles.md:28`):

- `TelegramTransport` (`outbound.ts`) — outbound interface (`sendMessage`).
- `BotTransport` (`bot.ts`) — `TelegramTransport` + `EditTransport` + `getUpdates(offset)` +
  `sendKeyboard(chatId, text, keyboard)` + `answerCallback(callbackQueryId, text?)` (Sprint 4) +
  `downloadDocument` (Sprint 5); the Sprint 6 `EditTransport` adds `sendReturningId` / `editMessage`
  for the streaming funnel. The loop depends on this.
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
| `src/telegram/outbound.ts` | `TelegramTransport` / `KeyboardTransport` / `EditTransport` interfaces + `SendOptions{silent?}` + the **four** outbound funnel chokepoints: `sendSafe` (text; optional 4th `opts` arg) · `sendSafeKeyboard` (inline keyboards) · `sendSafeForEdit` (the one streaming send, returns the `message_id`) · `sendSafeEdit` (in-place edits). `KeyboardTransport`/`EditTransport` live here to avoid a circular import to `bot.ts`. |
| `src/telegram/streaming.ts` | `streamProgress(transport, chatId, updates, opts?)` — Sprint 6 streaming sender: one `sendSafeForEdit` (initial header, default `"Working…"`) + N `sendSafeEdit` on the **same** message id, consuming an injected `AsyncIterable<string>` (no run logic, never a new message per tick). Sprint 7 adds `streamFleetView(transport, chatId, bundle)` — streams the per-agent fleet sections via the **shared** `renderFleetView` fed into `streamProgress` (accumulating generator). No grammy. |
| `src/telegram/fleet-view.ts` | Sprint 7 read-only secretary `/fleet` view: PURE `renderFleetView(bundle)` (groups `bundle.findings` by `FactRecord.subject` → header w/ `bundle.rounds` + one section/agent: label + one-line summary + round + confidence + count; round from `bundle.rounds` — `FactRecord` has no round) + `handleFleet(senderId, allowed, reader?)` (whitelist-FIRST → `denialReply`, reader never called; null/empty ⇒ "no recent fleet run", never throws; else `renderFleetView(...).join`) + injected `SynthesisReader` type + production `defaultSynthesisReader` (reads `.bober/fleet-synthesis.json` via `node:fs/promises`, `null` on ENOENT/parse-fail). `SynthesisBundle`/`FactRecord` are **type-only** imports — `dist/telegram/fleet-view.js` has zero runtime coupling to `src/fleet`/`better-sqlite3`. `oneLine()` (`MAX_LINE_LENGTH=120`) truncation. No grammy, no new dep. |
| `src/telegram/digest.ts` | `sendDigest(transport, chatId, text)` — Sprint 6 silent digest sender: `sendSafe` with `{ silent: true }` → `disable_notification`. Content/cadence owned by the research-scheduler, not here. No grammy. |
| `src/telegram/router.ts` | Pure `classify(message)` → `RoutedMessage` (`command` vs `text`) + pure `parseScopeFromCommand(name, args)` → hub `Scope` \| `null` (`/today`/`/priority`/`/decide`). No I/O. |
| `src/telegram/handlers/capture.ts` | `handleCapture` (zero-friction capture via an injected `InboxCapture` sink) + production `defaultCapture` (persists via `captureTask`). |
| `src/telegram/handlers/prioritize.ts` | `handlePrioritize` (numbered ranked list via an injected `HubQuery`, title-only render) + production `defaultPrioritize` (execa → `hub priority`/`hub decide` subprocess; the subprocess owns all LLM calls). |
| `src/telegram/keyboard.ts` | Pure, **zero-grammy** inline-keyboard builder + callback_data codec: `CallbackAction` (`approve`/`adjust`/`reject` + Sprint 5 `confirm`/`cancel`), `InlineKeyboardSpec`, `encodeCallback`/`decodeCallback` (`"<code>:<checkpointId>"`, codes `a`/`j`/`r`/`y`/`n`, ≤ 64 bytes, never truncates), `buildApprovalKeyboard` + `buildUploadKeyboard` (`[Yes][No]`). |
| `src/telegram/handlers/upload.ts` | Per-upload medical-ingest opt-in gate: `registerUpload` (stash + opt-in prompt, **no download**) + `handleUploadCallback` (Yes ⇒ download → injected ingest **once** → count-only reply → temp dir removed in `finally`; No/missing ⇒ ingests nothing; whitelist-first) + ephemeral `PendingUploadState` (`createPendingUploadState`) + injected `DownloadFn`/`MedicalIngest` types + production `defaultMedicalIngest` (execa → `medical import` subprocess; guards stay authoritative there) + `LOCAL_INGEST_DEST`/`buildUploadPrompt`. No grammy. |
| `src/telegram/handlers/approvals.ts` | `handleApprovalCallback` (whitelist-first + `pendingExists` guard chain → `saveApproved`/`saveRejected`, **byte-identical markers**) + `handleApprovalFollowup` (resolves a stashed Adjust/Reject from the next text turn) + ephemeral `PendingCallbackState` map (`createPendingState`). No grammy, no new approval mechanism. |
| `src/telegram/bot.ts` | `BotTransport` (`sendKeyboard`/`answerCallback` + Sprint 5 `downloadDocument` + Sprint 6 `EditTransport`: `sendReturningId`/`editMessage`) + `GrammyTransport` adapter (sole grammy import; `toGrammyKeyboard` + `downloadDocument` via `getFile`+`fetch` + `sendMessage` `silent`→`disable_notification` mapping + `editMessageText` here only), `helpReply` stub (Sprint 7 adds the `/fleet` line), and the `startPollLoop` getUpdates loop (callback_query branch decodes-first → upload vs approvals; document branch → `registerUpload`; `classify` → capture / prioritize / `/pending` / `/fleet` → `handleFleet` / command dispatch). Sprint 7 adds an optional 7th `fleetReader = defaultSynthesisReader` param. |
| `src/cli/commands/telegram.ts` | `registerTelegramCommand` — the `agent-bober telegram` command (env credential read, SIGINT/SIGTERM shutdown, never-throw). |

User-facing usage lives in [`COMMANDS.md`](../COMMANDS.md) under **Telegram Commands**.

---

## Plan complete (7/7 sprints)

`spec-20260628-telegram-frontend` is **complete** — all 7 sprints passed iteration 1 (zero reworks).
The presentation adapter is the last spec of the knowledge-platform plan: a locally-run Telegram bot
through which a whitelisted operator talks to agent-bober.

### Full command / delivery surface

- **CLI:** `agent-bober telegram` — start the local getUpdates long-polling bot (no server / webhook /
  inbound port; env-only credentials; `SIGINT`/`SIGTERM` stop it cleanly; never throws).
- **Plain text** → zero-friction inbox **capture** (message = task title, no other required field).
- **`/today` · `/priority` · `/decide X vs Y`** → numbered ranked list from the priority hub
  (ephemeral scope, delegated to the hub CLI subprocess, titles only).
- **`/pending`** → inline `[Approve][Adjust][Reject]` over the **existing** disk-marker approval gate
  (byte-identical markers; no new mechanism).
- **Document upload** → medical ingest behind a **mandatory per-upload opt-in** (deferred download,
  count-only reply, guards authoritative in the subprocess).
- **`/fleet`** → read-only secretary view of the most recent fleet run (one section per agent),
  shared with the streaming surface (`streamFleetView`).
- **Outbound delivery:** `streamProgress` (in-place-edit progress) + `sendDigest` (silent scheduled
  digest).

### Safety invariants held across the plan

- **Whitelist is the control-plane boundary** — every command sits behind `isAllowed`; non-whitelisted
  senders get one id-echoing denial and `/fleet` reads nothing for them.
- **One funnel, four chokepoints** — every reply leaves through `sendSafe` / `sendSafeKeyboard` /
  `sendSafeForEdit` / `sendSafeEdit`; no handler sends directly. Raw payloads (PHI, fleet finding
  values) are truncated/summarised at the seam — never sent verbatim.
- **grammy stays `bot.ts`-only** — every other module imports zero grammy; swapping the SDK is a
  `bot.ts`-only change.
- **No runtime coupling leaks in** — the fleet view imports `SynthesisBundle`/`FactRecord` type-only, so
  `better-sqlite3` never reaches the bot process; hub/medical model calls stay in their subprocesses.
- **Telegram is not E2E-encrypted** — the medical-upload and digest paths deliberately carry only
  non-sensitive counts/titles; keep that boundary honest at the `sendSafe` seam.

### Deferred follow-ups (sibling specs / pending wiring)

- **Live do-bridge streaming wire (`sc-6-5` seam).** Wiring a real long-running do-bridge promotion run
  to `streamProgress` is still a **documented seam** at `src/do-bridge/do.ts` (after the promotion gate);
  `streamProgress` / `streamFleetView` are source-agnostic and consume an injected iterable / bundle.
- **Live smoke tests need a real bot token.** The manual criteria (`sc-1-6`, `sc-7-7`, etc.) were not run
  in CI — exercising the live bot end-to-end requires a real `TELEGRAM_BOT_TOKEN`.
- **Tier 2 / Tier 3 deferred to sibling specs.** Tier 2 (per-LLM bot identities / Bot API 10.0
  bot-to-bot) and Tier 3 (Secretary Mode) are out of scope for this plan and tracked separately.
- **Full inbox/calendar action dispatch.** Beyond capture and the hub-query commands, broader
  inbox/calendar action commands remain a future addition — any other `/command` still returns the
  `Unknown command` stub. New reply paths must return content through one of the four funnel chokepoints
  and sit behind the `isAllowed` whitelist.
