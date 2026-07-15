# Sprint Briefing: Plain text → zero-friction task inbox capture

**Contract:** sprint-spec-20260628-telegram-frontend-2
**Generated:** 2026-06-30
**Spec:** spec-20260628-telegram-frontend (Sprint 2 of 6)
**Depends on:** sprint-spec-20260628-telegram-frontend-1 (commit eb680c2)

---

## 0. TL;DR for the Generator

Build three things, in order:
1. `src/telegram/router.ts` — pure `classify(message)` → `{kind:"command",...}` | `{kind:"text",text}` (+ `router.test.ts`).
2. `src/telegram/handlers/capture.ts` — `handleCapture(text, capture)` that calls an **injected** inbox-capture sink once and returns a confirmation string containing the title (+ `capture.test.ts` with a fake sink, NO real FactStore). `handlers/` does not exist yet — creating it is fine.
3. Wire both into `src/telegram/bot.ts`'s `startPollLoop` so whitelisted plain text → capture → `sendSafe`, and `/`-prefixed messages → a command-dispatch stub (NOT captured).

**Capture surface decision (Q1 hybrid rule):** the task-inbox module **DOES export a stable capture function** — `captureTask` at `src/hub/task-inbox.ts:22`. Per the hybrid rule ("import if exported, else shell out"), the default wrapper should **import `captureTask`**. An `execa` fallback to `agent-bober task add "<text>"` is the documented alternative (pattern provided in §3/§5). Either way, the handler takes the capture fn as an injected parameter so the unit test passes a fake.

**Hard invariants (from contract nonGoals/evaluatorNotes):**
- Reply ONLY through `sendSafe` — never call `transport.sendMessage` directly.
- Capture is zero-friction: never prompt for due date / domain / any field. Keep message text **verbatim** as the title (no parse/enrich).
- `/`-prefixed messages produce **zero** inbox tasks.
- ESM `.js` imports, `import type`, no `any`.

---

## 1. Target Files

### src/telegram/router.ts (create)

**Directory pattern:** `src/telegram/*.ts` — kebab/lowercase single-word files, each a focused module with `// ── Section ──` headers and rich JSDoc (see `outbound.ts`, `whitelist.ts`). Pure modules (`whitelist.ts`) declare "No side effects, no network" in the header.
**Most similar existing file:** `src/telegram/whitelist.ts` (pure, typed, exported functions + a discriminated/union return) — follow this structure.
**Recommended shape** (discriminated union; keep text verbatim):
```ts
/** router.ts — Pure classifier: slash-command vs plain text. No side effects, no network. */

// ── Types ─────────────────────────────────────────────────────────────
export type RoutedMessage =
  | { kind: "command"; name: string; args: string }
  | { kind: "text"; text: string };

// ── classify ──────────────────────────────────────────────────────────
/** A message whose first non-space char is '/' is a command; everything else is capture text. */
export function classify(message: string): RoutedMessage {
  const trimmed = message.trimStart();
  if (trimmed.startsWith("/")) {
    const body = trimmed.slice(1);
    const sp = body.search(/\s/);
    const name = sp === -1 ? body : body.slice(0, sp);
    const args = sp === -1 ? "" : body.slice(sp + 1).trim();
    return { kind: "command", name, args };
  }
  return { kind: "text", text: message }; // verbatim — do not trim/parse (generatorNotes)
}
```

### src/telegram/handlers/capture.ts (create)

