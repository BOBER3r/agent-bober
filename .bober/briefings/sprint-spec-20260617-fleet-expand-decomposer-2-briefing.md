# Sprint Briefing: fleet expand subcommand (write-and-stop, --yes gate)

**Contract:** sprint-spec-20260617-fleet-expand-decomposer-2
**Generated:** 2026-06-17T20:30:00Z

> Goal: add `agent-bober fleet expand <goal>` as a **child** of the existing `fleet` command in `src/fleet/index.ts`. It builds the DeepSeek client (credential fail-fast BEFORE any IO), calls `decomposeGoal` (Sprint 1), assembles `{ rootDir, concurrency, children }`, atomically writes it to `<root>/.bober/fleet-expand.json`, prints it + a review hint, and **STOPS** unless `--yes` is passed (then chains into the locked `runFleet(outPath)`). The `fleet <manifest>` registration line MUST stay byte-identical.

---

## 1. Target Files

### `src/fleet/index.ts` (modify — additive only)

This file already exports `runFleet`, `FleetDeps`, `FleetOptions`, `validateManifestCredentials` (internal), and `registerFleetCommand`. You will ADD a new exported `runFleetExpand(...)` function and a new exported `registerFleetExpandSubcommand(fleet: Command)`, then call it from inside `registerFleetCommand`.

**CRITICAL — the `fleet <manifest>` registration must stay byte-identical (lines 133-165):**
```ts
export function registerFleetCommand(program: Command): void {
  program
    .command("fleet <manifest>")
    .description("Run a fleet of agent-bober children from a manifest")
    .option("--concurrency <n>", "Override manifest concurrency")
    .option("--root <dir>", "Override manifest rootDir")
    .action(async (manifest: string, opts: { concurrency?: string; root?: string }) => {
      try {
        const report = await runFleet(manifest, {
          concurrency: opts.concurrency ? Number(opts.concurrency) : undefined,
          rootDir: opts.root,
        });

        console.log();
        console.log(chalk.bold("═══ Fleet Summary ═══"));
        console.log();
        console.log(`  Total:      ${chalk.cyan(String(report.total))} children`);
        console.log(`  Completed:  ${chalk.green(String(report.completed))}`);
        if (report.failed > 0) {
          console.log(`  Failed:     ${chalk.red(String(report.failed))}`);
        }
        if (report.other > 0) {
          console.log(`  Other:      ${chalk.yellow(String(report.other))}`);
        }
        console.log();

        process.exitCode = 0;
      } catch (err) {
        logger.error(`Fleet failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });
}
```

**THE ATTACHMENT PROBLEM (read carefully):** `program.command("fleet <manifest>")` registers `fleet` as a command WITH a positional `<manifest>` argument. To attach `expand` as a child WITHOUT changing the `.command("fleet <manifest>")` line, you must **capture the Command object that line returns** and attach the child to it. Refactor like this (the `.command("fleet <manifest>")` / `.description` / `.option` / `.action` chain stays byte-for-byte; only the surrounding assignment changes):

```ts
export function registerFleetCommand(program: Command): void {
  const fleet = program
    .command("fleet <manifest>")
    .description("Run a fleet of agent-bober children from a manifest")
    .option("--concurrency <n>", "Override manifest concurrency")
    .option("--root <dir>", "Override manifest rootDir")
    .action(async (manifest: string, opts: { concurrency?: string; root?: string }) => {
      // ... UNCHANGED body (lines 140-163 above) ...
    });

  registerFleetExpandSubcommand(fleet);   // attach the child
}
```
The mutation here is only `program` → `const fleet = program` and adding the trailing call. The `.command("fleet <manifest>")` string literal and the entire `.action(...)` body are unchanged — sc-2-7 diffs this.

**`runFleet` signature + `FleetDeps` DI shape to mirror (lines 28-32, 88-92):**
```ts
export interface FleetDeps {
  coordinator?: FleetCoordinator;
  aggregator?: OutcomeAggregator;
  reporter?: PortfolioReporter;
}

