# Sprint Briefing: `bober replay run` deterministic regression gate + runReplayHarness API

**Contract:** sprint-spec-20260615-self-improve-p1-p2-2
**Generated:** 2026-06-15T19:05:00Z

---

## 0. The Load-Bearing Rules (read first — easy to get subtly wrong)

These two definitions are the entire point of the sprint. State them in code comments exactly.

**Deterministic fresh-verdict derivation (NO LLM):**
> For each captured case, parse the frozen `evalDetailsJson` (it is `JSON.stringify(payload.results)` — an array, see capture at `src/cli/commands/replay.ts:117-119`). The **fresh verdict is `'fail'` iff ANY captured failure detail has `passed === false` AND `severity === 'error'`; otherwise it is `'pass'`.** No clock, no fs, no network, no generator/evaluator LLM. The same frozen fixtures must always yield the same fresh verdict.

**Regression / improvement classification (in `compareToBaseline`):**
> For each `caseId`:
> - `baselineVerdict === 'pass'` AND `freshVerdict === 'fail'` → **regression**
> - `baselineVerdict === 'fail'` AND `freshVerdict === 'pass'` → **improvement**
> - otherwise (pass→pass or fail→fail) → **unchanged**

A regression is STRICTLY pass→fail. Do not classify a fresh-only or baseline-only caseId as a regression; the harness only compares caseIds present in the baseline corpus.

The contract forbids re-running the LLM (`nonGoals[0]`, `outOfScope`): the evaluator's grep check (`evaluatorNotes`) will FAIL the sprint if `replay-harness.ts` references `runGeneratorAgent`, `runEvaluatorAgent`, or `createClient`. Do not import any of them.

---

## 1. Target Files

### src/orchestrator/selfimprove/replay-harness.ts (create)

**Directory pattern:** Modules in `src/orchestrator/selfimprove/` are kebab-case, named-export only, with a top-of-file JSDoc banner and `// ── Section ──` rules. See `replay-store.ts` and `replay-types.ts`.
**Most similar pure-function exemplar:** `src/orchestrator/memory/distill.ts` — mirror its purity discipline (header that says PURE / no Date.now / no fs, deterministic output, params-only). See Section 2.
**Two required exports** (per `successCriteria` sc-2-3 / sc-2-4 and `generatorNotes`):

```typescript
// PURE — no clock, no fs, no LLM. All inputs are parameters.
export type Verdict = "pass" | "fail";

export interface ReplayComparison {
  regressions: string[];   // caseIds: baseline pass -> fresh fail
  improvements: string[];  // caseIds: baseline fail -> fresh pass
  unchanged: string[];     // same verdict
}

// (1) PURE comparator — mirror distill.ts purity. baseline + fresh keyed by caseId.
export function compareToBaseline(
  baseline: Map<string, Verdict>,
  fresh: Map<string, Verdict>,
): ReplayComparison { /* classify each caseId in `baseline` */ }

// (2) async gate — opens the Sprint-1 ReplayStore, re-derives fresh verdicts, compares.
export async function runReplayHarness(
  projectRoot: string,
  config: BoberConfig,
): Promise<ReplayComparison & { total: number }> { /* ... */ }
```

NOTE the contract's `generatorNotes` permits baseline/fresh to be "Map<caseId,'pass'|'fail'> OR arrays of {caseId, verdict}". Pick ONE shape and keep it consistent; **Map is simplest and matches the test seeding ("seeded with putCase rows of known verdicts")**. The CLI builds the fresh Map by re-deriving from each record's `evalDetailsJson`; the baseline Map from each record's `baselineVerdict`.