**Directory:** `src/telegram/handlers/` **does not exist yet** (verified: `ls src/telegram/` → bot.ts, outbound.ts, whitelist.ts + tests only). Creating the subdir is expected — the contract's `estimatedFiles` puts the handler there. Note the **extra `../` depth** for imports from a `handlers/` subdir (e.g. `../outbound.js`, `../../hub/task-inbox.js`, `../../fleet/runner.js`).
**Pattern to mirror:** the injected-default-with-execa DI pattern in `src/chat/run-spawner.ts:31-39, 74-78` (a typed injected fn whose default wraps `execa`; tests pass a fake). The handler returns a **content string** (like `helpReply()` at `bot.ts:78`); the loop passes it to `sendSafe`.
**Recommended shape:**
```ts
/** handlers/capture.ts — Route whitelisted plain text into the task inbox (zero-friction). */
import type { Finding } from "../../hub/finding.js";

/** Injected inbox sink. Default persists via captureTask; tests pass a fake (no FactStore). */
export type InboxCapture = (text: string) => Promise<{ id?: string; title: string }>;

/**
 * Captures `text` as one open task (title = text verbatim, no other field) and
 * returns a one-line confirmation containing the title. Never prompts for fields.
 */
export async function handleCapture(text: string, capture: InboxCapture): Promise<string> {
  const { title, id } = await capture(text);
  return id ? `Captured: ${title} (#${id})` : `Captured: ${title}`;
}
```
For the **default** capture (non-test) wrapper, see §3 — import `captureTask` (preferred per hybrid rule) or the `execa` fallback.

### src/telegram/bot.ts (modify)

**Relevant section — `startPollLoop` whitelisted branch (lines 120-137):**
```ts
    for (const update of updates) {
      offset = update.update_id + 1;
      const msg = update.message;
      if (!msg) continue;
      const senderId = msg.from?.id;
      const chatId = msg.chat.id;
      if (senderId === undefined) continue;
      if (!isAllowed(senderId, allowed)) {
        await sendSafe(transport, chatId, denialReply(senderId));
        continue;
      }
      // Whitelisted sender: reply with the /start help stub.   ← REPLACE THIS LINE
      await sendSafe(transport, chatId, helpReply());           ← with router dispatch
    }
```
**Change:** after the whitelist check, route on `msg.text`. Empty/absent text → keep help stub (or ignore). Otherwise `const routed = classify(msg.text)`:
- `routed.kind === "text"` → `const reply = await handleCapture(routed.text, captureFn); await sendSafe(transport, chatId, reply);`
- `routed.kind === "command"` → command-dispatch stub. For `/start` keep `helpReply()`; everything else a placeholder ("command not yet supported" / fall through) — Sprints 3-4 populate real dispatch. The key invariant: **commands are NOT captured** (zero inbox tasks).

**Imports `bot.ts` already uses (lines 6-10):**
- `import { Bot } from "grammy";` (sole grammy consumer — do not add grammy elsewhere)
- `import type { TelegramTransport } from "./outbound.js";` / `import { sendSafe } from "./outbound.js";`
- `import { isAllowed, parseAllowedUsers, denialReply } from "./whitelist.js";`
- Add: `import { classify } from "./router.js";` and `import { handleCapture } from "./handlers/capture.js";` (+ the default capture wrapper / its type).

**Imported by:** `src/cli/commands/telegram.ts:5` (`import { GrammyTransport, startPollLoop } from "../../telegram/bot.js"`) and `src/telegram/outbound.test.ts:11-12`.
**Test file:** `src/telegram/outbound.test.ts` exists and exercises `startPollLoop` directly via an injected `BotTransport` spy (see §6). Your bot.ts change must keep those 3 loop tests green (see §7).

**Wiring note (default capture into the loop):** `startPollLoop(transport, signal)` has no capture param today. Cleanest additive option: give it an **optional** 3rd param `capture: InboxCapture = defaultCapture` (default = the import/execa wrapper), so existing callers (`telegram.ts:50`, `outbound.test.ts`) stay compatible and tests can inject a fake. Mirrors the `run-spawner.ts` optional-injected-default convention.

---

## 2. Patterns to Follow

### Handler returns a content string; loop funnels it through sendSafe
**Source:** `src/telegram/bot.ts:71-85` (`helpReply`) + `src/telegram/outbound.ts:27-33` (`sendSafe`)
```ts
export function helpReply(): string { return "Welcome! ..."; }
// ...loop:
await sendSafe(transport, chatId, helpReply());
```
**Rule:** Handlers (incl. `handleCapture`) NEVER touch the transport — they return a string; only the loop calls `sendSafe`. Do not call `transport.sendMessage` anywhere outside `outbound.ts`.

### Injected fn with an execa-backed default (DI for testability)
**Source:** `src/chat/run-spawner.ts:31-39, 74-78`
```ts
export type SpawnFn = (file: string, args: string[], options: {...}) => {...};
// ...
this.spawnFn = opts.spawn ??
  ((file, args, options) =>
    execa(file, args, options) as unknown as { pid?: number; unref: () => void });
