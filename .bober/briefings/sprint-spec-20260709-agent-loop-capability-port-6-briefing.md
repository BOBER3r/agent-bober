# Sprint Briefing: Loop session persistence, resume and fork (.bober/sessions/)

**Contract:** sprint-spec-20260709-agent-loop-capability-port-6
**Generated:** 2026-07-10T00:00:00Z

---

## 0. What this sprint adds (one paragraph)

A NEW `src/orchestrator/session-store.ts` module (Zod `SessionRecord` + a `SessionStore` class over `.bober/sessions/<id>.json`, mirroring `src/research/job-store.ts`). `AgenticLoopParams` gains two OPTIONAL fields: `session?: { store; sessionId }` and `initialMessages?: Message[]`. When `session` is present, the loop writes the full transcript after every turn (crash-resumable). `resumeSession()` loads a prior transcript as `initialMessages`; `forkSession()` copies a transcript to a new id. **No `session` option → no files, byte-identical (sc-6-4).** All 8 existing callers of `runAgenticLoop` pass neither field, so they stay byte-identical automatically.

---

## 1. Target Files

### src/orchestrator/session-store.ts (create)

**Directory pattern:** `src/orchestrator/*.ts` is kebab-case; the module to MIRROR lives elsewhere: `src/research/job-store.ts` (the canonical filesystem-state store pattern).
**Most similar existing file:** `src/research/job-store.ts` — copy its structure verbatim (path helpers → Zod validate-before-write → safeParse-on-read → async fs only).
**Zod schema template:** mirror `ResearchJobSchema` at `src/research/types.ts:33-61` (uses `z.object`, `z.string().datetime()`, `.optional()`).

There is **NO existing Zod schema for the `Message` union** (verified: `grep MessageSchema` and `z.literal("assistant")` return nothing in `src/`). You must author a `MessageSchema` Zod union in `session-store.ts` that matches the 4 variants in `src/providers/types.ts:135-139`. Structural template:

```ts
import { z } from "zod";
import type { Message } from "../providers/types.js";
import { ensureDir } from "../state/helpers.js";

// Zod mirror of src/providers/types.ts Message union (types.ts:135-139).
const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  input: z.record(z.unknown()),
});
const ToolResultSchema = z.object({
  toolUseId: z.string(),
  content: z.string(),
  isError: z.boolean().optional(),
});
const MessageSchema: z.ZodType<Message> = z.union([
  z.object({ role: z.enum(["user", "assistant"]), content: z.string() }),        // TextMessage
  z.object({ role: z.literal("assistant"), content: z.string(), toolCalls: z.array(ToolCallSchema) }), // AssistantMessage
  z.object({ role: z.literal("user"), toolResults: z.array(ToolResultSchema) }),  // ToolResultMessage
  z.object({ role: z.literal("user"), systemUpdate: z.string(), cacheTtl: z.enum(["5m","1h"]).optional() }), // SystemUpdateMessage
]);

export const SessionRecordSchema = z.object({
  sessionId: z.string().min(1),
  model: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  turnsUsed: z.number().int().nonnegative(),
  messages: z.array(MessageSchema),
});
export type SessionRecord = z.infer<typeof SessionRecordSchema>;
```

> **Zod union ordering caveat:** `z.union` tries variants in order and takes the first match. `TextMessage {role:"assistant", content}` and `AssistantMessage {role:"assistant", content, toolCalls}` overlap on `{role,content}`. Put the MORE-SPECIFIC variant (AssistantMessage, has `toolCalls`) FIRST, or use a stricter object (`.strict()`) so an assistant-with-toolCalls doesn't get parsed as a bare TextMessage and silently drop `toolCalls`. Test round-trip of an AssistantMessage explicitly.

