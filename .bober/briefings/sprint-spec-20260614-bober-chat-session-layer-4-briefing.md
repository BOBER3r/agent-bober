# Sprint Briefing: Steer — inspect + kill-by-PID stop with /stop command

**Contract:** sprint-spec-20260614-bober-chat-session-layer-4
**Generated:** 2026-06-14T00:00:00Z

---

## 1. Target Files

### src/chat/run-spawner.ts (modify)

Add a `stop(runId, reason)` method + `StopResult` type to the existing `RunSpawner` class. The class already holds `this.projectRoot` and `this.sidecar` (a `PidSidecar`), and already imports `writeRunState` and `RunState`. You only need to add `readRunState` to the import and an injectable kill fn.

**Existing constructor wiring you reuse (lines 47-70):**
```ts
import { writeRunState } from "../state/run-state.js";        // line 9
import type { RunState } from "../mcp/run-manager.js";        // line 10
import { PidSidecar } from "./pid-sidecar.js";                // line 12

export class RunSpawner {
  private readonly projectRoot: string;        // line 50
  private readonly sidecar: PidSidecar;        // line 56
  private readonly now: () => string;          // line 55
  // constructor sets: this.sidecar = new PidSidecar(this.projectRoot, this.sessionId);  // line 69
}
```

**Pattern for an injected dependency (mirror `spawn?: SpawnFn` at line 36 / 61-65):**
```ts
// RunSpawnerOptions — add a `kill?` field alongside spawn?/now?
/** Injected kill function. Defaults to process.kill. Tests pass a fake. */
kill?: (pid: number, signal?: string | number) => void;

// constructor — add:
this.killFn = opts.kill ?? ((pid, signal) => { process.kill(pid, signal); });
```

**What `stop` must do (from generatorNotes):**
1. `const all = await this.sidecar.readAll(); const entry = all[runId];`
2. If `entry?.pid` present: call `this.killFn(entry.pid, "SIGTERM")`, then read current state via `readRunState(this.projectRoot, runId)`, flip `status:"aborted"` (+ `abortedAt`, `abortReason`) and `writeRunState`. Return `{ stopped:true, runId, killedPid: entry.pid }`.
3. If NO sidecar entry: DO NOT call kill. Read state via `readRunState`; if it exists, flip to `aborted` and write, return `{ stopped:true, runId, fallbackFlagOnly:true }`. If the run is not on disk at all, return `{ stopped:false, runId }`.
4. Wrap the `killFn` call in try/catch to tolerate ESRCH (already-dead pid) — see Pattern 2.

**Imports this file uses:** `execa`, `writeRunState` (`../state/run-state.js`), `RunState` (`../mcp/run-manager.js`), `resolveCliEntry` (`../fleet/runner.js`), `PidSidecar` (`./pid-sidecar.js`). **Add:** `readRunState` from `../state/run-state.js`.

**Imported by:** `src/chat/chat-session.ts:15`, `src/chat/chat-session-spawn.test.ts:7`.

**Test file:** `src/chat/run-spawner.test.ts` (exists — extend it).

---

### src/chat/chat-session.ts (modify)

The steer branch is currently a stub at lines 154-159. Replace it. Also add `/stop` routing through a shared internal handler.

**Current steer stub (lines 154-159):**
```ts
} else {
  // steer (inspect/stop) arrives in Sprint 3/4
  reply =
    `The "${action.action}" action is not yet available in this version of bober chat ` +
    ...
}
```

**Replace with** (action is `ClassifierAction`, narrowed to `action.action === "steer"`):
```ts
} else if (action.action === "steer") {
  if (action.op === "inspect") {
    reply = this.roster.summarize(states); // `states` already read at line 134-138
  } else { // op === "stop", action.runId: string
    reply = await this.handleStop(action.runId);
  }
}
```

