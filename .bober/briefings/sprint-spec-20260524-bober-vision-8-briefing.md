# Sprint Briefing: CLI blocking checkpoint mechanism

**Contract:** sprint-spec-20260524-bober-vision-8
**Generated:** 2026-05-25T00:00:00Z
**Tier:** 2 (careful-flow), Sprint 2/8 of tier
**Depends on:** Sprint 7 (checkpoint abstraction)

---

## Sprint Summary

Implement the `cli` CheckpointMechanism — a blocking, interactive approval prompt
backed by `node:readline`. It prints the checkpoint id + an artifact summary +
an `a/r/e` prompt, blocks on stdin until valid input is received, opens
`$EDITOR` for the edit branch, and **falls back to the noop mechanism** when
`process.stdin.isTTY` is falsy (CI / non-interactive). The mechanism is
self-registered under name `"cli"` at module load via `registry.ts`. **HARD
CONSTRAINT (override of contract):** the test file must be **colocated** at
`src/orchestrator/checkpoints/mechanisms/cli.test.ts`, **NOT** at
`tests/orchestrator/checkpoints/cli.test.ts` as `expectedChanges[2].path`
states. See COLOCATION HARD CONSTRAINT below — placing it in `tests/` risks
the Sprint 5 scanner regression and contradicts the precedent Sprint 7 set
(`src/orchestrator/checkpoints/checkpoints.test.ts`). Default pipeline behavior
must remain noop — Sprint 14 wires mode/mechanism selection; this sprint only
adds a new entry to the registry.

---

## Sprint 7 API Surface — Conform Verbatim

The CLI mechanism MUST implement this interface exactly. Quoted from
`src/orchestrator/checkpoints/types.ts:46-60`:

```ts
export type CheckpointOutcome =
  | { approved: true; editDelta?: unknown }
  | { approved: false; feedback: string }
  | { edit: true; editDelta: unknown };

/**
 * A pluggable approval mechanism. Sprints 8-10 implement `cli`, `disk`, `pr`.
 * This sprint registers ONLY `noop`.
 */
export interface CheckpointMechanism {
  request(
    checkpoint: CheckpointId,
    artifact: CheckpointArtifact,
  ): Promise<CheckpointOutcome>;
}
```

Where (`src/orchestrator/checkpoints/types.ts:13-22`):

```ts
export type CheckpointId =
  | "post-research"
  | "post-plan"
  | "post-sprint-contract"
  | "pre-curator"
  | "pre-generator"
  | "pre-evaluator"
  | "pre-code-reviewer"
  | "post-sprint"
  | "end-of-pipeline";

export type CheckpointArtifact = unknown;
```

Outcome shape rules for the CLI three branches (per s8-c2):
- `'a' | 'approve'` → `{ approved: true }`
- `'r' | 'reject'` → prompt for feedback, then `{ approved: false, feedback: <typed text> }`
- `'e' | 'edit'`   → spawn `$EDITOR`, on save → `{ edit: true, editDelta: <delta> }`

---

## COLOCATION HARD CONSTRAINT (override of contract)

The contract's `expectedChanges[2].path` says
`tests/orchestrator/checkpoints/cli.test.ts`. **Ignore that path.** The
generator MUST place the unit test at:

```
src/orchestrator/checkpoints/mechanisms/cli.test.ts
```

**Why** — Sprint 5 added a regression test in `src/discovery/scanner.test.ts`
asserting `report?.colocated === true`. The detector at
`src/discovery/scanners/test-conventions.ts:144-167` counts:

```ts
function detectColocated(testFiles: string[], projectRoot: string): boolean {
  if (testFiles.length === 0) return false;
  let colocatedCount = 0;
  let separateCount = 0;
  for (const filePath of testFiles) {
    const rel = relative(projectRoot, filePath);
    const dir = dirname(rel);
    if (
      dir.includes("__tests__") ||
      dir.startsWith("test/") ||
      dir.startsWith("tests/") ||
      dir === "test" || dir === "tests"
    ) {
      separateCount++;
    } else {
      colocatedCount++;
    }
  }
  return colocatedCount >= separateCount;
}
```

