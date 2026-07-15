# Sprint Briefing: Rotation-safe completion weaving (history.jsonl tailer)

**Contract:** sprint-spec-20260614-bober-chat-session-layer-3
**Generated:** 2026-06-14T00:00:00Z

---

## 1. Target Files

### src/chat/completion-tailer.ts (create)

**Directory pattern:** Files in `src/chat/` use kebab-case names, a leading `// ── name.ts ──` banner, named class/interface exports, ESM `.js` import extensions, and `node:fs/promises` only (no sync fs — principles.md:42).
**Most similar existing file for structure:** `src/chat/conversation-store.ts` (JSONL read + skip-malformed-lines + ENOENT-returns-empty) and `src/chat/pid-sidecar.ts` (per-session JSON state at `.bober/chat/<sessionId>.*`).

**What this module must do** (generatorNotes + sc-3-4..sc-3-8):
- Export `interface CompletionEvent { runId?: string; phase: "complete" | "failed"; completed: number; failed: number; durationMs: number; timestamp: string; }`
- Export `interface PollResult { events: CompletionEvent[]; cursor: number; }`
- Export `class CompletionTailer` with `async poll(): Promise<CompletionEvent[]>` (or `poll(cursor)` per sc-3-4). Loads cursor via CursorStore, stats `.bober/history.jsonl`, reads `[readFrom, EOF)`, parses lines, filters `event === "pipeline-complete"`, dedupes by runId, persists, returns new events.

**Structure template (mirror conversation-store.ts shape):**
```typescript
// ── completion-tailer.ts ───────────────────────────────────────────────
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { CursorStore } from "./cursor-store.js";
// reuse the live event shape — DO NOT redefine the history schema
import { HistoryEntrySchema } from "../state/history.js";

export interface CompletionEvent { /* runId?, phase, completed, failed, durationMs, timestamp */ }

export class CompletionTailer {
  private readonly store: CursorStore;
  constructor(private readonly projectRoot: string, private readonly sessionId: string) {
    this.store = new CursorStore(projectRoot, sessionId);
  }
  async poll(): Promise<CompletionEvent[]> { /* stat → shrink check → read → parse → dedupe → persist */ }
}
```

**poll algorithm (from generatorNotes — implement exactly):**
1. `stat` `.bober/history.jsonl`; on `ENOENT` return `{ events: [], cursor: 0 }` (sc-3-8 — catch the throw, check `err.code === "ENOENT"` OR just try/catch like conversation-store.ts:60-65).
2. If `stat.size < cursor` (rotation/truncation/shrink) ⇒ `readFrom = 0`; else `readFrom = cursor` (sc-3-5).
3. Read bytes `[readFrom, EOF)`. File is bounded to ~2000 lines by rotation (history.ts:99), so `readFile(path, "utf-8")` then `.slice(readFrom)` (byte-aware: use a Buffer slice, since cursor is a BYTE offset). Keep only complete lines (up to last `\n`); set new cursor to `readFrom + byteLengthOfConsumedCompleteLines`. A partial trailing line (mid-write) must NOT advance the cursor past it (assumptions[2]).
4. Parse each line via `HistoryEntrySchema.safeParse` (history.ts:38-45); keep `event === "pipeline-complete"`. Map `details.completed/failed/durationMs` → CompletionEvent. Derive runId from the line via the extractRunId pattern (event-stream.ts:47-58) — top-level `runId`, else `details.runId`. If still absent, scan `.bober/runs/` for a fresh `<id>.completed.json` marker (fallback per nonGoals[3] — markers written by writeCompletionMarker, feedback-router.ts:387).
5. Filter out completions whose runId ∈ `seenRunIds`; add newly-emitted runIds. If no resolvable runId, use synthetic dedupe key `timestamp + ":" + durationMs`.
6. Persist `{ byteCursor: newCursor, lastSize: stat.size, seenRunIds }` via CursorStore.