export async function runFleet(
  manifestPath: string,
  options?: FleetOptions,
  deps?: FleetDeps,
): Promise<PortfolioReport> { ... }
```
Mirror this for `runFleetExpand(goal, opts, deps?)` — `deps` injects the seams (`decomposeGoal`, `runFleet`, `createClient`) so tests avoid real network/spawn.

**Current imports in this file (lines 10-22):**
```ts
import chalk from "chalk";
import type { Command } from "commander";
import { load } from "./manifest.js";
import { buildChildConfig } from "./child-config.js";
import { FleetCoordinator } from "./coordinator.js";
import { OutcomeAggregator } from "./aggregator.js";
import { PortfolioReporter } from "./reporter.js";
import { validateApiKey } from "../providers/factory.js";
import { logger } from "../utils/logger.js";
import type { FleetManifest } from "./manifest.js";
import type { ChildOutcome } from "./types.js";
import type { PortfolioReport } from "./reporter.js";
```
**Imports you must ADD** (note `.js` extensions, `import type` for types):
```ts
import { join } from "node:path";
import { writeFile, rename, access } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createClient } from "../providers/factory.js";   // validateApiKey already imported
import { decomposeGoal } from "./decomposer.js";
import { ensureDir } from "../state/helpers.js";           // mkdir-recursive helper
import type { LLMClient } from "../providers/types.js";
```

**Imported by:** `src/cli/index.ts:38` (`import { registerFleetCommand } from "../fleet/index.js";`) and `src/fleet/index.test.ts:6`. Your new exports add to this file but do not require changes in `cli/index.ts` (the `expand` child is attached inside `registerFleetCommand`, which is already wired at `src/cli/index.ts:317`).

**Test file:** `src/fleet/index.test.ts` exists (does NOT cover expand). Add new tests in `src/fleet/expand.test.ts` (per `estimatedFiles`).

---

### `src/fleet/expand.test.ts` (create)

**Directory pattern:** fleet tests are collocated kebab/lowercase `*.test.ts` next to source. Most similar existing file: `src/fleet/index.test.ts` — mirror its imports, temp-dir setup, env-var save/restore, and fake-injection style.

**Structure template (based on `src/fleet/index.test.ts:1-11, 67-81`):**
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { runFleetExpand, registerFleetCommand } from "./index.js";
import type { FleetManifest } from "./manifest.js";

describe("runFleetExpand write-and-stop (sc-2-4)", () => {
  let tmpDir: string;
  let savedKey: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-expand-"));
    savedKey = process.env["DEEPSEEK_API_KEY"];
    process.env["DEEPSEEK_API_KEY"] = "fake-key-for-test";
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    if (savedKey !== undefined) process.env["DEEPSEEK_API_KEY"] = savedKey;
    else delete process.env["DEEPSEEK_API_KEY"];
  });

  // ... inject fake decomposeGoal + spy runFleet + fake client builder via deps ...
});
```

---

## 2. Patterns to Follow

### Parent + child Commander attachment (THE pattern to mirror)
**Source:** `src/cli/commands/worktree.ts`, lines 23-29
```ts
export function registerWorktreeCommand(program: Command): void {
  const wtCmd = program
    .command("worktree")
    .description("Launch and manage worktree-isolated pipeline runs");

  wtCmd
    .command("run <task>")
    .description("Run the full Bober pipeline in an isolated git worktree on a new branch")
    .option("--allow-dirty", "...")
    .action(async (task: string, opts: { allowDirty?: boolean; keepOnSuccess?: boolean }) => { ... });
}
```
**Rule:** Capture the parent `Command` returned by `program.command(...)` into a const, then call `.command(...)` on that const to attach the child. For this sprint the parent already exists (`fleet <manifest>`), so capture it as `const fleet = program.command("fleet <manifest>")...` and pass `fleet` to `registerFleetExpandSubcommand`.

