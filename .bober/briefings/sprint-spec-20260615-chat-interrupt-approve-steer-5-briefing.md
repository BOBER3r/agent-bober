# Sprint Briefing: Soft pause / resume — /pause, /resume + paused RunState + cooperative gate

**Contract:** sprint-spec-20260615-chat-interrupt-approve-steer-5
**Generated:** 2026-06-15T17:30:00Z

> SOFT pause = keep the process alive, hold at the next checkpoint boundary. It is NOT the hard `/stop` (kill-by-PID, Phase 1). The whole sprint hinges on this distinction: `/pause` MUST NOT send a kill signal. `src/state/pause.ts` is a near-clone of Sprint 4's `src/state/guidance.ts`; `waitWhilePaused` is modeled on `DiskCheckpointMechanism.request`'s injected-clock poll loop; the pipeline gate sits one statement away from Sprint 4's guidance read point.

---

## 1. Target Files

### src/state/pause.ts (create)

**Directory pattern:** `src/state/*.ts` — kebab-case files, box-drawing section headers, async fs via `node:fs/promises`, atomic temp-file+rename writes, never-throw reads. Closest peer: `guidance.ts` (Sprint 4).

**Most similar existing file:** `src/state/guidance.ts` — copy its `runsRoot`/`runDir` path helpers, re-export style, and the `safeSegment` guard. Use `run-state.ts`/`approval-state.ts` for the `unlink`/`access` patterns.

**Path the marker lives at:** `.bober/runs/<runId>/paused.json` (same `runDir` as guidance/state — see `run-state.ts:23-29` and `guidance.ts:32-37`).

**Structure template (mirror guidance.ts exactly):**
```typescript
// ── pause.ts ──────────────────────────────────────────────────────────
//
// Disk-marker helpers for the runId-keyed SOFT-PAUSE channel.
// Layout: .bober/runs/<runId>/paused.json  → { pausedAt: string }
// Atomic write via temp-file + rename (mirrors run-state.ts:41-52).

import { writeFile, unlink, rename, access } from "node:fs/promises";
import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { ensureDir } from "./helpers.js";
import { safeSegment } from "./guidance.js";   // REUSE — do NOT redefine

function runsRoot(projectRoot: string): string {
  return join(projectRoot, ".bober", "runs");
}
function runDir(projectRoot: string, runId: string): string {
  return join(runsRoot(projectRoot), runId);
}
function pausePath(projectRoot: string, runId: string): string {
  return join(runDir(projectRoot, runId), "paused.json");
}

export async function setPaused(projectRoot, runId): Promise<void> {
  if (!safeSegment(runId)) throw new Error(`Invalid runId "${runId}": ...`);
  await ensureDir(runDir(projectRoot, runId));
  // atomic temp+rename — mirror run-state.ts:46-52
  const filePath = pausePath(projectRoot, runId);
  const rnd = randomBytes(4).toString("hex");
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${rnd}.tmp`;
  await writeFile(tmp, JSON.stringify({ pausedAt: new Date().toISOString() }) + "\n",
    { encoding: "utf-8", mode: 0o600 });
  await rename(tmp, filePath);
}

export async function clearPaused(projectRoot, runId): Promise<void> {
  if (!safeSegment(runId)) return;                 // best-effort, never throw
  await unlink(pausePath(projectRoot, runId)).catch(() => {});  // model: approval-state.ts:138
}

