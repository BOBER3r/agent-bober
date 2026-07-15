# Sprint Briefing: Multi-LLM "secretary" fleet view (/fleet command + per-agent streaming sections)

**Contract:** sprint-spec-20260628-telegram-frontend-7
**Generated:** 2026-06-30T00:00:00Z

---

## 0. TL;DR for the Generator

Build `src/telegram/fleet-view.ts`:
- **(a) PURE `renderFleetView(bundle: SynthesisBundle): string[]`** — group `bundle.findings` by `FactRecord.subject` (= per-agent childFolder), one section per subject (label + one-line summary of latest finding's `value` truncated + round + confidence + that subject's finding count), plus a header line with `bundle.rounds`.
- **(b) `handleFleet(reader, ...)`** — injected-reader handler mirroring `prioritize.ts`: default reader reads `.bober/fleet-synthesis.json` via `node:fs/promises`, `JSON.parse`, returns `null` on ENOENT/parse-fail. Whitelist-gated (reuse `isAllowed`/`denialReply`). Empty/missing → friendly `"no recent fleet run"`. Output via `sendSafe`.

Then register `/fleet` in `bot.ts` (whitelist-gated, reader NEVER called for non-whitelisted) and add a thin wrapper in `streaming.ts` that feeds `renderFleetView` output into `streamProgress`.

**Type-only imports ONLY:** `import type { SynthesisBundle } from "../fleet/synthesis.js"` and `import type { FactRecord } from "../state/facts.js"`. Both are fully erased at compile — zero runtime coupling to `src/fleet` or `better-sqlite3`.

**CRITICAL PITFALL (read §9 first):** `FactRecord` has **NO `round` field**. `round` is lost at `publish()`. The only round available is `bundle.rounds`. Do NOT write `finding.round` — it does not compile / is `undefined`.

---

## 1. Target Files

### src/telegram/fleet-view.ts  (create)

**Directory pattern:** `src/telegram/` modules are kebab-case-free single-word/`.ts` files (`outbound.ts`, `streaming.ts`, `digest.ts`, `whitelist.ts`); handlers live in `src/telegram/handlers/`. The contract puts this at the top level (`src/telegram/fleet-view.ts`), NOT under `handlers/` — follow the contract's `estimatedFiles`.

**Most similar existing files:**
- `src/telegram/handlers/prioritize.ts` — the injected-reader + default + pure-string-return handler shape to MIRROR (§2.1).
- `src/telegram/digest.ts` — a tiny pure `sendSafe`-only adapter (§2.4).

**Structure template (skeleton — fill in real logic):**
```ts
/** fleet-view.ts — Read-only secretary view of the most recent fleet run. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findProjectRoot } from "../utils/fs.js";
import { isAllowed, denialReply } from "./whitelist.js";
import type { AllowedUsers } from "./whitelist.js";
import type { SynthesisBundle } from "../fleet/synthesis.js"; // TYPE-ONLY — erased at compile
import type { FactRecord } from "../state/facts.js";          // TYPE-ONLY — no better-sqlite3 leaks

// ── Injected reader ───────────────────────────────────────────────────
/** Returns the parsed bundle, or null when absent/unparseable. Tests inject a fake. */
export type SynthesisReader = () => Promise<SynthesisBundle | null>;

// ── defaultSynthesisReader ────────────────────────────────────────────
export async function defaultSynthesisReader(): Promise<SynthesisBundle | null> {
  const root = (await findProjectRoot()) ?? process.cwd();
  const path = join(root, ".bober", "fleet-synthesis.json");
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as SynthesisBundle;   // shape is the contract (see §2.2)
  } catch {
    return null; // ENOENT or JSON.parse failure → graceful empty state
  }
}

// ── renderFleetView (PURE) ────────────────────────────────────────────
/** Group findings by subject; one section per agent. NO IO, NO throw. */
export function renderFleetView(bundle: SynthesisBundle): string[] { /* §9 grouping */ }

// ── handleFleet ───────────────────────────────────────────────────────
/** Whitelist gate → (only if allowed) call reader → render → return string for sendSafe. */
export async function handleFleet(
  senderId: number,
  allowed: AllowedUsers,
  reader: SynthesisReader = defaultSynthesisReader,
): Promise<string> { /* §9 sequence */ }
```

---

### src/telegram/fleet-view.test.ts  (create)
Mirror `prioritize.test.ts` / `outbound.test.ts` injected-spy style. Full template in §6.

---

### src/telegram/bot.ts  (modify)

