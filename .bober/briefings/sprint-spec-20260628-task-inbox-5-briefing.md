# Sprint Briefing: Chat intent-detection capture

**Contract:** sprint-spec-20260628-task-inbox-5
**Generated:** 2026-06-29T00:00:00.000Z

> Goal: add a NEW `capture-task` member to the chat turn classifier and a chat-session
> branch that, on `capture-task`, persists the task via the sprint-1 `captureTask` write
> path and replies with a short confirmation INSTEAD of calling the Answerer. Everything
> is ADDITIVE: every existing classifier action and the never-throw FALLBACK→answer must
> stay byte-behaviour-identical.

---

## 1. Target Files

### src/chat/turn-classifier.ts (modify)

This file is read IN FULL below — it is small (171 lines) and every edit lands here.

**(a) Discriminated union — `src/chat/turn-classifier.ts:11-20`** (9 existing members; ADD a 10th):
```ts
export type ClassifierAction =
  | { action: "answer" }
  | { action: "spawn"; task: string }
  | { action: "steer"; op: "inspect" }
  | { action: "steer"; op: "stop"; runId: string }
  | { action: "approve"; checkpointId?: string }
  | { action: "reject"; checkpointId?: string; feedback?: string }
  | { action: "tell"; runId: string; text: string }
  | { action: "pause"; runId: string }
  | { action: "resume"; runId: string };
// ADD:  | { action: "capture-task"; task: string };
```

**(b) Zod discriminated union — `src/chat/turn-classifier.ts:24-44`** (ADD one `z.object` to the array; do NOT touch existing members):
```ts
const ClassifierActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("answer") }),
  z.object({ action: z.literal("spawn"), task: z.string() }),
  /* ... steer / approve / reject / tell / pause / resume unchanged ... */
  z.object({ action: z.literal("resume"), runId: z.string() }),
  // ADD: z.object({ action: z.literal("capture-task"), task: z.string() }),
]);
```

**(c) FALLBACK constant — `src/chat/turn-classifier.ts:46`** (DO NOT change — never-throw contract):
```ts
const FALLBACK: ClassifierAction = { action: "answer" };
```

**(d) parseClassifierAction — `src/chat/turn-classifier.ts:80-122`.** The spawn branch is at line 90; ADD the capture-task reconstruction branch right after it. Note the function returns `FALLBACK` at line 118 (schema mismatch) and again at line 120 (catch). Both must remain:
```ts
      if (data.action === "spawn") return { action: "spawn", task: data.task };
      // ADD immediately after the spawn branch:
      // if (data.action === "capture-task") {
      //   return { action: "capture-task", task: data.task };
      // }
```

**(e) System-prompt option list — `src/chat/turn-classifier.ts:141-156`** (extend the array). Existing tail:
```ts
      '  {"action":"resume","runId":"<id>"}  — resume a soft-paused run',
      "Return ONLY the JSON object, no other text.",
```
ADD a `capture-task` option line PLUS an explicit scope-statement rule BEFORE the closing "Return ONLY..." line (see snippet in §5b). The scope-statement rule is load-bearing for sc-5-3.

**Imports this file uses:** `z` from `"zod"`; `import type { LLMClient }` from `"../providers/types.js"` (line 7). No new imports needed.
**Imported by:** `src/chat/chat-session.ts:12` (`TurnClassifier`). `ClassifierAction` is NOT exported/consumed elsewhere (grep: only referenced inside turn-classifier.ts). Adding a union member is safe.
**Test file:** `src/chat/turn-classifier.test.ts` (exists — extend it for sc-5-2 / sc-5-3 / sc-5-5).

---

### src/chat/turn-classifier.test.ts (modify)

Append new `it(...)` cases (sc-5-2 capture-task, sc-5-3 question→answer + scope-statement≠capture-task, sc-5-5 malformed→answer). Reuse the existing `ScriptedClient` at the top of the file — see §6 + §5d.

---

### src/chat/chat-session.ts (modify)