**Imports this file will use:**
- `readFile`, `stat` from `node:fs/promises`
- `join` from `node:path`
- `HistoryEntrySchema` from `../state/history.js`
- `CursorStore` from `./cursor-store.js` (this sprint)

**Test file:** `src/chat/completion-tailer.test.ts` (create — collocated, principles.md:20)

---

### src/chat/cursor-store.ts (create)

**Most similar existing file:** `src/chat/pid-sidecar.ts:21-64` — copy its EXACT shape (per-session JSON at `.bober/chat/<sessionId>.X.json`, `readAll` returns default on missing/malformed, `record`/`write` uses `ensureDir` + atomic write).

**Structure template (mirror pid-sidecar.ts):**
```typescript
// ── cursor-store.ts ─────────────────────────────────────────────────────
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir } from "../utils/fs.js";

export interface CursorFile {
  byteCursor: number;
  lastSize: number;
  seenRunIds: string[];   // serialize Set as array
}

const EMPTY: CursorFile = { byteCursor: 0, lastSize: 0, seenRunIds: [] };

export class CursorStore {
  constructor(private readonly projectRoot: string, private readonly sessionId: string) {}
  private path(): string {
    return join(this.projectRoot, ".bober", "chat", `${this.sessionId}.cursor.json`);
  }
  async read(): Promise<CursorFile> {
    try { return JSON.parse(await readFile(this.path(), "utf-8")) as CursorFile; }
    catch { return { ...EMPTY }; }
  }
  async write(cursor: CursorFile): Promise<void> {
    await ensureDir(join(this.projectRoot, ".bober", "chat"));
    await writeFile(this.path(), JSON.stringify(cursor, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  }
}
```

**Test file:** `src/chat/cursor-store.test.ts` (create) — or cover via completion-tailer.test.ts (sc-3-6 requires fresh-instance restart dedupe).

---

### src/chat/chat-session.ts (modify)

**Relevant section — constructor (lines 72-87):** add a `CompletionTailer` field, constructed from `this.projectRoot` + `this.sessionId` (mirror how `this.spawner` is built at lines 81-86). Consider an injectable option in `ChatSessionOptions` (lines 19-29) for tests (like `spawner?`).

**Relevant section — handleTurn LLM path (lines 110-143):** this is where to weave. Current code (extract):
```typescript
// line 110-116
const [states, memoryDistill, recentHistory] = await Promise.all([
  this.roster.read(),
  buildMemoryDistill(this.projectRoot),
  this.store.loadRecent(20),
]);
const rosterSummary = this.roster.summarize(states);
// line 118-124
const action = await this.classifier.classify(input);
let reply: string;
if (action.action === "answer") {
  reply = await this.answerer.answer(input, rosterSummary, memoryDistill, recentHistory);
}
// ...
// line 138-143 — persist
const now = new Date().toISOString();
await this.store.append({ role: "user", content: input, ts: now });
await this.store.append({ role: "assistant", content: reply, ts: now });
return reply;
```

**Weave plan (sc-3-7):**
1. At the start of the LLM path (a "prelude"), call `const completions = await this.tailer.poll();`. Add it to the `Promise.all` at lines 111-115 OR call before classify.
2. After `reply` is computed (after line 136), if `completions.length > 0`, append a concise system-note to the reply that references each `runId`, e.g. ``\n\n[run ${c.runId} finished: ${c.phase}]``. sc-3-7 asserts "the reply OR an appended system turn references the runId" — simplest is to append to `reply`.
3. Persist a system `ChatTurn` for transparency: the store only accepts `role: "user" | "assistant"` (conversation-store.ts:14-18 — `TurnRecord`). Append the completion notice as an `assistant` turn (mirror the slash-command persistence at lines 105-106), or fold it into the existing assistant reply turn (line 141). Do NOT add a new role to TurnRecord — out of scope.