```
**Rule:** Production default wraps `execa`/real I/O; the parameter is overridable so the unit test injects a fake. Apply this to `InboxCapture`.

### Provider-agnostic + clock-at-boundary
**Source:** `.bober/principles.md:28` (provider-agnostic), `src/cli/commands/task.ts:351-352` (`// Stamp wall-clock time at handler boundary — NEVER inside the store`), `src/hub/task-inbox.ts:20-21` (`PURE: never calls Date.now()`)
**Rule:** `captureTask` is PURE and takes `now` injected. If your default wrapper imports it, stamp `const now = new Date().toISOString()` at the wrapper boundary (like `task.ts:352`), not inside any pure helper. The router/handler stay clock-free.

### Discriminated-union return (pure module)
**Source:** `src/telegram/whitelist.ts` (pure typed functions) + this sprint's `RoutedMessage`.
**Rule:** Use a `kind`-discriminated union for the router result so `bot.ts` can switch exhaustively with no `any`.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `captureTask` | `src/hub/task-inbox.ts:22` | `(store: FactStore, text: string, opts: { domain?: string; now: string }) => Promise<Finding>` | **THE zero-friction capture.** Builds an open `action` Finding (title=text.trim(), domain defaults to `"inbox"`, neutral urgency/severity) and persists it. PURE re `now`. **Import this for the default sink (hybrid rule).** |
| `runTaskAdd` | `src/cli/commands/task.ts:76` | `(store, text, opts, now) => Promise<void>` | CLI DI core wrapping `captureTask` + chalk output. Reference for store lifecycle; not directly importable as a sink (writes to stdout, returns void). |
| `registerTaskCommand` | `src/cli/commands/task.ts:335` | `(program: Command) => void` | Registers `task add <text> [--domain]`, `task list`, etc. This is the `agent-bober task add "<text>"` execa-fallback target. |
| `sendSafe` | `src/telegram/outbound.ts:27` | `(transport: TelegramTransport, chatId: number, content: string) => Promise<void>` | **Sole outbound funnel.** Reply ONLY through this. |
| `helpReply` | `src/telegram/bot.ts:78` | `() => string` | `/start` help stub — reuse for the `/start` command branch. |
| `isAllowed` / `parseAllowedUsers` / `denialReply` | `src/telegram/whitelist.ts:32 / 16 / 42` | see file | Whitelist gate (already applied in the loop before your branch). |
| `resolveCliEntry` | `src/fleet/runner.ts:9` | `() => string` | Resolves `dist/cli/index.js` — use for the execa fallback (`execa(process.execPath, [resolveCliEntry(), "task", "add", text])`). |
| `FactStore` | `src/state/facts.ts:136` | `new FactStore(dbPath: string, opts?)` | SQLite-backed store. Use `":memory:"` in tests if you ever need a real one (you should NOT — inject a fake sink instead). |
| `factsDbPath` | `src/state/facts.ts:77` | `(projectRoot: string, namespace?: string) => string` | DB path for the import-based default wrapper. |
| `ensureFactsDir` | `src/state/facts.ts:86` | `(projectRoot: string, namespace?: string) => Promise<void>` | Ensure memory dir exists before opening the store. |
| `findProjectRoot` | `src/utils/fs.ts` (imported at `task.ts:17`) | `() => Promise<string \| undefined>` | Resolve project root for the import-based wrapper. |

**Utilities reviewed:** `src/utils/` (`git.ts` execa patterns, `fs.ts` root resolver), `src/state/facts.ts`, `src/hub/` (task-inbox, finding, finding-store), `src/fleet/runner.ts`, `src/chat/run-spawner.ts`. No router/classify or telegram-capture utility exists yet — both are new.

### Default capture wrapper — two concrete options

