# Sprint Briefing: Document upload → medical ingest with mandatory per-upload opt-in

**Contract:** sprint-spec-20260628-telegram-frontend-5
**Generated:** 2026-06-30T00:00:00Z

> PRIVACY-SENSITIVE SPRINT. Telegram bot messages are NOT E2E-encrypted. The per-upload Yes/No
> opt-in is a MANDATORY gate that must run, disclose the LOCAL ingest destination, and be answered
> "Yes" BEFORE any file download or any call into `src/medical`. On No / no-confirm: download nothing
> (or discard), ingest nothing. Post-ingest reply = a NON-SENSITIVE count only — never marker values/names.

---

## 1. Target Files

### `src/telegram/handlers/upload.ts` (create)

**Directory pattern:** `src/telegram/handlers/` uses kebab-case single-purpose files, each an
injected-dependency pure adapter (no transport access, returns strings) — see `capture.ts`,
`prioritize.ts`, `approvals.ts`.

**Most similar existing files (follow BOTH):**
- `src/telegram/handlers/approvals.ts` — for the ephemeral chatId/id-keyed pending-state map + callback handler.
- `src/telegram/handlers/prioritize.ts` — for the injected-fn pattern with an execa-subprocess production default (`defaultPrioritize`, lines 56-100).

**Structure template (mirrors approvals.ts + prioritize.ts):**
```ts
/**
 * handlers/upload.ts — Per-upload opt-in gate for document → src/medical ingest.
 * Telegram is NOT E2E-encrypted: a document is NEVER downloaded/ingested until the
 * user taps an explicit Yes. The ingest fn + download fn are INJECTED so tests use spies
 * (no grammy, no network, no real medical pipeline). grammy stays in bot.ts only (principles.md:28).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { isAllowed } from "../whitelist.js";
import type { AllowedUsers } from "../whitelist.js";
import { decodeCallback } from "../keyboard.js";
import { findProjectRoot } from "../../utils/fs.js";
import { resolveCliEntry } from "../../fleet/runner.js";

// ── Injected deps (testability) ───────────────────────────────────────
/** Downloads the Telegram file_id to destPath. Default: transport.downloadDocument (grammy in bot.ts). */
export type DownloadFn = (fileId: string, destPath: string) => Promise<void>;
/** Hands a LOCAL file path to the existing src/medical ingest path; returns a NON-SENSITIVE count. */
export type MedicalIngest = (filePath: string) => Promise<{ recordsParsed: number; newRows: number }>;

// ── Ephemeral pending-upload state (mirror approvals.ts:32-36) ─────────
export type PendingUpload = { fileId: string; fileName: string; chatId: number };
export type PendingUploadState = Map<string, PendingUpload>; // keyed by uploadId encoded in callback_data
export function createPendingUploadState(): PendingUploadState { return new Map(); }

// ── Prompt + reply text (sc-5-5) ──────────────────────────────────────
export const LOCAL_INGEST_DEST = ".bober/medical (local health store)";
export function buildUploadPrompt(fileName: string): string {
  return `Telegram is not end-to-end encrypted. Send "${fileName}" to the LOCAL medical ingest `
    + `(${LOCAL_INGEST_DEST})? Nothing is processed until you tap Yes.`;
}

// ── On a document message: stash + return prompt (NO download yet) ─────
export function registerUpload(args: {
  uploadId: string; chatId: number; fileId: string; fileName: string; pending: PendingUploadState;
}): { reply: string } { /* pending.set(uploadId, {...}); return { reply: buildUploadPrompt(fileName) } */ }

// ── Yes/No callback → download + ingest exactly once, or discard ───────
export async function handleUploadCallback(args: {
  senderId: number; allowed: AllowedUsers; data: string; pending: PendingUploadState;
  download: DownloadFn; ingest: MedicalIngest;
}): Promise<{ reply: string | null; answer: string }> { /* see §6 */ }

// ── Production default ingest = execa `agent-bober medical import <file>` (see §3) ─
export async function defaultMedicalIngest(filePath: string): Promise<{ recordsParsed: number; newRows: number }> { /* §3 */ }
```

---

### `src/telegram/keyboard.ts` (modify)

