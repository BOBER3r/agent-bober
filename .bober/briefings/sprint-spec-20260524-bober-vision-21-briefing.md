# Sprint Briefing: Rollback awareness + `bober rollback` CLI command

**Contract:** sprint-spec-20260524-bober-vision-21
**Generated:** 2026-05-25T00:00:00Z

> **DESTRUCTIVE OPERATION SPRINT.** Every rollback step is itself a risky action that must pass through the Sprint 20 gate independently — N rollback steps invoke the gate N times. Plan presentation does NOT replace per-step approval. The `--dry-run` flag must produce **zero side effects** (no ChangeEntry writes, no executor calls). Halting on inverse failure means subsequent steps stay `executed`, NOT silently marked rolled-back.

---

## Sprint Summary (8 success criteria)

| ID | What it checks |
|----|----------------|
| s21-c1 | `planRollback(incidentId)` reads `changelog.jsonl`, filters effective-status `executed` (not `rolled-back`), returns inverses in **reverse execution order**. |
| s21-c2 | `executeRollback(plan)` runs each inverse through the Sprint 20 risky-action gate (per-step). Marks original `ChangeEntry.status='rolled-back'` on success. |
| s21-c3 | CLI `bober rollback <incidentId>` calls planRollback → presents plan **even in autopilot mode** → executeRollback → writes `rollback-execution.jsonl`. |
| s21-c4 | `--since <changeId>` partial rollback; `--dry-run` prints plan without executing anything. |
| s21-c5 | Inverse failure halts sequence; failed step → `rolled-back-failed`; escalation triggers with **list of remaining unrolled steps**. |
| s21-c6 | Missing-inverse ChangeEntries excluded from plan; surfaced in warnings (defensive — schema requires inverse, but legacy/malformed data possible). |
| s21-c7 | Unit + integration tests cover planRollback, executeRollback happy-path, --since, --dry-run, halt-on-failure, no-inverse. |
| s21-c8 | typecheck / lint / build / test all exit 0. |

---

## 1. Target Files

### `src/incident/types.ts` (modify) — schema extension

**The status enum is currently:** (line 88)

```typescript
status: z.enum(["pending", "executed", "rolled-back", "failed"]),
```

**Sprint 21 needs a NEW terminal state** `'rolled-back-failed'` (s21-c5). The generator must extend the enum:

```typescript
status: z.enum(["pending", "executed", "rolled-back", "rolled-back-failed", "failed"]),
```

That's the **only** change in this file. The status field is consumed by Sprint 20 (`execute.ts:147-187`) and Sprint 21 (this sprint). Sprint 20 only writes `'pending'`/`'executed'`/`'failed'`, so adding a new variant is safe.

**Imported by:** `src/incident/timeline.ts`, `src/orchestrator/deploy/execute.ts`, `tests/incident/timeline.test.ts`, `tests/orchestrator/deployer.test.ts`. None of these write the new variant, so the extension is backward-compatible.

---

### `src/incident/rollback.ts` (create)

**Directory pattern:** Single existing sibling is `src/incident/timeline.ts`. Same conventions: zod schemas for inputs, named exports, JSDoc at file top, mutex via promise-chain, mode 0600 on file writes, `appendOneLine`-style append.

**Most similar existing file:** `src/incident/timeline.ts` — copy its file structure (header doc, imports, helpers, exports). Use `appendChange` (already exists) for status writes; you do NOT need a new appender.

**What it MUST export:**

```typescript
// Plan shape (per generatorNotes):
export interface RollbackPlan {
  incidentId: string;
  totalChanges: number;
  rollbackableChanges: number;
  unrollbackableChanges: number;  // missing inverse
  steps: RollbackStep[];
  warnings: string[];             // no-inverse, --since filter notes, etc.
}

export interface RollbackStep {
  originalChangeId: string;
  originalDescription: string;
  inverseDescription: string;
  inverseCommand?: string;
  originalExecutedAt: string;     // ISO-8601 from original ChangeEntry
}

export interface PlanRollbackOpts {
  since?: string;       // changeId — include changes EXECUTED AFTER this id
}

export interface ExecuteRollbackOpts {
  config?: RiskyActionConfig;       // pipeline config — passes to executeAction
  executor?: ExecutorSeam;           // injected for tests
  writeWarn?: (msg: string) => void; // stderr writer (default: process.stderr.write)
  now?: () => Date;                  // injected clock
}

export interface RollbackExecutionEntry {
  timestamp: string;                                    // ISO-8601
  originalChangeId: string;
  inverseDescription: string;
  status: "rolled-back" | "rolled-back-failed";
  durationMs: number;
  errorMessage?: string;
}

export interface RollbackResult {
  attempted: number;
  succeeded: number;
  failed: number;                  // 0 or 1 (sequence halts on first failure)
  remaining: RollbackStep[];       // present when failed === 1; for escalation
  escalated: boolean;
}

export async function planRollback(
  projectRoot: string,
  incidentId: IncidentId,
  opts?: PlanRollbackOpts,
): Promise<RollbackPlan>;

export async function executeRollback(
  projectRoot: string,
  incidentId: IncidentId,
  plan: RollbackPlan,
  opts?: ExecuteRollbackOpts,
): Promise<RollbackResult>;

export function presentPlan(plan: RollbackPlan): string;
```

---

### `src/cli/commands/rollback.ts` (create)

**Directory pattern:** All commands in `src/cli/commands/` follow the `registerXxxCommand(program: Command): void` pattern (see `approve.ts`, `audit-show.ts`, `list-approvals.ts`).

**Most similar existing file:** `src/cli/commands/approve.ts` — single-arg + options, calls into a library, exits with `process.exitCode = 1` on error. Use it as the structural template.

---

### `src/cli/index.ts` (modify)

**Relevant section — lines 24-27 (imports) and 244-254 (registration block):**

