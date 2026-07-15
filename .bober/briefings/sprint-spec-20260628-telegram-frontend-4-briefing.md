# Sprint Briefing: Inline-keyboard approve / adjust / reject over the existing disk-marker gate

**Contract:** sprint-spec-20260628-telegram-frontend-4
**Generated:** 2026-06-30T00:00:00Z

> Mission: surface pending checkpoints in Telegram as a message + `[Approve][Adjust][Reject]` inline keyboard whose button taps write the **same** `.approved.json` / `.rejected.json` disk markers the existing `approve`/`reject` CLI commands write. No new approval mechanism. All callbacks whitelist-gated and funnelled through Sprint-1 `sendSafe`.

---

## 0. The One Rule That Decides This Sprint

Every marker your Telegram callback writes MUST be **byte-shaped-identical** to what `src/cli/commands/approve.ts` / `reject.ts` already produce. Both the CLI and the `saveApproved`/`saveRejected` helpers serialise with the identical call `JSON.stringify(payload, null, 2) + "\n"` (approve.ts:74-78 vs approval-state.ts:112-116). Import the helpers; build the payload object with the **same key order**; do not invent fields. The evaluator diffs your output against the CLI output.

---

## 1. Target Files

### `src/state/approval-state.ts` (READ-ONLY — do not modify; nonGoal #5)

This is the single source of truth. Import its helpers directly. **Exact exports + signatures (verified):**

```ts
// src/state/approval-state.ts:25-43  — marker shapes (DO NOT change; nonGoal #5)
export interface PendingMarker {
  checkpointId: string;
  runId?: string;
  artifact: { type?: string; path?: string; summary?: string; lines?: number };
  prompt: string;
  requestedAt: string;
  timeoutAt: string;
}
export interface ApprovedMarker {
  approvedAt: string;          // required — ISO-8601
  approverId: string;          // required — Telegram sender id (String(from.id))
  editDelta?: unknown;         // OPTIONAL — Adjust supplies the replacement text here
}
export interface RejectedMarker {
  rejectedAt: string;          // required — ISO-8601
  rejecterId: string;          // required — NOTE: "rejecterId" (NOT rejectorId/approverId)
  feedback: string;            // required — the supplied feedback text
}
```

| Helper | Location | Signature | Use in this sprint |
|--------|----------|-----------|--------------------|
| `listPending` | `approval-state.ts:80` | `(projectRoot: string) => Promise<PendingMarker[]>` | `/pending` command lists full markers (need `prompt`, `checkpointId`, `artifact`) |
| `readPending` | `approval-state.ts:64` | `(projectRoot, id) => Promise<PendingMarker \| null>` | optional — re-read one marker for rendering |
| `pendingExists` | `approval-state.ts:145` | `(projectRoot, id) => Promise<boolean>` | THE GUARD — callback writes nothing if false (mirrors approve.ts:44) |
| `saveApproved` | `approval-state.ts:106` | `(projectRoot, id, m: ApprovedMarker) => Promise<void>` | Approve + Adjust write path |
| `saveRejected` | `approval-state.ts:122` | `(projectRoot, id, m: RejectedMarker) => Promise<void>` | Reject write path |
| `deletePending` | `approval-state.ts:138` | `(projectRoot, id) => Promise<void>` | best-effort cleanup after resolution (never throws); matches do-bridge/promote.ts:99 |

On-disk layout (private helpers, `approval-state.ts:7-23`): markers live at `<projectRoot>/.bober/approvals/<id>.{pending,approved,rejected}.json`. **Every helper takes `projectRoot` as its first argument** — tests point it at a `mkdtemp` dir. There is NO `readApproved`/`readRejected` export (confirmed by the comment at proposal-gate.ts:144-146); you only read pending + write approved/rejected.

`listPendingApprovals` (`approval-state.ts:179`) returns the cockpit-row shape `{checkpointId, ageMs, prompt}` — convenient if `/pending` only needs those three fields, but it omits `artifact`. Prefer `listPending` if you render the artifact summary.

---

### `src/telegram/bot.ts` (modify)

Three surgical additions. **Relevant existing anchors:**