**Insertion point — the slash-command dispatch block, lines 374-402:**
```ts
// src/telegram/bot.ts:374-402 (inside `if (routed.kind === "command")`)
        if (routed.name === "start") {
          await sendSafe(transport, chatId, helpReply());
        } else if (
          routed.name === "today" ||
          routed.name === "priority" ||
          routed.name === "decide"
        ) {
          const reply = await handlePrioritize(routed.name, routed.args, prioritize);
          await sendSafe(transport, chatId, reply);
        } else if (routed.name === "pending") {
          // ... listPending + sendSafeKeyboard ...
        } else {
          await sendSafe(transport, chatId, `Unknown command: /${routed.name}`);
        }
```
Add a new `else if (routed.name === "fleet")` branch BEFORE the final `else`. The whitelist gate already happened at **bot.ts:316-320** (the message branch only reaches the command switch for whitelisted senders), so inside this branch the sender is already whitelisted — call the injected reader here. For sc-7-6, the denial path at bot.ts:316-320 fires first and the `/fleet` branch is never entered, so the reader is never called.

**`fleetReader` injection param** — add an optional injected reader to `startPollLoop` so tests can pass a spy, mirroring `prioritize: PrioritizeFn = defaultPrioritize` (bot.ts:232):
```ts
// src/telegram/bot.ts:228-235 — current signature
export async function startPollLoop(
  transport: BotTransport,
  signal: AbortSignal,
  capture: InboxCapture = defaultCapture,
  prioritize: PrioritizeFn = defaultPrioritize,
  pending: PendingCallbackState = createPendingState(),
  uploads: PendingUploadState = createPendingUploadState(),
): Promise<void> {
```
Append `fleetReader: SynthesisReader = defaultSynthesisReader` as the next optional param (keeps all existing callers — e.g. `src/cli/commands/telegram.ts:50` passing `(transport, ac.signal)` — compiling unchanged).

**Also update `helpReply()` (bot.ts:199-209)** to add a `/fleet` line (cheap, expected by DoD).

**Imports this file already uses (reuse, do not re-add):** `sendSafe, sendSafeKeyboard` (bot.ts:12); `isAllowed, parseAllowedUsers, denialReply` (bot.ts:13); `findProjectRoot` (bot.ts:31). **Add:** `import { handleFleet, defaultSynthesisReader } from "./fleet-view.js"` and `import type { SynthesisReader } from "./fleet-view.js"`.

**Imported by:** `src/telegram/outbound.test.ts:11` (`startPollLoop, helpReply`), `src/cli/commands/telegram.ts:50` (the `agent-bober telegram` CLI entry — calls `startPollLoop(transport, ac.signal)`), and `bot`'s own consumers. **Test file:** `outbound.test.ts` exercises `startPollLoop` (loop-spy pattern, §6).

---

### src/telegram/streaming.ts  (modify)

**Current full module (lines 1-38) — `streamProgress` signature is load-bearing:**
```ts
// src/telegram/streaming.ts:25-38
export async function streamProgress(
  transport: EditTransport,
  chatId: number,
  updates: AsyncIterable<string>,
  opts?: { header?: string },
): Promise<void> {
  const header = opts?.header ?? "Working…";
  const messageId = await sendSafeForEdit(transport, chatId, header);
  for await (const text of updates) {
    await sendSafeEdit(transport, chatId, messageId, text);
  }
}
```
**How `renderFleetView` feeds it:** `renderFleetView` returns `string[]`. `streamProgress` consumes `AsyncIterable<string>` and edits ONE message in place per yielded item. Add a thin exported wrapper (runtime import of `renderFleetView` from `./fleet-view.js` is SAFE — fleet-view.js has zero runtime fleet coupling):
```ts
import { renderFleetView } from "./fleet-view.js";
import type { SynthesisBundle } from "../fleet/synthesis.js"; // TYPE-ONLY

/** Stream the per-agent fleet sections as in-place edits to ONE message. */
export async function streamFleetView(
  transport: EditTransport,
  chatId: number,
  bundle: SynthesisBundle,
): Promise<void> {
  const sections = renderFleetView(bundle);            // header + one per agent
  async function* gen(): AsyncIterable<string> {
    let acc = "";
    for (const s of sections) { acc = acc ? `${acc}\n\n${s}` : s; yield acc; }
  }
  await streamProgress(transport, chatId, gen(), { header: sections[0] ?? "Fleet…" });
}
```
**Imported by:** `src/telegram/streaming.test.ts:6`. **Funnel:** `streamProgress` only touches transport via `sendSafeForEdit`/`sendSafeEdit` (streaming.ts:2) — never call `transport.editMessage` directly (sc-6-4 carried forward, relevant to sc-7-5).