**Current counts at sprint start:**
- `src/**/*.test.ts` (colocated): **24** files
- `tests/**/*.test.ts` (separate): **22** files
- Ratio: 24 ≥ 22 → `colocated = true` (the regression assertion passes)

Sprint 7 explicitly noted this trade-off and colocated its test at
`src/orchestrator/checkpoints/checkpoints.test.ts` (see the file header
comment, lines 1-8). Adding `tests/orchestrator/checkpoints/cli.test.ts`
would push separate from 22 → 23 (still 24 ≥ 23 = true, **but** any other
file added to `tests/` after this — e.g., Sprint 9 disk-marker tests — would
flip the ratio. Sprints 9 and 10 follow the same `mechanisms/<name>.ts`
pattern, so colocating now establishes the convention.) Colocating adds a
file to `src/` instead: 25 ≥ 22 → margin grows. This is the safe choice.

`tests/orchestrator/` currently contains exactly two files:
`curator-turn-count.test.ts`, `gating.test.ts`. Do not add a third.

---

## Module Layout

```
src/orchestrator/checkpoints/
├── types.ts                       (Sprint 7 — UNCHANGED)
├── registry.ts                    (modify: add ONE import + ONE register call)
├── noop.ts                        (Sprint 7 — UNCHANGED)
├── sites.ts                       (Sprint 7 — UNCHANGED)
├── index.ts                       (UNCHANGED — barrel stays opaque, see below)
├── checkpoints.test.ts            (Sprint 7 — UNCHANGED)
└── mechanisms/                    (NEW directory)
    ├── cli.ts                     (CREATE — CliCheckpointMechanism class)
    └── cli.test.ts                (CREATE — colocated test)
```

**`index.ts` does NOT re-export mechanisms.** The Sprint 7 evaluator noted
the barrel is opaque to the coordinator (registry.ts is the only retrieval
path). See `src/orchestrator/checkpoints/index.ts:1-16`:

```ts
/**
 * The coordinator imports from this barrel — never from individual files.
 * The noop mechanism is NOT re-exported here: it is opaque to the coordinator,
 * registered by registry.ts at module init, and retrieved via getCheckpointMechanism("noop").
 */
export type { CheckpointId, CheckpointArtifact, CheckpointMechanism, CheckpointOutcome } from "./types.js";
export { registerCheckpointMechanism, getCheckpointMechanism } from "./registry.js";
export { CHECKPOINT_SITES, type CheckpointSite } from "./sites.js";
```

**Do NOT add `CliCheckpointMechanism` to the barrel.** Follow the same
opaque pattern. Only `registry.ts` imports `./mechanisms/cli.js`.

**`registry.ts` modification (exactly two lines added):**

```ts
// at top with other imports:
import { CliCheckpointMechanism } from "./mechanisms/cli.js";
// at bottom alongside the noop self-registration:
registerCheckpointMechanism("cli", new CliCheckpointMechanism());
```

Match the existing pattern at `src/orchestrator/checkpoints/registry.ts:30-32`:

```ts
// Self-register the noop mechanism at module init.
// This mirrors how src/evaluators/registry.ts:41-50 populates built-ins.
registerCheckpointMechanism("noop", new NoopCheckpointMechanism());
```

---

## Prompt Format (verbatim from contract generatorNotes)

```
[Checkpoint: post-research] Research artifact ready.
  Path: .bober/research/research-20260524-foo.md
  Lines: 245 (first 40 shown)
  ---
  <summary>
  ---
  Approve (a), Reject (r), Edit (e)? 
```

**Field derivation rules:**
- `Checkpoint: <id>` — the `checkpoint` argument value (one of the 9 literals)
- `Path: …` — read from `artifact.path` if present, else omit the line
- `Lines: N (first 40 shown)` — count when the artifact is text-renderable
- `<summary>` — first **40 lines** of artifact text, append `... (N more lines)`
  if truncated (per generatorNotes — keep simple, Sprint 11 adds renderers)

**Reject sub-prompt:**

```
Why are you rejecting? Feedback (one line): 
```

