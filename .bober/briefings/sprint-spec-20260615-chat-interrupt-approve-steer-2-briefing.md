# Sprint Briefing: Surface pending approvals in chat (read path) + roster input-required

**Contract:** sprint-spec-20260615-chat-interrupt-approve-steer-2
**Generated:** 2026-06-15T17:30:00Z

> READ-ONLY sprint. You NEVER write `.pending.json` / `.approved.json` / `.rejected.json` markers and you DO NOT touch `approval-state.ts` write functions. You only READ markers, dedupe-announce them, weave a notice into the chat reply, and idempotently reflect pending fields onto the chat-owned RunState.

---

## 1. Target Files

### src/chat/approval-reader.ts (create)

**Directory pattern:** Files in `src/chat/` use kebab-case, a leading `// -- name.ts -----` section header, `import type` for types, `.js` import extensions, named class export. Model on `roster-reader.ts` (a read-only wrapper over a `src/state/` list helper).
**Most similar existing file:** `src/chat/roster-reader.ts` (whole file, 46 lines) — a thin class wrapping a state-layer list function.

**Structure template (mirror roster-reader.ts):**
```ts
// ── approval-reader.ts ────────────────────────────────────────────────
//
// Read-only wrapper over listPending for chat context.
// NEVER writes approval markers (Sprint 3 owns the write path).

import { listPending } from "../state/approval-state.js";
import type { PendingMarker } from "../state/approval-state.js";

export class ApprovalReader {
  private readonly projectRoot: string;
  constructor(projectRoot: string) { this.projectRoot = projectRoot; }

  /** Read all pending markers. Missing dir => []; corrupt files skipped (delegated to listPending). */
  async read(): Promise<PendingMarker[]> {
    return listPending(this.projectRoot);
  }
}
```

`listPending` ALREADY tolerates a missing dir (`approval-state.ts:82-86` returns `[]` on `readdir` throw) and ALREADY skips corrupt files (`approval-state.ts:90-98` try/catch per file). You do NOT need to add tolerance — sc-2-4 passes for free by delegating. Do not re-implement the readdir loop.

---

### src/chat/approval-cursor.ts (create)

**Directory pattern:** Same as cursor-store.ts / careful-sidecar.ts — a tiny class persisting one JSON file under `.bober/chat/<sessionId>.<name>.json`, missing/malformed-tolerant read, atomic-ish `writeFile` with `mode: 0o600`.
**Most similar existing files:** `src/chat/cursor-store.ts` (whole file, 64 lines) and `src/chat/careful-sidecar.ts` (whole file, 46 lines). `careful-sidecar.ts` is the closest in size/shape (single small JSON, try/catch read, `ensureDir` + `writeFile` write).

**Identity key (contract assumption, generatorNotes):** `` `${checkpointId}@${requestedAt}` `` — stable while a gate stays pending, changes if the gate is re-requested in a later round. Use EXACTLY this key (sc-2-6 keys dedupe on checkpointId+requestedAt).

