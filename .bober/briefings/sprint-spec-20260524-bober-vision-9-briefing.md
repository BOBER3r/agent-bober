# Sprint Briefing: Disk-marker checkpoint mechanism + `bober approve/reject/list-approvals` CLI commands

**Contract:** `sprint-spec-20260524-bober-vision-9`
**Generated:** 2026-05-25T00:00:00Z
**Tier:** 2 (sprint 3/8)
**Depends on:** Sprint 7 (checkpoint types/registry/noop), Sprint 8 (CLI mechanism + colocation precedent)

---

## 0. Sprint Summary

Implement the **disk-marker checkpoint mechanism** (`src/orchestrator/checkpoints/mechanisms/disk.ts`) — writes `.bober/approvals/<checkpointId>.pending.json`, polls the directory at a configurable interval (default 2s), and resolves when the user (via CLI) renames the file to `.approved.json` or `.rejected.json`. Register it under the name `"disk"` next to `"noop"` and `"cli"` in `registry.ts`. Then add **three CLI subcommands** to `src/cli/index.ts` — `bober approve <checkpointId> [--edit <file>]`, `bober reject <checkpointId> --feedback <text>`, `bober list-approvals [--json]` — each implemented in its own file under `src/cli/commands/`. **CRITICAL: every new test file must be COLOCATED** alongside the source file (`disk.test.ts` next to `disk.ts`; CLI command tests next to the command file — see `src/cli/commands/impact.test.ts` for the precedent). The contract's `expectedChanges` says `tests/orchestrator/checkpoints/disk.test.ts` — that path is **WRONG** per the Sprint 5 scanner regression and would tip the colocated:separate ratio (currently 25:22) closer to the boundary.

---

## 1. Target Files

### `src/orchestrator/checkpoints/mechanisms/disk.ts` (create)

**Directory pattern:** `mechanisms/` was established by Sprint 8 (`cli.ts`). Files use kebab-case singular names — one file per mechanism class. Class is `<Name>CheckpointMechanism` (e.g. `DiskCheckpointMechanism`).

**Most similar existing file:** `src/orchestrator/checkpoints/mechanisms/cli.ts` (Sprint 8, 230 lines) — follow this structure exactly.

**Structure template (cloned from cli.ts):**
```ts
/**
 * Disk-marker blocking checkpoint mechanism.
 *
 * Writes .bober/approvals/<checkpointId>.pending.json containing a SUMMARY of
 * the artifact (NOT the full artifact — perf budget 100ms), polls the directory
 * until <id>.approved.json or <id>.rejected.json appears, deletes the pending
 * file, and returns the matching CheckpointOutcome. Times out at a configurable
 * cap (default 24h, max 7d) writing a TIMEOUT marker.
 *
 * Sprint 9 — colocated in mechanisms/ per Sprint 7+8 precedent.
 */
import { readFile, writeFile, readdir, unlink, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  CheckpointArtifact,
  CheckpointId,
  CheckpointMechanism,
  CheckpointOutcome,
} from "../types.js";

const DEFAULT_POLL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000;      // 24h
const MAX_TIMEOUT_MS    = 7  * 24 * 60 * 60 * 1000;  // 7d cap

export interface DiskMechanismOptions {
  /** Default 2000ms; configurable via pipeline.approvalPollMs */
  pollMs?: number;
  /** Default 24h; capped at 7d via MAX_TIMEOUT_MS */
  timeoutMs?: number;
  /** Optional runId stamped into the pending file */
  runId?: string;
}

/** Summary written to disk — NOT the full artifact (perf budget). */
interface ArtifactSummary {
  type?: string;
  path?: string;
  summary?: string;
  lines?: number;
}

export class DiskCheckpointMechanism implements CheckpointMechanism {
  constructor(
    private readonly approvalsDir: string,           // .bober/approvals absolute path
    private readonly options: DiskMechanismOptions = {},
    // Optional clock injection for deterministic timeout tests
    private readonly now: () => number = () => Date.now(),
  ) {}

  async request(
    checkpoint: CheckpointId,
    artifact: CheckpointArtifact,
  ): Promise<CheckpointOutcome> {
    const pollMs    = this.options.pollMs    ?? DEFAULT_POLL_MS;
    const timeoutMs = Math.min(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

    await mkdir(this.approvalsDir, { recursive: true });

    // 1) Write pending file (under 100ms — summary only)
    const pendingPath  = join(this.approvalsDir, `${checkpoint}.pending.json`);
    const approvedPath = join(this.approvalsDir, `${checkpoint}.approved.json`);
    const rejectedPath = join(this.approvalsDir, `${checkpoint}.rejected.json`);
    const timeoutPath  = join(this.approvalsDir, `${checkpoint}.timeout.json`);

    const requestedAt = new Date(this.now()).toISOString();
    const timeoutAt   = new Date(this.now() + timeoutMs).toISOString();

    const pending = {
      checkpointId: checkpoint,
      runId: this.options.runId,
      artifact: summarizeArtifact(artifact),   // SUMMARY shape, not raw
      prompt: `Checkpoint "${checkpoint}" awaiting approval.`,
      requestedAt,
      timeoutAt,
    };
    await writeFile(pendingPath, JSON.stringify(pending, null, 2) + "\n", "utf-8");

    // 2) Poll until resolution OR timeout
    const startedAt = this.now();
    let pollHandle: ReturnType<typeof setTimeout> | undefined;

    try {
      return await new Promise<CheckpointOutcome>((resolve, reject) => {
        const tick = async (): Promise<void> => {
          try {
            // Atomic-ish read: enumerate directory once per poll.
            const entries = new Set(await readdir(this.approvalsDir).catch(() => []));

            if (entries.has(`${checkpoint}.approved.json`)) {
              const raw = await readFile(approvedPath, "utf-8");
              const parsed = JSON.parse(raw) as { editDelta?: unknown };
              await unlink(pendingPath).catch(() => {});  // last-write-wins cleanup
              await unlink(approvedPath).catch(() => {});
              resolve(parsed.editDelta !== undefined
                ? { approved: true, editDelta: parsed.editDelta }
                : { approved: true });
              return;
            }
            if (entries.has(`${checkpoint}.rejected.json`)) {
              const raw = await readFile(rejectedPath, "utf-8");
              const parsed = JSON.parse(raw) as { feedback: string };
              await unlink(pendingPath).catch(() => {});
              await unlink(rejectedPath).catch(() => {});
              resolve({ approved: false, feedback: parsed.feedback });
              return;
            }
            if (this.now() - startedAt >= timeoutMs) {
              await writeFile(timeoutPath, JSON.stringify({
                checkpointId: checkpoint, timedOutAt: new Date(this.now()).toISOString(),
              }) + "\n", "utf-8");
              await unlink(pendingPath).catch(() => {});
              resolve({ approved: false, feedback: "TIMEOUT" });
              return;
            }
            pollHandle = setTimeout(tick, pollMs);  // schedule next tick
          } catch (err) {
            reject(err);
          }
        };
        pollHandle = setTimeout(tick, pollMs);
      });
    } finally {
      if (pollHandle) clearTimeout(pollHandle);   // cleanup — NO leaked timers
    }
  }
}

function summarizeArtifact(artifact: CheckpointArtifact): ArtifactSummary {
  const a = artifact as Record<string, unknown> | null | undefined;
  if (!a || typeof a !== "object") return {};
  const out: ArtifactSummary = {};
  if (typeof a["type"]    === "string") out.type    = a["type"];
  if (typeof a["path"]    === "string") out.path    = a["path"];
  if (typeof a["summary"] === "string") out.summary = a["summary"];
  if (typeof a["lines"]   === "number") out.lines   = a["lines"];
  return out;
}
```

