# Sprint Briefing: RunState grammar + careful-mode chat spawn + /careful toggle

**Contract:** sprint-spec-20260615-chat-interrupt-approve-steer-1
**Generated:** 2026-06-15T17:30:00Z

> Foundation sprint for chat-driven approval. Everything is **additive and default-off**. The autopilot chat spawn must stay byte-for-byte identical to Phase 1.

---

## 1. Target Files

### src/mcp/run-manager.ts (modify)

The `RunState` interface lives here (NOT in run-state.ts). Extend the status union additively and add four optional fields. `RunManager` itself needs no logic change — its switches only match `"running"` and never `default`/exhaust the union.

**Relevant section — `interface RunState` (lines 35-55):**
```ts
export interface RunState {
  runId: string;
  task: string;
  status: "running" | "completed" | "failed" | "aborted";
  startedAt: string;
  completedAt?: string;
  abortedAt?: string;
  abortReason?: string;
  progress: RunProgress;
  result?: RunResult;
  error?: string;
  projectRoot: string;
  specId?: string;
  /** Sprint 4: ... worktree path ... */
  worktreePath?: string;
  branch?: string;
}
```
**Change:** add `| "input-required" | "paused"` to the `status` union and append four optional fields (mirror the existing `worktreePath?`/`branch?` doc-comment style):
```ts
  status: "running" | "completed" | "failed" | "aborted" | "input-required" | "paused";
  // ── Phase 2 (chat interrupt/approve/steer) ──
  /** Checkpoint id the run is paused at, awaiting human input. */
  pendingCheckpointId?: string;
  /** Human-readable prompt surfaced for the pending checkpoint. */
  pendingPrompt?: string;
  /** ISO timestamp the run entered 'input-required'. */
  pendingSince?: string;
  /** ISO timestamp the run was soft-paused. */
  pausedAt?: string;
```

**Imports this file uses:** `randomUUID` from `node:crypto`; `BoberConfig` from `../config/schema.js`; `writeRunState, listRunStateFiles` from `../state/run-state.js`.

**Imported by (verified via grep — `RunState` is imported in 14 files):**
- `src/state/run-state.ts:15` (`type RunState`) — serializer; **no change needed**, `JSON.stringify(state)` already round-trips any field.
- `src/chat/run-spawner.ts:10`, `src/chat/chat-session-steer.test.ts`, `src/chat/roster-reader.ts`
- `src/mcp/tools/status.ts` (status-string switch — see §7), `src/mcp/tools/list-projects.ts`, `src/mcp/tools/get-project-state.ts`
- `src/fleet/aggregator.ts`, `src/fleet/types.ts`

**Test file:** `src/mcp/run-manager.test.ts` (exists). The round-trip test for the new grammar goes in `src/state/run-state.test.ts` per the contract.

---

### src/state/run-state.test.ts (modify — add round-trip tests, sc-1-4)

`writeRunState`/`readRunState` serialize the WHOLE object (`JSON.stringify(state, null, 2)` at `src/state/run-state.ts:48`; `JSON.parse(raw) as RunState` at `:64`). **No production change** is required for round-trip — only the type change in run-manager.ts. Add tests that write `input-required`/`paused` states with all four optional fields and read them back deep-equal, plus a legacy `running` state. Use the existing `makeState()` helper (`src/state/run-state.test.ts:30-40`) with `overrides`.

---

### src/cli/commands/run.ts (modify — add `--approve-gates` merge, sc-1-5)

`RunCommandOptions` is defined at lines 13-30. The override-application block runs sequentially from line 93. Mirror the `--checkpoint` merge pattern exactly.

**Relevant section — existing `--mode`/`--checkpoint` merge (lines 104-132):**
```ts
  // Apply --mode override
  if (options.mode) {
    config = { ...config, pipeline: { ...config.pipeline, mode: options.mode } };
    logger.info(`Mode override: ${options.mode}`);
  }
  ...
  } else if (options.checkpoint) {
    config = {
      ...config,
      pipeline: {
        ...config.pipeline,
        checkpointMechanism: options.checkpoint as "noop" | "cli" | "disk" | "pr",
      },
    };
    logger.info(`Checkpoint override: ${options.checkpoint}`);
  }
```

**Change A — add field to `RunCommandOptions` (after line 29):**
```ts
  /** Comma-separated checkpoint ids to gate via the 'disk' mechanism for this run only. */
  approveGates?: string;
```