**Store API (per generatorNotes):** `SessionStore` over `.bober/sessions/<id>.json` with `save(record)`, `load(sessionId)`, `fork(sessionId, newId)`, `path(sessionId)`. Follow `job-store.ts` conventions:
- Path sanitization: `id.replace(/[^a-zA-Z0-9_-]/g, "_")` — `job-store.ts:17`.
- `save`: `await ensureDir(...)` then `SessionRecordSchema.safeParse` (throw on invalid so bad data never hits disk) then `writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf-8")` — `job-store.ts:47-60`.
- `load`: `JSON.parse(await readFile(...))` in try/catch, `safeParse`, return `null` on missing OR malformed — `job-store.ts:100-113`. **This null-on-corrupt is what `resumeSession` maps to its error variant (sc-6-5).**
- Project root: `job-store` takes `projectRoot` as a function arg. `SessionStore` may take `projectRoot` in its constructor (see `ConversationStore` at `conversation-store.ts:36-39` for the constructor-holds-projectRoot style) so the loop only holds an opaque `store` handle.

### src/orchestrator/session-store.test.ts (create)

**Most similar existing file:** `src/research/job-store.test.ts` — copy its `mkdtemp`/`rm` temp-dir lifecycle (see §6).

### src/orchestrator/agentic-loop.ts (modify)

**(a) Add the two optional params to the interface — `AgenticLoopParams`, ends at line 92.** Insert after `hooks?: LoopHooks;` (line 91), before the closing brace:

```ts
  // agentic-loop.ts:20-92 — AgenticLoopParams. Add:
  /** Opt-in loop-transcript persistence to .bober/sessions/<sessionId>.json (sprint 6). Absent => no files, byte-identical. */
  session?: { store: SessionStore; sessionId: string };
  /** Prior transcript to seed AHEAD of `userMessage` (resume). Absent => byte-identical. */
  initialMessages?: Message[];
```

