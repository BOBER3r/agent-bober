# Sprint Briefing: Portfolio reporter, runFleet entrypoint, and fleet CLI command

**Contract:** sprint-spec-20260609-fleet-orchestrator-4
**Generated:** 2026-06-09T00:00:00Z

---

## 1. Target Files

### src/fleet/reporter.ts (create)

**Directory pattern:** `src/fleet/` uses kebab-case `.ts` files, section comments `// ── Name ───`, named exports, classes for stateful seams. Collocated `*.test.ts`.
**Most similar existing file (atomic write):** `src/state/run-state.ts` — MIRROR its temp+rename technique.
**Most similar existing file (tally/class):** `src/fleet/aggregator.ts` (class `OutcomeAggregator`).

`PortfolioReport` shape (from contract sc-4-4): `{ total, completed, failed, other, children: ChildOutcome[], generatedAt: string }`.

- `build(outcomes: ChildOutcome[]): PortfolioReport` — tally; `other` = anything NOT `completed`/`failed`; `generatedAt = new Date().toISOString()`.
- `write(rootDir: string, report: PortfolioReport): Promise<string>` — write `<rootDir>/.bober/fleet-report.json` atomically, return ABSOLUTE path. **This is the ONE place allowed to throw on IO failure.**

### src/fleet/index.ts (create)

Exports `runFleet(manifestPath, options): Promise<PortfolioReport>` and `registerFleetCommand(program: Command): void`.
**Most similar registration file:** `src/cli/commands/worktree.ts` (`registerWorktreeCommand` shape).

### src/cli/index.ts (modify)

**Insert wiring after line 286** (after `registerMemoryCommand(program);`, before the Parse section line 288):
```ts
  // ── memory ────────────────────────────────────────────────────────
  registerMemoryCommand(program);

  // ── fleet ─────────────────────────────────────────────────────────
  registerFleetCommand(program);

  // ── Parse ───────────────────────────────────────────────────────
  await program.parseAsync(process.argv);
```
**Add import** alongside the other `register*Command` imports (lines 21-35). Note: existing imports come from `./commands/...`; the fleet registration lives in `src/fleet/index.ts`, so import:
```ts
import { registerFleetCommand } from "../fleet/index.js";
```
**DO NOT touch** the `run` command block (lines 189-227). **DO NOT touch** `src/cli/commands/run.ts` or runPipeline.

---

## 2. Patterns to Follow

### Atomic temp-file + rename write (MIRROR EXACTLY)
**Source:** `src/state/run-state.ts`, lines 10-53
```ts
import { rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { ensureDir } from "./helpers.js";   // reporter is in src/fleet/, see note below

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
**Rule for reporter.write:** compute `const dir = join(rootDir, ".bober");` and `const filePath = join(dir, "fleet-report.json");`. Call `await mkdir(dir, { recursive: true })` (import `mkdir` from `node:fs/promises` — `ensureDir` lives in `src/state/helpers.ts`; you may import it as `import { ensureDir } from "../state/helpers.js"` OR just call `mkdir` directly, both are codebase-idiomatic — `ensureDir` is literally `mkdir(p,{recursive:true})` per `src/state/helpers.ts:6-8`). Then tmp = `${filePath}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}.tmp`, `writeFile(tmp, JSON.stringify(report, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 })`, `rename(tmp, filePath)`, return `filePath`. Use `resolve()`/`join()` so the returned path is absolute when `rootDir` is.

### CLI command registration (commander)
**Source:** `src/cli/commands/worktree.ts`, lines 19-49
```ts
import type { Command } from "commander";