**Add a private `handleStop(runId)` shared by `/stop` and classifier steer:stop:**
```ts
private async handleStop(runId: string): Promise<string> {
  const states = await this.roster.read();                 // resolve against disk roster at stop-time
  const target = states.find((s) => s.runId === runId && s.status === "running");
  if (!target) return `No such running run: ${runId}`;     // sc-4-7 / sc-4-9 — never kill
  const result = await this.spawner.stop(runId, "Stopped via chat");
  return result.killedPid !== undefined
    ? `Stopped run ${runId} (killed pid ${result.killedPid}).`
    : `Stopped run ${runId} (no live process found; marked aborted).`;
}
```
Wire `/stop` by giving `dispatch` a way to invoke this — see Pattern 3 (pass a `stopHandler` callback into `dispatch`).

**Slash dispatch call site (line 116):** `const slashResult = await dispatch(input, this.roster);` — extend signature to also pass the stop handler.

**Test file:** no `chat-session.test.ts`; tests are split by concern: `chat-session-spawn.test.ts`, `chat-session-completion.test.ts`. Create `src/chat/chat-session-steer.test.ts`.

---

### src/chat/slash-commands.ts (modify)

Add a `/stop <runId>` case to the `switch` (lines 44-63) and the `/stop` line to `HELP_TEXT` (lines 17-24). The dispatcher currently takes `(input, roster)`. Add a third param for the stop handler so `/stop` stays deterministic (no LLM).

**Current signature (line 33-36):**
```ts
export async function dispatch(input: string, roster: RosterReader): Promise<SlashResult>
```

**Extend to:**
```ts
export async function dispatch(
  input: string,
  roster: RosterReader,
  stopHandler?: (runId: string) => Promise<string>,
): Promise<SlashResult>
```

**New case (parse the arg from the already-trimmed input):**
```ts
case "/stop": {
  const arg = trimmed.split(/\s+/)[1];
  if (!arg) return { handled: true, output: "Usage: /stop <runId>" };
  const output = stopHandler ? await stopHandler(arg) : "Stop is unavailable.";
  return { handled: true, output };
}
```
`stopHandler` is `ChatSession.handleStop` bound in chat-session.ts. This keeps `/stop` on the deterministic path (sc-4-6) — the existing `command` var (line 42) already lowercases the command token.

**Test file:** `src/chat/slash-commands.test.ts` (exists — extend; note existing tests call `dispatch(x, roster)` with 2 args, so the 3rd param MUST stay optional to avoid breaking them).

---

### src/chat/pid-sidecar.ts (read-only reuse — likely NO change)

`stop` reads via the existing `readAll()`. No new method needed. See Section 3.

---

## 2. Patterns to Follow

### Pattern 1 — Injected dependency for testability (kill fn)
**Source:** `src/chat/run-spawner.ts`, lines 36-45 + 61-68
```ts
/** Injected spawn function. Defaults to a thin execa wrapper. */
spawn?: SpawnFn;
now?: () => string;
// ...
this.spawnFn = opts.spawn ?? (/* default */);
this.now = opts.now ?? (() => new Date().toISOString());
```
**Rule:** Every side-effecting primitive (spawn, clock, AND your new kill) is constructor-injected with a real default; tests pass a fake. Add `kill?` the same way — tests never call real `process.kill`.

### Pattern 2 — process.kill with already-dead (ESRCH) tolerance
**Source:** `src/graph/pipeline-lifecycle.ts`, lines 310-326
```ts
try {
  process.kill(orphanPid, 0);              // probe: throws ESRCH if dead
  try { process.kill(orphanPid, "SIGTERM"); } catch { /* Already gone */ }
  await delay(500);
  try { process.kill(orphanPid, "SIGKILL"); } catch { /* Already gone */ }
} catch { /* not running */ }
```
**Rule:** Wrap each kill in try/catch and swallow the error — an already-dead pid (ESRCH) is not a failure. For Phase 1 a single `SIGTERM` is sufficient (contract: "real hard-stop"); use the same swallow-on-throw shape. Do NOT escalate to SIGKILL unless you choose to mirror the 500ms pattern.