**Structure template (mirror cursor-store.ts:25-64 + careful-sidecar.ts:19-45):**
```ts
// ── approval-cursor.ts ────────────────────────────────────────────────
//
// Tracks which pending markers have already been announced in chat, by
// key `${checkpointId}@${requestedAt}`. Persists at
// .bober/chat/<sessionId>.approvals-cursor.json. Mirrors cursor-store.ts.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir } from "../utils/fs.js";
import type { PendingMarker } from "../state/approval-state.js";

interface AnnouncedFile { announced: string[]; }
const EMPTY: AnnouncedFile = { announced: [] };

export function markerKey(m: PendingMarker): string {
  return `${m.checkpointId}@${m.requestedAt}`;
}

export class ApprovalCursor {
  constructor(
    private readonly projectRoot: string,
    private readonly sessionId: string,
  ) {}

  private path(): string {
    return join(this.projectRoot, ".bober", "chat", `${this.sessionId}.approvals-cursor.json`);
  }

  private async read(): Promise<AnnouncedFile> {
    try { return JSON.parse(await readFile(this.path(), "utf-8")) as AnnouncedFile; }
    catch { return { ...EMPTY }; }
  }

  /** Return markers not yet announced AND record them as announced. */
  async filterNew(markers: PendingMarker[]): Promise<PendingMarker[]> {
    const file = await this.read();
    const seen = new Set(file.announced);
    const fresh = markers.filter((m) => !seen.has(markerKey(m)));
    if (fresh.length > 0) {
      for (const m of fresh) seen.add(markerKey(m));
      await ensureDir(join(this.projectRoot, ".bober", "chat"));
      await writeFile(this.path(), JSON.stringify({ announced: [...seen] }, null, 2) + "\n",
        { encoding: "utf-8", mode: 0o600 });
    }
    return fresh;
  }
}
```
Read uses try/catch → EMPTY (mirrors `cursor-store.ts:44-50` and `careful-sidecar.ts:26-33`). Write uses `ensureDir(.bober/chat)` + `writeFile(..., { mode: 0o600 })` (mirrors `cursor-store.ts:56-63`).

---

### src/chat/chat-session.ts (modify)

Sprint 1 already edited this file (added `CarefulSidecar` field at :87/:108, `handleCareful` at :225). Line numbers below are CURRENT.

**Constructor — add two fields (next to `this.tailer` at :105-108):**
```ts
// :80  private readonly tailer: CompletionTailer;
// add:  private readonly approvalReader: ApprovalReader;
//       private readonly approvalCursor: ApprovalCursor;
// :105-108 in constructor, after this.tailer = ...:
//   this.approvalReader = new ApprovalReader(this.projectRoot);
//   this.approvalCursor = new ApprovalCursor(this.projectRoot, this.sessionId);
```
Consider an injectable option in `ChatSessionOptions` (`:22-40`) mirroring `tailer?` (`:32-33`, used `:105-107`) so tests can inject a fake reader. Optional but matches the existing test seam.

**Poll prelude — handleTurn at :120, next to the completion poll at :122-127:**
```ts
async handleTurn(input: string): Promise<string | null> {
    // ── Poll for run completions (prelude) ──
    let completions: CompletionEvent[] = [];
    try {
      completions = await this.tailer.poll();
    } catch {
      // Poll errors must never break the turn
    }
    // >>> ADD: poll for pending approvals (same try/catch shape) <<<
    let approvalNotice = "";
    try {
      const pending = await this.approvalReader.read();
      const states = await this.roster.read();   // for correlation by runId
      const fresh = await this.approvalCursor.filterNew(pending);
      // build notice from `fresh`; reflect onto RunState for correlated markers
    } catch {
      // Approval read errors must never break the turn
    }
```
Wrap in a try/catch IDENTICAL to the completion poll at `:123-127`. A read error MUST NOT break the turn (sc-2-8 demands Phase-1-identical behavior, and the try/catch keeps no-pending a no-op since `read()` returns `[]`).

**Weave into BOTH reply paths — the two critical edit sites:**

1. **Slash path** (`:136-150`). The completion notices are prepended at `:140-145`:
```ts
    if (slashResult.handled) {
      if (slashResult.exit) return null;
      let output = slashResult.output ?? "";
      if (completions.length > 0) {
        const notices = completions
          .map((c) => `[run ${c.runId ?? "unknown"} finished: ${c.phase}]`)
          .join("\n");
        output = `${notices}\n\n${output}`;
      }
      // >>> ADD: prepend approvalNotice the same way (only if non-empty) <<<
      // if (approvalNotice) output = `${approvalNotice}\n\n${output}`;
      ...
    }
```

2. **LLM path** (`:186-192`). The completion notices are prepended at `:187-192`:
```ts
    // ── Weave completion notices ──
    if (completions.length > 0) {
      const notices = completions
        .map((c) => `[run ${c.runId ?? "unknown"} finished: ${c.phase}]`)
        .join("\n");
      reply = `${notices}\n\n${reply}`;
    }
    // >>> ADD: prepend approvalNotice the same way (only if non-empty) <<<
    // if (approvalNotice) reply = `${approvalNotice}\n\n${reply}`;
```

