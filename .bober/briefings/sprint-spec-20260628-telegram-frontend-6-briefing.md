# Sprint Briefing: Streaming run progress (in-place edits) + silent scheduled digest delivery

**Contract:** sprint-spec-20260628-telegram-frontend-6
**Generated:** 2026-06-30T00:00:00Z

> Scope: PURE presentation. Two new outbound delivery modes over the unified sendSafe funnel — (a) STREAMING (one send + N edits on the SAME message id) and (b) SILENT DIGEST (`disable_notification`). NO run/fleet/scheduler logic. Diff must stay inside `src/telegram/`. Whitelist + funnel discipline preserved.

---

## 1. Target Files

### src/telegram/outbound.ts (modify) — extend the funnel, keep the single chokepoint

**Current shapes (FULL file is 64 lines — quoted verbatim, the parts you extend):**

`TelegramTransport` interface — `outbound.ts:12-15`:
```ts
export interface TelegramTransport {
  /** Send a plain-text message to the given Telegram chat id. */
  sendMessage(chatId: number, text: string): Promise<void>;
}
```

`KeyboardTransport` interface — `outbound.ts:23-25`:
```ts
export interface KeyboardTransport {
  sendKeyboard(chatId: number, text: string, keyboard: InlineKeyboardSpec): Promise<void>;
}
```

`sendSafe` (the text chokepoint) — `outbound.ts:38-44`:
```ts
export async function sendSafe(
  transport: TelegramTransport,
  chatId: number,
  content: string,
): Promise<void> {
  await transport.sendMessage(chatId, content);
}
```

`sendSafeKeyboard` (the keyboard chokepoint, §B) — `outbound.ts:56-63`:
```ts
export async function sendSafeKeyboard(
  transport: KeyboardTransport,
  chatId: number,
  content: string,
  keyboard: InlineKeyboardSpec,
): Promise<void> {
  await transport.sendKeyboard(chatId, content, keyboard);
}
```

**RECOMMENDED minimal extension (keeps Sprints 1-5 byte-compatible, preserves single chokepoint):**