### Pattern 3 — Aborted-status flip via read → mutate → writeRunState
**Source:** `src/mcp/run-manager.ts`, lines 123-134
```ts
abortRun(runId: string, reason: string): void {
  const state = this.runs.get(runId);
  if (!state) return;
  state.status = "aborted";
  state.abortedAt = new Date().toISOString();
  state.abortReason = reason;
  writeRunState(state.projectRoot, state).catch(/* log */);
}
```
**Rule:** This is the canonical 'aborted' flip. In `RunSpawner.stop` do the disk-only equivalent: `const s = await readRunState(projectRoot, runId); if (s) { s.status="aborted"; s.abortedAt=this.now(); s.abortReason=reason; await writeRunState(projectRoot, s); }`. Set `status` to the literal `"aborted"` — it is a valid member of the RunState status union (see Section 3).

### Pattern 4 — Deterministic slash switch returning SlashResult
**Source:** `src/chat/slash-commands.ts`, lines 44-63
```ts
switch (command) {
  case "/runs": {
    const states = await roster.read();
    return { handled: true, output: roster.summarize(states) };
  }
  case "/exit": { return { handled: true, exit: true }; }
  default: { return { handled: true, output: `Unknown command...` }; }
}
```
**Rule:** Each case returns a `SlashResult` (`{handled:true, output}` or `{handled:true, exit:true}`). `/stop` follows the same shape. Never reach the LLM.

### Pattern 5 — Steer classifier action shape
**Source:** `src/chat/turn-classifier.ts`, lines 11-15
```ts
export type ClassifierAction =
  | { action: "answer" }
  | { action: "spawn"; task: string }
  | { action: "steer"; op: "inspect" }
  | { action: "steer"; op: "stop"; runId: string };
```
**Rule:** Narrow on `action.action === "steer"` then `action.op`. For `op:"stop"`, `action.runId` is a `string`. The classifier already emits these (no classifier change needed); you only consume them in chat-session.ts.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `PidSidecar.readAll` | `src/chat/pid-sidecar.ts:40` | `(): Promise<Record<string, PidEntry>>` | Read all session runId→{pid,task,spawnedAt}; returns {} if missing, never throws. Use to resolve a runId's pid. |
| `PidEntry` (type) | `src/chat/pid-sidecar.ts:13` | `{ pid?: number; task: string; spawnedAt: string }` | Sidecar entry shape; `pid` is optional — guard before kill. |
| `readRunState` | `src/state/run-state.ts:61` | `(projectRoot, runId): Promise<RunState \| null>` | Read one run's state.json; null if missing/malformed. Read BEFORE the aborted flip. |
| `writeRunState` | `src/state/run-state.ts:41` | `(projectRoot, state): Promise<void>` | Atomic temp+rename write of state.json. Use for the 'aborted' flip. |
| `readRunStatesFromDisk` | `src/state/run-state.ts:110` | `(projectRoot): Promise<RunState[]>` | Disk roster enumeration (wrapped by RosterReader.read). |
| `RosterReader.read` | `src/chat/roster-reader.ts:22` | `(): Promise<RunState[]>` | Read disk roster — use to resolve runId at stop-time (sc-4-7). |
| `RosterReader.summarize` | `src/chat/roster-reader.ts:30` | `(states): string` | Roster summary string — reuse for steer:inspect AND /runs (sc-4-8). |
| `RunState` (type) | `src/mcp/run-manager.ts:35` | interface with `status` union | Run state; `status: "running"\|"completed"\|"failed"\|"aborted"` (line 38), `abortedAt?`, `abortReason?` (lines 41-42). |

**`'aborted'` is a valid terminal status** — `src/mcp/run-manager.ts:38`. Use it; do NOT invent 'stopped'/'cancelled'.