```ts
// bot.ts:25-33  — local minimal Update shape (grammy types must NOT leak past this file)
export interface TelegramUpdate {
  update_id: number;
  message?: { message_id: number; from?: { id: number }; chat: { id: number }; text?: string };
  // ADD: callback_query?: { id: string; from: { id: number }; message?: { chat: { id: number } }; data?: string };
}

// bot.ts:42-44  — BotTransport (extend here, NOT in outbound.ts — see outbound.ts:8-9)
export interface BotTransport extends TelegramTransport {
  getUpdates(offset: number): Promise<TelegramUpdate[]>;
  // ADD: sendKeyboard(chatId: number, text: string, keyboard: InlineKeyboardSpec): Promise<void>;
  // ADD: answerCallback(callbackQueryId: string, text?: string): Promise<void>;
}

// bot.ts:127-173 — poll loop; ADD a callback_query branch BEFORE the existing `const msg = update.message` block
```

**Imports this file already uses:** `Bot` from `grammy` (bot.ts:6 — the ONLY grammy import in the repo); `sendSafe`/`TelegramTransport` from `./outbound.js`; `isAllowed`/`parseAllowedUsers`/`denialReply` from `./whitelist.js`; `classify` from `./router.js`; the capture/prioritize handlers.

**Imported by:** `src/cli/commands/telegram.ts:5` (`GrammyTransport`, `startPollLoop`). Adding params to `startPollLoop` MUST keep them optional/defaulted — telegram.ts:50 calls `startPollLoop(transport, ac.signal)` with only two args (see Impact Analysis §7).

**Test file:** none exists (`src/telegram/bot.test.ts` is absent). Put the testable logic in `approvals.ts` (a pure-ish handler) so it can be unit-tested without driving the loop; keep `bot.ts` a thin wiring layer.

---

### `src/telegram/handlers/approvals.ts` (create)

**Directory pattern:** `src/telegram/handlers/` uses kebab-less single-word filenames (`capture.ts`, `prioritize.ts`), each with a co-located `*.test.ts`. **Most similar existing file:** `src/telegram/handlers/prioritize.ts` — follow its shape: doc-comment header, `// ── Section ──` box headers (principles.md:32), a `Default*` production impl, a thin `handle*` entry that returns a **string reply** (never touches the transport — caller funnels via `sendSafe`).

**Structure template (mirrors prioritize.ts:1-127 + the filesystem-via-temp-dir test rule, principles.md:44):**

```ts
/**
 * handlers/approvals.ts — Resolve pending disk-marker checkpoints from Telegram
 * inline-keyboard taps. Writes the SAME markers as src/cli/commands/{approve,reject}.ts.
 * No new approval mechanism (nonGoal #1). Replies returned as strings → sendSafe.
 */
import { isAllowed, type AllowedUsers } from "../whitelist.js";
import {
  pendingExists, saveApproved, saveRejected, deletePending,
  type ApprovedMarker, type RejectedMarker,
} from "../../state/approval-state.js";
import { decodeCallback, type CallbackAction } from "../keyboard.js";

// ── Ephemeral per-chat pending-callback state ──────────────────────────
/** Map<chatId, {action, checkpointId}> — Adjust/Reject await a follow-up text. In-memory, no disk. */
export type PendingCallbackState = Map<number, { action: "adjust" | "reject"; checkpointId: string }>;
export function createPendingState(): PendingCallbackState { return new Map(); }

// ── Button tap (callback_query) ────────────────────────────────────────
export async function handleApprovalCallback(args: {
  projectRoot: string;
  senderId: number;
  allowed: AllowedUsers;
  chatId: number;
  data: string;                       // raw callback_data
  pending: PendingCallbackState;
  now?: () => string;                 // injected clock — defaults to () => new Date().toISOString()
}): Promise<{ reply: string | null; answer: string }> {
  // 1. whitelist re-check on the CALLBACK sender id (generatorNotes step 1; sc-4-5)
  if (!isAllowed(args.senderId, args.allowed)) return { reply: null, answer: "Denied" };
  const decoded = decodeCallback(args.data);
  if (!decoded) return { reply: null, answer: "Unknown" };
  // 2. no-pending guard (mirror approve.ts:44 — write NOTHING; sc-4-4)
  if (!(await pendingExists(args.projectRoot, decoded.checkpointId))) {
    return { reply: `No pending checkpoint: ${decoded.checkpointId}`, answer: "Gone" };
  }
  const now = args.now ?? (() => new Date().toISOString());
  if (decoded.action === "approve") {
    const m: ApprovedMarker = { approvedAt: now(), approverId: String(args.senderId) };
    await saveApproved(args.projectRoot, decoded.checkpointId, m);
    await deletePending(args.projectRoot, decoded.checkpointId);
    return { reply: `Approved ${decoded.checkpointId}`, answer: "Approved" };
  }
  // Adjust / Reject: stash and await the next text message from this chat
  args.pending.set(args.chatId, { action: decoded.action, checkpointId: decoded.checkpointId });
  return {
    reply: decoded.action === "adjust" ? "Send the replacement text." : "Send rejection feedback.",
    answer: "OK",
  };
}

// ── Follow-up text resolves a stashed Adjust/Reject ────────────────────
export async function handleApprovalFollowup(args: {
  projectRoot: string; senderId: number; allowed: AllowedUsers;
  chatId: number; text: string; pending: PendingCallbackState; now?: () => string;
}): Promise<string | null> {                // null → no stash → caller falls through to normal text routing
  const stash = args.pending.get(args.chatId);
  if (!stash) return null;
  if (!isAllowed(args.senderId, args.allowed)) return null;            // belt-and-suspenders
  args.pending.delete(args.chatId);
  if (!(await pendingExists(args.projectRoot, stash.checkpointId))) {
    return `No pending checkpoint: ${stash.checkpointId}`;
  }
  const now = args.now ?? (() => new Date().toISOString());
  if (stash.action === "adjust") {
    const m: ApprovedMarker = { approvedAt: now(), approverId: String(args.senderId), editDelta: args.text };
    await saveApproved(args.projectRoot, stash.checkpointId, m);
    await deletePending(args.projectRoot, stash.checkpointId);
    return `Adjusted + approved ${stash.checkpointId}`;
  }
  const m: RejectedMarker = { rejectedAt: now(), rejecterId: String(args.senderId), feedback: args.text };
  await saveRejected(args.projectRoot, stash.checkpointId, m);
  await deletePending(args.projectRoot, stash.checkpointId);
  return `Rejected ${stash.checkpointId}`;
}
```