### CLI action error handling (set exitCode, do not throw)
**Source:** `src/fleet/index.ts`, lines 160-163 (and `worktree.ts:75-82`)
```ts
} catch (err) {
  logger.error(`Fleet failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
```
**Rule:** Wrap the `expand` `.action` in try/catch; on any error call `logger.error(...)` and set `process.exitCode = 1`. The action itself should `await runFleetExpand(...)`. Credential fail-fast errors from `createClient` propagate here → exit 1, no file written (sc-2-6).

### Atomic temp + rename write
**Source:** `src/state/run-state.ts`, lines 41-53
```ts
export async function writeRunState(projectRoot: string, state: RunState): Promise<void> {
  await ensureDir(runDir(projectRoot, state.runId));
  const filePath = statePath(projectRoot, state.runId);
  const rnd = randomBytes(4).toString("hex");
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${rnd}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  await rename(tmp, filePath);
}
```
**Rule:** Mirror EXACTLY for the manifest write: `await ensureDir(dirname(outPath))`, write to `${outPath}.${process.pid}.${Date.now()}.${rnd}.tmp`, then `rename(tmp, outPath)`. Use `JSON.stringify(manifest, null, 2)` (contract says null, 2). For the "overwrite notice", check existence BEFORE the rename with `await access(outPath).then(() => true, () => false)` and print a notice if it existed.

### ensureDir (recursive mkdir, async)
**Source:** `src/state/helpers.ts`, lines 6-8
```ts
export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}
```
**Rule:** Import `ensureDir` from `../state/helpers.js` to create `<root>/.bober/` before writing. Do NOT call `mkdir` directly — reuse this helper.

### Section comments (project convention)
**Source:** `src/fleet/index.ts`, lines 26, 34, 67, 123; principles.md:32
```ts
// ── DI seam ───────────────────────────────────────────────────────────
// ── Credential fail-fast ──────────────────────────────────────────────
// ── runFleet ──────────────────────────────────────────────────────────
// ── registerFleetCommand ──────────────────────────────────────────────
```
**Rule:** Add `// ── runFleetExpand ──` and `// ── registerFleetExpandSubcommand ──` headers for your new sections.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `decomposeGoal` | `src/fleet/decomposer.ts:159` | `(input: DecomposeInput): Promise<FleetManifest>` where `DecomposeInput = { goal; client: LLMClient; model: string; maxRetries?: number }` | Sprint 1 — one DeepSeek jsonObjectMode call + 1 coercion retry, returns Zod-valid children-only manifest. CALL with `{ goal, client, model, maxRetries: 1 }`. |
| `createClient` | `src/providers/factory.ts:172` | `(provider?, endpoint?, providerConfig?, model?, role?): LLMClient` | Builds an LLMClient; runs `validateApiKey` internally → THROWS fail-fast when `DEEPSEEK_API_KEY` missing for `api.deepseek.com`. |
| `validateApiKey` | `src/providers/factory.ts:86` | `(resolvedProvider, role?, apiKey?, endpoint?): void` | DeepSeek branch (lines 128-140) throws when `endpoint.includes("api.deepseek.com")` and no key. Already invoked by `createClient`; you do NOT need to call it directly. |
| `runFleet` | `src/fleet/index.ts:88` | `(manifestPath, options?, deps?): Promise<PortfolioReport>` | LOCKED Phase 1 entrypoint. On `--yes`, call `runFleet(outPath)` against the freshly-written file. Never modify. |
| `ensureDir` | `src/state/helpers.ts:6` | `(dirPath: string): Promise<void>` | Recursive async mkdir. Use before the atomic write. |
| `FleetManifestSchema` | `src/fleet/manifest.ts:13` | Zod object `{ rootDir(default "."), concurrency(int≥1, default 3), children(≥1) }` | Validate/parse the assembled object; gives the concurrency default = 3. |
| `logger` | `src/utils/logger.ts:87` | `logger.error(msg)`, `logger.info(...)` etc. | Error logging in the catch block. |
| `buildChildConfig` | `src/fleet/child-config.ts:21` | `(child: FleetChild): BoberConfig` | NOT directly needed by expand (decomposer produces children-only). Do not call. |