**Change B — add a validated merge block** (place it after the `--checkpoint` block, ~line 133). Parse comma-list, trim, validate each against `KNOWN_CHECKPOINT_IDS`, reject unknowns with a thrown error / `process.exitCode = 1` + stderr (mirror the `logger.error` style at lines 87/219), then spread-merge `{ [gate]: 'disk' }` into `config.pipeline.checkpointOverrides`:
```ts
  // Apply --approve-gates: merge { gate -> 'disk' } into checkpointOverrides for this run only.
  if (options.approveGates) {
    const gates = options.approveGates.split(",").map((g) => g.trim()).filter(Boolean);
    const unknown = gates.filter((g) => !KNOWN_CHECKPOINT_IDS.includes(g as CheckpointId));
    if (unknown.length > 0) {
      logger.error(
        `Unknown approve-gate(s): ${unknown.join(", ")}. ` +
        `Valid gates: ${KNOWN_CHECKPOINT_IDS.join(", ")}.`,
      );
      process.exitCode = 1;
      return; // do not apply a partial merge
    }
    const merged = { ...config.pipeline.checkpointOverrides };
    for (const g of gates) merged[g] = "disk";
    config = { ...config, pipeline: { ...config.pipeline, checkpointOverrides: merged } };
    logger.info(`Approve-gates: ${gates.join(", ")} -> disk`);
  }
```
> NOTE on `checkpointOverrides`: `PipelineSectionSchema.checkpointOverrides` (`src/config/schema.ts:192`) is `z.record(z.string(), CheckpointMechanismSchema).default({})` — keys are checkpoint ids, values are `"noop"|"cli"|"disk"|"pr"`. It is ALWAYS an object (never undefined) post-load, so spreading `{...config.pipeline.checkpointOverrides}` is safe.

**Source the gate set** — the contract says define `KNOWN_CHECKPOINT_IDS` and point a comment at the sites. The canonical list already exists: `CHECKPOINT_SITES` in `src/orchestrator/checkpoints/sites.ts:23-78`. Either import + map it, or declare a literal tuple. **Recommended (single source of truth):**
```ts
import { CHECKPOINT_SITES } from "../../orchestrator/checkpoints/sites.js";
import type { CheckpointId } from "../../orchestrator/checkpoints/types.js";
/** Valid --approve-gates names — sourced from the declared checkpoint sites. */
export const KNOWN_CHECKPOINT_IDS: readonly CheckpointId[] =
  CHECKPOINT_SITES.map((s) => s.id);
```
The nine ids are: `post-research, post-plan, post-sprint-contract, pre-curator, pre-generator, pre-evaluator, pre-code-reviewer, post-sprint, end-of-pipeline` (`src/orchestrator/checkpoints/sites.ts`). Export `KNOWN_CHECKPOINT_IDS` so the test can assert against it.

**Imported by / test:** `src/cli/index.ts:20` imports `runRunCommand`; `src/cli/commands/run.test.ts` tests it via `vi.mock` of `pipeline`/`loader` then calls `runRunCommand` directly.

---

### src/cli/index.ts (modify — register the flag, threads to runRunCommand)

The `run` command is registered at lines 196-245. Add a `.option("--approve-gates <gates>", ...)`, add `approveGates?: string` to the inline `cmdOpts` type at line 225-232, and thread `approveGates: cmdOpts?.approveGates` into the `runRunCommand(...)` call at lines 236-244.

**Relevant section (lines 217-244):**
```ts
    .option(
      "--run-id <id>",
      "Use a caller-supplied run identifier instead of self-generating run-<timestamp>.",
    )
    .option(
      "--team <id>",
      "Select the active team for this run; absent => config.defaultTeam then 'programming'.",
    )
    .action(async (task?: string, cmdOpts?: {
      provider?: string;
      mode?: "autopilot" | "careful";
      checkpoint?: string;
      checkpointAll?: boolean;
      runId?: string;
      team?: string;
    }) => {
      const opts = program.opts<{ verbose?: boolean; config?: string }>();
      const projectRoot = await resolveProjectRoot(opts.config);
      await runRunCommand(task, projectRoot, {
        verbose: opts.verbose,
        provider: cmdOpts?.provider,
        mode: cmdOpts?.mode,
        checkpoint: cmdOpts?.checkpoint,
        checkpointAll: cmdOpts?.checkpointAll,
        runId: cmdOpts?.runId,
        team: cmdOpts?.team,
      });
    });
```
**Rule:** Commander camelCases `--approve-gates` to `approveGates` automatically. Add the option + cmdOpts field + threading line.

---

### src/chat/careful-sidecar.ts (create)

**Directory pattern:** Files in `src/chat/` are kebab-case `.ts` with a leading `// ── name.ts ──` box header (see `src/chat/pid-sidecar.ts:1`). Sidecars live at `.bober/chat/<sessionId>.*.json`.
**Most similar existing file:** `src/chat/pid-sidecar.ts` — mirror it exactly (constructor `(projectRoot, sessionId)`, private `path()`, tolerant read returning a default on missing/malformed, atomic-ish `writeFile` with `mode: 0o600`, `ensureDir(.bober/chat)` from `../utils/fs.js`).