**Imports this file will need (verified):**
- `import { ReplayStore } from "./replay-store.js";` — `src/orchestrator/selfimprove/replay-store.ts:68`
- `import type { ReplayCaseRecord } from "./replay-types.js";` — `src/orchestrator/selfimprove/replay-types.ts:22`
- `import type { BoberConfig } from "../../config/schema.js";` — `src/config/schema.ts:416`
- `import { join } from "node:path";` (to build `<replayDir>/replay.db`)
- For the fresh-verdict derivation, parse `record.evalDetailsJson` with `JSON.parse` and narrow leniently (mirror distill.ts's `isRecord` style at `distill.ts:83-85`).

**Reading config tolerantly:** `runReplayHarness` receives `config` already loaded (the CLI calls `loadConfig`). `config.selfImprove` is OPTIONAL and may be `undefined` (see Section 5). Resolve `const replayDir = config.selfImprove?.replayDir ?? ".bober/replay";` then `const dbPath = join(projectRoot, replayDir, "replay.db");`.

**Test file:** `src/orchestrator/selfimprove/replay-harness.test.ts` (create — sc-2-5).

---

### src/orchestrator/selfimprove/replay-harness.test.ts (create)

**Most similar test:** `src/state/facts.test.ts` (in-memory store seeding) + `src/cli/commands/replay.test.ts` (Sprint 1).
**Pattern:** seed a `new ReplayStore(":memory:")`, `putCase(...)` rows with known `baselineVerdict` and known `evalDetailsJson` (so the derived fresh verdict is predictable), then assert. Four required cases (sc-2-5): identical rerun → zero regressions; pass→fail flip → in `regressions` exactly once; fail→pass flip → in `improvements`; empty corpus → all-empty arrays. Each uses an in-memory store. See Section 6.

---

### src/cli/commands/replay.ts (modify)

Add a fourth subcommand `run` INSIDE `registerReplayCommand` (`src/cli/commands/replay.ts:43`), after the `show` block ends at `src/cli/commands/replay.ts:262`. Mirror the existing subcommand structure EXACTLY: `.command("run")`, `.description(...)`, `.option("--replay-dir <dir>", ..., ".bober/replay")`, `.action(async (opts) => { const projectRoot = await resolveRoot(); try { ... } catch (err) { process.stderr.write(...); process.exitCode = 1; } })`.

The `run` handler must:
1. `loadConfig(projectRoot)` tolerantly (config absence is not fatal — wrap in its own try/catch and fall back so the default `.bober/replay` is still usable; see facts.ts pattern Section 5). OR pass an explicit `--replay-dir` override into a minimal config-shaped object. Simplest: load config, on failure build a stub `{ selfImprove: { replayDir: opts.replayDir, ... } }`-shaped value, then call `runReplayHarness`.
2. Call `const result = await runReplayHarness(projectRoot, config);`.
3. If `result.total === 0` → `process.stdout.write(chalk.gray("no cases captured\n"));` and return (exit 0).
4. Else print a per-case delta table: columns `caseId | baseline | fresh | delta` (use the padEnd chalk style from `list` at `replay.ts:196-207`). `delta` = "REGRESSION" / "improvement" / "unchanged" (or "ok"). To print per-case rows you need the per-case baseline+fresh verdicts — keep them available (e.g. have the harness also return the fresh Map, or rebuild the table inside the CLI). Cleanest: the CLI calls the harness AND re-derives the table from the same two Maps. (Consider having `runReplayHarness` return `{ ...comparison, total, baseline, fresh }` so the CLI prints without re-opening the DB.)
5. If `result.regressions.length > 0` → print the regressed caseIds (chalk.red) and set `process.exitCode = 1;`.

**Imports already present (reuse — do NOT re-add):** `chalk` (`replay.ts:14`), `Command` type (`replay.ts:15`), `join` (`replay.ts:16`), `ReplayStore` (`replay.ts:22`), `resolveRoot()` (`replay.ts:26-29`). **Add:** `import { loadConfig } from "../../config/loader.js";` (see facts.ts:18) and `import { runReplayHarness } from "../../orchestrator/selfimprove/replay-harness.js";`.

**Imported by:** `src/cli/index.ts` registers it (grep `registerReplayCommand`). Adding a subcommand is additive — no caller signature changes.

**Test file:** `src/cli/commands/replay.test.ts` (exists — extend it, sc-2-6).

---

### src/cli/commands/replay.test.ts (modify)

Add an `invokeRun(...)` helper mirroring the existing `invokeCapture/invokeList/invokeShow` helpers (`replay.test.ts:63-157`) and a `describe("replay run ...")` block. Seed a corpus by either (a) calling `invokeCapture` over seeded eval-results, or (b) directly opening `new ReplayStore(join(tmpDir, ".bober/replay/replay.db"))` and `putCase`-ing rows with crafted `evalDetailsJson`. Assert `process.exitCode === 0` on a clean corpus and `process.exitCode === 1` when a seeded case regresses (baseline pass + evalDetailsJson containing a `{passed:false, severity:"error"}` failure). Capture/restore `process.exitCode` around each invocation (already done in `beforeEach/afterEach` at `replay.test.ts:27-37`).

---

## 2. Patterns to Follow

### Pure-function discipline (mirror for compareToBaseline)
**Source:** `src/orchestrator/memory/distill.ts`, header lines 1-24 + function 121-289.
```typescript
// src/orchestrator/memory/distill.ts:1-6 (header banner)
/**
 * PURE deterministic distillation of sprint outcomes into LessonEntry records.
 *
 * PURE — must not import from ../providers; no network, no Date.now(), no side effects,
 * no filesystem access. createdAt is stamped at PERSIST TIME by the CLI handler, not here.
 */
```
```typescript
// src/orchestrator/memory/distill.ts:83-85 — lenient narrowing helper to reuse style
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
```
```typescript
// src/orchestrator/memory/distill.ts:286 — deterministic ordering for byte-identical output
lessons.sort((a, b) => a.lessonId.localeCompare(b.lessonId));
```
**Rule:** Put a PURE banner on `compareToBaseline`, take only parameters, read no clock/fs/network, and SORT every output array (`regressions/improvements/unchanged`) for deterministic output. The evaluator greps the body for `fs`/`Date` — there must be none.

### CLI subcommand + no-throw / process.exitCode discipline
**Source:** `src/cli/commands/replay.ts:221-262` (the `show` subcommand — the closest template for `run`).
```typescript
// src/cli/commands/replay.ts:222-240 (structure to mirror)
replayCmd
  .command("show <id>")
  .description("Print one replay case with full provenance")
  .option("--replay-dir <dir>", "Replay directory (default: .bober/replay)", ".bober/replay")
  .action(async (id: string, opts: { replayDir: string }) => {
    const projectRoot = await resolveRoot();
    try {
      // ... work ...
      if (rec === null) {
        process.stderr.write(chalk.yellow(`Replay case not found: ${id}\n`));
        process.exitCode = 1;
        return;
      }
      // ... print ...
    } catch (err) {
      process.stderr.write(
        chalk.red(`Failed to show replay case: ${err instanceof Error ? err.message : String(err)}\n`),
      );
      process.exitCode = 1;
    }
  });
```
**Rule:** The handler MUST NOT throw — wrap the body in try/catch and on any error `process.stderr.write(chalk.red(...))` + `process.exitCode = 1; return;`. Set `process.exitCode = 1` on regressions; never `process.exit()`.

### chalk padded table (mirror for the delta table)
**Source:** `src/cli/commands/replay.ts:196-207` (the `list` table).
```typescript
// src/cli/commands/replay.ts:196-207
process.stdout.write(
  chalk.bold(`${"ID".padEnd(18)} ${"CONTRACT".padEnd(40)} ${"ITER".padEnd(6)} ${"VERDICT".padEnd(8)} CAPTURED\n`),
);
process.stdout.write(`${"-".repeat(100)}\n`);
for (const c of cases) {
  process.stdout.write(
    `${c.caseId.padEnd(18)} ${c.contractId.padEnd(40)} ${String(c.iteration).padEnd(6)} ${c.baselineVerdict.padEnd(8)} ${c.tCaptured}\n`,
  );
}
```
**Rule:** Build the run delta table the same way — `caseId | baseline | fresh | delta` with `padEnd`, header in `chalk.bold`, a `-`-repeat separator. Color regressions `chalk.red`, improvements `chalk.green`.

### Tolerant loadConfig (config absence is not fatal)
**Source:** `src/cli/commands/facts.ts:41-50`.
```typescript
// src/cli/commands/facts.ts:41-50
async function resolveDefaultNamespace(projectRoot: string): Promise<string | undefined> {
  try {
    const config = await loadConfig(projectRoot);
    return loadTeam(config, undefined).memoryNamespace || undefined;
  } catch {
    return undefined; // Never throws — config absence is not fatal.
  }
}
```
**Rule:** Wrap `loadConfig` in try/catch in the CLI handler; on failure fall back to a default config so `replay run` still works with `--replay-dir`. `runReplayHarness` itself receives an already-resolved `config` and reads `config.selfImprove?.replayDir ?? ".bober/replay"`.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `ReplayStore` | `src/orchestrator/selfimprove/replay-store.ts:68` | `new ReplayStore(dbPath: string)` | SQLite case store; `:memory:`-testable. The harness opens this at `<replayDir>/replay.db`. |
| `ReplayStore.listCases` | `src/orchestrator/selfimprove/replay-store.ts:142` | `listCases(): ReplayCaseRecord[]` | Returns all cases ordered by `t_captured ASC`. Primary harness input. |
| `ReplayStore.getBaselineVerdict` | `src/orchestrator/selfimprove/replay-store.ts:152` | `getBaselineVerdict(id: string): string \| null` | Baseline verdict for a caseId (the record also carries `baselineVerdict`, so you may not need this). |
| `ReplayStore.putCase` | `src/orchestrator/selfimprove/replay-store.ts:90` | `putCase(input: ReplayCaseInput): ReplayCaseRecord` | Seeds the in-memory corpus in tests. |
| `ReplayStore.getCase` | `src/orchestrator/selfimprove/replay-store.ts:132` | `getCase(id): ReplayCaseRecord \| null` | Single case lookup. |
| `ReplayStore.close` | `src/orchestrator/selfimprove/replay-store.ts:160` | `close(): void` | MUST be called in a `finally` after listing (see `replay.ts:208-210`). |
| `ReplayCaseRecord` (type) | `src/orchestrator/selfimprove/replay-types.ts:22` | `interface ... extends ReplayCaseInput { caseId: string }` | Record shape consumed by the harness. |
| `loadConfig` | `src/config/loader.ts:142` | `(projectRoot: string): Promise<BoberConfig>` | Loads + validates config; throws if no config file — catch it. |
| `BoberConfig` (type) | `src/config/schema.ts:416` | `z.infer<typeof BoberConfigSchema>` | `runReplayHarness` param type. `config.selfImprove` is OPTIONAL. |
| `findProjectRoot` / `resolveRoot` | `src/utils/fs.ts` / `src/cli/commands/replay.ts:26` | `(): Promise<string \| undefined>` / `(): Promise<string>` | Root resolution; `resolveRoot` already exists in replay.ts — reuse it. |
| `chalk` | `src/cli/commands/replay.ts:14` | — | Table/colored output. Already imported. |
| `join` | `node:path` (`replay.ts:16`) | — | Build `<replayDir>/replay.db`. |

**Directories reviewed for the inventory:** `src/orchestrator/selfimprove/`, `src/orchestrator/memory/`, `src/config/`, `src/utils/fs.ts`, `src/state/`. No existing comparator/diff util for verdicts exists — `compareToBaseline` is genuinely new (grep for `compareToBaseline`/`runReplayHarness` in `src/` returns nothing).

---

## 4. Prior Sprint Output (Sprint 1 — commit ffd6e8a, PASSED)

### `src/orchestrator/selfimprove/replay-store.ts` — exports `ReplayStore`, `caseId`
The harness loads cases via `listCases()`; each record gives baseline + frozen eval details.
```typescript
// src/orchestrator/selfimprove/replay-store.ts:142-147
listCases(): ReplayCaseRecord[] {
  const rows = this.db
    .prepare(`SELECT * FROM replay_cases ORDER BY t_captured ASC`)
    .all() as RawRow[];
  return rows.map(rowToRecord);
}
```
```typescript
// src/orchestrator/selfimprove/replay-store.ts:152-157
getBaselineVerdict(id: string): string | null {
  const row = this.db
    .prepare(`SELECT baseline_verdict FROM replay_cases WHERE case_id = ?`)
    .get(id) as Pick<RawRow, "baseline_verdict"> | undefined;
  return row?.baseline_verdict ?? null;
}
```
```typescript
// src/orchestrator/selfimprove/replay-store.ts:45-55 — the record fields the harness reads
function rowToRecord(row: RawRow): ReplayCaseRecord {
  return {
    caseId: row.case_id,
    contractId: row.contract_id,
    iteration: row.iteration,
    baselineVerdict: row.baseline_verdict as "pass" | "fail",
    diffDigest: row.diff_digest,
    evalDetailsJson: row.eval_details_json,  // <-- frozen results JSON; re-derive fresh verdict from this
    tCaptured: row.t_captured,
  };
}
```

### `src/orchestrator/selfimprove/replay-types.ts` — exports `ReplayCaseSchema`, `ReplayCaseInput`, `ReplayCaseRecord`
```typescript
// src/orchestrator/selfimprove/replay-types.ts:9-24
export const ReplayCaseSchema = z.object({
  contractId: z.string().min(1),
  iteration: z.number().int(),
  baselineVerdict: z.enum(["pass", "fail"]),
  diffDigest: z.string().min(1),
  evalDetailsJson: z.string(),     // <-- JSON.stringify of the eval `results[]` array
  tCaptured: z.string().datetime(),
});
export type ReplayCaseInput = z.infer<typeof ReplayCaseSchema>;
export interface ReplayCaseRecord extends ReplayCaseInput { caseId: string; }
```
**Connection:** `runReplayHarness` builds `baseline: Map<caseId, record.baselineVerdict>` and `fresh: Map<caseId, deriveFresh(record.evalDetailsJson)>`, then calls `compareToBaseline(baseline, fresh)`.

### `src/config/schema.ts` — `selfImprove` section (Sprint 1)
```typescript
// src/config/schema.ts:122-127
export const SelfImproveSectionSchema = z.object({
  deterministicGate: z.boolean().default(false),
  rubricIsolation: z.boolean().default(false),
  requireCitedArtifact: z.boolean().default(false),
  replayDir: z.string().default(".bober/replay"),
});
```

### `src/cli/commands/replay.ts` — `registerReplayCommand` (capture|list|show)
Sprint 2 extends this with `run` (see Section 1). The frozen `evalDetailsJson` is produced at capture time:
```typescript
// src/cli/commands/replay.ts:116-119 — what evalDetailsJson contains
const baselineVerdict = payload.passed ? "pass" : "fail";
const resultsJson = JSON.stringify(payload.results);   // <-- this is evalDetailsJson
const diffDigest = createHash("sha256").update(resultsJson).digest("hex").slice(0, 32);
const evalDetailsJson = resultsJson;
```

### How `evalDetailsJson` is shaped (for the fresh-verdict rule)
`payload.results` is the `.bober/eval-results/eval-*.json` `results[]` array, written by `eval-persist.ts`:
```typescript
// src/orchestrator/eval-persist.ts:57-65 — each result carries a `failures` array of failing details
results: evaluation.results.map((r) => ({
  evaluator: r.evaluator,
  passed: r.passed,
  score: r.score,
  summary: r.summary,
  ...(r.passed ? {} : { feedback: r.feedback }),
  ...(r.lensVerdicts ? { lensVerdicts: r.lensVerdicts } : {}),
  failures: r.details.filter((d) => !d.passed),   // each detail: { passed:false, severity:'error'|'warning'|'info', message, ... }
})),
```
`severity` values are `"error" | "warning" | "info"` (see `evaluator-agent.ts:287`).
**Fresh-verdict derivation rule (implement EXACTLY):** parse `evalDetailsJson` to an array; the verdict is `'fail'` iff any element's `failures[]` (or any nested detail) has `passed === false && severity === 'error'`; else `'pass'`. Narrow defensively — `failures` may be absent, `severity` may be missing. Treat malformed/empty details as `'pass'` (no error-severity failure found).

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` content load-bearing for this sprint was found beyond the off-by-default self-improve gating already encoded in `SelfImproveSectionSchema` (`src/config/schema.ts:122-127`). All four flags default `false` — replay is an OFFLINE, opt-in tool and must not touch the live pipeline.

### Architecture / config tolerance
`config.selfImprove` is declared `.optional()` at `src/config/schema.ts:414` and is NOT given a default during the loader merge (`src/config/loader.ts:186-236` lists project/planner/generator/evaluator/sprint/pipeline/commands defaults but NOT selfImprove). Therefore on a config WITHOUT a `selfImprove` block, `config.selfImprove` is `undefined`. **`runReplayHarness` MUST default it:** `config.selfImprove?.replayDir ?? ".bober/replay"`. Do not assume `config.selfImprove` exists.

### Other docs
- npm scripts (`package.json:12-16`): `build` = `tsc`, `typecheck` = `tsc --noEmit`, `lint` = `eslint src/`, `test` = `vitest`.
- ESM/NodeNext: ALL relative imports end in `.js` (e.g. `./replay-store.js`, `../../config/loader.js`). Type-only imports use `import type`.

---

## 6. Testing Patterns

### Unit test pattern (harness — in-memory ReplayStore)
**Source:** `src/state/facts.test.ts:1-14` (in-memory store seeding) + `src/cli/commands/replay.test.ts:11-37`.
```typescript
// src/state/facts.test.ts:1-14 — runner + in-memory store
import { describe, it, expect, afterEach } from "vitest";
import { FactStore, factId } from "./facts.js";
// ...
store = new FactStore(":memory:");   // <-- mirror: new ReplayStore(":memory:")
```
Harness test skeleton (seed known verdicts, derive predictable fresh):
```typescript
import { describe, it, expect, afterEach } from "vitest";
import { ReplayStore } from "./replay-store.js";
import { runReplayHarness, compareToBaseline } from "./replay-harness.js";

// evalDetailsJson that derives to 'fail': one error-severity failure
const FAIL_DETAILS = JSON.stringify([{ evaluator: "x", passed: false, failures: [{ passed: false, severity: "error", message: "boom" }] }]);
// evalDetailsJson that derives to 'pass': no error-severity failures
const PASS_DETAILS = JSON.stringify([{ evaluator: "x", passed: true, failures: [] }]);

describe("compareToBaseline (sc-2-3)", () => {
  it("flags pass->fail as a regression exactly once", () => {
    const base = new Map([["c1", "pass"]]);  const fresh = new Map([["c1", "fail"]]);
    const r = compareToBaseline(base, fresh);
    expect(r.regressions).toEqual(["c1"]);
    expect(r.improvements).toEqual([]);
  });
  it("flags fail->pass as an improvement", () => {
    expect(compareToBaseline(new Map([["c1","fail"]]), new Map([["c1","pass"]])).improvements).toEqual(["c1"]);
  });
  it("empty corpus -> all empty", () => {
    const r = compareToBaseline(new Map(), new Map());
    expect(r).toEqual({ regressions: [], improvements: [], unchanged: [] });
  });
});
```
For `runReplayHarness`, seed via store then call with a stub config:
```typescript
const store = new ReplayStore(":memory:"); // NOTE: harness opens its OWN store by path — see pitfall below
```
**Runner:** vitest. **Assertion style:** `expect(...)`. **Mock approach:** `vi.spyOn` (CLI tests only). **File naming:** co-located `*.test.ts`. **Location:** co-located next to source.

### CLI exit-code test pattern (sc-2-6)
**Source:** `src/cli/commands/replay.test.ts:251-260` (the show-bogus exit-code-1 assertion) + the invoke helpers at `replay.test.ts:63-157`.
```typescript
// src/cli/commands/replay.test.ts:27-37 — capture/restore process.exitCode each test
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-replay-cmd-"));
  process.exitCode = 0;
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  process.exitCode = 0;
});
```
```typescript
// src/cli/commands/replay.test.ts:251-260 — asserting exitCode=1 without throwing
it("sets exitCode=1 ... no throw", async () => {
  process.exitCode = 0;
  const { stderr } = await invokeShow("bogus-unknown-id-xxx");
  expect(stderr).toContain("bogus-unknown-id-xxx");
  expect(process.exitCode).toBe(1);
});
```
```typescript
// src/cli/commands/replay.test.ts:63-92 — invoke helper to clone for invokeRun
async function invokeCapture(replayDir = ".bober/replay") {
  const stdoutWrites: string[] = []; const stderrWrites: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((c) => { stdoutWrites.push(String(c)); return true; });
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((c) => { stderrWrites.push(String(c)); return true; });
  const fsUtils = await import("../../utils/fs.js");
  const rootSpy = vi.spyOn(fsUtils, "findProjectRoot").mockResolvedValue(tmpDir);
  try {
    const { Command } = await import("commander");
    const { registerReplayCommand } = await import("./replay.js");
    const program = new Command(); program.exitOverride(); registerReplayCommand(program);
    await program.parseAsync(["node", "bober", "replay", "capture", "--replay-dir", replayDir]);
  } finally { stdoutSpy.mockRestore(); stderrSpy.mockRestore(); rootSpy.mockRestore(); }
  return { stdout: stdoutWrites.join(""), stderr: stderrWrites.join("") };
}
```
**Clone this as `invokeRun`** (args `["node","bober","replay","run","--replay-dir",replayDir]`). It mocks `findProjectRoot` → `tmpDir`, so the harness's `loadConfig(tmpDir)` will throw (no config in tmpDir) — your CLI handler MUST catch that and fall back to `opts.replayDir` so the seeded `tmpDir/.bober/replay/replay.db` is read. Seed that DB before invoking: open `new ReplayStore(join(tmpDir, ".bober/replay/replay.db"))`, `putCase` a row with `baselineVerdict:"pass"` and `evalDetailsJson = FAIL_DETAILS`, close, then `invokeRun()` and assert `process.exitCode === 1`. Also test a clean corpus (`baselineVerdict:"pass"`, `evalDetailsJson = PASS_DETAILS`) → exit 0, and empty corpus → "no cases captured" + exit 0.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/commands/replay.ts` | extended in place | low | New `run` subcommand is purely additive; capture/list/show handlers untouched. Don't alter existing imports' behavior. |
| `src/cli/index.ts` | `registerReplayCommand` | low | Registration signature unchanged (still one function). No edit needed unless `runReplayHarness` is also surfaced elsewhere (it is not — Sprint 4 imports it directly). |
| `src/orchestrator/selfimprove/replay-store.ts` | read-only consumer | none | Harness only CALLS `listCases()` — do not modify the store (nonGoals: no schema change). |
| `src/config/schema.ts` / `loader.ts` | read `selfImprove` | none | Read-only. Do not add a default for `selfImprove` in the loader (out of scope) — handle `undefined` in the harness. |