**Dispatch chain — `src/chat/chat-session.ts:257-291`** (the `if/else if` over `action.action`). ADD a `capture-task` branch (placement anywhere in the chain; recommend right before the final `else`):
```ts
    if (action.action === "answer") {
      reply = await this.answerer.answer(input, rosterSummary, memoryDistill, recentHistory);
    } else if (action.action === "spawn") {
      /* ... */
    } else if (action.action === "resume") {
      reply = await this.handleResume(action.runId);
    // ADD: } else if (action.action === "capture-task") {
    //        reply = await this.handleCaptureTask(action.task);
    } else {
      reply = `Unrecognised action. For now, try /help for available commands.`;
    }
```
The capture branch must NOT reach `this.answerer` (line 258). Implement it as a private method `handleCaptureTask` mirroring the other private handlers (`handleStop` 318, `handlePause` 421, `handleResume` 441) — see §5c.

**Existing now-stamp boundary — `src/chat/chat-session.ts:306`**: `const now = new Date().toISOString();` is already used at the persist boundary, so a second `new Date().toISOString()` inside `handleCaptureTask` is the permitted chat-handler boundary (principles allow it there for the captureTask stamp).

**Best-effort try/catch idiom to mirror — `src/chat/chat-session.ts:496-512`** (`rankAndRenderHub`): wraps a hub write in `try { ... } catch { /* never break the turn */ }`. Mirror this "never throw out of a turn" stance.

**Imports this file uses (lines 22-42):** pulls hub helpers (`collectFindings`, `rankFindings`, `HUB_SCOPE`, etc.) and state helpers. It does NOT yet import `FactStore` / `factsDbPath` / `ensureFactsDir` / `captureTask` — ADD:
```ts
import { FactStore, factsDbPath, ensureFactsDir } from "../state/facts.js";
import { captureTask } from "../hub/task-inbox.js";
```
**Imported by:** `src/cli/commands/chat.ts:18` (constructs `ChatSession`). Constructor signature is unchanged by this sprint, so chat.ts is unaffected.
**Test file:** `src/chat/chat-session.test.ts` exists (hub /priority tests) — but create a SEPARATE file for sc-5-4 (see below).

---

### src/chat/chat-session-capture.test.ts (create)

**Directory pattern:** `src/chat/` collocates tests as `<name>.test.ts` (e.g. `chat-session-spawn.test.ts`, `chat-session-completion.test.ts`, `chat-session-steer.test.ts`). Use the same `chat-session-<feature>.test.ts` naming.
**Most similar existing file:** `src/chat/chat-session.test.ts` — copy its temp-dir harness (`mkdtemp`/`rm` at lines 82-90) and `ScriptedClient` (lines 30-38). Full template in §5e.

---

## 2. Patterns to Follow

### Pattern: ADDITIVE discriminated-union member + parse reconstruction
**Source:** `src/chat/turn-classifier.ts:90` (spawn), `:111-116` (pause/resume)
```ts
      if (data.action === "spawn") return { action: "spawn", task: data.task };
      ...
      if (data.action === "pause")  return { action: "pause", runId: data.runId };
      if (data.action === "resume") return { action: "resume", runId: data.runId };
```
**Rule:** Each schema member gets a matching explicit reconstruction branch returning a freshly-built literal object; add `capture-task` the same way, after spawn.

### Pattern: CLI-boundary FactStore lifecycle (open → use → close)
**Source:** `src/cli/commands/task.ts:307-319` (`task add` action)
```ts
const ns = await resolveDefaultNamespace(projectRoot);
await ensureFactsDir(projectRoot, ns);
const now = new Date().toISOString();        // stamp at the boundary
const store = new FactStore(factsDbPath(projectRoot, ns));
try {
  await runTaskAdd(store, text, opts, now);  // -> calls captureTask
} finally {
  store.close();                              // ALWAYS close
}
```
**Rule:** In `handleCaptureTask`, `ensureFactsDir` first, stamp `now`, open `new FactStore(factsDbPath(...))`, call `captureTask` in a `try`, `store.close()` in `finally`. The chat session already holds `this.projectRoot` and `this.memoryNamespace` — use those instead of re-resolving.