**Structure template (modeled on `src/chat/pid-sidecar.ts:1-64`):**
```ts
// ── careful-sidecar.ts ─────────────────────────────────────────────────
//
// Persists the per-session "careful mode" toggle at
// .bober/chat/<sessionId>.careful.json. Default off → autopilot (Phase 1).

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ensureDir } from "../utils/fs.js";

export class CarefulSidecar {
  constructor(
    private readonly projectRoot: string,
    private readonly sessionId: string,
  ) {}

  private path(): string {
    return join(this.projectRoot, ".bober", "chat", `${this.sessionId}.careful.json`);
  }

  /** Read the careful flag. Missing/malformed file => false (autopilot). Never throws. */
  async isCareful(): Promise<boolean> {
    try {
      const data = JSON.parse(await readFile(this.path(), "utf-8")) as { careful?: boolean };
      return data.careful === true;
    } catch {
      return false;
    }
  }

  /** Persist the careful flag. */
  async setCareful(on: boolean): Promise<void> {
    await ensureDir(join(this.projectRoot, ".bober", "chat"));
    await writeFile(
      this.path(),
      JSON.stringify({ careful: on }, null, 2) + "\n",
      { encoding: "utf-8", mode: 0o600 },
    );
  }
}
```

**Test file:** `src/chat/careful-sidecar.test.ts` (create). Mirror `src/chat/pid-sidecar.test.ts` — mkdtemp temp dir, toggle on, construct a FRESH `CarefulSidecar` for the same sessionId, assert `isCareful()` true; toggle off, assert false; assert missing-file default is false (sc-1-6).

---

### src/chat/slash-commands.ts (modify — add `/careful`, sc-1-6)

`dispatch` (lines 38-79) is a `switch (command)`. The `stopHandler` optional-callback threading (lines 41, 64-66) is the EXACT back-compat pattern to mirror for a `carefulHandler`.

**Relevant section (lines 38-67):**
```ts
export async function dispatch(
  input: string,
  roster: RosterReader,
  stopHandler?: (runId: string) => Promise<string>,
): Promise<SlashResult> {
  ...
  switch (command) {
    ...
    case "/stop": {
      const arg = trimmed.split(/\s+/)[1];
      if (!arg) return { handled: true, output: "Usage: /stop <runId>" };
      const output = stopHandler ? await stopHandler(arg) : "Stop is unavailable.";
      return { handled: true, output };
    }
```
**Change:** add a 4th optional param `carefulHandler?: (arg: string | undefined) => Promise<string>` (keeps existing 2-/3-arg callers green — see `src/chat/slash-commands.test.ts:32` which calls `dispatch("/help", roster)` with 2 args), add a `case "/careful":` that parses the optional `on|off` arg, and add `/careful` to `HELP_TEXT` (lines 17-25):
```ts
    case "/careful": {
      const arg = trimmed.split(/\s+/)[1]?.toLowerCase();
      const output = carefulHandler
        ? await carefulHandler(arg)
        : "Careful mode is unavailable.";
      return { handled: true, output };
    }
```
**Rule:** Keep `dispatch` deterministic — never call the LLM. `HELP_TEXT` is a const array joined with `\n` (line 17-25); add `"  /careful [on|off] — Toggle approval gates for new runs"`.

---

### src/chat/chat-session.ts (modify — construct sidecar, thread careful into spawn)

The session constructs `RunSpawner` at lines 96-101 and dispatches slash commands at lines 126-130. The `spawn` branch is at lines 162-167.

**Relevant section — slash dispatch (lines 126-130):**
```ts
    const slashResult = await dispatch(
      input,
      this.roster,
      (runId) => this.handleStop(runId),
    );
```
**Relevant section — spawn branch (lines 162-167):**
```ts
    } else if (action.action === "spawn") {
      const runId = this.nextRunId();
      const ack = await this.spawner.spawn(action.task, runId);
      reply = ack.spawnError
        ? `Failed to launch run ${runId}: ${ack.spawnError}`
        : `Launched run ${runId} for: ${action.task}. Use /runs to track it.`;
    }
```
**Changes:**
1. Add a private field `carefulSidecar: CarefulSidecar` initialized in the constructor (lines 86-105): `this.carefulSidecar = new CarefulSidecar(this.projectRoot, this.sessionId);` (import from `./careful-sidecar.js`).
2. Pass a `carefulHandler` 4th arg to `dispatch(...)` that calls `this.handleCareful(arg)` — a new private method that reads/sets the sidecar and returns a state-report string (`/careful` no-arg → report current; `on`/`off` → set + confirm message per generatorNotes: `'Careful mode ON — new runs will pause at curated gates.'`).
3. In the spawn branch, read careful state and pass it to `spawner.spawn`: `const careful = await this.carefulSidecar.isCareful(); const ack = await this.spawner.spawn(action.task, runId, { careful });`
> The constructor injects `spawner` for tests (`opts.spawner`, line 97). Add a `now`-style injected `carefulSidecar?` option to `ChatSessionOptions` (lines 21-39) OR construct it unconditionally — tests use a real temp dir so an unconditional construction is fine and matches how `store`/`roster` are built.