**Imports this file uses:** `node:fs/promises`, `node:path`, `../types.js` (sibling barrel).

**Test file:** `src/orchestrator/checkpoints/mechanisms/disk.test.ts` — **MUST BE COLOCATED**, see Section 3.

---

### `src/orchestrator/checkpoints/registry.ts` (modify)

**Relevant section — full current file (35 lines):**
```ts
import type { CheckpointMechanism } from "./types.js";
import { NoopCheckpointMechanism } from "./noop.js";
import { CliCheckpointMechanism } from "./mechanisms/cli.js";

// ...
const mechanisms = new Map<string, CheckpointMechanism>();

export function registerCheckpointMechanism(name: string, impl: CheckpointMechanism): void {
  mechanisms.set(name, impl);
}

export function getCheckpointMechanism(name: string): CheckpointMechanism {
  const impl = mechanisms.get(name);
  if (!impl) {
    throw new Error(
      `Unknown checkpoint mechanism: ${name}. Registered: ${[...mechanisms.keys()].join(", ") || "(none)"}`,
    );
  }
  return impl;
}

// Self-register the noop mechanism at module init.
registerCheckpointMechanism("noop", new NoopCheckpointMechanism());
registerCheckpointMechanism("cli", new CliCheckpointMechanism());
```

**Change (additive — 2 lines):**
```ts
// add import
import { DiskCheckpointMechanism } from "./mechanisms/disk.js";

// at the bottom, after the cli registration:
registerCheckpointMechanism(
  "disk",
  new DiskCheckpointMechanism(
    // Resolve at module load:  process.cwd() + "/.bober/approvals"
    // OR (cleaner) defer construction to a factory; orchestrator passes projectRoot.
    // For Sprint 9 keep parity with cli registration — no constructor args —
    // and let the disk mechanism resolve approvalsDir from process.cwd().
    join(process.cwd(), ".bober", "approvals"),
  ),
);
```
**Caveat:** the registry runs at module-load (module init). `process.cwd()` is read at that moment. If the orchestrator ever runs from a different cwd, the path is wrong. The cleaner pattern is a small factory; mirror what cli.ts does (defaults at construction). Use `process.cwd()` here for parity with the cli registration and document it.

---

### `src/cli/commands/approve.ts` (create)

**Directory pattern:** `src/cli/commands/*.ts` — each command file exports either a `runXxxCommand(...)` function OR a `registerXxxCommand(program: Command): void` (newer convention from Sprint 10 — see `impact.ts`, `graph.ts`, `onboard.ts`). **Follow the `register*` pattern** because the new commands are independent subcommands wired into `src/cli/index.ts`.

**Most similar existing file:** `src/cli/commands/impact.ts` (registerImpactCommand) — same shape: read project root, do a filesystem op, print success/error.