**Option A (RECOMMENDED per hybrid rule — `captureTask` IS exported):** import it and manage store lifecycle exactly like `task.ts:346-359`:
```ts
import { captureTask } from "../../hub/task-inbox.js";
import { FactStore, factsDbPath, ensureFactsDir } from "../../state/facts.js";
import { findProjectRoot } from "../../utils/fs.js";

async function defaultCapture(text: string): Promise<{ id?: string; title: string }> {
  const projectRoot = (await findProjectRoot()) ?? process.cwd();
  await ensureFactsDir(projectRoot);                 // namespace omitted → default pool
  const now = new Date().toISOString();              // clock at boundary
  const store = new FactStore(factsDbPath(projectRoot));
  try {
    const f = await captureTask(store, text, { now }); // domain omitted → "inbox" pool
    return { id: f.id, title: f.title };
  } finally {
    store.close();
  }
}
```
(`task.ts` also resolves a memory namespace via `resolveDefaultNamespace` — that helper is **private** to task.ts. Omitting the namespace falls back to the default `.bober/memory/` pool, which matches the contract's "hub pool, no domain tag" assumption. Replicate the namespace logic only if you decide it's needed.)

**Option B (execa fallback — reuses the full CLI action incl. namespace):**
```ts
import { execa } from "execa";
import { resolveCliEntry } from "../../fleet/runner.js";

async function defaultCapture(text: string): Promise<{ id?: string; title: string }> {
  const { stdout } = await execa(process.execPath, [resolveCliEntry(), "task", "add", text], { reject: false });
  // stdout contains "Captured task <id>" — id parse is optional; title is the input text.
  return { title: text.trim() };
}
```

---

## 4. Prior Sprint Output (Sprint 1, commit eb680c2)

### `src/telegram/outbound.ts` — exports `TelegramTransport`, `sendSafe`
- `interface TelegramTransport { sendMessage(chatId: number, text: string): Promise<void> }` (`:11`)
- `async function sendSafe(transport, chatId, content): Promise<void>` (`:27`) — sole funnel.
**Connection:** every reply from the capture handler goes back through `sendSafe`.

### `src/telegram/bot.ts` — exports `TelegramUpdate`, `BotTransport`, `GrammyTransport`, `helpReply`, `startPollLoop`
- `interface TelegramUpdate { update_id: number; message?: { message_id; from?: {id}; chat: {id}; text? } }` (`:20-28`) — the message shape you classify (`update.message.text`).
- `interface BotTransport extends TelegramTransport { getUpdates(offset): Promise<TelegramUpdate[]> }` (`:37-39`)
- `async function startPollLoop(transport: BotTransport, signal: AbortSignal): Promise<void>` (`:99-102`) — **the file you wire the router/handler into**.
**Connection:** the whitelisted branch (`bot.ts:135-136`) currently always sends `helpReply()`; replace with router dispatch.

### `src/telegram/whitelist.ts` — exports `isAllowed`, `parseAllowedUsers`, `denialReply`, type `AllowedUsers`
**Connection:** already enforced in the loop before your branch — you do not re-check whitelisting inside the handler.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM everywhere** — all imports use `.js` extensions (NodeNext). (`principles.md:25`)
- **Use `type` imports** — ESLint `consistent-type-imports`. (`principles.md:34`)
- **No `any` without justification** — prefer `unknown` + narrowing. (`principles.md:41`)
- **Provider-agnostic interfaces** — never leak SDK (grammy) types outside `bot.ts`. (`principles.md:28`)
- **Tests collocated** — `*.test.ts` next to `*.ts`, Vitest. (`principles.md:20`)
- **Section comments** — `// ── Section ──` box-drawing headers. (`principles.md`, see whitelist.ts)
- **Prefix unused params with `_`** — only escape hatch for unused. (`principles.md:36`)

### Architecture Decisions
No `.bober/architecture/` ADR specific to telegram-frontend Sprint 2 was found relevant. Contract `assumptions` reference research §3a (zero-required-field capture = `agent-bober task add`, default hub pool, no domain tag) — already encoded in `captureTask` defaults (`task-inbox.ts:9,36`).

### CLI handler convention
**Source:** `src/cli/commands/task.ts:6-9` and `telegram.ts:53` — "CLI handlers MUST NOT throw. Set `process.exitCode=1` and return." This is the CLI-command rule; your router/handler are library modules and may return values normally, but if you touch `telegram.ts` keep this rule.

---

## 6. Testing Patterns