---

## 2. Patterns to Follow

### 2.1 Injected-reader handler (MIRROR THIS)
**Source:** `src/telegram/handlers/prioritize.ts`, lines 29-35 and 117-127
```ts
// prioritize.ts:29-35 — injected fn type + production default alias
export type HubQuery = (scope: Scope) => Promise<HubResult[]>;
export type PrioritizeFn = HubQuery;

// prioritize.ts:117-127 — handler takes injected fn (default = production reader), returns a STRING
export async function handlePrioritize(
  name: string, args: string,
  query: HubQuery = defaultPrioritize,
): Promise<string> {
  const scope = parseScopeFromCommand(name, args);
  if (scope === null) return `Unknown command: /${name}`;
  const findings = await query(scope);
  if (findings.length === 0) return "No findings to prioritize.";
  return findings.map((f, i) => `${i + 1}. ${f.title}`).join("\n");
}
```
**Rule:** Handler takes an injected reader with a production default, returns a plain `string` (NO transport access — the caller routes it through `sendSafe`). For `/fleet`, `handleFleet` also takes `senderId`+`allowed` so the whitelist gate lives in one place and the reader is skipped on denial (sc-7-6).

### 2.2 SynthesisBundle shape — the contract the reader parses
**Source:** `src/fleet/synthesis.ts:15-19`
```ts
export interface SynthesisBundle {
  rounds: number;
  childResults: PortfolioReport; // the same report the reporter built
  findings: FactRecord[];        // blackboard.readAll() (all active 'finding' facts)
}
```
**`findings[]` element type = `FactRecord`** (§2.3). `bundle.rounds` = run-level round count (header source, sc-7-4). `childResults` is a `PortfolioReport` (`src/fleet/reporter.ts:17-25`) — the renderer does NOT need to render it (outOfScope). The renderer only needs `bundle.rounds` + `bundle.findings`.

### 2.3 FactRecord — the fields the renderer uses
**Source:** `src/state/facts.ts:37-49`
```ts
export interface FactRecord {
  id: string;
  scope: string;
  subject: string;      // ← GROUPING KEY = per-agent childFolder (see §2.5)
  predicate: string;    // always "finding" for fleet findings
  value: string;        // ← RAW PAYLOAD to truncate to one line (NEVER send verbatim)
  confidence: number;   // ← per-section confidence
  sourceRunId: string | null;
  tValid: string;
  tInvalid: string | null;
  tCreated: string;     // ISO-8601 — use to pick the "latest" finding per subject
  tInvalidated: string | null;
}
```
**Rule:** group by `subject`; per group, the "latest finding" = max `tCreated` (or last in array — fixtures drive this). Show `subject` (label), one-line `value`, `confidence`, count = group length, round = `bundle.rounds`. **There is NO `round` field on FactRecord (§9).**

### 2.4 sendSafe-only thin adapter
**Source:** `src/telegram/digest.ts:23-29`
```ts
export async function sendDigest(transport: TelegramTransport, chatId: number, text: string): Promise<void> {
  await sendSafe(transport, chatId, text, { silent: true });
}
```
**Rule:** Handlers never call `transport.sendMessage` directly; everything funnels through `sendSafe` (outbound.ts:61-68). The `/fleet` reply and the streamed sections both go through the funnel (sc-7-5).

### 2.5 Why `subject` IS the per-agent childFolder
**Source:** `src/fleet/shared-blackboard.ts:74-90` (`publish`)
```ts
publish(finding: BlackboardFinding, now: string): FactRecord {
  if (finding.round > this.maxRounds) { throw new Error(...); }
  return this.store.insertFact({
    scope: this.namespace,
    subject: finding.childFolder,    // ← childFolder → subject
    predicate: "finding",            // ← predicate is always "finding"
    value: finding.payload,          // ← payload → value
    confidence: finding.confidence ?? 1,
    sourceRunId: null,
    tValid: now,
    tCreated: now,
  });
  // NOTE: finding.round is validated but NEVER persisted onto the FactRecord.
}
```
`BlackboardFinding` (shared-blackboard.ts:13-18) = `{ childFolder, round, payload, confidence? }`. Confirmed: `subject` = childFolder, `value` = payload, `confidence` carried; **`round` dropped**.