**Relevant sections (lines 17-25, 32-49, 59-67):** the codec is generic (`<code>:<id>`, split on first `:`),
so adding Yes/No is purely additive — extend the `CallbackAction` union + the `CODE`/`ACTION` maps, then add a builder.
```ts
// keyboard.ts:17
export type CallbackAction = "approve" | "adjust" | "reject";              // ADD: | "confirm" | "cancel"
// keyboard.ts:24-25
const CODE: Record<CallbackAction, string> = { approve: "a", adjust: "j", reject: "r" }; // ADD confirm:"y", cancel:"n"
const ACTION: Record<string, CallbackAction> = { a: "approve", j: "adjust", r: "reject" }; // ADD y:"confirm", n:"cancel"
// keyboard.ts:59 — add a sibling builder, do NOT touch buildApprovalKeyboard
export function buildUploadKeyboard(uploadId: string): InlineKeyboardSpec {
  return [[
    { text: "Yes", data: encodeCallback("confirm", uploadId) },
    { text: "No",  data: encodeCallback("cancel",  uploadId) },
  ]];
}
```
**Rule:** `encodeCallback`/`decodeCallback` (lines 32, 41) are unchanged — they are action-agnostic. The 64-byte
budget is `2 + byteLength(uploadId)`; use a short uploadId (the document `message_id` as a string is tiny).

**Imported by:** `src/telegram/bot.ts:18`, `src/telegram/handlers/approvals.ts:22` (+ their tests). Additive change → no break.
**Test file:** `src/telegram/keyboard.test.ts` (exists) — add Yes/No round-trip cases.

---

### `src/telegram/bot.ts` (modify)

**(a) Extend `TelegramUpdate.message` with an optional `document` (lines 31-46):**
```ts
// bot.ts:33 — message shape; ADD document (mirrors @grammyjs/types Document subset, §5)
message?: {
  message_id: number;
  from?: { id: number };
  chat: { id: number };
  text?: string;
  document?: { file_id: string; file_name?: string; mime_type?: string };  // ADD
};
```

**(b) Extend `BotTransport` with a download method (lines 56-62) — keeps grammy in bot.ts only:**
```ts
// bot.ts:56
export interface BotTransport extends TelegramTransport {
  getUpdates(offset: number): Promise<TelegramUpdate[]>;
  sendKeyboard(chatId: number, text: string, keyboard: InlineKeyboardSpec): Promise<void>;
  answerCallback(callbackQueryId: string, text?: string): Promise<void>;
  downloadDocument(fileId: string, destPath: string): Promise<void>;   // ADD
}
```

**(c) Implement it on `GrammyTransport` (sole grammy consumer, lines 85-125).** grammy `getFile` returns
`File.file_path`; download via the documented URL then write bytes with `node:fs/promises` (no `@grammyjs/files` plugin is installed):
```ts
// GrammyTransport — uses this.bot.token (Bot.token is readonly, bot.d.ts:106) + this.bot.api.getFile (api.d.ts:639)
async downloadDocument(fileId: string, destPath: string): Promise<void> {
  const file = await this.bot.api.getFile(fileId);              // → { file_path?, file_id, ... }
  if (!file.file_path) throw new Error("Telegram getFile returned no file_path");
  const url = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`file download failed: ${res.status}`);
  await writeFile(destPath, Buffer.from(await res.arrayBuffer()));   // import { writeFile } from "node:fs/promises"
}
```

**(d) Wire the document branch into the message section (lines 218-238).** Add it BEFORE the text/help fallback —
a document message has no `text`, so today it falls through to `helpReply()` at lines 234-238. Branch first:
```ts
// after the whitelist check (bot.ts:226) and BEFORE `const text = msg.text` (bot.ts:233):
const doc = msg.document;
if (doc) {
  const uploadId = String(msg.message_id);
  const { reply } = registerUpload({
    uploadId, chatId, fileId: doc.file_id, fileName: doc.file_name ?? "upload.bin", pending: uploads,
  });
  await transport.sendKeyboard(chatId, reply, buildUploadKeyboard(uploadId));
  continue;
}
```

**(e) Route Yes/No taps in the callback branch (lines 193-216).** Decode first; route confirm/cancel to the upload
handler, everything else stays on `handleApprovalCallback`:
```ts
const decoded = decodeCallback(cb.data ?? "");
if (decoded && (decoded.action === "confirm" || decoded.action === "cancel")) {
  const { reply, answer } = await handleUploadCallback({
    senderId: cb.from.id, allowed, data: cb.data ?? "", pending: uploads,
    download: (fileId, dest) => transport.downloadDocument(fileId, dest),
    ingest: defaultMedicalIngest,
  });
  await transport.answerCallback(cb.id, answer);
  if (reply !== null) await sendSafe(transport, cbChatId, reply);
  continue;
}
// else: existing handleApprovalCallback path (bot.ts:198-210) unchanged
```