DeepSeek constants live in `src/fleet/child-config.ts:7-9` but are **module-private** (`const DEEPSEEK_PROVIDER = "openai-compat"`, `DEEPSEEK_ENDPOINT = "https://api.deepseek.com"`, `DEEPSEEK_MODEL = "deepseek-v4-pro"`). They are NOT exported. The contract specifies you inline the literals in the `createClient` call: provider `"openai-compat"`, endpoint `"https://api.deepseek.com"`, model default `"deepseek-v4-pro"` — matching those constants exactly.

---

## 4. Prior Sprint Output

### Sprint 1 (DONE, commit 4c1dc09): `src/fleet/decomposer.ts`
**Exports:** `decomposeGoal(input: DecomposeInput): Promise<FleetManifest>`, `DecomposeInput`, `validateManifest`, `DECOMPOSE_SYSTEM_PROMPT`, `DECOMPOSE_COERCION_INSTRUCTION`, `DECOMPOSE_MAX_RETRIES`.

**Exact signature (decomposer.ts:44-49, 159-160):**
```ts
export interface DecomposeInput {
  goal: string;
  client: LLMClient;        // from ../providers/types.js
  model: string;
  maxRetries?: number;
}
export async function decomposeGoal(input: DecomposeInput): Promise<FleetManifest> {
  const { goal, client, model, maxRetries = DECOMPOSE_MAX_RETRIES } = input;
```
Returns a `FleetManifest` whose `children` are children-only (`{ folder, task }`, no `config` key — guarded at decomposer.ts:144-152). **Connection:** `runFleetExpand` builds the client via `createClient`, calls `decomposeGoal({ goal, client, model, maxRetries: 1 })`, then assembles `{ rootDir, concurrency, children: decomposed.children }`. Note: `decomposeGoal` returns a full FleetManifest (it parses via `FleetManifestSchema`), so `decomposed.children` is the children array to lift.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM .js imports** — every relative import ends in `.js` (principles.md:27).
- **`import type` for types** — `consistent-type-imports` enforced (principles.md:35). Use `import type { LLMClient } from "../providers/types.js"`, `import type { FleetManifest } from "./manifest.js"`, `import type { Command } from "commander"`.
- **No SDK leakage** — never import provider SDKs outside `providers/`; go through `createClient`/`LLMClient` (principles.md:28, 41).
- **No synchronous fs** — only `node:fs/promises` (principles.md:42). Use `writeFile`, `rename`, `access`, and `ensureDir` (async).
- **No `any`** — use `unknown` + narrowing (principles.md:40). The `opts` object should be typed as `{ count?: string; provider?: string; model?: string; root?: string; concurrency?: string; out?: string; yes?: boolean }`.
- **Section comments** — `// ── Section ──` headers (principles.md:32).
- **Collocated tests, temp dirs, no fs mocks** — create real temp dirs and clean up (principles.md:20, 44).

### Architecture Decisions
`src/state/run-state.ts:6-8` documents that atomic writes "mirror src/incident/timeline.ts:86-92 atomicWriteJson pattern" — temp-file + rename is the project-wide standard. No fleet-specific ADR file found beyond the inline DI/credential-fail-fast doc comments in `src/fleet/index.ts:76-86`.

### Other Docs
No `CLAUDE.md`/`CONTRIBUTING.md` coding-guideline file in repo root relevant beyond principles.md.

---

## 6. Testing Patterns

### Unit Test Pattern (fleet DI / fake injection)
**Source:** `src/fleet/index.test.ts` — temp dir + env save/restore + injected fakes via the `deps` arg.

