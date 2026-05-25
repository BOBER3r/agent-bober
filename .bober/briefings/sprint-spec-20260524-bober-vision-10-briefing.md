# Sprint Briefing: GitHub PR-native checkpoint mechanism

**Contract:** `sprint-spec-20260524-bober-vision-10`
**Generated:** 2026-05-25T04:25:00Z
**Tier:** 2 (sprint 4/4 of the Tier 2 checkpoint-mechanism family)
**Depends on:** Sprint 9 (disk mechanism — used as fallback), Sprint 8 (cli mechanism + colocated test precedent), Sprint 7 (CheckpointMechanism interface, registry).

---

## 0. Sprint Summary

Implement the **PR-native checkpoint mechanism** (`src/orchestrator/checkpoints/mechanisms/pr.ts`) that uses the `gh` CLI to (a) open a single draft "run-tracking PR" on the first checkpoint of a `bober run`, (b) append a checkpoint comment per subsequent checkpoint, (c) poll the PR until merge / labeled approval / approve-comment / reject-comment / edit-comment, and (d) fall back to the `disk` mechanism when `gh` is unavailable (gh missing, gh not authed, no GitHub remote). Register it under name `"pr"` in `registry.ts`, plus add a per-checkpoint override resolver (`getCheckpointMechanismFor(checkpointId, config)`) — Sprint 14 will wire the config, this sprint only provides the resolution hook.

**CRITICAL CONFLICTS TO RESOLVE FIRST**

1. **Colocated tests, not `tests/`**: The contract's `expectedChanges` says `tests/orchestrator/checkpoints/pr.test.ts` — but Sprints 8 and 9 BOTH used colocated tests (`src/orchestrator/checkpoints/mechanisms/{cli,disk}.test.ts`). The Sprint 5 scanner enforces `colocated >= separate` ratio (currently 26:22 after Sprint 9). The new test MUST go at `src/orchestrator/checkpoints/mechanisms/pr.test.ts`. The success criterion `s10-c8` says "Locate test file" — no path mandate. Match the established Sprint 8/9 precedent.

2. **Fallback target is DISK, not noop/cli**: Per `evaluatorNotes`: "fallback chain: pr unavailable → disk. Disk is more reliable; CLI is interactive-only. The fallback should NOT be to cli." Sprint 8's cli mechanism falls back to noop; Sprint 10's pr mechanism falls back to **disk**. The pr constructor must accept an injected disk-like fallback mechanism instance (defaulting to a fresh `DiskCheckpointMechanism` rooted at `.bober/approvals`).

3. **Single `gh` helper seam**: Per `evaluatorNotes`: "Verify gh CLI calls are all going through a single helper function (e.g., gh.ts wrapping execa) — easier to mock and audit." Define a `GhClient` interface inside `pr.ts` (or extract a private module-local helper) and inject it via the constructor. Tests then mock the GhClient at the seam, not at `vi.mock("execa")` (avoid module-level execa mock leaking into other tests).

4. **NEVER call real `gh` in tests**: "the unit test must NOT actually call gh. Mock at the execa level. A test that creates a real PR is a failure (rollback required)." Inject the GhClient — do not let any code path reach the real `execa("gh", ...)` during the test.

---

## 1. Target Files

### `src/orchestrator/checkpoints/mechanisms/pr.ts` (create)

**Directory pattern:** `src/orchestrator/checkpoints/mechanisms/` — established by Sprint 8. Files use kebab-case singular names (one file per mechanism class). Class names follow `<Name>CheckpointMechanism` (e.g., `CliCheckpointMechanism`, `DiskCheckpointMechanism`, → `PrCheckpointMechanism`).

**Most similar existing files:**
- `src/orchestrator/checkpoints/mechanisms/disk.ts` (185 lines) — for poll loop + timeout pattern + constructor-injected clock.
- `src/orchestrator/checkpoints/mechanisms/cli.ts` (230 lines) — for fallback injection + constructor seam pattern.