**(f) `startPollLoop` (lines 162-168):** add a defaulted param so `telegram.ts:51`'s 2-arg call still compiles:
```ts
uploads: PendingUploadState = createPendingUploadState(),
```

**Imported by:** `src/cli/commands/telegram.ts:5` (constructs `GrammyTransport`, calls `startPollLoop(transport, signal)` at line 51) and `src/telegram/outbound.test.ts`. Keep new params optional/defaulted → no break.
**Test file:** no `bot.test.ts`; loop is covered indirectly. Put the new gating tests in `upload.test.ts`.

---

## 2. Patterns to Follow

### Injected-dependency pure adapter (production default = execa subprocess)
**Source:** `src/telegram/handlers/prioritize.ts`, lines 30-100
```ts
export type HubQuery = (scope: Scope) => Promise<HubResult[]>;          // injected fn (line ~30)
export async function defaultPrioritize(scope: Scope): Promise<HubResult[]> {
  const projectRoot = (await findProjectRoot()) ?? process.cwd();
  const cliEntry = resolveCliEntry();                                   // fleet/runner.ts:9 → dist/cli/index.js
  const result = await execa(process.execPath, [cliEntry, "hub", "priority"], {
    cwd: projectRoot, reject: false, all: true,                         // prioritize.ts:79-83
  });
  if (result.exitCode !== 0) throw new Error(`hub priority failed ...`);// prioritize.ts:85-90
  // parse stdout lines → typed results (prioritize.ts:92-99)
}
```
**Rule:** the handler takes an injected fn; the production default spawns the CLI in a subprocess so the
subsystem (here: `src/medical`) keeps its guardrails authoritative inside the child process. Tests inject a spy.

### Ephemeral in-memory pending-state map (no disk)
**Source:** `src/telegram/handlers/approvals.ts`, lines 24-36, 92-95
```ts
export type PendingCallbackState = Map<number, { action: "adjust" | "reject"; checkpointId: string }>;
export function createPendingState(): PendingCallbackState { return new Map(); }
// stash on tap:
args.pending.set(args.chatId, { action: decoded.action, checkpointId: decoded.checkpointId });
```
**Rule:** process-memory `Map` only, cleared on restart; created in the loop and threaded as a defaulted param.
Mirror EXACTLY for `PendingUploadState`.

### Whitelist re-check on the callback sender id
**Source:** `src/telegram/handlers/approvals.ts`, lines 63-66
```ts
if (!isAllowed(args.senderId, args.allowed)) { return { reply: null, answer: "Denied" }; }
```
**Rule:** re-check the CALLBACK sender id inside `handleUploadCallback` (defense-in-depth, sc-4-5 analog).

### Single outbound chokepoint
**Source:** `src/telegram/outbound.ts`, lines 11-33 (`sendSafe`, line 27)
**Rule:** every text reply goes through `sendSafe(transport, chatId, text)`; keyboard prompts go through
`transport.sendKeyboard`. Handlers NEVER call `transport.sendMessage` directly.

### Temp dir create + guaranteed cleanup
**Source:** test convention `src/research/scheduler.test.ts:23` / `approvals.test.ts:26,32`
```ts
const dir = await mkdtemp(join(tmpdir(), "bober-tg-upload-"));   // node:os tmpdir + node:fs/promises mkdtemp
// ... download into join(dir, fileName) ... then ALWAYS:
await rm(dir, { recursive: true, force: true });                 // on Yes-after-ingest AND on No/discard
```
**Rule:** download to a fresh temp dir; `rm(..., {recursive,force})` in a `finally` so No / errors discard the file.

---

## 3. Medical Ingest Surface (CRITICAL — pin this)

### (a) Directly-importable entry — EXISTS, returns a typed count
`src/medical/ingestion.ts` exports the assembled pipeline pieces (the `medical import` CLI assembles them at
`src/cli/commands/medical.ts:247-257`). There is NO single one-call `importMedicalFile(path)` export — the entry is
a 4-object recipe:
```ts
// src/cli/commands/medical.ts:247-257 — the canonical wiring
const store = new HealthDataStore(dbPath);                       // health-store.ts
const sink = new StoreObservationSink(store);                    // ingestion.ts:16
const normalizer = new IngestionNormalizer(sink);               // ingestion.ts:39
normalizer.register(new AppleHealthAdapter());                  // adapters/apple-health.ts
const result = await normalizer.importFile(file);              // ingestion.ts:57 → IngestionResult
// result: { recordsParsed: number; newRows: number }          // types.ts:196-199
```
`IngestionNormalizer.importFile(filePath)` → `Promise<IngestionResult>` where
`IngestionResult = { recordsParsed: number; newRows: number }` (`src/medical/types.ts:196-199`). `newRows` is the
non-sensitive count to render ("Imported N results"). The Apple Health import is purely LOCAL — no LLM, no egress.