**Streams:**
- All prompt output → **`process.stderr`** (per evaluatorNotes — stdout is
  reserved for orchestrator protocol in some harnesses; `src/utils/logger.ts`
  uses `console.error` for warn/error, but `info`/`success` go to `console.log`.
  For the CLI checkpoint prompt, prefer `process.stderr.write` directly to
  avoid any chalk styling or newline conventions interfering with prompts.)
- stdin reads are line-based via `node:readline` `createInterface({ input: process.stdin })`.

---

## TTY Fallback Pattern (RECOMMENDED: direct import)

**Recommendation:** import `NoopCheckpointMechanism` from `../noop.js` directly.
**Reason:** registry circularity. `registry.ts` imports both `./noop.js` and
`./mechanisms/cli.js`. If `cli.ts` calls `getCheckpointMechanism("noop")`, the
runtime relies on `registry.ts` having executed its noop self-registration
before `request()` is called. In practice this works because registration runs
at module-load (top-level), but it makes the dependency graph cyclic in spirit
(`cli` → `registry` → `cli`). A direct `new NoopCheckpointMechanism()` (or
import + reuse a module-level singleton) avoids that.

**Pattern to use:**

```ts
// src/orchestrator/checkpoints/mechanisms/cli.ts
import { NoopCheckpointMechanism } from "../noop.js";

const NOOP_FALLBACK = new NoopCheckpointMechanism();

export class CliCheckpointMechanism implements CheckpointMechanism {
  async request(
    checkpoint: CheckpointId,
    artifact: CheckpointArtifact,
  ): Promise<CheckpointOutcome> {
    if (!process.stdin.isTTY) {
      process.stderr.write(
        `warn: CLI checkpoint "${checkpoint}" requested but stdin is not a TTY; auto-approving via noop.\n`,
      );
      return NOOP_FALLBACK.request(checkpoint, artifact);
    }
    // … interactive flow
  }
}
```

**Critical for s8-c5(d):** the test must verify the noop **path** is taken
(not just that the outcome is `{ approved: true }`, which would coincide).
Approach: spy on `NOOP_FALLBACK.request` (e.g., `vi.spyOn(NOOP_FALLBACK, "request")`)
or assert the stderr warning string appears. The evaluatorNotes call this out
explicitly: *"verify the noop path is taken"*.

If the spy approach feels invasive, an alternative is to inject the fallback
via constructor: `constructor(private fallback: CheckpointMechanism = new NoopCheckpointMechanism())`.
Then test passes a spy. **Recommended:** constructor injection — cleaner test,
no module-mock gymnastics.

---

## $EDITOR Resolution + Temp-File Pattern

**No prior precedent in codebase.** `src/utils/fs.ts:1-79` exports `fileExists`,
`readJson`, `writeJson`, `ensureDir`, `findProjectRoot` — none cover tmpdir or
EDITOR spawning. Neither `os.tmpdir()`, `crypto.randomBytes`, nor
`process.env.EDITOR` appear anywhere in `src/`. The generator must introduce
these primitives fresh.

**`child_process` precedent:** `src/mcp/tools/playwright.ts:8` and
`src/graph/onboarding-composer-markdown.test.ts:12` use `node:child_process`
`execFile`. For interactive editors we need `spawn` with `{ stdio: 'inherit' }`
to give the editor full TTY control, then await `'exit'`.

**Pattern:**

```ts
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { writeFile, readFile, unlink } from "node:fs/promises";

async function editArtifact(initialText: string): Promise<string> {
  const editor = process.env.EDITOR ?? "nano";
  const tmpPath = join(
    tmpdir(),
    `bober-checkpoint-${randomBytes(8).toString("hex")}.txt`,
  );
  await writeFile(tmpPath, initialText, "utf-8");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(editor, [tmpPath], { stdio: "inherit" });
      child.on("exit", (code) => {
        // Note: per evaluatorNotes, non-zero exit must still clean up the
        // temp file (the `finally` below guarantees it). We do NOT reject
        // here — accept whatever the user wrote. Treat non-zero like "quit
        // without save" and read the file as-is.
        resolve();
      });
      child.on("error", reject);
    });
    return await readFile(tmpPath, "utf-8");
  } finally {
    // Always cleanup, even on spawn error / non-zero exit.
    await unlink(tmpPath).catch(() => { /* ignore */ });
  }
}
```