**Structure template:**
```ts
/**
 * `agent-bober approve <checkpointId> [--edit <file>]` — resolve a pending
 * disk-marker checkpoint by writing .bober/approvals/<id>.approved.json.
 *
 * Stateless: does not talk to the orchestrator; communicates via filesystem.
 * Works from any cwd inside the project (findProjectRoot() walks upward).
 */
import { readFile, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { findProjectRoot } from "../../utils/fs.js";

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

function resolveApprover(): string {
  return process.env["USER"] ?? process.env["USERNAME"] ?? "unknown";
}

export function registerApproveCommand(program: Command): void {
  program
    .command("approve <checkpointId>")
    .description("Approve a pending checkpoint by writing the .approved.json marker")
    .option("--edit <path>", "Path to a file whose contents become the editDelta")
    .action(async (checkpointId: string, opts: { edit?: string }) => {
      const projectRoot = await resolveRoot();
      const approvalsDir = join(projectRoot, ".bober", "approvals");
      const pendingPath  = join(approvalsDir, `${checkpointId}.pending.json`);
      const approvedPath = join(approvalsDir, `${checkpointId}.approved.json`);

      // Guard: pending file must exist — never write a dangling .approved.json
      try {
        await access(pendingPath, constants.R_OK);
      } catch {
        process.stderr.write(
          chalk.red(`No pending checkpoint found: ${checkpointId}\n`) +
          `  Expected: .bober/approvals/${checkpointId}.pending.json\n`,
        );
        process.exitCode = 1;
        return;
      }

      let editDelta: unknown;
      if (opts.edit) {
        try {
          editDelta = await readFile(opts.edit, "utf-8");
        } catch (err) {
          process.stderr.write(
            chalk.red(`Failed to read --edit file: ${opts.edit}\n`) +
            `  ${err instanceof Error ? err.message : String(err)}\n`,
          );
          process.exitCode = 1;
          return;
        }
      }

      const payload = {
        approvedAt: new Date().toISOString(),
        approverId: resolveApprover(),
        ...(editDelta !== undefined ? { editDelta } : {}),
      };
      await writeFile(approvedPath, JSON.stringify(payload, null, 2) + "\n", "utf-8");

      process.stdout.write(
        chalk.green(`Approved checkpoint: ${checkpointId}\n`),
      );
    });
}
```

---

### `src/cli/commands/reject.ts` (create)

Same shape as approve.ts. Required: `--feedback <text>` (non-empty). Guard: pending file must exist.

```ts
program
  .command("reject <checkpointId>")
  .description("Reject a pending checkpoint by writing the .rejected.json marker")
  .requiredOption("--feedback <text>", "Why the checkpoint is rejected")
  .action(async (checkpointId: string, opts: { feedback: string }) => {
    // ... same guards as approve.ts ...
    const payload = {
      rejectedAt: new Date().toISOString(),
      rejecterId: resolveApprover(),
      feedback: opts.feedback,
    };
    await writeFile(rejectedPath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
    process.stdout.write(chalk.green(`Rejected checkpoint: ${checkpointId}\n`));
  });
```

---

### `src/cli/commands/list-approvals.ts` (create)

Enumerate `.bober/approvals/*.pending.json`, parse each, render as table OR JSON via `--json` flag.

```ts
program
  .command("list-approvals")
  .description("List all pending checkpoints awaiting approval")
  .option("--json", "Emit machine-readable JSON instead of a table")
  .action(async (opts: { json?: boolean }) => {
    const projectRoot = await resolveRoot();
    const approvalsDir = join(projectRoot, ".bober", "approvals");
    let entries: string[] = [];
    try {
      entries = await readdir(approvalsDir);
    } catch {
      // dir doesn't exist → no pending
    }
    const pending = entries.filter((f) => f.endsWith(".pending.json"));
    const rows: { checkpointId: string; ageMs: number; prompt: string }[] = [];
    for (const f of pending) {
      try {
        const raw = await readFile(join(approvalsDir, f), "utf-8");
        const parsed = JSON.parse(raw) as { checkpointId: string; prompt: string; requestedAt: string };
        rows.push({
          checkpointId: parsed.checkpointId,
          ageMs: Date.now() - Date.parse(parsed.requestedAt),
          prompt: parsed.prompt,
        });
      } catch { /* skip corrupted */ }
    }
    if (opts.json) {
      process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
      return;
    }
    if (rows.length === 0) {
      process.stdout.write("No pending checkpoints.\n");
      return;
    }
    // Simple human-readable table — column widths can be naive
    for (const r of rows) {
      process.stdout.write(
        `${r.checkpointId.padEnd(48)} ${formatAge(r.ageMs).padEnd(8)} ${r.prompt}\n`,
      );
    }
  });
```

---

### `src/cli/index.ts` (modify) — wire the three commands

**Relevant section (lines 12-23 — imports):**
```ts
import { registerGraphCommand } from "./commands/graph.js";
import { registerOnboardCommand } from "./commands/onboard.js";
import { registerImpactCommand } from "./commands/impact.js";
```
**Add:**
```ts
import { registerApproveCommand } from "./commands/approve.js";
import { registerRejectCommand }  from "./commands/reject.js";
import { registerListApprovalsCommand } from "./commands/list-approvals.js";
```

**Relevant section (lines 209-216 — registration calls):**
```ts
registerGraphCommand(program);
registerOnboardCommand(program);
registerImpactCommand(program);
```
**Add (after impact registration, before `program.parseAsync`):**
```ts
registerApproveCommand(program);
registerRejectCommand(program);
registerListApprovalsCommand(program);
```

---

### `src/state/index.ts` (modify) — add `'approvals'` to `SUBDIRS`

**Relevant section (lines 67-68):**
```ts
const BOBER_DIR = ".bober";
const SUBDIRS = ["contracts", "specs", "research", "designs", "outlines", "architecture", "briefings", "reviews"] as const;
```

**Change (add one entry):**
```ts
const SUBDIRS = ["contracts", "specs", "research", "designs", "outlines", "architecture", "briefings", "reviews", "approvals"] as const;
```

---

### `src/state/approval-state.ts` (create — RECOMMENDED, optional)

Mirror `src/state/review-state.ts` and `briefing-state.ts`. Keeps disk paths and JSON encoding in one place — CLI commands and the mechanism share helpers, no path drift.