export async function isPaused(projectRoot, runId): Promise<boolean> {
  if (!safeSegment(runId)) return false;
  try { await access(pausePath(projectRoot, runId), constants.R_OK); return true; }
  catch { return false; }                          // model: guidance.ts:66-73
}
```

**The poll helper also lives here (export it so the pipeline imports one module):**
```typescript
export interface WaitWhilePausedOptions {
  pollMs?: number;
  timeoutMs?: number;
  now?: () => number;            // injected clock — MUST default to () => Date.now()
}
export async function waitWhilePaused(
  projectRoot: string, runId: string, opts: WaitWhilePausedOptions = {},
): Promise<void> { /* see §2 poll-loop pattern */ }
```

**Test file:** `src/state/pause.test.ts` (create — temp dirs, injected clock; NO fs mocks per principles.md:44).

---

### src/orchestrator/pipeline.ts (modify — PROTECTED, additive only)

**THE insertion site — Sprint 4's guidance block, CURRENT lines 290-298 inside `runSprintCycle`:**
```typescript
290    // ── Phase 2 guidance injection (additive) ──────────────────────────
291    // Drain any queued free-text guidance for the active run and inject it ...
294    let injectedHandoff = compactedHandoff;
295    if (pipelineRunId) {
296      const guidance = await drainGuidance(projectRoot, pipelineRunId);
297      injectedHandoff = injectGuidanceIntoHandoff(compactedHandoff, guidance);
298    }
299
300    // ── Generate ───────────────────────────────────────────────
```
**ADD the cooperative-pause gate immediately AFTER line 298 (after guidance, before Generate), guarded on `pipelineRunId`:**
```typescript
    // ── Phase 2 cooperative pause gate (additive) ──────────────────────
    // With no runId or no paused.json marker, this is a single existence
    // check (isPaused) then continue — provably additive (sc-5-7).
    if (pipelineRunId) {
      await waitWhilePaused(projectRoot, pipelineRunId);
    }
```
- Import at top (next to the Sprint 4 line `import { drainGuidance } from "../state/guidance.js";` at **pipeline.ts:62**):
  `import { waitWhilePaused } from "../state/pause.js";`
- `runSprintCycle` already receives `pipelineRunId?: string` (signature at **pipeline.ts:157-165**) and `projectRoot` — NO signature change needed. The clock/pollMs are baked into `waitWhilePaused`'s defaults; tests exercise `waitWhilePaused` directly (do NOT thread a clock through `runSprintCycle`).

**DO-NOT-TOUCH invariant block (the sprint-fail telemetry + max-iterations, CURRENT lines 562-585):**
```typescript
562    // Sprint 28 — telemetry (only emit retry if there are more iterations)
563    if (iteration < maxIterations) { void emit(...); }
572    if (iteration >= maxIterations) {
573      logger.error(`Sprint ... exceeded max iterations ...`);
576      currentContract = updateContractStatus(currentContract, "needs-rework");
578      return { contract: currentContract, evaluation };
579    }
```
Leave the phase order, the iteration loop, and this block byte-for-byte unchanged. **`runTsPipeline` (pipeline.ts:606) and `runPipeline` (pipeline.ts:1009) are UNTOUCHED** — the gate lives only inside `runSprintCycle`.

**Imported by (importers of pipeline.ts — additive gate must not change exported signatures):**
- `src/index.ts`, `src/cli/commands/run.ts`, `src/mcp/run-manager.ts`, `src/orchestrator/worktree.ts`, `src/graph/preflight-injector.ts` (plus 4 mcp test files). All consume `runPipeline`/`runSprintCycle` signatures — keep them stable.

**Test file:** new `src/orchestrator/pipeline.pause.test.ts` (create — mirror `pipeline.guidance.test.ts`).

---

### src/chat/chat-session.ts (modify)

**Mirror & CONTRAST `handleStop` — CURRENT lines 286-296:**
```typescript
286  private async handleStop(runId: string): Promise<string> {
288    const states = await this.roster.read();
289    const target = states.find((s) => s.runId === runId && s.status === "running");
290    if (!target) return `No such running run: ${runId}`;
292    const result = await this.spawner.stop(runId, "Stopped via chat");   // ← KILLS pid
293    return result.killedPid !== undefined ? `Stopped run ${runId} (killed pid ...).` : ...;
295  }
```
**ADD `handlePause` / `handleResume` (NO spawner.stop, NO kill — that is the entire point):**
```typescript
  private async handlePause(runId: string): Promise<string> {
    const states = await this.roster.read();
    const target = states.find((s) => s.runId === runId && s.status === "running");
    if (!target) return `No such running run: ${runId}`;       // unknown/non-running → write nothing
    await setPaused(this.projectRoot, runId);                  // marker (NO process.kill)
    await writeRunState(this.projectRoot, {                    // chat-owned RunState flip
      ...target, status: "paused", pausedAt: new Date().toISOString(),
    });
    return `Paused run ${runId} at the next boundary — the process stays alive (use /resume ${runId} to continue). This is NOT /stop.`;
  }
  private async handleResume(runId: string): Promise<string> {
    await clearPaused(this.projectRoot, runId);               // remove marker (best-effort)
    const states = await this.roster.read();
    const target = states.find((s) => s.runId === runId && s.status === "paused");
    if (target) {
      const { pausedAt, ...rest } = target; void pausedAt;    // drop pausedAt — see clearPending:392
      await writeRunState(this.projectRoot, { ...rest, status: "running" });
    }
    return `Resumed run ${runId}.`;
  }