**NOTE — slash-command early-return (lines 100-108):** the slash path returns before the LLM path. If completions should surface even on slash turns, poll before the slash dispatch. The contract only requires surfacing "on the next turn" — polling at the top of `handleTurn` (before line 100) is safest and covers both paths.

**Imports this file uses (lines 6-15):** readline, `LLMClient`, memory helpers, `ConversationStore`, `RosterReader`, `TurnClassifier`, `Answerer`, `dispatch`, `RunSpawner`. Add: `import { CompletionTailer } from "./completion-tailer.js";`

**Imported by:** `src/chat/chat-session-spawn.test.ts:6`, and the `bober chat` CLI command (Sprint 1). Constructor signature change must stay backward compatible (new field built internally, new option optional).

**Test file:** `src/chat/chat-session-spawn.test.ts` exists (covers spawn). Add a new test file `src/chat/chat-session-completion.test.ts` (or extend) for sc-3-7.

---

## 2. Patterns to Follow

### Skip-malformed-JSONL-line parsing
**Source:** `src/state/history.ts`, lines 53-69
```typescript
function parseEntries(content: string): HistoryEntry[] {
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  const entries: HistoryEntry[] = [];
  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line);
      const result = HistoryEntrySchema.safeParse(parsed);
      if (result.success) entries.push(result.data);
    } catch { /* Skip malformed lines */ }
  }
  return entries;
}
```
**Rule:** Parse JSONL line-by-line with `safeParse`; silently skip unparseable/invalid lines — never throw. The tailer must tolerate a partial trailing line the same way.

### ENOENT-returns-empty (graceful missing file)
**Source:** `src/chat/conversation-store.ts`, lines 59-65
```typescript
let raw: string;
try { raw = await readFile(path, "utf-8"); }
catch { return []; }  // File does not exist yet — no prior conversation
```
**Rule:** Wrap the history read in try/catch; on any read failure (incl. ENOENT) return `{ events: [], cursor: 0 }` (sc-3-8).

### Per-session JSON state file with safe default
**Source:** `src/chat/pid-sidecar.ts`, lines 40-63
```typescript
async readAll(): Promise<Record<string, PidEntry>> {
  try { return JSON.parse(await readFile(this.path(), "utf-8")) as Record<string, PidEntry>; }
  catch { return {}; }
}
async record(runId: string, entry: PidEntry): Promise<void> {
  await ensureDir(join(this.projectRoot, ".bober", "chat"));
  const all = await this.readAll();
  all[runId] = entry;
  await writeFile(this.path(), JSON.stringify(all, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
}
```
**Rule:** CursorStore copies this exactly — `.bober/chat/<sessionId>.cursor.json`, read returns default on error, write uses `ensureDir` + `mode: 0o600`.

### extractRunId from a parsed JSONL record
**Source:** `src/mcp/event-stream.ts`, lines 47-58
```typescript
function extractRunId(rec: unknown): string | undefined {
  if (typeof rec !== "object" || rec === null) return undefined;
  const r = rec as Record<string, unknown>;
  if (typeof r.runId === "string") return r.runId;        // top-level
  if (typeof r.details === "object" && r.details !== null) {
    const d = r.details as Record<string, unknown>;
    if (typeof d.runId === "string") return d.runId;       // nested in details
  }
  return undefined;
}
```
**Rule:** The `pipeline-complete` line (pipeline.ts:925-934) does NOT include runId in details — so this returns undefined for it. Fall back to the `.completed.json` marker (see Utilities). Re-implement this small helper locally (do NOT import — it is not exported from event-stream.ts).

### The live pipeline-complete event shape (DO NOT redefine the schema)
**Source:** `src/orchestrator/pipeline.ts`, lines 925-934
```typescript
await appendHistory(projectRoot, {
  timestamp: new Date().toISOString(),
  event: "pipeline-complete",
  phase: success ? "complete" : "failed",
  details: { completed: completedSprints.length, failed: failedSprints.length, durationMs: duration },
});
```
**Rule:** Filter on `event === "pipeline-complete"`. Read `details.completed`, `details.failed`, `details.durationMs`, plus `phase` and `timestamp`. The schema is `HistoryEntrySchema` (history.ts:38-45) — import and reuse it; do NOT hand-roll a parallel schema.