**Runner:** Vitest. **Assertion style:** `expect(...)`. **Mock approach:** inject a fake (duck-typed object that records calls) — `vi.spyOn` only for stdout/stderr suppression. **File naming:** `*.test.ts` collocated next to source. **Location:** same dir (handler test → `src/telegram/handlers/capture.test.ts`).

### Injected-fake-sink pattern (the template for capture.test.ts)
**Source:** `src/telegram/outbound.test.ts:17-36` (records calls on a duck-typed spy):
```ts
import { describe, it, expect } from "vitest";

function makeSpy(): TelegramTransport & { calls: Array<{ chatId: number; text: string }> } {
  const calls: Array<{ chatId: number; text: string }> = [];
  return { calls, async sendMessage(chatId, text) { calls.push({ chatId, text }); } };
}

it("calls transport.sendMessage exactly once ...", async () => {
  const spy = makeSpy();
  await sendSafe(spy, 123, "hello world");
  expect(spy.calls).toHaveLength(1);
  expect(spy.calls[0]).toMatchObject({ chatId: 123, text: "hello world" });
});
```
**Apply to `capture.test.ts`** — fake `InboxCapture` sink, NO FactStore:
```ts
import { describe, it, expect } from "vitest";
import { handleCapture } from "./capture.js";

it("sc-2-3/sc-2-4: captures once with verbatim title, no field prompt", async () => {
  const calls: string[] = [];
  const fakeSink = async (text: string) => { calls.push(text); return { id: "abc123", title: text }; };
  const reply = await handleCapture("renew passport", fakeSink);
  expect(calls).toEqual(["renew passport"]);     // invoked exactly once, raw text
  expect(reply).toContain("renew passport");      // confirmation contains the title
});
```

### router.test.ts (sc-2-2)
```ts
import { describe, it, expect } from "vitest";
import { classify } from "./router.js";

it("classifies '/start' as a command", () => {
  const r = classify("/start");
  expect(r.kind).toBe("command");
  if (r.kind === "command") expect(r.name).toBe("start");
});
it("classifies plain text as capture text", () => {
  const r = classify("renew passport");
  expect(r).toEqual({ kind: "text", text: "renew passport" });
});
```