**`editDelta` shape:** generatorNotes say *"simple text diff is fine — JSON-diff
is overkill"*. The minimum viable delta is `{ before: string, after: string }`
or even just the new text. Recommendation: `{ before, after }` so consumers in
Sprint 12 (feedback propagation) can render a diff. Document the shape inline.

---

## Test Patterns

### Sprint 7 vitest pattern — reuse the same style

From `src/orchestrator/checkpoints/checkpoints.test.ts:10-46`:

```ts
import { describe, it, expect } from "vitest";
import {
  registerCheckpointMechanism,
  getCheckpointMechanism,
  CHECKPOINT_SITES,
  type CheckpointMechanism,
} from "./index.js";

describe("checkpoints — noop mechanism (s7-c5a)", () => {
  it("returns {approved: true} for every CheckpointId", async () => {
    const noop = getCheckpointMechanism("noop");
    for (const site of CHECKPOINT_SITES) {
      const outcome = await noop.request(site.id, { /* opaque */ });
      expect(outcome).toEqual({ approved: true });
    }
  });
});

describe("checkpoints — registry (s7-c2, s7-c5b, s7-c5c)", () => {
  it("throws a clear error for unknown mechanism names", () => {
    expect(() => getCheckpointMechanism("does-not-exist")).toThrow(/does-not-exist/);
  });
});
```

**Conventions to match:**
- Runner: **vitest** (per `scanner.test.ts` assertions and project config)
- Style: `describe(...)` per logical group, `it(...)` per assertion
- Imports: from `./index.js` (note `.js` ESM extension)
- Assertion: `expect(...).toEqual(...)` / `.toThrow(/regex/)`
- Test id tagging in describe label: `(s8-c5a)`, `(s8-c5b)`, etc.

### Mock pattern for stdin

Use `vi.mock` for `node:readline` and `node:child_process`, OR inject via
constructor (cleaner). Example for stdin mock (vitest-native):

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CliCheckpointMechanism } from "./cli.js";
import { NoopCheckpointMechanism } from "../noop.js";

// Mock readline to feed canned answers
vi.mock("node:readline", () => ({
  createInterface: vi.fn(),
}));
import * as readline from "node:readline";

function stubReadline(answers: string[]) {
  let i = 0;
  (readline.createInterface as any).mockReturnValue({
    question: (_q: string, cb: (a: string) => void) => cb(answers[i++] ?? ""),
    close: () => {},
  });
}

describe("CliCheckpointMechanism (s8-c5)", () => {
  let originalIsTTY: boolean | undefined;
  beforeEach(() => {
    originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
    vi.restoreAllMocks();
  });

  it("(a) 'a' input → {approved: true}", async () => {
    stubReadline(["a"]);
    const cli = new CliCheckpointMechanism();
    const outcome = await cli.request("post-research", { path: "x.md", text: "hi" });
    expect(outcome).toEqual({ approved: true });
  });

  it("(b) 'r' input + feedback → {approved: false, feedback}", async () => {
    stubReadline(["r", "needs more detail"]);
    const cli = new CliCheckpointMechanism();
    const outcome = await cli.request("post-plan", { path: "p.json" });
    expect(outcome).toEqual({ approved: false, feedback: "needs more detail" });
  });

  it("(c) 'e' input + stub EDITOR → {edit: true, editDelta}", async () => {
    // Set EDITOR to a tiny script that overwrites the temp file
    process.env.EDITOR = "/bin/sh -c 'echo edited > \"$0\"'";
    stubReadline(["e"]);
    const cli = new CliCheckpointMechanism();
    const outcome = await cli.request("post-research", { text: "original" });
    expect("edit" in outcome && outcome.edit).toBe(true);
  });

  it("(d) non-TTY → falls back to noop and warns to stderr", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const noopSpy = { request: vi.fn(async () => ({ approved: true as const })) };
    const cli = new CliCheckpointMechanism(noopSpy); // constructor injection
    const outcome = await cli.request("post-plan", {});
    expect(noopSpy.request).toHaveBeenCalledOnce();
    expect(stderrSpy.mock.calls.flat().join("")).toMatch(/not a TTY/i);
    expect(outcome).toEqual({ approved: true });
  });
});
```

Notes:
- The 'e' branch test is the trickiest. Using `/bin/sh -c '...'` as EDITOR
  works on POSIX (the test suite runs on darwin/linux). For portability, you
  could write a small shell stub and chmod it +x before the test, or accept
  that this test is darwin/linux-only and skip on win32 (`it.skipIf(process.platform === "win32")`).
- Constructor injection (`new CliCheckpointMechanism(noopSpy)`) is the
  cleanest way to satisfy *"verify the noop path is taken"* without
  module-level mock surgery.

---

## Performance Benchmark Technique (s8-c6, <200ms)

Budget excludes user-think time and editor-open time. Measure only:
prompt-render + stdin-read of a **pre-stuffed buffer**.

**Approach — readable-stream injection:**

```ts
import { Readable } from "node:stream";

