# Sprint Briefing: Long-polling bot transport + user-id whitelist + outbound safe-summary funnel

**Contract:** sprint-spec-20260628-telegram-frontend-1
**Generated:** 2026-06-30T00:00:00Z

---

## 0. TL;DR for the Generator

Build a NEW additive module `src/telegram/`. No existing file changes except adding the registration line in `src/cli/index.ts` and adding ONE dependency to `package.json`. Mirror the WHOOP module's discipline exactly:

- **Env creds** like `src/medical/whoop/whoop-token.ts:46-56` (`process.env["TELEGRAM_BOT_TOKEN"]`, `process.env["TELEGRAM_ALLOWED_USERS"]`, throw/exit naming the missing var).
- **SDK behind a typed injectable transport** like `WhoopClient` wraps `fetch` (`src/medical/whoop/whoop-client.ts:40-52,148-164`) — the rest of `src/telegram/` depends on your `TelegramTransport` interface, NEVER the SDK.
- **Single outbound chokepoint** `sendSafe(transport, chatId, content)` — no handler calls `transport.sendMessage` directly.
- **CLI register** like `registerMedicalCommand` (`src/cli/commands/medical.ts:229`, wired at `src/cli/index.ts:41,328`).
- **Tests**: vitest, collocated `*.test.ts`, env save/delete/restore (`src/medical/whoop/whoop-token.test.ts:26-40`), duck-typed injected fake transport as a spy (`src/medical/whoop/whoop-sync.test.ts:18-38`).
- ESM: every relative import ends in `.js`; `import type` for type-only; no `any`; `node:fs/promises` only.

---

## 1. Target Files

### src/telegram/whitelist.ts (create) — pure, no deps

Pure functions only. The contract (generatorNotes) suggests:
`parseAllowedUsers(env)` + `isAllowed(id, allowed)` + `denialReply(id)`.
- `TELEGRAM_ALLOWED_USERS` is comma-separated numeric ids (sc-1-3).
- `denialReply(id)` MUST contain the sender's exact numeric id as a substring (sc-1-4).
No filesystem, no SDK, no network — trivially unit-testable.

### src/telegram/outbound.ts (create) — the single funnel

