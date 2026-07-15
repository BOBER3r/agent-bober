# Sprint Briefing: Non-blocking detached spawn with session-generated runId (--run-id flag)

**Contract:** sprint-spec-20260614-bober-chat-session-layer-2
**Generated:** 2026-06-14T00:00:00Z

---

## 0. Sprint Shape (read first)

Two additive parts plus wiring:

- **(A) `--run-id <id>` flag** on `agent-bober run`, threaded all the way to `pipelineRunId` (`src/orchestrator/pipeline.ts:583`) so the completion marker `.bober/runs/<id>.completed.json` and roster are keyed on the caller-supplied id. Default behavior (`run-${Date.now()}`) is preserved when the flag is absent.
- **(B) `RunSpawner`** (`src/chat/run-spawner.ts`) + `PidSidecar` (`src/chat/pid-sidecar.ts`): write roster `state.json` via `writeRunState` BEFORE launching a DETACHED `agent-bober run <task> --run-id <id>` child, record `runId->{pid,...}` in `.bober/chat/<sessionId>.pids.json`, return a synchronous `SpawnAck`.
- **(Wiring)** `ChatSession.handleTurn` (`src/chat/chat-session.ts:106`) — replace the `action !== 'answer'` placeholder with a `spawn` branch that generates a runId, calls `RunSpawner.spawn`, persists the ack, returns it.

**CRITICAL CONSTRAINT (do not violate):** `runPipeline` (`src/orchestrator/pipeline.ts:969`) and the `PipelineEngine.run` interface (`src/orchestrator/workflow/engine.ts:10-17`) are documented as *frozen signatures*. The additive change is an **optional 4th parameter** threaded through the chain; existing 3-arg callers must keep working unchanged.

---

## 1. Target Files

### src/cli/commands/run.ts (modify)

**RunCommandOptions (lines 13-26)** — add an optional `runId`:
```ts
export interface RunCommandOptions {
  verbose?: boolean;
  provider?: string;
  mode?: "autopilot" | "careful";
  checkpoint?: string;
  checkpointAll?: boolean;
  // ADD:
  /** When set, the pipeline honors this runId instead of self-generating run-<timestamp>. */
  runId?: string;
}
```

**The runPipeline call (line 146)** — thread the id additively:
```ts
const result = await runPipeline(task, projectRoot, config);
// CHANGE TO (additive 4th arg, optional):
const result = await runPipeline(task, projectRoot, config, { runId: options.runId });
```

**Imports this file uses:** `runPipeline` from `../../orchestrator/pipeline.js` (line 7), `loadConfig`/`configExists` from `../../config/loader.js`, `ensureBoberDir` from `../../state/index.js`, `logger` from `../../utils/logger.js`.

**Imported by:** `src/cli/index.ts:20` (`import { runRunCommand } from "./commands/run.js"`).

**Test file:** does NOT exist (`src/cli/commands/run.test.ts` absent). sc-2-4/sc-2-5 may be satisfied by testing the pipeline runId param directly (see §6) rather than the commander handler.

---

### src/cli/index.ts (modify — register the flag)

**The `run` command registration (lines 197-233):** add a `.option("--run-id <id>", ...)`, widen the `cmdOpts` inline type, and pass it into `runRunCommand`.
```ts
.command("run [task]")
.description("Run the full autonomous pipeline (plan + sprint loop)")
.option("--provider <name>", "...")
.option("--mode <mode>", "...")
.option("--checkpoint <mechanism>", "...")
.option("--checkpoint-all", "...")
// ADD:
.option("--run-id <id>", "Use a caller-supplied run identifier instead of self-generating run-<timestamp>.")
.action(async (task?: string, cmdOpts?: {
  provider?: string;
  mode?: "autopilot" | "careful";
  checkpoint?: string;
  checkpointAll?: boolean;
  runId?: string;   // commander camelCases --run-id -> runId
}) => {
  const opts = program.opts<{ verbose?: boolean; config?: string }>();
  const projectRoot = await resolveProjectRoot(opts.config);
  await runRunCommand(task, projectRoot, {
    verbose: opts.verbose,
    provider: cmdOpts?.provider,
    mode: cmdOpts?.mode,
    checkpoint: cmdOpts?.checkpoint,
    checkpointAll: cmdOpts?.checkpointAll,
    runId: cmdOpts?.runId,   // ADD
  });
});
```
**NOTE:** commander maps `--run-id` to the `runId` property automatically (kebab → camelCase). `src/cli/index.ts` is NOT in `estimatedFiles` but MUST be edited or the flag is unreachable from the CLI — the detached child invokes `agent-bober run ... --run-id <id>`, which is parsed here.