### 2.6 Whitelist denial with numeric-id echo (reuse, feat-2 / sc-7-6)
**Source:** `src/telegram/whitelist.ts:32-44`
```ts
export function isAllowed(id: number, allowed: AllowedUsers): boolean {
  return allowed.has(id);
}
export function denialReply(id: number): string {
  return `Access denied. Your Telegram id (${id}) is not in the allowed list.`;
}
```
**Live denial site (bot.ts:316-320)** — already gates the whole command switch:
```ts
if (!isAllowed(senderId, allowed)) {
  await sendSafe(transport, chatId, denialReply(senderId));
  continue;
}
```
**Rule:** Non-whitelisted `/fleet` is denied with the id echo and the reader is never reached. In `handleFleet`, gate FIRST: `if (!isAllowed(senderId, allowed)) return denialReply(senderId);` BEFORE `await reader()` — so the injected reader spy is never called (sc-7-6).

### 2.7 Type-only imports erase ALL runtime coupling
**Evidence:** `synthesis.ts:9-11` itself imports its deps as types only (`import type { SharedBlackboard }`, `import type { PortfolioReport }`, `import type { FactRecord }`). `facts.ts:3` has a runtime `import Database from "better-sqlite3"`. Under TS `import type`, the imported symbol is a pure type and is **fully erased** from emitted JS (NodeNext + `consistent-type-imports` enforced, principles.md). So `import type { SynthesisBundle }` / `import type { FactRecord }` in `src/telegram/*` emit ZERO `require`/`import` of `src/fleet`, `synthesis.ts`'s `collect`, or `better-sqlite3`. **Rule:** use `import type` exclusively for these two symbols; the build (sc-7-1) stays clean and `src/telegram` never loads better-sqlite3.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `sendSafe` | `src/telegram/outbound.ts:61` | `(transport, chatId, content, opts?) => Promise<void>` | The ONLY outbound text chokepoint — route the `/fleet` reply through this. |
| `sendSafeForEdit` | `src/telegram/outbound.ts:76` | `(transport: EditTransport, chatId, content, opts?) => Promise<number>` | Initial streaming send → returns message_id (used by `streamProgress`). |
| `sendSafeEdit` | `src/telegram/outbound.ts:90` | `(transport: EditTransport, chatId, messageId, content) => Promise<void>` | In-place edit chokepoint (used by `streamProgress`). |
| `streamProgress` | `src/telegram/streaming.ts:25` | `(transport, chatId, updates: AsyncIterable<string>, opts?) => Promise<void>` | One send + N in-place edits — wrap it to stream fleet sections. |
| `isAllowed` | `src/telegram/whitelist.ts:32` | `(id: number, allowed: AllowedUsers) => boolean` | Whitelist gate for `/fleet`. |
| `denialReply` | `src/telegram/whitelist.ts:42` | `(id: number) => string` | id-echo denial string (sc-7-6). |
| `parseAllowedUsers` | `src/telegram/whitelist.ts:16` | `(env) => AllowedUsers` | Already called once at bot.ts:237; reuse that `allowed` set. |
| `findProjectRoot` | `src/utils/fs.ts` (imported bot.ts:31) | `() => Promise<string \| undefined>` | Resolve project root for the default reader's `.bober/fleet-synthesis.json` path. |
| `classify` | `src/telegram/router.ts:30` | `(message) => RoutedMessage` | Already routes `/fleet` → `{kind:"command", name:"fleet", args}` (no change needed). |

**Truncation/one-line helper:** none reusable. `src/utils/` has only `fs.ts, git.ts, logger.ts` — no `truncate`/`firstLine` (verified via grep). `truncate` functions exist in `src/orchestrator/*` and `src/mcp/tools/graph.ts` but are deep internals — do NOT import them (would break the thin-adapter boundary). Write a tiny local one-liner inside `fleet-view.ts`, e.g. `value.split("\n")[0]!.slice(0, MAX)` + ellipsis. Keep it private to the module.

**Utilities reviewed:** `src/utils/` (fs, git, logger, index), `src/telegram/` (outbound, whitelist, streaming, digest, router) — all relevant ones listed above.

---

## 4. Prior Sprint Output

### Sprint 1: Outbound funnel + whitelist
**Created:** `src/telegram/outbound.ts` — exports `sendSafe`, `EditTransport`, `TelegramTransport`. `src/telegram/whitelist.ts` — exports `isAllowed`, `denialReply`, `parseAllowedUsers`, `AllowedUsers`.
**Connection:** `/fleet` reply funnels through `sendSafe`; denial reuses `isAllowed`+`denialReply` (sc-7-5, sc-7-6).

### Sprint 3: Injected-reader handler pattern
**Created:** `src/telegram/handlers/prioritize.ts` — `handlePrioritize(name, args, query=defaultPrioritize)`, injected `HubQuery`, production default that reads the real source, returns a plain string.
**Connection:** `handleFleet` mirrors this EXACTLY — injected `SynthesisReader` (default reads disk), tests inject a fixture/spy, handler returns a string for `sendSafe`.