export function registerWorktreeCommand(program: Command): void {
  const wtCmd = program
    .command("worktree")
    .description("Launch and manage worktree-isolated pipeline runs");

  wtCmd
    .command("run <task>")
    .description("...")
    .option("--allow-dirty", "...")
    .option("--keep-on-success", "...")
    .action(async (task: string, opts: { allowDirty?: boolean; keepOnSuccess?: boolean }) => {
      // ... handler MUST NOT throw: set process.exitCode=1 and return on error
    });
}
```
**Rule:** Use `import type { Command } from "commander";` (type-only). For fleet:
```ts
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
      // print summary (see run.ts style); exit 0 even if children failed
      process.exitCode = 0;
    } catch (err) {
      logger.error(`Fleet failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });
```
Note: commander option is `--concurrency <n>` → opts key is `opts.concurrency` (camelCased only when multi-word like `--keep-on-success` → `keepOnSuccess`). `--root` → `opts.root`.

### Summary-print + exitCode style (MIRROR, do not modify run.ts)
**Source:** `src/cli/commands/run.ts`, lines 148-217
```ts
console.log(chalk.bold("═══ Pipeline Summary ═══"));
console.log(`  Completed:  ${chalk.green(String(result.completedSprints.length))} sprints`);
if (result.failedSprints.length > 0) {
  console.log(`  Failed:     ${chalk.red(String(result.failedSprints.length))} sprints`);
}
// ... on hard failure only:
process.exitCode = 1;
```
**Rule:** Print a fleet summary using `console.log` + `chalk` (total/completed/failed/other + report path). NOTE: run.ts sets `process.exitCode = 1` on pipeline failure — fleet does NOT do this for per-child failures (always exit 0; only batch-setup catch sets 1).

### Logger
**Source:** `src/utils/logger.ts:13-29` — `logger.info`, `logger.success`, `logger.warn`, `logger.error`. Import: `import { logger } from "../utils/logger.js";`.

### Credential fail-fast logic (match the real client)
**Source:** `src/providers/factory.ts`, lines 128-140 (`validateApiKey`, `openai-compat` case)
```ts
case "openai-compat":
  if (endpoint?.includes("api.deepseek.com")) {
    const key = apiKey ?? process.env["DEEPSEEK_API_KEY"];
    if (!key) {
      throw new Error(`... neither providerConfig.apiKey nor DEEPSEEK_API_KEY is set. ...`);
    }
  }
  break;
```
**Source of child provider values:** `src/fleet/child-config.ts:7-9,21-45` — every child gets `provider: "openai-compat"`, `endpoint: "https://api.deepseek.com"` via `buildChildConfig(child)` UNLESS `child.config` overrides `planner`/`generator`/`evaluator` (shallow merge, top-level key replaces). `providerConfig.apiKey` would live under a role's config (e.g. `config.generator.endpoint`/key). The child's effective config is `buildChildConfig(child)`; inspect `cfg.planner/generator/evaluator` for `provider === "openai-compat"` && `endpoint?.includes("api.deepseek.com")`.
**Rule for runFleet fail-fast:** For each child, `const cfg = buildChildConfig(child);` then for each role config (`cfg.planner`, `cfg.generator`, `cfg.evaluator`) check if it targets DeepSeek; if so require `roleCfg.apiKey ?? process.env["DEEPSEEK_API_KEY"]` — else `throw new Error(...)` BEFORE calling `coordinator.execute`. You may reuse `validateApiKey(roleCfg.provider, role, roleCfg.apiKey, roleCfg.endpoint)` from `factory.ts` to get IDENTICAL semantics/error message (it is exported at `src/providers/factory.ts:86`). Importing `validateApiKey` is the lowest-risk path and avoids drift.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `load` | `src/fleet/manifest.ts:22` | `(manifestPath: string): Promise<FleetManifest>` | Read+parse+Zod-validate manifest; throws on bad path/JSON |
| `buildChildConfig` | `src/fleet/child-config.ts:21` | `(child: FleetChild): BoberConfig` | Effective DeepSeek config per child |
| `validateApiKey` | `src/providers/factory.ts:86` | `(provider, role?, apiKey?, endpoint?): void` | Throws if DeepSeek/other key missing — REUSE for fail-fast |
| `FleetCoordinator` | `src/fleet/coordinator.ts:21` | `new FleetCoordinator({scaffolder?,runner?})`, `.execute(manifest): Promise<ChildExecution[]>` | Fan-out scaffold→run; DI constructor for fakes |
| `OutcomeAggregator` | `src/fleet/aggregator.ts:15` | `.aggregate(execution): Promise<ChildOutcome>` | Map one execution to a ChildOutcome |
| `probeCliVersion` | `src/fleet/runner.ts:43` | `(cliEntry: string): Promise<boolean>` | Optional preflight (ADR-4); never throws |
| `resolveCliEntry` | `src/fleet/runner.ts:9` | `(): string` | dist/cli/index.js path for probe |
| `ensureDir` | `src/state/helpers.ts:6` | `(dirPath: string): Promise<void>` | `mkdir(p,{recursive:true})` |
| `logger` | `src/utils/logger.ts` | `.info/.success/.warn/.error` | CLI output |

**Types to import:** `ChildOutcome`, `ChildStatus`, `ChildExecution` from `./types.js` (`src/fleet/types.ts:16-27`); `FleetManifest`, `FleetChild` from `./manifest.js`; `Command` from `commander` (type-only).

---

## 4. Prior Sprint Output

### Sprint 1: manifest + child-config
**Created:** `src/fleet/manifest.ts` exports `load`, `FleetManifest` (`{rootDir, concurrency, children}`), `FleetChild`. `src/fleet/child-config.ts` exports `buildChildConfig`.
**Connection:** runFleet calls `load(manifestPath)`, applies `options.concurrency`/`options.rootDir` overrides onto the manifest, then uses `buildChildConfig` for the credential check.

### Sprint 2: runner
**Created:** `src/fleet/runner.ts` exports `resolveCliEntry()`, `probeCliVersion()`, `ChildRunner`. Test fixture: `src/fleet/__fixtures__/stub-child.js`.
**Connection:** optional CLI preflight in runFleet; tests can inject `ChildRunner` via coordinator DI.

### Sprint 3: coordinator + aggregator + types
**Created:** `src/fleet/coordinator.ts` (`FleetCoordinator`, DI `constructor(deps?: {scaffolder?, runner?})`, `.execute(manifest)`), `src/fleet/aggregator.ts` (`OutcomeAggregator.aggregate`), `src/fleet/types.ts` (`ChildExecution`, `ChildOutcome{folder,status:'completed'|'failed'|'other',source,exitCode?,runId?,runState?}`).
**Connection:** runFleet pipeline = `coordinator.execute(manifest)` → `Promise.all(executions.map(e => aggregator.aggregate(e)))` → `reporter.build(outcomes)` → `reporter.write(manifest.rootDir, report)`. Inject `FleetCoordinator`/`OutcomeAggregator` (or factory deps) into runFleet so tests pass fakes — mirror `coordinator.test.ts` fake-injection style.

**DI recommendation:** Give `runFleet` an optional deps param, e.g. `runFleet(manifestPath, options, deps?: { coordinator?: FleetCoordinator; aggregator?: OutcomeAggregator; reporter?: PortfolioReporter })` defaulting to `new FleetCoordinator()` etc. This lets `index.test.ts` drive end-to-end deterministically without spawns.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM everywhere** — `.js` extensions on all relative imports (`run-state.ts:10-15` shows the pattern).
- **`import type`** for type-only imports (consistent-type-imports enforced).
- **No `any`** — use `unknown` + narrowing. `(err as Error).message` is the idiom (manifest.ts:29).
- **No sync fs** — `node:fs/promises` only.
- **No SDK leakage outside providers/** — runFleet/reporter must NOT import provider SDKs; using `validateApiKey` from `providers/factory.ts` is fine (it's the providers boundary).
- **Errors-as-data EXCEPT:** `reporter.write` (the one IO-throw point) and runFleet batch-setup (bad manifest, missing credentials, report-write failure) MAY throw. Per-child failures are DATA in the report (never throw).
- **Section comments** `// ── Name ───`; collocated `*.test.ts`.

### Architecture
ADR-4 (probe CLI entry before spawn) referenced in `runner.ts:5,36`. No new ADR file required for this sprint.

---

## 6. Testing Patterns

### Unit Test Pattern — DI fakes (no fs mocks)
**Source:** `src/fleet/coordinator.test.ts:10-46`
```ts
import { describe, it, expect } from "vitest";
// build typed fakes that satisfy the Scaffolder/Runner interfaces and inject via constructor
const coord = new FleetCoordinator({ scaffolder: makeScaffolder(), runner: makeRunner() });
```
For `index.test.ts`: inject a fake coordinator whose `.execute` returns canned `ChildExecution[]`, and a fake aggregator returning canned `ChildOutcome[]`, to drive runFleet without spawning. Assert the returned report counts and that the report file exists.

### Atomic write test (temp dir, no leftover .tmp)
**Source:** `src/state/run-state.test.ts:8-71`
```ts
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-fleet-report-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

it("is atomic — no .tmp files remain after a successful write", async () => {
  await reporter.write(tmpDir, report);
  const entries = await readdir(join(tmpDir, ".bober"));
  expect(entries.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  const parsed = JSON.parse(await readFile(join(tmpDir, ".bober", "fleet-report.json"), "utf-8"));
  expect(parsed.total).toBe(report.total);
});
```
**Unwritable-dir throws:** create a temp dir, `chmod` it `0o400` (or write to a path whose parent is a file) and assert `await expect(reporter.write(badRoot, report)).rejects.toThrow()`. (No `chmod` test exists yet in the codebase for this; mkdtemp + a read-only parent is the established no-mock approach.)

### CLI registration test (in-process, no parseAsync needed)
**Source:** `src/cli/commands/worktree.test.ts:14-39`
```ts
import { Command } from "commander";
import { registerFleetCommand } from "./index.js"; // from src/fleet/

it("registers a 'fleet' command with --concurrency and --root", () => {
  const program = new Command();
  registerFleetCommand(program);
  const fleet = program.commands.find((c) => c.name() === "fleet")!;
  expect(fleet).toBeDefined();
  const optNames = fleet.options.map((o) => o.long);
  expect(optNames).toContain("--concurrency");
  expect(optNames).toContain("--root");
});
```

### exitCode + env unset/restore pattern
**Source:** `src/cli/commands/plan.test.ts:39,107-118`
```ts
beforeEach(() => { process.exitCode = undefined; });
// ...
expect(process.exitCode).toBe(1);
```
**Credential fail-fast test (sc-4-7, CRITICAL):**
```ts
let savedKey: string | undefined;
beforeEach(() => { savedKey = process.env["DEEPSEEK_API_KEY"]; delete process.env["DEEPSEEK_API_KEY"]; });
afterEach(() => { if (savedKey !== undefined) process.env["DEEPSEEK_API_KEY"] = savedKey; else delete process.env["DEEPSEEK_API_KEY"]; });

it("throws before any spawn when DeepSeek key is missing (sc-4-7)", async () => {
  let scaffoldCalled = false;
  const fakeScaffolder = { async scaffold(){ scaffoldCalled = true; /*...*/ } };
  const coord = new FleetCoordinator({ scaffolder: fakeScaffolder, runner: /*spy*/ });
  await expect(runFleet(manifestPath, {}, { coordinator: coord })).rejects.toThrow(/DEEPSEEK_API_KEY/);
  expect(scaffoldCalled).toBe(false); // proves no scaffold/spawn happened
});
```
With the key set, assert it proceeds and returns a report. Use a real manifest file written into a mkdtemp dir (no fs mocks).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/index.ts` | new `registerFleetCommand` import | low | Import path `../fleet/index.js`; new command registered before `parseAsync` (line 289) |
| `src/fleet/index.ts` | coordinator/aggregator/reporter/manifest/child-config | medium | All `.js` ESM imports resolve; DI defaults instantiate correctly |