**Test file:** existing tests `src/chat/chat-session-spawn.test.ts`, `src/chat/chat-session-steer.test.ts`. These must stay green — the `dispatch` and `spawn` signatures change additively (new optional 4th dispatch arg + new optional `spawn` opts arg). Add new `/careful` toggle assertions in a new or existing chat-session test.

---

### src/chat/run-spawner.ts (modify — append `--approve-gates` when careful, sc-1-7)

`spawn(task, runId)` is at lines 93-132. The args vector is built at line 111. Keep careful OFF by default so existing run-spawner tests pass unchanged (`src/chat/run-spawner.test.ts:89` asserts the EXACT Phase 1 vector).

**Relevant section (lines 93-113):**
```ts
  async spawn(task: string, runId: string): Promise<SpawnAck> {
    const cwd = this.projectRoot;
    const state: RunState = { runId, task, status: "running", startedAt: this.now(),
      progress: { completed: 0, total: 0 }, projectRoot: cwd };
    await writeRunState(cwd, state);
    try {
      const child = this.spawnFn(
        this.nodeBin,
        [this.cliEntry, "run", task, "--run-id", runId],
        { cwd, detached: true, stdio: "ignore" },
      );
```
**Change:** add an optional 3rd param with a default so all existing 2-arg callers and tests are byte-for-byte unchanged, then conditionally append the curated gates:
```ts
  async spawn(
    task: string,
    runId: string,
    opts: { careful?: boolean } = {},
  ): Promise<SpawnAck> {
    ...
    const args = [this.cliEntry, "run", task, "--run-id", runId];
    if (opts.careful) {
      args.push("--approve-gates", "post-research,post-plan,post-sprint");
    }
    const child = this.spawnFn(this.nodeBin, args, { cwd, detached: true, stdio: "ignore" });
```
**Rule:** The curated list is the literal `"post-research,post-plan,post-sprint"` (per contract description and sc-1-7). When `careful` is falsy the args MUST equal `[cliEntry, "run", task, "--run-id", runId]` exactly.

**Test file:** `src/chat/run-spawner.test.ts` (exists). Add: careful-on captures `--approve-gates` + curated list in `calls[0].args`; careful-off asserts `calls[0].args` equals the Phase 1 vector. Use the `makeFakeSpawn()` helper (lines 21-35) that records `calls`.

---

## 2. Patterns to Follow

### Sidecar (read-tolerant / atomic write)
**Source:** `src/chat/pid-sidecar.ts`, lines 40-63
```ts
  async readAll(): Promise<Record<string, PidEntry>> {
    try {
      return JSON.parse(await readFile(this.path(), "utf-8")) as Record<string, PidEntry>;
    } catch {
      return {};   // missing/malformed => default, never throws
    }
  }
  async record(runId: string, entry: PidEntry): Promise<void> {
    await ensureDir(join(this.projectRoot, ".bober", "chat"));
    ...
    await writeFile(this.path(), JSON.stringify(all, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  }
```
**Rule:** Sidecar reads tolerate a missing/corrupt file (return the default); writes `ensureDir` first and use `mode: 0o600`. `CarefulSidecar` follows this verbatim.

### CLI override merge (immutable spread)
**Source:** `src/cli/commands/run.ts`, lines 122-131
```ts
  } else if (options.checkpoint) {
    config = { ...config, pipeline: { ...config.pipeline, checkpointMechanism: options.checkpoint as ... } };
    logger.info(`Checkpoint override: ${options.checkpoint}`);
  }
```
**Rule:** Never mutate `config` in place. Re-assign `config = { ...config, pipeline: { ...config.pipeline, <field>: ... } }` and `logger.info` the override.

### Optional-handler back-compat in dispatch
**Source:** `src/chat/slash-commands.ts`, lines 41 + 64-66
```ts
  stopHandler?: (runId: string) => Promise<string>,
  ...
  const output = stopHandler ? await stopHandler(arg) : "Stop is unavailable.";
```
**Rule:** New cross-cutting handlers are appended as OPTIONAL trailing params with a graceful "unavailable" fallback, so 2-/3-arg callers (and tests) keep working.