### Atomic JSON marker write (reference for the .completed.json fallback shape)
**Source:** `src/orchestrator/checkpoints/feedback-router.ts`, lines 387-404 — `writeCompletionMarker` writes `.bober/runs/<runId>.completed.json` with payload `{ runId, completedAt, ...summary }`.
**Rule:** The fallback reader must look for `.bober/runs/<id>.completed.json` files, parse `runId` from inside. Do NOT call writeCompletionMarker (write-side, owned by pipeline).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `HistoryEntrySchema` / `HistoryEntry` | `src/state/history.ts:38-45` | Zod schema `{ timestamp, event, phase, sprintId?, details }` | The exact history.jsonl line shape — import & `safeParse`, never redefine. |
| `appendHistory` | `src/state/history.ts:80` | `(projectRoot, entry) => Promise<void>` | Write-side only (used by pipeline). Reference, do not call. |
| `loadRecentHistory` | `src/state/history.ts:135` | `(projectRoot, {limit}) => Promise<HistoryEntry[]>` | Active-only tail read — but it has NO byte cursor, so it cannot dedupe across polls. Build the cursor tailer fresh. |
| `ensureDir` | `src/utils/fs.ts:45` | `(path) => Promise<void>` | `mkdir -p`. Use in CursorStore.write. |
| `readJson` / `writeJson` | `src/utils/fs.ts:24,34` | `<T>(path)=>Promise<T>` / `(path,data)=>Promise<void>` | Generic JSON read/write (writeJson pretty-prints + ensureDir). Optional alternative to hand-rolled CursorStore read/write. |
| `fileExists` | `src/utils/fs.ts:10` | `(path)=>Promise<boolean>` | Useful for the `.completed.json` marker fallback scan. |
| `writeCompletionMarker` | `src/orchestrator/checkpoints/feedback-router.ts:387` | `(projectRoot, runId, summary)=>Promise<void>` | Writes `.bober/runs/<id>.completed.json` `{runId, completedAt, ...}`. Write-side; fallback reader parses these. |
| `readRunStatesFromDisk` | `src/state/run-state.ts:110` | `(projectRoot)=>Promise<RunState[]>` | Roster run states. NOT needed for the tailer but available for runId correlation if desired. |
| `historyActivePath` | `src/state/history-rotation.ts:37` | `(projectRoot)=>string` | Returns `.bober/history.jsonl` path. Reuse instead of re-joining. |
| `rotateIfNeeded` | `src/state/history-rotation.ts:60` | `(projectRoot, maxActiveLines=2000)=>Promise<void>` | Explains WHY cursor can exceed file size (atomic rename to a shorter file). Do not modify (nonGoals[2]). |

**Utilities reviewed:** `src/utils/fs.ts`, `src/state/`, `src/chat/`, `src/orchestrator/checkpoints/`. No existing byte-offset/cursor file-tailer exists outside `EventStreamManager` (event-stream.ts), which uses `fs.watch` + live MCP push and is explicitly out of scope (nonGoals[2]). Build the cursor tailer fresh.

---

## 4. Prior Sprint Output

### Sprint 1: src/chat/ module
**Created:** `conversation-store.ts` (`ConversationStore`, `TurnRecord` role union user|assistant), `roster-reader.ts` (`RosterReader` wraps `readRunStatesFromDisk`), `turn-classifier.ts`, `answerer.ts` (`Answerer.answer(input, rosterSummary, memoryDistill, recentHistory)`), `slash-commands.ts` (`dispatch`).
**Connection:** ChatSession composes these. The completion notice must be persisted via `ConversationStore.append` using `role: "assistant"` (TurnRecord only allows user|assistant — conversation-store.ts:14-18).