### (b) execa CLI fallback — `agent-bober medical import <file>`
The CLI action (`medical.ts:235-271`) prints exactly:
```
Imported <file>
  records parsed: <N>
  new rows:       <M>
```
(stdout writes at `medical.ts:255-257`). Parse `new rows:` (or `records parsed:`) with a regex, mirroring
`prioritize.ts:92-99`.

### RECOMMENDATION (Q1 hybrid rule): default = execa CLI subprocess.
Reasons: (1) it mirrors the closest sibling `defaultPrioritize` (subprocess isolation for a heavier subsystem);
(2) re-assembling the 4-object recipe inside the Telegram handler would DUPLICATE `medical.ts:247-253` —
nonGoal #2 ("Do not reimplement medical parsing or storage"); (3) it keeps ALL medical wiring + guardrails
authoritative in the medical module/subprocess. Implement `defaultMedicalIngest(filePath)` as:
```ts
export async function defaultMedicalIngest(filePath: string): Promise<{ recordsParsed: number; newRows: number }> {
  const projectRoot = (await findProjectRoot()) ?? process.cwd();
  const cliEntry = resolveCliEntry();                                   // fleet/runner.ts:9
  const r = await execa(process.execPath, [cliEntry, "medical", "import", filePath], {
    cwd: projectRoot, reject: false, all: true,
  });
  if (r.exitCode !== 0) throw new Error(`medical import failed (exit ${r.exitCode ?? -1}): ${(r.all ?? "").slice(0,300)}`);
  const parsed = /records parsed:\s*(\d+)/.exec(r.stdout ?? "");
  const rows   = /new rows:\s*(\d+)/.exec(r.stdout ?? "");
  return { recordsParsed: parsed ? Number(parsed[1]) : 0, newRows: rows ? Number(rows[1]) : 0 };
}
```
ALTERNATIVE (typed, no stdout parse): import the 4 objects from §3(a). Acceptable, but it relocates the medical
wiring into the Telegram adapter. If chosen, keep it byte-identical to `medical.ts:247-257`.

---

## 4. Medical Egress + Consent Guardrails — DO NOT duplicate or bypass