`sendSafe(transport, chatId, content)` — the ONLY place `transport.sendMessage` is invoked (sc-1-5, nonGoal #5, evaluatorNotes). Depends on the `TelegramTransport` interface type (import `type`), not the SDK. Keep it tiny — this is the control-plane boundary later sprints extend.

### src/telegram/bot.ts (create) — transport wrapper + long-poll loop

Two responsibilities (the generator may split, but contract lists bot.ts):
1. **`TelegramTransport` interface** + a concrete adapter wrapping the chosen SDK (suggested methods: `sendMessage/editMessage/getFile/answerCallback`, plus a `getUpdates`-style poll). SDK import lives ONLY here — mirror `WhoopClient`'s `FetchLike` injectable (`whoop-client.ts:40-52,156`).
2. **long-poll loop** using getUpdates: for each update, run whitelist → if denied, `sendSafe` the `denialReply(id)` and ignore; if allowed, `sendSafe` the `/start` help reply (sc-1-6). NO server/listen/createServer/webhook (nonGoal, evaluatorNotes — they will grep).

### src/cli/commands/telegram.ts (create) — `export function registerTelegramCommand(program)`

Mirror `registerMedicalCommand` (full pattern in section 2). Read `TELEGRAM_BOT_TOKEN` from env; if empty, write a message NAMING the var to stderr and set `process.exitCode = 1`, then return (stopConditions: "exits non-zero with a message naming the missing variable"). On valid token, start the long-poll loop from bot.ts. Handlers MUST NOT throw — set exitCode + return (see `medical.ts:262-270`).

### src/cli/index.ts (MODIFY — only 2 lines added)

Add an import next to the other `register*Command` imports (lines 13-47) and a call next to the other registrations (lines 277-352). Exact insertion pattern in section 2.

**Imported by:** this is the CLI entrypoint (`bin: dist/cli/index.js`, `package.json:9`). Nothing imports it.
**Test file:** none for `cli/index.ts` (no `src/cli/index.test.ts`).

### package.json (MODIFY — add exactly ONE dependency)

Add ONE maintained Telegram long-polling library (grammY / telegraf / node-telegram-bot-api) to `dependencies` (lines 62-76, alphabetical). State the choice in a code comment in bot.ts AND the commit message (generatorNotes). nonGoal: do NOT add more than one. `execa` (`package.json:68`) already present — reuse, don't re-add.

---

## 2. Patterns to Follow

### Pattern A — CLI command registration (the register<X>Command shape)
**Source:** `src/cli/commands/medical.ts:229-233` (definition) + `src/cli/index.ts:41` (import) + `src/cli/index.ts:327-328` (call)
```ts
// src/cli/commands/medical.ts
import type { Command } from "commander";
import chalk from "chalk";
import { findProjectRoot } from "../../utils/fs.js";

export function registerMedicalCommand(program: Command): void {
  const medicalCmd = program
    .command("medical")
    .description("Medical team utilities (health data import)");
  medicalCmd
    .command("import <file>")
    .description("Stream-import a health export file into the medical health store")
    .action(async (file: string) => { /* ... */ });
}
```
```ts
// src/cli/index.ts:41  (import — sits with the other register* imports)
import { registerMedicalCommand } from "./commands/medical.js";
// src/cli/index.ts:327-328  (call — sits with the other registrations inside main())
// ── medical ───────────────────────────────────────────────────────
registerMedicalCommand(program);
```
**Rule:** Export `registerTelegramCommand(program: Command): void` from `src/cli/commands/telegram.ts`; add `import { registerTelegramCommand } from "./commands/telegram.js";` near line 47 and `registerTelegramCommand(program);` near line 352 of `src/cli/index.ts`. Type-only `Command` import uses `import type`.

### Pattern B — Reading credentials from process.env (clear-throw / exit on missing)
**Source:** `src/medical/whoop/whoop-token.ts:46-56`
```ts
clientCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env["WHOOP_CLIENT_ID"];
  const clientSecret = process.env["WHOOP_CLIENT_SECRET"];
  if (!clientId || !clientSecret) {
    throw new Error(
      "WHOOP credentials missing — set WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET " +
        "environment variables and try again.",
    );
  }
  return { clientId, clientSecret };
}
```
**CLI exit form** (when the missing var should exit non-zero rather than throw) — `src/cli/commands/medical.ts:80-88`:
```ts
try {
  tokenStore.clientCredentials();
} catch (e) {
  process.stderr.write(chalk.red(`${e instanceof Error ? e.message : String(e)}\n`));
  process.exitCode = 1;
  return;
}
```
**Rule:** Read `process.env["TELEGRAM_BOT_TOKEN"]` / `process.env["TELEGRAM_ALLOWED_USERS"]` with bracket notation (TS `noUncheckedIndexedAccess`-friendly + matches the codebase). On empty `TELEGRAM_BOT_TOKEN` the CLI writes a message NAMING the variable to stderr and sets `process.exitCode = 1` then `return` (stopConditions). NEVER hardcode tokens/ids (nonGoal #3).

### Pattern C — Wrap the SDK behind a small typed injectable interface (provider/adapter discipline)
**Source:** `src/medical/whoop/whoop-client.ts:40-52` (the injectable transport type) and `:148-164` (DI constructor defaulting to the real impl)
```ts
// The injectable transport type — tests pass a duck-typed fake; production defaults to global fetch.
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export class WhoopClient {
  constructor(
    private readonly egress: EgressGuard,
    private readonly tokenStore: WhoopTokenStore,
    // global fetch is the default ONLY here; tests inject a FetchLike returning fixture data.
    private readonly fetchImpl: FetchLike = fetch as FetchLike,
  ) {}
}
```
**Rule:** Define a `TelegramTransport` interface (e.g. `sendMessage(chatId, text)`, `getUpdates(...)`, etc.) in `bot.ts`. The concrete adapter constructs the chosen SDK client and is the ONLY file importing the SDK. The loop, `outbound.ts`, and any handler depend on `TelegramTransport` (imported with `import type`), never the SDK — exactly as `outbound.ts`/loop must not call the SDK directly. This is also what makes the funnel test (sc-1-5) possible with an injected spy. Reinforced by principles.md:28 "Provider-agnostic interfaces … Never leak SDK types outside adapter files."

### Pattern D — CLI handler never throws; uses process.std{out,err}.write + chalk
**Source:** `src/cli/commands/medical.ts:262-270`
```ts
} catch (err) {
  process.stderr.write(
    chalk.red(`Failed to import: ${err instanceof Error ? err.message : String(err)}\n`),
  );
  // CLI handlers MUST NOT throw — set exitCode and return.
  process.exitCode = 1;
}
```
**Rule:** Action handlers wrap work in try/catch, write red error to stderr, set `process.exitCode = 1`, and return. Success output goes to stdout via `chalk.green(...)`. (Note: the top-level `main().catch` at `src/cli/index.ts:360-370` is the only place that may surface a thrown fatal.)

### Pattern E — Section comments + file-head docstring
**Source:** `src/medical/whoop/whoop-token.ts:1` and `:6,15,34,40,58` ; principles.md:32
```ts
/** WhoopTokenStore — WHOOP OAuth creds (env) + 0600 refresh-token sidecar. NO network (ADR-2). */
// ── Types ────────────────────────────────────────────────────────────
// ── Credentials ───────────────────────────────────────────────────
```
**Rule:** One-line `/** ... */` file purpose header; unicode box-drawing section dividers `// ── Section ──`.

---

## 3. Existing Utilities — DO NOT Recreate

Searched `src/utils/` (only directory; no `lib/`, `helpers/`, `shared/`, `common/` exist). Barrel at `src/utils/index.ts`.

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `findProjectRoot` | `src/utils/fs.ts:58` | `(startDir?: string): Promise<string \| null>` | Walk up to the dir containing `bober.config.json`/`package.json`. Used by every CLI command via `resolveRoot()`. |
| `ensureDir` | `src/utils/fs.ts:45` | `(path: string): Promise<void>` | `mkdir -p` (recursive). |
| `fileExists` | `src/utils/fs.ts:10` | `(path: string): Promise<boolean>` | Async readable check. |
| `readJson` / `writeJson` | `src/utils/fs.ts:24` / `:34` | `<T>(path): Promise<T>` / `(path, data): Promise<void>` | Pretty JSON read/write (writeJson creates parent dirs). |
| `logger` (singleton) | `src/utils/logger.ts:87` | `logger.info/success/warn/error/debug(msg, ...args)` | App-wide console logger (chalk-colored). Used in `cli/index.ts:10`. CLI commands tend to use direct `process.std*.write` + chalk instead. |
| `chalk` (dep) | `package.json:66` | — | Color stdout/stderr. Import `chalk` (already a dependency). |
| `execa` (dep) | `package.json:68` | — | Already present — reuse if you ever shell out; do NOT re-add. |

**There is NO dedicated "exit-non-zero-with-message" helper.** The established convention is to inline `process.stderr.write(chalk.red(...)); process.exitCode = 1; return;` (Pattern D). Do not invent a new helper for this sprint.

**CLI root resolver convention** — each command file defines its own tiny `resolveRoot()` (`medical.ts:36-39`): `const root = await findProjectRoot(); return root ?? process.cwd();`. Telegram may not need project root at all (env-only), so this is optional.

---

## 4. Prior Sprint Output

This is **Sprint 1 of 7** — `dependsOn: []`. No prior sprint output to import.

Forward note (not built this sprint): `src/research/digest.ts` already emits a JSON artifact explicitly shaped for a future Telegram consumer (`src/research/digest.ts:3`, `src/cli/commands/research.ts:405`, `src/research/digest.test.ts:127` "stable Telegram-consumer shape"). Sprint 6 consumes it; **do NOT wire it now** (out of scope — transport/whitelist/funnel only).

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`) — BINDING
- **ESM everywhere** — `.js` extensions on all relative imports for NodeNext (`:27`).
- **Provider-agnostic interfaces** — wrap SDKs behind adapters; never leak SDK types out of the adapter file (`:28`). Directly motivates Pattern C / the `TelegramTransport` wrapper.
- **`import type` for types** — `consistent-type-imports` is an ESLint **error** (`:35`, eslint.config.js:39).
- **No `any`** — `no-explicit-any` warn; use `unknown` + narrowing (`:40`). Note `err instanceof Error ? err.message : String(err)` idiom (Pattern D).
- **`node:fs/promises` only**, no sync fs (`:42`).
- **Tests collocated** `*.test.ts` next to source, vitest (`:20`).
- **Section comments** box-drawing headers (`:32`).
- **Conventional commits** — sprint commits use `bober(sprint-N): description` (`:34`); state the chosen Telegram lib in the message.
- **Small single-purpose utils** (`:33`) — keeps whitelist/outbound/bot split clean.

### Architecture Decisions
No ADR file binds `src/telegram/` (the `.bober/architecture/` dir holds unrelated specs). ESLint enforces zero-egress boundaries only for `src/telemetry/` and `src/medical/` (eslint.config.js:42-106) — **`src/telegram/` has NO network restriction**, so the bot may use the SDK / `fetch` freely. `fetch`, `setTimeout`, `setInterval`, `AbortController` are whitelisted ESLint globals (eslint.config.js:15-26), available for the poll loop.

### Build/TS settings (`tsconfig.json`)
`module`/`moduleResolution: NodeNext`, `strict: true`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `isolatedModules: true`. `**/*.test.ts` is excluded from the build (`:26`) — tests don't ship to `dist/`. `isolatedModules` means type-only re-exports need `export type`.

---

## 6. Testing Patterns

### Unit Test Pattern — env save/delete/restore (for whitelist parse from env)
**Source:** `src/medical/whoop/whoop-token.test.ts:6-40`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WhoopTokenStore } from "./whoop-token.js";

describe("WhoopTokenStore.clientCredentials — env vars (sc-2-6)", () => {
  it("throws when both WHOOP env vars are unset", () => {
    const savedId = process.env["WHOOP_CLIENT_ID"];
    const savedSecret = process.env["WHOOP_CLIENT_SECRET"];
    delete process.env["WHOOP_CLIENT_ID"];
    delete process.env["WHOOP_CLIENT_SECRET"];
    try {
      expect(() => new WhoopTokenStore("/tmp").clientCredentials()).toThrow(/WHOOP_CLIENT_ID/);
    } finally {
      if (savedId !== undefined) process.env["WHOOP_CLIENT_ID"] = savedId;
      if (savedSecret !== undefined) process.env["WHOOP_CLIENT_SECRET"] = savedSecret;
    }
  });
});
```
**Rule:** Save → mutate → assert in `try` → restore (set-or-delete) in `finally`. Use this exact shape for `whitelist.test.ts` cases that read `TELEGRAM_ALLOWED_USERS` from the env. Prefer pure-arg functions (`isAllowed(id, allowed)`) so most whitelist tests need no env at all. Assert the denial echo with a substring/regex on the id (sc-1-4): `expect(denialReply(99999)).toContain("99999")`.

### Unit Test Pattern — injected duck-typed transport SPY (for the funnel, sc-1-5)
**Source:** `src/medical/whoop/whoop-sync.test.ts:18-38`
```ts
import type { WhoopClient, WhoopCollection, WhoopPage, SyncWindow } from "./whoop-client.js";

function fakeClient(pages: Partial<Record<WhoopCollection, WhoopPage[]>>): WhoopClient {
  let call = 0;
  return {
    async fetchPage(collection: WhoopCollection, _window: SyncWindow, _cursor?: string): Promise<WhoopPage> {
      call++;
      /* serve fixture pages */ return pages[collection]?.[0] ?? { records: [] };
    },
  } as unknown as WhoopClient; // duck-typed: sync only calls fetchPage
}
```
**Rule:** For sc-1-5 build a fake `TelegramTransport` whose `sendMessage` PUSHES `{chatId, text}` into a recording array (the spy). Drive a denied + an allowed update through the loop/handler, then assert: (a) the only outbound sends observed are the ones `sendSafe` produced; (b) a handler given no funnel produces NO direct `sendMessage` calls. Inject the fake via constructor/param — never module-level mock. The `as unknown as TelegramTransport` cast lets the fake implement only the methods under test.

**Runner:** vitest (`package.json:16`, `^3.0.5`)
**Assertion style:** `expect(...).toBe/.toThrow/.toContain/.toMatchObject`
**Mock approach:** constructor/parameter dependency injection of duck-typed fakes — NOT `vi.mock`. No filesystem mocks (principles.md:44).
**File naming / location:** `*.test.ts` collocated next to source (`src/telegram/whitelist.test.ts`, `src/telegram/outbound.test.ts`).
**No vitest.config.ts exists** — vitest uses defaults (auto-discovers `*.test.ts`). No global setup file.

### E2E Test Pattern
Not applicable — no Playwright, no `e2e/` dir, no `playwright.config.ts` in this repo. The CLI/long-poll path (sc-1-6) is the `required:false` manual criterion; do not attempt to automate live Telegram polling.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/index.ts` | new `./commands/telegram.js` | low | The added import + `registerTelegramCommand(program)` call must compile; the import path must end in `.js`. This is the ONLY existing file edited. |
| `package.json` | new dep | low | Exactly ONE new key in `dependencies`; valid JSON; `npm install` resolves it. |