`src/cli/index.ts` is the entry; no other file imports from it. `src/fleet/index.ts` is new (no current importers). The `run` command and runPipeline are untouched.

### Existing Tests That Must Still Pass
- `src/fleet/coordinator.test.ts`, `aggregator.test.ts`, `manifest.test.ts`, `child-config.test.ts`, `runner.test.ts`, `scaffolder.test.ts` — Sprint 1-3 modules you import; verify unchanged behavior.
- `src/cli/commands/worktree.test.ts`, `plan.test.ts`, etc. — confirm the cli/index.ts edit doesn't break command-registration tests.
- Any run-command tests (sc-4-9) — must be UNTOUCHED and green (you must not edit `run.ts`/runPipeline).

### Features That Could Be Affected
- **fleet (this feature)** — shares `src/fleet/*`; verify Sprint 1-3 modules still pass.
- **run / pipeline** — shares only `cli/index.ts`; verify `run` still registers and behaves identically.

### Recommended Regression Checks
1. `npx vitest run src/fleet/` — all fleet tests green.
2. `npx vitest run src/cli/` — CLI registration + run tests green.
3. `git diff src/cli/commands/run.ts src/orchestrator/pipeline.ts` — MUST be empty.
4. `npm run build && npx tsc --noEmit && npx eslint src/fleet src/cli/index.ts` — clean.