**Structure template (composite of cli.ts + disk.ts patterns):**
```ts
/**
 * GitHub PR-native checkpoint mechanism.
 *
 * On request(): opens a draft PR per `bober run` (idempotent — reuses
 * existing run-tracking PR) and appends a checkpoint comment. Polls the PR
 * for resolution via: (a) merge → auto-approve all pending, (b) 'approve
 * <checkpointId>' comment or 'bober/approved-<id>' label, (c) 'reject
 * <checkpointId> <feedback>' comment, (d) 'edit <checkpointId>\n```...```'
 * comment. Falls back to disk mechanism with a warning when gh is unavailable.
 *
 * Sprint 10 — colocated in mechanisms/ per Sprint 7+8+9 precedent.
 */

import { execa } from "execa";
import { join } from "node:path";
import type {
  CheckpointArtifact,
  CheckpointId,
  CheckpointMechanism,
  CheckpointOutcome,
} from "../types.js";
import { DiskCheckpointMechanism } from "./disk.js";

const DEFAULT_POLL_MS = 30_000;           // PRs are async; 30s default
const MIN_POLL_MS = 10_000;               // GitHub secondary rate limits
const DEFAULT_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000; // 7d cap (mirrors disk)

/** Single mockable seam for all `gh` CLI calls. */
export interface GhClient {
  version(): Promise<{ ok: boolean; stdout: string }>;
  authStatus(): Promise<{ ok: boolean; stderr: string }>;
  repoView(): Promise<{ url: string; owner: string; name: string } | null>;
  prList(headRef: string): Promise<Array<{ number: number; state: string }>>;
  prCreate(opts: { title: string; body: string; draft: boolean }): Promise<{ number: number; url: string }>;
  prComment(prNumber: number, body: string): Promise<void>;
  prView(prNumber: number): Promise<{
    state: string;
    merged: boolean;
    labels: Array<{ name: string }>;
    comments: Array<{ id: number; body: string; createdAt: string }>;
  }>;
}

/** Default GhClient implementation — wraps execa. */
export function createGhClient(cwd: string): GhClient {
  return {
    async version() {
      const r = await execa("gh", ["--version"], { reject: false, timeout: 5000 });
      return { ok: r.exitCode === 0, stdout: r.stdout ?? "" };
    },
    async authStatus() {
      const r = await execa("gh", ["auth", "status"], { reject: false, timeout: 5000 });
      return { ok: r.exitCode === 0, stderr: r.stderr ?? "" };
    },
    async repoView() {
      const r = await execa(
        "gh",
        ["repo", "view", "--json", "url,owner,name"],
        { cwd, reject: false, timeout: 5000 },
      );
      if (r.exitCode !== 0) return null;
      try {
        const j = JSON.parse(r.stdout ?? "{}") as {
          url: string;
          owner: { login: string };
          name: string;
        };
        return { url: j.url, owner: j.owner.login, name: j.name };
      } catch { return null; }
    },
    async prList(headRef) { /* gh pr list --head <ref> --json number,state */ },
    async prCreate({ title, body, draft }) { /* gh pr create --draft ... */ },
    async prComment(n, body) { /* gh pr comment <n> --body ... */ },
    async prView(n) { /* gh pr view <n> --json state,merged,labels,comments */ },
  };
}

export interface PrMechanismOptions {
  /** Default 30_000ms; floor 10_000ms (GitHub rate limits). Configurable via pipeline.prPollMs. */
  pollMs?: number;
  /** Default 7d; matches disk cap. */
  timeoutMs?: number;
  /** Required — one PR per run, reused across checkpoints. */
  runId?: string;
  /** Used in the PR title — e.g., "bober(run-XXX): <featureName>". */
  featureName?: string;
}

export class PrCheckpointMechanism implements CheckpointMechanism {
  /** Cached PR number for this run — set on first request(), reused thereafter. */
  private runPrNumber: number | null = null;

  /**
   * @param gh        - Mockable GhClient. Tests pass a fake; prod uses createGhClient(cwd).
   * @param fallback  - Mechanism used when gh is unavailable. Defaults to DiskCheckpointMechanism
   *                    rooted at <cwd>/.bober/approvals. MUST be disk (not cli/noop) per evaluator note.
   * @param options   - poll/timeout/runId/featureName.
   * @param now       - Clock injection for deterministic timeout tests (matches disk.ts:69).
   */
  constructor(
    private readonly gh: GhClient,
    private readonly fallback: CheckpointMechanism,
    private readonly options: PrMechanismOptions = {},
    private readonly now: () => number = () => Date.now(),
  ) {}

  async request(checkpoint: CheckpointId, artifact: CheckpointArtifact): Promise<CheckpointOutcome> {
    // 1) Availability check (s10-c4) — gh version, gh auth, gh repo view.
    const avail = await this.checkAvailability();
    if (!avail.ok) {
      process.stderr.write(
        `warn: PR checkpoint "${checkpoint}" requested but gh is unavailable (${avail.reason}); falling back to disk mechanism. Run \`gh auth login\` to enable PR checkpoints.\n`,
      );
      return this.fallback.request(checkpoint, artifact);
    }

    // 2) Find or create the run-tracking PR.
    const prNumber = await this.ensureRunPr(avail.headRef);

    // 3) Append the checkpoint comment.
    await this.gh.prComment(
      prNumber,
      this.renderCheckpointComment(checkpoint, artifact),
    );

    // 4) Poll for resolution (merge / approve / reject / edit) with exponential
    //    back-off on rate-limit errors (cap at 5 minutes per evaluatorNotes).
    return this.pollPrUntilResolved(prNumber, checkpoint);
  }

  // ── private helpers ──
  // checkAvailability(): { ok: true, headRef } | { ok: false, reason }
  // ensureRunPr(headRef): reuses runPrNumber if set; else gh pr list / gh pr create
  // renderCheckpointComment(id, artifact): plain markdown body
  // pollPrUntilResolved(prNumber, checkpoint): loop + parseSignals
  // parseSignals(view, checkpoint): merge | approve | reject | edit | null
}
```

**Imports this file will use:**
- `execa` from `"execa"` (npm dep — see package.json:64)
- `node:path` for `join`
- Types from `"../types.js"` (CheckpointArtifact, CheckpointId, CheckpointMechanism, CheckpointOutcome)
- `DiskCheckpointMechanism` from `"./disk.js"` (default fallback)

**Imported by (after this sprint):**
- `src/orchestrator/checkpoints/registry.ts` (will add `registerCheckpointMechanism("pr", new PrCheckpointMechanism(...))`)

**Test file:** `src/orchestrator/checkpoints/mechanisms/pr.test.ts` — **MUST be colocated** (NOT `tests/orchestrator/checkpoints/pr.test.ts` as the contract's expectedChanges incorrectly states).

---

### `src/orchestrator/checkpoints/registry.ts` (modify)

**Current state (Sprint 9, 44 lines):**
```ts
import { join } from "node:path";
import type { CheckpointMechanism } from "./types.js";
import { NoopCheckpointMechanism } from "./noop.js";
import { CliCheckpointMechanism } from "./mechanisms/cli.js";
import { DiskCheckpointMechanism } from "./mechanisms/disk.js";

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

