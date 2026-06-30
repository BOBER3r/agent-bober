# Document upload → medical ingest with mandatory per-upload opt-in (+ keyboard funnel unification)

**Contract:** sprint-spec-20260628-telegram-frontend-5  ·  **Spec:** spec-20260628-telegram-frontend  ·  **Completed:** 2026-06-30

## What this sprint added

**§A — Document-upload medical opt-in.** A document message from a whitelisted sender now triggers a
**mandatory per-upload Yes/No consent gate** (`src/telegram/handlers/upload.ts`) before any
processing. Because Telegram is **not** end-to-end encrypted, the bot **defers the download entirely**:
`registerUpload` only stashes the `file_id` in an ephemeral in-memory map and replies with a prompt
that **names the local medical ingest destination** (`.bober/medical (local health store)`) and
discloses the non-E2E nature of Telegram — nothing is fetched until the user taps **Yes**. On Yes,
`handleUploadCallback` downloads the file to a temp dir, calls the **existing** `src/medical` ingest
path **exactly once** (default: execa `node <cli> medical import <file>`), replies with a
**non-sensitive integer count only** (`Imported N results into local medical store.` — no PHI / marker
values / names), and **always removes the temp dir in a `finally`**. On **No** or no confirmation,
nothing is downloaded and nothing is ingested. The medical `EgressGuard` / `ConsentGate` / `AuditLog`
stay authoritative **inside the ingest subprocess** — they are **not** duplicated or weakened here
(nonGoal #5).

**§B — Keyboard funnel unification (carry-forward fix from Sprint 4).** `outbound.ts` gains
`sendSafeKeyboard` — the **single** keyboard chokepoint, mirroring `sendSafe` for text.
`transport.sendKeyboard` is now invoked **only** inside `sendSafeKeyboard`; the Sprint-4 `/pending`
approvals keyboard was retrofitted to route through it, and the new upload opt-in keyboard uses it too.
This **closes the seam gap** the Sprint-4 doc noted (keyboards previously bypassed a unified funnel by
calling `transport.sendKeyboard` directly in the poll loop). grammy stays `bot.ts`-only throughout.

## Public surface

### §A — Document upload (`src/telegram/handlers/upload.ts`)

- `registerUpload(args)` (`src/telegram/handlers/upload.ts:92`) — called on a document message from a
  whitelisted sender. **Stashes** `{ fileId, fileName, chatId }` in the ephemeral `PendingUploadState`
  keyed by `uploadId` (the message id) and returns `{ reply }` (the opt-in prompt). **The file is NOT
  downloaded here** — download happens only after an explicit Yes (`sc-5-2`).
- `handleUploadCallback(args)` (`src/telegram/handlers/upload.ts:126`) — handles a Yes (`confirm`) /
  No (`cancel`) tap. Returns `{ reply, answer }` (`reply` → `sendSafe`, `null` = send nothing; `answer`
  dismisses the client spinner). Order: **(1)** whitelist re-check on the callback sender id
  (non-whitelisted ⇒ `{ reply:null, answer:"Denied" }`, ingests nothing); **(2)** `decodeCallback`
  (malformed ⇒ `"Unknown"`); **(3)** consume the stash single-shot (missing ⇒
  `"Upload expired or already handled."`, no ingest); **(4)** **No** ⇒ `"Discarded — nothing was
  ingested."` (no download, no ingest, `sc-5-4`); **(5)** **Yes** ⇒ `mkdtemp` → injected `download`
  → injected `ingest` **exactly once** → reply `Imported <newRows> results into local medical store.`
  (count only, `sc-5-3`/`sc-5-5`), with `rm(dir, { recursive, force })` in a **`finally`** (`nonGoal #4`).
- `buildUploadPrompt(fileName)` (`src/telegram/handlers/upload.ts:77`) — the opt-in prompt shown
  **before** any download. Names `LOCAL_INGEST_DEST` and states Telegram is not end-to-end encrypted so
  consent is informed (`sc-5-5`).
- `LOCAL_INGEST_DEST` (`src/telegram/handlers/upload.ts:70`) — the disclosed local destination string
  (`".bober/medical (local health store)"`), exported as a constant so the handler and its tests assert
  the same text.
- `PendingUpload` / `PendingUploadState` (`src/telegram/handlers/upload.ts:56`) —
  `Map<uploadId, { fileId, fileName, chatId }>`: the **ephemeral, in-memory** stash of pending upload
  confirmations. **No disk persistence** — cleared on bot restart (mirrors `PendingCallbackState`).
- `createPendingUploadState()` (`src/telegram/handlers/upload.ts:59`) — constructs an empty
  `PendingUploadState` (the default for `startPollLoop`'s new 6th param).
- `DownloadFn` (`src/telegram/handlers/upload.ts:37`) / `MedicalIngest`
  (`src/telegram/handlers/upload.ts:45`) — the **injected** dependency types
  (`(fileId, destPath) => Promise<void>` and `(filePath) => Promise<{ recordsParsed, newRows }>`) so
  tests use spies with no network, no disk, no real medical pipeline.
- `defaultMedicalIngest(filePath)` (`src/telegram/handlers/upload.ts:190`) — production `MedicalIngest`.
  Invokes `node <cliEntry> medical import <filePath>` via `execa` in the project root (`reject:false`),
  **throws** on a non-zero exit, and parses the non-sensitive `records parsed:` / `new rows:` counts
  from stdout (format per `src/cli/commands/medical.ts`). The subprocess runs the full medical pipeline
  with all guardrails — mirrors `defaultPrioritize`.

### Keyboard codec + builder (`src/telegram/keyboard.ts`)

- `CallbackAction` (`src/telegram/keyboard.ts:18`) — extended to
  `"approve" | "adjust" | "reject" | "confirm" | "cancel"`; the codec gains `confirm`→`y` / `cancel`→`n`
  (the existing `a`/`j`/`r` codec and approval tests are **unchanged**).
- `buildUploadKeyboard(uploadId)` (`src/telegram/keyboard.ts:87`) — one-row `[Yes][No]`
  `InlineKeyboardSpec`; `uploadId` is the (short) message-id string, well within the 64-byte
  `callback_data` budget.

### Transport extension (`src/telegram/bot.ts`)

- `BotTransport.downloadDocument(fileId, destPath)` (`src/telegram/bot.ts:79`, impl `:150`) — downloads
  a Telegram file. `GrammyTransport` resolves the path via `bot.api.getFile`, fetches the Telegram file
  endpoint, and writes bytes via `node:fs/promises` — **no `@grammyjs/files` plugin**, and grammy stays
  isolated to `bot.ts`.
- `TelegramUpdate.message.document` (`src/telegram/bot.ts`) — minimal local `{ file_id, file_name?,
  mime_type? }` subset so grammy's generated `Document` type never leaks.
- `startPollLoop(transport, signal, capture?, prioritize?, pending?, uploads = createPendingUploadState())`
  — gains an **optional** 6th parameter (the pending-upload state) so the loop is testable with an
  injected map; existing callers (`telegram.ts:50`) compile unchanged. The callback_query branch
  **decodes first** and routes `confirm`/`cancel` → `handleUploadCallback`, `a`/`j`/`r` →
  `handleApprovalCallback`; a document message branch runs **before** the text branch.

### §B — Unified keyboard funnel (`src/telegram/outbound.ts`)

- `sendSafeKeyboard(transport, chatId, content, keyboard)` (`src/telegram/outbound.ts:56`) — the
  **single** keyboard chokepoint, the **only** place `transport.sendKeyboard` is invoked. Both the
  upload opt-in keyboard and the `/pending` approvals keyboard now route through it. Plain passthrough
  today; the seam where later sprints add keyboard-message filtering / audit / rate-limiting.
- `KeyboardTransport` (`src/telegram/outbound.ts:23`) — a minimal `{ sendKeyboard }` interface defined
  in `outbound.ts` so `sendSafeKeyboard` lives there **without importing from `bot.ts`** (which would
  create a circular dependency — `bot.ts` already imports from `outbound.ts`). `BotTransport` satisfies
  it structurally.

## How to use / how it fits

Run the bot as before (`agent-bober telegram`, credentials from env). From a whitelisted account:

```
upload a lab PDF     → bot replies with the opt-in prompt (names .bober/medical, warns non-E2E) + [Yes][No]
tap Yes              → bot downloads → runs `medical import` → replies "Imported N results into local medical store."
tap No               → bot replies "Discarded — nothing was ingested." (no download, no ingest)
no tap               → nothing is downloaded or ingested
```

The ingest path is the **existing** `src/medical` pipeline (`agent-bober medical import`) invoked in a
subprocess — the adapter does **not** reimplement parsing/storage and does **not** duplicate the
medical guardrails. The post-ingest reply carries a **count only**; no marker values or names leave
through Telegram. Every text reply still leaves through `sendSafe`; every keyboard message now leaves
through `sendSafeKeyboard` — the two unified outbound chokepoints.

## Notes for maintainers

- **Download is deferred until Yes — by design.** The whole point of the gate is that **no document
  bytes are fetched** before informed consent. `registerUpload` must never download; only
  `handleUploadCallback`'s Yes branch does (`sc-5-2`/`sc-5-4`). Keep that ordering.
- **Count-only replies — no PHI.** The post-ingest reply is an **integer count** parsed from the
  subprocess stdout. **Never** echo marker values, names, or other raw PHI back through Telegram
  (`nonGoal #3`, `sc-5-5`). The actual reply string is
  `Imported <newRows> results into local medical store.`.
- **Temp file always removed.** The temp dir is removed in a `finally` so **no PHI bytes remain on disk**
  after ingest, even if download or ingest throws (`nonGoal #4`).
- **Guardrails stay authoritative in the subprocess.** `EgressGuard` / `ConsentGate` / `AuditLog` run
  inside the `medical import` child process — they are **not** duplicated, bypassed, or weakened here
  (`nonGoal #5`). Do not add a parallel medical code path in `src/telegram/`.
- **Whitelist guard fires first on the callback.** A `confirm`/`cancel` tap from a non-whitelisted
  account ingests nothing — the whitelist re-check runs before the stash lookup (mirrors the Sprint-4
  approvals guard).
- **Ephemeral, single-process upload state.** `PendingUploadState` is an in-process `Map` keyed by
  upload (message) id — no disk, cleared on restart, consumed single-shot so a duplicate tap is a no-op.
  A `bober:` note flags moving it to a shared key-value store only if the bot ever runs across multiple
  processes.
- **§B closes the Sprint-4 funnel seam.** Sprint 4 sent the `/pending` keyboard via
  `transport.sendKeyboard` directly in the poll loop (the doc noted this seam gap). Sprint 5 makes
  `sendSafeKeyboard` the **sole** `transport.sendKeyboard` caller; the loop and handlers must route all
  keyboard sends through it. `KeyboardTransport` exists only to keep that function in `outbound.ts`
  without a circular import.
- **grammy stays `bot.ts`-only.** `upload.ts`, `keyboard.ts`, and `outbound.ts` import **zero** grammy;
  `downloadDocument` (the new grammy surface) lives on `GrammyTransport` in `bot.ts`. Swapping the SDK
  remains a `bot.ts`-only change.
- **Default ingest counts.** `defaultMedicalIngest` returns `{ recordsParsed, newRows }`; the reply uses
  `newRows`. If the medical CLI's stdout `records parsed:` / `new rows:` format changes, update the
  regexes here (they default to `0` on no match rather than throwing).

Commit: `e7a2aa4` — *bober(sprint-5): document upload opt-in gate + keyboard funnel unification*
(8 files, +718/-29; **no** new dependency). Build/typecheck 0 errors; full suite **3667** green
(**+17 tests**: upload handler + keyboard/outbound additions). All 5 required criteria
(`sc-5-1`..`sc-5-5`) passed iteration 1 (no-confirm/No ⇒ zero ingest + temp dir removed; Yes ⇒ exactly
one ingest with the downloaded file; prompt names the destination + non-E2E before confirm; count-only
reply; funnel unification + grammy isolation evaluator-verified); the manual `sc-5-6` (live lab-PDF
upload against the running bot) was not run in CI. No regressions (Sprint-4 approvals/keyboard suites
green).