### Injected spawn fn for tests
**Source:** `src/chat/run-spawner.ts`, lines 35-39, 74-78
```ts
export type SpawnFn = (file: string, args: string[],
  options: { cwd: string; detached: boolean; stdio: "ignore" }) => { pid?: number; unref: () => void };
```
**Rule:** Tests inject a fake `spawn` that pushes `{file,args,options}` into a `calls[]` array and returns `{ pid, unref }` — never launch a real process.

### Atomic disk write (temp-file + rename)
**Source:** `src/state/run-state.ts`, lines 41-53
```ts
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${rnd}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  await rename(tmp, filePath);
```
**Rule:** RunState writes are atomic and serialize the whole object — adding optional fields needs NO serializer change.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `ensureDir` | `src/utils/fs.ts:45` | `(path: string): Promise<void>` | `mkdir -p`. Use in CarefulSidecar.setCareful (NOT a new mkdir). |
| `fileExists` | `src/utils/fs.ts:10` | `(path: string): Promise<boolean>` | Async readable check. |
| `readJson` / `writeJson` | `src/utils/fs.ts:24` / `:34` | `<T>(path): Promise<T>` / `(path, data): Promise<void>` | JSON helpers (writeJson ensureDirs + pretty-prints). Sidecar uses inline read/write to match pid-sidecar; do not introduce a different helper. |
| `writeRunState` | `src/state/run-state.ts:41` | `(projectRoot, state: RunState): Promise<void>` | Atomic state.json write. Serializes the whole RunState — covers new fields free. |
| `readRunState` | `src/state/run-state.ts:61` | `(projectRoot, runId): Promise<RunState \| null>` | Tolerant read (null on missing/corrupt). |
| `listRunStateFiles` / `readRunStatesFromDisk` | `src/state/run-state.ts:78` / `:110` | `(projectRoot): Promise<RunState[]>` | Enumerate roster from disk. |
| `CHECKPOINT_SITES` | `src/orchestrator/checkpoints/sites.ts:23` | `readonly CheckpointSite[]` (each has `.id: CheckpointId`) | THE canonical list of the 9 valid gate ids — source `KNOWN_CHECKPOINT_IDS` from this. |
| `CheckpointId` (type) | `src/orchestrator/checkpoints/types.ts` | string-literal union | Type the gate-id constant + validation against it. |
| `resolveCheckpointMechanismName` | `src/orchestrator/checkpoints/registry.ts:65` | `(checkpointId, config, cliOverride?, cliOverrideAll?, fallback?): string` | Confirms merging `{gate:'disk'}` into `checkpointOverrides` (Tier 2) wins over `mode` (Tier 5) — that's why `--approve-gates` needs NO `--mode`. Do not call from this sprint; cited as the reason the merge is sufficient (assumption #3). |
| `PidSidecar` | `src/chat/pid-sidecar.ts:21` | `class (projectRoot, sessionId)` | Template for CarefulSidecar — copy the shape, change suffix + payload. |
| `CheckpointMechanismSchema` | `src/config/schema.ts:176` | `z.enum(["noop","cli","disk","pr"])` | Valid mechanism values; `checkpointOverrides` values must be one of these (`"disk"`). |

Utilities reviewed: `src/utils/fs.ts`, `src/utils/logger.ts`, `src/state/run-state.ts`, `src/state/helpers.ts`, `src/chat/*`. No existing careful/approve-gate sidecar or flag exists — create them.

---

## 4. Prior Sprint Output

This plan's Sprint 1 has no in-plan dependencies (`dependsOn: []`). It builds on two merged phases:

### Phase 1 (PR #44, spec-20260614-bober-chat-session-layer)
**Created:** `src/chat/chat-session.ts` (`ChatSession.handleTurn`), `src/chat/run-spawner.ts` (`RunSpawner.spawn`/`.stop` — detached `bober run --run-id` child), `src/chat/pid-sidecar.ts` (`PidSidecar`), `src/chat/slash-commands.ts` (`dispatch`), `src/chat/roster-reader.ts`, `src/chat/completion-tailer.ts`.
**Connection:** This sprint extends `RunSpawner.spawn` (append `--approve-gates`), `dispatch` (`/careful`), and `ChatSession` (construct `CarefulSidecar`, thread careful into spawn) — all ADDITIVE. The `--run-id` child path (`run-spawner.ts:111`) is where the gate flag rides along, consumed by `src/cli/commands/run.ts`.