1. Add a neutral delivery-options type + thread it through `sendSafe` as an OPTIONAL 4th arg:
```ts
/** Provider-neutral outbound options. `silent` maps to Telegram's disable_notification in GrammyTransport. */
export interface SendOptions { silent?: boolean }

// widen TelegramTransport.sendMessage with an OPTIONAL opts param (backward-compatible:
// a 2-arg impl like GrammyTransport.sendMessage still satisfies a (a,b,opts?) interface
// because TS allows fewer-param functions to be assignable to more-param types):
export interface TelegramTransport {
  sendMessage(chatId: number, text: string, opts?: SendOptions): Promise<void>;
}

export async function sendSafe(
  transport: TelegramTransport,
  chatId: number,
  content: string,
  opts?: SendOptions,          // NEW — undefined for all existing callers => no behavior change
): Promise<void> {
  await transport.sendMessage(chatId, content, opts);
}
```
2. Add the in-place-edit chokepoints (a SEPARATE transport surface so `sendSafe`'s void contract is untouched):
```ts
/** Transport surface used ONLY by the streaming sender. Kept here (not bot.ts) to avoid a cycle. */
export interface EditTransport {
  /** Send and return the new message id so the streamer can edit it in place. */
  sendReturningId(chatId: number, text: string, opts?: SendOptions): Promise<number>;
  /** Edit an existing message in place (no new message). */
  editMessage(chatId: number, messageId: number, text: string): Promise<void>;
}

/** The ONLY place sendReturningId is invoked — funnel for the initial streaming send. */
export async function sendSafeForEdit(
  transport: EditTransport, chatId: number, content: string, opts?: SendOptions,
): Promise<number> {
  return transport.sendReturningId(chatId, content, opts);
}

/** The ONLY place editMessage is invoked — funnel for every in-place progress edit. */
export async function sendSafeEdit(
  transport: EditTransport, chatId: number, messageId: number, content: string,
): Promise<void> {
  await transport.editMessage(chatId, messageId, content);
}
```
**Rule:** `streaming.ts` and `digest.ts` MUST call these four funnel functions only — never `transport.sendMessage/editMessage` directly. This is the same discipline the poll loop already obeys (`bot.ts:253,269,289,333,353,368` always go through `sendSafe`/`sendSafeKeyboard`).

**Imports this file uses:** `import type { InlineKeyboardSpec } from "./keyboard.js"` (`outbound.ts:2`).
**Imported by:** `src/telegram/bot.ts:11-12` (`TelegramTransport` type + `sendSafe`/`sendSafeKeyboard`), `src/telegram/outbound.test.ts:9-10`. New importers: `streaming.ts`, `digest.ts`.
**Test file:** `src/telegram/outbound.test.ts` (exists).

---

### src/telegram/bot.ts (modify) — give BotTransport + GrammyTransport the new methods

**Current `BotTransport` interface — `bot.ts:68-80`:**
```ts
export interface BotTransport extends TelegramTransport {
  getUpdates(offset: number): Promise<TelegramUpdate[]>;
  sendKeyboard(chatId: number, text: string, keyboard: InlineKeyboardSpec): Promise<void>;
  answerCallback(callbackQueryId: string, text?: string): Promise<void>;
  downloadDocument(fileId: string, destPath: string): Promise<void>;
}
```

**Current `GrammyTransport` methods (this is the ONLY file that imports grammy — `bot.ts:9`):**
- `sendMessage` — `bot.ts:111-113`: `await this.bot.api.sendMessage(chatId, text)` (returns `void` today)
- `sendKeyboard` — `bot.ts:119-123`: `this.bot.api.sendMessage(chatId, text, { reply_markup })`
- `answerCallback` — `bot.ts:129-131`
- `getUpdates` — `bot.ts:138-142`
- `downloadDocument` — `bot.ts:150-161`

**What BotTransport must GAIN for Sprint 6** — extend it to also satisfy `EditTransport` and accept silent on send:
```ts
export interface BotTransport extends TelegramTransport, EditTransport {
  // ...existing members unchanged...
}
```
**GrammyTransport additions (silent mapping + id-returning send + edit):**
```ts
// widen the existing sendMessage to honour silent (bot.ts:111-113):
async sendMessage(chatId: number, text: string, opts?: SendOptions): Promise<void> {
  await this.bot.api.sendMessage(chatId, text, opts?.silent ? { disable_notification: true } : undefined);
}

// NEW — initial streaming send that returns the message id:
async sendReturningId(chatId: number, text: string, opts?: SendOptions): Promise<number> {
  const msg = await this.bot.api.sendMessage(
    chatId, text, opts?.silent ? { disable_notification: true } : undefined,
  );
  return msg.message_id;   // Message.TextMessage.message_id — see grammy refs below
}

// NEW — in-place edit:
async editMessage(chatId: number, messageId: number, text: string): Promise<void> {
  await this.bot.api.editMessageText(chatId, messageId, text);
}
```

**grammy API evidence (so the wrappers are exact):**
- `sendMessage(chat_id, text, other?, signal?): Promise<Message.TextMessage>` — `node_modules/grammy/out/core/api.d.ts:156`. **It RETURNS the sent message** (today's wrapper discards it → that is why a new `sendReturningId` is needed; `sendSafe`/`sendMessage` keep their void contract).
- `disable_notification?: boolean` lives on the sendMessage `Other` options — `node_modules/@grammyjs/types/methods.d.ts:98` ("Sends the message silently. Users will receive a notification with no sound."). The full sendMessage arg object is `methods.d.ts:80-104`.
- `Message.TextMessage` carries `message_id: number` — `node_modules/@grammyjs/types/message.d.ts:11`.
- `editMessageText(chat_id, message_id, text, other?, signal?): Promise<true | <edited Message>>` — `node_modules/grammy/out/core/api.d.ts:1319-1325`. Streaming does not need its return; it reuses the id from the initial `sendReturningId`.

**Imported by:** `src/cli/commands/telegram.ts:5` (constructs `GrammyTransport`, runs `startPollLoop` at `telegram.ts:36,50`), `src/telegram/outbound.test.ts:11-12`.
**Test file:** no dedicated `bot.test.ts`; the loop/transport is exercised via `outbound.test.ts:108-218`.

---

### src/telegram/streaming.ts (create)

**Directory pattern:** `src/telegram/*.ts` are kebab-free single-word modules with a top `/** file — purpose */` banner (see `outbound.ts:1`, `bot.ts:1-5`, `router.ts`, `whitelist.ts`). Named exports only, `.js` ESM import suffixes, `import type` for types.
**Most similar existing file:** `src/telegram/digest.ts` (its sibling, also created this sprint) and `src/do-bridge/launcher.ts` for the DI-port style.
**Structure template:**
```ts
/** streaming.ts — Stream long-running progress as in-place edits to ONE Telegram message. */
import { sendSafeForEdit, sendSafeEdit } from "./outbound.js";
import type { EditTransport } from "./outbound.js";

/**
 * Send an initial status message, then edit THAT SAME message id for each update.
 * One send + N edits (never a new message per tick). `updates` is injected so tests
 * drive a fixed sequence; the real path passes an async iterable tailing run progress
 * (NO run logic added here). The final update is the summary ("final edit = summary").
 */
export async function streamProgress(
  transport: EditTransport,
  chatId: number,
  updates: AsyncIterable<string>,
  opts?: { header?: string },
): Promise<void> {
  const header = opts?.header ?? "Working…";
  const messageId = await sendSafeForEdit(transport, chatId, header); // 1 send
  for await (const text of updates) {
    await sendSafeEdit(transport, chatId, messageId, text);           // N edits, SAME id
  }
}
```
**sc-6-2 guarantee:** the initial header is the single `send`; every update is an `edit` on the captured id, so N>=2 updates => 1 send + >=2 edits. (Do NOT make the first update the send — that yields only N-1 edits and fails sc-6-2 at N=2.) `AsyncIterable<string>` precedent exists at `src/medical/adapters/apple-health.ts:83-85` (`for await (const chunk of stream)`).

---

### src/telegram/digest.ts (create)

**Most similar existing file:** `src/telegram/streaming.ts` (sibling) + `sendSafe` usage everywhere in `bot.ts`.
**Structure template:**
```ts
/** digest.ts — Deliver a scheduler-handed digest payload silently (no notification sound). */
import { sendSafe } from "./outbound.js";
import type { TelegramTransport } from "./outbound.js";

/**
 * Send a plain digest summary with notifications silenced. The payload text is handed in
 * by the scheduler owner (this adapter does NOT decide content or cadence). Routes through
 * the sendSafe funnel with silent:true => GrammyTransport maps it to disable_notification.
 */
export async function sendDigest(
  transport: TelegramTransport,
  chatId: number,
  text: string,
): Promise<void> {
  await sendSafe(transport, chatId, text, { silent: true });
}
```
**Note (digest payload source):** the scheduler's digest text comes from the research-scheduler — `src/research/digest.ts:63 renderDigestMarkdown(digest): string` returns plain markdown. Sprint 6 only RECEIVES that string; do not import or re-derive it (out of scope). Different directory → no name collision with `src/telegram/digest.ts`.

---

## 2. Patterns to Follow

### Single outbound chokepoint (the load-bearing invariant)
**Source:** `src/telegram/outbound.ts:29-44` and the loop callers `bot.ts:253,269,289,333,353,377`.
```ts
// handlers return a string; ONLY sendSafe touches transport.sendMessage:
await sendSafe(transport, cbChatId, reply);
// §B keyboard equivalent:
await sendSafeKeyboard(transport, chatId, reply, buildUploadKeyboard(uploadId));
```
**Rule:** add new funnels (`sendSafeForEdit`/`sendSafeEdit`) rather than calling the transport from `streaming.ts`/`digest.ts`. The funnel functions are the ONLY callers of the transport methods.

### Provider-neutral transport (grammy never leaks)
**Source:** `bot.ts:1-5` ("This is the ONLY file that imports grammy") + `bot.ts:33-58` (local `TelegramUpdate` subset) + principles.md:28 (cited in `bot.ts:39`).
**Rule:** keep the funnel/interface option neutral (`silent`); only `GrammyTransport` (in `bot.ts`) translates `silent` → grammy's `disable_notification`, and only `bot.ts` calls `bot.api.editMessageText`.

### Optional-param back-compat extension
**Source:** `bot.ts:199-206` (`startPollLoop` added capture/prioritize/pending/uploads as defaulted params so `telegram.ts:50` callers compile unchanged; note at `bot.ts:193-194`).
**Rule:** every Sprint-6 signature change is an OPTIONAL trailing param (`opts?`) so Sprints 1-5 callers/impls stay byte-compatible.

### Injected-dependency DI (so tests need no SDK/network)
**Source:** `src/do-bridge/launcher.ts:19-22` (`Launcher` port) + `handlers/upload.ts` `DownloadFn`/`MedicalIngest` injected fns.
**Rule:** `streamProgress` takes the progress source as an injected `AsyncIterable<string>`; `sendDigest`/`streamProgress` take the transport as a param. No globals, no `process`-level run reads in these two files.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---|---|---|---|
| `sendSafe` | `src/telegram/outbound.ts:38` | `(transport, chatId, content, opts?) => Promise<void>` | Text chokepoint — extend with `opts.silent`; both new senders route through it (sc-6-4). |
| `sendSafeKeyboard` | `src/telegram/outbound.ts:56` | `(transport, chatId, content, keyboard) => Promise<void>` | Keyboard chokepoint (§B) — leave untouched; reference only. |
| `GrammyTransport` | `src/telegram/bot.ts:103` | `class implements BotTransport` | Sole grammy consumer — add `sendReturningId`/`editMessage`, widen `sendMessage`. |
| `runPromotionGate` | `src/do-bridge/promote.ts:66` | `(args: PromotionGateArgs) => Promise<GateOutcome>` | Sprint-4 do-bridge approve/reject gate; streaming wires AFTER it approves. |
| `Launcher.launch` | `src/do-bridge/launcher.ts:21` | `(plan) => Promise<{ runId; pid? }>` | Returns the `runId` to tail for progress at the wiring seam. |
| `CompletionTailer` | `src/chat/completion-tailer.ts:97` | `class` (reads history.jsonl markers) | Existing READ-ONLY run-progress signal; tail it for the real path (do NOT add run logic). |
| roster `state.json` `progress` | `src/chat/run-spawner.ts:106` | `{ completed, total }` | Existing per-run progress field a real tailer could read. |
| `renderDigestMarkdown` | `src/research/digest.ts:63` | `(digest) => string` | Scheduler's digest text source (input only; out of scope to build). |

Utilities reviewed: `src/utils/`, `src/state/`, `src/telegram/` — no existing streaming/edit/silent helper exists (`ls src/telegram` shows no `streaming.ts`/`digest.ts`); create fresh.

---

## 4. Prior Sprint Output

### Sprint 1: Telegram transport + funnel + poll loop
**Created:** `src/telegram/outbound.ts` (`sendSafe`, `TelegramTransport`), `src/telegram/bot.ts` (`BotTransport`, `GrammyTransport`, `startPollLoop`).
**Connection:** Sprint 6 extends `TelegramTransport.sendMessage` with `opts?`, adds `EditTransport`, and adds `GrammyTransport.sendReturningId`/`editMessage`.

### Sprint 5 (§B): unified keyboard funnel
**Created/modified:** `src/telegram/outbound.ts` `sendSafeKeyboard` (`outbound.ts:56`) — the keyboard chokepoint; loop uses it at `bot.ts:308,368`.
**Connection:** Sprint 6 mirrors this discipline — every new outbound path is a `sendSafe*` funnel function; no direct transport calls in `streaming.ts`/`digest.ts`.

### Sprint 4: do-bridge promotion gate
**Created:** `src/do-bridge/promote.ts` `runPromotionGate` (`promote.ts:66`), consumed by `src/cli/commands/do.ts:160`.
**Connection:** the manual streaming path (sc-6-5) is wired AFTER the gate approves and `launcher.launch` returns a `runId` (`do.ts:180`).

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- `principles.md:19` — ESLint `consistent-type-imports` enforced, `no-explicit-any` warned, unused vars errored. Zero lint errors is a hard gate.
- `principles.md:27` — **ESM everywhere**; all imports use `.js` extensions (NodeNext). Matches generatorNotes ("ESM .js imports").
- `principles.md:35` — use `import type { ... }` for type-only imports.
- `principles.md:40` — no `any` (use `unknown` + narrowing). generatorNotes: "no any".
- `principles.md:28` (cited in `bot.ts:39`) — provider-agnostic: grammy types must not leak outside `bot.ts`.

### Architecture Decisions
No `.bober/architecture/` ADR specific to the Telegram frontend was found relevant to this sprint (the dir holds fleet/heterogeneous-team ADRs). The governing rule is the provider-agnostic + single-chokepoint convention documented inline in `outbound.ts:6-26` and `bot.ts:1-9`.

### Other Docs
generatorNotes/evaluatorNotes in the contract are load-bearing: "extend the funnel to accept delivery options like silent/edit-target rather than calling the transport directly"; "diff stays within `src/telegram/`"; "node:fs/promises only" (only relevant if a real tailer is added — keep it injected instead).

---

## 6. Testing Patterns

### Unit Test Pattern
**Source:** `src/telegram/outbound.test.ts:15-39` (spy factories) + `src/telegram/handlers/upload.test.ts:24-40` (injected-spy factories).
**Runner:** vitest. **Assertion style:** `expect(...).toMatchObject/toHaveLength/...`. **Mock approach:** hand-rolled duck-typed spy objects (NO `vi.mock`, no SDK). **File naming:** co-located `*.test.ts`. **Location:** co-located beside source.

Existing spy factory (mirror this exact shape) — `outbound.test.ts:18-26`:
```ts
function makeSpy(): TelegramTransport & { calls: Array<{ chatId: number; text: string }> } {
  const calls: Array<{ chatId: number; text: string }> = [];
  return {
    calls,
    async sendMessage(chatId: number, text: string): Promise<void> { calls.push({ chatId, text }); },
  };
}
```

**streaming.test.ts spy + assertions (sc-6-2, sc-6-4):**
```ts
import { describe, it, expect } from "vitest";
import { streamProgress } from "./streaming.js";
import type { EditTransport } from "./outbound.js";

function makeStreamSpy() {
  const sends: Array<{ chatId: number; text: string }> = [];
  const edits: Array<{ chatId: number; messageId: number; text: string }> = [];
  const MSG_ID = 555;
  const transport: EditTransport & { sends: typeof sends; edits: typeof edits } = {
    sends, edits,
    async sendReturningId(chatId, text) { sends.push({ chatId, text }); return MSG_ID; },
    async editMessage(chatId, messageId, text) { edits.push({ chatId, messageId, text }); },
  };
  return transport;
}

async function* seq(items: string[]): AsyncIterable<string> { for (const i of items) yield i; }

it("one send + >=2 edits on the SAME message id for N>=2 updates (sc-6-2)", async () => {
  const spy = makeStreamSpy();
  await streamProgress(spy, 7, seq(["step 1", "step 2", "done — summary"]));
  expect(spy.sends).toHaveLength(1);                 // exactly one send
  expect(spy.edits.length).toBeGreaterThanOrEqual(2);// in-place edits, not new messages
  expect(spy.edits.every((e) => e.messageId === 555)).toBe(true); // SAME id
});
```

**digest.test.ts spy + assertions (sc-6-3, sc-6-4):** the spy's `sendMessage` records `opts` so the silent flag is observable.
```ts
import { sendDigest } from "./digest.js";
import type { TelegramTransport, SendOptions } from "./outbound.js";

function makeDigestSpy() {
  const calls: Array<{ chatId: number; text: string; opts?: SendOptions }> = [];
  const transport: TelegramTransport & { calls: typeof calls } = {
    calls,
    async sendMessage(chatId, text, opts) { calls.push({ chatId, text, opts }); },
  };
  return transport;
}

it("sendDigest routes through sendSafe with silent:true => disable_notification (sc-6-3/sc-6-4)", async () => {
  const spy = makeDigestSpy();
  await sendDigest(spy, 7, "Morning digest: 3 new findings");
  expect(spy.calls).toHaveLength(1);                 // exactly one send via the funnel
  expect(spy.calls[0]?.opts?.silent).toBe(true);     // silenced
});
```
> sc-6-4 ("both route through sendSafe") is satisfied structurally: `digest.ts` imports `sendSafe`, `streaming.ts` imports `sendSafeForEdit`/`sendSafeEdit`; the spies record only the transport methods those funnels wrap, so a recorded call IS a funnel call. `silent` is the neutral funnel flag; `GrammyTransport.sendMessage` (bot.ts) maps it to grammy's `disable_notification` — the literal `disable_notification` token appears in the bot.ts diff the evaluator reads.

### E2E Test Pattern
Not applicable — this repo has no Playwright config; the Telegram surface is verified entirely with injected-transport vitest unit tests. sc-6-5 is a manual check (required:false).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|---|---|---|---|
| `src/telegram/bot.ts` | `outbound.ts` (`TelegramTransport`, `sendSafe`, `sendSafeKeyboard`) | medium | Widening `sendMessage` with `opts?` must keep `GrammyTransport` + the loop compiling; existing 2-arg calls unchanged. |
| `src/cli/commands/telegram.ts` | `bot.ts` (`GrammyTransport`, `startPollLoop`) | low | Constructs `GrammyTransport` (`telegram.ts:36`); new methods are additive — must still compile. |
| `src/telegram/outbound.test.ts` | `outbound.ts`, `bot.ts` | low | Existing spies use 2-arg `sendMessage`; optional `opts?` keeps them valid (TS allows fewer-arg impls). Must stay green. |
| `src/cli/commands/do.ts` | `do-bridge/promote.ts`, `launcher.ts` | low | Only touched if you add the OPTIONAL streaming wire at `do.ts:180`; default path must stay byte-identical. |

### Existing Tests That Must Still Pass
- `src/telegram/outbound.test.ts` — covers `sendSafe`/`sendSafeKeyboard` (`:43-106`) and the poll-loop funnel invariant (`:135-218`). The `opts?` widening and new funnels must not change its assertions. **Highest-priority regression guard.**
- `src/telegram/handlers/upload.test.ts`, `approvals.test.ts`, `prioritize.test.ts`, `capture.test.ts`, `keyboard.test.ts`, `router.test.ts`, `whitelist.test.ts` — unrelated but in-module; run them to confirm no `src/telegram/` breakage.
- `src/do-bridge/promote.test.ts`, `launcher.test.ts` — only relevant if you wire `do.ts`; must stay green (gate behavior unchanged).

### Features That Could Be Affected
- **Keyboard funnel (§B, Sprint 5)** — shares `outbound.ts`; verify `sendSafeKeyboard` and its single-chokepoint tests are untouched.
- **Poll loop (Sprint 1)** — shares `bot.ts`/`BotTransport`; verify `startPollLoop` still type-checks against the extended `BotTransport`.

### Recommended Regression Checks
1. `npm run build` (tsc) — zero errors (sc-6-1).
2. `npx vitest run src/telegram` — all telegram unit tests pass, including new `streaming.test.ts` + `digest.test.ts` (sc-6-2/6-3/6-4).
3. `npx vitest run src/do-bridge` — gate/launcher tests green (only if `do.ts` touched).
4. `npm run lint` — `consistent-type-imports`, no `any`, no unused vars (principles.md:19,35,40).
5. `git diff --name-only` — confirm changes are confined to `src/telegram/` (+ at most an optional minimal `src/cli/commands/do.ts` wire); NO run/fleet/scheduler files touched (evaluatorNotes).

---

## 8. Implementation Sequence (dependency-ordered)

1. **`src/telegram/outbound.ts`** — add `SendOptions`; widen `TelegramTransport.sendMessage` + `sendSafe` with optional `opts?`; add `EditTransport` + `sendSafeForEdit` + `sendSafeEdit`.
   - Verify: `npm run build` still passes; `outbound.test.ts` unchanged and green.
2. **`src/telegram/bot.ts`** — extend `BotTransport` to also `extends EditTransport`; widen `GrammyTransport.sendMessage` to forward `silent`→`disable_notification`; add `sendReturningId` (returns `msg.message_id`) + `editMessage` (calls `bot.api.editMessageText`).
   - Verify: `tsc` clean; `telegram.ts` + `outbound.test.ts` still compile.
3. **`src/telegram/streaming.ts`** + **`streaming.test.ts`** — implement `streamProgress` (1 send via `sendSafeForEdit` + edits via `sendSafeEdit`); test asserts 1 send + >=2 edits on the same id (sc-6-2) and funnel routing (sc-6-4).
   - Verify: `npx vitest run src/telegram/streaming.test.ts` passes.
4. **`src/telegram/digest.ts`** + **`digest.test.ts`** — implement `sendDigest` (calls `sendSafe(..., { silent: true })`); test asserts `silent:true` + funnel routing (sc-6-3/6-4).
   - Verify: `npx vitest run src/telegram/digest.test.ts` passes.
5. **(Optional, sc-6-5 manual) minimal wire** — in `src/cli/commands/do.ts` AFTER `runPromotionGate` approves and `launcher.launch` returns `{ runId }` (`do.ts:172-180`), call `streamProgress` with an async iterable that tails existing run progress (`CompletionTailer` at `chat/completion-tailer.ts:97` / roster `state.json.progress` at `run-spawner.ts:106`). Keep it READ-ONLY; add NO run logic; behind the existing approved branch so the default path stays byte-identical.
   - Verify: `do-bridge` tests still green; default (non-streaming) path unchanged.
6. **Run full verification** — `npm run build` && `npx vitest run src/telegram src/do-bridge` && `npm run lint`.

---

## 9. Pitfalls & Warnings

- **Do NOT make the first update the initial send.** First-update-as-send yields only N-1 edits → fails sc-6-2 at N=2. Use a fixed initial header as the single `send`, then edit per update (1 send + N edits).
- **Do NOT change `sendSafe`'s `Promise<void>` return** to thread the message id — the contract says keep it void. Use the separate `sendReturningId`/`sendSafeForEdit` path for the id (the contract explicitly suggests this).
- **`GrammyTransport.sendMessage` currently discards the return** (`bot.ts:111-113`). grammy DOES return `Message.TextMessage` (`api.d.ts:156`, `message.d.ts:11`) — the id is available; you just need `sendReturningId` to surface it.
- **Keep the option neutral.** Name the funnel/interface field `silent` (provider-neutral, principles.md:28); only `GrammyTransport` (bot.ts) maps it to grammy's `disable_notification`. Do not import grammy types into `outbound.ts`/`streaming.ts`/`digest.ts`.
- **Never call the transport directly** from `streaming.ts`/`digest.ts` — only `sendSafe`/`sendSafeForEdit`/`sendSafeEdit`. A direct `transport.sendMessage`/`editMessage` call breaks the single-chokepoint invariant the evaluator checks.
- **Keep the diff inside `src/telegram/`** (plus at most a tiny optional `do.ts` wire). Adding run/fleet/scheduler logic fails the non-goals and evaluatorNotes.
- **ESM discipline:** `.js` suffixes on all relative imports, `import type` for type-only imports, no `any` (use `unknown`/narrowing). Lint is a hard gate (principles.md:19).
- **`digest.ts` name is local to `src/telegram/`** — do not confuse with `src/research/digest.ts`; do not import the research module (out of scope). The digest text is handed in as a plain string.
- **`async function*` generators** are the simplest way for the test to build an `AsyncIterable<string>` from a fixed array (precedent: `apple-health.ts:83-85`).
