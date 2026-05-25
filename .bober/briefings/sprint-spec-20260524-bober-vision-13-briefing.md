# Sprint Briefing: Checkpoint approval audit trail

**Contract:** sprint-spec-20260524-bober-vision-13
**Generated:** 2026-05-25T00:00:00Z

This briefing is intentionally prescriptive about the architectural seam (wrapper vs in-mechanism try/finally) — read Section 2 BEFORE reading the rest. The mode-0600 file-open pattern in Section 9 is the highest-risk pitfall.

---

## 1. Target Files

### `src/orchestrator/checkpoints/audit.ts` (create)

**Directory pattern:** colocated in `src/orchestrator/checkpoints/` next to `noop.ts`, `registry.ts`, `feedback-router.ts`, `sites.ts`. ESM, `.js` import extensions, named exports only.

**Most similar existing file:** `src/orchestrator/checkpoints/feedback-router.ts` (header comment style, named exports, module-level state for cross-call coordination — e.g. `writeChain` mirrors `prReadyTimer`).

**Structure template (skeleton — implement, don't paste):**
```ts
/**
 * Append-only approval audit logger (Sprint 13).
 *
 * Each call to recordApproval() appends ONE JSON line to
 * .bober/audits/<runId>.jsonl. Lines never span. Concurrent appends from
 * multiple async checkpoints serialize via an in-process Promise chain.
 *
 * File is created with mode 0600 on first append; subsequent appends
 * preserve the mode (kernel does not re-chmod on O_APPEND).
 *
 * approverId resolution: chooses a strategy per mechanism name.
 *   1. PR mechanism:    GitHub user from comment/merge actor (passed in).
 *   2. CLI mechanism:   process.env.USER || process.env.USERNAME.
 *   3. disk mechanism:  `git config user.name` then env USER.
 *   4. noop mechanism:  'autopilot'.
 *   5. fallback:        'unknown'.
 */

import { open, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";

export type ApprovalOutcome = "approved" | "rejected" | "edited" | "aborted";
export type MechanismName  = "cli" | "disk" | "pr" | "noop";

export interface EditDeltaSummary {
  lineCount: number;
  firstChars: string; // first 200 chars of the after-text
}

export interface ApprovalRecord {
  timestamp: string;        // ISO-8601, set inside recordApproval if omitted
  runId: string;
  checkpointId: string;
  mechanism: MechanismName;
  outcome: ApprovalOutcome;
  approverId: string;
  iteration: number;
  feedbackText?: string;    // truncated to 500 chars
  editDeltaSummary?: EditDeltaSummary | null;
  durationMs: number;
}

export function getAuditPath(projectRoot: string, runId: string): string {
  return join(projectRoot, ".bober", "audits", `${runId}.jsonl`);
}

// One mutex per runId so unrelated runs don't serialize against each other.
const writeChains = new Map<string, Promise<void>>();

export async function recordApproval(
  projectRoot: string,
  runId: string,
  record: ApprovalRecord,
): Promise<void> { /* … */ }

export async function resolveApproverId(
  mechanism: MechanismName,
  hint?: string,
): Promise<string> { /* … */ }

export function summarizeEditDelta(editDelta: unknown): EditDeltaSummary | null { /* … */ }
export function truncateFeedback(s: string | undefined): string | undefined { /* … */ }

/**
 * Recommended seam (see Section 2 of the briefing):
 * Wrap a mechanism.request() call with audit accounting in a try/finally.
 * Used by pipeline.ts at all 9 checkpoint sites and by feedback-router's
 * runCheckpointWithFeedback.
 */
export async function runWithAudit<T extends { approved?: boolean; feedback?: string; edit?: boolean; editDelta?: unknown }>(
  opts: {
    projectRoot: string;
    runId: string;
    checkpointId: string;
    mechanism: MechanismName;
    iteration: number;
    approverHint?: string;          // GitHub user for PR mechanism, etc.
    fn: () => Promise<T>;           // wraps mechanism.request(...)
  },
): Promise<T> { /* try/finally + recordApproval */ }
```

**Imports the new file uses:**
- `node:fs/promises` — `open`, `mkdir`, `stat` (NOT `appendFile`, see Section 9)
- `node:path` — `join`
- `execa` (already a dep — see `src/utils/git.ts:1` and `src/orchestrator/checkpoints/mechanisms/pr.ts:14`)

**Test file:** `src/orchestrator/checkpoints/audit.test.ts` (does not exist — create it). NOTE: contract names `tests/orchestrator/checkpoints/audit.test.ts` but the project's HARD colocation convention (`checkpoints.test.ts:1-8`, `mechanisms/disk.test.ts:1-16`, `feedback-router.test.ts:3-9`) requires the colocated path. Document the deviation in the test header just like Sprint 12 did.

---

### `src/orchestrator/checkpoints/mechanisms/cli.ts` (modify)

**Relevant sections (lines 86-184) — the `request()` method's outer shape:**
```ts
export class CliCheckpointMechanism implements CheckpointMechanism {
  constructor(
    private readonly fallback: CheckpointMechanism = DEFAULT_NOOP,
    private readonly stdin: Readable = process.stdin as Readable,
    private readonly editor?: string,
  ) {}

  async request(checkpoint: CheckpointId, artifact: CheckpointArtifact): Promise<CheckpointOutcome> {
    if (!process.stdin.isTTY) {
      // …falls back to noop. NOTE: the fallback path returns BEFORE returning to the wrapper —
      // the noop record will be written by the wrapper if cli is wrapped at all call sites,
      // OR you may want the cli mechanism to record both. See Section 2.
      return this.fallback.request(checkpoint, artifact);
    }
    // … render summary, ask, branch into approve / reject / edit …
    // Existing finally (line 180) only does rl.close(). The audit hook is NOT here in
    // the recommended seam (B); it lives in runWithAudit at the caller.
  }
}
```

**Imports this file uses (relevant for seam decision):** none from `audit.ts` if seam (B); add an `import { recordApproval, runWithAudit } from "../audit.js"` only if you adopt seam (A).

**Imported by:** `src/orchestrator/checkpoints/registry.ts:4`, `src/orchestrator/checkpoints/mechanisms/cli.test.ts` (do not break either).

**Test file:** `src/orchestrator/checkpoints/mechanisms/cli.test.ts` (exists — keep passing).

---

### `src/orchestrator/checkpoints/mechanisms/disk.ts` (modify)

**Relevant sections (lines 49-176) — outer `request()` shape:**
```ts
export class DiskCheckpointMechanism implements CheckpointMechanism {
  constructor(
    private readonly approvalsDir: string,
    private readonly options: DiskMechanismOptions = {},
    private readonly now: () => number = () => Date.now(),
  ) {}

  async request(checkpoint: CheckpointId, artifact: CheckpointArtifact): Promise<CheckpointOutcome> {
    // … writes pending marker; polls; resolves with approved/rejected/timeout outcome …
    // Existing finally at line 170 only clears the poll timer.
    // The wrapper (seam B) records the outcome.
  }
}
```

**runId source:** `this.options.runId` (already plumbed for disk — see `disk.ts:33`). If using seam (B), pass `runId` into the wrapper from the same place the mechanism's options received it (i.e., from pipeline-level config / orchestrator state).

**Test file:** `src/orchestrator/checkpoints/mechanisms/disk.test.ts` (exists).

---

### `src/orchestrator/checkpoints/mechanisms/pr.ts` (modify)

**Relevant sections (lines 173-276) — outer `request()` and approver hint extraction:**
```ts
async request(checkpoint: CheckpointId, artifact: CheckpointArtifact): Promise<CheckpointOutcome> {
  // … gh availability check; ensure run PR; comment; pollPrUntilResolved …
  const outcome = await this.pollPrUntilResolved(prNumber, checkpoint, artifact);
  // outcome shape decided here; this is also where we can capture the GitHub username
  // (comment author / merge actor) — see parseSignals at line 484. Currently parseSignals
  // returns a PrSignal but discards the comment.user / actor login. Extending the signal
  // shape with { actor?: string } and surfacing it to the caller is the cleanest way to
  // pass the approverHint into runWithAudit.
}
```

**Where the GitHub username lives:** `view.comments[i]` from `gh pr view --json state,merged,labels,comments` (line 124). The JSON shape returned by `gh` includes `author.login` per comment — this is NOT currently parsed into PrSignal. You will need to either (a) extend `parseSignals` to emit `{ actor }` and thread it through `pollPrUntilResolved`, OR (b) re-fetch the actor when recording the audit. Recommend (a) — single round-trip.

**runId source:** `this.options.runId` (`pr.ts:150`).

**Test file:** `src/orchestrator/checkpoints/mechanisms/pr.test.ts` (exists). Tests stub `prView` and may need updating if you extend PrSignal.

---

### `src/orchestrator/checkpoints/noop.ts` (modify — required by s13-c2)

**Full current file:**
```ts
import type { CheckpointArtifact, CheckpointId, CheckpointMechanism, CheckpointOutcome } from "./types.js";

export class NoopCheckpointMechanism implements CheckpointMechanism {
  async request(_checkpoint: CheckpointId, _artifact: CheckpointArtifact): Promise<CheckpointOutcome> {
    return { approved: true };
  }
}
```

**Why this MUST also audit:** s13-c2 says "all three mechanisms" but the contract text says "every checkpoint outcome". Per the generatorNotes shape, `mechanism: "noop"` is one of the legal values and the approverId for noop is `'autopilot'`. The noop mechanism is what autopilot mode uses for every checkpoint — its audit entries are the most important for replay/compliance.

With seam (B), `noop.ts` does NOT change — the wrapper handles it. But pipeline.ts calls `getCheckpointMechanismFor(..., "noop").request(...)` directly at 9 sites (see Impact Analysis). EACH of those 9 sites must be wrapped in `runWithAudit` for s13-c2 to pass.

---

### `src/cli/commands/audit-show.ts` (create — for s13-c6)

**Directory pattern:** `src/cli/commands/` uses `kebab-case.ts` (see `list-approvals.ts`, `approve.ts`, `reject.ts`).

**Most similar existing file:** `src/cli/commands/list-approvals.ts` — table-or-JSON output, `--json` flag, ENOENT handled by returning an empty list. Replicate this shape exactly.

**Structure template:**
```ts
/**
 * `agent-bober audit show <runId> [--json]` — print the approval audit log for a run.
 *
 * Reads .bober/audits/<runId>.jsonl. Prints a human-readable table by default
 * (timestamp / checkpoint / outcome / approver / iteration / duration), or
 * machine-readable JSON via --json. Exits non-zero with a friendly message
 * if the audit log is missing (ENOENT).
 *
 * Sprint 13 — colocated CLI command per Sprint 9 precedent.
 */
import { readFile } from "node:fs/promises";
import chalk from "chalk";
import type { Command } from "commander";
import { findProjectRoot } from "../../utils/fs.js";
import { getAuditPath, type ApprovalRecord } from "../../orchestrator/checkpoints/audit.js";

export function registerAuditCommand(program: Command): void {
  const auditCmd = program.command("audit").description("Inspect checkpoint audit logs");
  auditCmd
    .command("show <runId>")
    .description("Print the approval audit log for a run")
    .option("--json", "Emit machine-readable JSON instead of a table")
    .action(async (runId: string, opts: { json?: boolean }) => {
      const projectRoot = (await findProjectRoot()) ?? process.cwd();
      const path = getAuditPath(projectRoot, runId);
      let raw: string;
      try {
        raw = await readFile(path, "utf-8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          process.stderr.write(chalk.yellow(`No audit log found for run ${runId}.\n`));
          process.exitCode = 1;
          return;
        }
        throw err;
      }
      const records = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as ApprovalRecord);
      if (opts.json) { process.stdout.write(JSON.stringify(records, null, 2) + "\n"); return; }
      // …table render (mirror list-approvals.ts:93-107)
    });
}
```

**Note the `audit` namespace:** unlike `list-approvals`/`approve`/`reject`, this is a *subcommand of a subcommand* (`audit show`). Use commander's nested command pattern — `plan answer` at `src/cli/index.ts:120-138` is the only prior example in this codebase. Follow that pattern.

---

### `src/cli/index.ts` (modify)

**Relevant section (lines 22-28, registration block):**
```ts
import { registerApproveCommand } from "./commands/approve.js";
import { registerRejectCommand } from "./commands/reject.js";
import { registerListApprovalsCommand } from "./commands/list-approvals.js";
// ADD:
import { registerAuditCommand } from "./commands/audit-show.js";
```

**Relevant section (lines 221-228, registration calls):**
```ts
registerApproveCommand(program);
registerRejectCommand(program);
registerListApprovalsCommand(program);
// ADD:
registerAuditCommand(program);
```

**Imported by:** `package.json` bin entry (`dist/cli/index.js`). Changes here affect the CLI surface; don't break existing command registration order.

---

## 2. Patterns to Follow

### Pattern A — Architectural seam: WRAPPER, not per-mechanism try/finally
**Source:** Decision derived from contract s13-c2 text + `feedback-router.ts:601` shape.

The contract says *"the CheckpointMechanism interface includes a hook that the orchestrator calls in a finally block — guarantees the audit is recorded even on mechanism error."* Two architectures are possible:

- **(A)** Each mechanism (cli/disk/pr/noop) wraps its OWN `request()` body in try/finally → calls `recordApproval`. Pros: bullet-proof, mechanism-local. Cons: 4-way code duplication; fallback chains (cli→noop, pr→disk) write double entries unless you add a guard flag.
- **(B)** Export `runWithAudit({ projectRoot, runId, checkpointId, mechanism, iteration, fn })` from `audit.ts`. Every CALLER (pipeline.ts × 9 sites, feedback-router's `runCheckpointWithFeedback` at line 601) calls `runWithAudit(..., () => mechanism.request(id, art))` instead of `mechanism.request(id, art)` directly. The wrapper owns the try/finally. Pros: single canonical seam; no double-write in fallback chains; noop is audited for free. Cons: callers must consistently use the wrapper.

**ADOPT (B).** Implementation:

```ts
// In audit.ts
export async function runWithAudit<T extends CheckpointOutcome>(opts: {
  projectRoot: string;
  runId: string;
  checkpointId: string;
  mechanism: MechanismName;
  iteration: number;
  approverHint?: string;
  fn: () => Promise<T>;
}): Promise<T> {
  const start = Date.now();
  let outcome: ApprovalOutcome = "aborted";
  let feedbackText: string | undefined;
  let editDeltaSummary: EditDeltaSummary | null = null;
  let thrown: unknown;
  let result: T | undefined;
  try {
    result = await opts.fn();
    if ("approved" in result && result.approved === true)  outcome = "approved";
    else if ("approved" in result && result.approved === false) {
      outcome = "rejected";
      feedbackText = truncateFeedback(result.feedback);
    } else if ("edit" in result && result.edit === true) {
      outcome = "edited";
      editDeltaSummary = summarizeEditDelta(result.editDelta);
    }
  } catch (err) {
    thrown = err;
    outcome = "aborted";
    feedbackText = truncateFeedback(err instanceof Error ? err.message : String(err));
  } finally {
    const approverId = await resolveApproverId(opts.mechanism, opts.approverHint);
    await recordApproval(opts.projectRoot, opts.runId, {
      timestamp: new Date().toISOString(),
      runId: opts.runId,
      checkpointId: opts.checkpointId,
      mechanism: opts.mechanism,
      outcome,
      approverId,
      iteration: opts.iteration,
      feedbackText,
      editDeltaSummary,
      durationMs: Date.now() - start,
    }).catch(() => { /* audit failure must never break the pipeline */ });
  }
  if (thrown !== undefined) throw thrown;
  return result as T;
}
```

**Rule:** All 9 call sites in pipeline.ts AND the single `mechanism.request` call in `feedback-router.ts:601` must be wrapped. Direct mechanism instantiation in tests is unaffected (those tests verify mechanism behavior, not audit; they should not write to .bober/audits).

---

### Pattern B — Module-level promise chain mutex
**Source:** generatorNotes pinned this pattern; mirrors `pr.ts:184` (`prReadyTimer`) module-state idiom.
```ts
const writeChains = new Map<string, Promise<void>>();
export async function recordApproval(projectRoot: string, runId: string, record: ApprovalRecord): Promise<void> {
  const prev = writeChains.get(runId) ?? Promise.resolve();
  const next = prev.then(() => appendOneLine(projectRoot, runId, record));
  // Swallow errors in the chain pointer so subsequent appends aren't blocked,
  // but propagate to THIS caller.
  writeChains.set(runId, next.catch(() => {}));
  return next;
}
```
**Rule:** Per-runId map (NOT a single global chain) — unrelated runs proceed in parallel. `prev` is the *prior pointer*, swallowed for chain continuity, but `next` is what we return so this caller sees the real error.

---

### Pattern C — fs.open with mode 0o600 (NOT appendFile)
**Source:** evaluatorNotes "Use fs.open with O_CREAT|O_APPEND|O_WRONLY and mode arg, then write."
```ts
import { open, mkdir } from "node:fs/promises";
import { constants } from "node:fs";

async function appendOneLine(projectRoot: string, runId: string, record: ApprovalRecord): Promise<void> {
  const dir = join(projectRoot, ".bober", "audits");
  await mkdir(dir, { recursive: true });
  const path = getAuditPath(projectRoot, runId);
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT;
  const fh = await open(path, flags, 0o600);
  try {
    await fh.write(JSON.stringify(record) + "\n");
  } finally {
    await fh.close();
  }
}
```
**Rule:** `fs.appendFile(path, data, { mode: 0o600 })` does NOT apply mode to an existing file — and even on first create, some Node versions ignore the mode option for appendFile. The `fs.open(flags, mode)` form is the only reliable way. See Pitfalls Section 9.

---

### Pattern D — Module header + named exports
**Source:** Every checkpoint module — `feedback-router.ts:1-26`, `mechanisms/disk.ts:1-11`, `noop.ts:1-9`.
```ts
/**
 * <One-line summary>
 *
 * <Why it exists / what it owns / Sprint number>
 */
import { … } from "node:…";
import type { … } from "./types.js";  // .js extension MANDATORY (ESM)

export function … { … }
```
**Rule:** Always lead with a JSDoc header naming the sprint. Always use `.js` extension on internal imports — this is enforced by `tsconfig` moduleResolution and is consistent across every file in `src/orchestrator/checkpoints/`. Named exports only — there are zero `export default` in this directory.

---

### Pattern E — CLI command registration
**Source:** `src/cli/commands/list-approvals.ts:39-107`, `src/cli/index.ts:120-138` (nested sub-subcommand example).
```ts
export function registerXxxCommand(program: Command): void {
  program.command("xxx")
    .description("…")
    .option("--json", "Emit machine-readable JSON instead of a table")
    .action(async (opts: { json?: boolean }) => { … });
}
```
**Nested example** for `audit show`:
```ts
const auditCmd = program.command("audit").description("Inspect checkpoint audit logs");
auditCmd.command("show <runId>").description("…").action(async (runId, opts) => { … });
```
**Rule:** Use `chalk.cyan` for table headers, `chalk.gray` for separator lines, `chalk.yellow`/`chalk.red` for missing-resource / error messages. `process.exitCode = 1` (NOT `process.exit(1)`) on user-error paths.

---

### Pattern F — Test colocation + tmpdir + cleanup
**Source:** `mechanisms/disk.test.ts:18-37`, `list-approvals.test.ts:17-30`, `feedback-router.test.ts:34-42`.
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-audit-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });
```
**Rule:** Tests that touch the filesystem use `mkdtemp` for isolation. Do NOT write into the real `.bober/audits/` of the project.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `findProjectRoot` | `src/utils/fs.ts:58` | `(startDir?: string) => Promise<string \| null>` | Walks up to find `bober.config.json`/`package.json`. Use in `audit show` to resolve projectRoot. |
| `ensureDir` | `src/utils/fs.ts:45` | `(path: string) => Promise<void>` | `mkdir(path, { recursive: true })` wrapper. |
| `fileExists` | `src/utils/fs.ts:10` | `(path: string) => Promise<boolean>` | Use for the `audit show` ENOENT precheck if you prefer it over a try/catch. |
| `readJson` / `writeJson` | `src/utils/fs.ts:24,34` | generic JSON helpers | DO NOT use for JSONL — they read/write whole-file JSON. JSONL needs line-by-line. |
| `resolveApprover` | `src/cli/commands/approve.ts:29` | `() => string` (env USER → USERNAME → "unknown") | Inline copy of the CLI mechanism's approver logic. Audit can reuse this directly: `import { resolveApprover } from "../../cli/commands/approve.js"` — BUT a cross-layer import from `orchestrator/` into `cli/` is bad. Instead, EXTRACT the chain into `audit.ts:resolveApproverId("cli")` and have approve.ts call back into it (or simply duplicate the 1-line fallback — acceptable here). |
| `resolveRejecter` | `src/cli/commands/reject.ts:29` | identical to `resolveApprover` | Same note — do not depend on cli/ from orchestrator/. |
| `execa` | (npm dep; `src/utils/git.ts:1`) | `execa(cmd, args, opts) => Promise<{ stdout, stderr, exitCode }>` | Use for `git config user.name` lookup in disk-mechanism approverId chain. Always pass `{ reject: false, timeout: 5000 }` per the `pr.ts:48-72` precedent. |
| `getCurrentBranch` / `commitAll` | `src/utils/git.ts:8,27` | git wrappers | Not needed for this sprint — but illustrates the `execa` calling convention to copy. |
| `logger` | `src/utils/logger.ts` (used via `import { logger } from "../../utils/logger.js"`) | structured logger | Use for any internal warnings (e.g., audit write failed). DO NOT log audit records themselves — they go to disk. |
| `chalk` | npm dep, used in every CLI command | color helpers | Use in `audit show` for header/separator/error coloring. |
| `Command` from commander | used in every CLI command | CLI framework | Use for the nested `audit show` registration. |
| `CheckpointOutcome` type | `src/orchestrator/checkpoints/types.ts:46` | discriminated union | The wrapper inspects `outcome.approved` / `outcome.edit` to map to `ApprovalOutcome`. Mirror the exact narrowing pattern used in `feedback-router.ts:432-441`. |
| `CheckpointId` type | `src/orchestrator/checkpoints/types.ts:13` | string union of 9 ids | Use as the type of `checkpointId` in `ApprovalRecord` (but the record's `checkpointId` is widened to `string` per generatorNotes — be explicit). |
| `CHECKPOINT_SITES` | `src/orchestrator/checkpoints/sites.ts:23` | readonly site enumeration | The contract requires 9 sites be wrapped. Cross-reference this list when wiring pipeline.ts. |
| `getCheckpointMechanismFor` | `src/orchestrator/checkpoints/registry.ts:66` | resolves mechanism by id+config | The wrapper does NOT replace this — the wrapper is one layer above it. |
| `formatAge` | `src/cli/commands/list-approvals.ts:27` | `(ms) => "Xd Yh"` style | Reuse for the duration column in `audit show` (`record.durationMs` → human string). |
| `pendingExists` | `src/state/approval-state.ts:145` | `(root, id) => Promise<boolean>` | Not used by audit — listed for awareness so you don't reinvent file-exists helpers. |

---

## 4. Prior Sprint Output

### Sprint 7: Checkpoint scaffolding
**Created:** `src/orchestrator/checkpoints/{types.ts, noop.ts, registry.ts, sites.ts, index.ts, checkpoints.test.ts}`.
**Connection:** Defines `CheckpointId`, `CheckpointArtifact`, `CheckpointOutcome`, `CheckpointMechanism`. Audit consumes these types. The 9 `CHECKPOINT_SITES` are the call sites that need wrapping.

### Sprint 8: CLI mechanism
**Created:** `src/orchestrator/checkpoints/mechanisms/cli.ts` + tests.
**Connection:** The CLI mechanism is the source of `approverId = env.USER`. Audit reuses the `process.env["USER"] ?? process.env["USERNAME"] ?? "unknown"` pattern. The non-TTY fallback to noop means audit may record `mechanism: "noop"` even when the user invoked cli — handle this in the wrapper by reading the *effective* mechanism name (i.e., the mechanism that produced the outcome). For seam (B), the caller knows it asked for "cli" — the noop fallback inside is invisible to the wrapper. ACCEPTABLE: the audit will say `mechanism: "cli"` even when the inner noop fired. Document this.

### Sprint 9: Disk mechanism + first CLI commands
**Created:** `src/orchestrator/checkpoints/mechanisms/disk.ts`, `src/state/approval-state.ts`, `src/cli/commands/{approve, reject, list-approvals}.ts` + tests.
**Connection:** `approve.ts:29 resolveApprover()` is the env-USER fallback. `list-approvals.ts` is the structural template for `audit show`. The disk mechanism receives `runId` in its options (`disk.ts:33`) — that's how the wrapper gets the runId for disk-mechanism call sites.

### Sprint 10: PR mechanism
**Created:** `src/orchestrator/checkpoints/mechanisms/pr.ts` + tests.
**Connection:** Provides `runId` (`pr.ts:150`) and has comment-author data available via `gh pr view`. The PR mechanism's `parseSignals` (line 484) currently DISCARDS the comment author — Sprint 13 must extend the signal shape with `actor` to surface the GitHub username for `approverId`.

### Sprint 11: Renderers
**Created:** `src/orchestrator/checkpoints/renderers/*` — referenced by `cli.ts:31`, `disk.ts:21`, `pr.ts:22`. Not directly relevant to audit beyond reading.

### Sprint 12: Feedback router (dependsOn target)
**Created:** `src/orchestrator/checkpoints/feedback-router.ts` + tests.
**Connection:** The router's `runCheckpointWithFeedback` (line 561) wraps `mechanism.request` inside its iteration loop at line 601. This is the SECOND wrapping point (after pipeline.ts's 9 direct call sites). When the router re-invokes an agent and re-runs the mechanism, each iteration's outcome must be a separate audit entry (the `iteration` field is passed in — the router already counts iterations from 1).

   **Critical:** the router is NOT currently wired into pipeline.ts. The 9 sites in pipeline.ts still call `mechanism.request` directly. Sprint 13 must wrap BOTH paths — every direct call site in pipeline.ts AND the single call at `feedback-router.ts:601` — to guarantee s13-c2.

---

## 5. Relevant Documentation

### Project Principles
**No `.bober/principles.md` file found.** The implicit conventions (extracted from code patterns):
- ESM with `.js` import extensions on internal modules.
- Named exports only — no default exports anywhere in `src/orchestrator/checkpoints/`.
- File headers with one-line summary + sprint number.
- Errors carry context (`Error(\`X failed: ${reason}\`)`) — never bare `throw`.
- `process.exitCode = N` for CLI failures, never `process.exit(N)` (allows graceful flush).

### Architecture Decisions
**No `.bober/architecture/` directory found.** Architectural intent is encoded in module header comments. The key implicit ADR for Sprint 13:
- **Checkpoint mechanisms are pluggable via a registry** (`registry.ts:18`). Sprint 14 wires per-checkpoint overrides. Audit must NOT bake in mechanism-name strings beyond the four enumerated.
- **Fallback chains are transparent** (cli→noop, pr→disk in `cli.ts:112` and `pr.ts:211`). Audit records the *requested* mechanism, not the fallback. Document this.

### Other Docs
- `package.json:11-17`: scripts are `build` (`tsc`), `dev` (`tsc --watch`), `lint` (`eslint src/`), `typecheck` (`tsc --noEmit`), `test` (`vitest`). Use all four for s13-c9 verification.
- No `CLAUDE.md` / `CONTRIBUTING.md` in the project root.
- README is present but does not document audit behavior — no doc updates required by this sprint contract.

---

## 6. Testing Patterns

### Unit Test Pattern
**Source:** `src/orchestrator/checkpoints/mechanisms/disk.test.ts:1-90`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DiskCheckpointMechanism } from "./disk.js";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-disk-cp-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

describe("DiskCheckpointMechanism — approve flow (s9-c7a)", () => {
  it("returns { approved: true } when .approved.json appears", async () => {
    const m = new DiskCheckpointMechanism(tmpDir, { pollMs: 10 });
    // …
    const outcome = await m.request(id, { type: "research-doc" });
    expect(outcome).toEqual({ approved: true });
  });
});
```
**Runner:** `vitest` (`package.json:16`)
**Assertion style:** `expect(...).toEqual(...)`, `.toBe(...)`, `.toContain(...)`, `.toHaveLength(...)`
**Mock approach:** No `vi.mock` in this directory — tests inject fakes via constructor params (`DiskCheckpointMechanism`'s `now: () => number`, CLI's `stdin: Readable`). Mirror this — accept the audit's mutex map / clock as a *testable side door* if you need deterministic time.
**File naming:** `<module>.test.ts` colocated next to `<module>.ts`.
**Location:** Colocated (HARD CONSTRAINT). Tests at `src/orchestrator/checkpoints/audit.test.ts` and `src/cli/commands/audit-show.test.ts`. NEVER `tests/orchestrator/checkpoints/`.

### Required test cases (s13-c8 enumerates them — make ONE describe block per case):
```ts
describe("recordApproval (s13-c8a) — outcome variants", () => {
  it("approved outcome writes mechanism='cli', outcome='approved'", async () => { … });
  it("rejected outcome includes truncated feedbackText (500 chars max)", async () => { … });
  it("edited outcome includes editDeltaSummary { lineCount, firstChars }", async () => { … });
  it("aborted outcome (thrown error) records outcome='aborted' with err.message in feedbackText", async () => { … });
});

describe("runWithAudit (s13-c8b) — mechanism-error path", () => {
  it("records an entry even when fn() throws", async () => {
    const throwingFn = async () => { throw new Error("boom"); };
    await expect(runWithAudit({ …, fn: throwingFn })).rejects.toThrow("boom");
    const records = await readAuditFile(tmp, runId);
    expect(records[0].outcome).toBe("aborted");
    expect(records[0].feedbackText).toContain("boom");
  });
});

describe("recordApproval (s13-c8c) — concurrent appends serialize", () => {
  it("100 parallel recordApproval calls produce 100 distinct, parseable lines", async () => {
    await Promise.all(Array.from({ length: 100 }, (_, i) =>
      recordApproval(tmp, runId, makeRecord(i))));
    const lines = (await readFile(getAuditPath(tmp, runId), "utf-8")).split("\n").filter(Boolean);
    expect(lines).toHaveLength(100);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });
});

describe("resolveApproverId (s13-c8d) — fallback chain", () => {
  it("noop → 'autopilot'", async () => { … });
  it("cli → env.USER", async () => { … });
  it("cli → env.USERNAME when USER unset", async () => { … });
  it("disk → git config user.name (mock execa)", async () => { … });
  it("disk → env.USER when git config fails", async () => { … });
  it("pr → uses approverHint as-is (formatted 'github:<login>')", async () => { … });
  it("any → 'unknown' when all fallbacks fail", async () => { … });
});

describe("mode 0600 (s13-c7)", () => {
  it("created audit file has mode 0600 on POSIX", async () => {
    if (process.platform === "win32") return;
    await recordApproval(tmp, runId, makeRecord(0));
    const s = await stat(getAuditPath(tmp, runId));
    expect(s.mode & 0o777).toBe(0o600);
  });
});

describe("audit show (s13-c8e) — CLI command", () => {
  it("prints a table for an existing run", async () => { … });
  it("--json emits parseable JSON array", async () => { … });
  it("missing run prints friendly message and exits non-zero", async () => { … });
});
```

### E2E Test Pattern
**Not applicable** — this project has no Playwright config (`grep -r playwright` returns nothing). No E2E test layer.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/orchestrator/pipeline.ts` (lines 148, 243, 306, 363, 398, 493, 629, 659, 721) | direct `.request()` calls on each of 9 checkpoint sites | high | All 9 calls must be wrapped in `runWithAudit`. Forgetting one breaks s13-c2 for that checkpoint. |
| `src/orchestrator/checkpoints/feedback-router.ts:601` | `mechanism.request(checkpointId, artifactWithMeta)` inside iteration loop | high | Each iteration must produce a separate audit entry. Use `iteration` from the loop counter. |
| `src/orchestrator/checkpoints/mechanisms/pr.ts:484` (`parseSignals`) | does not expose comment author | medium | Extend `PrSignal` with `actor?: string` to surface GitHub username for approverId. Existing tests in `pr.test.ts` may break if signal shape changes. |
| `src/orchestrator/checkpoints/checkpoints.test.ts` | uses `getCheckpointMechanism("noop")` directly without runId | low | Test verifies noop behavior in isolation — should NOT be wrapped. Keep unchanged. |
| `src/orchestrator/checkpoints/mechanisms/{cli,disk,pr}.test.ts` | call `mechanism.request` directly | low | These tests verify mechanism behavior in isolation. Audit should NOT be wired in here. Tests pass unchanged because seam (B) is at the caller, not the mechanism. |
| `src/cli/index.ts:222-228` | imports the three Sprint-9 commands | low | Add `registerAuditCommand` import + call; preserve order. |

### Existing Tests That Must Still Pass
- `src/orchestrator/checkpoints/checkpoints.test.ts` — verifies noop returns `{approved:true}` and registry resolution. Audit must not change noop's output shape.
- `src/orchestrator/checkpoints/mechanisms/cli.test.ts` — verifies TTY guard, edit/reject branches. Outputs unchanged.
- `src/orchestrator/checkpoints/mechanisms/disk.test.ts` — 7 test groups (s9-c7a–g). All must pass unchanged.
- `src/orchestrator/checkpoints/mechanisms/pr.test.ts` — verifies `parseSignals` outputs. **Will break** if you extend `PrSignal` with `actor`. Update tests to assert new field.
- `src/orchestrator/checkpoints/feedback-router.test.ts` — `runCheckpointWithFeedback` tests. **Will break** if you wrap the inner `mechanism.request` with audit and tests don't supply projectRoot/runId. Use a thin shim: `runWithAudit` should accept an optional `enabled: boolean` flag that defaults to true, with feedback-router tests passing `enabled: false`. OR: only call `runWithAudit` if `projectRoot` is in scope (it is — `RunCheckpointWithFeedbackOpts.projectRoot` already exists at line 524).
- `src/cli/commands/{approve,reject,list-approvals}.test.ts` — unrelated, unchanged.

### Features That Could Be Affected
- **Tier 2 careful-flow (Sprints 7-12)** — audit is the observability layer over the entire checkpoint machinery. Any silent breakage of audit recording will degrade compliance/replay across all Tier 2 features.
- **Sprint 14 (per-checkpoint config overrides)** — Sprint 14 will plumb full `BoberConfig.pipeline` into `getCheckpointMechanismFor`. The audit wrapper does NOT need to know about config; it gets the resolved mechanism name from the caller. Keep the wrapper config-agnostic so Sprint 14 doesn't need to refactor it.
- **Sprint 15+ replay / compliance review** — these features will consume the JSONL. Don't break the schema after writing it: pin `ApprovalRecord` shape in TypeScript and avoid renaming fields.

### Recommended Regression Checks
After implementation, the Generator MUST verify:
1. `npm run typecheck` — exit 0
2. `npm run lint` — exit 0
3. `npm run build` — exit 0
4. `npm run test` — all suites pass, including pre-existing `checkpoints.test.ts`, `mechanisms/{cli,disk,pr}.test.ts`, `feedback-router.test.ts`, and the new `audit.test.ts` + `audit-show.test.ts`.
5. Manual smoke: in a temp dir, run a noop-mode pipeline (or invoke a wrapped `runWithAudit` directly in a Node REPL) → verify `.bober/audits/<runId>.jsonl` exists with mode 0600 and contains a valid JSON line per checkpoint.
6. Manual smoke: `node dist/cli/index.js audit show <runId>` — verify table renders; `--json` emits an array; missing runId prints yellow message + exit 1.

---

## 8. Implementation Sequence

1. **`src/orchestrator/checkpoints/audit.ts`** — create. Exports: `ApprovalRecord` (type), `ApprovalOutcome` (type), `MechanismName` (type), `EditDeltaSummary` (type), `getAuditPath`, `recordApproval`, `resolveApproverId`, `summarizeEditDelta`, `truncateFeedback`, `runWithAudit`.
   - Verify: `npm run typecheck` passes. `import { recordApproval } from "./audit.js"` resolves.

2. **`src/orchestrator/checkpoints/audit.test.ts`** — create. Cover all s13-c8 cases listed in Section 6.
   - Verify: `npx vitest run src/orchestrator/checkpoints/audit.test.ts` — all green.

3. **`src/cli/commands/audit-show.ts`** — create. Mirrors `list-approvals.ts` structure, nested under `audit` command.
   - Verify: imports `getAuditPath` and `ApprovalRecord` from `../../orchestrator/checkpoints/audit.js`. Compiles.

4. **`src/cli/commands/audit-show.test.ts`** — create (colocated). Covers s13-c8e.
   - Verify: tests pass; CLI registers cleanly.

5. **`src/cli/index.ts`** — add import + registration call. ~2 lines added.
   - Verify: `node dist/cli/index.js --help` shows `audit` subcommand after build.

6. **`src/orchestrator/checkpoints/mechanisms/pr.ts`** — extend `PrSignal` with `actor?: string`; thread it through `parseSignals` (line 484), `pollPrUntilResolved` (line 395), and `request()` return path so the caller can pass it as `approverHint` to `runWithAudit`.
   - Verify: `pr.test.ts` updates pass; existing assertions on PrSignal shape are updated.

7. **`src/orchestrator/pipeline.ts`** — wrap each of the 9 `getCheckpointMechanismFor(...).request(...)` call sites in `runWithAudit({ projectRoot, runId, checkpointId, mechanism: resolvedMechName, iteration: 1, fn: () => mech.request(id, art) })`. The mechanism name is the string that `getCheckpointMechanismFor` resolved to — pipeline currently discards it; you'll need to fetch both (consider adding `resolveCheckpointMechanismName(checkpointId, config)` to `registry.ts`).
   - Verify: pipeline still runs in noop mode end-to-end; `.bober/audits/<runId>.jsonl` populated; types pass.

8. **`src/orchestrator/checkpoints/feedback-router.ts`** — at line 601, wrap the `mechanism.request` call with `runWithAudit`. Use `iteration` from the loop variable (already available). The `projectRoot` and `runId` are already in `RunCheckpointWithFeedbackOpts`. Mechanism name must be passed into `RunCheckpointWithFeedbackOpts` as a new required field — update callers in pipeline.ts.
   - Verify: `feedback-router.test.ts` passes (may need to pass `mechanismName: "noop"` in test opts; consider making it default to `"noop"` for test convenience).

9. **`src/orchestrator/checkpoints/noop.ts`** — NO file changes if seam (B). Document in a header comment that audit recording is performed by the caller via `runWithAudit`. (If you adopt seam (A), modify each mechanism instead — but this briefing recommends NOT doing that.)

10. **Run full verification** — `npm run typecheck && npm run lint && npm run build && npm run test`. Investigate any failure before declaring done.

---

## 9. Pitfalls & Warnings

- **`fs.appendFile` does NOT honor `mode`.** `appendFile(path, data, { mode: 0o600 })` is documented to apply `mode` only when creating the file, and even then several Node minor versions silently ignore it. The ONLY reliable form is `fs.open(path, O_WRONLY|O_APPEND|O_CREAT, 0o600)` then `fh.write(data)` then `fh.close()`. Use `node:fs/promises`'s `open` (returns a FileHandle), not `node:fs`'s `openSync`. See Pattern C in Section 2.

- **`umask` interferes with mode.** Even with `0o600` passed to `open`, the kernel applies the process umask: `effective = mode & ~umask`. On most dev machines umask is `022`, which leaves `0o600` intact (since 6 = 110 in binary, AND with 111 = 110). But for paranoia, follow up the open with `await fh.chmod(0o600)` BEFORE the first write, to guarantee the mode regardless of umask. Test asserts on `stat.mode & 0o777 === 0o600`.

- **Concurrent appends from a single process serialize via mutex; from multiple processes they do NOT.** O_APPEND is atomic on POSIX for writes ≤ PIPE_BUF (4096 bytes typically). Single-line JSON records will normally fit, but a 500-char feedback + 200-char editDelta preview + boilerplate ≈ 1KB — well under PIPE_BUF, so cross-process is also safe in practice. Document this limit in audit.ts header. Do NOT advertise multi-process safety beyond what POSIX guarantees.

- **JSON.stringify can throw on circular references.** Wrap `JSON.stringify(record)` in a try/catch inside `appendOneLine`; on failure, write a synthesized fallback record `{ …, feedbackText: "AUDIT_SERIALIZE_FAILED: <err>" }`. The audit must never silently drop entries.

- **`process.env["USER"]` is undefined in some CI environments.** Bracket access (`process.env["USER"]`) is required because the codebase uses strict TS settings (`noUncheckedIndexedAccess` is on — see `src/cli/commands/approve.ts:30`). Always use the bracket form, never dot access.

- **`execa("git", ["config", "user.name"])` may fail outside a git repo.** Always pass `{ reject: false, timeout: 5000 }` so the promise resolves with `exitCode !== 0` rather than throwing. Check `r.exitCode === 0 && r.stdout.trim().length > 0` before using the value.

- **Test files run in parallel by default in vitest.** If two test cases share a single in-process `writeChains` map, they may serialize each other. Use a fresh `runId` (e.g., `mkdtemp` + UUID) per test to avoid cross-test serialization slowdown.

- **The contract path `tests/orchestrator/checkpoints/audit.test.ts` is WRONG.** The project's colocation hard constraint mandates `src/orchestrator/checkpoints/audit.test.ts`. Document the deviation in the test file header (mirror `checkpoints.test.ts:1-8` and `feedback-router.test.ts:3-9`).

- **Do NOT log the full feedback string.** `truncateFeedback` caps at 500 chars per generatorNotes. Likewise `summarizeEditDelta` extracts only line count + first 200 chars — never the full delta. The full delta is owned by `feedback-router.ts:applyEditDelta` which writes a backup to `.bober/runs/<runId>/edits/`. The audit log is mode 0600 but may still be backed up — keep PII surface minimal.

- **Mechanism fallback chains hide the actual responder.** When `cli.ts:108-113` falls back to noop (non-TTY) and `pr.ts:207-212` falls back to disk (no gh), the wrapper records the *requested* mechanism — not the actual responder. This is acceptable for replay (the requested mechanism is what the user intended) but document it. If you need to record the actual responder, change the API so mechanisms return `{ outcome, effectiveMechanism }` — a deeper refactor than this sprint requires.

- **Audit write failures must NEVER break the pipeline.** The `runWithAudit` `finally` block must wrap `recordApproval` in `.catch(() => {})` (and log via `logger.warn`). The audit is a record-keeping concern; if it fails, the pipeline must still return the mechanism's outcome to its caller.

- **`process.exit(N)` is forbidden.** Use `process.exitCode = N; return;` (see `approve.ts:51`, `list-approvals.ts:88`). This allows stdout/stderr to flush and chalk to reset terminal state.