### Sprint 2: RunSpawner + PidSidecar
**Created:** `run-spawner.ts` (`RunSpawner.spawn(task, runId): Promise<SpawnAck>`, launches `bober run <task> --run-id <runId>`), `pid-sidecar.ts` (`PidSidecar` at `.bober/chat/<sessionId>.pids.json`, `readAll()`/`record()`).
**Connection:** Spawned runs use a session-generated `run-<ts>` id (chat-session.ts:90-92). When that run finishes, `pipeline.ts` writes the `pipeline-complete` line + `.completed.json` marker. The tailer correlates the completion back to a runId (via marker fallback) and `PidSidecar.readAll()` can map runId→task for a richer notice. CursorStore copies PidSidecar's per-session-file pattern verbatim.

---

## 5. Relevant Documentation

### Project Principles (.bober/principles.md)
- ESM everywhere; all imports use `.js` extensions (NodeNext). principles.md:27
- No synchronous fs — use `node:fs/promises` only. principles.md:42
- No filesystem mocks in tests — create real temp dirs and clean up. principles.md:44
- TypeScript strict (noUnusedLocals/Params, noImplicitReturns, etc.); zero type errors is a hard gate. principles.md:18
- ESLint `consistent-type-imports`: use `import type { ... }`; prefix unused params with `_`. principles.md:35-36
- Tests collocated `*.test.ts` next to source. principles.md:20
- Section comments with `// ── Name ──` box headers. principles.md:32

### Architecture Decisions
No ADR specific to chat tailing. ADR-5/ADR-8 (graph-gated tools) are orchestrator-internal and not relevant here.

### Contract assumptions (load-bearing)
- Terminal line is `event:"pipeline-complete"`, `phase:"complete"|"failed"`, `details:{completed,failed,durationMs}` (pipeline.ts:925-934); runId is NOT in the line — correlate via `.completed.json` marker.
- history.jsonl rotates via `rotateIfNeeded(...,2000)` on EVERY append (history.ts:99) — a byte offset CAN exceed file size after rotation ⇒ shrink detection is mandatory.
- Reading `[cursor,EOF)` and parsing whole lines is acceptable; tolerate a partial trailing line by not advancing past it.

---

## 6. Testing Patterns