### Optional: real-store integration reference (do NOT use in unit tests)
`src/cli/commands/task.test.ts:30-53` opens `new FactStore(":memory:")` and `vi.spyOn(process.stdout,"write")` — that is the heavier CLI-core test. Your capture test should stay store-free via the injected sink (sc-2-3 explicitly: "no real FactStore").

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/commands/telegram.ts` | `bot.ts` (`startPollLoop`, `GrammyTransport`) | low | Keep `startPollLoop`'s existing 2-arg call valid — add the capture param as **optional with a default**, do not make it required. |
| `src/telegram/outbound.test.ts` | `bot.ts` (`startPollLoop`, `helpReply`, `BotTransport`, `TelegramUpdate`) | **high** | 3 loop tests assert exact send behavior: whitelisted `/start` → `helpReply()` text (`:128-158`), non-whitelisted → denial (`:96-126`), no-message → 0 sends (`:160-177`). Your routing change must preserve all three. |
| `src/hub/task-inbox.ts` | (you import `captureTask`) | none | Read-only import; do not modify. |

### Existing Tests That Must Still Pass
- `src/telegram/outbound.test.ts` — covers `sendSafe` funnel + `startPollLoop` whitelist/denial/help/no-message. **Critical:** the `/start` whitelisted test (`:128-158`) sends text `"/start"` and asserts the reply equals `helpReply()`. After routing, `/start` is a **command** → ensure the command branch still returns `helpReply()` for `/start` (or that test breaks). The other loop messages in those tests are `/start` and `"hello"` (non-whitelisted, never reaches your branch).
- `src/cli/commands/task.test.ts` — covers `captureTask`/`runTaskAdd`; unaffected (you only import `captureTask`, don't change it). Run it to confirm no accidental change.

### Features That Could Be Affected
- **task-inbox (spec-20260628-task-inbox, completed)** — shares `captureTask`/`FactStore`. Verify a captured Telegram message appears via `agent-bober task list` and is a single open `action` Finding (sc-2-5, manual).
- **Sprint 1 telegram bot** — shares `startPollLoop`/`sendSafe`. Verify denial + `/start` help still work (covered by outbound.test.ts).

### Recommended Regression Checks (run after implementation)
1. `npm run build` → zero TS errors (sc-2-1).
2. `npx vitest run src/telegram/router.test.ts src/telegram/handlers/capture.test.ts` → new tests green (sc-2-2/2-3/2-4).
3. `npx vitest run src/telegram/outbound.test.ts` → all Sprint-1 loop tests still green (no regression).
4. `npx vitest run src/cli/commands/task.test.ts` → task-inbox tests still green.
5. Full suite: `npm test` (or `npx vitest run`).
6. Manual (sc-2-5, optional): start bot, send "renew passport", confirm one task in `agent-bober task list` and a confirmation reply containing the title; send "/foo", confirm **no** new task.

---

## 8. Implementation Sequence (dependency-ordered)

1. **`src/telegram/router.ts`** — pure `classify` + `RoutedMessage` union (no deps).
   - Verify: `npx vitest run src/telegram/router.test.ts` and `npm run build` (the union type compiles).
2. **`src/telegram/router.test.ts`** — `/start` → command, plain text → text (sc-2-2).
   - Verify: both cases pass.
3. **`src/telegram/handlers/capture.ts`** — `InboxCapture` type + `handleCapture` (depends on `finding.ts` type only) + the `defaultCapture` wrapper (Option A import of `captureTask`, or Option B execa).
   - Verify: imports resolve with the extra `../../` depth; `npm run build` clean.
4. **`src/telegram/handlers/capture.test.ts`** — fake sink, assert called once with verbatim text + confirmation contains title (sc-2-3, sc-2-4). NO FactStore.
   - Verify: tests pass; the test never imports `FactStore`.
5. **`src/telegram/bot.ts`** — import `classify` + `handleCapture` (+ default capture); in the whitelisted branch, `classify(msg.text)`; text → `handleCapture` → `sendSafe`; command `/start` → `helpReply()`, others → stub; absent/empty text → existing behavior. Add optional `capture` param to `startPollLoop` defaulting to `defaultCapture`.
   - Verify: `src/telegram/outbound.test.ts` still green (the `/start`→helpReply assertion!).
6. **Run full verification** — `npm run build` && `npx vitest run` (router + capture + outbound + task all green).

---

## 9. Pitfalls & Warnings

- **`/start` regression trap:** `outbound.test.ts:128-158` sends `"/start"` from a whitelisted user and asserts the reply is exactly `helpReply()`. After you route `/`-messages to a command branch, `/start` must still resolve to `helpReply()` or that test fails. Don't send a generic "unknown command" for `/start`.
- **Commands must NOT capture:** double-check the `kind === "command"` branch never calls `handleCapture` (stopCondition: a `/`-message produces zero tasks).
- **Verbatim title:** do NOT trim/lowercase/parse the captured text in the router or handler. `captureTask` does `text.trim()` internally (`task-inbox.ts:27`); leave the rest verbatim (generatorNotes).
- **Import depth from `handlers/`:** files in `src/telegram/handlers/` need `../outbound.js`, `../router.js`, `../../hub/task-inbox.js`, `../../state/facts.js`, `../../utils/fs.js`, `../../fleet/runner.js`, `../../hub/finding.js`. One wrong `../` = build failure.
- **No direct transport sends:** reply only via `sendSafe`. The evaluator checks "the reply goes through sendSafe (no direct transport call)."
- **Don't reimplement storage:** no new Finding/FactStore/dedup logic (nonGoal). Use `captureTask` or `agent-bober task add`.
- **Don't make `startPollLoop`'s new param required** — `telegram.ts:50` and `outbound.test.ts` call it with 2 args. Optional-with-default keeps them compiling.
- **No `any`:** `getUpdates`/grammy casts stay inside `bot.ts`. Type the router union and `InboxCapture` precisely; the discriminated union lets `bot.ts` switch without casts.
- **`captureTask` is async and needs `now`:** if you use Option A, stamp `now` at the wrapper boundary; never inside a pure helper (clock-at-boundary principle).
- **grammy stays in bot.ts only:** do not import `grammy` in router.ts or capture.ts (provider-agnostic, `principles.md:28`).