### Phase 4 (PR #45, spec-20260615-team-abstraction)
**Created:** `--team` flag in `src/cli/index.ts` + `src/cli/commands/run.ts`; `src/teams/registry.ts`.
**Connection:** The `--team` flag is the freshest precedent for adding a new additive `run` CLI option — mirror its registration/threading (`src/cli/index.ts:221-244`, `src/cli/commands/run.ts:28-30,150-157`) for `--approve-gates`.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM + `.js` import extensions** everywhere; `import type` for types (consistent-type-imports enforced). (lines 27, 35)
- **No SDK types outside `providers/`**. (line 41)
- **Filesystem state only** — `.bober/` JSON files, no DB, no global in-memory state. (line 31)
- **No test mocks for filesystem** — tests create temp dirs and clean up. (line 44) [The existing `run.test.ts` DOES `vi.mock` the pipeline/loader modules — mocking non-fs modules is fine; just don't mock `node:fs`.]
- **Section comments** `// ── Name ──`. (line 32)
- **Strict mode, zero type errors, zero lint errors are hard gates.** `noFallthroughCasesInSwitch` is on — every new `switch` case must `return`/`break`. (line 18)
- **Prefix unused params with `_`.** (line 36)

### Architecture / Research (`.bober/research/20260614-chattable-team-of-agents-platform.md`)
- **Invariant #3 (line 177):** approval gate = worker → `input-required` (A2A grammar), no HTTP stack. This is exactly the `RunState` status this sprint adds.
- **Invariant #2 (line 176):** disk roster is the only membership truth — `RunManager` reloaded per turn; never reconstruct from LLM context. (Why the sidecar/state files are authoritative.)
- **Roadmap S2.1 (line 278):** "Add `input-required`/`paused` to `RunState` (A2A grammar)" — this sprint.
- **A2A vocabulary (line 96):** `submitted → working → input-required → ... completed|failed|canceled|rejected`.

### Other
No `CLAUDE.md`/`CONTRIBUTING.md` coding-guideline file at repo root beyond `.bober/principles.md`.

---

## 6. Testing Patterns

### Unit Test Pattern (filesystem — temp dir, no fs mocks)
**Source:** `src/state/run-state.test.ts:8-44`
```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-run-state-test-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

function makeState(overrides?: Partial<RunState>): RunState {
  return { runId: "test-run-123", task: "build something", status: "running",
    startedAt: new Date().toISOString(), progress: { completed: 0, total: 0 },
    projectRoot: tmpDir, ...overrides };
}
```
**Round-trip test for sc-1-4:**
```ts
it("round-trips an 'input-required' state with pending fields", async () => {
  const state = makeState({ runId: "ir-run", status: "input-required",
    pendingCheckpointId: "post-plan", pendingPrompt: "approve the plan?",
    pendingSince: "2026-06-15T00:00:00.000Z", pausedAt: "2026-06-15T00:00:01.000Z" });
  await writeRunState(tmpDir, state);
  const read = await readRunState(tmpDir, "ir-run");
  expect(read).toEqual(state);
});
```
**Runner:** vitest · **Assertion:** `expect().toBe/toEqual/toMatchObject/toThrow` · **Mock:** `vi.mock` (modules only, NOT fs) or injected fakes · **File naming:** `<name>.test.ts` co-located · **Location:** co-located next to source.

### Injected-fake pattern (capture spawn args — for sc-1-7)
**Source:** `src/chat/run-spawner.test.ts:21-35, 86-91`
```ts
function makeFakeSpawn(pid = 4242) {
  const calls: Array<{ file: string; args: string[]; options: unknown }> = [];
  const spawn = (file: string, args: string[], options: unknown) => {
    calls.push({ file, args, options });
    return { pid, unref: () => {} };
  };
  return { spawn, calls };
}
// ...
expect(calls[0].args).toEqual(["/fake/cli/index.js", "run", "build X", "--run-id", "test-run-123"]);
```
For sc-1-7 careful-on, assert `calls[0].args` `.toContain("--approve-gates")` and includes `"post-research,post-plan,post-sprint"`; for careful-off assert `.toEqual` the Phase 1 vector above.

### CLI command test (mock pipeline/loader, call directly — for sc-1-5)
**Source:** `src/cli/commands/run.test.ts:31-44, 104-116`
```ts
vi.mock("../../orchestrator/pipeline.js", () => ({ runPipeline: vi.fn(async () => ({ ... })) }));
vi.mock("../../config/loader.js", () => ({ configExists: vi.fn(async () => true), loadConfig: vi.fn(async () => minimalConfig) }));
// ...
await runRunCommand("do something", tmpDir, { approveGates: "post-research,post-plan,post-sprint" });
expect(runPipeline).toHaveBeenCalledWith("do something", tmpDir,
  expect.objectContaining({ pipeline: expect.objectContaining({
    checkpointOverrides: { "post-research": "disk", "post-plan": "disk", "post-sprint": "disk" } }) }),
  expect.anything());
```
For the unknown-gate case, call with `approveGates: "bogus"` and assert no partial merge applied (the `config` passed to `runPipeline` keeps `checkpointOverrides` unchanged, or `runPipeline` is not called because of early `return`). `loadConfig` returns `minimalConfig` which has NO `pipeline` section — for the merge test, give `minimalConfig` a `pipeline: { checkpointOverrides: {} }` so the spread has a base, OR test the parse/merge as an exported pure helper.

### No E2E for this sprint
No Playwright. Sprint 6 covers e2e (out of scope here).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/state/run-state.ts` | `RunState` (type only) | low | Serializer is shape-agnostic; new optional fields round-trip free. No change. |
| `src/mcp/tools/status.ts:54,69,85` | `RunState.status` | low | Uses `if (state.status === "running"/"completed"/"aborted")` — NOT an exhaustive switch; new statuses fall through to existing else-branches harmlessly. No change required, but a future `"input-required"` status renders as the generic case (acceptable; surfacing is Sprint 2). |
| `src/mcp/tools/list-active-runs.ts:31-35` | `RunState.status` | low | Filters by a string equality (`s.status === statusFilter`); accepts any string. New statuses just aren't "running". |
| `src/mcp/run-manager.ts:84,116,251` | `RunState.status` | low | `=== "running"` checks; no `default`/exhaustive switch. `load()` only reconciles `"running"`. New statuses are inert here. |
| `src/chat/roster-reader.ts` | `RunState` | low | Summarizes states; verify it doesn't `switch` exhaustively on status (it reads fields, doesn't enumerate the union). |
| `src/fleet/aggregator.ts`, `src/mcp/tools/get-project-state.ts`, `list-projects.ts` | `RunState.status` | low | All use `=== "running"` filters, not exhaustive switches. |
| `src/cli/index.ts` | `runRunCommand` signature | low | Add the new flag + thread `approveGates`; existing options untouched. |
| `src/chat/chat-session.ts` | `dispatch`, `RunSpawner.spawn` | medium | New optional dispatch 4th arg + spawn opts arg are additive; existing call sites compile unchanged. |

**No exhaustive `switch (status)` on `RunState` exists** (verified via grep — all matches are `if (status === ...)` string equalities). The union extension is safe; `noFallthroughCasesInSwitch` only bites NEW switches you add.

### Existing Tests That Must Still Pass
- `src/state/run-state.test.ts` — round-trip/atomic/concurrent writes; new fields must not break `makeState()` or existing assertions.
- `src/chat/run-spawner.test.ts:89` — asserts the **EXACT** Phase 1 arg vector. With careful defaulting off, this stays green. This is the canary for sc-1-7's "byte-for-byte unchanged" requirement.
- `src/chat/slash-commands.test.ts:32-87` — calls `dispatch(...)` with 2 args; the new optional 4th param keeps these green.
- `src/chat/chat-session-spawn.test.ts`, `src/chat/chat-session-steer.test.ts` — inject `spawner`/`llm`; new sidecar construction + spawn opts must not change reply strings or the spawn/stop behavior.
- `src/cli/commands/run.test.ts` — `--team`/`--run-id` threading; the new merge block must run AFTER existing override blocks and not perturb them.
- `src/mcp/run-manager.test.ts` — RunManager status logic; unchanged.

### Features That Could Be Affected
- **Phase 1 chat spawn (autopilot)** — shares `RunSpawner.spawn` + `ChatSession`. Verify a default (careful-off) spawn produces the identical arg vector and reply. THIS is stop-condition #2.
- **`bober run` CLI** — shares `run.ts` override chain. Verify `--mode`/`--checkpoint`/`--checkpoint-all`/`--team` still behave; `--approve-gates` merges only the named gates and leaves the rest of `checkpointOverrides` intact.
- **Checkpoint resolution** — `resolveCheckpointMechanismName` (`registry.ts:65`) Tier 2 reads `checkpointOverrides[id]`; merging `disk` there activates only those gates without `--mode careful` (assumption #3). Do NOT touch DiskCheckpointMechanism/approval-state.ts/approve CLI (nonGoals).

### Recommended Regression Checks
1. `npm run build` — zero TS errors (the union/type change compiles; dist `.d.ts` regenerated by build — do NOT hand-edit dist).
2. `npm run typecheck` — strict mode clean.
3. `npm run test` — full suite green, especially `run-spawner.test.ts`, `slash-commands.test.ts`, `chat-session-*.test.ts`, `run-state.test.ts`, `run.test.ts`.
4. Manual sanity: confirm `git grep -n 'switch.*status'` shows no NEW exhaustive switch over `RunState.status`.

---

## 8. Implementation Sequence

1. **src/mcp/run-manager.ts** — extend `RunState.status` union (+`"input-required"|"paused"`) and add the 4 optional fields (lines 35-55).
   - Verify: `npm run typecheck` clean; no exhaustive-switch error.
2. **src/state/run-state.test.ts** — add round-trip tests for `input-required`/`paused`/legacy `running` (sc-1-4).
   - Verify: new tests green; serializer unchanged.
3. **src/cli/commands/run.ts** — export `KNOWN_CHECKPOINT_IDS` (sourced from `CHECKPOINT_SITES`), add `approveGates` to `RunCommandOptions`, add the validate+merge block (sc-1-5).
   - Verify: merge produces the 3 `disk` entries; unknown gate → error + no partial merge.
4. **src/cli/index.ts** — register `--approve-gates <gates>` option + cmdOpts field + thread `approveGates` into `runRunCommand` (lines 217-244).
   - Verify: `node dist/cli/index.js run --help` lists the flag (after build).
5. **src/cli/commands/run.test.ts** — assert merge + unknown-gate rejection (sc-1-5).
   - Verify: tests green.
6. **src/chat/careful-sidecar.ts** — create `CarefulSidecar` mirroring `pid-sidecar.ts` (`isCareful`/`setCareful`, default false).
   - Verify: compiles; uses `ensureDir` from `../utils/fs.js`.
7. **src/chat/careful-sidecar.test.ts** — toggle on → fresh instance reads true; off → false; missing → false (sc-1-6).
   - Verify: tests green.
8. **src/chat/run-spawner.ts** — add optional `opts: { careful?: boolean } = {}` 3rd param to `spawn`; append `--approve-gates post-research,post-plan,post-sprint` when careful (sc-1-7).
   - Verify: `run-spawner.test.ts:89` (Phase 1 vector) still passes.
9. **src/chat/run-spawner.test.ts** — add careful-on (contains gates) + careful-off (exact Phase 1 vector) assertions (sc-1-7).
   - Verify: both green.
10. **src/chat/slash-commands.ts** — add optional `carefulHandler` 4th param, `/careful` case, and HELP_TEXT line (sc-1-6).
    - Verify: `slash-commands.test.ts` 2-arg callers still green.
11. **src/chat/chat-session.ts** — construct `CarefulSidecar`; thread `carefulHandler` into `dispatch`; read careful + pass `{ careful }` into `spawner.spawn` (sc-1-6, sc-1-7).
    - Verify: `chat-session-spawn.test.ts`/`-steer.test.ts` green; add a `/careful` toggle test.
12. **src/chat/slash-commands.test.ts** — add `/careful on|off|<none>` dispatch assertions (sc-1-6).
    - Verify: green.
13. **Full verification** — `npm run build && npm run typecheck && npm run test`.

---

## 9. Pitfalls & Warnings

- **`RunState` lives in `src/mcp/run-manager.ts:35`, NOT in `src/state/run-state.ts`.** run-state.ts only `import type`s it. Edit the type in run-manager.ts; the serializer needs no change.
- **Do NOT hand-edit `dist/`.** The `.d.ts` is regenerated by `npm run build`. Only edit `src/`.
- **run-spawner.ts careful arg MUST default off.** `src/chat/run-spawner.test.ts:89` asserts the EXACT Phase 1 arg vector — any unconditional `--approve-gates` breaks it and violates stop-condition #2 (autopilot byte-for-byte unchanged).
- **`dispatch`/`spawn` new params MUST be optional trailing args.** `slash-commands.test.ts` calls `dispatch` with 2 args; chat-session tests call `spawn` with 2 args. Mirror the `stopHandler?` pattern (`slash-commands.ts:41`).
- **`checkpointOverrides` is `Record<string, "noop"|"cli"|"disk"|"pr">` and is ALWAYS an object post-load** (`schema.ts:192` `.default({})`). Spread it; do not assume undefined. Merge `{ [gate]: "disk" }`.
- **Do NOT also set `--mode careful`.** Merging into `checkpointOverrides` (Tier 2, `registry.ts:76`) beats the mode default (Tier 5). Setting mode too would gate ALL checkpoints, not just the curated three (assumption #3, nonGoal "do not change autopilot spawn behavior").
- **`noFallthroughCasesInSwitch` is on.** The new `/careful` switch case in `dispatch` must `return` (every existing case returns).
- **Source `KNOWN_CHECKPOINT_IDS` from `CHECKPOINT_SITES`** (`sites.ts:23`) — a free-floating literal tuple risks drifting from the real sites. If you use a literal tuple, add a comment pointing at `src/orchestrator/checkpoints/sites.ts`.
- **`run.ts` validation must reject unknown gates with NO partial merge** (evaluatorNotes for sc-1-5): validate the whole list first, error+`return` on any unknown, only then merge.
- **`import type` for type-only imports** (`RunState`, `CheckpointId`, `SpawnAck`) — ESLint `consistent-type-imports` errors otherwise.
- **Surfacing/writing approvals is OUT OF SCOPE** (Sprints 2-3). Adding the `input-required` status here must not change how `status.ts`/`roster-reader.ts` render — leaving them to fall into their generic branches is correct for this sprint.