```typescript
// Add to imports (line ~28):
import { registerRollbackCommand } from "./commands/rollback.js";

// Add to registration block (line ~255, after registerAuditCommand):
// ── rollback ───────────────────────────────────────────────────
registerRollbackCommand(program);
```

That is the **entire** modification to `src/cli/index.ts`.

---

### `tests/incident/rollback.test.ts` (create)

**Directory pattern:** Tests at `tests/incident/` use vitest + mkdtemp temp directories + readJsonl helper. Pattern is identical to `tests/incident/timeline.test.ts` and `tests/orchestrator/deployer.test.ts`.

---

## 2. Patterns to Follow

### Pattern 1 — Append helper using existing `appendChange`
**Source:** `src/orchestrator/deploy/execute.ts`, lines 145-187

```typescript
const startedAt = now().toISOString();
const pendingEntry: ChangeEntry = {
  id: action.id,
  type: isRisky ? "risky-action" : "safe-action",
  executedAt: startedAt,
  description: action.description,
  inverse: action.inverse,
  status: "pending",
};
await appendChange(projectRoot, incidentId, pendingEntry);
// ... execute ...
const finalEntry: ChangeEntry = { ...pendingEntry, executedAt: now().toISOString(), status: finalStatus };
await appendChange(projectRoot, incidentId, finalEntry);
```

**Rule:** Sprint 21 follows the same pattern — to mark an original ChangeEntry as `rolled-back`, **append a NEW ChangeEntry line** with the same `id` and `status='rolled-back'`. JSONL is append-only; "the latest entry per id wins" is how Sprint 20 already operates.

### Pattern 2 — Atomic JSONL append (mode 0600)
**Source:** `src/incident/timeline.ts`, lines 63-78

```typescript
async function appendOneLine(filePath: string, record: unknown): Promise<void> {
  const dir = join(filePath, "..");
  await mkdir(dir, { recursive: true });
  const line = JSON.stringify(record) + "\n";
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT;
  const fh = await open(filePath, flags, 0o600);
  try {
    await fh.chmod(0o600);
    await fh.write(line);
  } finally {
    await fh.close();
  }
}
```

**Rule:** Use this exact pattern for `rollback-execution.jsonl`. Do NOT use `fs.appendFile`. Reproduce the helper locally inside `rollback.ts` OR (preferred) export `appendOneLine` from timeline.ts as a small refactor — but if you refactor, keep the change minimal and update the existing tests if any assertions break. **Recommendation: inline a private `appendOneLine` in rollback.ts to avoid touching Sprint 19 code.**

### Pattern 3 — Read JSONL file (per `tests/incident/timeline.test.ts:50-56`)

```typescript
async function readJsonl<T>(filePath: string): Promise<T[]> {
  const raw = await readFile(filePath, "utf-8");
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
}
```

Used in `tests/orchestrator/deployer.test.ts:37-47` with try/catch fallback to `[]` on missing file. **Use this in both rollback.ts (private helper) and the tests.**

### Pattern 4 — CLI command registration (commander)
**Source:** `src/cli/commands/approve.ts`, lines 33-83

```typescript
export function registerApproveCommand(program: Command): void {
  program
    .command("approve <checkpointId>")
    .description("...")
    .option("--edit <path>", "...")
    .action(async (checkpointId: string, opts: { edit?: string }) => {
      const projectRoot = await resolveRoot();
      // ... guards ...
      if (!exists) {
        process.stderr.write(chalk.red(`No pending checkpoint found: ${checkpointId}\n`));
        process.exitCode = 1;
        return;
      }
      // ... do the work ...
      process.stdout.write(chalk.green(`Approved checkpoint: ${checkpointId}\n`));
    });
}
```

**Rule:** Follow this signature exactly. Use `findProjectRoot()` from `src/utils/fs.ts` via a local `resolveRoot()` helper. On error: write red message to stderr, set `process.exitCode = 1`, `return` (do NOT `process.exit`).

### Pattern 5 — Interactive prompt via `prompts` package
**Source:** `src/cli/commands/init.ts`, line 4 + 99-119

```typescript
import prompts from "prompts";

const { confirm } = await prompts({
  type: "confirm",
  name: "confirm",
  message: "Proceed with rollback? Each step still requires individual approval.",
  initial: false,
});
if (!confirm) {
  process.stdout.write(chalk.yellow("Rollback cancelled.\n"));
  return;
}
```

**Rule:** Use `prompts` (already a dependency — `package.json` line 67) for the y/N confirmation. Do NOT add a new `readline` dependency.

### Pattern 6 — Sprint 20 gate invocation per step
**Source:** `src/orchestrator/deploy/execute.ts`, lines 98-143

The gate is invoked **inside** `executeAction()`. Sprint 21 does NOT re-implement the gate — it calls `executeAction()` once per rollback step. Each call goes through the full gate sequence (classify → log action → checkpoint → ChangeEntry pending → execute → ChangeEntry terminal).