```ts
import { readFile, writeFile, readdir, unlink, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { ensureDir } from "./helpers.js";

const APPROVAL_DIR = ".bober/approvals";

export interface PendingMarker {
  checkpointId: string;
  runId?: string;
  artifact: { type?: string; path?: string; summary?: string; lines?: number };
  prompt: string;
  requestedAt: string;
  timeoutAt: string;
}
export interface ApprovedMarker  { approvedAt: string;  approverId: string; editDelta?: unknown }
export interface RejectedMarker  { rejectedAt: string;  rejecterId: string; feedback: string }

const approvalsDir = (root: string): string => join(root, APPROVAL_DIR);
const pendingPath  = (root: string, id: string): string => join(approvalsDir(root), `${id}.pending.json`);
const approvedPath = (root: string, id: string): string => join(approvalsDir(root), `${id}.approved.json`);
const rejectedPath = (root: string, id: string): string => join(approvalsDir(root), `${id}.rejected.json`);

export async function savePending(root: string, m: PendingMarker): Promise<void> {
  await ensureDir(approvalsDir(root));
  await writeFile(pendingPath(root, m.checkpointId), JSON.stringify(m, null, 2) + "\n", "utf-8");
}
export async function readPending(root: string, id: string): Promise<PendingMarker | null> {
  try { return JSON.parse(await readFile(pendingPath(root, id), "utf-8")) as PendingMarker; }
  catch { return null; }
}
export async function listPending(root: string): Promise<PendingMarker[]> {
  let entries: string[] = [];
  try { entries = await readdir(approvalsDir(root)); } catch { return []; }
  const out: PendingMarker[] = [];
  for (const f of entries.filter((x) => x.endsWith(".pending.json"))) {
    try { out.push(JSON.parse(await readFile(join(approvalsDir(root), f), "utf-8"))); } catch { /* skip */ }
  }
  return out;
}
export async function saveApproved(root: string, id: string, m: ApprovedMarker): Promise<void> {
  await ensureDir(approvalsDir(root));
  await writeFile(approvedPath(root, id), JSON.stringify(m, null, 2) + "\n", "utf-8");
}
export async function saveRejected(root: string, id: string, m: RejectedMarker): Promise<void> {
  await ensureDir(approvalsDir(root));
  await writeFile(rejectedPath(root, id), JSON.stringify(m, null, 2) + "\n", "utf-8");
}
export async function deletePending(root: string, id: string): Promise<void> {
  await unlink(pendingPath(root, id)).catch(() => {});
}
export async function pendingExists(root: string, id: string): Promise<boolean> {
  try { await access(pendingPath(root, id), constants.R_OK); return true; } catch { return false; }
}
```
If created, the disk mechanism + the three CLI commands all `import { ... } from "../../state/approval-state.js"` (or `"../state/approval-state.js"` from CLI commands). Decision rests with the Generator — but the lift is small and matches the codebase convention exactly.

---

## 2. Sprint 8 Patterns to Clone

### Pattern 2.1 — Constructor-injected dependencies for testability
**Source:** `src/orchestrator/checkpoints/mechanisms/cli.ts`, lines 132-147
```ts
export class CliCheckpointMechanism implements CheckpointMechanism {
  constructor(
    private readonly fallback: CheckpointMechanism = DEFAULT_NOOP,
    private readonly stdin: Readable = process.stdin as Readable,
    private readonly editor?: string,
  ) {}
}
```
**Rule:** Every external dependency (filesystem path, polling interval, clock, runId) goes through the constructor with a sensible default. Tests inject `mkdtemp()`-based temp dir + fast `pollMs=10` + deterministic `now()` instead of monkey-patching the real fs.

### Pattern 2.2 — Module-load registration
**Source:** `src/orchestrator/checkpoints/registry.ts`, lines 31-34
```ts
// Self-register the noop mechanism at module init.
registerCheckpointMechanism("noop", new NoopCheckpointMechanism());
registerCheckpointMechanism("cli", new CliCheckpointMechanism());
```
**Rule:** Add `registerCheckpointMechanism("disk", new DiskCheckpointMechanism(...));` as the third line. No lazy init, no factory wrapper — match the existing two registrations exactly. The coordinator imports `getCheckpointMechanism("disk")` and never touches the class directly.

### Pattern 2.3 — Colocated test next to source
**Source:** `src/orchestrator/checkpoints/mechanisms/cli.test.ts`, lines 1-10
```
* Placed at src/orchestrator/checkpoints/mechanisms/cli.test.ts per the
* COLOCATION HARD CONSTRAINT in Sprint 8 briefing — NOT in tests/orchestrator/.
* This keeps the colocated:separate test ratio at 25:22, preserving the
* Sprint 5 scanner regression assertion (colocated >= separate).
```
**Rule:** New unit test for the disk mechanism goes at `src/orchestrator/checkpoints/mechanisms/disk.test.ts` (sibling of `disk.ts`). CLI tests go at `src/cli/commands/approve.test.ts` etc. (sibling of `approve.ts`).

---

## 3. COLOCATION HARD CONSTRAINT — Full reasoning + correct paths

**Why this matters:** Sprint 5 added a scanner test asserting `colocated >= separate` test files. Current ratio: **25 colocated : 22 separate**. Each new test in `tests/` narrows that margin; once it flips, the scanner test fails and the eval blocks the sprint. Sprint 7 (`checkpoints.test.ts`), Sprint 8 (`cli.test.ts`), and Sprint 10 (`impact.test.ts`, `plan.test.ts`) all explicitly fought this same regression.

**The contract is wrong.** `expectedChanges` lists `tests/orchestrator/checkpoints/disk.test.ts`. **IGNORE THIS** — it predates the colocation precedent. Place tests at the colocated locations below.

**Correct test file locations for this sprint:**