**Notice format (generatorNotes):** `` `[run <runId> waiting at <checkpointId>: <prompt first-line/truncated>]` ``. Use `m.runId ?? "unknown"` for markers with no runId (assumption: still announced, never hidden). sc-2-5 asserts the notice contains the runId, the checkpoint id, AND the prompt text — include all three.

CRITICAL (sc-2-8): only prepend when the notice string is non-empty. The no-pending test (`chat-session-completion.test.ts:95-108`) asserts `reply` is EXACTLY `"Just a normal answer."` with nothing prepended. An empty-but-prepended `"\n\n" + reply` would break it.

**Imports this file uses (current):** `LLMClient` (`../providers/types.js`), `loadLessonIndex/loadLesson` (`../state/memory.js`), `ConversationStore`, `RosterReader`, `TurnClassifier`, `Answerer`, `dispatch`, `RunSpawner`, `CarefulSidecar`, `CompletionTailer` + type `CompletionEvent` — all from `./*.js`. ADD: `ApprovalReader` from `./approval-reader.js`, `ApprovalCursor` from `./approval-cursor.js`, `writeRunState` from `../state/run-state.js`.

**Imported by:** `src/cli/commands/chat.ts` (constructs `new ChatSession(...)`). Tests: `chat-session-completion.test.ts`, `chat-session-spawn.test.ts`, `chat-session-steer.test.ts`.
**Test file:** No `chat-session.test.ts`; behavior is split per-concern (`chat-session-completion/spawn/steer.test.ts`). Create `chat-session-approval.test.ts`.

---

### src/chat/roster-reader.ts (modify)