These already enforce the medical safety invariants. The Telegram adapter must NOT re-implement, weaken, or
skip them (nonGoal #5). The per-upload Telegram opt-in is an ADDITIONAL transport-boundary gate ON TOP, not a
replacement for them.

| Guard | Location | What it enforces |
|-------|----------|------------------|
| `EgressGuard` | `src/medical/egress.ts:17` (`isAllowed` 35, `assertAllowed` 54, `fromConfig` 25) | 3 independent egress axes `cloud-inference` / `literature-retrieval` / `device-connection`, ALL default FALSE (egress.ts:5,21). Code-enforced zero-egress; throws if an axis is used without opt-in. |
| `ConsentGate` | `src/medical/consent.ts:21` (`hasConsent` 39, `current` 47, `recordConsent` 75) | Fail-closed first-run consent at `.bober/medical/consent.json`; missing/corrupt → false (consent.ts:38,62). |
| `AuditLog` | `src/medical/audit.ts` (PHI rule at audit.ts:12-13) | Append-only audit; entries hold IDs/enums ONLY — NEVER values/counts/names. |

NOTE: the `medical import` (Apple Health) path is LOCAL and does NOT touch an egress axis (egress gating applies
to `import-labs`→cloud-inference at medical.ts:172 and `whoop sync`→device-connection at medical.ts:67). So the
adapter does not need to read egress config; it just hands the local file to the medical path, which owns all guards.

---

## 5. Telegram Document + File shapes (grammy 1.44.0 / @grammyjs/types)

`@grammyjs/types/message.d.ts:760` — `Document`:
```ts
export interface Document {
  file_id: string;            // used to download/reuse
  file_unique_id: string;
  thumbnail?: PhotoSize;
  file_name?: string;         // original filename
  mime_type?: string;
  file_size?: number;
}
```
`@grammyjs/types/message.d.ts` — `File` (returned by getFile):
```ts
export interface File { file_id: string; file_unique_id: string; file_size?: number; file_path?: string; }
// file_path docstring: "Use https://api.telegram.org/file/bot<token>/<file_path> to get the file."
```
grammy API: `Api.getFile(file_id, signal?): Promise<File>` (`node_modules/grammy/out/core/api.d.ts:639`). The
20MB bot download limit applies. `Bot.token` is `readonly` (`node_modules/grammy/out/bot.d.ts:106`).
`update.message.document` is the document field (Message.document, message.d.ts:186). The poll loop only consumes
a compatible subset, so extend `TelegramUpdate.message` with `document?: { file_id; file_name?; mime_type? }`
(provider-agnostic — keep the full grammy types inside bot.ts only, principles.md:28).

---

## 6. handleUploadCallback — Yes/No logic (mirror approvals.ts)

```ts
export async function handleUploadCallback(args: {
  senderId: number; allowed: AllowedUsers; data: string; pending: PendingUploadState;
  download: DownloadFn; ingest: MedicalIngest;
}): Promise<{ reply: string | null; answer: string }> {
  if (!isAllowed(args.senderId, args.allowed)) return { reply: null, answer: "Denied" }; // approvals.ts:63-66
  const decoded = decodeCallback(args.data);
  if (!decoded) return { reply: null, answer: "Unknown" };
  const up = args.pending.get(decoded.checkpointId);          // checkpointId == uploadId
  if (!up) return { reply: "Upload expired or already handled.", answer: "Gone" };
  args.pending.delete(decoded.checkpointId);                  // single-shot; consume the stash

  if (decoded.action === "cancel") {                          // No → ingest NOTHING (sc-5-4)
    return { reply: "Discarded — nothing was ingested.", answer: "Cancelled" };
  }
  // confirm (Yes) → download then ingest EXACTLY once (sc-5-3)
  const dir = await mkdtemp(join(tmpdir(), "bober-tg-upload-"));
  const dest = join(dir, up.fileName);
  try {
    await args.download(up.fileId, dest);
    const { newRows } = await args.ingest(dest);             // NON-SENSITIVE count only
    return { reply: `Imported ${newRows} results into local medical store.`, answer: "Imported" };
  } finally {
    await rm(dir, { recursive: true, force: true });        // discard temp file after ingest (nonGoal #4)
  }
}
```
Key invariants: on No / no-callback the `ingest` spy is NEVER called; on Yes it is called EXACTLY once with the
downloaded path; the reply contains only an integer count — no marker values/names (nonGoal #3).

---

## 7. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `encodeCallback` | `src/telegram/keyboard.ts:32` | `(action, checkpointId) => string` | Compact `<code>:<id>` callback_data (≤64B). |
| `decodeCallback` | `src/telegram/keyboard.ts:41` | `(data) => {action, checkpointId} \| null` | Split on first `:`; action-agnostic. |
| `buildApprovalKeyboard` | `src/telegram/keyboard.ts:59` | `(checkpointId) => InlineKeyboardSpec` | Pattern to copy for `buildUploadKeyboard`. |
| `sendSafe` | `src/telegram/outbound.ts:27` | `(transport, chatId, content) => Promise<void>` | The ONLY outbound text chokepoint. |
| `isAllowed` | `src/telegram/whitelist.ts` | `(id, allowed) => boolean` | Whitelist check (re-check callback sender). |
| `findProjectRoot` | `src/utils/fs.ts:58` | `() => Promise<string \| undefined>` | Resolve project root for execa cwd. |
| `ensureDir` | `src/utils/fs.ts:45` | `(path) => Promise<void>` | mkdir -p via node:fs/promises. |
| `resolveCliEntry` | `src/fleet/runner.ts:9` | `() => string` | Path to `dist/cli/index.js` for execa. |
| `IngestionNormalizer` | `src/medical/ingestion.ts:39` | `importFile(filePath) => Promise<IngestionResult>` | Direct-import ingest entry (alt). |
| `StoreObservationSink` | `src/medical/ingestion.ts:16` | `new (store)` | Sink for the direct-import path. |
| `EgressGuard` | `src/medical/egress.ts:17` | `fromConfig(config)`, `isAllowed(axis)` | Authoritative egress gates — do not touch. |
| `ConsentGate` | `src/medical/consent.ts:21` | `hasConsent()`, `recordConsent(...)` | Authoritative consent — do not touch. |
| `execa` | `node_modules/execa` | `execa(file, args, opts)` | Subprocess for the CLI fallback (see prioritize.ts:79). |

Utilities reviewed: `src/utils/`, `src/telegram/`, `src/medical/`, `src/fleet/` — above are the applicable ones.

---

## 8. Prior Sprint Output

### Sprint 1: Telegram transport + poll loop
**Created:** `src/telegram/outbound.ts` (`sendSafe` line 27, `TelegramTransport` line 11),
`src/telegram/bot.ts` (`BotTransport` 56, `GrammyTransport` 85, `startPollLoop` 162 — grammy ONLY here),
`src/telegram/whitelist.ts` (`isAllowed`).
**Connection:** extend `BotTransport`/`GrammyTransport` with `downloadDocument`; add the document branch + Yes/No
routing in `startPollLoop`; reply via `sendSafe`.

### Sprint 4: inline keyboard + approval handler
**Created:** `src/telegram/keyboard.ts` (codec + `buildApprovalKeyboard`), `src/telegram/handlers/approvals.ts`
(`PendingCallbackState` 32, `createPendingState` 34, `handleApprovalCallback` 54).
**Connection:** REUSE `keyboard.ts` for the Yes/No keyboard (add `confirm`/`cancel` + `buildUploadKeyboard`);
MIRROR the ephemeral chatId/id-keyed pending-state map + callback handler for pending uploads.

---

## 9. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM everywhere** — all imports use `.js` extensions, NodeNext (line 27). `node:fs/promises` only, no sync fs (line 42).
- **Provider-agnostic interfaces** — never leak SDK types outside the adapter file; grammy stays in `bot.ts` (line 28; in-code citations principles.md:28,41 in keyboard.ts:2 and approvals.ts:11).
- **`type` imports** — `consistent-type-imports` enforced (line 35); use `import type { ... }`.
- **No `any`** — `no-explicit-any` warned; prefer `unknown` + narrowing (line 40). Zero lint errors is a hard gate (line 19).
- generatorNotes echo these: "ESM .js imports, `import type`, no `any`, node:fs/promises only."

### Architecture Decisions
No `.bober/architecture/` ADR is specific to the Telegram frontend. Medical egress is governed by ADR-6
(zero-egress axes, cited in `egress.ts:1`). No new ADR needed for this sprint.

### Other Docs
nonGoals (contract): no auto-ingest; do not reimplement medical parsing/storage; never echo marker values/names;
do not persist the file outside the medical ingest path; do not weaken/bypass medical guards.

---

## 10. Testing Patterns

### Unit Test Pattern (injected-spy, mirror capture.test.ts + approvals.test.ts)
**Source:** `src/telegram/handlers/capture.test.ts:11-24` (spy counts calls); `approvals.test.ts:5,22-23` (vitest imports, ALLOWED, NOW).
```ts
import { describe, it, expect } from "vitest";
import { parseAllowedUsers } from "../whitelist.js";
import { encodeCallback } from "../keyboard.js";
import {
  createPendingUploadState, registerUpload, handleUploadCallback, buildUploadPrompt, LOCAL_INGEST_DEST,
} from "./upload.js";
import type { MedicalIngest, DownloadFn } from "./upload.js";

const ALLOWED = parseAllowedUsers({ TELEGRAM_ALLOWED_USERS: "42" });

const spyIngest = () => {
  const calls: string[] = [];
  const fn: MedicalIngest = async (p) => { calls.push(p); return { recordsParsed: 7, newRows: 5 }; };
  return { fn, calls };
};
const spyDownload = () => {
  const calls: Array<[string, string]> = [];
  const fn: DownloadFn = async (id, dest) => { calls.push([id, dest]); };
  return { fn, calls };
};

describe("upload opt-in gate", () => {
  it("sc-5-2: a document with NO confirmation never invokes ingest", async () => {
    const ingest = spyIngest(); const dl = spyDownload();
    const pending = createPendingUploadState();
    registerUpload({ uploadId: "1", chatId: 7, fileId: "F", fileName: "labs.pdf", pending });
    // no callback ever arrives → ingest must be zero
    expect(ingest.calls).toEqual([]);
    expect(dl.calls).toEqual([]);
  });

  it("sc-5-3: explicit Yes downloads then invokes ingest exactly once", async () => {
    const ingest = spyIngest(); const dl = spyDownload();
    const pending = createPendingUploadState();
    registerUpload({ uploadId: "1", chatId: 7, fileId: "F", fileName: "labs.pdf", pending });
    const res = await handleUploadCallback({
      senderId: 42, allowed: ALLOWED, data: encodeCallback("confirm", "1"),
      pending, download: dl.fn, ingest: ingest.fn,
    });
    expect(dl.calls.length).toBe(1);
    expect(dl.calls[0][0]).toBe("F");                 // downloaded the right file_id
    expect(ingest.calls.length).toBe(1);              // ingest exactly once
    expect(ingest.calls[0]).toBe(dl.calls[0][1]);     // ingested the downloaded path
    expect(res.reply).toMatch(/Imported \d+/);
  });

  it("sc-5-4: No discards the file and never invokes ingest", async () => {
    const ingest = spyIngest(); const dl = spyDownload();
    const pending = createPendingUploadState();
    registerUpload({ uploadId: "1", chatId: 7, fileId: "F", fileName: "labs.pdf", pending });
    await handleUploadCallback({
      senderId: 42, allowed: ALLOWED, data: encodeCallback("cancel", "1"),
      pending, download: dl.fn, ingest: ingest.fn,
    });
    expect(ingest.calls).toEqual([]);                 // zero ingest
    expect(dl.calls).toEqual([]);                     // not even downloaded
    expect(pending.size).toBe(0);                     // stash discarded
  });

  it("sc-5-5: prompt names the LOCAL ingest destination; reply leaks no marker values", async () => {
    const prompt = buildUploadPrompt("labs.pdf");
    expect(prompt).toContain(LOCAL_INGEST_DEST);                       // discloses destination BEFORE confirm
    expect(prompt.toLowerCase()).toContain("not end-to-end");         // discloses non-E2E
    const ingest = spyIngest(); const dl = spyDownload();
    const pending = createPendingUploadState();
    registerUpload({ uploadId: "1", chatId: 7, fileId: "F", fileName: "labs.pdf", pending });
    const res = await handleUploadCallback({
      senderId: 42, allowed: ALLOWED, data: encodeCallback("confirm", "1"),
      pending, download: dl.fn, ingest: ingest.fn,
    });
    expect(res.reply).toMatch(/^Imported \d+/);       // count/summary only
    expect(res.reply).not.toMatch(/\d+\.\d+/);        // no decimal marker values echoed
  });
});
```
**Runner:** vitest. **Assertion style:** `expect`. **Mock approach:** injected spy fns (NO `vi.mock`, NO network,
NO real medical/grammy — principles.md "No test mocks for filesystem"; use temp dirs if a real fs path is needed).
**File naming:** co-located `upload.test.ts`. **Location:** `src/telegram/handlers/`.

### E2E Test Pattern
Not applicable — no Playwright in this repo. sc-5-6 is a manual check.

---

## 11. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/commands/telegram.ts` | `bot.ts` (`GrammyTransport`, `startPollLoop`) | low | New `startPollLoop` param is defaulted; 2-arg call at line 51 must still compile. |
| `src/telegram/outbound.test.ts` | `bot.ts` | low | Imports BotTransport/types — additive method on interface; fakes implementing BotTransport in tests may need the new `downloadDocument` (check & extend test fakes). |
| `src/telegram/handlers/approvals.ts` + `approvals.test.ts` | `keyboard.ts` codec | low | `CallbackAction`/`CODE`/`ACTION` are extended additively; existing a/j/r round-trips unchanged. |
| `src/telegram/keyboard.test.ts` | `keyboard.ts` | low | Existing approve/adjust/reject cases must still pass after the union grows. |
| `src/cli/commands/medical.ts` | (invoked via execa) | none | NOT modified — the adapter calls it as a subprocess; its tests are untouched. |

### Existing Tests That Must Still Pass
- `src/telegram/keyboard.test.ts` — codec + buildApprovalKeyboard; verify a/j/r still round-trip after adding y/n.
- `src/telegram/handlers/approvals.test.ts` — callback gating; the callback branch reorder (decode-first) must not change approval routing.
- `src/telegram/outbound.test.ts` — if it defines a fake BotTransport, add a no-op `downloadDocument` so it still type-checks.
- `src/cli/commands/medical.test.ts` — unchanged; confirms the `medical import` stdout count format the execa fallback parses.

### Features That Could Be Affected
- **Approval/keyboard flow (Sprint 4)** — shares `keyboard.ts` codec + the callback branch in `bot.ts`. Verify Approve/Adjust/Reject taps still resolve (decode-first routing must fall through to `handleApprovalCallback` for a/j/r).
- **Medical ingest (`src/medical`)** — invoked as a subprocess; verify zero changes to that module and that the guards stay authoritative there.

### Recommended Regression Checks
1. `npm run build` — zero tsc errors (sc-5-1).
2. `npx vitest run src/telegram/handlers/upload.test.ts` — the 4 gating tests (sc-5-2..5-5) pass.
3. `npx vitest run src/telegram/keyboard.test.ts src/telegram/handlers/approvals.test.ts src/telegram/outbound.test.ts` — Sprint-1/4 telegram tests still green.
4. `npx eslint src/telegram` — zero errors (consistent-type-imports, no-explicit-any).
5. Grep self-check: confirm `grammy` is imported ONLY in `src/telegram/bot.ts` (`grep -rn "from \"grammy\"" src/telegram`).

---

## 12. Implementation Sequence

1. **`src/telegram/keyboard.ts`** — extend `CallbackAction` with `"confirm" | "cancel"`, add `y`/`n` to `CODE`/`ACTION`, add `buildUploadKeyboard(uploadId)`. (types/util layer — no deps.)
   - Verify: `npx vitest run src/telegram/keyboard.test.ts` (add + pass Yes/No round-trip).
2. **`src/telegram/handlers/upload.ts`** — `PendingUploadState`/`createPendingUploadState`, `DownloadFn`/`MedicalIngest` types, `LOCAL_INGEST_DEST`/`buildUploadPrompt`, `registerUpload`, `handleUploadCallback` (§6), `defaultMedicalIngest` (execa, §3b).
   - Verify: imports resolve; `tsc` clean for this file.
3. **`src/telegram/handlers/upload.test.ts`** — the 4 spy-based gating tests (§10).
   - Verify: `npx vitest run src/telegram/handlers/upload.test.ts` green (sc-5-2..5-5).
4. **`src/telegram/bot.ts`** — (a) add `document?` to `TelegramUpdate.message`; (b) add `downloadDocument` to `BotTransport`; (c) implement it on `GrammyTransport` (getFile + fetch + writeFile); (d) document branch in the message section; (e) decode-first Yes/No routing in the callback branch; (f) defaulted `uploads` param on `startPollLoop`.
   - Verify: `telegram.ts:51` still compiles (2-arg call); grammy still only in bot.ts.
5. **Run full verification** — `npm run build` (sc-5-1), `npx vitest run src/telegram` (all telegram tests), `npx eslint src/telegram`.

---

## 13. Pitfalls & Warnings

- **NEVER download or call ingest before Yes.** `registerUpload` (on the document message) must only stash + send the keyboard. Download happens exclusively in `handleUploadCallback`'s `confirm` branch (sc-5-2/sc-5-4 hinge on this).
- **Reply must be count-only.** Use `newRows` integer; never interpolate marker values/names/panels (nonGoal #3). The CLI subprocess already keeps PHI out (audit.ts PHI rule); do not re-add it.
- **grammy containment.** `getFile`/download/token use stays in `GrammyTransport` (bot.ts). `upload.ts` and `keyboard.ts` must NOT import grammy (principles.md:28). Build the download URL from `this.bot.token` + `file.file_path`; there is NO `@grammyjs/files` plugin installed.
- **Document messages have no `text`.** Today they hit the `helpReply()` fallback at bot.ts:234-238 — branch on `msg.document` BEFORE that fallback, after the whitelist check.
- **Decode-first in the callback branch.** Route `confirm`/`cancel` to the upload handler and let `approve`/`adjust`/`reject` fall through to `handleApprovalCallback` — do not break Sprint-4 approvals.
- **Always discard the temp file.** `rm(dir, {recursive,force})` in a `finally` so a failed download/ingest or a No never leaves bytes on disk (nonGoal #4). Use `mkdtemp` under `os.tmpdir()`.
- **Do NOT touch the medical guards.** No EgressGuard/ConsentGate logic in the Telegram adapter — the medical module/subprocess owns them. The opt-in is an ADDITIONAL transport gate, not a substitute.
- **64-byte callback_data.** Keep `uploadId` short (the document `message_id` as a string). Truncation would break the `pending` lookup silently (keyboard.ts:12).
- **CLI handlers must not throw.** If you add anything to `medical.ts`, follow its set-`process.exitCode`-and-return convention (medical.ts:268-269) — but this sprint should NOT need to modify medical.ts.