This is a purely additive module. Grep confirms **no existing code imports anything named telegram** (only doc-comment references in `src/research/digest.ts:3`, `src/cli/commands/research.ts:405`). `src/telegram/` does not yet exist.

### Existing Tests That Must Still Pass
- No existing test imports `src/cli/index.ts` or `src/telegram/*` (the module is new). The whole existing suite must remain green — the only cross-cutting risk is a `tsc` break from a bad import in `cli/index.ts`.
- `src/research/digest.test.ts` references the "Telegram-consumer shape" but does NOT import telegram code — it is unaffected this sprint; do not touch it.

### Features That Could Be Affected
- **Research digest (Sprint 6 consumer)** — shares the *conceptual* Telegram surface only. No shared code is created this sprint, so nothing to verify yet.

### Recommended Regression Checks (run after implementation)
1. `npm run build` — exits 0, emits `dist/telegram/*.js` and `dist/cli/commands/telegram.js` (sc-1-1).
2. `npm run typecheck` — zero errors across new files (sc-1-2).
3. `npm test` — full suite green; new whitelist/denial/funnel tests pass (sc-1-3/4/5).
4. `npm run lint` — `consistent-type-imports` + no-unused clean on new files.
5. `git diff package.json` — confirm exactly ONE added dependency (evaluatorNotes will check this).
6. `grep -rinE "createServer|\.listen\(|webhook|express|fastify" src/telegram/` → MUST be empty (nonGoal; long-poll getUpdates only).
7. `grep -rn "sendMessage" src/telegram/` → the SDK send call appears ONLY inside the transport adapter in bot.ts and is reached by handlers ONLY via `outbound.ts` `sendSafe` (single-funnel invariant, evaluatorNotes).
8. `agent-bober telegram --help` prints usage (stopConditions); empty `TELEGRAM_BOT_TOKEN` exits non-zero naming the var.