### Sprint 6: Streaming + digest path
**Created:** `src/telegram/streaming.ts` — `streamProgress(transport, chatId, updates: AsyncIterable<string>, opts?)` (one send + N in-place edits). `src/telegram/digest.ts` — `sendDigest` (silent funnel).
**Connection:** the shared `renderFleetView` feeds `streamProgress` so a live fleet run streams per-agent sections via in-place edits (sc-7-7); both surfaces use the same renderer.

### Fleet side (read-only dependency — TYPE-ONLY)
**`src/fleet/synthesis.ts`** — `collect(blackboard, childResults, rounds): SynthesisBundle` is **PURE** (no IO; synthesis.ts:29-39). It does NOT write the file.
**`src/fleet/index.ts:61-76`** `writeSynthesis(rootDir, bundle)` is what actually writes `<rootDir>/.bober/fleet-synthesis.json` (atomic tmp+rename, `JSON.stringify(bundle, null, 2) + "\n"`, mode 0o600), called at `index.ts:203` after `collect`. **The renderer reads that exact path.** Only written on blackboard runs (absent otherwise — index.test.ts:689-712) → the default reader's `null` path matters.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM everywhere** — all imports use `.js` extensions (NodeNext). Use `../fleet/synthesis.js`, `../state/facts.js`, `./fleet-view.js`, `./whitelist.js`.
- **Use `type` imports** — ESLint `consistent-type-imports` ENFORCED. `SynthesisBundle`/`FactRecord` MUST be `import type` (also the sc-7-1 requirement).
- **No `any`** — `no-explicit-any`; use `unknown` + narrowing. The reader casts `JSON.parse(raw) as SynthesisBundle` (acceptable, shape is the on-disk contract).
- **No synchronous fs** — `node:fs/promises` only (`readFile`), never `readFileSync`.
- **Provider-agnostic / no SDK leak** — `src/telegram` must not import `better-sqlite3` or `src/fleet` runtime; `import type` satisfies this (§2.7).
- **Section comments** — `// ── Section Name ──────` unicode headers (see every file in §1/§2).
- **Tests collocated** — `fleet-view.test.ts` next to `fleet-view.ts`; Vitest.

### Architecture Decisions
No `.bober/architecture/` ADR specific to telegram/fleet-view was found applicable to this sprint. Relevant invariant: ADR-5 (fleet) — callers pass ABSOLUTE paths; the default reader resolves via `findProjectRoot()` then `join(root, ".bober", "fleet-synthesis.json")`.

### Other Docs
`helpReply()` (bot.ts:199-209) is the in-band command catalogue — add a `/fleet` line there.

---

## 6. Testing Patterns

### Unit Test Pattern
**Runner:** vitest (`package.json:16` `"test": "vitest"`). **Assertion:** `expect`. **Mocks:** NONE — injected fakes/spies (principles: "No test mocks for filesystem"). **File naming:** `fleet-view.test.ts` co-located. **Build:** `npm run build` (tsc), typecheck `npm run typecheck`.