---

## 8. Implementation Sequence

1. **src/fleet/reporter.ts** — define `PortfolioReport` interface + `PortfolioReporter` class with `build()` (tally; `new Date().toISOString()`) and `write()` (atomic temp+rename mirroring run-state.ts:41-53; return absolute path).
   - Verify: `build([])` returns zeros; `write` creates `.bober/fleet-report.json`, no `.tmp` left.
2. **src/fleet/reporter.test.ts** — count tallies (mixed outcomes: completed/failed/other), atomic write, unwritable-dir throws.
   - Verify: `npx vitest run src/fleet/reporter.test.ts` green.
3. **src/fleet/index.ts → runFleet** — `load` → apply concurrency/rootDir overrides → credential fail-fast (`buildChildConfig` + `validateApiKey`) BEFORE execute → `coordinator.execute` → `Promise.all(map(aggregate))` → `reporter.build` → `reporter.write(manifest.rootDir, report)` → return report. Optional `deps` param for DI.
   - Verify: returns report; never throws on per-child failure; throws on missing manifest / missing DeepSeek key / write failure.
4. **src/fleet/index.ts → registerFleetCommand** — commander `fleet <manifest>` + `--concurrency`/`--root`; action try/catch sets exitCode 0 (per-child) / 1 (setup error); print summary (run.ts style, do not modify run.ts).
   - Verify: registration test asserts command + options exist.