**Rule:** `executeRollback` constructs ONE `ProposedAction` per rollback step and calls `executeAction` per step. The gate count == step count automatically.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `appendChange` | `src/incident/timeline.ts:306` | `(projectRoot, incidentId, ChangeEntry) → Promise<void>` | Append ChangeEntry + timeline event under mutex. Use this to write `rolled-back` / `rolled-back-failed` status updates. |
| `appendTimeline` | `src/incident/timeline.ts:210` | `(projectRoot, incidentId, TimelineEvent) → Promise<void>` | Append a freestanding timeline event (e.g., `rollback_started`, `rollback_halted`). |
| `executeAction` | `src/orchestrator/deploy/execute.ts:58` | `(action, incidentId, projectRoot, config, deps) → Promise<ExecuteActionResult>` | The Sprint 20 gated executor. Call once per rollback step. |
| `findProjectRoot` | `src/utils/fs.ts:58` | `(startDir?) → Promise<string \| null>` | Walks upward looking for `bober.config.json`/`package.json`. Use in CLI command. |
| `fileExists` | `src/utils/fs.ts:10` | `(path) → Promise<boolean>` | Async existence check. |
| `readJson` / `writeJson` | `src/utils/fs.ts:24,34` | — | For `incident.json` style files (not changelog). |
| `prompts` | `node_modules` (in `package.json:67`) | — | Interactive prompts. Use `{ type: 'confirm', ... }` for y/N. |
| `chalk` | `node_modules` | — | Colored CLI output: red for errors, yellow for warnings, green for success, cyan for headers. |
| `ChangeEntrySchema` / `ChangeEntry` | `src/incident/types.ts:78` | zod schema + inferred type | Source of truth for changelog entries. **MUST be extended to add `rolled-back-failed`.** |
| `ProposedActionSchema` / `ProposedAction` | `src/orchestrator/deploy/types.ts:13` | zod schema + inferred type | Shape passed to `executeAction`. Sprint 21 constructs these from rollback steps. |
| `RiskyActionConfig` | `src/orchestrator/deploy/resolve.ts:29` | interface | Config passed through to executeAction. |
| `resolveRiskyActionMechanismName` | `src/orchestrator/deploy/resolve.ts:52` | `(config, isRisky, actionId) → string` | Pure name resolver. Not called directly by Sprint 21 — executeAction handles it. |
| `formatAge` | `src/cli/commands/list-approvals.ts:27` | `(ms) → string` | "2h 15m" formatter. Useful if you display executedAt ages. |

---

## 4. Prior Sprint Output

### Sprint 19 — Incident artifacts
**Created:** `src/incident/timeline.ts` exports `appendChange`, `appendTimeline`, `createIncident`, `listIncidents`. Also `src/incident/types.ts` with `ChangeEntrySchema` (status enum: `pending|executed|rolled-back|failed`).
**Connection:** Sprint 21 READS `changelog.jsonl` (the file created/appended by Sprint 19 helpers). Sprint 21 ALSO writes back via `appendChange` to record `rolled-back`/`rolled-back-failed` status entries. **Sprint 21 must extend ChangeEntry status enum to add `rolled-back-failed`.**

### Sprint 20 — Deployer + gates
**Created:** `src/orchestrator/deploy/execute.ts` (`executeAction`), `src/orchestrator/deploy/resolve.ts` (`resolveRiskyActionMechanismName`, forces 'disk' floor for risky+!allow+noop), `src/orchestrator/deploy/types.ts` (`ProposedAction`, `ExecutorSeam`).
**Connection:** Sprint 21's `executeRollback` constructs a `ProposedAction` per rollback step and calls `executeAction` to gate it. Each rollback step is, by definition, a risky action — so the Sprint 20 floor applies.

### Sprint 9 — CLI approve
**Created:** `src/cli/commands/approve.ts` with `registerApproveCommand(program)` pattern.
**Connection:** Use it as the structural template for `registerRollbackCommand(program)`. Same approach to `process.exitCode`, `findProjectRoot`, stderr/stdout writes.

### Sprint 14 — CLI flags
**Wired:** `src/cli/index.ts:182-218` shows how `run` registers `--mode --checkpoint --checkpoint-all`. Sprint 21's flag plumbing (`--since`, `--dry-run`, `--json`) follows the same `.option()` pattern.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` file. Project conventions are inferred from:
- `CLAUDE.md` files (user-level only, see `/Users/bober4ik/CLAUDE.md`)
- Briefings in `.bober/briefings/sprint-spec-20260524-bober-vision-*-briefing.md` (consult Sprint 19 and 20 briefings for vocabulary)
- Existing code patterns

### Architecture Decisions
No `.bober/architecture/` directory. Decisions are documented inline as file headers (see `src/incident/timeline.ts:1-23` and `src/orchestrator/deploy/execute.ts:1-18`).

### Tier 3 conventions in scope for Sprint 21
- Append-only JSONL semantics: latest entry per id wins (Sprint 20 implicitly relies on this).
- Mode 0600 on all incident artifact files.
- ISO-8601 timestamps with `new Date().toISOString()`.
- Per-incidentId promise-chain mutex serializes writes.
- inverse field on ChangeEntry is **required** at zod level (Sprint 19, see `types.ts:75-89`).
- Risky actions ALWAYS go through the gate; `allowAutopilotRiskyActions=true` auto-approves but still writes audit.

---

## 6. Testing Patterns

### Unit Test Pattern
**Source:** `tests/orchestrator/deployer.test.ts` (the structural twin for Sprint 21 tests)

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-rollback-test-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

async function readJsonl<T>(filePath: string): Promise<T[]> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
  } catch { return []; }
}
```

**Runner:** vitest
**Assertion style:** `expect(...).toBe(...)`, `.toBeTruthy()`, `.toMatch(/regex/)`, `.rejects.toThrow(/.../)`
**Mock approach:** Inject `ExecutorSeam` via deps bag (`{ executor: { async run() { ... } } }`) — see deployer.test.ts:97-101
**File naming:** `<module>.test.ts`
**Location:** `tests/incident/rollback.test.ts` (per contract expectedChanges)

### Counting gate invocations (CRITICAL per evaluatorNotes)

A test must invoke the gate **N times for N rollback steps**. The simplest counter is on the injected executor:

```typescript
let executorCalls = 0;
const executor: ExecutorSeam = {
  async run() {
    executorCalls += 1;
    return { exitCode: 0, stdout: "", stderr: "" };
  },
};
// ... run executeRollback over a 3-step plan ...
expect(executorCalls).toBe(3);
```

**However**, executor calls ≠ gate calls. The gate is invoked by `executeAction` BEFORE the executor. To verify gate invocation per step, **either**:
1. Configure `allowAutopilotRiskyActions: true` and assert that **N warning messages** are written to `writeWarn`, OR
2. Read `actions.jsonl` and assert N entries with `requiresApproval: true`, OR
3. Use a mock CheckpointMechanism — but Sprint 20's executeAction does not accept a mechanism injection, so the cleanest path is #1 or #2.

**Recommended test approach for s21-c2:**
```typescript
const warnings: string[] = [];
await executeRollback(tmpDir, incidentId, plan, {
  config: { pipeline: { allowAutopilotRiskyActions: true } },
  executor,
  writeWarn: (m) => warnings.push(m),
});
expect(warnings.filter(w => w.includes("auto-approved risky action")).length).toBe(plan.steps.length);
```

### Halt-on-failure pattern (s21-c5)

```typescript
let callCount = 0;
const executor: ExecutorSeam = {
  async run() {
    callCount += 1;
    if (callCount === 3) return { exitCode: 1, stdout: "", stderr: "rollback step 3 broke" };
    return { exitCode: 0, stdout: "", stderr: "" };
  },
};
// 5-step plan
const result = await executeRollback(tmpDir, incidentId, plan, { config: { pipeline: { allowAutopilotRiskyActions: true } }, executor });