| Source file | Test file (REQUIRED location) |
|---|---|
| `src/orchestrator/checkpoints/mechanisms/disk.ts` | `src/orchestrator/checkpoints/mechanisms/disk.test.ts` |
| `src/cli/commands/approve.ts` | `src/cli/commands/approve.test.ts` |
| `src/cli/commands/reject.ts` | `src/cli/commands/reject.test.ts` |
| `src/cli/commands/list-approvals.ts` | `src/cli/commands/list-approvals.test.ts` |

**Net ratio impact:** +1 to +4 colocated; +0 separate. Ratio improves to **26:22 → 29:22**.

**Generator MUST NOT** create `tests/orchestrator/checkpoints/disk.test.ts` or any other file under the `tests/` tree. The contract's expectedChanges is a known-stale path; the briefing overrides it.

---

## 4. `src/cli/` Framework Analysis

**Framework:** `commander@^13` (see `package.json` deps).
**Entry point:** `src/cli/index.ts` builds a `program = new Command()`, attaches each subcommand, and calls `program.parseAsync(process.argv)`.
**Commands live in:** `src/cli/commands/*.ts`. Tests are colocated (e.g. `impact.test.ts`, `plan.test.ts`).

### Two registration styles co-exist:

**Style A — run-function (older, used by `init`, `plan`, `sprint`, `eval`, `run`, `mcp`):**
`src/cli/index.ts:78-90`:
```ts
program
  .command("init [preset]")
  .description("Initialize bober in the current project")
  .action(async (presetArg?: string, cmdOpts?: { preset?: string }) => {
    const projectRoot = process.cwd();
    await runInitCommand(projectRoot, { preset });
  });
```

**Style B — register function (newer, used by `graph`, `onboard`, `impact`; SPRINT 9 USES THIS):**
`src/cli/index.ts:209-216`:
```ts
registerGraphCommand(program);
registerOnboardCommand(program);
registerImpactCommand(program);
```
And inside `src/cli/commands/impact.ts:74-80`:
```ts
export function registerImpactCommand(program: Command): void {
  program
    .command("impact <target>")
    .description("Analyse the impact radius of a symbol or file in the code graph")
    .action(async (target: string) => { /* ... */ });
}
```
**Rule for Sprint 9:** Use Style B. It's the more recent pattern and keeps `src/cli/index.ts` short.

### Project-root resolution (CLI must work from any cwd)

`src/utils/fs.ts:58-79` defines:
```ts
export async function findProjectRoot(startDir?: string): Promise<string | null> {
  let dir = resolve(startDir ?? process.cwd());
  const markers = ["bober.config.json", "package.json"];
  for (;;) {
    for (const marker of markers) {
      if (await fileExists(join(dir, marker))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
```
All Style-B commands use the same helper (see `impact.ts:63-66`, `onboard.ts:36-39`, `graph.ts:24-27`):
```ts
async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}
```
**Sprint 9 CLI commands MUST use this helper** — DO NOT just use `process.cwd()`. Without it, `bober approve` would fail when run from a subdirectory.

### Test pattern for CLI commands

`src/cli/commands/impact.test.ts:1-12` shows the colocated test pattern (pure function tests):
```ts
import { describe, it, expect } from "vitest";
import { deriveSlug } from "./impact.js";

describe("deriveSlug", () => {
  it("lowercases camelCase input", () => {
    expect(deriveSlug("sandboxPath")).toBe("sandboxpath");
  });
  // ...
});
```

`src/cli/commands/plan.test.ts:1-45` shows the pattern for tests that hit the filesystem — `mkdtemp(tmpdir(), ...)`, `rm({recursive,force})` in afterEach, spy on `console.log`:
```ts
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "bober-plan-answer-"));
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  process.exitCode = undefined;
});
afterEach(async () => {
  consoleLogSpy.mockRestore();
  await rm(tmpRoot, { recursive: true, force: true });
});
```
**Sprint 9 CLI tests should clone this pattern** — mkdtemp for a fake project root containing `.bober/approvals/`, then exercise `registerApproveCommand` end-to-end. Or test the underlying helper directly (e.g. `resolveApprover()`, `formatAge()`) for fast unit coverage.

---

## 5. `src/state/approval-state.ts` Design

(See full template in Section 1.) Mirrors `review-state.ts` (file: `src/state/review-state.ts`, 65 lines):

| API | Purpose |
|---|---|
| `savePending(root, marker)` | Disk mechanism writes the pending marker |
| `readPending(root, id)` | CLI commands fetch the pending marker (null if missing) |
| `listPending(root)` | `list-approvals` enumerates all pending markers |
| `saveApproved(root, id, marker)` | `bober approve` writes the resolution |
| `saveRejected(root, id, marker)` | `bober reject` writes the resolution |
| `deletePending(root, id)` | Disk mechanism cleanup after resolution / timeout |
| `pendingExists(root, id)` | CLI guard: `approve` and `reject` refuse to run on unknown ids |

**File-shape constants live here**, NOT in the disk mechanism — single source of truth. Re-export from `src/state/index.ts` for the existing pattern:
```ts
export {
  savePending,
  readPending,
  listPending,
  saveApproved,
  saveRejected,
  deletePending,
  pendingExists,
} from "./approval-state.js";
```

---

## 6. `src/state/index.ts` SUBDIRS Addition

**Existing line — `src/state/index.ts:68`:**
```ts
const SUBDIRS = ["contracts", "specs", "research", "designs", "outlines", "architecture", "briefings", "reviews"] as const;
```

**Sprint 9 change (add `"approvals"`):**
```ts
const SUBDIRS = ["contracts", "specs", "research", "designs", "outlines", "architecture", "briefings", "reviews", "approvals"] as const;
```
This is precisely the pattern Sprint 5 used to add `"reviews"` — straight clone, zero ambiguity. The disk mechanism already calls `mkdir({recursive:true})` so this is belt-and-suspenders; it primarily helps `bober init` lay out the directory on first use.