### Pattern: reuse captureTask — the SINGLE write path (do NOT re-implement)
**Source:** `src/hub/task-inbox.ts:22-50`
```ts
export async function captureTask(
  store: FactStore,
  text: string,
  { domain, now }: { domain?: string; now: string },
): Promise<Finding> { /* builds open kind:"action" Finding, sha256 id, writes via writeFinding */ }
```
**Rule:** Call `captureTask(store, action.task, { now })`. Do NOT build a Finding inline, do NOT call `writeFinding`/`writeFact` directly — captureTask is the contract's mandated reuse point (non-goal: "captureTask is the single write path reused here").

### Pattern: private async handler returning a reply string
**Source:** `src/chat/chat-session.ts:318-328` (`handleStop`), `:441-452` (`handleResume`)
```ts
private async handleStop(runId: string): Promise<string> {
  const states = await this.roster.read();
  const target = states.find((s) => s.runId === runId && s.status === "running");
  if (!target) return `No such running run: ${runId}`;
  ...
  return `Stopped run ${runId} ...`;
}
```
**Rule:** Mirror this shape for `handleCaptureTask(task: string): Promise<string>` — it returns the confirmation/error string that becomes `reply`.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `captureTask` | `src/hub/task-inbox.ts:22` | `(store: FactStore, text: string, {domain?, now: string}) => Promise<Finding>` | The ONLY write path for a captured task; builds open `kind:"action"` Finding + sha256 id, persists. REUSE. |
| `FactStore` | `src/state/facts.ts:136` | `new FactStore(dbPath, opts?)` | SQLite-backed fact store; pass `":memory:"` for in-memory, or a file path. Has `.close()`, `.getActiveFacts()`. |
| `factsDbPath` | `src/state/facts.ts:77` | `(projectRoot, namespace?) => string` | Resolves absolute `…/facts.db` for a project root + memory namespace. |
| `ensureFactsDir` | `src/state/facts.ts:86` | `(projectRoot, namespace?) => Promise<void>` | mkdir -p for the facts dir; MUST be called before opening a file-backed store. |
| `readFindings` | `src/hub/finding-store.ts:45` | `(store: FactStore) => Finding[]` | Reads + validates all active hub findings (throws on malformed row). Use in the sc-5-4 assertion. |
| `writeFinding` | `src/hub/finding-store.ts:17` | `(store, finding, {now}) => Promise<ReconcileAction>` | Lower-level persist used *inside* captureTask. Do NOT call directly here. |
| `HUB_SCOPE` | `src/hub/finding-source.ts:8` | `"hub"` (const) | Scope/namespace findings live under (used by `getActiveFacts`). |
| `parseClassifierAction` | `src/chat/turn-classifier.ts:80` | `(text: string) => ClassifierAction` | Existing defensive parser; EXTEND its branch list, do not replace. |

Utilities reviewed: `src/utils/` (`fs.ts` — `findProjectRoot`, `fileExists`, `ensureDir`), `src/state/` (facts, memory), `src/hub/` (task-inbox, finding-store, finding-source). The capture branch needs only the rows above; no new util is warranted.

---

## 4. Prior Sprint Output

### Sprint 1 (0e39c15): task-inbox capture core
**Created:** `src/hub/task-inbox.ts` — exports `captureTask(store, text, {domain?, now})`. Builds an `open` `kind:"action"` Finding with a sha256 id (`title|now`), `urgency:3`, `severity:1`, persists via `writeFinding`. PURE: never reads the clock — `now` is injected.
**Also reused:** `src/hub/finding-store.ts` (`writeFinding`/`readFindings`), `src/hub/finding-source.ts` (`HUB_SCOPE`).
**Connection to this sprint:** The chat capture branch calls `captureTask` exactly as the `task add` CLI does (`src/cli/commands/task.ts:82`). This sprint is the chat-side entry point to the same write path — no new persistence logic.