Env-var save/restore + temp dir (lines 67-81):
```ts
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-fleet-"));
  savedKey = process.env["DEEPSEEK_API_KEY"];
  process.env["DEEPSEEK_API_KEY"] = "fake-key-for-test";
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  if (savedKey !== undefined) process.env["DEEPSEEK_API_KEY"] = savedKey;
  else delete process.env["DEEPSEEK_API_KEY"];
});
```

Credential fail-fast assertion (lines 194-215) — proves NO downstream call when key missing:
```ts
delete process.env["DEEPSEEK_API_KEY"];
let executeCalled = false;
const fakeCoord = { async execute() { executeCalled = true; return []; } } as unknown as FleetCoordinator;
await expect(runFleet(manifestPath, {}, { coordinator: fakeCoord })).rejects.toThrow(/DEEPSEEK_API_KEY/);
expect(executeCalled).toBe(false);
```
Mirror this for sc-2-6: with the key unset, `runFleetExpand` must reject (from the client builder) and the manifest file must NOT exist (`await expect(access(outPath)).rejects.toThrow()`), and the injected `runFleet` spy must not be called.

Commander registration assertion (lines 243-264) — for sc-2-7:
```ts
const program = new Command();
registerFleetCommand(program);
const fleet = program.commands.find((c) => c.name() === "fleet");
expect(fleet).toBeDefined();
expect(fleet!.usage()).toContain("manifest");           // <manifest> positional intact
const subNames = fleet!.commands.map((c) => c.name());   // child commands
expect(subNames).toContain("expand");                    // expand attached
```
(The child-name assertion mirrors `worktree.test.ts:25-28` which does `wtCmd!.commands.map((c) => c.name())`.)

**Runner:** vitest. **Assertion style:** `expect(...)`. **Mock approach:** hand-rolled fakes cast `as unknown as <Type>`, or `vi.fn()` spies passed through the `deps` seam (NO `vi.mock` of fs — use real temp dirs). **File naming:** `*.test.ts` collocated. **Location:** co-located (`src/fleet/expand.test.ts`).

### Fake-injection design for `runFleetExpand`
Define an injectable deps interface so tests pass fakes (mirrors `FleetDeps`):
```ts
export interface FleetExpandDeps {
  decompose?: typeof decomposeGoal;       // fake returns a known FleetManifest
  runFleet?: typeof runFleet;             // spy; asserted called 0 (default) / 1 (--yes)
  createClient?: typeof createClient;     // fake can throw to simulate missing credential
}
```
Test for sc-2-5 (--yes): pass `{ decompose: fakeDecompose, runFleet: vi.fn(...), createClient: fakeBuilder }`, call `runFleetExpand(goal, { yes: true, out: outPath, root: tmpDir }, deps)`, then `expect(deps.runFleet).toHaveBeenCalledTimes(1)` and `expect(deps.runFleet).toHaveBeenCalledWith(outPath)` (or with `(outPath)` — verify only after file exists).