expect(callCount).toBe(3);                          // steps 4,5 NEVER executed
expect(result.failed).toBe(1);
expect(result.remaining.length).toBe(2);            // steps 4 and 5
expect(result.escalated).toBe(true);

const changelog = await readJsonl<ChangeEntry>(changelogPath);
// originals at indices 0,1 (reversed: rolled back first) have 'rolled-back' entries; original at index 2 has 'rolled-back-failed'
// originals at indices 3,4 still effective-status 'executed' (no rollback entries written)
const effective = computeEffectiveStatus(changelog);
expect(effective.get("step-3")).toBe("rolled-back-failed");
expect(effective.get("step-4")).toBe("executed");
expect(effective.get("step-5")).toBe("executed");
```

### Dry-run pattern (s21-c4)

```typescript
let executorCalls = 0;
const executor: ExecutorSeam = { async run() { executorCalls += 1; return { exitCode: 0, stdout: "", stderr: "" }; } };
// Critical: --dry-run should NOT call executeRollback at all.
// The CLI command short-circuits AFTER planRollback + presentPlan.
// But if executeRollback is called with a dry-run flag, test that ZERO ChangeEntries are written.
const beforeLines = (await readJsonl<ChangeEntry>(changelogPath)).length;
// In dry-run, the CLI presents the plan and returns; do not call executeRollback at all.
const afterLines = (await readJsonl<ChangeEntry>(changelogPath)).length;
expect(afterLines).toBe(beforeLines);
expect(executorCalls).toBe(0);
```

**Design choice:** `--dry-run` is implemented in the **CLI layer**, not in `executeRollback`. The CLI calls planRollback + presentPlan and STOPS. executeRollback has no dry-run mode. This keeps the library function pure.

### E2E Test Pattern
No Playwright in this project (CLI tool). Use vitest integration tests under `tests/incident/` only.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break

| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/orchestrator/deploy/execute.ts` | `ChangeEntry.status` enum | LOW | Writes only `pending`/`executed`/`failed`. Adding new variant `rolled-back-failed` is purely additive — no exhaustiveness checks rely on the old set. |
| `src/incident/timeline.ts` (`appendChange`) | `ChangeEntrySchema` | LOW | `ChangeEntrySchema.parse(entry)` will accept the new variant. No code path needs updating. |
| `tests/incident/timeline.test.ts` | `ChangeEntry` type | LOW | Uses fixtures with `status: "executed"`. New variant doesn't affect existing tests. |
| `tests/orchestrator/deployer.test.ts` | `ChangeEntrySchema` | LOW | Same — assertions don't check the enum's full set. |
| `src/cli/index.ts` | new `registerRollbackCommand` | LOW | Only adds one import + one registration call. |

### Existing Tests That Must Still Pass

- `tests/incident/timeline.test.ts` — Sprint 19 incident artifact tests. Verifies `appendChange` writes mode 0600 lines with required `inverse`. Sprint 21 calls `appendChange` so this MUST keep working.
- `tests/orchestrator/deployer.test.ts` — Sprint 20 gate tests. Sprint 21's executeRollback calls `executeAction` so these must remain green.
- `tests/orchestrator/gating.test.ts` — Sprint 14 mode-based mechanism resolution. Risky-action floor depends on this.
- `tests/incident/rollback.test.ts` (new) — Sprint 21's own tests.
- `src/cli/commands/approve.test.ts`, `src/cli/commands/list-approvals.test.ts`, `src/cli/commands/audit-show.test.ts` — CLI registration patterns. Sprint 21 follows the same pattern; ensure new subcommand registration doesn't clash with existing names.

### Features That Could Be Affected

- **Sprint 22 (postmortem generation)** — likely reads `changelog.jsonl` and `rollback-execution.jsonl`. The schemas defined here become Sprint 22's contract. Be precise about shapes.
- **Sprint 24 (full /bober-incident flow)** — orchestrates diagnoser → deployer → rollback. The rollback CLI command must be invokable from the orchestrator (so make the lib functions, not just the CLI, the public surface).

### Recommended Regression Checks

After implementation, the Generator MUST run:

1. `npm run typecheck` — strict mode, exit 0
2. `npm run lint` — exit 0
3. `npm test` — all tests pass; verify `tests/incident/rollback.test.ts` runs
4. `npm run build` — exit 0
5. **Manual smoke (optional):** create an incident with `createIncident` programmatically, append 3 ChangeEntries with `status='executed'`, run `node dist/cli/index.js rollback <incidentId> --dry-run` and verify the plan presentation contains the 3 inverses in reverse order with no side effects on changelog.jsonl.

---

## 8. Implementation Sequence

1. **`src/incident/types.ts`** — Extend `ChangeEntrySchema.status` enum to add `'rolled-back-failed'`.
   - Verify: `npm run typecheck` passes; existing tests still pass.