---

### src/orchestrator/pipeline.ts (modify — honor injected runId)

**`pipelineRunId` generation (line 583):**
```ts
const pipelineRunId = `run-${Date.now()}`;
```
**Change to honor an injected id (additive opts):**
```ts
const pipelineRunId = opts?.runId ?? `run-${Date.now()}`;
```

**`runTsPipeline` signature (lines 573-577):** add an optional 4th param:
```ts
export async function runTsPipeline(
  userPrompt: string,
  projectRoot: string,
  config: BoberConfig,
  opts?: { runId?: string },   // ADD
): Promise<PipelineResult> {
```

**`runPipeline` public entry (lines 969-975)** — frozen, but extend additively and forward:
```ts
export async function runPipeline(
  userPrompt: string,
  projectRoot: string,
  config: BoberConfig,
  opts?: { runId?: string },   // ADD (optional → existing 3-arg callers unaffected)
): Promise<PipelineResult> {
  return selectPipelineEngine(config).run(userPrompt, projectRoot, config, opts);
}
```

`pipelineRunId` flows to: roster writes (lines 660, 803, 866, 936), the iteration `sprintRunId` (line 149 already accepts an optional `pipelineRunId` param), and `writeCompletionMarker(projectRoot, pipelineRunId, ...)` (line 943) → `.bober/runs/<pipelineRunId>.completed.json` (feedback-router.ts:387-394). This is exactly what sc-2-4 asserts.

**Imported by (callers of runPipeline that must NOT break):** `src/cli/commands/run.ts:7`, `src/mcp/run-manager.ts:14`. Both call with 3 args today → safe with an optional 4th.

**Test file:** check `src/orchestrator/pipeline.test.ts` if present (grep showed none collocated; pipeline is large). A targeted test can call `runTsPipeline`/`runPipeline` with `{ runId: "test-run-123" }` against a temp projectRoot — but the full pipeline calls the LLM. Prefer asserting at the `pipelineRunId` seam or via the completion-marker path with a stubbed/short config. See §7 risk note.

---

### src/orchestrator/workflow/engine.ts + ts-engine.ts + workflow-engine.ts (modify — forward opts)

The `PipelineEngine.run` interface and both implementers must accept and forward the optional `opts`:

`engine.ts:10-17` interface — add `opts?: { runId?: string }` to `run`.
`ts-engine.ts:16-22` — forward to `runTsPipeline(userPrompt, projectRoot, config, opts)`.
`workflow-engine.ts:55,79` — forward `opts` to `this.tsEngineFactory().run(userPrompt, projectRoot, config, opts)`.