it("(perf) prompt + stdin read completes under 200ms (s8-c6)", async () => {
  // Pre-stuff a stream that emits "a\n" immediately
  const buf = Readable.from(["a\n"]);
  // The mechanism normally reads from process.stdin; for this test, inject
  // the stream via constructor (recommended) or by temporarily reassigning
  // process.stdin to `buf` (cast to any). Constructor injection preferred.
  const cli = new CliCheckpointMechanism(/* noop */ undefined, /* stdin */ buf as any);
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

  const start = performance.now();
  const outcome = await cli.request("post-research", { text: "x" });
  const elapsed = performance.now() - start;

  expect(outcome).toEqual({ approved: true });
  expect(elapsed).toBeLessThan(200);
});
```

**Implication for `cli.ts` signature:** the constructor should accept two
optional injections to make this test possible without `vi.mock`:

```ts
export class CliCheckpointMechanism implements CheckpointMechanism {
  constructor(
    private fallback: CheckpointMechanism = new NoopCheckpointMechanism(),
    private stdin: NodeJS.ReadableStream = process.stdin,
  ) {}
  // … request() uses this.stdin instead of process.stdin
  // (but TTY check still uses process.stdin.isTTY — the real terminal)
}
```

This keeps zero-arg construction the default (registry registers with `new CliCheckpointMechanism()`)
while enabling clean tests. Note: `readline.createInterface({ input: this.stdin })`.

---

## Existing Utilities — Inventory

Searched `src/utils/`, `src/cli/`. **No relevant utility exists** for any of:
- `readline` / interactive stdin
- `process.stdin.isTTY` checks
- `os.tmpdir()` temp files
- `process.env.EDITOR` resolution
- spawning interactive child processes

| Utility | Location | Signature | Relevant? |
|---------|----------|-----------|-----------|
| `logger` | `src/utils/logger.ts:87` | Singleton `Logger` (info/warn/error) | **Do not use** for prompt — too styled. Direct `process.stderr.write` is cleaner. |
| `fileExists` | `src/utils/fs.ts:10` | `(path: string) => Promise<boolean>` | Not needed for tmp flow (unlink-with-catch is sufficient). |
| `ensureDir` | `src/utils/fs.ts:45` | `(path: string) => Promise<void>` | Not needed — `os.tmpdir()` always exists. |
| `NoopCheckpointMechanism` | `src/orchestrator/checkpoints/noop.ts:10` | `class NoopCheckpointMechanism implements CheckpointMechanism` | **YES — import + instantiate for fallback.** |
| `registerCheckpointMechanism` | `src/orchestrator/checkpoints/registry.ts:16` | `(name: string, impl: CheckpointMechanism) => void` | **YES — call once in registry.ts modification.** |
| `getCheckpointMechanism` | `src/orchestrator/checkpoints/registry.ts:20` | `(name: string) => CheckpointMechanism` | Not needed inside cli.ts (use direct import for fallback). |
| `CHECKPOINT_SITES` | `src/orchestrator/checkpoints/sites.ts:23` | `readonly CheckpointSite[]` | Optional — useful if a test iterates all sites. |

**Generator must introduce fresh:** `node:readline`, `node:child_process` (spawn),
`node:os` (tmpdir), `node:crypto` (randomBytes), `node:fs/promises` (writeFile/readFile/unlink).
All are Node built-ins — no new npm dependency needed.

---

## Prior Sprint Output (Sprint 7)

| File | Exports | How Sprint 8 uses it |
|------|---------|----------------------|
| `src/orchestrator/checkpoints/types.ts` | `CheckpointId`, `CheckpointArtifact`, `CheckpointOutcome`, `CheckpointMechanism` | Import all four; `CliCheckpointMechanism implements CheckpointMechanism`. |
| `src/orchestrator/checkpoints/registry.ts` | `registerCheckpointMechanism`, `getCheckpointMechanism` | Add ONE `import` + ONE `register…("cli", new CliCheckpointMechanism())` call. |
| `src/orchestrator/checkpoints/noop.ts` | `NoopCheckpointMechanism` | Import directly (avoid registry round-trip); instantiate for TTY fallback. |
| `src/orchestrator/checkpoints/index.ts` | barrel | **Do NOT modify** — keep mechanisms opaque (Sprint 7 evaluator convention). |
| `src/orchestrator/checkpoints/sites.ts` | `CHECKPOINT_SITES`, `CheckpointSite` | Not modified. Useful in tests to iterate. |
| `src/orchestrator/checkpoints/checkpoints.test.ts` | (test) | Read as **the** template for test style. |
| `src/orchestrator/pipeline.ts` | 9 `await getCheckpointMechanism(…).request(id, artifact)` call sites | Not modified — they still resolve `"noop"` (Sprint 14 swaps). |

---

## Implementation Sequence

1. **Create directory** `src/orchestrator/checkpoints/mechanisms/`.
2. **Create `src/orchestrator/checkpoints/mechanisms/cli.ts`** with:
   - Imports: types (`CheckpointMechanism`, `CheckpointId`, `CheckpointArtifact`, `CheckpointOutcome`) from `../types.js`; `NoopCheckpointMechanism` from `../noop.js`; node built-ins.
   - Class `CliCheckpointMechanism implements CheckpointMechanism` with constructor accepting optional `fallback` and `stdin` injections (defaults to new noop instance and `process.stdin`).
   - `request()` body: TTY check → fallback to noop with stderr warning; render prompt to stderr (header + path + line count + first 40 lines); use `readline.createInterface` to read action; branch on `a|r|e` (normalize, allow full words); reject branch prompts again for feedback; edit branch writes artifact text to tmp file, spawns `$EDITOR ?? 'nano'`, waits exit, reads file, returns delta; **always** unlink temp file in `finally`.
   - Verify: file compiles (`npm run typecheck`).
3. **Modify `src/orchestrator/checkpoints/registry.ts`**:
   - Add `import { CliCheckpointMechanism } from "./mechanisms/cli.js";` near the top (after noop import).
   - Add `registerCheckpointMechanism("cli", new CliCheckpointMechanism());` after the existing noop registration line.
   - Verify: registration order is `noop` first, then `cli` (preserve module-load semantics; either order works but stay consistent).
4. **Create `src/orchestrator/checkpoints/mechanisms/cli.test.ts`** (colocated — see HARD CONSTRAINT above):
   - Mirror Sprint 7's test style (`describe(...)` per concern, test-id tags in labels).
   - Implement (a) approve, (b) reject + feedback, (c) edit + EDITOR stub, (d) non-TTY fallback (assert noop spy invoked + stderr warning), and (perf) <200ms with pre-stuffed Readable.
   - Verify: `npm run test -- cli` passes locally.
5. **DO NOT modify `index.ts`** — confirm by re-reading it post-implementation.
6. **Run full verification**:
   - `npm run typecheck` — exit 0
   - `npm run lint` — exit 0
   - `npm run build` — exit 0
   - `npm run test` — exit 0 (all sprints, especially `src/discovery/scanner.test.ts > 'detects co-located tests'`)

---

## Verification Checklist (per success criterion)

- [ ] **s8-c1** — Read `src/orchestrator/checkpoints/mechanisms/cli.ts`. Prompt header includes `[Checkpoint: <id>]`, optional path, line count, first-40-lines summary, action prompt `Approve (a), Reject (r), Edit (e)?`. Stdin via `readline.createInterface`.
- [ ] **s8-c2** — Three branches map to `{approved:true}` / `{approved:false, feedback}` / `{edit:true, editDelta}`. `$EDITOR ?? 'nano'`.
- [ ] **s8-c3** — `if (!process.stdin.isTTY)` → `process.stderr.write(...)` + delegate to fallback instance (a `NoopCheckpointMechanism`). Warning string contains `"not a TTY"`.
- [ ] **s8-c4** — `grep -n 'registerCheckpointMechanism("cli"' src/orchestrator/checkpoints/registry.ts` returns one line at module top-level (not inside a function).
- [ ] **s8-c5** — Run `npm run test -- cli`; all four cases pass. Case (d) MUST assert the noop spy `.request` was called (not just outcome equality).
- [ ] **s8-c6** — Perf test measures only `request()` wall-clock with pre-stuffed `Readable.from(["a\n"])`; asserts < 200ms.
- [ ] **s8-c7** — `npm run typecheck && npm run lint && npm run build && npm run test` all exit 0. Pipeline default still resolves `"noop"` at all 9 sites (no pipeline.ts edits in this sprint).
- [ ] **Colocation regression** — `src/discovery/scanner.test.ts > 'detects co-located tests'` still passes (it will, because the new test landed in `src/`, growing colocated count to 25 vs separate 22).

---

## Pitfalls & Warnings

- **DO NOT** put the test in `tests/orchestrator/checkpoints/cli.test.ts`. The contract is wrong on this; the COLOCATION HARD CONSTRAINT above is binding.
- **DO NOT** modify `src/orchestrator/checkpoints/index.ts`. Mechanisms stay opaque per Sprint 7 evaluator's barrel convention. The coordinator never imports `CliCheckpointMechanism` directly.
- **DO NOT** modify `src/orchestrator/pipeline.ts` — Sprint 14 wires the mechanism selection. This sprint only registers the new mechanism; default behavior must remain noop.
- **DO NOT** use `getCheckpointMechanism("noop")` inside `cli.ts` for the TTY fallback — creates a soft circular import (cli.ts → registry.ts → cli.ts). Use a direct `NoopCheckpointMechanism` instance instead.
- **DO NOT** write prompts to `stdout`. Use `process.stderr.write`. Stdout may be parsed by parent harnesses.
- **DO NOT** use `child.stdio: 'pipe'` for the editor spawn — must be `'inherit'` so the editor gets the real TTY (vim/nano need it).
- **DO NOT** forget `finally { await unlink(tmpPath).catch(() => {}) }` — evaluatorNotes call this out explicitly; the temp file must be cleaned up even when `$EDITOR` exits non-zero.
- **DO NOT** reject on editor non-zero exit code — treat as "saved as-is" and read the file. User may have used `:cq` in vim deliberately; orchestrator decides what to do with the delta.
- **DO NOT** assume `process.env.EDITOR` is set. Default to `"nano"`. On systems without `nano`, the spawn will fail; surface that error clearly (don't swallow it) — but the temp file must STILL be cleaned up.
- **Import extension:** all relative imports MUST end in `.js` (NodeNext ESM resolution). `from "../types.js"`, `from "../noop.js"`, etc. (Sprint 5 scanner confirms project convention.)
- **TTY mocking** in tests: `process.stdin.isTTY` is a getter on a non-configurable property in some Node versions. Use `Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true })` and restore in `afterEach`.
- **EDITOR with spaces** (e.g., `"code --wait"`): `spawn(editor, [tmpPath])` will treat the whole string as one binary name. Either split on whitespace (`const [cmd, ...args] = editor.split(/\s+/)`) or document that complex EDITOR commands are unsupported for this sprint (Sprint 11+ can refine).