**Do NOT use `RunManager.abortRun`** for cross-process stop — it operates on the in-memory map and no-ops for runs not in `this.runs` (`src/mcp/run-manager.ts:123-125`, and contract nonGoal). Use disk `readRunState`/`writeRunState` directly.

---

## 4. Prior Sprint Output

### Sprint 2: RunSpawner + PidSidecar
**Created:** `src/chat/run-spawner.ts` (exports `RunSpawner`, `SpawnAck`, `SpawnFn`, `RunSpawnerOptions`); `src/chat/pid-sidecar.ts` (exports `PidSidecar`, `PidEntry`).
**Connection:** `stop()` is added to the SAME `RunSpawner` class and resolves PIDs from the SAME sidecar (`this.sidecar.readAll()`). The sidecar at `.bober/chat/<sessionId>.pids.json` is the authoritative source of session-recorded PIDs (contract assumption).

### Sprint 1: chat module + slash dispatcher
**Created:** `src/chat/slash-commands.ts` (`dispatch`), `src/chat/roster-reader.ts` (`RosterReader`), `src/chat/chat-session.ts` (`ChatSession`).
**Connection:** `/stop` is added to the same `dispatch` switch; steer routing replaces the stub in `ChatSession.handleTurn` (chat-session.ts:154-159).

### Sprint 3: CompletionTailer
**Connection:** `handleTurn` weaves completion notices around BOTH slash output (lines 121-126) and LLM-path reply (lines 162-167). Your steer reply flows through the LLM-path weaving automatically; your `/stop` output flows through the slash weaving — no extra work, just don't break it.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM everywhere** — all imports use `.js` extensions (NodeNext). Already followed in this module.
- **`import type` for types** — ESLint `consistent-type-imports` enforced. Import `RunState`, `PidEntry`, `ClassifierAction` with `import type`.
- **No synchronous fs** — use `node:fs/promises` only. `readRunState`/`writeRunState` already async.
- **Collocated Vitest tests** — `*.test.ts` next to source; tests create temp dirs and clean up (no fs mocks).
- **Section comments** — use `// ── Section ──────` unicode box headers (see run-spawner.ts:14, 47).
- **Prefix unused params with `_`** — only escape hatch for unused vars.

### Architecture Decisions
No ADRs found relevant to chat steer. The `.bober/architecture/` dir exists but contains spec-scoped docs, not chat steering ADRs.

---

## 6. Testing Patterns

### Unit Test Pattern — injected fake spawn (mirror for fake kill)
**Source:** `src/chat/run-spawner.test.ts`, lines 20-67
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunSpawner } from "./run-spawner.js";
import { readRunState } from "../state/run-state.js";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-spawner-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