These three files are NOT in `estimatedFiles` but are on the threading path. Keep `opts` optional everywhere so nothing else breaks. (If you instead choose to stash runId on `config` rather than a 4th param, you avoid touching engine.ts/ts-engine.ts/workflow-engine.ts — but the contract's assumption text and pipeline.ts:583 note both endorse the opts approach. Pick ONE and be consistent.)

---

### src/chat/run-spawner.ts (create)

**Directory pattern:** files in `src/chat/` are kebab-case, single class per file, section headers `// ── Name ─────`, named exports, `.js` import extensions. See `conversation-store.ts`, `roster-reader.ts`.

**Most similar existing files:** `src/fleet/runner.ts` (CLI-entry resolution + child spawn) and `src/chat/conversation-store.ts` (chat-dir-scoped persistence class).

**Structure template:**
```ts
// ── run-spawner.ts ─────────────────────────────────────────────────────
//
// Launches a DETACHED `agent-bober run <task> --run-id <id>` child that
// survives the REPL exiting. Writes the roster state.json BEFORE spawning
// so the run is visible the same turn; records the pid in a sidecar.

import { execa } from "execa";

import { writeRunState } from "../state/run-state.js";
import type { RunState } from "../mcp/run-manager.js";
import { resolveCliEntry } from "../fleet/runner.js";   // REUSE — do not reimplement
import { PidSidecar } from "./pid-sidecar.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface SpawnAck {
  runId: string;
  task: string;
  pid?: number;
  cwd: string;
  spawnError?: string;
}

/** Injected spawn fn — default execa. Tests pass a fake that records args + returns a fake child. */
export type SpawnFn = (file: string, args: string[], options: {
  cwd: string; detached: boolean; stdio: "ignore";
}) => { pid?: number; unref: () => void };

export interface RunSpawnerOptions {
  projectRoot: string;
  sessionId: string;
  /** default: (f,a,o) => execa(f,a,o) */
  spawn?: SpawnFn;
  /** default: resolveCliEntry() */
  cliEntry?: string;
  /** default: process.execPath */
  nodeBin?: string;
  /** default: () => new Date().toISOString() */
  now?: () => string;
}

// ── RunSpawner ─────────────────────────────────────────────────────────

export class RunSpawner {
  // store projectRoot, sessionId, spawn, cliEntry, nodeBin, now, sidecar
  async spawn(task: string, runId: string): Promise<SpawnAck> {
    const cwd = this.projectRoot;
    // 1. Write roster state.json FIRST (sc-2-6) — match RunState shape exactly
    const state: RunState = {
      runId, task, status: "running",
      startedAt: this.now(),
      progress: { completed: 0, total: 0 },
      projectRoot: cwd,
    };
    await writeRunState(cwd, state);

    // 2. Launch detached child (sc-2-9) — never await its completion
    try {
      const child = this.spawnFn(this.nodeBin, [this.cliEntry, "run", task, "--run-id", runId], {
        cwd, detached: true, stdio: "ignore",
      });
      child.unref();
      await this.sidecar.record(runId, { pid: child.pid, task, spawnedAt: this.now() });
      return { runId, task, pid: child.pid, cwd };
    } catch (err) {
      return { runId, task, cwd, spawnError: err instanceof Error ? err.message : String(err) };
    }
  }
}
```
**Notes:** `execa(file, args, { detached, stdio: 'ignore' })` returns a child process with `.pid` and `.unref()`. With `stdio: 'ignore'` and not awaiting, the call is non-blocking. Do NOT `await` the returned execa promise — that would block on child completion (the fleet runner DOES await; you must NOT). The injected `spawn` default should be a thin wrapper so the fake in tests can return `{ pid, unref }` without a real process.

---

### src/chat/pid-sidecar.ts (create)

**Most similar existing file:** `src/chat/conversation-store.ts` (lines 1-50) — chat-dir-scoped, `ensureDir` then write under `.bober/chat/`. Use atomic write style from `src/state/run-state.ts:41-53` (temp + rename) if you want crash-safety, or simple `writeFile` for the whole map.

**Structure template:**
```ts
// ── pid-sidecar.ts ─────────────────────────────────────────────────────
//
// Persists runId -> {pid, task, spawnedAt} for a chat session at
// .bober/chat/<sessionId>.pids.json. Survives across instances (sc-2-7).

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir } from "../utils/fs.js";   // src/utils/fs.ts:45

export interface PidEntry { pid?: number; task: string; spawnedAt: string; }

export class PidSidecar {
  constructor(private readonly projectRoot: string, private readonly sessionId: string) {}

  private path(): string {
    return join(this.projectRoot, ".bober", "chat", `${this.sessionId}.pids.json`);
  }

  async readAll(): Promise<Record<string, PidEntry>> {
    try { return JSON.parse(await readFile(this.path(), "utf-8")) as Record<string, PidEntry>; }
    catch { return {}; }   // missing/malformed → empty, never throw
  }

  async record(runId: string, entry: PidEntry): Promise<void> {
    await ensureDir(join(this.projectRoot, ".bober", "chat"));
    const all = await this.readAll();
    all[runId] = entry;
    // prefer temp+rename atomic write (mirror run-state.ts:41-53)
    await writeFile(this.path(), JSON.stringify(all, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  }
}
```
sc-2-7 requires: after `record`, a FRESH `new PidSidecar(...)` instance's `readAll()` still returns the entry → the read must come from disk (it does above), not in-memory cache.

---

### src/chat/chat-session.ts (modify — wire the spawn branch)

**Current placeholder (lines 104-111):**
```ts
if (action.action === "answer") {
  reply = await this.answerer.answer(input, rosterSummary, memoryDistill, recentHistory);
} else {
  // spawn and steer arrive in later sprints
  reply = `The "${action.action}" action is not yet available ...`;
}
```
**Replace with a `spawn` branch (keep `steer` as the not-yet-available fallback):**
```ts
if (action.action === "answer") {
  reply = await this.answerer.answer(input, rosterSummary, memoryDistill, recentHistory);
} else if (action.action === "spawn") {
  const runId = this.nextRunId();           // e.g. `run-${this.now()}` (injectable for tests)
  const ack = await this.spawner.spawn(action.task, runId);
  reply = ack.spawnError
    ? `Failed to launch run ${runId}: ${ack.spawnError}`
    : `Launched run ${runId} for: ${action.task}. Use /runs to track it.`;
} else {
  // steer (inspect/stop) arrives in Sprint 3/4
  reply = `The "${action.action}" action is not yet available ...`;
}
```
**Constructor (lines 65-73):** instantiate `this.spawner = new RunSpawner({ projectRoot: this.projectRoot, sessionId: this.sessionId })`. Add an optional `spawner?: RunSpawner` and `now?: () => string` to `ChatSessionOptions` (lines 18-24) for test injection, defaulting to a real instance / `() => Date.now().toString()`. The reply MUST contain the runId (sc-2-8). Keep the call non-blocking — `spawner.spawn` already returns synchronously.

**`action.task` is available:** the classifier returns `{ action: "spawn"; task: string }` (`src/chat/turn-classifier.ts:13`).

---

## 2. Patterns to Follow

### CLI-entry resolution for spawning a bober child
**Source:** `src/fleet/runner.ts`, lines 9-12 and 85-100
```ts
export function resolveCliEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // dist/<module>
  return join(here, "..", "cli", "index.js");           // dist/cli/index.js
}
// ...
const result = await execa(nodeBin, [cliEntry, "run", spec.task], { cwd: spec.cwd, reject: false, timeout, maxBuffer });
```
**Rule:** REUSE the exported `resolveCliEntry` from `src/fleet/runner.ts` and `process.execPath` as nodeBin — never a bare PATH lookup. Your args are `[cliEntry, "run", task, "--run-id", runId]`. UNLIKE the fleet runner, use `{ detached: true, stdio: "ignore" }` and DO NOT await (call `.unref()` instead).

### RunState shape (authoritative)
**Source:** `src/mcp/run-manager.ts`, lines 35-55
```ts
export interface RunState {
  runId: string; task: string;
  status: "running" | "completed" | "failed" | "aborted";
  startedAt: string; completedAt?: string; abortedAt?: string; abortReason?: string;
  progress: RunProgress;  // { completed: number; total: number; currentSprint?: string; iteration?: number }
  result?: RunResult; error?: string; projectRoot: string; specId?: string;
  worktreePath?: string; branch?: string;
}
```
**Rule:** Construct your spawn-time state with `status: "running"`, `progress: { completed: 0, total: 0 }`, `projectRoot`, and `startedAt` ISO string. (NOTE: `src/chat/roster-reader.test.ts:24-31` uses a DIFFERENT `progress` shape with `currentSprint/totalSprints/...` — that fixture is loose; follow the run-manager.ts interface, which is what `writeRunState`/`readRunState` round-trip.)

### Atomic disk write (temp + rename)
**Source:** `src/state/run-state.ts`, lines 41-53
```ts
const tmp = `${filePath}.${process.pid}.${Date.now()}.${rnd}.tmp`;
await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
await rename(tmp, filePath);
```
**Rule:** Mirror this for the pid sidecar if you want crash-safety. `writeRunState` already does this for you for state.json — just call it.

### Dependency injection for testable spawning
**Source:** `src/fleet/runner.ts`, lines 64-76 (constructor injects `cliEntry`/`nodeBin` overrides)
**Rule:** Inject the spawn function (default `execa`), `cliEntry` (default `resolveCliEntry()`), `nodeBin` (default `process.execPath`), and `now` (default `() => new Date().toISOString()`) through the constructor so tests capture args and avoid real processes / `Date.now()` nondeterminism.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `writeRunState` | `src/state/run-state.ts:41` | `(projectRoot: string, state: RunState): Promise<void>` | Atomic write of `.bober/runs/<runId>/state.json`. Use for the spawn-time roster write (sc-2-6). |
| `readRunState` | `src/state/run-state.ts:61` | `(projectRoot, runId): Promise<RunState \| null>` | Read one run's state; null on missing/malformed. |
| `readRunStatesFromDisk` | `src/state/run-state.ts:110` | `(projectRoot): Promise<RunState[]>` | Cross-project read-only roster enumeration (what RosterReader uses). |
| `resolveCliEntry` | `src/fleet/runner.ts:9` | `(): string` | Resolves `dist/cli/index.js` from module url (ADR-4). Reuse for the child cliEntry. |
| `ensureDir` | `src/utils/fs.ts:45` | `(path: string): Promise<void>` | mkdir -p. Used by ConversationStore; use for the chat dir before sidecar write. |
| `ensureDir` (alt) | `src/state/helpers.ts:6` | `(dirPath): Promise<void>` | Duplicate in state/; prefer the utils/fs one in chat code (matches conversation-store). |
| `writeCompletionMarker` | `src/orchestrator/checkpoints/feedback-router.ts:387` | `(projectRoot, runId, summary): Promise<void>` | Writes `.bober/runs/<runId>.completed.json`. Already called at pipeline.ts:943 with `pipelineRunId` — DO NOT call it yourself; just let the threaded runId flow there. |
| `RosterReader` | `src/chat/roster-reader.ts:11` | `new RosterReader(projectRoot)`, `.read()`, `.summarize(states)` | Already used by ChatSession; `/runs` slash command surfaces the new run after spawn (sc-2-8). |
| `RunState` type | `src/mcp/run-manager.ts:35` | interface | Import as the spawn-time state shape — do not redefine. |
| `execa` | `node_modules` (`import { execa } from "execa"`) | `(file, args, options)` | Spawn primitive. Default for the injected `spawn` fn. Fleet runner imports it the same way (`src/fleet/runner.ts:1`). |

**Utilities reviewed:** `src/utils/` (fs, logger, git), `src/state/` (run-state, helpers, index), `src/fleet/runner.ts`, `src/chat/*`. No existing detached-spawn helper exists — that logic is genuinely new to RunSpawner.

---

## 4. Prior Sprint Output

### Sprint 1: Chat session layer
**Created:** `src/chat/chat-session.ts` (ChatSession.handleTurn — classify→dispatch loop), `src/chat/turn-classifier.ts` (exports `ClassifierAction` discriminated union incl. `{action:"spawn"; task}` at line 13), `src/chat/conversation-store.ts` (ConversationStore.append/loadRecent), `src/chat/roster-reader.ts` (RosterReader.read/summarize), `src/chat/answerer.ts`, `src/chat/slash-commands.ts` (`/runs`, `/help`, `/exit`). Added a `chat` CLI command and `chat` PROMPT role.
**Connection to this sprint:** The classifier already emits `{action:"spawn", task}` (the placeholder at chat-session.ts:106 currently rejects it). This sprint wires that action to the new `RunSpawner`. `RosterReader.read()` is reused by the `/runs` slash command to surface the spawned run (sc-2-8). `ConversationStore.append` persists the ack turn.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM everywhere** — all imports use `.js` extensions (NodeNext). New chat files must import `../fleet/runner.js`, `../state/run-state.js`, etc. with `.js`.
- **`import type` for types** — ESLint enforces `consistent-type-imports`. Import `RunState` and `SpawnFn`/option interfaces as `import type` where they are types only.
- **Filesystem state** — all mutable state is JSON files under `.bober/`. The pid sidecar at `.bober/chat/<sessionId>.pids.json` fits this convention.
- **Small utility modules / section headers** — use `// ── Name ─────` box headers; keep RunSpawner and PidSidecar single-purpose.
- **Prefix unused params with `_`**; **no `any`** (use `unknown` + narrowing). TypeScript strict, zero type errors is a hard gate.
- **Tests collocated** as `*.test.ts` next to source, Vitest.

### Architecture Decisions
- **ADR-4 (entry resolution):** the detached child's CLI entry MUST be resolved relative to the module via `resolveCliEntry()` (`src/fleet/runner.ts:5-12`), never a bare PATH name. Contract assumption confirms the child uses the same resolved entry as the fleet ChildRunner.
- `AGENTS.md` and `README.md` exist at project root (not deeply relevant to this sprint's mechanics beyond build/test commands below).

---

## 6. Testing Patterns

### Unit Test Pattern (temp-dir + injected spawn)
**Source:** `src/fleet/runner.test.ts` (injected entry/nodeBin, no real long process) and `src/chat/roster-reader.test.ts:1-34` (temp-dir state.json round-trip)
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunSpawner } from "./run-spawner.js";
import { readRunState } from "../state/run-state.js";
import { PidSidecar } from "./pid-sidecar.js";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-spawn-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

it("writes roster state.json before launching and returns synchronously (sc-2-6/sc-2-9)", async () => {
  const calls: { file: string; args: string[]; options: unknown }[] = [];
  let unrefCalled = false;
  const fakeSpawn = (file: string, args: string[], options: any) => {
    calls.push({ file, args, options });
    return { pid: 4242, unref: () => { unrefCalled = true; } };
  };
  const spawner = new RunSpawner({
    projectRoot: tmpDir, sessionId: "s1",
    spawn: fakeSpawn, cliEntry: "/fake/cli/index.js", nodeBin: "/fake/node",
    now: () => "2026-06-14T00:00:00.000Z",
  });

  const ack = await spawner.spawn("build X", "test-run-123");

  // state.json exists with status running immediately (no awaiting child completion)
  const state = await readRunState(tmpDir, "test-run-123");
  expect(state?.status).toBe("running");
  expect(ack.runId).toBe("test-run-123");
  expect(calls).toHaveLength(1);
  expect(calls[0].args).toEqual(["/fake/cli/index.js", "run", "build X", "--run-id", "test-run-123"]);
  expect(calls[0].options).toMatchObject({ cwd: tmpDir, detached: true, stdio: "ignore" });
  expect(unrefCalled).toBe(true);
});

it("persists pid sidecar across instances (sc-2-7)", async () => {
  // ...spawn as above, then:
  const fresh = new PidSidecar(tmpDir, "s1");
  const all = await fresh.readAll();
  expect(all["test-run-123"]?.pid).toBe(4242);
});
```
**Runner:** vitest. **Assertion style:** `expect(...).toBe/toEqual/toMatchObject`. **Mock approach:** dependency injection (inject fake `spawn`/`cliEntry`/`now`) — NOT `vi.mock`. The codebase favors constructor injection over module mocking for spawn code (`src/fleet/runner.test.ts`). **File naming:** `run-spawner.test.ts`, `pid-sidecar.test.ts` collocated in `src/chat/`. **Location:** co-located.

### Testing the runId threading (sc-2-4 / sc-2-5)
Avoid driving the full `runPipeline` (it calls real LLMs). Two viable options:
1. Assert on the seam: a small test that the `--run-id` propagates by checking the completion-marker path is keyed on the id — requires a runnable pipeline, heavy. PREFER option 2.
2. Unit-test the pure mapping: confirm `runRunCommand` forwards `options.runId` into the `runPipeline` opts (spy on a stubbed `runPipeline`), and a focused test that `pipelineRunId = opts?.runId ?? run-${Date.now()}` yields `"test-run-123"` when provided and matches `/^run-\d+$/` when not. If extracting that one line is awkward, a thin exported helper `resolvePipelineRunId(opts?)` in pipeline.ts is acceptable and directly testable.

### Classifier→spawn wiring test (sc-2-8)
Inject a fake classifier action by constructing `ChatSession` with an injected `RunSpawner` and calling `handleTurn`, OR test the spawn branch directly. Assert the returned reply string contains the runId, then `RosterReader.read()` lists the run as `running`.

### E2E Test Pattern
Not applicable — no Playwright in this CLI project. Do NOT launch real detached pipelines in tests (contract evaluatorNotes: "do not launch real long-running pipelines").

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/commands/run.ts` | `runPipeline` | low | New optional 4th arg; existing call still type-checks. |
| `src/mcp/run-manager.ts:14` | `runPipeline` | low | Calls `runPipeline` with 3 args (startRun path) — optional 4th param keeps it valid. Verify no signature regression. |
| `src/orchestrator/workflow/ts-engine.ts` | `runTsPipeline` | medium | Must forward new optional `opts`; if you change `runTsPipeline` to required 4th arg you break this — keep optional. |
| `src/orchestrator/workflow/workflow-engine.ts` | `PipelineEngine.run` | medium | Lines 55, 79 call `.run(...)`; forward `opts`. |
| `src/orchestrator/workflow/engine.ts` | interface consumers | medium | Widening `run` with an optional param is backward-compatible; both implementers must still satisfy it. |
| `src/cli/index.ts` | `runRunCommand` | low | Add the `--run-id` option + pass-through; commander camelCases to `runId`. |
| `src/chat/chat-session.ts` | classifier/RosterReader | low | New `spawn` branch; keep `steer` fallback intact. |

### Existing Tests That Must Still Pass
- `src/fleet/runner.test.ts` — verifies the fleet ChildRunner; you reuse `resolveCliEntry` but must NOT change runner.ts behavior. Confirm still green.
- `src/state/run-state.test.ts` — covers `writeRunState`/`readRunState` round-trip; your spawn writes via these. Must remain green (no change to run-state.ts expected).
- `src/mcp/run-manager.test.ts` — exercises `startRun`/RunState; verify the optional runPipeline param did not break the 3-arg call.
- `src/chat/turn-classifier.test.ts`, `src/chat/roster-reader.test.ts`, `src/chat/conversation-store.test.ts`, `src/chat/slash-commands.test.ts` — Sprint-1 chat tests; the new spawn branch must not regress them.

### Features That Could Be Affected
- **Fleet orchestrator** — shares `resolveCliEntry`/`execa` spawn approach (`src/fleet/runner.ts`). Verify you only IMPORT `resolveCliEntry`, not modify it. Fleet awaits (blocking); chat must NOT await (detached).
- **MCP run-manager / bober_run** — shares `runPipeline` + `RunState` + `writeRunState`. Verify a no-runId `runPipeline` call still self-generates `run-<timestamp>` (sc-2-5).

### Recommended Regression Checks
1. `npm run build` — zero TS errors (sc-2-1).
2. `npx tsc --noEmit` (or the project's typecheck script) — zero type errors (sc-2-2).
3. `npx vitest run` (full suite) — all pass, incl. new `src/chat/run-spawner.test.ts` and `src/chat/pid-sidecar.test.ts` (sc-2-3).
4. `npx vitest run src/fleet/runner.test.ts src/mcp/run-manager.test.ts src/state/run-state.test.ts src/chat` — targeted no-regression check on the touched dependency graph.

---

## 8. Implementation Sequence

1. **src/chat/pid-sidecar.ts** (create) — no deps beyond `node:fs`/`ensureDir`. Smallest, leaf.
   - Verify: `new PidSidecar(tmp,'s').record(...)` then a fresh instance `.readAll()` returns the entry.
2. **src/chat/run-spawner.ts** (create) — depends on PidSidecar, `writeRunState`, `resolveCliEntry`, `RunState`.
   - Verify: with a fake spawn, `state.json` (status running) exists right after `spawn()` resolves; args/options/unref captured correctly; returns SpawnAck with runId.
3. **src/orchestrator/pipeline.ts** (modify) — add optional `opts?: { runId?: string }` to `runTsPipeline` + `runPipeline`; change line 583 to `opts?.runId ?? ...`.
   - Verify: build still passes; a focused test shows `pipelineRunId` honors injected id and falls back to `run-<timestamp>` otherwise.
4. **src/orchestrator/workflow/engine.ts + ts-engine.ts + workflow-engine.ts** (modify) — widen `run` signature, forward `opts`.
   - Verify: `npx tsc --noEmit` clean; both engine implementers compile.
5. **src/cli/commands/run.ts** (modify) — add `runId?` to RunCommandOptions; pass `{ runId: options.runId }` into `runPipeline`.
   - Verify: type-checks; existing 3-arg behavior unchanged when undefined.
6. **src/cli/index.ts** (modify) — register `--run-id <id>` option and thread to `runRunCommand`.
   - Verify: `agent-bober run --help` would show `--run-id` (build the CLI; commander maps to `runId`).
7. **src/chat/chat-session.ts** (modify) — instantiate RunSpawner; add the `spawn` branch generating a runId and returning an ack containing it; keep non-blocking + steer fallback.
   - Verify: spawn-action turn returns a reply containing the runId; RosterReader shows the run as running.
8. **Collocated tests** (create) — `run-spawner.test.ts`, `pid-sidecar.test.ts`, and a chat-session spawn-branch test; optional pipeline runId test.
   - Verify: cover sc-2-4 … sc-2-9.
9. **Run full verification** — `npm run build`, typecheck, `npx vitest run`.

---

## 9. Pitfalls & Warnings

- **DO NOT await the detached child.** The fleet runner (`src/fleet/runner.ts:91`) `await`s execa — that BLOCKS until the run finishes. RunSpawner must call execa WITHOUT awaiting and call `.unref()`, so the REPL is non-blocking and the child survives REPL exit. Awaiting would fail sc-2-6 (must return synchronously).
- **`runPipeline` and `PipelineEngine.run` signatures are documented as frozen.** Only ADD an OPTIONAL trailing param and forward it; never make it required. If any of the 3-arg callers (`run.ts`, `run-manager.ts`, ts-engine/workflow-engine) becomes type-broken, you made it required by mistake.
- **`src/cli/index.ts` is not listed in estimatedFiles but is mandatory** — without registering `--run-id`, the detached child `agent-bober run ... --run-id <id>` would error on an unknown option and the keyed marker (sc-2-4) would never happen. commander auto-maps `--run-id` → `cmdOpts.runId`.
- **RunState `progress` shape:** use `{ completed: number; total: number }` per `src/mcp/run-manager.ts:35-55`. The looser fixture in `roster-reader.test.ts:24-31` is NOT the canonical shape — don't copy it.
- **Two `ensureDir` exist** (`src/utils/fs.ts:45` and `src/state/helpers.ts:6`). Use `../utils/fs.js` in chat code to match `conversation-store.ts`.
- **`writeCompletionMarker` is already wired** at `pipeline.ts:943` with `pipelineRunId`. Do NOT call it from chat code — just thread the runId so the existing call keys the marker on the supplied id (sc-2-4).
- **Sidecar persistence (sc-2-7) must hit disk.** A fresh `PidSidecar` instance must read the entry, so `readAll()` reads the JSON file each call (no instance-level cache that masks disk).
- **Determinism in tests:** inject `now()` and the spawn fn; never assert exact `Date.now()` values. The contract evaluatorNotes call this out.
- **`.js` import extensions + `import type`** are hard gates (ESLint/NodeNight). New files: `import { writeRunState } from "../state/run-state.js"`, `import type { RunState } from "../mcp/run-manager.js"`.
- **Out of scope:** no completion weaving / history tailing (Sprint 3), no stop/kill-by-PID (Sprint 4). The sidecar only RECORDS the pid this sprint — do not add supervision or kill logic.