**Spy/fixture template (mirrors prioritize.test.ts + outbound.test.ts + digest.test.ts):**
```ts
/** fleet-view.test.ts — Unit tests for renderFleetView + handleFleet (sc-7-2..sc-7-6). */
import { describe, it, expect } from "vitest";
import { renderFleetView, handleFleet } from "./fleet-view.js";
import type { SynthesisReader } from "./fleet-view.js";
import type { SynthesisBundle } from "../fleet/synthesis.js";
import type { FactRecord } from "../state/facts.js";
import { sendSafe } from "./outbound.js";
import type { TelegramTransport } from "./outbound.js";

// ── Fixtures ──────────────────────────────────────────────────────────
/** Build a minimal valid FactRecord 'finding' (mirrors prioritize.test.ts `fx`). */
const fact = (subject: string, value: string, confidence = 1, tCreated = "2026-06-30T00:00:00.000Z"): FactRecord => ({
  id: `${subject}-${value}`.slice(0, 16),
  scope: "fleet-ns",
  subject,
  predicate: "finding",
  value,
  confidence,
  sourceRunId: null,
  tValid: tCreated,
  tInvalid: null,
  tCreated,
  tInvalidated: null,
});
const bundle = (findings: FactRecord[], rounds = 2): SynthesisBundle => ({
  rounds,
  childResults: { total: findings.length, completed: findings.length, failed: 0, other: 0,
    generatedAt: "2026-06-30T00:00:00.000Z", children: [] },
  findings,
});

/** TelegramTransport spy (mirrors outbound.test.ts makeSpy). */
function makeSpy(): TelegramTransport & { calls: Array<{ chatId: number; text: string }> } {
  const calls: Array<{ chatId: number; text: string }> = [];
  return { calls, async sendMessage(chatId, text) { calls.push({ chatId, text }); } };
}

const ALLOWED = new Set<number>([111]);

// ── sc-7-2: one section per distinct subject ──────────────────────────
describe("renderFleetView", () => {
  it("sc-7-2: emits one section per distinct subject with label+summary+round+confidence+count", () => {
    const out = renderFleetView(bundle([
      fact("grok-child", "anomaly found in Q3 ledger", 0.9),
      fact("grok-child", "second grok note", 0.8),
      fact("deepseek-child", "schema mismatch detected", 0.7),
    ]));
    const joined = out.join("\n");
    expect(joined).toContain("grok-child");
    expect(joined).toContain("deepseek-child");
    // exactly 2 agent sections (subjects), regardless of header line
    const sections = out.filter((s) => s.includes("grok-child") || s.includes("deepseek-child"));
    expect(sections).toHaveLength(2);
    // grok section carries its count (2 findings) and confidence
    expect(joined).toMatch(/grok-child[\s\S]*2/);   // count of 2
  });

  // ── sc-7-4: header shows bundle.rounds ──────────────────────────────
  it("sc-7-4: header includes the run's round count", () => {
    const out = renderFleetView(bundle([fact("a", "x")], 3));
    expect(out[0]).toContain("3"); // header line carries rounds=3
  });

  // ── sc-7-5 (render half): over-long value truncated to one line ──────
  it("sc-7-5: a multi-line / over-long value is summarized to one line", () => {
    const huge = "L1 secret-payload\nL2 more\n" + "x".repeat(5000);
    const out = renderFleetView(bundle([fact("a", huge)]));
    const joined = out.join("\n");
    expect(joined).not.toContain("L2 more");          // newlines collapsed
    expect(joined).not.toContain("x".repeat(5000));   // verbatim never present
    expect(joined.split("\n").every((l) => l.length < 400)).toBe(true);
  });
});

// ── sc-7-3 / sc-7-5 / sc-7-6: handler behaviour ───────────────────────
describe("handleFleet", () => {
  it("sc-7-3: reader returns null → 'no recent fleet run', no throw", async () => {
    const reader: SynthesisReader = async () => null;
    const reply = await handleFleet(111, ALLOWED, reader);
    expect(reply.toLowerCase()).toContain("no recent fleet run");
  });

  it("sc-7-3: reader returns { findings: [] } → 'no recent fleet run'", async () => {
    const reader: SynthesisReader = async () => bundle([]);
    const reply = await handleFleet(111, ALLOWED, reader);
    expect(reply.toLowerCase()).toContain("no recent fleet run");
  });

  it("sc-7-5: over-long value routed via sendSafe — verbatim never reaches transport", async () => {
    const huge = "secret-" + "z".repeat(4000);
    const reader: SynthesisReader = async () => bundle([fact("a", huge)]);
    const reply = await handleFleet(111, ALLOWED, reader);
    const spy = makeSpy();
    await sendSafe(spy, 111, reply);               // caller funnels the string
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.text).not.toContain("z".repeat(4000));
  });

  it("sc-7-6: non-whitelisted /fleet denied with id-echo AND reader never called", async () => {
    let called = false;
    const readerSpy: SynthesisReader = async () => { called = true; return null; };
    const reply = await handleFleet(99999, ALLOWED, readerSpy);  // 99999 NOT in ALLOWED
    expect(reply).toContain("99999");               // id echo (denialReply)
    expect(called).toBe(false);                     // reader spy never invoked
  });
});
```

**sc-7-5 streaming half** — assert the streamed path also truncates (mirror `streaming.test.ts` `makeStreamSpy`, lines 13-36):
```ts
import { streamFleetView } from "./streaming.js";
// build the EditTransport spy from streaming.test.ts:13-36 (sends[]/edits[])
it("sc-7-5: streamFleetView edits never contain the verbatim over-long payload", async () => {
  const spy = makeStreamSpy(); // from streaming.test.ts pattern
  await streamFleetView(spy, 7, bundle([fact("a", "p-" + "q".repeat(4000))]));
  expect(spy.sends).toHaveLength(1);                       // one initial send
  expect(spy.edits.every((e) => !e.text.includes("q".repeat(4000)))).toBe(true);
});
```