2. **`src/incident/rollback.ts`** — Create the file with:
   - Imports: `ChangeEntry`, `ChangeEntrySchema` from `./types.js`; `appendChange`, `appendTimeline` from `./timeline.js`; `executeAction`, `ProposedAction`, `ExecutorSeam` from `../orchestrator/deploy/...`; `RiskyActionConfig` from `../orchestrator/deploy/resolve.js`; node:fs/promises, node:path, chalk.
   - Private helpers:
     - `readChangelog(projectRoot, incidentId): Promise<ChangeEntry[]>` — returns all lines (preserving order).
     - `computeEffectiveStatus(entries: ChangeEntry[]): Map<string, ChangeEntry>` — group by `entry.id`, return latest entry per id (preserving the *first executedAt for the original `executed` entry* if needed for ordering).
     - `appendRollbackExecution(projectRoot, incidentId, entry: RollbackExecutionEntry): Promise<void>` — uses `appendOneLine` style, file path is `<dir>/rollback-execution.jsonl`.
   - Public exports: `planRollback`, `executeRollback`, `presentPlan`, all interfaces from §1 above.
   - Verify: `npm run typecheck` passes; can be imported.

3. **`tests/incident/rollback.test.ts`** — Write tests covering:
   - planRollback: 3-executed entries → 3-step plan in reverse order.
   - planRollback: excludes entries with effective status `rolled-back`/`rolled-back-failed`.
   - planRollback: surfaces no-inverse entries in `warnings` (synthesize a degenerate ChangeEntry directly into changelog.jsonl bypassing the schema — write raw JSON line).
   - planRollback `--since` with a valid changeId → only newer changes included.
   - planRollback `--since` with non-existent changeId → throws clear error.
   - executeRollback: 3-step plan + auto-approve mode → 3 executor calls + 3 stderr warnings + 3 `rolled-back` ChangeEntries appended.
   - executeRollback halts on step-3 failure (5-step plan) → callCount=3; remaining=[step4,step5]; effective status checks; `rolled-back-failed` recorded.
   - rollback-execution.jsonl shape sanity (timestamps, durations, status).
   - Verify: `npm test -- tests/incident/rollback.test.ts` passes.

4. **`src/cli/commands/rollback.ts`** — Create the CLI command with `registerRollbackCommand(program)`.
   - Args: `<incidentId>`.
   - Options: `--since <changeId>`, `--dry-run`, `--json` (json prints plan as JSON instead of human-readable presentation).
   - Flow: resolveRoot → planRollback → presentPlan to stdout (or JSON if `--json`) → if `--dry-run` STOP → prompts confirm "Proceed? (y/N)" → executeRollback → print summary.
   - On any thrown error: red message to stderr, `process.exitCode = 1`.
   - Verify: `node dist/cli/index.js rollback --help` shows the command.

5. **`src/cli/index.ts`** — Add `import { registerRollbackCommand } from "./commands/rollback.js"` and `registerRollbackCommand(program);` in the registration block.
   - Verify: `npm run build` passes; `agent-bober rollback --help` runs.

6. **Run full verification** — `npm run typecheck && npm run lint && npm test && npm run build`.

---

## 9. Pitfalls & Warnings

- **Status enum extension is critical.** The current enum (`types.ts:88`) does NOT include `rolled-back-failed`. If you forget to extend it, `appendChange` will throw a ZodError when you try to write the failure status. Do this step FIRST.

- **JSONL is append-only with "latest wins" semantics.** When Sprint 20 writes pending→executed for a single action, there are TWO lines in changelog.jsonl with the same `id`. Sprint 21 sees TWO lines but must treat the action as effective-status `executed`. After Sprint 21 writes `rolled-back`, there are THREE lines — effective-status is `rolled-back`. Always group by id, take the latest.

- **Latest = last-write-wins.** "Latest" means the LAST line in file order, NOT the maximum `executedAt`. Use file order because Sprint 20's mutex guarantees write order, and clock skew is possible.

- **Reverse execution order = reverse FIRST-occurrence order.** When grouping by id, sort steps by the executedAt of the FIRST entry per id (which is when the action originally executed — `status='pending'` or the first `executed`). Then reverse. Pseudocode:

```typescript
function planSteps(entries: ChangeEntry[]): RollbackStep[] {
  // Group by id, keep BOTH first (for original time) and last (for effective status).
  const byId = new Map<string, { first: ChangeEntry; last: ChangeEntry }>();
  for (const e of entries) {
    const existing = byId.get(e.id);
    if (existing) existing.last = e;
    else byId.set(e.id, { first: e, last: e });
  }
  // Filter to effective-status 'executed' only.
  const executed = [...byId.values()].filter(({ last }) => last.status === "executed");
  // Sort ascending by ORIGINAL executedAt (first.executedAt), then reverse.
  executed.sort((a, b) => a.first.executedAt < b.first.executedAt ? -1 : 1);
  executed.reverse();
  return executed.map(({ first, last }) => ({
    originalChangeId: first.id,
    originalDescription: first.description,
    inverseDescription: first.inverse.description,
    inverseCommand: first.inverse.command,
    originalExecutedAt: first.executedAt,
  }));
}
```

- **`--since <changeId>` is changeId-based, NOT timestamp-based.** Pick changeId for two reasons: (1) Sprint 20 emits monotonically-ordered ids; (2) timestamps can collide. Implementation: scan grouped entries, find the entry with `id === since`, return all entries whose `first.executedAt` is strictly greater. If no entry matches → throw `Error: --since changeId "<id>" not found in changelog`.

- **`--dry-run` lives in the CLI, not the library.** executeRollback has no dry-run flag. The CLI's `--dry-run` path: `planRollback → presentPlan → return`. Tests for dry-run go through the CLI command (or assert the absence of writes when the CLI returns early). **The simpler test:** call planRollback and presentPlan directly and assert no `appendChange` happened by reading changelog.jsonl before/after.

- **Constructing ProposedAction for a rollback step is subtle.** Sprint 20's executeAction REQUIRES inverse.description. The "inverse of an inverse" semantically is the original action. So:

```typescript
const rollbackProposed: ProposedAction = {
  id: `rollback-${step.originalChangeId}`,                       // distinct id to avoid colliding with original
  description: step.inverseDescription,
  classification: "risky" as const,                              // rollbacks are ALWAYS risky
  reasoning: `Rolling back change ${step.originalChangeId}: ${step.originalDescription}`,
  command: step.inverseCommand,                                  // may be undefined for metadata-only inverses
  inverse: {                                                     // the inverse-of-inverse is to re-run the original
    description: `Re-apply original change: ${step.originalDescription}`,
    command: undefined,                                          // we don't have the original command stored
  },
};
```

Note: Sprint 19's ChangeEntry stores `description` and `inverse` but NOT the original `command`. So the inverse-of-inverse cannot reconstruct the original command exactly. Use a descriptor string — Sprint 20's schema only requires `inverse.description` to be non-empty.

- **No-inverse defensive path.** Although Sprint 19's schema makes inverse REQUIRED, the contract (s21-c6) says "be defensive." Defensive == when reading changelog.jsonl, also surface entries where `inverse.description` is missing or empty — push into `warnings[]` and skip from `steps[]`. The warning must appear in (a) the plan presentation, (b) the audit log via `appendTimeline` (eventKind `'rollback_warning_unrollbackable'`), and (c) stderr via writeWarn.

- **Each rollback step writes a `rolled-back` ChangeEntry with the ORIGINAL `id`.** Do NOT use a new id. The rollback marks the original action — that's how "effective status" computation finds it.

```typescript
// After successful inverse execution:
await appendChange(projectRoot, incidentId, {
  id: step.originalChangeId,                          // SAME id as original
  type: "rollback",                                   // distinct type tag
  executedAt: now().toISOString(),
  description: `Rolled back: ${step.originalDescription}`,
  inverse: { description: `Re-apply: ${step.originalDescription}` },  // satisfies schema
  status: "rolled-back",
});
```

- **`rollback-execution.jsonl` is SEPARATE from `changelog.jsonl`.** Per contract s21-c3, write outcomes there. Shape:

```typescript
interface RollbackExecutionEntry {
  timestamp: string;
  originalChangeId: string;
  inverseDescription: string;
  status: "rolled-back" | "rolled-back-failed";
  durationMs: number;
  errorMessage?: string;
}
```