it("captures the kill pid and flips state to aborted (sc-4-4)", async () => {
  const killCalls: Array<{ pid: number; signal?: string | number }> = [];
  const spawner = new RunSpawner({
    projectRoot: tmpDir, sessionId: "s1",
    spawn: (_f, _a, _o) => ({ pid: 4242, unref: () => {} }),
    kill: (pid, signal) => { killCalls.push({ pid, signal }); },  // FAKE — never real
    cliEntry: "/fake/cli/index.js", nodeBin: "/fake/node",
    now: () => "2026-06-14T00:00:00.000Z",
  });
  await spawner.spawn("build X", "run-x");          // seeds sidecar pid 4242 + running state
  const result = await spawner.stop("run-x", "test");
  expect(killCalls).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
  expect((await readRunState(tmpDir, "run-x"))?.status).toBe("aborted");
  expect(result.killedPid).toBe(4242);
});
```
**Runner:** vitest. **Assertion:** `expect`. **Mock approach:** constructor dependency injection (NO `vi.mock`). **File naming:** `*.test.ts` collocated. **Location:** co-located in `src/chat/`.

### Key test scenarios to cover (from successCriteria)
- **sc-4-4:** seed sidecar+running state via `spawn`, then `stop` → assert injected kill got recorded pid AND disk status `aborted`.
- **sc-4-5:** write a running `state.json` (via `writeRunState`) but NO sidecar entry → `stop` → assert kill NOT called, status `aborted`, `result.fallbackFlagOnly === true`.
- **sc-4-9:** unknown/stale runId (no sidecar entry, no disk state) → assert injected kill array is empty (`stopped:false`).
- **sc-4-6:** feed `'/stop run-x'` to a `ChatSession` whose LLMClient throws on `chat` → assert the stop handler ran (no LLM call). Use the `ThrowingClient` pattern from `slash-commands.test.ts:13-17`.
- **sc-4-7:** classifier returns `{action:"steer",op:"stop",runId}` for a runId absent from roster → assert reply contains "No such running run" and kill array empty.
- **sc-4-8:** classifier `steer:inspect` reply equals `RosterReader.summarize(states)` for the same states.

### ChatSession injection pattern for steer/stop tests
**Source:** `src/chat/chat-session-spawn.test.ts`, lines 22-55
```ts
function makeStopClassifierLLM(runId: string): LLMClient {
  return { chat: async () => ({
    text: JSON.stringify({ action: "steer", op: "stop", runId }),
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  }) } as unknown as LLMClient;
}
const session = new ChatSession({ llm, projectRoot: tmpDir, sessionId: "s", spawner: fakeSpawner });
const reply = await session.handleTurn("stop run-x");
```
Inject a `RunSpawner` whose `kill` fake records calls, OR stub `spawner.stop` directly (see spawn.test.ts:113-120 for the `as unknown as RunSpawner` stub style).

### ThrowingClient (proves no LLM call on /stop — sc-4-6)
**Source:** `src/chat/slash-commands.test.ts`, lines 13-17
```ts
class ThrowingClient implements LLMClient {
  async chat(_params: ChatParams): Promise<ChatResponse> {
    throw new Error("LLMClient must NOT be called for slash commands");
  }
}
```

E2E: not applicable (no Playwright for the chat layer).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/chat/chat-session.ts` | `RunSpawner`, `dispatch` | high | New `stop` method + steer routing + extended `dispatch` signature; the `else` steer stub (154-159) is replaced. |
| `src/chat/chat-session-spawn.test.ts` | `RunSpawner`, `dispatch` (indirect) | medium | Constructs `RunSpawner` without `kill` — default must keep working; spawn flow unchanged. |
| `src/chat/slash-commands.test.ts` | `dispatch` | medium | Existing tests call `dispatch(x, roster)` with 2 args — new 3rd param MUST be optional. |
| `src/chat/run-spawner.test.ts` | `RunSpawner` | medium | Existing spawn tests must still pass; only additive `stop` + `kill?` option. |
| `src/chat/turn-classifier.ts` | (consumed by) | low | No change; you only consume `ClassifierAction`. Don't touch the union. |

### Existing Tests That Must Still Pass
- `src/chat/run-spawner.test.ts` — spawn writes state.json, args, sidecar persistence, spawnError. Adding `stop`/`kill?` must not alter these.
- `src/chat/slash-commands.test.ts` — `/runs`, `/help`, `/exit`, non-slash, no-LLM. Optional 3rd `dispatch` param keeps these green.
- `src/chat/chat-session-spawn.test.ts` — spawn routing; verify the steer branch replacement didn't change the spawn `else if`.
- `src/chat/chat-session-completion.test.ts` — completion weaving around slash AND LLM replies; verify `/stop` and steer replies still get notices woven.

### Features That Could Be Affected
- **/runs (Sprint 1)** — shares `RosterReader.summarize`. steer:inspect must return the SAME summary (sc-4-8) — call the identical method, don't fork formatting.
- **spawn (Sprint 2)** — shares `RunSpawner` + sidecar. `stop` reads the sidecar `spawn` writes; don't change `record`/`readAll`.