---

## 8. Implementation Sequence (dependency-ordered)

1. **package.json** — add the ONE chosen Telegram long-polling lib to `dependencies` (alphabetical, lines 62-76); `npm install`.
   - Verify: lib resolves; `git diff` shows exactly one new dep key.
2. **src/telegram/whitelist.ts** — pure `parseAllowedUsers(env)`, `isAllowed(id, allowed)`, `denialReply(id)`. No imports beyond TS.
   - Verify: `denialReply(n)` includes `String(n)`; comma-list parse handles whitespace/empties.
3. **src/telegram/whitelist.test.ts** — deny (absent id) + allow (present id) + denial-echo substring; env save/restore where reading `TELEGRAM_ALLOWED_USERS` (sc-1-3, sc-1-4).
   - Verify: `npm test` green for these.
4. **src/telegram/bot.ts** — define `TelegramTransport` interface; concrete SDK-wrapping adapter (ONLY SDK import here, with a comment naming the lib); long-poll getUpdates loop calling whitelist then `sendSafe`. Loop/adapter take the transport via DI so tests can inject a fake.
   - Verify: no `createServer/listen/webhook`; `import type { TelegramTransport }` used by the loop where it doesn't need the concrete class.
5. **src/telegram/outbound.ts** — `sendSafe(transport, chatId, content)`; imports `type { TelegramTransport }` from bot.ts; the SOLE caller of `transport.sendMessage`.
   - Verify: no other file under `src/telegram/` calls `transport.sendMessage`.