### Sprints 2-4: lifecycle/list/snooze/ingest
**Created/extended:** `transitionFinding`, snooze helpers (`src/hub/finding-store.ts:51-153`), `src/cli/commands/task.ts` subcommands. NOT directly used by this sprint (chat captures only; it does not transition/list). Mentioned only because `task.ts` is the canonical FactStore-lifecycle reference (§2).

---

## 5. Load-Bearing Paste-Ready Snippets

### 5a. Classifier — union member + schema option + parse branch (turn-classifier.ts)
Union (after line 20's last member):
```ts
  | { action: "capture-task"; task: string };
```
Schema array (after the `resume` object at line 43):
```ts
  z.object({ action: z.literal("capture-task"), task: z.string() }),
```
Parse branch (immediately after the spawn branch at line 90):
```ts
      if (data.action === "capture-task") {
        return { action: "capture-task", task: data.task };
      }
```

### 5b. System-prompt extension (turn-classifier.ts:145-156) — task vs question vs scope-statement
Add the option line alongside the others, and the distinguishing rule before the final "Return ONLY..." line:
```ts
      '  {"action":"capture-task","task":"<task text>"}  — capture a NEW personal task/to-do the user states (an imperative like "renew passport", "book dentist", "call the bank")',
      'A plain question (e.g. "what is X?", "how do I Y?") is {"action":"answer"} — NOT a task.',
      'A decision/scope statement (e.g. "I\'m deciding between X and Y", "should I do A or B?") is NOT a new task — route it to {"action":"answer"}.',
      "Return ONLY the JSON object, no other text.",
```
(The "deciding between" wording lets the sc-5-3 system-prompt assertion check the rule is present.)

### 5c. chat-session.ts — capture branch + private handler
Branch in the dispatch chain (`chat-session.ts:257-291`):
```ts
    } else if (action.action === "capture-task") {
      reply = await this.handleCaptureTask(action.task);
    } else {
```
New private method (place near the other handlers, e.g. after `handleResume` at line 452). Note: `new Date().toISOString()` here is the permitted chat-handler boundary stamp:
```ts
  /**
   * Capture a plain task statement as an open action Finding in the hub pool.
   * Reuses captureTask (sprint 1) — the single write path; never re-implements it.
   * `now` is stamped here at the chat handler boundary (the only permitted
   * new Date() per principles); captureTask/the store stay clock-free.
   * Never throws: a persistence failure becomes an error reply, not an exception.
   */
  private async handleCaptureTask(task: string): Promise<string> {
    const title = task.trim();
    if (title.length === 0) {
      return "Nothing to capture — the task text was empty.";
    }
    try {
      await ensureFactsDir(this.projectRoot, this.memoryNamespace);
      const now = new Date().toISOString();
      const store = new FactStore(factsDbPath(this.projectRoot, this.memoryNamespace));
      try {
        const finding = await captureTask(store, title, { now });
        return `Captured task: ${finding.title}`;
      } finally {
        store.close();
      }
    } catch (err) {
      return `Failed to capture task: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
```
Add imports near `chat-session.ts:22-42`:
```ts
import { FactStore, factsDbPath, ensureFactsDir } from "../state/facts.js";
import { captureTask } from "../hub/task-inbox.js";
```

### 5d. turn-classifier.test.ts — sc-5-2 / sc-5-3 / sc-5-5
Reuse the file's existing `ScriptedClient` (records `client.calls`, `turn-classifier.test.ts:9-20`). Append:
```ts
// ── capture-task classifier action (sc-5-2 / sc-5-3 / sc-5-5) ──────────
describe("TurnClassifier — capture-task action", () => {
  it("parses capture-task for an imperative task phrase (sc-5-2)", async () => {
    const client = new ScriptedClient(['{"action":"capture-task","task":"renew passport"}']);
    const classifier = new TurnClassifier(client, "test-model");
    const result = await classifier.classify("renew passport");
    expect(result).toEqual({ action: "capture-task", task: "renew passport" });
  });

  it("a question routes to answer (sc-5-3)", async () => {
    const client = new ScriptedClient(['{"action":"answer"}']);
    const classifier = new TurnClassifier(client, "test-model");
    const result = await classifier.classify("What is a passport?");
    expect(result).toEqual({ action: "answer" });
  });

  it("a decision/scope statement does NOT capture a task (sc-5-3)", async () => {
    const client = new ScriptedClient(['{"action":"answer"}']);
    const classifier = new TurnClassifier(client, "test-model");
    const result = await classifier.classify("I'm deciding between Postgres and MySQL");
    expect(result.action).not.toBe("capture-task");
    expect(result).toEqual({ action: "answer" });
  });

  it("system prompt describes capture-task and the scope-statement rule (sc-5-3)", async () => {
    const client = new ScriptedClient(['{"action":"answer"}']);
    const classifier = new TurnClassifier(client, "test-model");
    await classifier.classify("test");
    const system = client.calls[0]?.system ?? "";
    expect(system).toContain("capture-task");
    expect(system).toContain("deciding between");
  });

  it("malformed classifier response falls back to answer (sc-5-5)", async () => {
    const client = new ScriptedClient(["this is not json at all"]);
    const classifier = new TurnClassifier(client, "test-model");
    const result = await classifier.classify("renew passport");
    expect(result).toEqual({ action: "answer" });
  });
});
```

### 5e. chat-session-capture.test.ts — sc-5-4 (NEW FILE)
The handler opens its OWN file-backed store at `factsDbPath(projectRoot, ns)` (it is NOT DI for the store, unlike `runTaskAdd`). So the test uses a temp `projectRoot`, drives `handleTurn`, then RE-OPENS the same path to assert. The `OnceClient` proves only `classify` ran (the Answerer is NOT called):
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChatSession } from "./chat-session.js";
import type { LLMClient, ChatParams, ChatResponse } from "../providers/types.js";
import { FactStore, factsDbPath } from "../state/facts.js";
import { readFindings } from "../hub/finding-store.js";

// Answers exactly one chat() call (the classifier). A second call (i.e. the
// Answerer) throws — proving the capture branch never reaches the Answerer.
class OnceClient implements LLMClient {
  calls = 0;
  constructor(private readonly response: string) {}
  async chat(_p: ChatParams): Promise<ChatResponse> {
    this.calls += 1;
    if (this.calls > 1) throw new Error("Answerer must NOT be called on capture-task");
    return { text: this.response, toolCalls: [], stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-capture-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

describe("sc-5-4: chat-session capture-task handler", () => {
  it("persists one open action Finding and replies with a capture confirmation", async () => {
    const projectRoot = join(tmpDir, "root");
    await mkdir(join(projectRoot, ".bober"), { recursive: true });

    const llm = new OnceClient('{"action":"capture-task","task":"renew passport"}');
    const session = new ChatSession({ llm, projectRoot, sessionId: "t" }); // default namespace → undefined

    const reply = await session.handleTurn("renew passport");

    // Reply is a capture confirmation, NOT an LLM answer.
    expect(reply).toContain("Captured task");
    expect(reply).toContain("renew passport");
    expect(llm.calls).toBe(1); // only the classifier ran

    // Re-open the store the handler wrote to and assert exactly one open action Finding.
    const store = new FactStore(factsDbPath(projectRoot, undefined));
    try {
      const findings = readFindings(store);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.kind).toBe("action");
      expect(findings[0]!.status).toBe("open");
      expect(findings[0]!.title).toBe("renew passport");
    } finally {
      store.close();
    }
  });
});
```
NOTE on the "in-memory FactStore" phrasing in sc-5-4: the handler is NOT injected with a store, so a true in-memory store cannot be threaded in without refactoring the handler signature (out of scope / non-additive). The temp-dir + re-open pattern above satisfies the criterion ("one open action-Finding is persisted; reply is a confirmation, not an LLM answer") while keeping the handler additive. Do NOT change `ChatSession`'s constructor to inject a store.

---

## 6. Testing Patterns

### Unit Test Pattern (classifier)
**Source:** `src/chat/turn-classifier.test.ts:9-20` (fake client) + `:179-188` (system-prompt assertion)
```ts
class ScriptedClient implements LLMClient {
  readonly calls: ChatParams[] = [];
  private idx = 0;
  constructor(private readonly responses: string[]) {}
  async chat(params: ChatParams): Promise<ChatResponse> {
    this.calls.push(params);
    const text = this.responses[Math.min(this.idx, this.responses.length - 1)] ?? "";
    this.idx += 1;
    return { text, toolCalls: [], stopReason: "end", usage: { inputTokens: 3, outputTokens: 5 } };
  }
}
```
**Runner:** vitest. **Assertion style:** `expect(...).toEqual(...)` / `.toBe(...)`. **Mock approach:** hand-rolled fake `LLMClient` (no `vi.mock`). **File naming:** `<name>.test.ts` collocated. **Location:** collocated (`src/chat/`).

### Session Test Pattern (temp dir harness)
**Source:** `src/chat/chat-session.test.ts:82-90`
```ts
let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-hub-chat-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });
```
**Rule:** Real temp dirs + cleanup (principles: "No test mocks for filesystem"). `ScriptedClient`/`ThrowingClient` avoid any network. The sc-5-4 store re-open uses the same `factsDbPath(projectRoot, ns)` the handler wrote to.

(No E2E/Playwright in this repo — not applicable.)

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/chat/chat-session.ts` | `turn-classifier.ts` (`TurnClassifier`) | low | Adds a `capture-task` branch; the new union member is exhaustively handled (the `else` at line 288 still covers nothing-else). No existing branch changes. |
| `src/cli/commands/chat.ts:18` | `chat-session.ts` (`ChatSession`) | low | Constructor signature unchanged — no edit needed. |
| `src/orchestrator/memory/fact-judge.ts:37` | comment-only mirror of turn-classifier helpers | none | Not a code import; no change. |

`ClassifierAction` is not imported anywhere outside `turn-classifier.ts` (grep confirmed) — the additive union member has zero external type fallout.

### Existing Tests That Must Still Pass
- `src/chat/turn-classifier.test.ts` — covers answer/spawn/approve/reject/pause/resume parsing + garbage→FALLBACK. ALL must stay green (proves the additive member did not disturb existing reconstruction branches or the fallback).
- `src/chat/chat-session.test.ts` — hub `/priority` `/decide` + `/help`/`/exit` regression (the `/help` test at line 291 asserts `/priority`/`/decide` are NOT in `/help`; capture-task is not a slash command, so `/help` is unaffected — verify it still passes).
- `src/chat/chat-session-spawn.test.ts`, `chat-session-steer.test.ts`, `chat-session-approval.test.ts`, `chat-session-completion.test.ts` — exercise the dispatch chain (`chat-session.ts:257-291`); inserting one `else if` must not perturb them.
- `src/hub/task-inbox.test.ts`, `src/hub/finding-store.test.ts`, `src/cli/commands/task.test.ts` — exercise `captureTask`/`readFindings` reused here; confirm still green (no source change to those modules).

### Features That Could Be Affected
- **task CLI (`bober task add`)** — shares `captureTask`. This sprint adds a second caller; verify `task add` still captures exactly one Finding (its tests cover this).
- **hub `/priority` chat command** — shares `chat-session.ts handleTurn`. Verify the prelude (tailer/approval polls) and persist still run for the capture path.

### Recommended Regression Checks
1. `npm run build` exits 0 (sc-5-1) — confirms the union is exhaustively handled and no unused vars.
2. `npx vitest run src/chat/turn-classifier.test.ts` — existing + new sc-5-2/5-3/5-5 green.
3. `npx vitest run src/chat/chat-session.test.ts src/chat/chat-session-capture.test.ts` — hub regressions + sc-5-4 green.
4. `npx vitest run src/chat src/hub src/cli/commands/task.test.ts` — full chat/hub/task surface green (no regressions).
5. `npm run lint` (or the configured lint script) — zero errors; specifically NO unused vars (see Pitfalls).

---

## 8. Implementation Sequence

1. **src/chat/turn-classifier.ts** — add the union member (line 20), the schema `z.object` (line 43), the parse branch (after line 90), and the system-prompt lines (lines 145-156 region). Keep `FALLBACK` (line 46) and both fallback returns (lines 118, 120) untouched.
   - Verify: `npm run build` clean; the union compiles and `parseClassifierAction` exhaustively narrows.
2. **src/chat/turn-classifier.test.ts** — append the sc-5-2 / sc-5-3 / sc-5-5 cases (§5d).
   - Verify: `npx vitest run src/chat/turn-classifier.test.ts` all green (old + new).
3. **src/chat/chat-session.ts** — add the two imports (facts + task-inbox), the `capture-task` dispatch branch (line ~288 region), and the `handleCaptureTask` private method (after line 452).
   - Verify: `npm run build` clean; no unused imports/vars.
4. **src/chat/chat-session-capture.test.ts** — create the sc-5-4 test (§5e).
   - Verify: `npx vitest run src/chat/chat-session-capture.test.ts` green; reply is a confirmation and exactly one open action Finding is persisted.
5. **Run full verification** — `npm run build`, then `npx vitest run src/chat src/hub src/cli/commands/task.test.ts`, then the lint script. All must pass with zero regressions.

---

## 9. Pitfalls & Warnings

- **Unused-var lint is a HARD gate (an earlier sprint in THIS plan failed once on it).** `noUnusedLocals`/`noUnusedParameters` + ESLint unused-vars-error are on. If you destructure or import something you do not use, the build fails. Only the `_` prefix escapes it (principles `:36`). Double-check every new import (`FactStore`, `factsDbPath`, `ensureFactsDir`, `captureTask`) is actually referenced, and that `OnceClient`/`ScriptedClient` params you ignore are prefixed `_` (e.g. `_p: ChatParams`).
- **`.js` extensions on every relative import** (NodeNext ESM). New imports must read `"../state/facts.js"`, `"../hub/task-inbox.js"`, `"../hub/finding-store.js"` — NOT `.ts`, NOT extensionless.
- **`import type` for type-only imports** (ESLint `consistent-type-imports`). In the test, `LLMClient`/`ChatParams`/`ChatResponse` are types → `import type { ... }`. `FactStore`, `factsDbPath`, `ensureFactsDir`, `captureTask`, `readFindings`, `ChatSession` are values → normal `import`.
- **Do NOT call the Answerer in the capture branch.** The branch returns `handleCaptureTask`'s string directly; it must not fall through to `this.answerer.answer` (line 258). The `OnceClient` in the sc-5-4 test enforces this.
- **`new Date()` is allowed ONLY at the chat-handler boundary for the captureTask stamp** (principles: no `Date.now()`/`new Date()` except where `now` is stamped for captureTask). Keep `captureTask`/the store clock-free — pass `now` in. Do not add a clock read inside any hub/store function.
- **Reuse `captureTask`, do not re-implement the write.** Building a Finding inline or calling `writeFinding`/`writeFact` directly violates the non-goal and the "single write path" assumption.
- **ADDITIVE only on the union/schema.** Do not reorder, rename, or alter existing union members or schema objects — the evaluator checks every existing action still parses and that the malformed→`answer` FALLBACK is intact.
- **`readFindings` THROWS on a malformed row** (`finding-store.ts:45-49`) — fine for the sc-5-4 assertion (rows are well-formed), but do not use it where silent-skip is needed (that is `FactStoreFindingSource`).
- **The handler is not DI for the store.** Resist refactoring `ChatSession` to inject a FactStore to satisfy the "in-memory" wording in sc-5-4 — that is non-additive and risks the existing session tests. Use the temp-dir + re-open pattern (§5e).
- **`memoryNamespace` threading:** the capture branch uses `this.memoryNamespace` (may be `undefined` for the default team). The sc-5-4 test must re-open with the SAME namespace it constructed the session with (`undefined` if none passed) so `factsDbPath` resolves to the same file.