### Unit Test Pattern (temp-dir, real fs)
**Source:** `src/chat/conversation-store.test.ts`, lines 1-17, 56-74
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-tailer-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });
```
**Runner:** vitest. **Assertion style:** `expect(...).toEqual / .toHaveLength / .toContain / .toMatchObject`. **Mock approach:** NO fs mocks — real temp dirs (principles.md:44). **File naming:** `<name>.test.ts` collocated.

### Writing/rotating history.jsonl by hand in tests (sc-3-4, sc-3-5)
The malformed-line injection pattern from conversation-store.test.ts:60-65 shows direct fs writes:
```typescript
const { appendFile, mkdir, writeFile } = await import("node:fs/promises");
const histDir = join(tmpDir, ".bober");
await mkdir(histDir, { recursive: true });
const histPath = join(histDir, "history.jsonl");
const line = (e: object) => JSON.stringify(e) + "\n";
// sc-3-4: one complete + one non-complete
await appendFile(histPath, line({ timestamp: "2026-06-14T00:00:00.000Z", event: "pipeline-complete", phase: "complete", details: { completed: 1, failed: 0, durationMs: 1000 } }), "utf-8");
await appendFile(histPath, line({ timestamp: "2026-06-14T00:00:01.000Z", event: "phase-start", phase: "generating", details: {} }), "utf-8");
// sc-3-5: simulate rotation — OVERWRITE with shorter content keeping ONE new completion
await writeFile(histPath, line({ timestamp: "...", event: "pipeline-complete", phase: "failed", details: { completed: 0, failed: 1, durationMs: 50 } }), "utf-8");
```
Use the `.completed.json` marker to give a completion a runId in tests: write `.bober/runs/<id>.completed.json` with `{ runId: "<id>", ... }` (matches writeCompletionMarker output, feedback-router.ts:395-399).

### ChatSession turn test with fake LLM (sc-3-7)
**Source:** `src/chat/chat-session-spawn.test.ts`, lines 22-62 — inject a fake `LLMClient` (classify=answer) and drive `session.handleTurn(...)`:
```typescript
function makeAnswerLLM(replyText: string): LLMClient {
  return { chat: async () => ({ text: JSON.stringify({ action: "answer" }), usage: {inputTokens:0,outputTokens:0,totalTokens:0} }) } as unknown as LLMClient;
}
// inject a pipeline-complete line + .completed.json for a spawned runId, then:
const reply = await session.handleTurn("any question");
expect(reply).toContain("run-XXXX"); // notice references the runId
```
Note: classifier and answerer BOTH call `llm.chat`; the fake returns the classify JSON. To assert the completion notice you append it to `reply` AFTER the answerer returns, so it survives regardless of answer text.

### E2E Test Pattern
Not applicable — no Playwright; this is a CLI/library. No `playwright.config.ts` in repo.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/chat/chat-session-spawn.test.ts` | `ChatSession` constructor + `handleTurn` | medium | Constructor change must stay backward compatible (new tailer field built internally, new option optional). Spawn replies must NOT gain a spurious completion notice when no completion occurred. |
| `bober chat` CLI command (Sprint 1 wiring) | `ChatSession` constructor | low | Constructor still works with existing options; `sessionId`/`projectRoot` already passed. |
| `src/chat/conversation-store.ts` (`TurnRecord`) | role union `user`|`assistant` | low | Do NOT add a new role; persist the completion notice as `assistant`. |

`grep` for importers: `ChatSession` is imported only by `chat-session-spawn.test.ts:6` and the CLI command. `HistoryEntrySchema` import adds a new dependency from `src/chat/` → `src/state/history.ts` (acceptable; one-way).

### Existing Tests That Must Still Pass
- `src/chat/chat-session-spawn.test.ts` — tests spawn branch; verify replies are unchanged when no completion is pending (poll returns `[]` against a temp dir with no history.jsonl, so notice is empty). Currently these tests have no history.jsonl in their tmpDir ⇒ poll must return `{events:[],cursor:0}` (sc-3-8) and NOT alter the asserted reply substrings (`run-...`, `build something`, `Use /runs`).
- `src/chat/conversation-store.test.ts` — unaffected; verify still green.
- `src/state/history.test.ts` (if present) — do NOT modify history.ts; verify still green.

### Features That Could Be Affected
- **Spawn (Sprint 2)** — shares `ChatSession.handleTurn`; verify spawn replies/roster still correct and no completion notice leaks into spawn-turn assertions.
- **history.jsonl writers / rotation (pipeline.ts, history-rotation.ts)** — READ-ONLY for this sprint (nonGoals[2]). Do not touch.

### Recommended Regression Checks
1. `npm run build` (tsc clean — sc-3-1/sc-3-2).
2. `npx vitest run src/chat/` — all chat tests incl. new tailer/cursor/completion tests pass.
3. `npx vitest run src/chat/chat-session-spawn.test.ts` — spawn assertions unchanged.
4. `npx vitest run` (full suite) — no regressions in state/orchestrator tests.

---

## 8. Implementation Sequence

1. **src/chat/cursor-store.ts** — `CursorFile { byteCursor, lastSize, seenRunIds: string[] }` + `CursorStore` (read default-on-error, write ensureDir + 0o600). Mirror pid-sidecar.ts:21-64.
   - Verify: `tsc` clean; a quick test reads default `{byteCursor:0,lastSize:0,seenRunIds:[]}` from an empty dir.