6. **src/telegram/outbound.test.ts** — inject a recording fake transport (spy); assert outbound goes only through `sendSafe`; handler returns content, send happens only in the funnel (sc-1-5).
   - Verify: `npm test` green.
7. **src/cli/commands/telegram.ts** — `export function registerTelegramCommand(program: Command): void`; read `TELEGRAM_BOT_TOKEN`; empty → stderr message naming var + `exitCode = 1` + return; else start the loop. Handler never throws (Pattern D).
   - Verify: `agent-bober telegram --help`; empty-token path exits non-zero.
8. **src/cli/index.ts** — add `import { registerTelegramCommand } from "./commands/telegram.js";` (near line 47) and `registerTelegramCommand(program);` (near line 352, with a `// ── telegram ──` divider).
   - Verify: build + typecheck.
9. **Run full verification** — `npm run build`, `npm run typecheck`, `npm test`, `npm run lint`, plus regression greps in section 7.

---

## 9. Pitfalls & Warnings

- **`.js` import extensions are mandatory.** `import { TelegramTransport } from "./bot.js"` even though the source is `bot.ts` (NodeNext). A missing `.js` compiles in editors but FAILS `tsc`/runtime.
- **`import type` is an ESLint ERROR if omitted** for type-only imports (eslint.config.js:39). The `TelegramTransport` interface, `Command`, etc. must use `import type`.
- **`isolatedModules: true`** — re-exporting a type needs `export type { TelegramTransport }`, not a bare `export`.
- **Bracket env access** — use `process.env["TELEGRAM_BOT_TOKEN"]` (matches codebase + strict index access), not `process.env.TELEGRAM_BOT_TOKEN`.
- **Single-funnel invariant is graded by grep** (evaluatorNotes). Do NOT call the SDK's send method from the loop, a handler, or the CLI — only from the transport adapter, reached via `sendSafe`. Keep the SDK import in bot.ts ONLY.
- **No server / no port** — getUpdates long-polling only. Any `createServer`, `.listen()`, webhook registration, express/fastify, or opening an inbound port violates nonGoals and the DoD and will fail review.
- **Exactly ONE new dependency.** If the chosen lib pulls peer deps, that's fine, but do not add a second direct entry to `dependencies`. State the choice in a bot.ts comment AND the commit message.
- **Handlers MUST NOT throw** — set `process.exitCode = 1` and return (Pattern D). Only the top-level `main().catch` (`cli/index.ts:360`) handles thrown fatals.
- **Tests stay offline** — never open a real Telegram connection in tests; inject a fake `TelegramTransport`. CI has no network and the suite must pass deterministically (mirrors whoop tests' offline discipline).
- **Don't wire the digest/hub/calendar/medical** — those are Sprints 2-6. Sprint 1 is transport + whitelist + funnel + `/start` help reply ONLY.
- **`src/telegram/` is NOT under an ESLint egress ban** (unlike `src/medical/`/`src/telemetry/`) — `fetch`/SDK network is allowed here; do not copy the medical zero-egress asserts.