5. **src/fleet/index.test.ts** — end-to-end runFleet with injected fakes; credential fail-fast (no spawn); registration test.
   - Verify: `npx vitest run src/fleet/index.test.ts` green.
6. **src/cli/index.ts** — add `import { registerFleetCommand } from "../fleet/index.js";` and `registerFleetCommand(program);` before `parseAsync`.
   - Verify: build + cli tests green.
7. **Full verification** — `npm run build`, `npx tsc --noEmit`, `npx eslint`, `npx vitest run`.

---

## 9. Pitfalls & Warnings

- **DO NOT touch** `src/cli/commands/run.ts` or `src/orchestrator/pipeline.ts` (sc-4-9). Diff must be empty.
- **Per-child failures => exit 0.** Only batch-setup errors (bad manifest, missing credentials, report-write IO failure) set `process.exitCode = 1` / throw. `reporter.write` is the ONLY place allowed to throw on IO.
- **generatedAt** = `new Date().toISOString()` (ISO-8601), not `Date.now()` number.
- **`other`** = anything not `completed`/`failed` (running/aborted-mapped-to-failed already happens in aggregator; treat any leftover status as `other`). Tally directly from `ChildOutcome.status` values.
- **Import path for fleet command into cli/index.ts is `../fleet/index.js`** (NOT `./commands/...`). All other register* imports come from `./commands/` — fleet is the exception.
- **commander option camelCasing:** `--concurrency <n>` → `opts.concurrency`; `--root <dir>` → `opts.root`. `Number(opts.concurrency)` only when present (guard with `opts.concurrency ? Number(...) : undefined`).
- **Credential check must run BEFORE `coordinator.execute`** — compute `buildChildConfig(child)` for every child first. Use `validateApiKey` (factory.ts:86) for identical error text; do not re-implement the DeepSeek/endpoint matching.
- **No fs mocks** (principles.md:44) — use `mkdtemp` + cleanup. No `vi.mock` of node:fs.
- **rootDir override:** `options.rootDir` (and `--root`) overrides `manifest.rootDir`; pass the EFFECTIVE rootDir to `reporter.write`. `--concurrency` overrides `manifest.concurrency` before `coordinator.execute`.
- **Atomic write returns the path** — `reporter.write` returns `string` (absolute path), runFleet ignores or logs it; the report itself is what runFleet returns.
- **`import type { Command } from "commander"`** (type-only) for registerFleetCommand, matching worktree.ts:16.