2. **src/chat/completion-tailer.ts** — `CompletionEvent`, `CompletionTailer.poll()`. Implement: cursor model (CursorStore) → ENOENT-empty → shrink detection (size<cursor ⇒ readFrom=0) → byte-aware read of `[readFrom,EOF)` keeping complete lines → `HistoryEntrySchema.safeParse` + filter `event==="pipeline-complete"` → runId via extractRunId-pattern else `.completed.json` marker scan else synthetic key → dedupe against seenRunIds → persist.
   - Verify: sc-3-4 (one event of two lines), sc-3-5 (shrink reset, no drop/dup), sc-3-6 (restart dedupe via fresh instance), sc-3-8 (missing file → `{events:[],cursor:0}`).
3. **src/chat/chat-session.ts** — construct `CompletionTailer` in constructor (optional injectable option); poll at top of `handleTurn` (before slash dispatch); after `reply` computed, append a notice referencing each `runId`; persist as assistant turn. Keep constructor backward compatible.
   - Verify: sc-3-7 (turn after injected pipeline-complete references the run); spawn tests still pass.
4. **Tests** — `completion-tailer.test.ts` (+ optional `cursor-store.test.ts`, `chat-session-completion.test.ts`). Use real temp dirs; write/rotate history.jsonl by hand; write `.completed.json` markers for runId correlation.
   - Verify: all eight success criteria.
5. **Run full verification** — `npm run build`, `npx vitest run`, typecheck (tsc clean).

---

## 9. Pitfalls & Warnings

- **runId is NOT in the pipeline-complete line.** pipeline.ts:925-934 omits runId from `details`. `extractRunId` (event-stream.ts pattern) returns undefined for it — you MUST fall back to scanning `.bober/runs/<id>.completed.json` markers, else use a synthetic dedupe key (`timestamp:durationMs`). Skipping this makes sc-3-6/sc-3-7 fail.
- **Cursor is a BYTE offset, not a line/char count.** `readFile(path,"utf-8")` then `.slice(cursor)` is WRONG for multi-byte content — slice on the Buffer (`Buffer.byteLength` / `buf.subarray(readFrom)`) so the offset stays byte-accurate. Advance the new cursor by the byte length of the CONSUMED complete lines only.
- **Partial trailing line.** A mid-write append may leave a line without `\n`. Consume only up to the last `\n`; do not advance the cursor past a partial line (assumptions[2]) — otherwise the completion is permanently skipped.
- **Shrink detection is mandatory, not optional.** `rotateIfNeeded` (history.ts:99) atomically renames a SHORTER file over the active one on every append once >2000 lines — so `stat.size < cursor` is a normal steady-state event, not just truncation. Without the `size < cursor ⇒ readFrom=0` reset, you silently drop all post-rotation completions (sc-3-5).
- **Dedupe is the correctness keystone after a shrink reset.** Re-scanning from 0 re-reads every line; without runId dedupe against persisted `seenRunIds`, you re-emit every old completion (double-reporting). Persist seenRunIds as an array, hydrate into a Set.
- **Do NOT modify history.ts, history-rotation.ts, pipeline.ts, or EventStreamManager** (nonGoals[2]). Import `HistoryEntrySchema` read-only.
- **Do NOT read history.archive.jsonl** (nonGoals[3]) — use the `.completed.json` marker fallback for completions whose line rotated away.
- **TurnRecord has no "system" role** (conversation-store.ts:14-18). Persist the completion notice as `role: "assistant"`; do not extend the union (out of scope).
- **Spawn tests have no history.jsonl** — ensure poll returns `{events:[],cursor:0}` so existing chat-session-spawn.test.ts assertions (exact reply substrings) are not broken by a stray notice.
- **ESLint `consistent-type-imports`** — import `HistoryEntry`, `TurnRecord`, `CursorFile` etc. with `import type`. Prefix any unused param with `_`. No `any` (use `unknown` + narrowing, as event-stream.ts:48-49 does).