**Relevant section — `summarize` (lines 30-45):**
```ts
  summarize(states: RunState[]): string {
    if (states.length === 0) return "No runs found.";
    const lines: string[] = [`Runs (${states.length} total):`];
    for (const s of states) {
      const completed = s.completedAt ? ` completed=${s.completedAt}` : "";
      const spec = s.specId ? ` spec=${s.specId}` : "";
      lines.push(
        `  [${s.status.toUpperCase()}] ${s.runId}  task="${s.task}"${spec}  started=${s.startedAt}${completed}`,
      );
    }
    return lines.join("\n");
  }
```
`[${s.status.toUpperCase()}]` (`:40`) ALREADY renders `input-required` → `[INPUT-REQUIRED]` for free (sc-2-7's bracket assertion passes with zero changes once the RunState status is flipped). The ONLY (optional, additive) change: when `s.status === "input-required"`, append the pending prompt/checkpoint, e.g.:
```ts
      const pending = s.status === "input-required" && s.pendingCheckpointId
        ? ` waiting=${s.pendingCheckpointId}` : "";
      // ...append `${pending}` to the pushed line
```
Keep it small and additive so the existing `roster-reader.test.ts` line-format assertions still pass.

**Imported by:** `src/chat/slash-commands.ts:6` (uses `roster.read()` + `roster.summarize()` for `/runs` at `slash-commands.ts:56-60`), `src/chat/chat-session.ts:11`.
**Test file:** `src/chat/roster-reader.test.ts` (exists).

---

## 2. Patterns to Follow

### Read-only state-layer list helper already does the tolerance
**Source:** `src/state/approval-state.ts`, lines 80-101
```ts
export async function listPending(projectRoot: string): Promise<PendingMarker[]> {
  let entries: string[];
  try { entries = await readdir(approvalsDir(projectRoot)); }
  catch { return []; }                                    // missing dir => []
  const out: PendingMarker[] = [];
  for (const f of entries.filter((x) => x.endsWith(".pending.json"))) {
    try { out.push(JSON.parse(await readFile(join(approvalsDir(projectRoot), f), "utf-8")) as PendingMarker); }
    catch { /* skip corrupted files */ }                  // corrupt => skip
  }
  return out;
}
```
**Rule:** Delegate `ApprovalReader.read()` straight to `listPending`. Do NOT re-implement directory scanning or add your own tolerance — it already handles missing-dir-`[]` and corrupt-skip (sc-2-4).

### Sidecar persistence (missing-file tolerant read, 0o600 write)
**Source:** `src/chat/cursor-store.ts`, lines 44-63
```ts
  async read(): Promise<CursorFile> {
    try { return JSON.parse(await readFile(this.path(), "utf-8")) as CursorFile; }
    catch { return { ...EMPTY }; }
  }
  async write(cursor: CursorFile): Promise<void> {
    await ensureDir(join(this.projectRoot, ".bober", "chat"));
    await writeFile(this.path(), JSON.stringify(cursor, null, 2) + "\n",
      { encoding: "utf-8", mode: 0o600 });
  }
```
**Rule:** ApprovalCursor read → try/catch → default; write → `ensureDir(.bober/chat)` then `writeFile(..., { mode: 0o600 })`. Path = `.bober/chat/<sessionId>.approvals-cursor.json`.

### Try/catch poll prelude that never breaks the turn
**Source:** `src/chat/chat-session.ts`, lines 121-127
```ts
    let completions: CompletionEvent[] = [];
    try { completions = await this.tailer.poll(); }
    catch { /* Poll errors must never break the turn */ }
```
**Rule:** The approval read block mirrors this exactly — initialise empty, wrap the read in try/catch, swallow errors. This is what guarantees sc-2-8 (no-pending = no behavior change).

### Notice woven by prepending `notice\n\n` ONLY when non-empty
**Source:** `src/chat/chat-session.ts`, lines 187-192 (LLM path) and 140-145 (slash path)
```ts
    if (completions.length > 0) {
      const notices = completions.map((c) => `[run ${c.runId ?? "unknown"} finished: ${c.phase}]`).join("\n");
      reply = `${notices}\n\n${reply}`;
    }
```
**Rule:** Gate the prepend on a non-empty condition (`approvalNotice` truthy). Never prepend an empty string.

### Idempotent RunState reflection via writeRunState
**Source:** write helper `src/state/run-state.ts:41-53`; status union `src/mcp/run-manager.ts:38`; Phase 2 fields `src/mcp/run-manager.ts:55-63`
```ts
// run-manager.ts:38
status: "running" | "completed" | "failed" | "aborted" | "input-required" | "paused";
// run-manager.ts:57-61
pendingCheckpointId?: string; pendingPrompt?: string; pendingSince?: string;
```
**Rule:** When a marker's `runId` matches a RunState whose `status === "running"`, write back `{ ...state, status: "input-required", pendingCheckpointId, pendingPrompt, pendingSince }` via `writeRunState(projectRoot, next)`. Flip ONLY `running` → `input-required`. NEVER clobber `completed`/`aborted`/`failed`/already-`input-required`. `pendingSince` = the marker's `requestedAt` (or `new Date().toISOString()` if you prefer "when chat first saw it"; contract says reflect pending fields — `requestedAt` is the truthful source). `writeRunState` is atomic (temp + rename, `:46-52`).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `listPending` | `src/state/approval-state.ts:80` | `(projectRoot): Promise<PendingMarker[]>` | List ALL pending markers (full shape incl. `runId`, `prompt`). Missing-dir → `[]`, corrupt → skip. ApprovalReader delegates to this. |
| `PendingMarker` (type) | `src/state/approval-state.ts:25` | `{ checkpointId; runId?; artifact; prompt; requestedAt; timeoutAt }` | The marker shape. `runId` and (note) `artifact`/`timeoutAt` are present; correlation uses `runId`. |
| `listPendingApprovals` | `src/state/approval-state.ts:179` | `(projectRoot): Promise<PendingApprovalRow[]>` | Cockpit-row shape `{checkpointId, ageMs, prompt}` — NO runId. Do NOT use for correlation; use `listPending`. |
| `writeRunState` | `src/state/run-state.ts:41` | `(projectRoot, state): Promise<void>` | Atomic (temp+rename) write of `.bober/runs/<runId>/state.json`. Use to reflect pending fields. |
| `readRunState` | `src/state/run-state.ts:61` | `(projectRoot, runId): Promise<RunState\|null>` | Read one RunState; null on missing/corrupt. Useful in tests to assert reflected fields. |
| `readRunStatesFromDisk` | `src/state/run-state.ts:110` | `(projectRoot): Promise<RunState[]>` | Read all RunStates (read-only). `RosterReader.read()` wraps this — use the roster, not this directly, in chat-session. |
| `ensureDir` | `src/utils/fs.ts:45` | `(path): Promise<void>` | `mkdir(recursive)`. Use in ApprovalCursor.write before writeFile. (Note: `src/state/helpers.ts:6` also exports `ensureDir`; chat-layer code imports the `utils/fs.js` one — see cursor-store.ts:10.) |
| `fileExists` | `src/utils/fs.ts:10` | `(path): Promise<boolean>` | Async readable check. Not strictly needed but available. |
| `readJson` / `writeJson` | `src/utils/fs.ts:24,34` | `<T>(path): Promise<T>` / `(path, data)` | Generic JSON helpers — NOT used by sidecars (they do explicit JSON.parse + 0o600 writeFile). Stay consistent with cursor-store.ts/careful-sidecar.ts; do not introduce writeJson here. |

**Do NOT recreate:** a directory scanner for `.pending.json` (use `listPending`), a corrupt-file skipper (built into `listPending`), an atomic RunState writer (use `writeRunState`), or a generic JSON read-with-default (mirror the sidecar try/catch inline).

---

## 4. Prior Sprint Output

### Sprint 1 (commit 14c2be6): RunState fields + CarefulSidecar + careful spawn
**Modified:** `src/mcp/run-manager.ts` — `RunState.status` union now includes `"input-required" | "paused"` (`:38`); added optional `pendingCheckpointId`/`pendingPrompt`/`pendingSince`/`pausedAt` (`:55-63`). These are the EXACT fields Sprint 2 SETS.
**Created:** `src/chat/careful-sidecar.ts` — `CarefulSidecar` (the per-session JSON-sidecar pattern; ApprovalCursor mirrors its read/write shape). Wired into `chat-session.ts` at `:87`/`:108`/`:225`.
**Connection to this sprint:** Sprint 2 fills the pending fields Sprint 1 declared. RunState round-trip via `writeRunState`/`readRunState` is verified working — your reflection write + test read-back rely on it. Do NOT re-declare the status union or pending fields; they already exist.

### Phase 1 (#44): chat REPL + CompletionTailer/cursor-store dedupe
**Created:** `src/chat/completion-tailer.ts` (poll + weave-into-reply model), `src/chat/cursor-store.ts` (announce-once dedupe model), `src/chat/roster-reader.ts`, `src/chat/chat-session.ts` handleTurn loop.
**Connection:** ApprovalReader ≈ CompletionTailer (read+dedupe+weave); ApprovalCursor ≈ CursorStore (per-session seen-set). The completion weave at `chat-session.ts:140-145`/`:187-192` is the literal template for the approval weave — add a SECOND prepend alongside it, do not replace it.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM + `.js` extensions** on every import (`principles.md:27`). NodeNext.
- **`import type`** for types — `consistent-type-imports` is enforced (`principles.md:35`). Import `PendingMarker`, `RunState`, `CompletionEvent` as types.
- **Filesystem state, async only** — `node:fs/promises`, no sync fs (`principles.md:42`).
- **No fs mocks** — tests create temp dirs and clean up (`principles.md:44`). Every test here uses `mkdtemp`/`rm`.
- **Section headers** `// ── Name ──` on new files (`principles.md:32`).
- **Strict TS** — `noUnusedLocals`/`noUnusedParameters` etc.; prefix unused params with `_` (`principles.md:18,36`).

### Architecture Decisions
No ADR specific to chat approvals found under `.bober/architecture/`. The governing decisions are encoded in the contract assumptions: correlation by `PendingMarker.runId`; at most one careful chat run at a time this phase (ambiguity deferred to Sprint 6); read-only w.r.t. the approvals dir.

### Other Docs
`CLAUDE.md`: no repo-root project CLAUDE.md governs source conventions beyond principles.md. The contract `generatorNotes`/`evaluatorNotes` (verified above) are authoritative for touch points.

---

## 6. Testing Patterns

### Unit Test Pattern (temp-dir, synthetic markers + RunStates)
**Source:** `src/state/approval-state.test.ts:25-47` (marker fixture + temp dir) and `src/chat/chat-session-completion.test.ts:15-44,76-108` (handleTurn + fake LLM)
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-chat-approval-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

// Synthetic .pending.json directly on disk (do NOT use savePending — keeps test read-only):
async function injectPending(root: string, m: object & { checkpointId: string }) {
  const dir = join(root, ".bober", "approvals");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${m.checkpointId}.pending.json`), JSON.stringify(m, null, 2), "utf-8");
}

// Marker fixture (mirror approval-state.test.ts:37-47):
function makeMarker(o?: Partial<{ checkpointId: string; runId: string; prompt: string; requestedAt: string }>) {
  const now = new Date().toISOString();
  return { checkpointId: "cp-1", artifact: { type: "research-doc" },
           prompt: "Approve this", requestedAt: now, timeoutAt: now, ...o };
}
```
**Runner:** vitest. **Assertion style:** `expect(...).toBe/.toContain/.toEqual/.toHaveLength`. **Mock approach:** NO mocks — temp dirs (`principles.md:44`); LLM is a hand-rolled fake object (`chat-session-completion.test.ts:26-44`). **File naming:** collocated `*.test.ts`. **Location:** co-located next to source in `src/chat/`.

### Fake LLM for handleTurn tests
**Source:** `src/chat/chat-session-completion.test.ts:26-44` — first `chat()` call returns `{"action":"answer"}` (classifier), subsequent calls return the answer text. For an approval test you just need a deterministic answer reply so you can assert the approval notice is PREPENDED.

### Synthetic running RunState (for correlation + reflection assertions)
**Source:** `src/chat/chat-session-steer.test.ts:13` (`import { writeRunState }`) and canonical progress shape `src/state/run-state.test.ts:36`
```ts
import { writeRunState, readRunState } from "../state/run-state.js";
import type { RunState } from "../mcp/run-manager.js";

const running: RunState = {
  runId: "run-X", task: "demo", status: "running",
  startedAt: "2026-06-15T00:00:00.000Z",
  progress: { completed: 0, total: 1 },   // canonical RunProgress (run-manager.ts:21-26)
  projectRoot: tmpDir,
};
await writeRunState(tmpDir, running);
// ...after handleTurn:
const after = await readRunState(tmpDir, "run-X");
expect(after?.status).toBe("input-required");
expect(after?.pendingCheckpointId).toBe("cp-1");
```
WARNING: `roster-reader.test.ts:19-34` uses a NON-canonical `progress` shape (`currentSprint/totalSprints/...`) cast loosely — do NOT copy that shape; use `{ completed, total }` from `run-state.test.ts:36` which matches `RunProgress` (`run-manager.ts:21-26`) and won't trip strict typing.

### Tests to write (cover all 8 ACs)
- `approval-reader.test.ts`: two markers (one with runId, one without) → both returned; corrupt `.pending.json` → skipped; missing `.bober/approvals` → `[]` (sc-2-4).
- `approval-cursor.test.ts`: `filterNew` returns a marker once, then `[]` for the same key on a second call; missing cursor file tolerated; two markers with different `requestedAt` are distinct keys (sc-2-6).
- `chat-session-approval.test.ts`: (sc-2-5) inject marker + matching running RunState → `handleTurn` reply contains runId+checkpointId+prompt; (sc-2-6) two `handleTurn` calls → notice only on first; (sc-2-7) after turn, `readRunState` shows `input-required`+pending fields AND `roster.summarize(states)` contains `[INPUT-REQUIRED]`; (sc-2-8) NO markers → reply has no approval notice (assert exact equality like `chat-session-completion.test.ts:107`).

### E2E Test Pattern
Not applicable — no Playwright in this CLI repo. Sprint 6 owns any e2e.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/chat/slash-commands.ts` | `RosterReader.summarize` (`:58`) | medium | `/runs` output format — if you append a `waiting=` segment in summarize, slash-commands consumes the string verbatim; just don't change existing segments. |
| `src/cli/commands/chat.ts` | `ChatSession` ctor | low | If you add an optional `approvalReader?`/`approvalCursor?` to `ChatSessionOptions`, keep them optional so chat.ts's existing construction still compiles. |
| `src/chat/chat-session-completion.test.ts` | `handleTurn` reply text (`:107`) | HIGH | Asserts `reply === "Just a normal answer."` with no prefix. Your empty-notice guard MUST keep this exact (sc-2-8). |
| `src/chat/chat-session-spawn.test.ts` / `chat-session-steer.test.ts` | `handleTurn` behavior | medium | No pending markers in those temp dirs → approval read returns `[]` → no notice → unchanged. Verify they stay green. |
| `src/chat/roster-reader.test.ts` | `summarize` line format | medium | Existing line-format assertions; keep your addition gated on `status === "input-required"` so running/completed lines are byte-identical. |
| `src/mcp/run-manager.ts` consumers | `RunState` (read) | low | You only WRITE new optional fields already declared in Sprint 1; no consumer break. Do NOT change the type. |

### Existing Tests That Must Still Pass
- `src/chat/chat-session-completion.test.ts` — the no-weave case (`:95-108`) is the sc-2-8 canary; must stay exactly `"Just a normal answer."`.
- `src/chat/roster-reader.test.ts` — summarize format for running/completed/empty rosters.
- `src/chat/chat-session-spawn.test.ts`, `src/chat/chat-session-steer.test.ts` — full handleTurn paths; verify no spurious approval notice.
- `src/state/approval-state.test.ts` — proves `listPending`/`listPendingApprovals` behavior; do NOT modify approval-state.ts so these stay green (evaluatorNotes: confirm write functions untouched).
- `src/state/run-state.test.ts` — round-trip of writeRunState/readRunState you rely on.

### Features That Could Be Affected
- **`/runs` slash command** — shares `RosterReader.summarize`. Verify `/runs` still renders running/completed runs identically and now shows `[INPUT-REQUIRED]` for a reflected run.
- **Completion weaving (Phase 1, sc-3-7)** — shares the handleTurn prelude/weave sites. Verify completion notices still appear (do not move/replace the completion block; add alongside it).
- **Careful mode (Sprint 1)** — shares `.bober/chat/` sidecar dir and chat-session ctor. New `.approvals-cursor.json` filename must not collide with `.careful.json`/`.cursor.json` (it does not).

### Recommended Regression Checks
1. `npm run build` — zero TS errors (sc-2-1).
2. `npm run typecheck` — zero strict errors (sc-2-2).
3. `npm run test` — full suite green; specifically `npx vitest run src/chat src/state/approval-state.test.ts src/state/run-state.test.ts` (sc-2-3, sc-2-8).
4. Manual grep self-check: confirm `src/state/approval-state.ts` is byte-unchanged (no write functions added) — `git diff --stat src/state/approval-state.ts` shows no changes.

---

## 8. Implementation Sequence

1. **src/chat/approval-reader.ts** — class delegating `read()` to `listPending` (no new tolerance logic).
   - Verify: `npm run typecheck` clean; import resolves.
2. **src/chat/approval-reader.test.ts** — sc-2-4 (two markers, corrupt skip, missing-dir `[]`).
   - Verify: `npx vitest run src/chat/approval-reader.test.ts`.
3. **src/chat/approval-cursor.ts** — `ApprovalCursor` + exported `markerKey`, key = `` `${checkpointId}@${requestedAt}` ``, mirror cursor-store.ts read/write.
   - Verify: typecheck clean.
4. **src/chat/approval-cursor.test.ts** — sc-2-6 (announce-once, distinct keys, missing-file tolerated).
   - Verify: `npx vitest run src/chat/approval-cursor.test.ts`.
5. **src/chat/chat-session.ts** — add fields + ctor wiring; add try/catch approval poll in handleTurn (read markers, read roster, `filterNew`, build notice, reflect onto RunState via `writeRunState` idempotently); prepend `approvalNotice` (when non-empty) into BOTH the slash reply (:140-145 area) and the LLM reply (:187-192 area).
   - Verify: typecheck clean; existing chat-session-completion/spawn/steer tests still green (`npx vitest run src/chat`).
6. **src/chat/roster-reader.ts** — optional additive `waiting=<checkpointId>` segment gated on `status === "input-required"`.
   - Verify: `npx vitest run src/chat/roster-reader.test.ts` green.
7. **src/chat/chat-session-approval.test.ts** — sc-2-5, sc-2-6 (two-turn dedupe), sc-2-7 (RunState read-back + summarize `[INPUT-REQUIRED]`), sc-2-8 (no-pending exact-equality no-op).
   - Verify: `npx vitest run src/chat/chat-session-approval.test.ts`.
8. **Run full verification** — `npm run build`, `npm run typecheck`, `npm run test`.

---

## 9. Pitfalls & Warnings

- **Empty notice must not be prepended (sc-2-8).** Gate every prepend on a non-empty `approvalNotice`. The no-pending test asserts `reply === "Just a normal answer."` exactly (`chat-session-completion.test.ts:107`). An accidental `"\n\n" + reply` fails it.
- **Two weave sites, not one.** Notices must appear on BOTH the slash path (`:140-145`) and the LLM path (`:187-192`). Forgetting the slash path means `/runs` turns won't surface the notice. ADD alongside the completion block; never replace it (would break Phase 1 sc-3-7).
- **Correlate with `listPending`, not `listPendingApprovals`.** Only `listPending`/`PendingMarker` carries `runId` (`approval-state.ts:27`). `listPendingApprovals` rows drop runId (`approval-state.ts:161-165`) and cannot correlate.
- **Idempotent reflection.** Flip ONLY `running` → `input-required`. Re-running the prelude on an already-`input-required` (or `completed`/`aborted`) run must NOT rewrite/clobber. Guard with `if (state.status === "running")` before `writeRunState`. (The cursor already suppresses re-announce, but the RunState flip needs its own guard since correlation runs every turn.)
- **Cursor key identity.** Use EXACTLY `` `${checkpointId}@${requestedAt}` ``. Using checkpointId alone would suppress legitimate re-requests in a later round; using the whole marker would re-announce on any field change.
- **Do NOT touch `approval-state.ts`.** Read-only sprint; evaluator explicitly confirms write functions are untouched (`nonGoals`, evaluatorNotes). No new functions there.
- **`ensureDir` import source.** Chat-layer sidecars import `ensureDir` from `../utils/fs.js` (see `cursor-store.ts:10`, `careful-sidecar.ts:9`) — NOT from `../state/helpers.js`. Stay consistent.
- **`import type` for `PendingMarker`/`RunState`/`CompletionEvent`.** `consistent-type-imports` is a hard lint gate (`principles.md:35`); mixing value+type import will fail.
- **RunProgress shape in synthetic states.** Use `{ completed, total }` (run-manager.ts:21-26 / run-state.test.ts:36), NOT the looser shape in roster-reader.test.ts:25-32 — strict typing will reject the latter outside a cast.
- **PendingMarker has required `artifact` and `timeoutAt`.** When building synthetic markers in tests, include `artifact` and `timeoutAt` (see `approval-state.test.ts:37-47`) or the `as PendingMarker` cast hides a runtime-incomplete object; the marker fixture provides both.
- **`pendingSince` source.** Set it to the marker's `requestedAt` for truthfulness (the contract says "reflect pending fields"); sc-2-7 only asserts it is set, so either `requestedAt` or `now()` passes — prefer `requestedAt`.