This file is initialized lazily (it does NOT exist after `createIncident` — Sprint 19's `createIncident` creates only 5 jsonl files). Your `appendOneLine` will mkdir + create with mode 0600 on first write.

- **Plan presentation must always show** even in autopilot mode (per s21-c3). The CLI does NOT skip presentation based on config. Confirmation is also unconditional unless `--dry-run` (in which case STOP after presentation, no confirm). This is intentional: rollback is destructive; user always sees the plan and explicitly says yes.

- **`process.exit` is forbidden.** Use `process.exitCode = 1; return;` per the approve.ts pattern. This lets vitest/test runners observe exit codes without killing the process.

- **Path aliases.** Imports use `.js` extensions (NodeNext ESM). Never write `from "./types"` — always `from "./types.js"`. See every existing file.

- **`appendTimeline` for "rollback started/completed/halted" events.** Recommend three events:
  - `rollback_started` — at the top of executeRollback, summary lists step count.
  - `rollback_step_succeeded` — per successful step (could also rely on the existing `change_recorded` events triggered by appendChange — either way is acceptable, but explicit `rollback_*` events make the timeline narrative clearer).
  - `rollback_halted` — on first failure, summary includes remaining step count and originalChangeIds.
  - `rollback_completed` — on full success.

- **Escalation = `rollback_halted` timeline event + write warning to stderr + populate `result.escalated=true` and `result.remaining=[...]`.** The contract says "escalate via checkpoint" — but Sprint 21 does NOT have a dedicated escalation checkpoint mechanism. The minimal viable escalation is the timeline event + stderr warning + the return value. A future sprint may convert this to a real checkpoint. Document the choice in the file header.

---

## 10. Paste-Ready Snippets

### `planRollback` skeleton

```typescript
export async function planRollback(
  projectRoot: string,
  incidentId: IncidentId,
  opts: PlanRollbackOpts = {},
): Promise<RollbackPlan> {
  const entries = await readChangelog(projectRoot, incidentId);
  const warnings: string[] = [];

  // Group by id; track first entry (for original time + inverse) and last entry (for status).
  const byId = new Map<string, { first: ChangeEntry; last: ChangeEntry }>();
  for (const e of entries) {
    const existing = byId.get(e.id);
    if (existing) existing.last = e;
    else byId.set(e.id, { first: e, last: e });
  }

  let unrollbackable = 0;
  const candidates: Array<{ first: ChangeEntry; last: ChangeEntry }> = [];

  for (const group of byId.values()) {
    // Defensive: missing or empty inverse.description → warn, skip.
    if (!group.first.inverse?.description || group.first.inverse.description.trim() === "") {
      unrollbackable += 1;
      warnings.push(
        `Change "${group.first.description}" (${group.first.id}) has no recorded inverse; skipped.`,
      );
      continue;
    }
    // Effective status filter.
    if (group.last.status === "executed") {
      candidates.push(group);
    }
  }

  // --since filter (changeId-based, strict-after semantics).
  let filtered = candidates;
  if (opts.since !== undefined) {
    const pivot = byId.get(opts.since);
    if (!pivot) {
      throw new Error(`--since changeId "${opts.since}" not found in changelog`);
    }
    const pivotTime = pivot.first.executedAt;
    filtered = candidates.filter((c) => c.first.executedAt > pivotTime);
    warnings.push(`--since filter applied: showing ${filtered.length} of ${candidates.length} rollbackable changes.`);
  }

  // Reverse execution order: sort ascending by original executedAt, then reverse.
  filtered.sort((a, b) => (a.first.executedAt < b.first.executedAt ? -1 : 1));
  filtered.reverse();

  const steps: RollbackStep[] = filtered.map(({ first }) => ({
    originalChangeId: first.id,
    originalDescription: first.description,
    inverseDescription: first.inverse.description,
    ...(first.inverse.command !== undefined ? { inverseCommand: first.inverse.command } : {}),
    originalExecutedAt: first.executedAt,
  }));

  return {
    incidentId,
    totalChanges: byId.size,
    rollbackableChanges: steps.length,
    unrollbackableChanges: unrollbackable,
    steps,
    warnings,
  };
}
```

### `executeRollback` skeleton

```typescript
export async function executeRollback(
  projectRoot: string,
  incidentId: IncidentId,
  plan: RollbackPlan,
  opts: ExecuteRollbackOpts = {},
): Promise<RollbackResult> {
  const now = opts.now ?? (() => new Date());
  const writeWarn = opts.writeWarn ?? ((m: string) => process.stderr.write(m));

  await appendTimeline(projectRoot, incidentId, {
    timestamp: now().toISOString(),
    eventKind: "rollback_started",
    source: "deployer",
    summary: `Rollback started: ${plan.steps.length} steps planned`,
  });

  let succeeded = 0;

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const proposed: ProposedAction = {
      id: `rollback-${step.originalChangeId}`,
      description: step.inverseDescription,
      classification: "risky",
      reasoning: `Rolling back change ${step.originalChangeId}: ${step.originalDescription}`,
      ...(step.inverseCommand !== undefined ? { command: step.inverseCommand } : {}),
      inverse: {
        description: `Re-apply original change: ${step.originalDescription}`,
      },
    };

    const stepStart = Date.now();
    const result = await executeAction(
      proposed,
      incidentId,
      projectRoot,
      opts.config,
      { executor: opts.executor, writeWarn, now },
    );
    const durationMs = Date.now() - stepStart;

    if (result.status === "executed") {
      // Mark the ORIGINAL ChangeEntry as rolled-back.
      await appendChange(projectRoot, incidentId, {
        id: step.originalChangeId,
        type: "rollback",
        executedAt: now().toISOString(),
        description: `Rolled back: ${step.originalDescription}`,
        inverse: { description: `Re-apply: ${step.originalDescription}` },
        status: "rolled-back",
      });
      await appendRollbackExecution(projectRoot, incidentId, {
        timestamp: now().toISOString(),
        originalChangeId: step.originalChangeId,
        inverseDescription: step.inverseDescription,
        status: "rolled-back",
        durationMs,
      });
      succeeded += 1;
    } else {
      // Failed (or aborted). Halt sequence. Mark original 'rolled-back-failed'. Escalate.
      const errMsg = result.error ?? `rollback step aborted: ${result.reason ?? "unknown"}`;
      await appendChange(projectRoot, incidentId, {
        id: step.originalChangeId,
        type: "rollback-failed",
        executedAt: now().toISOString(),
        description: `Rollback FAILED for: ${step.originalDescription}`,
        inverse: { description: `Re-apply: ${step.originalDescription}` },
        status: "rolled-back-failed",
      });
      await appendRollbackExecution(projectRoot, incidentId, {
        timestamp: now().toISOString(),
        originalChangeId: step.originalChangeId,
        inverseDescription: step.inverseDescription,
        status: "rolled-back-failed",
        durationMs,
        errorMessage: errMsg,
      });

      const remaining = plan.steps.slice(i + 1);
      await appendTimeline(projectRoot, incidentId, {
        timestamp: now().toISOString(),
        eventKind: "rollback_halted",
        source: "deployer",
        summary: `Rollback HALTED at step ${i + 1}/${plan.steps.length}: ${errMsg}. Remaining: ${remaining.map(s => s.originalChangeId).join(", ")}`,
      });
      writeWarn(
        `[bober rollback] HALTED — step ${i + 1} (${step.originalChangeId}) failed: ${errMsg}. ` +
        `${remaining.length} step(s) NOT rolled back: ${remaining.map(s => s.originalChangeId).join(", ")}\n`,
      );

      return {
        attempted: i + 1,
        succeeded,
        failed: 1,
        remaining,
        escalated: true,
      };
    }
  }

  await appendTimeline(projectRoot, incidentId, {
    timestamp: now().toISOString(),
    eventKind: "rollback_completed",
    source: "deployer",
    summary: `Rollback completed: ${succeeded}/${plan.steps.length} steps`,
  });

  return { attempted: plan.steps.length, succeeded, failed: 0, remaining: [], escalated: false };
}
```

### `presentPlan` skeleton

```typescript
export function presentPlan(plan: RollbackPlan): string {
  const lines: string[] = [];
  lines.push(`Rollback plan for incident ${plan.incidentId}:`);
  lines.push("");
  lines.push(`Total changes: ${plan.totalChanges}`);
  lines.push(`Rollbackable: ${plan.rollbackableChanges}`);
  lines.push(`Unrollbackable: ${plan.unrollbackableChanges}${plan.unrollbackableChanges > 0 ? " (see warnings)" : ""}`);
  lines.push("");

  if (plan.steps.length === 0) {
    lines.push("(no rollbackable steps)");
  } else {
    lines.push("Proposed steps (in reverse execution order):");
    plan.steps.forEach((s, idx) => {
      lines.push(`  ${idx + 1}. Undo "${s.originalDescription}"`);
      lines.push(`     → ${s.inverseDescription}`);
      if (s.inverseCommand) lines.push(`     $ ${s.inverseCommand}`);
    });
  }

  if (plan.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const w of plan.warnings) lines.push(`  - ${w}`);
  }

  lines.push("");
  return lines.join("\n");
}
```

### CLI command skeleton (`src/cli/commands/rollback.ts`)

```typescript
import prompts from "prompts";
import chalk from "chalk";
import type { Command } from "commander";

import { findProjectRoot } from "../../utils/fs.js";
import { planRollback, executeRollback, presentPlan } from "../../incident/rollback.js";

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

export function registerRollbackCommand(program: Command): void {
  program
    .command("rollback <incidentId>")
    .description("Roll back executed changes for an incident — each step gated as a risky action")
    .option("--since <changeId>", "Roll back only changes executed after this changeId")
    .option("--dry-run", "Print the plan without executing anything")
    .option("--json", "Emit plan as JSON instead of a human-readable table")
    .action(async (incidentId: string, opts: { since?: string; dryRun?: boolean; json?: boolean }) => {
      const projectRoot = await resolveRoot();

      let plan;
      try {
        plan = await planRollback(projectRoot, incidentId, opts.since !== undefined ? { since: opts.since } : {});
      } catch (err) {
        process.stderr.write(chalk.red(`Failed to plan rollback: ${err instanceof Error ? err.message : String(err)}\n`));
        process.exitCode = 1;
        return;
      }

      if (opts.json) {
        process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
      } else {
        process.stdout.write(presentPlan(plan));
        // Surface unrollbackable warnings on stderr too (loud).
        for (const w of plan.warnings) process.stderr.write(chalk.yellow(`WARN: ${w}\n`));
      }

      if (opts.dryRun) {
        process.stdout.write(chalk.cyan("(--dry-run) No changes executed.\n"));
        return;
      }

      if (plan.steps.length === 0) {
        process.stdout.write(chalk.yellow("No rollbackable steps. Nothing to do.\n"));
        return;
      }

      const { confirm } = await prompts({
        type: "confirm",
        name: "confirm",
        message: `Proceed with ${plan.steps.length}-step rollback? Each step still requires individual approval.`,
        initial: false,
      });
      if (!confirm) {
        process.stdout.write(chalk.yellow("Rollback cancelled.\n"));
        return;
      }

      const result = await executeRollback(projectRoot, incidentId, plan);

      if (result.failed > 0) {
        process.stderr.write(
          chalk.red(
            `Rollback HALTED. Succeeded: ${result.succeeded}/${plan.steps.length}. ` +
            `Remaining unrolled: ${result.remaining.map(s => s.originalChangeId).join(", ")}\n`,
          ),
        );
        process.exitCode = 1;
      } else {
        process.stdout.write(chalk.green(`Rollback complete: ${result.succeeded}/${plan.steps.length} steps.\n`));
      }
    });
}
```

### Test scenarios with expected counts

```typescript
describe("planRollback", () => {
  it("3 executed entries → 3-step plan in reverse order", async () => {
    const incidentId = await createIncident("test", tmpDir);
    await appendChange(tmpDir, incidentId, makeChange({ id: "c1", executedAt: "2026-05-25T01:00:00Z" }));
    await appendChange(tmpDir, incidentId, makeChange({ id: "c2", executedAt: "2026-05-25T02:00:00Z" }));
    await appendChange(tmpDir, incidentId, makeChange({ id: "c3", executedAt: "2026-05-25T03:00:00Z" }));
    const plan = await planRollback(tmpDir, incidentId);
    expect(plan.steps.map(s => s.originalChangeId)).toEqual(["c3", "c2", "c1"]);
    expect(plan.rollbackableChanges).toBe(3);
  });

  it("excludes effective-status rolled-back entries", async () => {
    // append c1 executed, then c1 rolled-back → plan must not include c1
  });

  it("--since c2 → only c3 in plan", async () => { /* ... */ });

  it("--since unknown-id throws", async () => {
    await expect(planRollback(tmpDir, incidentId, { since: "nope" })).rejects.toThrow(/--since.*not found/);
  });

  it("no-inverse entries surfaced as warnings, excluded from steps", async () => {
    // Write a raw JSONL line bypassing the schema (or use a degenerate inverse).
  });
});

describe("executeRollback", () => {
  it("3-step plan → 3 executor calls → 3 rolled-back ChangeEntries appended", async () => {
    let calls = 0;
    const executor: ExecutorSeam = { async run() { calls += 1; return { exitCode: 0, stdout: "", stderr: "" }; } };
    const warnings: string[] = [];
    const result = await executeRollback(tmpDir, incidentId, plan, {
      config: { pipeline: { allowAutopilotRiskyActions: true } },
      executor,
      writeWarn: m => warnings.push(m),
    });
    expect(calls).toBe(3);
    expect(result.succeeded).toBe(3);
    expect(warnings.filter(w => w.includes("auto-approved risky action")).length).toBe(3);
    const cl = await readJsonl<ChangeEntry>(changelogPath);
    expect(cl.filter(e => e.status === "rolled-back").length).toBe(3);
  });

  it("halts on step-3 failure: 5-step plan, callCount=3, remaining=[step4,step5]", async () => {
    let calls = 0;
    const executor: ExecutorSeam = {
      async run() {
        calls += 1;
        if (calls === 3) return { exitCode: 1, stdout: "", stderr: "boom" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const result = await executeRollback(tmpDir, incidentId, plan5, {
      config: { pipeline: { allowAutopilotRiskyActions: true } }, executor,
    });
    expect(calls).toBe(3);
    expect(result.failed).toBe(1);
    expect(result.remaining.length).toBe(2);
    expect(result.escalated).toBe(true);
  });
});

describe("--dry-run", () => {
  it("planRollback + presentPlan produce no ChangeEntry writes", async () => {
    const beforeLines = (await readJsonl<ChangeEntry>(changelogPath)).length;
    const plan = await planRollback(tmpDir, incidentId);
    const text = presentPlan(plan);
    expect(text).toContain("Rollback plan");
    const afterLines = (await readJsonl<ChangeEntry>(changelogPath)).length;
    expect(afterLines).toBe(beforeLines);
  });
});
```

### `rollback-execution.jsonl` example record

```json
{"timestamp":"2026-05-25T03:15:22.123Z","originalChangeId":"act-3","inverseDescription":"kubectl scale deployment api --replicas=3","status":"rolled-back","durationMs":1842}
{"timestamp":"2026-05-25T03:15:24.901Z","originalChangeId":"act-2","inverseDescription":"Disable new_checkout_flow via API","status":"rolled-back-failed","durationMs":3120,"errorMessage":"feature flag API returned 500"}
```

---

End of briefing.