> Why import the real fs helpers (not inject fakes): principles.md:44 — "No test mocks for filesystem. Tests create temp directories and clean up." Inject only the **clock** (`now`) for deterministic `approvedAt`, exactly as capture.ts:38 stamps the clock at the boundary. This differs from prioritize/capture which inject the sink because there the side-effect is a FactStore/subprocess; here the side-effect is plain fs the test owns via a temp dir.

---

### `src/telegram/keyboard.ts` (create) — PURE, no SDK import

Encodes/decodes `callback_data` and builds the keyboard SPEC (a provider-neutral array; grammy's `InlineKeyboard` is constructed only inside bot.ts).

**64-byte constraint:** Telegram caps `callback_data` at 64 bytes. checkpointIds in this repo: `calendar-${planId}` (proposal-gate.ts:108), `promote-${findingId}` (promote.ts:79), and pipeline ids like `pre-curator` / `post-research` / `end-of-pipeline` (pipeline.ts:195,706,932). Use a 1-char action code + `:` + checkpointId so the budget is `2 + len(checkpointId)`:

```ts
// keyboard.ts (pure) — provider-neutral keyboard spec + compact callback_data codec
export type CallbackAction = "approve" | "adjust" | "reject";
export type InlineKeyboardSpec = { text: string; data: string }[][];   // rows of buttons

const CODE: Record<CallbackAction, string> = { approve: "a", adjust: "j", reject: "r" };
const ACTION: Record<string, CallbackAction> = { a: "approve", j: "adjust", r: "reject" };

export function encodeCallback(action: CallbackAction, checkpointId: string): string {
  return `${CODE[action]}:${checkpointId}`;                            // e.g. "a:calendar-mon-plan"
}
export function decodeCallback(data: string): { action: CallbackAction; checkpointId: string } | null {
  const i = data.indexOf(":");
  if (i <= 0) return null;
  const action = ACTION[data.slice(0, i)];
  const checkpointId = data.slice(i + 1);
  if (!action || !checkpointId) return null;
  return { action, checkpointId };
}
export function buildApprovalKeyboard(checkpointId: string): InlineKeyboardSpec {
  return [[
    { text: "Approve", data: encodeCallback("approve", checkpointId) },
    { text: "Adjust",  data: encodeCallback("adjust",  checkpointId) },
    { text: "Reject",  data: encodeCallback("reject",  checkpointId) },
  ]];
}
```

> Guard the budget: if `Buffer.byteLength(encodeCallback(...)) > 64`, that checkpointId can't round-trip — but all current id forms are well under (longest realistic `promote-<16hex>` = 24 bytes). Document the limit; don't add truncation (it would break `decodeCallback` → wrong file).

---

## 2. Patterns to Follow

### Pattern A — Handler returns a string; the loop funnels through `sendSafe`
**Source:** `src/telegram/handlers/prioritize.ts:117-127` + `bot.ts:167,171`
```ts
// handler: NO transport access — returns content
export async function handlePrioritize(name, args, query = defaultPrioritize): Promise<string> { ... }
// loop: the ONLY caller of the funnel
await sendSafe(transport, chatId, reply);
```
**Rule:** approvals handlers return reply strings; `bot.ts` passes them to `sendSafe` (text) — never call `transport.sendMessage` from a handler (nonGoal #4, outbound.ts:18-22).

### Pattern B — The no-pending guard (mirror exactly)
**Source:** `src/cli/commands/approve.ts:43-52` (reject.ts:43-52 is identical)
```ts
const exists = await pendingExists(projectRoot, checkpointId);
if (!exists) { /* write NOTHING, report, return */ return; }
```
**Rule:** every callback path re-checks `pendingExists` before any write; a tap on a checkpoint with no `.pending.json` writes nothing (sc-4-4).

### Pattern C — Approved/Rejected payload shape (byte-identical contract)
**Source:** `src/cli/commands/approve.ts:68-78` and `reject.ts:54-64`
```ts
// approve.ts
const payload = {
  approvedAt: new Date().toISOString(),
  approverId: resolveApprover(),
  ...(editDelta !== undefined ? { editDelta } : {}),   // editDelta key OMITTED when absent
};
await writeFile(approvedPath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
// reject.ts
const payload = { rejectedAt: new Date().toISOString(), rejecterId: resolveRejecter(), feedback: opts.feedback };
```
**Rule:** Approve → `{approvedAt, approverId}` (no editDelta key). Adjust → `{approvedAt, approverId, editDelta: <text>}`. Reject → `{rejectedAt, rejecterId, feedback}`. `saveApproved`/`saveRejected` serialise the object you pass with the same `JSON.stringify(m, null, 2)+"\n"` (approval-state.ts:112-116/128-132) → byte-identical to the CLI. Build the object literal in that key order. **Note `rejecterId` (not rejectorId).**

### Pattern D — approverId from the whitelist identity
**Source:** `approve.ts:29-31` (`resolveApprover`), `reject.ts:29-31` (`resolveRejecter`)
```ts
export function resolveApprover(): string { return process.env["USER"] ?? process.env["USERNAME"] ?? "unknown"; }
```
**Rule:** the CLI derives identity from `$USER`; the Telegram adapter's analogous identity is the **whitelisted Telegram sender id** (contract assumptions #3) → `approverId = String(callback.from.id)`. Do NOT reuse `resolveApprover()` (wrong identity source for Telegram).

### Pattern E — Clock injected at the boundary (pure-handler determinism)
**Source:** `src/telegram/handlers/capture.ts:38`
```ts
const now = new Date().toISOString(); // clock at boundary — NEVER inside the pure core
```
**Rule:** pass `now?: () => string` into the approvals handlers (default `() => new Date().toISOString()`); tests inject a fixed clock to assert `approvedAt`/`rejectedAt`.

### Pattern F — Provider-agnostic SDK isolation
**Source:** `bot.ts:1-6, 25-33, 53-74` + principles.md:28,41 + outbound.ts:8-9
```ts
// bot.ts:71 — grammy's Update cast down to the local subset; types never leak out
return updates as unknown as TelegramUpdate[];
```
**Rule:** `grammy` (`InlineKeyboard`, `answerCallbackQuery`, `CallbackQuery`) is referenced ONLY inside `bot.ts`. `keyboard.ts` + `approvals.ts` speak the neutral `InlineKeyboardSpec`/`TelegramUpdate.callback_query` shapes. `GrammyTransport` translates the spec into a real `InlineKeyboard`.

### Pattern G — Loop branch + whitelist re-check on the sender
**Source:** `bot.ts:127-148`
```ts
for (const update of updates) {
  offset = update.update_id + 1;
  // ADD FIRST: const cb = update.callback_query; if (cb) { ...handle + answerCallback + sendSafe... ; continue; }
  const msg = update.message;
  if (!msg) continue;
  const senderId = msg.from?.id; const chatId = msg.chat.id;
  if (senderId === undefined) continue;
  if (!isAllowed(senderId, allowed)) { await sendSafe(transport, chatId, denialReply(senderId)); continue; }
```
**Rule:** the callback branch reads `cb.from.id`, `cb.message?.chat.id`, `cb.data`; re-checks `isAllowed`; resolves via the approvals handler; always calls `transport.answerCallback(cb.id, answer)` to stop the client spinner; funnels any text reply via `sendSafe`. On the text branch, before normal `classify` routing, call `handleApprovalFollowup` — if it returns non-null, that text was an Adjust/Reject follow-up; otherwise fall through to existing capture/command routing (bot.ts:149-172).

---

## 3. grammy API surface (use ONLY inside bot.ts — grammy@1.44.0)

```ts
import { Bot, InlineKeyboard } from "grammy";

// Build a keyboard from the neutral spec (keyboard.d.ts:486-550)
//   new InlineKeyboard()                       — class, .inline_keyboard: InlineKeyboardButton[][]
//   .text(label: string, data?: string): this  — adds a callback button (data = callback_data ≤64B)
//   .row(): this                               — start a new button row
function toGrammy(spec: InlineKeyboardSpec): InlineKeyboard {
  const kb = new InlineKeyboard();
  spec.forEach((row, i) => { if (i > 0) kb.row(); for (const b of row) kb.text(b.text, b.data); });
  return kb;
}

// GrammyTransport methods to ADD:
async sendKeyboard(chatId: number, text: string, spec: InlineKeyboardSpec): Promise<void> {
  // api.d.ts:156 — sendMessage(chat_id, text, other?) ; reply_markup accepts an InlineKeyboard instance
  await this.bot.api.sendMessage(chatId, text, { reply_markup: toGrammy(spec) });
}
async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
  // api.d.ts:1151 — answerCallbackQuery(callback_query_id, other?) : Promise<true>
  await this.bot.api.answerCallbackQuery(callbackQueryId, text ? { text } : undefined);
}
```

**Inbound callback shape (markup.d.ts:99-114, surfaced via Update.callback_query at update.d.ts:59):**
```ts
interface CallbackQuery { id: string; from: User; message?: MaybeInaccessibleMessage; data?: string; /* ...*/ }
// Your local TelegramUpdate.callback_query subset only needs: { id, from: {id}, message?: {chat:{id}}, data? }
```
`getUpdates` already returns `callback_query` updates by default (no `allowed_updates` change needed); the existing `getUpdates(offset)` at bot.ts:69-73 keeps casting grammy `Update[] → TelegramUpdate[]`.

---

## 4. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `pendingExists` | `state/approval-state.ts:145` | `(root, id) => Promise<boolean>` | the no-pending guard (sc-4-4) |
| `saveApproved` | `state/approval-state.ts:106` | `(root, id, ApprovedMarker) => Promise<void>` | Approve/Adjust write |
| `saveRejected` | `state/approval-state.ts:122` | `(root, id, RejectedMarker) => Promise<void>` | Reject write |
| `listPending` | `state/approval-state.ts:80` | `(root) => Promise<PendingMarker[]>` | `/pending` listing |
| `readPending` | `state/approval-state.ts:64` | `(root, id) => Promise<PendingMarker\|null>` | single-marker re-read |
| `deletePending` | `state/approval-state.ts:138` | `(root, id) => Promise<void>` | best-effort cleanup post-resolution |
| `isAllowed` | `telegram/whitelist.ts:32` | `(id, AllowedUsers) => boolean` | callback whitelist re-check (sc-4-5) |
| `parseAllowedUsers` | `telegram/whitelist.ts:16` | `(env) => AllowedUsers` | already called at loop start (bot.ts:111) |
| `denialReply` | `telegram/whitelist.ts:42` | `(id) => string` | denial text (optional for callbacks) |
| `sendSafe` | `telegram/outbound.ts:27` | `(transport, chatId, content) => Promise<void>` | the ONLY text-reply funnel (nonGoal #4) |
| `classify` | `telegram/router.ts:30` | `(message) => RoutedMessage` | command-vs-text routing (text branch) |
| `ensureDir` | `state/helpers.ts:6` | `(dirPath) => Promise<void>` | used internally by save* (no need to call directly) |
| `findProjectRoot` | `utils/fs.ts` | `() => Promise<string\|null>` | resolve projectRoot in the bot.ts default path (see capture.ts:36) |

Utilities reviewed in `utils/`, `state/`, `telegram/`: the marker I/O + whitelist + funnel above cover the sprint — do NOT write a new approval writer, a new whitelist check, or a new JSON serialiser.

---

## 5. Prior Sprint Output

### Sprint 1 — outbound + transport + whitelist
**Created:** `telegram/outbound.ts` (`sendSafe`, `TelegramTransport`); `telegram/bot.ts` (`BotTransport`, `TelegramUpdate`, `GrammyTransport` — sole grammy importer, `startPollLoop`, `helpReply`); `telegram/whitelist.ts` (`isAllowed`, `parseAllowedUsers`, `denialReply`).
**Connection:** extend `BotTransport`/`TelegramUpdate`/`GrammyTransport` for keyboards+callbacks; reuse `sendSafe` + `isAllowed`; do NOT touch `TelegramTransport` in outbound.ts (outbound.ts:8-9 reserves extensions for BotTransport).

### Sprint 2-3 — router + injected-dependency handlers
**Created:** `telegram/router.ts` (`classify`, `parseScopeFromCommand`); `telegram/handlers/{capture,prioritize}.ts` (the injected-fn + `defaultX` + fake-in-tests pattern); command dispatch in `bot.ts:149-172`.
**Connection:** add `/pending` to the command switch (bot.ts:155-166); follow the handler/return-string discipline; mirror the test layout (`approvals.test.ts` co-located).

### Upstream producers (read-only context — they create the pending markers you resolve)
- `src/calendar/proposal-gate.ts:108,122` → `checkpointId = "calendar-" + planId`, `artifact.type:"calendar-plan"`.
- `src/do-bridge/promote.ts:79,85` → `checkpointId = "promote-" + findingId`, `artifact.type:"bober-run"`; promote.ts:95 auto-approve writes `{approvedAt, approverId:"auto"}` — your manual Approve mirrors this with the sender id.

---

## 6. Testing Patterns

### Unit Test Pattern — temp `.bober/approvals` dir (real fs, no mocks)
**Source:** `src/state/approval-state.test.ts:9-47` — copy this temp-dir setup/teardown verbatim.
```ts
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { savePending, type PendingMarker } from "../../state/approval-state.js";
import {
  handleApprovalCallback, handleApprovalFollowup, createPendingState,
} from "./approvals.js";
import { encodeCallback } from "../keyboard.js";
import { parseAllowedUsers } from "../whitelist.js";

let tmpRoot: string; let approvalsDir: string;
const ALLOWED = parseAllowedUsers({ TELEGRAM_ALLOWED_USERS: "42" }); // sender 42 is whitelisted
const NOW = () => "2026-06-30T12:00:00.000Z";

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "bober-tg-approvals-test-"));
  approvalsDir = join(tmpRoot, ".bober", "approvals");
  await mkdir(approvalsDir, { recursive: true });
});
afterEach(async () => { await rm(tmpRoot, { recursive: true, force: true }); });

const fixturePending = (id: string): PendingMarker => ({
  checkpointId: id, artifact: { type: "calendar-plan" }, prompt: "Approve plan",
  requestedAt: NOW(), timeoutAt: NOW(),
});
const exists = async (rel: string) =>
  await readFile(join(approvalsDir, rel), "utf-8").then(() => true, () => false);

it("sc-4-2: Approve writes <id>.approved.json with approvedAt + approverId", async () => {
  await savePending(tmpRoot, fixturePending("calendar-x"));
  const pending = createPendingState();
  await handleApprovalCallback({
    projectRoot: tmpRoot, senderId: 42, allowed: ALLOWED, chatId: 7,
    data: encodeCallback("approve", "calendar-x"), pending, now: NOW,
  });
  const m = JSON.parse(await readFile(join(approvalsDir, "calendar-x.approved.json"), "utf-8"));
  expect(m).toEqual({ approvedAt: NOW(), approverId: "42" });   // byte-shape == approve.ts
});

it("sc-4-3a: Reject then feedback writes <id>.rejected.json with feedback", async () => {
  await savePending(tmpRoot, fixturePending("calendar-y"));
  const pending = createPendingState();
  await handleApprovalCallback({ projectRoot: tmpRoot, senderId: 42, allowed: ALLOWED, chatId: 7,
    data: encodeCallback("reject", "calendar-y"), pending, now: NOW });
  await handleApprovalFollowup({ projectRoot: tmpRoot, senderId: 42, allowed: ALLOWED, chatId: 7,
    text: "scope too broad", pending, now: NOW });
  const m = JSON.parse(await readFile(join(approvalsDir, "calendar-y.rejected.json"), "utf-8"));
  expect(m).toEqual({ rejectedAt: NOW(), rejecterId: "42", feedback: "scope too broad" });
});

it("sc-4-3b: Adjust then text writes approved marker whose editDelta == that text", async () => {
  await savePending(tmpRoot, fixturePending("calendar-z"));
  const pending = createPendingState();
  await handleApprovalCallback({ projectRoot: tmpRoot, senderId: 42, allowed: ALLOWED, chatId: 7,
    data: encodeCallback("adjust", "calendar-z"), pending, now: NOW });
  await handleApprovalFollowup({ projectRoot: tmpRoot, senderId: 42, allowed: ALLOWED, chatId: 7,
    text: "move to Friday 3pm", pending, now: NOW });
  const m = JSON.parse(await readFile(join(approvalsDir, "calendar-z.approved.json"), "utf-8"));
  expect(m).toEqual({ approvedAt: NOW(), approverId: "42", editDelta: "move to Friday 3pm" });
});

it("sc-4-4: callback for a checkpoint with no pending marker writes nothing", async () => {
  const pending = createPendingState();
  await handleApprovalCallback({ projectRoot: tmpRoot, senderId: 42, allowed: ALLOWED, chatId: 7,
    data: encodeCallback("approve", "ghost"), pending, now: NOW });
  expect(await exists("ghost.approved.json")).toBe(false);
});

it("sc-4-5: callback from a non-whitelisted id writes nothing & does not stash", async () => {
  await savePending(tmpRoot, fixturePending("calendar-x"));
  const pending = createPendingState();
  await handleApprovalCallback({ projectRoot: tmpRoot, senderId: 999, allowed: ALLOWED, chatId: 7,
    data: encodeCallback("approve", "calendar-x"), pending, now: NOW });
  expect(await exists("calendar-x.approved.json")).toBe(false);
  expect(pending.size).toBe(0);
});
```
**Runner:** vitest. **Assertion:** `expect(...).toEqual` (exact-shape on the parsed JSON proves byte-shape parity). **Mock approach:** NO mocks — real fs in a `mkdtemp` temp root, inject only `now` (principles.md:44). **File naming:** `approvals.test.ts` co-located (principles.md:20). **Location:** `src/telegram/handlers/`.

> Pure-keyboard test: also add a `keyboard.test.ts` asserting `decodeCallback(encodeCallback("adjust","calendar-x"))` round-trips and that `Buffer.byteLength` of encoded data ≤ 64 — cheap, no fs.

### E2E Test Pattern
Not applicable — no Playwright in this repo (CLI/library only, principles.md:48). sc-4-6 is a `manual` criterion (not automated).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/commands/telegram.ts:5,50` | `bot.ts` `startPollLoop`/`GrammyTransport` | **high** | calls `startPollLoop(transport, ac.signal)` with 2 args — any new param MUST be optional/defaulted (like capture/prioritize at bot.ts:107-108) or this breaks |
| `src/cli/commands/{approve,reject}.ts` | shares `approval-state.ts` markers | **medium** | unchanged — but they define the byte-shape your callbacks must match; diff against them |
| `src/calendar/proposal-gate.ts`, `src/do-bridge/promote.ts` | write/read the same markers | **low** | read-only producers; confirm your Approve/Reject markers are what their gate readers expect |
| `src/state/approval-state.ts` consumers (list-approvals CLI, MCP tool) | marker schema | **low** | do NOT modify the schema (nonGoal #5) → zero impact |

### Existing Tests That Must Still Pass
- `src/state/approval-state.test.ts` — tests `listPendingApprovals`/`savePending`; you don't touch approval-state.ts, so it must stay green (also your temp-dir template source).
- `src/cli/commands/approve.test.ts`, `reject.test.ts` — define the CLI marker shape your output mirrors; unchanged, must stay green.
- `src/telegram/handlers/{capture,prioritize}.test.ts`, `router.test.ts`, `whitelist.test.ts`, `outbound.test.ts` — adding a `callback_query` branch + `/pending` dispatch must not regress message routing; re-run.

### Features That Could Be Affected
- **Calendar approve-gate (spec 7)** — shares `.bober/approvals/calendar-*`; a Telegram Approve must resolve `applyPlan`'s gate (proposal-gate.ts:151) exactly as the CLI does.
- **do-bridge promotion (spec 6)** — shares `.bober/approvals/promote-*`; verify Reject writes the rejected marker its waiting poll loop honours (promote.ts gate).
- **Plain-text capture (Sprint 2)** — the new Adjust/Reject follow-up interception runs BEFORE `classify`; ensure a chat with NO stash still falls through to capture (return null from `handleApprovalFollowup`).

### Recommended Regression Checks
1. `npm run build` — zero tsc errors (sc-4-1).
2. `npx vitest run src/telegram src/state/approval-state.test.ts src/cli/commands/approve.test.ts src/cli/commands/reject.test.ts` — new + adjacent suites green.
3. Diff parity: a Telegram Approve marker `JSON.parse` deep-equals what `approve.ts` writes for the same id (no extra/missing keys; `rejecterId` spelled correctly).
4. `npx tsc --noEmit` confirms grammy types did not leak out of bot.ts (keyboard.ts/approvals.ts import zero grammy symbols).

---

## 8. Implementation Sequence (dependency-ordered)

1. **`src/telegram/keyboard.ts`** (pure, no deps) — `CallbackAction`, `InlineKeyboardSpec`, `encodeCallback`/`decodeCallback`, `buildApprovalKeyboard`.
   - Verify: `keyboard.test.ts` round-trips encode→decode; encoded byte length ≤ 64.
2. **`src/telegram/handlers/approvals.ts`** (depends on keyboard.ts + approval-state.ts + whitelist.ts) — `PendingCallbackState`, `handleApprovalCallback`, `handleApprovalFollowup`.
   - Verify: imports zero grammy symbols; only `now` is injected; markers written via `saveApproved`/`saveRejected`.
3. **`src/telegram/handlers/approvals.test.ts`** (depends on #1,#2) — sc-4-2..4-5 against a temp `.bober/approvals` (template in §6).
   - Verify: all five tests pass; markers deep-equal the CLI shape.
4. **`src/telegram/bot.ts`** (integration, depends on all above) —
   a. extend `TelegramUpdate` with the `callback_query` subset (bot.ts:25-33);
   b. extend `BotTransport` with `sendKeyboard` + `answerCallback` (bot.ts:42-44);
   c. implement both on `GrammyTransport` via `InlineKeyboard` + `bot.api.answerCallbackQuery` (bot.ts:53-74);
   d. add a `/pending` case to the command switch (bot.ts:155-166): `listPending` → for each, `transport.sendKeyboard(chatId, render(marker), buildApprovalKeyboard(marker.checkpointId))`;
   e. add the `callback_query` branch at the top of the loop body (bot.ts:127) → `handleApprovalCallback` + `transport.answerCallback(cb.id, answer)` + `sendSafe` for any reply;
   f. before normal text routing (bot.ts:149), call `handleApprovalFollowup`; if non-null → `sendSafe(reply)` + `continue`;
   g. thread a `createPendingState()` map + optional handler params through `startPollLoop` with **defaults** so telegram.ts:50 still compiles.
   - Verify: `npm run build` zero errors; telegram.ts unchanged still compiles.
5. **Run full verification** — `npm run build` && `npx vitest run src/telegram src/state src/cli/commands/approve.test.ts src/cli/commands/reject.test.ts`.

---

## 9. Pitfalls & Warnings

- **`rejecterId`, not `rejectorId`/`approverId`.** RejectedMarker uses `rejecterId` (approval-state.ts:42). A typo here makes the marker shape diverge and the test `toEqual` fails.
- **editDelta key must be ABSENT for a plain Approve** (approve.ts:71 conditional spread). Build `{approvedAt, approverId}` with NO `editDelta` key for Approve; include it ONLY for Adjust. `toEqual` is exact-shape.
- **approverId is the Telegram sender id (`String(from.id)`), NOT `resolveApprover()`/`$USER`.** The CLI's identity source is wrong for Telegram (contract assumptions #3).
- **Do not touch `TelegramTransport` in outbound.ts** — extensions (`sendKeyboard`, `answerCallback`) belong on `BotTransport` in bot.ts (outbound.ts:8-9 says so explicitly). And keep `sendSafe` as the text funnel; do not call `transport.sendMessage` from handlers (nonGoal #4).
- **grammy stays in bot.ts only.** `keyboard.ts` and `approvals.ts` must import zero grammy symbols (principles.md:28,41). Pass the neutral `InlineKeyboardSpec`; convert to `InlineKeyboard` inside `GrammyTransport`.
- **`startPollLoop` signature is load-bearing** — telegram.ts:50 calls it with two args. New params (pending-state map, approvals deps) MUST be optional with defaults, mirroring `capture`/`prioritize` defaults at bot.ts:107-108. Otherwise the CLI breaks to compile.
- **Always `answerCallbackQuery`** even on a denied/ghost tap — otherwise the Telegram client shows an indefinite loading spinner on the button. The answer text is cosmetic; the marker (or lack of it) is the real outcome.
- **No-pending and non-whitelisted paths write NOTHING and stash NOTHING** (sc-4-4/4-5). For non-whitelisted Adjust/Reject taps, return before `pending.set` so no follow-up text is ever accepted.
- **64-byte callback_data** — current checkpointIds are short, but never truncate the id in `callback_data` (truncation breaks `pendingExists` lookup → silent no-op). Encode `code:checkpointId` and decode by first `:`.
- **`deletePending` is best-effort** (approval-state.ts:138, never throws) — call it after a successful write to keep `/pending` clean, but never gate control flow on it (gate is the presence of the approved/rejected marker, proposal-gate.ts:148-149).