### Recommended Regression Checks
1. `npm run build` — zero TS errors (sc-4-1, sc-4-2).
2. `npx vitest run src/chat/` — all chat tests pass (sc-4-3).
3. `npx vitest run src/chat/run-spawner.test.ts src/chat/slash-commands.test.ts src/chat/chat-session-spawn.test.ts` — prior-sprint tests still green.
4. `npm run typecheck` (or `tsc --noEmit`) — zero type errors.

---

## 8. Implementation Sequence

1. **src/chat/run-spawner.ts** — add `StopResult` type (`{ stopped: boolean; runId: string; killedPid?: number; fallbackFlagOnly?: boolean }`), add `kill?` to `RunSpawnerOptions`, store `this.killFn` in constructor (default `process.kill` wrapper), add `import { readRunState }` to the run-state import.
   - Verify: `tsc` compiles; existing run-spawner tests still pass.
2. **src/chat/run-spawner.ts** — implement `async stop(runId, reason)`: `readAll()` → if entry.pid, try/catch kill(pid,"SIGTERM"); read+flip+write state to `aborted`; return result per generatorNotes. Guard kill behind `entry?.pid` (sc-4-9).
   - Verify: write sc-4-4, sc-4-5, sc-4-9 unit tests; assert kill calls + disk status.
3. **src/chat/slash-commands.ts** — add optional `stopHandler` param, `/stop` switch case, `/stop` HELP_TEXT line.
   - Verify: existing slash tests pass (2-arg calls); new `/stop` usage + handler-invocation test.
4. **src/chat/chat-session.ts** — add private `handleStop(runId)`; replace steer stub (154-159) with inspect→summarize / stop→handleStop; pass `(runId) => this.handleStop(runId)` as 3rd arg to `dispatch` at line 116.
   - Verify: sc-4-6 (/stop, ThrowingClient), sc-4-7 (steer:stop absent runId), sc-4-8 (inspect == summarize) tests.
5. **Run full verification** — `npm run build`, `npx vitest run src/chat/`, `npm run typecheck`.

---

## 9. Pitfalls & Warnings

- **`PidEntry.pid` is optional** (`pid-sidecar.ts:13`). Guard `if (entry?.pid !== undefined)` before kill — an entry can exist with no pid (spawn-error path).
- **Do NOT use `RunManager.abortRun`** — it no-ops for runs not in the in-memory map (`run-manager.ts:123-125`); the detached child is a different process. Use disk `readRunState`+`writeRunState` (contract nonGoal at run-manager.ts:123).
- **Status literal is `"aborted"`**, NOT 'stopped'/'cancelled' — only 4 members in the union (`run-manager.ts:38`). A wrong literal fails the type check.
- **`dispatch`'s 3rd param MUST be optional** — `slash-commands.test.ts` and `chat-session.ts` (until you edit it) call it with 2 args. A required param breaks compilation.
- **Resolve runId at stop-time from disk, never spawn-time memory** (sc-4-7) — call `roster.read()` inside `handleStop`, not a cached list. The contract explicitly tests a stale/absent runId yields "no such running run" without killing.
- **Never call real `process.kill` in tests** — always inject the `kill` fake. A real kill could terminate the test runner or an arbitrary pid.
- **ESRCH tolerance** — wrap kill in try/catch and swallow (a dead pid is success, not failure); mirror `pipeline-lifecycle.ts:316-320`.
- **`import type`** for `RunState`, `PidEntry`, `ClassifierAction`, `StopResult` (ESLint `consistent-type-imports` is a hard gate).
- **Keep NL stop and `/stop` on one handler** — both route to `handleStop` so behavior is identical (generatorNotes). Don't duplicate the kill/flip logic.
- **steer:inspect must reuse `RosterReader.summarize`** exactly (sc-4-8) — don't write a parallel formatter.