registerCheckpointMechanism("noop", new NoopCheckpointMechanism());
registerCheckpointMechanism("cli", new CliCheckpointMechanism());
registerCheckpointMechanism(
  "disk",
  new DiskCheckpointMechanism(join(process.cwd(), ".bober", "approvals")),
);
```

**Changes required:**

1. Add import + registration for `PrCheckpointMechanism` (s10-c7):
```ts
import { PrCheckpointMechanism, createGhClient } from "./mechanisms/pr.js";

// Self-register at module init. The PR mechanism's default fallback is the
// already-registered disk mechanism instance (NOT noop, NOT cli).
const cwd = process.cwd();
const diskForPrFallback = new DiskCheckpointMechanism(join(cwd, ".bober", "approvals"));
registerCheckpointMechanism(
  "pr",
  new PrCheckpointMechanism(createGhClient(cwd), diskForPrFallback),
);
```

2. Add the per-checkpoint override resolver hook (s10-c5):
```ts
// Minimal shape Sprint 14 will refine — for now we accept an optional partial config.
export interface CheckpointOverrideConfig {
  pipeline?: {
    checkpointMechanism?: string;             // global default
    checkpointOverrides?: Record<string, string>; // per-checkpoint override
  };
}

/**
 * Resolve the mechanism for a specific checkpoint. Order:
 *   1. config.pipeline.checkpointOverrides[checkpointId] (if set)
 *   2. config.pipeline.checkpointMechanism (global default; if set)
 *   3. fallback param (caller's default; e.g., "noop")
 *
 * Sprint 14 will wire the BoberConfig pipeline schema; this sprint just
 * provides the resolution hook so a future PR can plumb config end-to-end.
 */
export function getCheckpointMechanismFor(
  checkpointId: string,
  config: CheckpointOverrideConfig | undefined,
  fallback = "noop",
): CheckpointMechanism {
  const override = config?.pipeline?.checkpointOverrides?.[checkpointId];
  const global = config?.pipeline?.checkpointMechanism;
  return getCheckpointMechanism(override ?? global ?? fallback);
}
```

> NOTE: keep `getCheckpointMechanism(name)` unchanged — it is used by pipeline.ts on lines 140/235/298/355/390/485/621/651/713. Adding `getCheckpointMechanismFor` as a SIBLING (not a replacement) preserves back-compat. The contract says `s10-c5` only requires that the override HOOK exists; pipeline call-sites stay on `getCheckpointMechanism("noop")` until Sprint 14 wires config.

**Imports this file uses (current):** `node:path:join`, `./types.js`, `./noop.js`, `./mechanisms/cli.js`, `./mechanisms/disk.js`. **Add:** `./mechanisms/pr.js`.

**Imported by:**
- `src/orchestrator/checkpoints/index.ts:13` re-exports `registerCheckpointMechanism, getCheckpointMechanism`. **Update index.ts to also re-export `getCheckpointMechanismFor` and `CheckpointOverrideConfig`.**
- `src/orchestrator/pipeline.ts:35` imports `getCheckpointMechanism` (10 call-sites — see Section 7).

**Test file:** No test file currently exists for registry.ts. Either co-locate a small `registry.test.ts` next to it OR test the override resolution INSIDE `mechanisms/pr.test.ts` under a `describe("getCheckpointMechanismFor — override resolution (s10-c5)")` block. Colocated `registry.test.ts` is cleaner (improves the colocated:separate ratio further).

---

### `src/orchestrator/checkpoints/mechanisms/pr.test.ts` (create)

**Directory pattern:** Colocated, mirroring `cli.test.ts` (222 lines) and `disk.test.ts` (338 lines). Same kebab-case `<mechanism>.test.ts` naming.

**Required coverage (s10-c8 — all 5 branches):**
- (a) PR creation — first request creates a draft PR, second request reuses cached `runPrNumber` and only appends a comment.
- (b) Comment-driven approve — `prView` returns a comment "approve post-research" → outcome `{ approved: true }`.
- (c) Comment-driven reject — comment "reject post-research needs more detail" → outcome `{ approved: false, feedback: "needs more detail" }`.
- (d) PR merge auto-approves all pending — `prView` returns `merged: true` → outcome `{ approved: true }`.
- (e) gh-unavailable fallback to disk — `gh.version()` returns `{ ok: false }` → invokes injected disk fallback (spy verifies the **path** was taken, NOT just the outcome — mirrors `cli.test.ts:178-194`).

**Plus override resolution (s10-c5):**
- (f) `getCheckpointMechanismFor("post-research", { pipeline: { checkpointOverrides: { "post-research": "disk" }, checkpointMechanism: "pr" } })` returns the disk mechanism; other checkpoints get pr.

**Plus strict comment parsing (evaluatorNotes):**
- (g) Comment "approveeee post-research" → does NOT approve (strict word-boundary). Same for "aproove", "reject-typo".

**Plus edit branch (s10-c2d):**
- (h) Comment "edit post-research\n\`\`\`...new content...\`\`\`" → outcome `{ edit: true, editDelta: { before, after } }`.

---

## 2. Patterns to Follow

### Pattern A: Constructor-injected mockable seams (Sprint 8 + 9 precedent)

**Source:** `src/orchestrator/checkpoints/mechanisms/cli.ts:143-147`
```ts
constructor(
  private readonly fallback: CheckpointMechanism = DEFAULT_NOOP,
  private readonly stdin: Readable = process.stdin as Readable,
  private readonly editor?: string,
) {}
```

**Source:** `src/orchestrator/checkpoints/mechanisms/disk.ts:65-70`
```ts
constructor(
  private readonly approvalsDir: string,
  private readonly options: DiskMechanismOptions = {},
  private readonly now: () => number = () => Date.now(),
) {}
```

**Rule:** Every external dependency (process, time, child processes, network) must be a constructor parameter with a sensible default — so tests can inject deterministic fakes without `vi.mock(...)` global module mocks. For pr.ts: inject `gh: GhClient`, `fallback: CheckpointMechanism`, `options`, `now`.

---

### Pattern B: Falling back with a stderr warning (Sprint 8 precedent)

**Source:** `src/orchestrator/checkpoints/mechanisms/cli.ts:153-159`
```ts
// TTY guard — fall back to noop in CI / non-interactive environments.
if (!process.stdin.isTTY) {
  process.stderr.write(
    `warn: CLI checkpoint "${checkpoint}" requested but stdin is not a TTY; auto-approving via noop.\n`,
  );
  return this.fallback.request(checkpoint, artifact);
}
```

**Rule:** When falling back, (a) write a single stderr line starting `warn:` with the checkpoint id quoted, (b) explicitly call `this.fallback.request(checkpoint, artifact)` — do NOT short-circuit to `{ approved: true }`. The test for s10-c8e MUST verify the fallback PATH was taken, not just the outcome (cli.test.ts:186-187 spies on `fallback.request` to prove it).

---

### Pattern C: Poll loop with cleanup + timeout (Sprint 9 precedent)

**Source:** `src/orchestrator/checkpoints/mechanisms/disk.ts:113-184`
```ts
const startedAt = this.now();
let pollHandle: ReturnType<typeof setTimeout> | undefined;