```
- Add import near line 27: `import { setPaused, clearPaused } from "../state/pause.js";`
- **Thread the new handlers into `dispatch`** at the call site (CURRENT lines 187-195). Append two callbacks after the `tell` handler:
```typescript
    const slashResult = await dispatch(
      input, this.roster,
      (runId) => this.handleStop(runId),
      (arg) => this.handleCareful(arg),
      (id) => this.handleApprove(id),
      (id, fb) => this.handleReject(id, fb),
      (runId, text) => this.handleTell(runId, text),
      (runId) => this.handlePause(runId),     // NEW
      (runId) => this.handleResume(runId),    // NEW
    );
```
- **Add classify-path routing** in `handleTurn` (the action `else if` chain, CURRENT lines 238-258). Add a branch (e.g. after the `tell` branch at line 254):
```typescript
    } else if (action.action === "pause") {
      reply = await this.handlePause(action.runId);
    } else if (action.action === "resume") {
      reply = await this.handleResume(action.runId);
```

**Test file:** `src/chat/chat-session-steer.test.ts` (exists — extend it; it already has the kill-capturing spawner + RunState fixtures).

---

### src/chat/slash-commands.ts (modify)

**Add two optional handler params after `tellHandler` (CURRENT signature lines 51-59):**
```typescript
  tellHandler?: (runId: string, text: string) => Promise<string>,
  pauseHandler?: (runId: string) => Promise<string>,     // NEW — last-but-one
  resumeHandler?: (runId: string) => Promise<string>,    // NEW — last (back-compat)
```
**Add cases (mirror the `/stop` case at lines 78-85 — single-arg shape):**
```typescript
    case "/pause": {
      const arg = trimmed.split(/\s+/)[1];
      if (!arg) return { handled: true, output: "Usage: /pause <runId>" };
      const output = pauseHandler ? await pauseHandler(arg) : "Pause is unavailable.";
      return { handled: true, output };
    }
    case "/resume": {
      const arg = trimmed.split(/\s+/)[1];
      if (!arg) return { handled: true, output: "Usage: /resume <runId>" };
      const output = resumeHandler ? await resumeHandler(arg) : "Resume is unavailable.";
      return { handled: true, output };
    }
```
**Update `HELP_TEXT` (CURRENT lines 17-29) — make /pause CLEARLY DISTINCT from /stop:**
```typescript
  "  /stop <runId>      — Stop a run by killing its process (hard stop)",
  "  /pause <runId>     — Soft-pause a run at the next boundary (process stays alive)",
  "  /resume <runId>    — Resume a soft-paused run",
```
(Keep the existing `/stop` line wording change minimal — just clarify it is the hard kill so `/pause` reads as the soft alternative. sc-5-6 asserts HELP_TEXT lists both /pause and /resume.)

**Test file:** `src/chat/slash-commands.test.ts` (exists — add /pause + /resume cases).

---

### src/chat/turn-classifier.ts (modify)

**Add to the `ClassifierAction` union (CURRENT lines 11-18):**
```typescript
  | { action: "tell"; runId: string; text: string }
  | { action: "pause"; runId: string }      // NEW
  | { action: "resume"; runId: string };    // NEW
```
**Add to the Zod `discriminatedUnion` (CURRENT lines 22-40):**
```typescript
  z.object({ action: z.literal("tell"), runId: z.string(), text: z.string() }),
  z.object({ action: z.literal("pause"), runId: z.string() }),      // NEW
  z.object({ action: z.literal("resume"), runId: z.string() }),     // NEW
```
**Add reconstruction branches in `parseClassifierAction` (after the `tell` branch, CURRENT lines 104-106):**
```typescript
      if (data.action === "pause")  return { action: "pause",  runId: data.runId };
      if (data.action === "resume") return { action: "resume", runId: data.runId };
```
**Add to the system-prompt options list (CURRENT lines 135-143):**
```typescript
      '  {"action":"pause","runId":"<id>"}  — soft-pause a run (process stays alive)',
      '  {"action":"resume","runId":"<id>"}  — resume a soft-paused run',
```

**Test file:** `src/chat/turn-classifier.test.ts` (exists — add pause/resume parse cases).

---

## 2. Patterns to Follow

### Path-traversal guard — REUSE, do not redefine
**Source:** `src/state/guidance.ts`, lines 48-57 (exported `safeSegment`)
```typescript
export function safeSegment(runId: string): boolean {
  if (!runId) return false;
  if (runId.includes("/")) return false;
  if (runId.includes("\\")) return false;
  if (runId.includes("..")) return false;
  if (runId.startsWith(".")) return false;
  if (runId.startsWith("/") || /^[A-Za-z]:[/\\]/.test(runId)) return false;
  return true;
}
```
**Rule:** Import `safeSegment` from `../state/guidance.js` in `pause.ts` and call it BEFORE building any path. Do NOT copy-paste a second definition.

### Never-throw existence read
**Source:** `src/state/guidance.ts`, lines 66-73 (`hasRunDir`)
```typescript
export async function hasRunDir(projectRoot: string, runId: string): Promise<boolean> {
  try { await access(runDir(projectRoot, runId), constants.R_OK); return true; }
  catch { return false; }
}
```
**Rule:** `isPaused` follows this exact try/access/catch→false shape on `paused.json`.

### Best-effort unlink (clearPaused model)
**Source:** `src/state/approval-state.ts`, lines 137-139 (`deletePending`)
```typescript
export async function deletePending(projectRoot: string, id: string): Promise<void> {
  await unlink(pendingPath(projectRoot, id)).catch(() => {});
}
```
**Rule:** `clearPaused` unlinks with `.catch(() => {})` — never throws, idempotent (no-op if already gone).

### Atomic write (setPaused model)
**Source:** `src/state/run-state.ts`, lines 41-52 (`writeRunState`)
```typescript
const rnd = randomBytes(4).toString("hex");
const tmp = `${filePath}.${process.pid}.${Date.now()}.${rnd}.tmp`;
await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
await rename(tmp, filePath);
```
**Rule:** `setPaused` writes `{ pausedAt }` via temp-file+rename, mode 0o600.

### Injected-clock bounded poll loop — THE waitWhilePaused model
**Source:** `src/orchestrator/checkpoints/mechanisms/disk.ts`, lines 23-25 (constants), 53-61 (clock injection), 104-176 (loop)
```typescript
const DEFAULT_POLL_MS = 2000;                       // disk.ts:23
const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000;     // disk.ts:24
const MAX_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;     // disk.ts:25  (cap — prevents unbounded hang)
// clock injection (disk.ts:56-61):
constructor(..., private readonly now: () => number = () => Date.now()) {}
// loop (disk.ts:104-169) — the structure to mirror:
const startedAt = this.now();
let pollHandle: ReturnType<typeof setTimeout> | undefined;
return await new Promise((resolve, reject) => {
  const tick = async () => {
    try {
      if (/* resolution condition */) { resolve(...); return; }
      if (this.now() - startedAt >= timeoutMs) { resolve(...); return; }  // disk.ts:142 timeout
      pollHandle = setTimeout(() => { tick().catch(reject); }, pollMs);   // disk.ts:157
    } catch (err) { reject(err); }
  };
  pollHandle = setTimeout(() => { tick().catch(reject); }, pollMs);       // disk.ts:166
});
// finally { if (pollHandle !== undefined) clearTimeout(pollHandle); }    // disk.ts:170-175
```
**Rule:** `waitWhilePaused` adapts this loop. Resolution condition = `!(await isPaused(...))`. The FIRST check must be inline BEFORE scheduling any setTimeout so the no-marker path resolves immediately with zero ticks (sc-5-7). Accept `{ pollMs, timeoutMs, now }`; default `now = () => Date.now()`, default `pollMs = 2000`, default `timeoutMs` capped (reuse the 24h/7d caps or a smaller dedicated cap). The injected `now` + a fake `setTimeout`-free design lets tests advance the clock without real sleeps.

> **Determinism tip:** because `setTimeout` itself sleeps in real time, the cleanest testable shape is to check `isPaused` first (immediate resolve when no marker), and for the polling test inject a `now()` whose elapsed delta crosses `timeoutMs` to force resolution, OR structure the loop so the test stubs the marker removal between awaited `isPaused` calls. Mirror disk.ts's `this.now()` timeout arithmetic so the timeout branch is clock-driven, not wall-clock-driven.

### Additive no-op guard (the sc-5-7 reference)
**Source:** `src/orchestrator/pipeline.ts`, lines 294-298 (Sprint 4 guidance — same `if (pipelineRunId)` shape)
**Rule:** Your gate copies this guard exactly. No runId → block skipped entirely. runId present, no marker → one `isPaused` call returns false → continue. Provably additive.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `safeSegment` | `src/state/guidance.ts:48` | `(runId: string): boolean` | Path-traversal guard — import & reuse in pause.ts |
| `hasRunDir` | `src/state/guidance.ts:66` | `(projectRoot, runId): Promise<boolean>` | Run-dir existence check (model for `isPaused`) |
| `ensureDir` | `src/state/helpers.ts:6` | `(dirPath: string): Promise<void>` | mkdir recursive — call before writing the marker |
| `writeRunState` | `src/state/run-state.ts:41` | `(projectRoot, state: RunState): Promise<void>` | Atomic RunState write — used for the paused/running flip |
| `readRunState` | `src/state/run-state.ts:61` | `(projectRoot, runId): Promise<RunState\|null>` | Never-throw RunState read |
| `readRunStatesFromDisk` | `src/state/run-state.ts:110` | `(projectRoot): Promise<RunState[]>` | Read-only roster source (behind RosterReader) |
| `deletePending` | `src/state/approval-state.ts:138` | `(projectRoot, id): Promise<void>` | Best-effort unlink (model for `clearPaused`) |
| `RosterReader.read` | `src/chat/roster-reader.ts:22` | `(): Promise<RunState[]>` | Disk roster for the run-exists/running guard |
| `DiskCheckpointMechanism.request` | `src/orchestrator/checkpoints/mechanisms/disk.ts:63` | injected-clock poll loop | THE poll-loop model for `waitWhilePaused` |
| `injectGuidanceIntoHandoff` | `src/orchestrator/pipeline.ts:141` | `(handoff, texts[]): ContextHandoff` | Sprint 4 additive helper — the no-op pattern to imitate |
| `drainGuidance` | `src/state/guidance.ts:120` | `(projectRoot, runId): Promise<string[]>` | Sibling marker reader (peer of `isPaused`) |
| `RunSpawner.stop` | `src/chat/run-spawner.ts:148` | `(runId, reason): Promise<StopResult>` | The HARD kill — do NOT call it from pause; study only to contrast |

> `RunState` interface (incl. `status` union with `"paused"` and `pausedAt?`): `src/mcp/run-manager.ts:35-64`. Both already exist (Sprint 1) — Sprint 5 only SETS them.

---

## 4. Prior Sprint Output

### Sprint 1: RunState grammar (14c2be6)
**Created/extended:** `src/mcp/run-manager.ts:38` (`status: ... | "paused"`) and `:63` (`pausedAt?: string`).
**Connection:** Sprint 5 is the first code that WRITES `status: "paused"` + `pausedAt`. No type changes needed.

### Sprint 4: guidance channel + additive pipeline read (b74dfcb)
**Created:** `src/state/guidance.ts` — exports `safeSegment` (48), `hasRunDir` (66), `appendGuidance` (87), `drainGuidance` (120).
**Created:** `src/orchestrator/pipeline.ts:141` `injectGuidanceIntoHandoff`; the additive read point at `pipeline.ts:290-298` inside `runSprintCycle`, guarded on `pipelineRunId`.
**Connection:** `pause.ts` is a structural CLONE of `guidance.ts` (same path helpers, reuses `safeSegment`). The cooperative-pause gate is added DIRECTLY after the guidance block (after line 298). `pipeline.guidance.test.ts` is the template for `pipeline.pause.test.ts`.

### Phase 1 (#44): hard /stop + DiskCheckpointMechanism
**`handleStop`** (`chat-session.ts:286`) and **`RunSpawner.stop`** (`run-spawner.ts:148`) are the KILL path — Sprint 5 must be visibly distinct (no kill).
**`DiskCheckpointMechanism.request`** (`disk.ts:63-176`) is the injected-clock poll-loop model.
**`RosterReader`** (`roster-reader.ts`) provides the run-exists/running guard.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM, `.js` import extensions** (line 27) — every import in pause.ts ends in `.js`.
- **No synchronous fs** (line 42) — use `node:fs/promises` only.
- **No test mocks for filesystem** (line 44) — tests use `mkdtemp` temp dirs + cleanup (see guidance/steer tests).
- **`import type`** for types (line 35) — `import type { RunState } from "../mcp/run-manager.js";`.
- **Prefix unused with `_`** (line 36) / `void x` already used in chat-session (clearPending:392-396) — reuse for dropped `pausedAt`.
- **Box-drawing section headers** (line 32) — `// ── Section ──`.
- Type safety + zero lint/build errors are HARD gates (lines 18-21) → sc-5-1/sc-5-2.

### Architecture Decisions
No ADR specific to soft pause. The contract `assumptions` (lines 70-72) are authoritative: reuse the disk-poll pattern with injected clock; place the gate at the same boundaries as guidance/approvals; RunState `paused` is chat-owned, pipeline only READS `paused.json`.

### Other Docs
No CLAUDE.md/CONTRIBUTING.md coding guide beyond principles.md.

---

## 6. Testing Patterns

### Unit Test Pattern (state-module — for pause.test.ts)
**Source:** `src/orchestrator/pipeline.guidance.test.ts:11-30` (temp-dir harness)
```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-pause-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });
```
**Runner:** vitest · **Assertion:** `expect(...)` · **Mocks:** none (temp dirs) · **File naming:** `pause.test.ts` collocated.

### Injected-clock poll test (sc-5-5 / sc-5-7) — NO real sleeps
Drive `waitWhilePaused` directly (like guidance.test.ts drives `drainGuidance`), with a fake clock:
```typescript
it("sc-5-7: no marker → resolves immediately with no extra ticks", async () => {
  let ticks = 0;
  const now = () => { ticks++; return 0; };
  await waitWhilePaused(tmpDir, "run-x", { now, pollMs: 1, timeoutMs: 1000 });
  // No paused.json → single isPaused() check → resolved; assert it returned (no hang)
});

it("sc-5-5: blocks while paused.json exists, advances after it is cleared", async () => {
  const runId = "run-paused";
  await mkdir(join(tmpDir, ".bober", "runs", runId), { recursive: true });
  await setPaused(tmpDir, runId);
  // Inject a clock that crosses timeoutMs so the loop terminates deterministically
  // (asserts the loop DID poll — did not resolve on the first immediate check),
  // OR clear the marker between awaited checks and assert resolution.
  let calls = 0;
  const now = () => (calls++ < 2 ? 0 : 10_000);   // 3rd read crosses a 5000ms cap
  const start = Date.now();
  await waitWhilePaused(tmpDir, runId, { now, pollMs: 1, timeoutMs: 5000 });
  expect(Date.now() - start).toBeLessThan(2000);  // proves no real-time sleep
});
```
**Rule:** Set `pollMs` to 1 (or 0) AND inject `now` so the timeout branch fires immediately in fake time — the test must never wait a real 2000ms tick. Prefer asserting on clock-call counts / immediate return over wall-clock timing.

### Chat handler test (sc-5-4 / sc-5-6) — assert NO kill
**Source:** `src/chat/chat-session-steer.test.ts:64-104` (kill-capturing spawner + ThrowingClient + RunState fixture)
```typescript
function makeStopCapturingSpawner(projectRoot, sessionId, killCalls) {
  return new RunSpawner({ projectRoot, sessionId,
    spawn: () => ({ pid: 4242, unref: () => {} }),
    kill: (pid, signal) => { killCalls.push({ pid, signal }); },   // ← capture kills
    cliEntry: "/fake/cli/index.js", nodeBin: "/fake/node",
    now: () => "2026-06-14T00:00:00.000Z" });
}
// sc-5-4 test body:
const killCalls = [];
const spawner = makeStopCapturingSpawner(tmpDir, "sess-pause", killCalls);
await spawner.spawn("task", "run-x");   // seeds running state + sidecar pid
const session = new ChatSession({ llm: new ThrowingClient(), projectRoot: tmpDir,
  sessionId: "sess-pause", spawner });
const reply = await session.handleTurn("/pause run-x");
expect(reply).toContain("run-x");
expect(killCalls).toHaveLength(0);      // ← THE no-kill assertion (contrast /stop)
// then read .bober/runs/run-x/paused.json exists + state.json status==='paused' with pausedAt
```
**Rule:** sc-5-4 MUST assert `killCalls.length === 0` (vs the /stop test at steer.test.ts:102-103 which asserts a kill). Read the marker file + `readRunState` to assert the transition. NL routing (sc-5-7): stub the LLM to return `{action:"pause",runId}` (mirror `makeSteerStopLLM` at steer.test.ts:33-38) and assert it routes to `handlePause`.

### Pipeline additive test (sc-5-7) — suite stays green
**Source:** `pipeline.guidance.test.ts` — test the EXPORTED helper (`waitWhilePaused`) directly; do NOT drive full `runSprintCycle` (it calls real LLMs). The pipeline change is one guarded await; its behavior is fully covered by `waitWhilePaused` tests + a deep-equal/no-extra-tick no-marker assertion.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/index.ts`, `src/cli/commands/run.ts`, `src/mcp/run-manager.ts`, `src/orchestrator/worktree.ts`, `src/graph/preflight-injector.ts` | `pipeline.ts` (`runPipeline`/`runSprintCycle`) | low | Gate is additive inside `runSprintCycle`; no exported signature changes → these are unaffected |
| `src/chat/chat-session.ts` | `slash-commands.ts dispatch` | medium | New params are OPTIONAL & appended last → existing 7-arg call still type-checks; update the call to pass the 2 new callbacks |
| any `dispatch(...)` caller | `slash-commands.ts` | low | Optional trailing params preserve back-compat (same convention as Sprints 3-4) |
| `turn-classifier.ts` consumers (chat-session action switch) | `ClassifierAction` union | medium | Adding union members is non-breaking; the chat-session `else` fallback (line 256-258) already handles unknown actions — but ADD explicit pause/resume branches |

### Existing Tests That Must Still Pass
- `src/orchestrator/pipeline.guidance.test.ts` — Sprint 4 additive guidance; verify the new gate after line 298 does not disturb it.
- `src/orchestrator/pipeline-run-id.test.ts` — runId threading; unaffected (no signature change).
- `src/chat/chat-session-steer.test.ts` — /stop kill path; CONFIRM /stop still kills and is distinct (your changes must not alter `handleStop`).
- `src/chat/slash-commands.test.ts` — existing /stop /careful /approve /reject /tell cases must stay green after adding the 2 new optional params.
- `src/chat/turn-classifier.test.ts` — existing action parses must stay green after the union grows.
- `src/chat/chat-session-approval.test.ts`, `chat-session-spawn.test.ts`, `chat-session-completion.test.ts` — exercise `handleTurn`; verify the new dispatch args + action branches don't regress.

### Features That Could Be Affected
- **Sprint 4 /tell guidance** — shares `pipeline.ts:290-298` boundary and the `guidance.ts` module. Verify `drainGuidance` still runs and `injectGuidanceIntoHandoff` is unchanged; pause gate sits AFTER guidance, not inside it.
- **Phase 1 hard /stop** — shares `chat-session.ts` + `RunSpawner`. Verify `handleStop`/`spawner.stop` are byte-for-byte unchanged.

### Recommended Regression Checks
1. `npm run build` — zero TS errors (sc-5-1).
2. `npm run typecheck` — zero strict errors (sc-5-2).
3. `npm run test` — full suite green incl. new pause tests (sc-5-3); specifically `pipeline.guidance.test.ts`, `chat-session-steer.test.ts`, `slash-commands.test.ts`, `turn-classifier.test.ts`.
4. `git diff src/orchestrator/pipeline.ts` — confirm ONLY the import line (≈:62) + one guarded `await waitWhilePaused` block (after :298) changed; phase order, the :562-585 invariant block, `runTsPipeline`, `runPipeline` untouched.
5. `git diff src/chat/chat-session.ts` — confirm `handleStop` (286-296) is unchanged.

---

## 8. Implementation Sequence

1. **src/state/pause.ts** — `setPaused` / `clearPaused` / `isPaused` (import `safeSegment` from guidance.js; reuse runDir/ensureDir; atomic write; best-effort unlink; never-throw access).
   - Verify: marker JSON shape `{ pausedAt }`; `isPaused` false on missing/unsafe runId.
2. **src/state/pause.ts** — `waitWhilePaused(projectRoot, runId, { pollMs, timeoutMs, now })` modeling disk.ts:104-176. FIRST `isPaused` check inline (immediate resolve when false); bounded by `timeoutMs` (cap so a paused run can't hang forever); `now` defaults to `() => Date.now()`.
   - Verify: no-marker → resolves with zero scheduled ticks; injected-clock timeout terminates the loop.
3. **src/orchestrator/pipeline.ts** — add `import { waitWhilePaused } from "../state/pause.js";` (≈:62) and the single guarded `await waitWhilePaused(projectRoot, pipelineRunId)` after line 298, inside `if (pipelineRunId)`.
   - Verify: `git diff` shows additive-only; invariant block + runTsPipeline/runPipeline untouched.
4. **src/chat/chat-session.ts** — `handlePause` / `handleResume` (roster running-guard, setPaused/clearPaused, writeRunState flip, NO kill); thread both into `dispatch`; add action-switch branches.
   - Verify: paused.json written, state→paused+pausedAt, no spawner.stop call; resume removes marker + state→running.
5. **src/chat/slash-commands.ts** — add `pauseHandler`/`resumeHandler` optional params + `/pause` `/resume` cases; update HELP_TEXT distinct-from-stop.
   - Verify: /help lists both; missing-arg usage hints; back-compat call shapes still compile.
6. **src/chat/turn-classifier.ts** — add `pause`/`resume` to union, Zod, reconstruction, system prompt.
   - Verify: `{action:"pause",runId}` parses; malformed → FALLBACK answer.
7. **Tests** — `pause.test.ts` (marker CRUD + injected-clock blocks-while-paused / advances-after-clear / no-marker single-check); `pipeline.pause.test.ts` (drive `waitWhilePaused`, sc-5-5/sc-5-7); extend `chat-session-steer.test.ts` (sc-5-4 no-kill assertion + sc-5-6 resume + NL routing); extend `slash-commands.test.ts` + `turn-classifier.test.ts`.
8. **Full verification** — `npm run build` && `npm run typecheck` && `npm run test`.

---

## 9. Pitfalls & Warnings

- **NO KILL.** `handlePause` must NEVER call `spawner.stop` / `process.kill`. sc-5-4 asserts `killCalls.length === 0`. The only side effects are `setPaused` (marker) + `writeRunState` (status flip). Copy `handleStop`'s ROSTER GUARD, not its `spawner.stop` line.
- **Real sleeps will hang/slow tests.** The poll loop MUST be clock-injectable. The first `isPaused` check must be inline (before any `setTimeout`) so sc-5-7 resolves with zero ticks. Set `pollMs` tiny AND inject `now` in tests; never assert against a real 2000ms tick.
- **Bounded timeout cap.** Reuse a cap (disk.ts uses MAX 7d at line 25) so a forgotten `paused.json` can't hang the pipeline forever — resolve (continue) on timeout rather than reject.
- **Additive no-op invariant (sc-5-7).** Wrap the gate in `if (pipelineRunId)` exactly like the guidance block. With no runId or no marker it is a single existence check. Do NOT add the pause check before the guidance block or you change the boundary ordering Sprint 4 established.
- **`safeSegment` is exported — reuse it.** Do not paste a second copy into pause.ts (duplication + drift). `import { safeSegment } from "./guidance.js";`.
- **Drop `pausedAt` on resume.** When flipping back to running, destructure `pausedAt` out (mirror `clearPending` at chat-session.ts:392-397 with `void pausedAt`) so the stale field isn't serialized.
- **Optional params go LAST.** `pauseHandler`/`resumeHandler` are appended after `tellHandler` in `dispatch` so existing callers (and the Sprint 3/4 tests) don't break — this is the established convention (slash-commands.ts:51-58).
- **pipeline.ts is PROTECTED.** Touch only the import line and the one guarded await. Do not refactor, reorder phases, or alter the :562-585 telemetry/max-iterations block, `runTsPipeline`, or `runPipeline`. Confirm with `git diff`.
- **No fs mocks (principles.md:44).** All tests use `mkdtemp` temp dirs (see guidance.test.ts:24-30, steer.test.ts:19-26).
- **`.js` extensions + `import type`.** `import { setPaused } from "../state/pause.js";` and `import type { RunState } from "../mcp/run-manager.js";` — strict/NodeNext + lint will fail otherwise.