### Bot-loop integration test (sc-7-6 at the loop level — optional but recommended)
Mirror `outbound.test.ts:114-218` `makeLoopSpy` + env save/restore. Preload a `/fleet` update from a NON-whitelisted id, pass a reader spy as the new `startPollLoop` param, assert the spy is never called and the send echoes the id. Reuse the `TELEGRAM_ALLOWED_USERS` save/restore try/finally (outbound.test.ts:153-159).

### E2E Test Pattern
Not applicable — no Playwright/`e2e/` in this repo (telegram is exercised via injected-transport unit tests only).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/telegram/outbound.test.ts` | `startPollLoop`, `helpReply` (bot.ts) | medium | New optional `fleetReader` param must default — existing `startPollLoop(spy, ac.signal)` calls (outbound.test.ts:155,187,210) keep compiling. `helpReply()` text assertion at outbound.test.ts:197 uses `helpReply()` itself (not a literal) so adding a `/fleet` line is safe. |
| `src/cli/telegram.ts` (telegram run entry) | `startPollLoop` | medium | Verify it calls `startPollLoop(transport, signal)` is 2-arg `startPollLoop(transport, ac.signal)` (verified) — stays compiling after the new optional param. |
| `src/telegram/streaming.test.ts` | `streamProgress` (streaming.ts) | low | `streamProgress` signature is UNCHANGED — only an additive `streamFleetView` export. Existing 10 tests must stay green. |
| `src/fleet/synthesis.ts`, `src/state/facts.ts` | (consumed type-only) | low | NOT modified. Type-only import adds no runtime edge — confirm the diff shows no runtime `import` of these in `src/telegram`. |
| `package.json` | — | n/a | MUST be unchanged (no npm dependency — nonGoal, evaluatorNotes). |

### Existing Tests That Must Still Pass
- `src/telegram/outbound.test.ts` — tests `startPollLoop` whitelist/funnel behaviour; the new `/fleet` branch + optional param must not regress the denial/help/no-message cases (outbound.test.ts:135-218).
- `src/telegram/streaming.test.ts` — tests `streamProgress` one-send/N-edit + funnel discipline; unchanged signature ⇒ must stay green.
- `src/telegram/digest.test.ts`, `prioritize.test.ts`, `whitelist.test.ts`, `router.test.ts`, `keyboard.test.ts` — neighbouring telegram tests; verify no collateral break.
- `src/fleet/index.test.ts` (esp. lines 526-583, 668-712) — asserts the on-disk `fleet-synthesis.json` shape the reader depends on; do NOT change the fleet write side (outOfScope). These pin the shape contract.
- `src/fleet/synthesis.test.ts` — pins `SynthesisBundle` shape from `collect`.

### Features That Could Be Affected
- **feat-8 (Sprint 6 streaming/digest)** — shares `src/telegram/streaming.ts`. Verify `streamProgress` semantics (one send + N edits, sc-6-2/sc-6-4) still hold after adding `streamFleetView`.
- **feat-1..feat-7 (Sprints 1-5 commands)** — share `bot.ts` command switch. Verify `/start`, `/today`, `/priority`, `/decide`, `/pending`, capture, upload all still route correctly after inserting the `/fleet` branch.

### Recommended Regression Checks
1. `npm run build` — exits 0 (sc-7-1); confirm no `better-sqlite3`/`src/fleet` runtime import appears in `dist/telegram/*.js`.
2. `npx vitest run src/telegram` — all telegram unit tests pass (new + existing).
3. `npx vitest run src/fleet/synthesis.test.ts src/fleet/index.test.ts` — shape contract untouched.
4. `git diff --stat package.json` — empty (no dependency added).
5. `grep -rn "import .*from \"../fleet" src/telegram` shows ONLY `import type` lines (no runtime fleet import).

---

## 8. Implementation Sequence

1. **`src/telegram/fleet-view.ts`** — write the PURE `renderFleetView(bundle): string[]` first (no IO): group `bundle.findings` by `subject`, per group pick latest by `tCreated`, truncate `value` to one line, emit header (`bundle.rounds`) + one section per subject (label/summary/round=`bundle.rounds`/confidence/count). Then add `SynthesisReader` type, `defaultSynthesisReader` (node:fs/promises + ENOENT→null), and `handleFleet` (whitelist gate FIRST, then reader, empty→"no recent fleet run", else `renderFleetView(...).join("\n")`). `import type` for `SynthesisBundle`/`FactRecord`.
   - Verify: `npm run typecheck` clean; no `finding.round` reference anywhere.
2. **`src/telegram/fleet-view.test.ts`** — add the §6 tests (sc-7-2 grouping, sc-7-3 empty/null, sc-7-4 header rounds, sc-7-5 truncation+sendSafe, sc-7-6 denial+reader-never-called).
   - Verify: `npx vitest run src/telegram/fleet-view.test.ts` green.
3. **`src/telegram/bot.ts`** — add `import { handleFleet, defaultSynthesisReader }` + `import type { SynthesisReader }` from `./fleet-view.js`; add optional `fleetReader: SynthesisReader = defaultSynthesisReader` param to `startPollLoop`; add `else if (routed.name === "fleet") { await sendSafe(transport, chatId, await handleFleet(senderId, allowed, fleetReader)); }` before the final `else` (bot.ts:400); add `/fleet` to `helpReply()`.
   - Verify: `npx vitest run src/telegram/outbound.test.ts` still green; existing 2-arg `startPollLoop` callers compile.
4. **`src/telegram/streaming.ts`** — add `streamFleetView(transport, chatId, bundle)` wrapping `streamProgress` with `renderFleetView` output (runtime import of `renderFleetView` from `./fleet-view.js`; `import type { SynthesisBundle }`).
   - Verify: `npx vitest run src/telegram/streaming.test.ts` green; add the streaming half of sc-7-5.
5. **Full verification** — `npm run build` (sc-7-1, zero TS errors), `npx vitest run src/telegram src/fleet/synthesis.test.ts src/fleet/index.test.ts`, `git diff package.json` empty, grep confirms type-only fleet imports.

---

## 9. Pitfalls & Warnings

- **`FactRecord` has NO `round` field — round is dropped at `publish()`** (shared-blackboard.ts:74-90 inserts only scope/subject/predicate/value/confidence/tValid/tCreated; `BlackboardFinding.round` is validated then discarded). Writing `finding.round` is a compile error / `undefined`. **The per-section "round" AND the header round must both come from `bundle.rounds`** (the run-level count). This is the only round the renderer can show. Do NOT invent a per-finding round.
- **`collect()` does NOT write the file.** It is PURE (synthesis.ts:29-39). The disk write is `writeSynthesis` at `src/fleet/index.ts:61-76` → `<rootDir>/.bober/fleet-synthesis.json`. The reader reads that exact path; the SHAPE (`{rounds, childResults, findings}`) is the contract.
- **`fleet-synthesis.json` is ABSENT on non-blackboard runs** (index.test.ts:689-712). The default reader MUST treat ENOENT as `null` → "no recent fleet run" (sc-7-3). Wrap `readFile`+`JSON.parse` in one try/catch returning `null` (do NOT let it throw — DoD: "never a throw").
- **Type-only or you break sc-7-1.** `facts.ts:3` runtime-imports `better-sqlite3`. A plain `import { FactRecord }` (without `type`) would pull better-sqlite3 into `src/telegram` and violate nonGoal #2 + sc-7-1. ESLint `consistent-type-imports` should catch it, but use `import type` explicitly. Same for `SynthesisBundle` (its module exports the runtime `collect`).
- **Whitelist gate must precede the reader call (sc-7-6).** In `handleFleet`, return `denialReply(senderId)` BEFORE awaiting `reader()`. At the bot level the gate is already at bot.ts:316-320 (the command switch is unreachable for non-whitelisted senders) — but keep the gate inside `handleFleet` too so the unit test can prove the reader spy is never called without spinning the whole loop.
- **Never emit `value` verbatim (sc-7-5).** Collapse newlines (`value.split("\n")[0]`) AND cap length with an ellipsis. The test asserts the raw payload (and any 2nd line) never reaches the transport spy — for BOTH `/fleet` (sendSafe) and `streamFleetView` (sendSafeEdit).
- **Do NOT import a `truncate` from `src/orchestrator/*` or `src/mcp/*`** — they exist but are deep internals; importing them couples telegram to unrelated modules. Write a 1-line private helper in `fleet-view.ts`.
- **Keep `startPollLoop` backward-compatible.** Add `fleetReader` as the LAST optional param with a default; do not reorder existing params (`capture`, `prioritize`, `pending`, `uploads`) — `src/cli/telegram.ts` and `outbound.test.ts` pass positional args.
- **`childResults` (PortfolioReport) is out of scope** — don't render it; the renderer only needs `bundle.rounds` + `bundle.findings`.
- **No npm dependency, no run/fleet/scheduler logic** — this is a read+render adapter only (nonGoals, evaluatorNotes verify `package.json` unchanged).