try {
  return await new Promise<CheckpointOutcome>((resolve, reject) => {
    const tick = async (): Promise<void> => {
      try {
        // ... check resolution
        if (entries.has(`${checkpoint}.approved.json`)) { /* resolve */ return; }
        if (entries.has(`${checkpoint}.rejected.json`)) { /* resolve */ return; }
        if (this.now() - startedAt >= timeoutMs) { /* timeout resolve */ return; }
        pollHandle = setTimeout(() => { tick().catch(reject); }, pollMs);
      } catch (err) { reject(err); }
    };
    pollHandle = setTimeout(() => { tick().catch(reject); }, pollMs);
  });
} finally {
  if (pollHandle !== undefined) clearTimeout(pollHandle);
}
```

**Rule:** Use the SAME poll skeleton in pr.ts — `setTimeout` chain inside a Promise, `try { ... } finally { clearTimeout(pollHandle) }`. The "no leaked timers" test (`disk.test.ts:219-251`) is a regression assertion the pr mechanism must also pass if we replicate the structure.

---

### Pattern D: execa wrapper for CLIs (existing project convention)

**Source:** `src/graph/prereq.ts:10-20`
```ts
async check(): Promise<PrereqResult> {
  let result;
  try {
    result = await execa(this.binary, ["--version"], {
      reject: false,
      timeout: 5000,
    });
  } catch {
    return { ok: false, reason: "MISSING", hint: this.installHint() };
  }
  if (result.exitCode !== 0 || result.failed) {
    return { ok: false, reason: "MISSING", hint: this.installHint() };
  }
  // ...
}
```

**Source:** `src/utils/git.ts:7-13`
```ts
export async function getCurrentBranch(cwd: string): Promise<string> {
  const { stdout } = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
  });
  return stdout.trim();
}
```

**Rule:** All `execa` calls that interact with external CLIs MUST pass `reject: false` so non-zero exits are inspected explicitly (NOT thrown). `timeout: 5000` for short metadata calls, longer/none for long operations. Always pass `cwd` when the command is repo-relative.

---

### Pattern E: Mocking execa in tests (project convention)

**Source:** `tests/graph/prereq.test.ts:3-11`
```ts
vi.mock("execa", () => ({
  execa: vi.fn(),
}));

import { execa } from "execa";