---

## 7. Pending File Shape (verbatim from contract)

```json
{
  "checkpointId": "post-research-spec-20260524-foo-1",
  "runId": "run-20260524-153000",
  "artifact": { "type": "research-doc", "path": ".bober/research/...", "summary": "..." },
  "prompt": "Research artifact ready for review.",
  "requestedAt": "2026-05-24T15:30:00Z",
  "timeoutAt": "2026-05-25T15:30:00Z"
}
```

**Approved file:**
```json
{
  "approvedAt": "2026-05-24T16:00:00Z",
  "approverId": "alice",
  "editDelta": "<optional — text or JSON>"
}
```

**Rejected file:**
```json
{
  "rejectedAt": "2026-05-24T16:00:00Z",
  "rejecterId": "alice",
  "feedback": "needs more detail on auth flow"
}
```

**Timeout marker (mechanism-written):**
```json
{ "checkpointId": "...", "timedOutAt": "..." }
```

---

## 8. Polling Pattern with try/finally Cleanup (CRITICAL — no leaked timers)

**Per evaluatorNotes:** "verify polling does not leak — when request() returns, the poll loop (or fs.watch handle) is cleaned up. Run a unit test that creates 10 checkpoints in parallel and verifies all 10 resolve and 0 watchers remain."

**Required shape:**
```ts
let pollHandle: ReturnType<typeof setTimeout> | undefined;
try {
  return await new Promise<CheckpointOutcome>((resolve, reject) => {
    const tick = async () => {
      // check fs, maybe resolve(), else: pollHandle = setTimeout(tick, pollMs);
    };
    pollHandle = setTimeout(tick, pollMs);
  });
} finally {
  if (pollHandle) clearTimeout(pollHandle);  // never leak
}
```

**Why `setTimeout`+recursion, not `setInterval`:**
- The check is `async` (fs reads). With `setInterval`, slow ticks overlap; with `setTimeout(tick, pollMs)` you guarantee serialized polls.
- Cleanup is one `clearTimeout` regardless of how many ticks have fired.

**Why NOT `fs.watch`/chokidar:**
- `chokidar` is not in `package.json` deps (verified — only `chalk`, `commander`, `execa`, `glob`, `ora`, `prompts`, `semver`, `zod` plus MCP/SDK). Adding it is out of scope.
- Node's `fs.watch` has [well-documented platform quirks](https://nodejs.org/api/fs.html#caveats) (macOS uses FSEvents, Linux uses inotify limits, Windows file locking) — not worth the complexity at 2-second polling.
- Polling at 2s gives <2s perceived latency, which is fine for the async use case (PR-style review).

**Test for the leak (recommended):**
```ts
it("does not leak timers across 10 parallel checkpoints", async () => {
  const before = process.getActiveResourcesInfo?.().filter((r) => r === "Timeout").length ?? 0;
  const m = new DiskCheckpointMechanism(tmpDir, { pollMs: 10 });
  // Resolve immediately by pre-writing approved markers
  for (let i = 0; i < 10; i++) {
    await writeFile(join(tmpDir, `cp-${i}.approved.json`),
      JSON.stringify({approvedAt:"x",approverId:"y"}));
  }
  await Promise.all(Array.from({length: 10},
    (_, i) => m.request(`cp-${i}` as CheckpointId, {})));
  const after = process.getActiveResourcesInfo?.().filter((r) => r === "Timeout").length ?? 0;
  expect(after).toBeLessThanOrEqual(before);
});
```

---

## 9. Race-Condition Handling — Last-Write-Wins

**Per evaluatorNotes (verbatim):** "what if approve and reject CLI commands race? Spec: last-write-wins is acceptable; the mechanism polls and consumes the first resolution it sees. Verify the pending file is DELETED after resolution (otherwise on next pipeline run with same checkpoint id, the orchestrator would re-resolve incorrectly)."

**Implementation:**
1. The disk mechanism's tick loop checks `entries.has("<id>.approved.json")` BEFORE `entries.has("<id>.rejected.json")`. Either branch resolves the promise.
2. The chosen branch reads the file, then calls `unlink(pendingPath).catch(() => {})` AND `unlink(resolvedPath).catch(() => {})`. Both are best-effort — the unlinks are idempotent.
3. The "loser" of the race leaves its marker on disk, but since the pending is gone, the orchestrator never re-polls. On next pipeline run with the same id, the stale loser marker is still ignored because `savePending()` overwrites the pending (and the mechanism only triggers on `.approved.json` / `.rejected.json` appearing AFTER its own write — but to be safe, the mechanism should also `unlink` any stale approved/rejected for the same id at the start of `request()`).

**Recommended hardening (extra unlinks at start of `request()`):**
```ts
await mkdir(this.approvalsDir, { recursive: true });
// Clean stale markers from a prior run (race-condition safety).
await unlink(join(this.approvalsDir, `${checkpoint}.approved.json`)).catch(() => {});
await unlink(join(this.approvalsDir, `${checkpoint}.rejected.json`)).catch(() => {});
await unlink(join(this.approvalsDir, `${checkpoint}.timeout.json`)).catch(() => {});
```

---

## 10. `$USER` / Approver Resolution

**Per generatorNotes:** "approverId (resolved from $USER or git config)".

**Recommended (lightweight, no git dependency):**
```ts
function resolveApprover(): string {
  return process.env["USER"] ?? process.env["USERNAME"] ?? "unknown";
}
```
- `USER` on macOS/Linux, `USERNAME` on Windows.
- Use bracket notation `process.env["USER"]` to satisfy the strict-typecheck rule used elsewhere in the codebase (`src/orchestrator/checkpoints/mechanisms/cli.ts:205` uses `process.env["EDITOR"]`).