### Existing Tests That Must Still Pass
- `src/cli/commands/replay.test.ts` — tests capture/list/show (sc-1-7). Your additions extend this file; the existing 4 describe blocks (`replay capture`, `replay list`, `replay show`, `replay command registration` at `replay.test.ts:161-279`) must still pass. The registration test (`replay.test.ts:263-278`) currently asserts `subNames` contains `capture/list/show` — after your change it will ALSO contain `run`; that test does not assert exclusivity so it still passes, but consider adding `expect(subNames).toContain("run")`.
- `src/orchestrator/selfimprove/replay-store.test.ts` — tests `putCase/getCase/listCases/getBaselineVerdict` against `:memory:`. Must still pass (you don't touch the store).
- `src/config/loader.test.ts` — config load tests. Must still pass (no loader change).

### Features That Could Be Affected
- **Sprint 4 `evolve` (future)** — will `import { runReplayHarness } from "../selfimprove/replay-harness.js"` as its promotion gate. Keep the public signature `runReplayHarness(projectRoot: string, config: BoberConfig)` returning `{ regressions, improvements, unchanged, total }` exactly as the contract states (sc-2-4) so Sprint 4 compiles. Do NOT make it depend on CLI-only state.

### Recommended Regression Checks (run after implementation)
1. `npm run build` (tsc) — exits 0, zero type errors.
2. `npm run typecheck` — exits 0.
3. `npm test -- replay-harness replay` — all new + existing replay tests green.
4. `npm run lint` — zero errors on new/modified files (sc-2-7, not required but desired).
5. Manual: `node dist/cli/index.js replay capture` then `node dist/cli/index.js replay run` over a captured corpus → table prints, exit 0 on clean.
6. `git diff --name-only` must NOT include `src/orchestrator/evaluator-agent.ts`, `src/orchestrator/pipeline.ts`, or `agents/` (evaluatorNotes hard check).
7. `grep -nE "runGeneratorAgent|runEvaluatorAgent|createClient|Date\.now|new Date|fs\.|readFile|writeFile" src/orchestrator/selfimprove/replay-harness.ts` → in `compareToBaseline` there must be NONE; `runReplayHarness` may use `join` + `ReplayStore` but NO LLM client and NO clock.

---

## 8. Implementation Sequence (dependency-ordered)

1. **`src/orchestrator/selfimprove/replay-harness.ts`** — Define `Verdict`, `ReplayComparison`. Implement PURE `compareToBaseline(baseline, fresh)` first (sorted outputs, params-only). Then implement a private `deriveFreshVerdict(evalDetailsJson: string): Verdict` (parse + scan for `passed===false && severity==='error'`). Then `runReplayHarness(projectRoot, config)`: resolve `replayDir = config.selfImprove?.replayDir ?? ".bober/replay"`, open `new ReplayStore(join(projectRoot, replayDir, "replay.db"))`, `listCases()` in a `try/finally { store.close() }`, build `baseline` + `fresh` Maps, return `{ ...compareToBaseline(baseline, fresh), total: cases.length }` (consider also returning `baseline` + `fresh` so the CLI can print rows without reopening the DB).
   - Verify: `npm run typecheck` passes; the file imports `ReplayStore` + `BoberConfig` only — no LLM/client imports.
2. **`src/orchestrator/selfimprove/replay-harness.test.ts`** — Cover sc-2-5: identical→0 regressions, pass→fail→1 regression, fail→pass→improvement, empty→all-empty. Use `:memory:` store + crafted `evalDetailsJson` (FAIL_DETAILS/PASS_DETAILS) for the `runReplayHarness` path, and direct Maps for the `compareToBaseline` path.
   - Verify: `npm test -- replay-harness` green.
3. **`src/cli/commands/replay.ts`** — Add `loadConfig` + `runReplayHarness` imports; add the `run` subcommand after the `show` block (`replay.ts:262`). Tolerant config load (try/catch fallback to `opts.replayDir`), call harness, print delta table (mirror list table), print regressed ids + `process.exitCode = 1` on regressions, "no cases captured" + exit 0 on empty.
   - Verify: `npm run build` passes; `node dist/cli/index.js replay run --help` shows the subcommand.
4. **`src/cli/commands/replay.test.ts`** — Add `invokeRun` helper + `describe("replay run")` block (sc-2-6): seed DB directly, assert exit 1 on regression, exit 0 on clean, "no cases captured" on empty. Optionally extend the registration test to assert `subNames` contains `"run"`.
   - Verify: `npm test -- replay` green.
5. **Full verification** — `npm run build` && `npm run typecheck` && `npm test -- replay-harness replay` && `npm run lint`. Confirm `git diff --name-only` excludes evaluator-agent.ts / pipeline.ts / agents/.

---

## 9. Pitfalls & Warnings

- **Do NOT re-run the LLM.** No `runGeneratorAgent` / `runEvaluatorAgent` / `createClient` imports in `replay-harness.ts` — the evaluator greps for them and fails the sprint (`evaluatorNotes`). Fresh verdict comes ONLY from frozen `evalDetailsJson`.
- **`config.selfImprove` can be `undefined`.** It is `.optional()` (`schema.ts:414`) and gets NO loader default (`loader.ts:186-236`). Always use `config.selfImprove?.replayDir ?? ".bober/replay"`. A non-optional access will crash at runtime on a minimal config.
- **CLI test root is mocked to `tmpDir`** (`replay.test.ts:76`), which has no bober config — so `loadConfig(tmpDir)` THROWS inside the harness path. The CLI `run` handler MUST catch the config error and fall back to `opts.replayDir`, otherwise every CLI run test fails. (Cleanest: in the CLI, try `loadConfig`, on failure synthesize a minimal config object whose `selfImprove.replayDir = opts.replayDir`.)
- **`compareToBaseline` must stay pure.** No `Date`, no `fs`, no store access inside it — those belong in `runReplayHarness`. The evaluator greps the comparator body.
- **Sort all output arrays** in `compareToBaseline` for deterministic, byte-identical output (mirror `distill.ts:286`). Map iteration order over a freshly-built Map is insertion order, which depends on `listCases()` ordering — sorting removes that coupling.
- **Re-derive over the baseline keyset only.** Iterate `baseline` (or `listCases()` records); a caseId present in `fresh` but absent in `baseline` is NOT a regression (the corpus defines what's gated). Classify strictly pass→fail / fail→pass / unchanged.
- **`severity` strings are `"error" | "warning" | "info"`** (`evaluator-agent.ts:287`). Only `"error"` flips fresh to fail. A `"warning"`-only failures array still derives to `'pass'`. Don't treat `passed:false` alone as fail — it must also be error-severity.
- **`evalDetailsJson` is an ARRAY** (`JSON.stringify(payload.results)`, `replay.ts:117`), and failing details live in each element's `failures[]` (`eval-persist.ts:64`). Parse defensively: guard non-array, missing `failures`, missing `severity`.
- **ESM `.js` import suffixes** are mandatory (`./replay-harness.js`, `../../config/loader.js`). Omitting them fails NodeNext resolution at runtime even if tsc is lenient.
- **`store.close()` in a `finally`** — mirror `replay.ts:208-210`. Leaking a better-sqlite3 handle in tests can wedge the `:memory:` lifecycle.
- **Don't call `process.exit()`** — only set `process.exitCode`. `process.exit()` would kill the vitest worker.