beforeEach(() => {
  (execa as unknown as Mock).mockReset();
});
```
Then per-test:
```ts
(execa as unknown as Mock).mockResolvedValue({
  exitCode: 0,
  stdout: "tokensave 6.0.0-beta.1",
  failed: false,
});
```

**Rule for pr.test.ts:** PREFER injecting a fake `GhClient` over `vi.mock("execa")`. The GhClient interface lets each test return synthetic structured data without mocking the bytes of stdout. Use `vi.mock("execa")` ONLY for tests that exercise the `createGhClient(cwd)` factory directly (round-trip parsing tests for `--json` outputs).

---

### Pattern F: Self-registration at module load (Sprint 7 precedent)

**Source:** `src/orchestrator/checkpoints/registry.ts:33-43`
```ts
registerCheckpointMechanism("noop", new NoopCheckpointMechanism());
registerCheckpointMechanism("cli", new CliCheckpointMechanism());
registerCheckpointMechanism(
  "disk",
  new DiskCheckpointMechanism(join(process.cwd(), ".bober", "approvals")),
);
```

**Rule:** Append the `pr` registration in the same block, NOT inside a function. Module-load registration mirrors how `src/evaluators/registry.ts` populates built-ins. The pr instance receives a fresh disk fallback rooted at `<cwd>/.bober/approvals` (same path as the standalone "disk" registration — same fallback marker dir is fine; the disk mechanism is stateless apart from the dir).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---|---|---|---|
| `execa` | `execa` (npm dep, package.json:64) | `execa(cmd, args, opts) → ExecaReturnValue` | All shell-out. Already imported in 15+ files; do NOT use `child_process.spawn` for new code. |
| `getCurrentBranch` | `src/utils/git.ts:8` | `(cwd: string) => Promise<string>` | Get current git branch. Use to compute the `--head` for `gh pr list`. |
| `getChangedFiles` | `src/utils/git.ts:45` | `(cwd: string, since?: string) => Promise<string[]>` | List files changed vs a ref. Available if PR body needs a file list. |
| `getDiff` | `src/utils/git.ts:64` | `(cwd: string, since?: string) => Promise<string>` | Get unified diff. Useful if PR body should include a diff snippet. |
| `commitAll` | `src/utils/git.ts:27` | `(cwd, message) => Promise<string>` | Stage + commit. Probably not needed for pr.ts but available. |
| `getCheckpointMechanism` | `src/orchestrator/checkpoints/registry.ts:23` | `(name: string) => CheckpointMechanism` | Keep this signature unchanged for back-compat; ADD a sibling `getCheckpointMechanismFor`. |
| `registerCheckpointMechanism` | `src/orchestrator/checkpoints/registry.ts:19` | `(name, impl) => void` | Used to register `"pr"`. |
| `NoopCheckpointMechanism` | `src/orchestrator/checkpoints/noop.ts:10` | `class implements CheckpointMechanism` | Available but DO NOT use as the pr fallback — use `DiskCheckpointMechanism` per evaluatorNotes. |
| `CliCheckpointMechanism` | `src/orchestrator/checkpoints/mechanisms/cli.ts:132` | `class implements CheckpointMechanism` | Available but DO NOT use as the pr fallback. |
| `DiskCheckpointMechanism` | `src/orchestrator/checkpoints/mechanisms/disk.ts:58` | `class(approvalsDir, options?, now?)` | **THIS is the required pr fallback.** Inject one rooted at `<cwd>/.bober/approvals`. |
| `CHECKPOINT_SITES` | `src/orchestrator/checkpoints/sites.ts:23` | `readonly CheckpointSite[]` | Static enumeration of all 9 checkpoint ids — reference for valid `CheckpointId` values in tests. |

**Types you must import from `../types.js`:**
- `CheckpointArtifact`, `CheckpointId`, `CheckpointMechanism`, `CheckpointOutcome` — defined at `src/orchestrator/checkpoints/types.ts:13-60`.

**The `CheckpointOutcome` discriminated union (types.ts:46-49)** — pr.ts must return one of:
```ts
| { approved: true; editDelta?: unknown }
| { approved: false; feedback: string }
| { edit: true; editDelta: unknown }
```

---

## 4. Prior Sprint Output

### Sprint 7 (sprint-spec-20260524-bober-vision-7) — Checkpoint scaffolding
- **Created:** `src/orchestrator/checkpoints/{types,registry,noop,sites,index}.ts`
- **Exports used by Sprint 10:** `CheckpointMechanism` interface, `CheckpointId` union, `CheckpointOutcome` discriminated union, `registerCheckpointMechanism()`, `getCheckpointMechanism()`.
- **Connection:** pr.ts `implements CheckpointMechanism` (types.ts:55-60). Registry.ts gets new `"pr"` registration and new `getCheckpointMechanismFor` sibling.

### Sprint 8 (sprint-spec-20260524-bober-vision-8) — CLI mechanism
- **Created:** `src/orchestrator/checkpoints/mechanisms/cli.ts` + `cli.test.ts` (COLOCATED).
- **Connection:** pr.ts copies cli.ts's constructor-injection pattern (fallback + stdin + editor → gh + fallback + options + now). pr.test.ts copies cli.test.ts's spy-on-fallback pattern for the unavailable→disk path (s10-c8e).

### Sprint 9 (sprint-spec-20260524-bober-vision-9) — Disk mechanism + CLI
- **Created:** `src/orchestrator/checkpoints/mechanisms/disk.ts` + `disk.test.ts` (COLOCATED). Also added `src/cli/commands/{approve,reject,list-approvals}.ts` + their colocated tests.
- **Exports used by Sprint 10:** `DiskCheckpointMechanism` class (disk.ts:58). pr.ts imports and instantiates this as the default fallback.
- **Connection:** Sprint 10's pr.ts `import { DiskCheckpointMechanism } from "./disk.js"` and uses it as the fallback when `gh` is unavailable.

---

## 5. Relevant Documentation

### Project Principles
**Result:** No `.bober/principles.md` file exists. No `CLAUDE.md` at the repo root.

### Architecture Decisions
**Result:** No `.bober/architecture/` directory exists. The Tier 2 architecture is documented inline in `src/orchestrator/checkpoints/types.ts:1-7` and `src/orchestrator/checkpoints/registry.ts:7-16`.

### README
**Result:** `README.md` exists but is product-facing — no engineering conventions documented there. Engineering conventions live in code comments (e.g., the registry.ts module header) and in prior Sprint briefings.

### Prior Sprint Conventions (extracted from briefings 7-9)
- **COLOCATED tests** for the checkpoints/mechanisms tree (Sprint 5 scanner enforces colocated:separate ratio ≥ 1).
- **ESM with `.js` extensions** in import specifiers (e.g., `from "./types.js"` even though the source is `.ts`).
- **`node:` prefix** for built-in modules (`node:path`, `node:fs/promises`).
- **`reject: false`** on every `execa` call so non-zero exits are inspected, not thrown.
- **Module-level mock state** in tests (`vi.mock("execa")` at the top, `mockReset()` in `beforeEach`).

---

## 6. Testing Patterns

### Unit test pattern — mechanism with injected seams
**Source:** `src/orchestrator/checkpoints/mechanisms/cli.test.ts:165-196`
```ts
describe("CliCheckpointMechanism — non-TTY fallback (s8-c5d)", () => {
  it("isTTY=false → calls fallback.request (not just returns approved:true) + writes stderr warning", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: false, configurable: true,
    });

    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockReturnValue(true as unknown as boolean);

    const noopSpy: CheckpointMechanism = {
      request: vi.fn(async () => ({ approved: true as const })),
    };

    const cli = new CliCheckpointMechanism(noopSpy);
    const outcome = await cli.request("post-plan", { key: "val" });

    expect(noopSpy.request).toHaveBeenCalledOnce();
    expect(noopSpy.request).toHaveBeenCalledWith("post-plan", { key: "val" });
    const allStderr = stderrSpy.mock.calls.flat().join("");
    expect(allStderr).toMatch(/not a TTY/i);
    expect(outcome).toEqual({ approved: true });
  });
});
```
**Adapt for pr.test.ts s10-c8e:**
```ts
it("gh unavailable → calls disk fallback path + writes stderr warning", async () => {
  const ghStub: GhClient = {
    version: vi.fn(async () => ({ ok: false, stdout: "" })),
    // others can throw if called — test asserts they aren't.
    authStatus: vi.fn(),
    repoView: vi.fn(),
    prList: vi.fn(),
    prCreate: vi.fn(),
    prComment: vi.fn(),
    prView: vi.fn(),
  };
  const diskSpy: CheckpointMechanism = {
    request: vi.fn(async () => ({ approved: true as const })),
  };
  const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true as unknown as boolean);

  const pr = new PrCheckpointMechanism(ghStub, diskSpy);
  const outcome = await pr.request("post-plan", { key: "val" });

  expect(diskSpy.request).toHaveBeenCalledOnce();
  expect(diskSpy.request).toHaveBeenCalledWith("post-plan", { key: "val" });
  expect((stderrSpy.mock.calls.flat().join("") as string)).toMatch(/gh.*unavailable|fall.*back/i);
  expect(outcome).toEqual({ approved: true });

  // Verify NO subsequent gh calls happened after availability failure.
  expect(ghStub.prCreate).not.toHaveBeenCalled();
  expect(ghStub.prComment).not.toHaveBeenCalled();
});
```

### Unit test pattern — execa mock at module level
**Source:** `tests/graph/prereq.test.ts:1-12`
```ts
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
vi.mock("execa", () => ({ execa: vi.fn() }));
import { execa } from "execa";
beforeEach(() => { (execa as unknown as Mock).mockReset(); });
```
**Use this in pr.test.ts ONLY** for the `createGhClient(cwd)` round-trip tests — i.e., proving that `gh.version()` parses execa's `exitCode === 0` correctly. All higher-level mechanism behavior tests should inject a fake `GhClient` directly into the constructor.

### Test runner / assertion style
- **Runner:** vitest (package.json:93)
- **Assertion style:** `expect(x).toEqual(...)` / `.toHaveBeenCalledWith(...)`
- **Mock approach:** `vi.fn()`, `vi.spyOn()`, `vi.mock()` for module-level; constructor injection preferred where possible.
- **File naming:** `<source>.test.ts` colocated next to `<source>.ts`.
- **Location:** Co-located in `src/` per Sprint 5 scanner constraint (colocated:separate ratio ≥ 1).

### E2E pattern
N/A — pr.ts is a node-only mechanism. No playwright E2E required.

---

## 7. Impact Analysis — Affected Files, Features & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|---|---|---|---|
| `src/orchestrator/checkpoints/index.ts` | registry.ts re-exports | **low** | Re-export of `getCheckpointMechanismFor` (new) — index.ts must export it for pipeline.ts/sprint 14 to consume. No existing re-exports break. |
| `src/orchestrator/pipeline.ts` | registry.ts `getCheckpointMechanism` (10 call-sites) | **low** | Call-sites all use `getCheckpointMechanism("noop")` — back-compat preserved. Verify these still work after registry edit. |
| `src/orchestrator/checkpoints/mechanisms/cli.ts` | imports `noop.js` (line 30) | **none** | Untouched by this sprint. |
| `src/orchestrator/checkpoints/mechanisms/disk.ts` | None (leaf) | **none** | But: pr.ts IMPORTS disk.ts, so changes to disk's exports would cascade. This sprint only consumes the existing `DiskCheckpointMechanism` class — do not modify disk.ts. |

### Existing Tests That Must Still Pass
- `src/orchestrator/checkpoints/mechanisms/cli.test.ts` (222 lines) — Sprint 8's mechanism tests. Verify still passes (registry.ts edit must not break the "cli" registration).
- `src/orchestrator/checkpoints/mechanisms/disk.test.ts` (338 lines) — Sprint 9's mechanism tests. Verify still passes.
- `src/cli/commands/approve.test.ts`, `src/cli/commands/reject.test.ts`, `src/cli/commands/list-approvals.test.ts` — Sprint 9's CLI tests. Verify still passes (disk mechanism behavior unchanged).
- Any test that imports `getCheckpointMechanism` directly — none found in the current repo, but verify with `grep -rn "getCheckpointMechanism" src/ tests/` after edit.

### Features That Could Be Affected
- **Tier 2 careful-flow** (Sprints 7–10) — this sprint completes the family. After: noop/cli/disk/pr are all registered. Sprint 11+ may add per-type renderers (`renderArtifact` improvements) that pr.ts could consume — keep `renderCheckpointComment` simple and isolated.
- **Sprint 14 config wiring** — depends on the override hook (`getCheckpointMechanismFor`) signature being stable. Get the shape right NOW so Sprint 14 only adds Zod schema for `checkpointOverrides` without changing the resolver.

### Recommended Regression Checks
After implementation the Generator MUST run, in order:
1. `npm run typecheck` — must exit 0. (`tsc --noEmit`)
2. `npm run lint` — must exit 0. (`eslint src/`)
3. `npm run build` — must exit 0. (`tsc`)
4. `npm run test` — must exit 0. Watch for:
   - `cli.test.ts` still 6/6 passing
   - `disk.test.ts` still 7/7 passing (s9-c7a–g)
   - `pr.test.ts` new tests all pass with NO real `gh` invocation (use `vi.fn()` everywhere)
5. Manual sanity grep: `grep -rn "execa.*['\"]gh['\"]" src/orchestrator/checkpoints/mechanisms/pr.test.ts` — should return ZERO lines (test must never invoke real `gh`).
6. Sanity grep that disk.ts is the fallback: `grep -n "DiskCheckpointMechanism\|disk" src/orchestrator/checkpoints/mechanisms/pr.ts | head -10` — should show disk as the fallback default, NOT noop or cli.

---

## 8. Implementation Sequence

1. **Read prior briefings** — `.bober/briefings/sprint-spec-20260524-bober-vision-{7,8,9}-briefing.md` for full context on the colocation constraint and registry shape.
   - Verify: skim the table of contents — confirm the colocated-test rule (Sprint 9 §0 paragraph 1).
2. **Create `src/orchestrator/checkpoints/mechanisms/pr.ts`** — define `GhClient` interface, `createGhClient(cwd)` factory, `PrMechanismOptions`, and `PrCheckpointMechanism` class. Implement: `checkAvailability()`, `ensureRunPr()`, `renderCheckpointComment()`, `pollPrUntilResolved()`, `parseSignals()`.
   - Verify: `npm run typecheck` exits 0. `grep -n "implements CheckpointMechanism" src/orchestrator/checkpoints/mechanisms/pr.ts` shows the class implements the interface.
3. **Modify `src/orchestrator/checkpoints/registry.ts`** — add `import { PrCheckpointMechanism, createGhClient } from "./mechanisms/pr.js"`, append registration block, add `getCheckpointMechanismFor` resolver + `CheckpointOverrideConfig` interface.
   - Verify: `npm run typecheck` exits 0. `grep -n "registerCheckpointMechanism.*pr" src/orchestrator/checkpoints/registry.ts` shows the pr registration line.
4. **Update `src/orchestrator/checkpoints/index.ts`** — re-export `getCheckpointMechanismFor` and `CheckpointOverrideConfig`.
   - Verify: `grep -n "getCheckpointMechanismFor\|CheckpointOverrideConfig" src/orchestrator/checkpoints/index.ts` shows both re-exports.
5. **Create `src/orchestrator/checkpoints/mechanisms/pr.test.ts`** — at minimum 8 `it()` blocks covering: (a) PR creation, (b) PR-reuse on second checkpoint, (c) approve comment, (d) reject comment, (e) PR merge auto-approves, (f) gh-unavailable → disk fallback PATH, (g) strict comment parsing rejects typos, (h) edit comment with fenced code block.
   - Verify: `npm run test -- src/orchestrator/checkpoints/mechanisms/pr.test.ts` exits 0 and reports ≥ 8 passing tests.
6. **Add override-resolver test** — either as a `describe` block inside pr.test.ts OR a new colocated `registry.test.ts`. Cover: override beats default, default is used when no override, fallback param is used when neither set.
   - Verify: the new tests pass; `grep -n "getCheckpointMechanismFor" src/orchestrator/checkpoints/` shows at least one test importer.
7. **Run full verification** — `npm run typecheck && npm run lint && npm run build && npm run test`. ALL must exit 0 (s10-c9).
   - Verify: no regressions in any prior sprint's tests; pr.test.ts uses no real `gh` calls.

---

## 9. Pitfalls & Warnings

- **DO NOT call real `gh` in tests.** Per evaluatorNotes, "A test that creates a real PR is a failure (rollback required)." Inject a fake `GhClient` everywhere. If you use `vi.mock("execa")`, double-check no code path can reach the real binary — the safest design is constructor-injected GhClient, where the test never instantiates `createGhClient`.

- **Fallback target is DISK, not noop/cli.** Sprint 8's cli falls back to noop. Sprint 10's pr falls back to **disk** per `evaluatorNotes` ("The fallback should NOT be to cli."). Easy mistake to copy cli.ts's `DEFAULT_NOOP` pattern — instead make the default fallback a fresh `DiskCheckpointMechanism(<cwd>/.bober/approvals)` when the constructor's fallback param is omitted, OR require the caller to inject it explicitly (registry.ts will do so).

- **Colocated tests, not `tests/`.** The contract's `expectedChanges` says `tests/orchestrator/checkpoints/pr.test.ts` but Sprints 8 and 9 used COLOCATED tests. Sprint 5's scanner enforces colocated:separate ratio. Place at `src/orchestrator/checkpoints/mechanisms/pr.test.ts`. The contract criterion `s10-c8` says only "Locate test file" — no path mandate.

- **Single run-tracking PR per `bober run`, not one PR per checkpoint.** Cache the `prNumber` in a class field (`runPrNumber`); the FIRST `request()` creates it, subsequent calls append comments. Wrong: creating a new PR for every checkpoint floods the repo and buries the work (evaluatorNotes).

- **Strict comment parsing.** Per evaluatorNotes: "Verify comment parsing is strict (rejects 'approveeee', 'aproove')." Use a regex with word boundaries: `/^approve\s+(\S+)\s*$/i` — not `body.includes("approve")`. Add a test case (s10-c8 implicit) that "approveeee post-research" does NOT trigger approval.

- **Rate-limit back-off.** GitHub secondary rate limits return 429 / "abuse detection mechanism" errors. Wrap `prView` polling in exponential back-off (start at `pollMs`, double on rate-limit errors, cap at 5 minutes per evaluatorNotes). Use `result.stderr` matching `/rate limit|abuse detection/i` to detect.

- **Minimum poll interval.** `MIN_POLL_MS = 10_000`. If user configures `pipeline.prPollMs` lower than 10s, clamp it: `Math.max(options.pollMs ?? DEFAULT_POLL_MS, MIN_POLL_MS)`. Document this clamp via a one-line stderr warning if the configured value is below floor.

- **ESM `.js` extensions in imports.** `from "./types.js"`, `from "./disk.js"`. Even though the source is TypeScript, the emitted ESM needs `.js` extensions to resolve. The whole codebase follows this — TypeScript's `moduleResolution: NodeNext` makes the missing extension a compile error.

- **`process.cwd()` at module load.** `registry.ts:42` and Sprint 9's disk registration both bake in `process.cwd()` at module load. This is fine for the standard CLI invocation but breaks if the orchestrator chdir's at runtime. Mirror this pattern for pr's disk-fallback — do NOT introduce a different lazy-cwd pattern unless the test suite breaks (it shouldn't).

- **Back-compat on `getCheckpointMechanism(name)`.** Pipeline.ts has 10 call-sites that pass a literal string name. Do NOT change the signature. Add `getCheckpointMechanismFor(checkpointId, config, fallback?)` as a SIBLING function. Sprint 14 will migrate pipeline.ts call-sites; this sprint just lays the rail.

- **`PartialBoberConfig` already exists.** The schema at `src/config/schema.ts:228` defines `PartialBoberConfigSchema = BoberConfigSchema.deepPartial()`. The `CheckpointOverrideConfig` shape we define in registry.ts should be a STRUCTURAL subset (`{ pipeline?: { checkpointMechanism?, checkpointOverrides? } }`) — that way Sprint 14 can pass a real `BoberConfig` or `PartialBoberConfig` and it just works without a cast.

- **`runPrNumber` cache is per-instance.** Because `registry.ts:42` registers a SINGLE `PrCheckpointMechanism` instance at module load, the cache survives across all checkpoints in a single `bober run` invocation. If a future sprint adds multi-run support, this caching strategy needs revisiting — but Sprint 10 is fine.

- **Stderr warning text must mention `gh auth login`.** Per s10-c4 verification: "log a clear warning and fall back to the 'disk' mechanism. Document this in the warning message." Include actionable guidance: `Run \`gh auth login\` to enable PR checkpoints.`