### E2E Test Pattern
Not applicable — no Playwright config; this is a CLI/library sprint.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/index.ts:38,317` | imports + calls `registerFleetCommand` | low | Signature of `registerFleetCommand(program)` is unchanged (still `(program: Command): void`). The refactor only adds an internal const + a call; the CLI wiring at :317 is untouched. |
| `src/fleet/index.test.ts:6,108,...` | imports `runFleet`, `registerFleetCommand` | medium | All existing `runFleet`/`registerFleetCommand` tests MUST pass unchanged. The `fleet <manifest>` `.command/.action` block stays byte-identical so `fleet!.usage()` still `toContain("manifest")` and options `--concurrency`/`--root` still present. |
| `src/fleet/decomposer.ts` | unchanged consumer | low | You only IMPORT `decomposeGoal`; do not modify Sprint-1 file. |
| `src/fleet/manifest.ts`, `child-config.ts` | unchanged | low | nonGoals: must NOT modify `FleetManifestSchema` or `buildChildConfig`. |

### Existing Tests That Must Still Pass
- `src/fleet/index.test.ts` — covers `runFleet` end-to-end fakes, credential fail-fast, and `registerFleetCommand` registration (`--concurrency`, `--root`, `<manifest>` positional). Affected because you refactor `registerFleetCommand` to capture the parent and attach a child; the existing assertions (lines 244-264) must still hold.
- `src/cli/commands/worktree.test.ts` — the parent+child pattern reference; not directly affected but confirms the `.commands.map(c => c.name())` child-detection approach works.

### Features That Could Be Affected
- **Phase 1 fleet (`fleet <manifest>`)** — shares the `fleet` Command object. Verify `fleet <manifest>` still parses with its positional arg and both options after attaching `expand`. The `.action` body for `<manifest>` must be byte-identical (sc-2-7).

### Recommended Regression Checks
1. `npm run build` (tsc) — zero errors (sc-2-1, sc-2-2).
2. `npx eslint src/fleet/index.ts src/fleet/expand.test.ts` — zero errors (consistent-type-imports, no-unused, .js extensions) (sc-2-3).
3. `npx vitest run src/fleet/` — all fleet tests pass, including the unchanged `index.test.ts` (sc-2-7) and new `expand.test.ts`.
4. `git diff src/fleet/index.ts` — confirm the `.command("fleet <manifest>")` line and its `.action(...)` body are unchanged (only `const fleet =` + the trailing `registerFleetExpandSubcommand(fleet)` call differ in that function).
5. `npx vitest run` — full suite green.

---

## 8. Implementation Sequence

1. **Add imports to `src/fleet/index.ts`** — `join`/`dirname` from `node:path`, `writeFile`/`rename`/`access` from `node:fs/promises`, `randomBytes` from `node:crypto`, `createClient` from `../providers/factory.js`, `decomposeGoal` from `./decomposer.js`, `ensureDir` from `../state/helpers.js`, `import type { LLMClient }`.
   - Verify: tsc resolves all imports; no unused-import lint error (every import is used).
2. **Define `FleetExpandDeps` + `FleetExpandOptions` interfaces** (the DI seam + the parsed-options shape), mirroring `FleetDeps` at index.ts:28-32.
   - Verify: no `any`; all option fields are `string | boolean | undefined`.
3. **Write the atomic-write helper inline (or a small local fn)** mirroring `run-state.ts:41-53`: `ensureDir(dirname(outPath))`, check `access(outPath)` for the overwrite notice, write temp, `rename`.
   - Verify: uses async fs only; `JSON.stringify(manifest, null, 2)`.
4. **Implement `export async function runFleetExpand(goal, opts, deps?)`** — order is load-bearing:
   (a) resolve `model = opts.model ?? "deepseek-v4-pro"`; build client via `(deps?.createClient ?? createClient)("openai-compat" (or opts.provider), "https://api.deepseek.com", undefined, model, "FleetDecomposer")` — THROWS before any IO if key missing.
   (b) `const decomposed = await (deps?.decompose ?? decomposeGoal)({ goal: <goal + count hint>, client, model, maxRetries: 1 })`.
   (c) assemble `const root = opts.root ?? "."; const manifest = { rootDir: root, concurrency: opts.concurrency ? Number(opts.concurrency) : 3, children: decomposed.children }`.
   (d) `const outPath = opts.out ?? join(root, ".bober", "fleet-expand.json")`; atomic write (step 3), print overwrite notice if it pre-existed.
   (e) `console.log` the manifest JSON + outPath + `Review then run: agent-bober fleet "<outPath>"`.
   (f) `if (opts.yes) { const report = await (deps?.runFleet ?? runFleet)(outPath); /* print Fleet Summary block mirroring index.ts:146-157 */ } else { process.exitCode = 0; return; }`.
   - Verify: the ONLY call into runFleet is guarded by `if (opts.yes)` (sc-2-4/sc-2-5 structural safety).
5. **Add `export function registerFleetExpandSubcommand(fleet: Command): void`** — `fleet.command("expand <goal>")` with options `--count <n>`, `--provider <p>`, `--model <m>`, `--root <dir>`, `--concurrency <c>`, `--out <path>`, `--yes`; `.action(async (goal, opts) => { try { await runFleetExpand(goal, opts); } catch (err) { logger.error(...); process.exitCode = 1; } })`.
   - Verify: action body is a thin wrapper; all logic lives in `runFleetExpand`.
6. **Refactor `registerFleetCommand`** — change `program.command("fleet <manifest>")...` to `const fleet = program.command("fleet <manifest>")...` (rest byte-identical), then `registerFleetExpandSubcommand(fleet)` at the end.
   - Verify: `git diff` shows only the `const fleet =` assignment + trailing call changed.
7. **Write `src/fleet/expand.test.ts`** — cover sc-2-4 (default writes manifest, runFleet NOT called), sc-2-5 (--yes calls runFleet once with outPath, after write), sc-2-6 (createClient fake throws → no file written, rejects), sc-2-8 (pre-existing file overwritten + notice; --out redirects), and a registration test asserting both `fleet <manifest>` and `expand` exist.
   - Verify: real temp dirs; env save/restore; fakes via `deps`.
8. **Run full verification** — `npm run build`, `npx eslint <files>`, `npx vitest run src/fleet/`, `npx vitest run`.

---

## 9. Pitfalls & Warnings

- **DO NOT change the `.command("fleet <manifest>")` line or its `.action` body.** sc-2-7 diffs it byte-for-byte. The only allowed change in `registerFleetCommand` is `program` → `const fleet = program` and the trailing `registerFleetExpandSubcommand(fleet)` call.
- **`fleet` is a command WITH a positional arg, not a bare parent.** You attach `expand` to the SAME Command object that `program.command("fleet <manifest>")` returns. Do NOT create a second `program.command("fleet")` — that would duplicate/conflict.
- **Credential fail-fast MUST run before any write (sc-2-6).** Call `createClient(...)` (which internally calls `validateApiKey` at factory.ts:216) as the FIRST thing in `runFleetExpand`, before `ensureDir`/`writeFile`. The DeepSeek key check is at `factory.ts:128-140` and only fires when `endpoint.includes("api.deepseek.com")` — so you MUST pass `"https://api.deepseek.com"` as the endpoint or the fail-fast won't trigger.
- **Default path must NEVER call runFleet (sc-2-4/sc-2-5).** The only `runFleet(...)` call site must be inside `if (opts.yes) { ... }`. Tests assert the injected spy is called 0 times by default.
- **`opts.concurrency` is a string (Commander).** Use `opts.concurrency ? Number(opts.concurrency) : 3` (3 = FleetManifestSchema default at manifest.ts:15). Do not pass the raw string into the manifest.
- **`decomposeGoal` returns a full FleetManifest, not just children.** Lift `decomposed.children` into your assembled object; do not nest a manifest inside a manifest.
- **`BOBER_TEST_DETERMINISTIC=1` short-circuits `createClient`** (factory.ts:182-184) returning a stub before `validateApiKey`. If any test env sets it, the credential fail-fast won't fire — your sc-2-6 test should inject a throwing `createClient` fake via `deps` rather than relying solely on the env var, OR ensure that env is unset.
- **Use `dirname(outPath)` for ensureDir** — with `--out` pointing elsewhere, the parent dir may differ from `<root>/.bober`. Always `ensureDir(dirname(outPath))`.
- **ESM `.js` extensions + `import type`** — `node:path`, `node:fs/promises`, `node:crypto` are bare; all local imports need `.js`; `LLMClient`, `Command`, `FleetManifest` are type-only imports.
- **No synchronous fs / no `any`** — use `node:fs/promises` only; type the options object explicitly, no `any`.
- **DeepSeek constants are private** in `child-config.ts:7-9` (not exported) — inline the string literals `"openai-compat"`, `"https://api.deepseek.com"`, `"deepseek-v4-pro"` in the `createClient` call, matching them exactly.