`git config user.email` is overkill for a marker file — adds a `child_process.execFile` call and fails ungracefully in non-git directories. Mention it in a code comment as a future enhancement; do NOT implement it for Sprint 9.

---

## 11. Performance Budget — 100ms Write (Critical)

**Per evaluatorNotes (verbatim):** "100ms write budget is strict. If using JSON.stringify on a large artifact, that alone could blow budget. Mechanism should write a summary, not the full artifact — full artifact stays on disk wherever the pipeline put it (e.g., .bober/research/*.md), pending file references it by path."

**Concrete rule for `request()`:**
- The `artifact` field in the pending file MUST be a small object: `{ type?, path?, summary?, lines? }`.
- Do NOT call `JSON.stringify(artifact)` directly on the raw input — the input could be a multi-MB ResearchDoc/PlanSpec.
- Use a `summarizeArtifact(raw)` helper (see template in Section 1) that hand-picks only the four whitelisted fields.

**Microbenchmark for `s9-c6`:**
```ts
it("write phase completes in <100ms even for large artifacts", async () => {
  const m = new DiskCheckpointMechanism(tmpDir, { pollMs: 5_000 });
  const huge = { type: "x", path: ".bober/x.md", summary: "ok", lines: 999,
                 fullContent: "a".repeat(5_000_000) };  // 5MB blob that should be IGNORED
  // Pre-stuff approved so the poll resolves on the first tick after the write.
  const writePromise = m.request("post-plan", huge);
  // Race: the write itself must already be on disk before pollMs ticks.
  const start = performance.now();
  // small async tick to let writeFile resolve
  while (!existsSync(join(tmpDir, "post-plan.pending.json"))) {
    await new Promise((r) => setImmediate(r));
    if (performance.now() - start > 100) break;
  }
  expect(performance.now() - start).toBeLessThan(100);
  // Resolve the request to clean up.
  await writeFile(join(tmpDir, "post-plan.approved.json"),
    JSON.stringify({approvedAt:"x",approverId:"y"}));
  await writePromise;
});
```

---

## 12. Implementation Sequence (DEPENDENCY-ORDERED)

1. **`src/state/index.ts`** — add `"approvals"` to `SUBDIRS` (line 68). One-line clone of the `"reviews"` precedent.
   - Verify: `npm run typecheck` still passes.

2. **`src/state/approval-state.ts`** (recommended, optional) — clone `review-state.ts` shape, add the seven exports listed in Section 5. Re-export from `src/state/index.ts`.
   - Verify: typecheck. Helpers compile in isolation (no consumers yet).

3. **`src/orchestrator/checkpoints/mechanisms/disk.ts`** — implement `DiskCheckpointMechanism` with constructor injection (Section 1 template). Use `approval-state.ts` helpers if you created them; otherwise inline `fs/promises` calls. Enforce: `summarizeArtifact()`, try/finally timer cleanup, last-write-wins, stale-marker cleanup, 7-day timeout cap.
   - Verify: typecheck. Nothing imports it yet, so no runtime impact on other code.

4. **`src/orchestrator/checkpoints/mechanisms/disk.test.ts`** (COLOCATED) — cover all 7 sub-criteria from `s9-c7`: (a) approve flow, (b) reject + feedback, (c) edit with editDelta, (d) timeout writes marker + returns `{approved:false, feedback:"TIMEOUT"}`, (e+f+g) the three CLI flows. Plus: leaked-timer test (Section 8), perf test (Section 11).
   - Verify: `npm run test src/orchestrator/checkpoints/mechanisms/disk.test.ts` — all green.

5. **`src/orchestrator/checkpoints/registry.ts`** — add `DiskCheckpointMechanism` import and one `registerCheckpointMechanism("disk", ...)` line at the bottom (Section 1).
   - Verify: `getCheckpointMechanism("disk")` returns the instance — extend `checkpoints.test.ts` with a one-liner check (or rely on the registry test that already iterates).
   - Verify: `s9-c8` satisfied.

6. **`src/cli/commands/approve.ts`** — Style-B register function, `findProjectRoot()` for cwd, pendingExists guard, `--edit` option (Section 1).

7. **`src/cli/commands/reject.ts`** — same shape with `requiredOption("--feedback <text>")`.

8. **`src/cli/commands/list-approvals.ts`** — table by default, `--json` flag for scripting (Section 1).

9. **`src/cli/commands/{approve,reject,list-approvals}.test.ts`** (COLOCATED) — mkdtemp project root, exercise via `program.parseAsync(["node","bober","approve","..."])` OR (simpler) directly call exported helpers (e.g. `resolveApprover()`).

10. **`src/cli/index.ts`** — three import lines + three `registerXxxCommand(program)` calls (Section 1).
    - Verify: `node dist/cli/index.js --help` after `npm run build` lists `approve`, `reject`, `list-approvals`.

11. **Run full verification** in this order:
    ```
    npm run typecheck   # MUST exit 0  (s9-c9)
    npm run lint        # MUST exit 0  (s9-c9)
    npm run build       # MUST exit 0  (s9-c9)
    npm run test        # MUST exit 0, all branches in s9-c7 green
    ```
    Also: confirm Sprint 5 scanner test (which enforces colocated >= separate) still passes — it will, because we added 4 colocated and 0 separate.

---

## 13. Verification Checklist (per criterion)