**(b) The initial-messages seed point — `agentic-loop.ts:320-322` (CURRENT):**
```ts
  const messages: Message[] = [
    { role: "user", content: userMessage },
  ];
```
Change to seed `initialMessages` AHEAD of the new user message (sc-6-2 asserts the client's first `chat()` call receives the seeded messages before the new user message):
```ts
  const messages: Message[] = [
    ...(initialMessages ?? []),
    { role: "user", content: userMessage },
  ];
```
Also add `session`, `initialMessages` to the destructuring block at `agentic-loop.ts:292-311`.

**(c) The per-turn APPEND points (where messages grow):**
- Tool-use turn: assistant message pushed at **`agentic-loop.ts:483-488`**, tool-result message pushed at **`agentic-loop.ts:558-562`**. Save AFTER line 562 (end of the tool-turn body, just before `onTurnComplete?.(...)` at line 564).
- Completion turn (non-tool): **`agentic-loop.ts:432-479`**. NOTE: on this path the code sets `finalText = response.text` (line 433) and returns WITHOUT pushing an assistant message onto `messages`. So to persist the final assistant turn you must push it into the record on this path (see §4 decision).
- Nudge path: **`agentic-loop.ts:446-455`** pushes an assistant + a user message then `continue`s. The next iteration's save captures them; no extra save needed unless you want mid-nudge crash safety.

**(d) The `finish()` helper — `agentic-loop.ts:345-356`** routes every stop path (all 4 returns) through one place. Good spot to reason about a final save, but per-turn saves already cover crash-resumability; a final save inside `finish()` is optional belt-and-suspenders.

**(e) The existing 'error' stop path — `agentic-loop.ts:378-394`** returns `stopReason: "error"`. This is the shape a resume failure is "consistent with" per generatorNotes. NOTE: `resumeSession` runs BEFORE the loop, so it returns its own `{ error }` variant; it does not go through this in-loop path. Keep the two conceptually aligned in docs but do not throw from `resumeSession`.

**(f) Exports to add:** `resumeSession(store, sessionId): Promise<{ initialMessages: Message[]; sessionId: string } | { error: string }>` and `forkSession(store, sessionId, newId?): Promise<string>`. Add these to the barrel at `src/index.ts:117-121` (currently exports `runAgenticLoop`, `AgenticLoopParams`, `AgenticLoopResult`) plus `SessionStore`/`SessionRecord` from the new module.

**Imports this file uses (agentic-loop.ts:1-16):** `Message`, `AssistantMessage`, `ToolResultMessage`, `ToolCall`, `ToolResult` from `../providers/types.js`; `logger` from `../utils/logger.js`. Add: `SessionStore`/`SessionRecord` from `./session-store.js`.

**Imported by (8 callers — all pass NEITHER new field, so byte-identical):** `src/orchestrator/{planner,curator,generator,evaluator,architect,documenter,code-reviewer,research}-agent.ts` and re-exported by `src/index.ts:117`. See §7.

**Test file:** `src/orchestrator/agentic-loop.test.ts` (exists — extend it).

### src/orchestrator/agentic-loop.test.ts (modify)
Add session/resume/fork tests. Reuse the `ScriptedLoopClient` at `agentic-loop.test.ts:18-30` (it captures `lastParams` — needed for sc-6-2). Add `mkdtemp`/`rm` temp-dir lifecycle (see §6).

### src/providers/types.ts (modify — likely READ-ONLY)
The `Message` union (`types.ts:135-139`) is **already fully JSON-serializable** (see §9 verification). The contract lists this file only "if any variant carries non-serializable fields." **None do** — you most likely will NOT edit this file. If you touch it at all, only to add a doc comment; do not change the type shape.

---

## 2. Patterns to Follow

### Filesystem-state store (THE pattern to mirror)
**Source:** `src/research/job-store.ts`, lines 42-113
```ts
export async function addJob(projectRoot: string, job: ResearchJob): Promise<void> {
  await ensureDir(jobsDir(projectRoot));
  const validation = ResearchJobSchema.safeParse(job);
  if (!validation.success) { /* throw with issue list */ }
  await writeFile(jobPath(projectRoot, job.id),
    JSON.stringify(validation.data, null, 2) + "\n", "utf-8");
}
export async function readJob(projectRoot: string, id: string): Promise<ResearchJob | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(jobPath(projectRoot, id), "utf-8"));
    const result = ResearchJobSchema.safeParse(raw);
    return result.success ? result.data : null;   // null on malformed
  } catch { return null; }                          // null on missing
}
```
**Rule:** validate with Zod `safeParse` before every write; read with `JSON.parse`+`safeParse` in try/catch returning `null` on both missing and corrupt. Pretty-print JSON with a trailing newline. Async `node:fs/promises` only.

### Deterministic / injectable id (no argless randomness in core)
**Source:** `src/research/job-store.ts`, lines 28-33
```ts
export function jobId(question: string, createdAt: string): string {
  return createHash("sha256").update(`${question}|${createdAt}`).digest("hex").slice(0, 16);
}
```
**Rule:** ids are content-hashed from injected inputs (here `createdAt` is passed in, never read from the clock). For `forkSession(sessionId, newId?)`, accept `newId` as an injectable arg (tests pass an explicit id); when omitted, derive it deterministically (e.g. hash of `sessionId` + an injected `now`/counter) rather than calling `randomUUID()` argless.

### Clock injection at the boundary
**Source:** `src/do-bridge/launcher.ts:31,55` (constructor pattern) and `src/cli/commands/research.ts:111`
```ts
// launcher.ts:31 (option) + :55 (default binding)
now?: () => string;
this.now = opts.now ?? (() => new Date().toISOString());
// research.ts:111 — clock read ONLY at the CLI .action() boundary
const now = new Date().toISOString();
```
**Rule:** core modules never call argless `new Date()`. Take a `now?: () => string` and default it to `() => new Date().toISOString()` at the constructor/param boundary; tests inject a fixed clock. `SessionStore.save` sets `updatedAt` (and `createdAt` on first save) from an injected `now`.

### Swallow-and-log (fail-soft) — reuse for save failures
**Source:** `src/orchestrator/agentic-loop.ts:333-341` (`safeEmit`)
```ts
const safeEmit = (event: LoopEvent): void => {
  if (!onEvent) return;
  try { onEvent(event); }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`onEvent hook threw (swallowed): ${message}`);
  }
};
```
**Rule:** a per-turn session-save failure MUST NOT crash the loop. Wrap the `await store.save(...)` in try/catch, `logger.warn` on failure, and continue — same shape as `safeEmit`. Document this decision (§4).

### Additive-optional / byte-identical gating
**Source:** `src/orchestrator/agentic-loop.ts:374` (`...(effort !== undefined ? { effort } : {})`) and the whole sprint-5 `onEvent`/`hooks` gating
**Rule:** every new behavior is gated on `if (session)` / `initialMessages ?? []`. When the field is absent the code path must be identical to today's. sc-6-4 asserts the FULL suite is unchanged and `.bober/sessions/` is never created.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `ensureDir` | `src/state/helpers.ts:6` | `(dirPath: string): Promise<void>` | `mkdir -p`. Use THIS one (job-store imports it from `../state/helpers.js`). |
| `ensureDir` (dup) | `src/utils/fs.ts:45` | `(path): Promise<void>` | Same behavior, different module. Do NOT import both; pick `state/helpers.js` to match job-store. |
| `writeJson` | `src/utils/fs.ts:34` | `(path, data): Promise<void>` | Pretty JSON + trailing `\n` + ensureDir(dirname). Optional convenience if you prefer over raw `writeFile`. |
| `readJson<T>` | `src/utils/fs.ts:24` | `(path): Promise<T>` | Reads+parses JSON but THROWS on missing/bad — do NOT use for load; use try/catch+safeParse like job-store. |
| `fileExists` | `src/utils/fs.ts:10` | `(path): Promise<boolean>` | Async R_OK check. |
| `jobId` | `src/research/job-store.ts:28` | `(question, createdAt): string` | Reference impl for content-hash ids (do not import; author a session-id analog). |
| `logger` | `src/utils/logger.ts` | `.warn/.debug/...` | Structured logging (already imported in agentic-loop.ts:15). Use `.warn` for fail-soft save errors. |
| `ScriptedLoopClient` | `src/orchestrator/agentic-loop.test.ts:18-30` | test double | Scripted `LLMClient`; captures `lastParams` (needed to assert seeded messages, sc-6-2). |

Utilities reviewed: `src/state/helpers.ts`, `src/utils/fs.ts`, `src/research/job-store.ts`, `src/chat/conversation-store.ts`. No existing session-transcript store, no existing `Message` Zod schema — both must be authored.

---

## 4. Design Guidance (decisions to make, with justification)

**Where to hook the per-turn save.** Add one small `persistSession()` closure inside `runAgenticLoop`, gated `if (!session) return;`. Call it at TWO places:
1. **After the tool-result append (`agentic-loop.ts:562`)**, before `onTurnComplete` at line 564. At this point `messages` holds the assistant message (line 488) AND the tool results (line 562) — a crash-resumable snapshot of a completed tool turn. Set `turnsUsed = turn`.
2. **On the completion path (`agentic-loop.ts:432-479`)**, right before the `return finish({...})` at line 467. The completion turn does NOT push its assistant text onto `messages`, so build the saved record's `messages` as `[...messages, { role: "assistant", content: finalText }]` so the final answer is persisted. Set `turnsUsed = turn`. (Do this append only inside the `if (session)` block so non-session runs are byte-identical — `messages` is local and unused after this point, so gating keeps behavior provably unchanged.)

Also save on the max-turns exit (`agentic-loop.ts:573-585`) and the API-error exit (`agentic-loop.ts:378-394`) if you want those partial transcripts durable; both are optional (the last completed turn was already saved by hook #1).

**What `turnsUsed` means mid-run.** It is the number of turns whose messages are captured in this record = the current `turn` counter at save time. After a 3-turn scripted run the final record has `turnsUsed: 3` (matches `AgenticLoopResult.turnsUsed`). The evaluator checks exactly this (evaluatorNotes sc-6-1).

**Should save failures crash the loop? NO.** Recommendation: fail-soft — `try { await store.save(rec); } catch (err) { logger.warn(...) }` and continue, mirroring `safeEmit` (`agentic-loop.ts:333-341`). Rationale: persistence is an opt-in convenience; losing a transcript write must not fail an otherwise-successful agent run. Document this in the param JSDoc. (Contrast: `save` itself still THROWS on a Zod-invalid record per the job-store pattern — that is a programmer error, caught by the try/catch and logged.)

**`resumeSession` error variant vs the loop's 'error' path.** `resumeSession(store, sessionId)` loads via `store.load()`; on `null` (missing OR corrupt JSON) it returns `{ error: "..." }` and NEVER throws and NEVER writes a replacement file (sc-6-5: "never silently starts an empty session in place of the requested one"). On success it returns `{ initialMessages, sessionId }`, which the caller threads into `runAgenticLoop({ initialMessages, session: { store, sessionId } })`. It is a PRE-loop helper — it does not itself produce a `stopReason:"error"` result; keep it a discriminated union the caller inspects. The "consistent with stopReason 'error'" note (`agentic-loop.ts:391`) is about conceptual alignment for docs, not a shared code path.

**`forkSession(store, sessionId, newId?)`.** Load the source record (return/throw-strategy: if source is missing, decide — simplest is to throw or return the null-consequence; the contract's sc-6-3 only exercises the happy path), then `save` a copy under `newId` with `messages` copied and `sessionId` updated to `newId`, `createdAt` fresh (or preserved), `updatedAt` = now. Returns the new `sessionId` string. sc-6-3: continuing the fork must leave the ORIGINAL file byte-identical — so fork writes ONLY the new file and never re-writes the source.

---

## 5. Prior Sprint Output & Relevant Docs

### Prior sprints (1-5, all on agentic-loop.ts — anchors are stale, re-located above)
- Sprint 5 added `onEvent`/`hooks` and the single `finish()` exit helper (`agentic-loop.ts:345-356`) that every stop path routes through — reuse its swallow-and-log shape for saves.
- Sprint 3 added `budget`/`costUsd`; sprint 1 added `refused`. None interact with sessions beyond sharing the `messages` array and `finish()`.

### Project Principles (`.bober/principles.md`)
- L31 **Filesystem state:** all mutable state is JSON under `.bober/`. No DB, no in-memory global state.
- L42 **No synchronous fs:** use `node:fs/promises` only — no `readFileSync`.
- L44 **No fs mocks in tests:** create real temp dirs and clean up (this is the `mkdtemp`/`rm` pattern).

### Architecture (`.bober/architecture/arch-20260709-agent-sdk-agent-loop-harness-*`)
- `...-architecture.md:52` — **Area 7 "Sessions & continuity" is UNUSED**, and states verbatim: *"Chat /resume and do-bridge sessionId are run-scoped, not model-context resume; no fork."* This sprint delivers the model-context transcript layer. **Keep names distinct** (nonGoal L54): the NEW `.bober/sessions/<id>.json` transcript is a DIFFERENT layer from chat `.bober/chat/<sessionId>.jsonl` and do-bridge `do-<findingId>` run sessions.
- ADR-1 rejects adopting the Agent SDK's `query()`/resume/fork wholesale — port into the own loop (this sprint does exactly that).

### Name-collision map (grep for `sessionId` returned these — DO NOT touch/confuse)
- `src/chat/conversation-store.ts:26` — `.bober/chat/<sessionId>.jsonl`, append-only JSONL of `{role,content,ts}` chat turns (class `ConversationStore`). Different dir, different format, different purpose.
- `src/do-bridge/launcher.ts:64` — `sessionId ?? "do-<findingId>"`, a RunSpawner sidecar id for a spawned `agent-bober run` child process. Run-scoped, not a transcript.

---

## 6. Testing Patterns

### Temp-dir lifecycle (REQUIRED — principle L44)
**Source:** `src/research/job-store.test.ts:1-19`
```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

let tmpRoot: string;
beforeEach(async () => { tmpRoot = await mkdtemp(join(tmpdir(), "bober-loop-session-")); });
afterEach(async () => { await rm(tmpRoot, { recursive: true, force: true }); });
```
**Runner:** vitest. **Assertion style:** `expect(...)`. **Mock approach:** `vi.fn`/`vi.spyOn` (see `agentic-loop.test.ts:199,565`); NO fs mocks. **File naming:** co-located `*.test.ts`. **Location:** co-located next to source.

### Scripted client + asserting the client received the seeded messages (sc-6-2)
**Source:** `src/orchestrator/agentic-loop.test.ts:18-30` (class) and `:587` (inspecting `lastParams.messages`)
```ts
class ScriptedLoopClient implements LLMClient {
  private idx = 0; callCount = 0; lastParams?: ChatParams;
  constructor(private readonly responses: ChatResponse[]) {}
  async chat(params: ChatParams): Promise<ChatResponse> {
    this.callCount += 1; this.lastParams = params;
    const r = this.responses[Math.min(this.idx, this.responses.length - 1)];
    this.idx += 1; return r;
  }
}
// sc-6-2 assertion shape (mirrors agentic-loop.test.ts:587):
const first = client.lastParams?.messages;   // capture BEFORE more turns; or capture per-call
expect(first?.[0]).toEqual({ role: "assistant", content: "prior turn" }); // seeded ahead of new user msg
```
> To assert the FIRST call specifically (not just the last), either script a single-turn run so `lastParams` == first call, or extend the fake client to record every call's `messages` into an array. sc-6-2 says "the fake client's FIRST chat() call receives the seeded messages before the new user message."

### const `base` helper
**Source:** `agentic-loop.test.ts:32` — `const base = { toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };` — spread into scripted responses: `{ ...base, text: "done", stopReason: "end" }`.

### Mid-run assertion for "file exists after turn 1" (sc-6-1)
The evaluator hints "hook into per-turn callback to check mid-run" — use the existing `onTurnComplete?: (turn, toolsCalled)` param (`agentic-loop.ts:57,564`): in the test, pass an `onTurnComplete` that, on `turn === 1`, reads/asserts `await store.load(sessionId)` already exists. This is a clean seam that already fires after each tool turn.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/orchestrator/{planner,curator,generator,evaluator,architect,documenter,code-reviewer,research}-agent.ts` | `runAgenticLoop` (imports `./agentic-loop.js`) | low | They call `runAgenticLoop({...})` WITHOUT `session`/`initialMessages`. New fields are OPTIONAL → their call sites compile & behave identically. Verify no positional/required-param change. |
| `src/index.ts:117-121` | re-exports loop symbols | low | Add `resumeSession`,`forkSession`,`SessionStore`,`SessionRecord` exports; keep existing 3 exports intact. |
| `src/providers/types.ts:135-139` | `Message` union | low/none | Do NOT change the type shape. Only the NEW `MessageSchema` mirror (in session-store.ts) must stay in sync with it. |

### Existing Tests That Must Still Pass
- `src/orchestrator/agentic-loop.test.ts` — the entire refusal/effort/budget/parallel/events/hooks suite (sc-1..sc-5). sc-6-4 requires these unchanged. The `messages`-array seed edit (`agentic-loop.test.ts` clients never pass `initialMessages`, so `...(initialMessages ?? [])` is `[]` → identical).
- `src/orchestrator/loop-events.test.ts` — event ordering; unaffected as long as saves are added OUTSIDE the emit sequence (do not add `safeEmit` calls for saving).
- `src/research/job-store.test.ts` — the store pattern you copy; unaffected but is your reference for temp-dir + round-trip.
- All 8 agent test suites (`*-agent.test.ts`) — call the loop; must stay green (byte-identical no-session path).

### Features That Could Be Affected
- **Chat `/resume` + `ConversationStore`** — shares the WORD "session" and `.bober/chat/`. Verify you write to `.bober/sessions/` (NOT `.bober/chat/`) and never touch `ConversationStore`. Different layer (arch doc L52).
- **do-bridge RunSpawner** — shares `sessionId` naming. No shared code; just keep docs distinct.

### Recommended Regression Checks (run after implementation)
1. `npm run build` (tsc) and `npm run typecheck` (tsc --noEmit) — sc-6-6.
2. `npx vitest run src/orchestrator/agentic-loop.test.ts src/orchestrator/session-store.test.ts` — new + touched suites.
3. `npx vitest run` — FULL suite (was 3802 green); sc-6-4 requires no regressions.
4. Manually/negatively assert: a no-session run creates NO `.bober/sessions/` dir (test with a temp projectRoot and `fileExists`/`readdir` on the sessions dir → absent).

---

## 8. Implementation Sequence (dependency-ordered)

1. **`src/providers/types.ts`** — READ ONLY; confirm the `Message` union (lines 135-139) shape you must mirror. (Almost certainly no edit.)
   - Verify: the 4 variants and their fields match your Zod `MessageSchema`.
2. **`src/orchestrator/session-store.ts`** — author `SessionRecordSchema` + `MessageSchema` (Zod) and `SessionStore` (`save`/`load`/`fork`/`path`) mirroring `job-store.ts`. Inject `now`.
   - Verify: `tsc --noEmit` clean; a scratch round-trip parses back deep-equal (esp. an AssistantMessage with `toolCalls` — union-ordering trap).
3. **`src/orchestrator/session-store.test.ts`** — temp-dir round-trip, save→load, fork isolation, corrupt-file → `load` returns null.
   - Verify: `npx vitest run src/orchestrator/session-store.test.ts` green.
4. **`src/orchestrator/agentic-loop.ts`** — add `session`/`initialMessages` to `AgenticLoopParams` (after line 91) + destructuring (292-311); seed `initialMessages` at 320-322; add the gated `persistSession()` and call it after 562 and before the completion return (467); add `resumeSession`/`forkSession` exports; wrap saves in fail-soft try/catch.
   - Verify: `tsc --noEmit` clean; existing `agentic-loop.test.ts` still green (byte-identical no-session path).
5. **`src/index.ts`** — extend the barrel (lines 117-121) with the new exports.
   - Verify: `tsc --noEmit` clean.
6. **`src/orchestrator/agentic-loop.test.ts`** — add sc-6-1..sc-6-5 tests (per-turn persistence via `onTurnComplete` mid-run check; resume seeds client via `lastParams`; fork byte-compare of original file; no-session absence; corrupt → error variant no throw).
   - Verify: `npx vitest run src/orchestrator/agentic-loop.test.ts` green.
7. **Full verification** — `npm run build` && `npm run typecheck` && `npx vitest run` (full suite unchanged, sc-6-6 + sc-6-4).

---

## 9. Pitfalls & Warnings

- **JSON-serializability is confirmed OK — do not "normalize" the Message union.** All 4 variants (`types.ts:135-139`) are plain data: `TextMessage {role,content:string}`, `AssistantMessage {role,content:string,toolCalls:ToolCall[]}` where `ToolCall={id,name,input:Record<string,unknown>}`, `ToolResultMessage {role,toolResults:ToolResult[]}` where `ToolResult={toolUseId,content,isError?}`, `SystemUpdateMessage {role,systemUpdate,cacheTtl?:"5m"|"1h"}`. No Dates, functions, Maps, or class instances. `ToolCall.input` is `Record<string,unknown>` but originates from JSON tool-call parsing, so it serializes fine. `JSON.stringify`/`JSON.parse` round-trips losslessly.
- **The completion turn does NOT append its assistant text to `messages`** (`agentic-loop.ts:432-479`). If you persist `messages` verbatim on that path, the final answer is missing. Build the record with `[...messages, {role:"assistant",content:finalText}]` inside the `if (session)` block (§4).
- **Zod `z.union` variant ordering** — an AssistantMessage `{role:"assistant",content,toolCalls}` will match a bare TextMessage `{role:"assistant",content}` first and DROP `toolCalls` unless the more-specific variant is earlier or objects are `.strict()`. Test an AssistantMessage round-trip explicitly.
- **Two `ensureDir`s exist** (`state/helpers.ts:6` and `utils/fs.ts:45`). Import from `../state/helpers.js` to match `job-store.ts`; don't import both.
- **`readJson` (utils/fs.ts:24) THROWS** on missing/bad JSON — do NOT use it for `load`; use the try/catch+`safeParse`→null pattern from `job-store.ts:100-113`, which is what makes sc-6-5 (corrupt → error variant, no throw) work.
- **No argless `new Date()`/`randomUUID()` in `session-store.ts` or the loop's save path** (principle + do-bridge convention). Inject `now`/`newId`. The loop already avoids clock reads; keep it that way.
- **Byte-identical guarantee (sc-6-4) is fragile** — every new statement must be behind `if (session)` or `?? []`. Do not reorder existing `messages.push` calls, do not add `safeEmit` for saving, do not change `finish()`'s existing behavior. Run the FULL suite, not just the loop suite.
- **Corrupt-file must not be overwritten** (sc-6-5). `resumeSession` only READS; it returns `{error}` and writes nothing. The loop is never started on the error path, so no empty session replaces the corrupt file.
- **Fork must not rewrite the source** (sc-6-3). `forkSession` writes ONLY the new-id file; continuing the fork saves only to the new id. Byte-compare the original before/after in the test.
- **Do not confuse `.bober/sessions/` with `.bober/chat/`** (ConversationStore) or do-bridge `do-<findingId>` sessions (arch doc L52; nonGoal L54).