| # | Criterion | How the Generator verifies |
|---|---|---|
| **s9-c1** | disk.ts implements interface, writes pending shape, polls dir | Open file. Confirm `implements CheckpointMechanism`, fields match Section 7 shape, `setTimeout` tick loop present |
| **s9-c2** | Resolution detection + pending deletion | Read the tick body — both branches read+parse the marker, return shaped outcome, `unlink(pendingPath)` called |
| **s9-c3** | Timeout configurable + 7-day cap + TIMEOUT feedback | Confirm `Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)` and the timeout branch writes marker + returns `{approved:false, feedback:"TIMEOUT"}` |
| **s9-c4** | approve / reject CLI commands | `node dist/cli/index.js approve --help` and `reject --help` show options. Test: write a `.pending.json`, run `bober approve <id>`, confirm `.approved.json` exists and `.pending.json` is gone |
| **s9-c5** | list-approvals lists pending with id+age+prompt | Write 2 pending files, run `bober list-approvals`, confirm table OR `--json` array |
| **s9-c6** | Write under 100ms | Run microbench test; assert `<100ms` |
| **s9-c7** | Unit tests cover 7 flows | All COLOCATED tests pass; coverage of approve / reject / edit / timeout / 3 CLI commands |
| **s9-c8** | Registered under "disk" at module load | `grep -n '"disk"' src/orchestrator/checkpoints/registry.ts` → finds one line; `getCheckpointMechanism("disk")` returns instance |
| **s9-c9** | All eval strategies pass | `npm run typecheck && npm run lint && npm run build && npm run test` all exit 0 |

---

## 14. Pitfalls & Warnings

- **DO NOT** create `tests/orchestrator/checkpoints/disk.test.ts`. Contract's `expectedChanges` is wrong; colocation is mandatory.
- **DO NOT** stringify the raw artifact into the pending file — use `summarizeArtifact()` to keep the write under 100ms.
- **DO NOT** use `setInterval`. Use recursive `setTimeout`. `setInterval` overlaps async ticks and is harder to cancel atomically in `finally`.
- **DO NOT** add chokidar to `package.json`. It's not in the deps and adding a dependency for one mechanism is out of scope.
- **DO NOT** forget the `try/finally` around the polling promise. A thrown error without cleanup leaks a `setTimeout` and the leak test will fail.
- **DO NOT** use `process.cwd()` from inside the CLI command body — use `findProjectRoot()` so commands work from any subdirectory.
- **DO NOT** write a dangling `.approved.json` for a checkpoint id that has no pending file. Both `approve` and `reject` MUST `pendingExists()` first and exit non-zero with a clear error otherwise.
- **DO NOT** omit `await unlink(...).catch(() => {})` after consuming a marker — without cleanup, the next pipeline run with the same checkpoint id will re-resolve from a stale marker.
- **DO** use `process.env["KEY"]` (bracket notation) — the project's tsconfig has `noPropertyAccessFromIndexSignature` or similar that rejects `process.env.KEY` in some files. Match the precedent in `cli.ts:205`.
- **DO** prefer `Style B` (`registerXxxCommand(program)`) for new CLI commands — Style A (`runXxxCommand`) is the older pattern.
- **DO** add `"approvals"` to `SUBDIRS` in `src/state/index.ts:68`. Even though the mechanism `mkdir`s on demand, the bober init flow expects the dir tree.

---

## 15. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---|---|---|---|
| `findProjectRoot` | `src/utils/fs.ts:58` | `(startDir?: string) => Promise<string \| null>` | Walks upward from cwd for `bober.config.json` / `package.json` — every CLI command MUST use this |
| `fileExists` | `src/utils/fs.ts:10` | `(path: string) => Promise<boolean>` | Quick R_OK check; useful for pre-flight |
| `readJson<T>` | `src/utils/fs.ts:24` | `(path: string) => Promise<T>` | Parse JSON file; alternative to manual `readFile`+`JSON.parse` |
| `writeJson` | `src/utils/fs.ts:34` | `(path: string, data: unknown) => Promise<void>` | Pretty-printed JSON write with ensureDir on parent |
| `ensureDir` | `src/utils/fs.ts:45` AND `src/state/helpers.ts:6` | `(path: string) => Promise<void>` | `mkdir({recursive:true})` wrapper |
| `getCheckpointMechanism` | `src/orchestrator/checkpoints/registry.ts:21` | `(name: string) => CheckpointMechanism` | Resolve mechanism by name from registry |
| `registerCheckpointMechanism` | `src/orchestrator/checkpoints/registry.ts:17` | `(name: string, impl: CheckpointMechanism) => void` | Self-registration at module load |
| `chalk.{green,red,yellow,cyan,gray}` | `chalk` dep | `(s: string) => string` | All CLI status output — match `impact.ts` style |
| `Command` | `commander` dep | class | CLI program / subcommand builder |
| `process.env["USER"]` / `process.env["USERNAME"]` | env | string \| undefined | Approver name; use both with `unknown` fallback |

---

## 16. Relevant Documentation

### Project Principles
**No `.bober/principles.md` found.** Sprint 9 has no project-wide principles file to reference.

### Architecture Decisions
**No `.bober/architecture/` directory found.** The contract references `arch-20260524-port-code-review-graph-architecture.md` from elsewhere but it's a graph-specific doc not in the repo at briefing time.

### Codebase conventions (inferred + verified)
- **ES Modules** (`"type": "module"` in package.json). All imports use `.js` extensions even for `.ts` source (`import "../types.js"` resolves to `types.ts` via tsc emit).
- **Path style:** `node:fs/promises`, `node:path`, `node:os`, `node:crypto` — always the `node:` prefix.
- **Test runner:** Vitest (`"test": "vitest"`). Imports: `import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"`.
- **Linting:** ESLint with `@typescript-eslint/eslint-plugin`. Strict — bracket-notation for env vars.
- **Logger:** `src/utils/logger.ts` exists for verbose CLI output, but the existing approve-style commands (`graph`, `onboard`, `impact`) all use `process.stdout.write` / `process.stderr.write` directly with `chalk`. Match that convention.

