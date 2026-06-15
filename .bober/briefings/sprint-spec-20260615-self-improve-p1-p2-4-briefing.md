# Sprint Briefing: GEPA offline prompt evolution `bober evolve` — replay-gated, Pareto-set, never live

**Contract:** sprint-spec-20260615-self-improve-p1-p2-4
**Generated:** 2026-06-15T00:00:00Z

---

## 0. The Two Load-Bearing Safety Invariants (read first)

Sprint 4 is gated by a guard test (`sc-4-7`) that reads `gepa.ts`, `evolve.ts`, and `pipeline.ts` **as text** and asserts forbidden patterns are absent. Everything you write must keep both invariants true:

1. **NEVER writes `agents/<role>.md`.** No write path may be constructed under `agents/`. Concretely: there must be **no `join(projectRoot, "agents", ...)` write** anywhere in `gepa.ts` or `evolve.ts`. All writes go under `.bober/evolve/<runId>/`. (You DO call `loadAgentDefinition` to *read* `agents/<role>.md` — reading is fine; only writing under `agents/` is forbidden.)
2. **NEVER invoked by `runPipeline`.** `src/orchestrator/pipeline.ts` must contain **no import of, and no call to, `evolve`/`gepa`**. The evolve verb is reachable ONLY from the CLI. (Verified absent today: `grep evolve|gepa src/orchestrator/pipeline.ts` → NONE. Do not add one.)

**Promotion predicate (strict — a tie does NOT promote):**
```
eligible  ⇔  result.regressions.length === 0  AND  result.improvements.length > baseline.improvements.length
```

**Write discipline:** `report.json` is written **always**; `promoted/<role>.md` is written **only** when a winning variant exists **AND** `!dryRun`.

**Scoring gate:** every variant is scored **ONLY** via `runReplayHarness` (Sprint 2). No `runGeneratorAgent` / `runEvaluatorAgent` / live LLM scoring. The evaluatorNotes grep for those symbols and expect NONE.

---

## 1. Target Files

### `src/orchestrator/selfimprove/gepa.ts` (create)

**Directory pattern:** Files in `src/orchestrator/selfimprove/` are kebab-case, colocated tests (`replay-harness.ts` + `replay-harness.test.ts`, `eval-guards.ts` + `eval-guards.test.ts`). Named ESM exports, `.js` import suffixes (NodeNext).
**Most similar existing file:** `src/orchestrator/selfimprove/eval-guards.ts` — same "PURE pieces + one orchestration entry" shape; mirror its module banner that states the PURE contract.

**Structure template (based on eval-guards.ts:1-12 banner + replay-harness.ts:24-50 type style):**
```typescript
/**
 * GEPA offline prompt evolution. Replay-gated, Pareto-set, NEVER live.
 *
 * SAFETY INVARIANTS:
 *  - No write path is ever constructed under agents/ (no join(projectRoot,'agents',...)).
 *  - Not imported or called by pipeline.ts. CLI-only.
 *  - Variants are scored ONLY via runReplayHarness — no live generator/evaluator runs.
 */
import { join } from "node:path";
import { writeFile } from "node:fs/promises";

import type { BoberConfig } from "../../config/schema.js";
import { loadAgentDefinition } from "../agent-loader.js";
import {
  runReplayHarness,
  type ReplayHarnessResult,
} from "./replay-harness.js";
import { ensureDir } from "../../state/helpers.js";

// ── Types ──────────────────────────────────────────────────────────
export interface VariantScore {
  variantId: string;
  prompt: string;
  promptLength: number;
  replayPassCount: number;       // axis 1 (desc)
  regressions: number;
  improvements: number;
}
export interface GepaResult {
  promoted: boolean;
  winnerPath: string | null;
  baselineRegressions: number;
  variantsTried: number;
}

// ── PURE: seeded PRNG (mulberry32 — NO Math.random) ────────────────
function mulberry32(seed: number): () => number { /* ... */ }

// ── PURE: proposeVariants(basePrompt, seed): string[] ──────────────
export function proposeVariants(basePrompt: string, seed: number): string[] { /* ... */ }

// ── PURE: paretoSet(scored): VariantScore[] ────────────────────────
export function paretoSet(scored: VariantScore[]): VariantScore[] { /* ... */ }

// ── async: evolve(projectRoot, config, opts, deps?) ────────────────
export interface EvolveOptions { role: "generator" | "evaluator"; seed: number; dryRun?: boolean; runId?: string; }
export type HarnessFn = typeof runReplayHarness;          // DI seam shape
export interface EvolveDeps { harness?: HarnessFn; }       // test injects a stub
export async function evolve(
  projectRoot: string,
  config: BoberConfig,
  opts: EvolveOptions,
  deps: EvolveDeps = {},
): Promise<GepaResult> { /* ... */ }
```

**DI SEAM (critical for sc-4-6):** `evolve` must accept an injectable harness so `gepa.test.ts` can pass a stubbed `runReplayHarness`-shaped fn. Default to the real `runReplayHarness`: `const harness = deps.harness ?? runReplayHarness;`. The stub returns a `ReplayHarnessResult` so the test deterministically simulates a regressing variant and a strictly-improving variant **without** a real `.bober/replay/replay.db`.

---

### `src/orchestrator/selfimprove/gepa.test.ts` (create)

**Most similar existing file:** `src/orchestrator/selfimprove/eval-guards.test.ts` (pure-fn assertions) + `src/cli/commands/replay.test.ts` (tmpdir lifecycle + `process.exitCode` reset). Vitest, `describe/it/expect`, colocated.

---

### `src/cli/commands/evolve.ts` (create)

**Most similar existing file:** `src/cli/commands/replay.ts` — copy its `registerReplayCommand` shape exactly (root resolver, tolerant config load, chalk, no-throw + `process.exitCode=1`).
**Structure template (mirrors replay.ts:16-33 + the `replay run` action 269-350):**
```typescript
import chalk from "chalk";
import type { Command } from "commander";

import { findProjectRoot } from "../../utils/fs.js";
import { loadConfig } from "../../config/loader.js";
import { evolve } from "../../orchestrator/selfimprove/gepa.js";

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

export function registerEvolveCommand(program: Command): void {
  program
    .command("evolve")
    .description("Offline replay-gated prompt evolution (never writes agents/, never live)")
    .requiredOption("--role <role>", "generator | evaluator")
    .option("--seed <n>", "Deterministic PRNG seed", "0")
    .option("--dry-run", "Score and report variants but write no promoted/<role>.md")
    .action(async (opts: { role: string; seed: string; dryRun?: boolean }) => {
      const projectRoot = await resolveRoot();
      try {
        // tolerant config load — mirror replay.ts:280-293
        let config; try { config = await loadConfig(projectRoot); } catch { /* stub */ }
        const result = await evolve(projectRoot, config, {
          role: opts.role as "generator" | "evaluator",
          seed: Number(opts.seed) || 0,
          dryRun: Boolean(opts.dryRun),
        });
        process.stdout.write(chalk.bold(`Variants tried: ${result.variantsTried}\n`));
        process.stdout.write(
          result.promoted
            ? chalk.green(`Promoted → ${result.winnerPath}\n`)
            : chalk.gray(`No variant beat the baseline (zero-regression + strictly-more-improvements). Nothing promoted.\n`),
        );
      } catch (err) {
        process.stderr.write(
          chalk.red(`Failed to evolve: ${err instanceof Error ? err.message : String(err)}\n`),
        );
        process.exitCode = 1;        // NEVER throw — replay.ts:177 / facts.ts:141 discipline
      }
    });
}
```
**IMPORTANT for sc-4-7:** keep ALL filesystem writes inside `gepa.ts::evolve`. `evolve.ts` should NOT itself construct any write path. Do NOT import `node:path`/`writeFile` to build a path joined with `'agents'` here.

---

### `src/cli/commands/evolve.test.ts` (create)

**Most similar existing file:** `src/cli/commands/replay.test.ts` — copy the `invoke*` harness (spy `process.stdout/stderr.write`, `vi.spyOn(fsUtils,'findProjectRoot').mockResolvedValue(tmpDir)`, `program.exitOverride()`, `parseAsync(["node","bober","evolve","--role","generator","--dry-run"])`). Reset `process.exitCode = 0` in `beforeEach/afterEach` (replay.test.ts:27-37).

---

### `src/cli/index.ts` (modify)

**Relevant sections (lines 36-40 imports; 314-321 registration):**
```typescript
// 36-40
import { registerMemoryCommand } from "./commands/memory.js";
import { registerFactsCommand } from "./commands/facts.js";
import { registerReplayCommand } from "./commands/replay.js";
import { registerFleetCommand } from "../fleet/index.js";
import { registerChatCommand } from "./commands/chat.js";
```
```typescript
// 314-319 (inside main())
  // ── facts ─────────────────────────────────────────────────────────
  registerFactsCommand(program);

  // ── replay ────────────────────────────────────────────────────────
  registerReplayCommand(program);
```
**Change:** add `import { registerEvolveCommand } from "./commands/evolve.js";` next to the replay import (line ~38), and `registerEvolveCommand(program);` immediately after the `registerReplayCommand(program);` block (line ~319). Two additive lines, nothing else.

---

## 2. Patterns to Follow

### Module banner stating the PURE/safety contract
**Source:** `src/orchestrator/selfimprove/eval-guards.ts`, lines 1-12
```typescript
/**
 * PURE evaluator anti-degeneration guards.
 *
 * PURE — no clock (no Date.now()), no filesystem access, no network, no mutation of inputs.
 * ...
 */
```
**Rule:** Open `gepa.ts` with a banner that explicitly states the two safety invariants and "scored ONLY via runReplayHarness" — it documents intent AND survives the sc-4-7 text scan only if you don't accidentally write the forbidden tokens (see Pitfalls).

### Deterministic, sorted output (for byte-identical variants)
**Source:** `src/orchestrator/selfimprove/replay-harness.ts`, lines 92-97
```typescript
  // Sort for deterministic, byte-identical output — mirrors distill.ts:286.
  regressions.sort((a, b) => a.localeCompare(b));
  improvements.sort((a, b) => a.localeCompare(b));
  unchanged.sort((a, b) => a.localeCompare(b));
```
**Rule:** `proposeVariants` must be byte-identical for a fixed seed — drive ALL nondeterminism through `mulberry32(seed)`, never `Math.random`, `Date.now`, or `Math.floor(Math.random()*…)`.

### CLI handler no-throw discipline
**Source:** `src/cli/commands/replay.ts`, lines 342-349 (and `facts.ts:135-142`)
```typescript
      } catch (err) {
        process.stderr.write(
          chalk.red(
            `Failed to run replay harness: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 1;
      }
```
**Rule:** Every CLI action body is one `try { ... } catch (err) { process.stderr.write(chalk.red(...)); process.exitCode = 1; }`. The handler returns, never throws.

### Tolerant config load (config absence is non-fatal)
**Source:** `src/cli/commands/replay.ts`, lines 278-294
```typescript
        let config: Awaited<ReturnType<typeof loadConfig>>;
        try {
          config = await loadConfig(projectRoot);
        } catch {
          config = { project: { name: "replay", mode: "greenfield" },
            selfImprove: { /* ... */ replayDir: opts.replayDir } } as unknown as Awaited<ReturnType<typeof loadConfig>>;
        }
```
**Rule:** `evolve` CLI loads config tolerantly; pass the resulting `BoberConfig` through to `evolve()` so `runReplayHarness` can read `config.selfImprove?.replayDir` (replay-harness.ts:159).

### runId + ensureDir for `.bober/<feature>/<runId>/`
**Source:** `ensureDir` at `src/state/helpers.ts:6`; usage at `src/cli/commands/replay.ts:67-69`
```typescript
        await ensureDir(replayDir);
        await ensureDir(casesDir);
```
**Rule:** `const runId = opts.runId ?? \`evolve-${Date.now()}\`;` then `const evolveDir = join(projectRoot, ".bober", "evolve", runId);` and `await ensureDir(join(evolveDir, "promoted"));`. The `Date.now()` runId stamp belongs in `evolve()` (orchestration), which is allowed to touch the clock/fs — only the PURE `proposeVariants`/`paretoSet` must stay pure.

### Guard test: read source as text, assert content
**Source:** `src/orchestrator/lens-panel-parity.test.ts`, lines 10-18 and 23-34
```typescript
  it("embeds every resolveLensFocus fragment verbatim", async () => {
    const md = await readFile(
      new URL("../../skills/shared/lens-panel.md", import.meta.url),
      "utf-8",
    );
    for (const lens of BUILT_IN_LENSES) {
      expect(md).toContain(resolveLensFocus(lens));
    }
  });
```
**Rule:** sc-4-7 reads the SOURCE `.ts` (not the bundled `dist`). Resolve paths relative to the test file via `new URL(..., import.meta.url)`. For `gepa.test.ts` reading `gepa.ts`: `new URL("./gepa.ts", import.meta.url)`. For `pipeline.ts`: `new URL("../pipeline.ts", import.meta.url)` (test lives in `src/orchestrator/selfimprove/`, pipeline in `src/orchestrator/`). For `evolve.ts`: `new URL("../../cli/commands/evolve.ts", import.meta.url)`.

**Concrete sc-4-7 assertions to write:**
```typescript
const gepaSrc = await readFile(new URL("./gepa.ts", import.meta.url), "utf-8");
const evolveSrc = await readFile(new URL("../../cli/commands/evolve.ts", import.meta.url), "utf-8");
const pipelineSrc = await readFile(new URL("../pipeline.ts", import.meta.url), "utf-8");
// No write under agents/ : the load-bearing form is a path join with 'agents'
expect(gepaSrc).not.toMatch(/join\([^)]*["']agents["']/);
expect(evolveSrc).not.toMatch(/join\([^)]*["']agents["']/);
// pipeline never reaches evolve/gepa
expect(pipelineSrc).not.toMatch(/from\s+["'][^"']*\/(gepa|evolve)/);
expect(pipelineSrc).not.toMatch(/\bevolve\s*\(/);
```
(See Pitfalls — keep the literal string `'agents'` out of any join-with-write in gepa/evolve, even in comments that the regex could catch.)

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `runReplayHarness` | `src/orchestrator/selfimprove/replay-harness.ts:154` | `(projectRoot: string, config: BoberConfig) => Promise<ReplayHarnessResult>` | THE GATE. Re-derives fresh verdicts from frozen corpus; returns `{ regressions[], improvements[], unchanged[], total, fresh, baseline }`. Import + use as the sole scorer; also the DI-seam type for the test stub. |
| `ReplayHarnessResult` (type) | `src/orchestrator/selfimprove/replay-harness.ts:43-50` | `interface extends ReplayComparison { total; fresh: Map; baseline: Map }` | Return shape; `regressions`/`improvements` are `string[]` → use `.length` in the predicate. |
| `loadAgentDefinition` | `src/orchestrator/agent-loader.ts:143` | `(agentName: string, projectRoot?: string) => Promise<AgentDefinition>` | Reads `agents/<agentName>.md`; `.systemPrompt` is the body after frontmatter — that is the base prompt to mutate. Agent names: `bober-generator`, `bober-evaluator`. |
| `AgentDefinition` (type) | `src/orchestrator/agent-loader.ts:13-24` | `{ name; description; tools[]; model; systemPrompt }` | `systemPrompt` (line 23) is the field to feed into `proposeVariants`. |
| `createClient` | `src/providers/factory.ts:172` | `(provider?, endpoint?, providerConfig?, model?, role?) => LLMClient` | Provider-agnostic LLM entry IF you generate variants via an LLM. NO `@anthropic-ai/sdk`/`openai` import. (Contract allows purely deterministic textual mutation operators with no LLM at all — simplest path that satisfies the gate.) |
| `ensureDir` | `src/state/helpers.ts:6` | `(dirPath: string) => Promise<void>` | `mkdir(recursive)`. Create `.bober/evolve/<runId>/promoted/` before writing. |
| `findProjectRoot` | `src/utils/fs.ts` (imported `replay.ts:22`) | `() => Promise<string \| null>` | CLI root resolver; fall back to `process.cwd()`. |
| `loadConfig` | `src/config/loader.ts:142` | `(projectRoot: string) => Promise<BoberConfig>` | Load config for the harness; wrap in try/catch (tolerant). |
| `BoberConfig` (type) | `src/config/schema.ts:416` | `z.infer<typeof BoberConfigSchema>` | Param type for `evolve` + `runReplayHarness`. Import `type`-only from `../../config/schema.js`. |

**Utilities reviewed:** `src/state/helpers.ts` (only `ensureDir`), `src/utils/` (`fs.ts` → `findProjectRoot`, `fileExists`). No existing seeded-PRNG helper anywhere (`grep mulberry|seededRandom src/` → NONE) — you MUST hand-roll `mulberry32` inside `gepa.ts`. No existing dominance/Pareto helper — hand-roll `paretoSet`.

---

## 4. Prior Sprint Output

### Sprint 2 (5b804d1): replay harness — THE GATE
**Created:** `src/orchestrator/selfimprove/replay-harness.ts` — exports `runReplayHarness(projectRoot, config)` returning `ReplayHarnessResult { regressions: string[]; improvements: string[]; unchanged: string[]; total: number; fresh: Map; baseline: Map }` (lines 33-50, 154-180).
**Connection:** `evolve()` imports `runReplayHarness` and `ReplayHarnessResult`; computes the baseline by calling it once, then scores each variant through it (or the injected stub). The predicate uses `result.regressions.length` and `result.improvements.length`. `replayPassCount` for the Pareto axis = `result.total - result.regressions.length` (or `unchanged.length + improvements.length`) — define it once and keep it consistent.

### Sprint 1 (ffd6e8a): ReplayStore + selfImprove config
**Created:** `src/orchestrator/selfimprove/replay-store.ts`; `SelfImproveSectionSchema` (`src/config/schema.ts:122-127`, `replayDir` default `.bober/replay`).
**Connection:** `runReplayHarness` reads `config.selfImprove?.replayDir` (replay-harness.ts:159). You don't touch the store directly; you go through the harness.

### Sprint 3 (91ddf8e): eval-guards.ts
**Connection:** None functionally. Use it ONLY as a structural template (PURE banner, named exports, colocated test). Do not import from it.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` was read for this sprint. The binding "principles" are the contract's `nonGoals` (lines 23-29) and `stopConditions` (lines 30-33): no agents/ write, no pipeline call, replay-only scoring, strict-improvement-only promotion, no SDK import.

### Architecture Decisions
The contract's `assumptions` (lines 35-40) and `generatorNotes` (line 47) are the authoritative design spec: mulberry32 seeded PRNG, Pareto frontier over `(replayPassCount desc, promptLength asc)`, DI-seam harness for testing, writes under `.bober/evolve/<runId>/` only.

### Other Docs
ESM/NodeNext: all relative imports use the `.js` suffix even for `.ts` files (see every import in `replay.ts`, `gepa`-sibling `replay-harness.ts:27`). `type`-only imports for types (`import type { BoberConfig } from "../../config/schema.js";` — replay-harness.ts:26).

---

## 6. Testing Patterns

### Unit Test Pattern (pure fns + DI stub) — for gepa.test.ts
**Source:** `src/orchestrator/selfimprove/eval-guards.test.ts:11-21` (imports/structure) + `src/cli/commands/replay.test.ts:27-37` (tmpdir + exitCode lifecycle)
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proposeVariants, paretoSet, evolve, type VariantScore } from "./gepa.js";
import type { ReplayHarnessResult } from "./replay-harness.js";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-gepa-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

// sc-4-3 determinism
it("proposeVariants is byte-identical for a fixed seed", () => {
  expect(proposeVariants("BASE PROMPT", 7)).toEqual(proposeVariants("BASE PROMPT", 7));
});
// sc-4-3 dominance: a variant worse on BOTH axes is dropped
it("paretoSet excludes a strictly-dominated variant", () => {
  const a: VariantScore = { variantId: "a", prompt: "x", promptLength: 10, replayPassCount: 5, regressions: 0, improvements: 2 };
  const dominated: VariantScore = { variantId: "b", prompt: "xxxx", promptLength: 99, replayPassCount: 1, regressions: 0, improvements: 0 };
  const front = paretoSet([a, dominated]);
  expect(front).toContainEqual(a);
  expect(front).not.toContainEqual(dominated);
});
```

**DI stub for sc-4-6 (regressing vs strictly-improving):**
```typescript
function stubHarness(regressions: string[], improvements: string[]): (root: string, cfg: unknown) => Promise<ReplayHarnessResult> {
  return async () => ({
    regressions, improvements, unchanged: [],
    total: regressions.length + improvements.length,
    fresh: new Map(), baseline: new Map(),
  });
}

it("(a) a regressing variant is NOT promoted and writes no promoted file", async () => {
  const result = await evolve(tmpDir, fakeConfig, { role: "generator", seed: 1 },
    { harness: stubHarness(["c1"], []) });   // 1 regression → ineligible
  expect(result.promoted).toBe(false);
  await expect(access(join(tmpDir, ".bober", "evolve"))).resolves.toBeUndefined(); // dir may exist
  // assert NO promoted/<role>.md anywhere under .bober/evolve
});

it("(b) a strictly-improving variant IS written under .bober/evolve/<runId>/promoted/", async () => {
  // baseline harness: 0 improvements; variant harness: >0 improvements, 0 regressions
  const result = await evolve(tmpDir, fakeConfig, { role: "generator", seed: 1, runId: "evolve-test" },
    { harness: /* baseline then variant — see note */ });
  expect(result.promoted).toBe(true);
  const winner = await readFile(join(tmpDir, ".bober", "evolve", "evolve-test", "promoted", "generator.md"), "utf-8");
  expect(winner.length).toBeGreaterThan(0);
});

it("(c) the writer never targets a path containing '/agents/'", () => {
  // covered by reading gepa.ts source and asserting no agents-join write (sc-4-7 overlap)
});
```
**NOTE on baseline-vs-variant:** `evolve` calls the harness once for the baseline and once per variant. To distinguish, give the test stub call-count awareness (e.g. first call → baseline result, subsequent calls → variant results) OR design `evolve` to take a `baselineHarness`/`variantHarness` pair. Simplest: a single stub closure that returns the baseline on call #1 and an improving result on call #2. Inject an `runId` via `EvolveOptions.runId` so the temp path is deterministic for the assertion.

**Runner:** vitest. **Assertion style:** `expect(...)`. **Mock approach:** `vi.spyOn` for `process.stdout/stderr.write` and `findProjectRoot` (replay.test.ts:66-77); plain closure stub for the harness DI seam. **File naming:** `<name>.test.ts`. **Location:** colocated (next to source).

### CLI Test Pattern — for evolve.test.ts
**Source:** `src/cli/commands/replay.test.ts:63-92` (`invokeCapture` template) + `:396-413` (registration test)
```typescript
const rootSpy = vi.spyOn(fsUtils, "findProjectRoot").mockResolvedValue(tmpDir);
const { Command } = await import("commander");
const { registerEvolveCommand } = await import("./evolve.js");
const program = new Command();
program.exitOverride();
registerEvolveCommand(program);
await program.parseAsync(["node", "bober", "evolve", "--role", "generator", "--dry-run"]);
// sc-4-8: prints decision, exitCode 0, writes no promoted file
expect(process.exitCode).toBe(0);
```
Registration test mirror (replay.test.ts:396-413): assert `program.commands.find(c => c.name() === "evolve")` is defined and exposes `--role`/`--seed`/`--dry-run`.

### E2E Test Pattern
Not applicable — no Playwright in this CLI package.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/index.ts` | adds `registerEvolveCommand` import + call | low | Two additive lines; existing commands unchanged. `npm run build` + `evolve --help`. |
| `src/orchestrator/pipeline.ts` | MUST stay free of evolve/gepa | n/a (do NOT touch) | sc-4-7 reads it as text; do not add any import/call. |
| `gepa.ts` consumers | only `evolve.ts` imports `evolve`; only `gepa.test.ts` imports pure fns | low | New file; no existing dependents. |

### Existing Tests That Must Still Pass
- `src/orchestrator/selfimprove/replay-harness.test.ts` — exercises `runReplayHarness` (sc-2-5). You import but do NOT modify the harness; this must stay green.
- `src/cli/commands/replay.test.ts` — registration + `replay run` behaviour. Adding `registerEvolveCommand` to `index.ts` must not perturb `registerReplayCommand`.
- `src/orchestrator/lens-panel-parity.test.ts` / `arch-lens-panel-parity.test.ts` — agent-copy sync gates. You do NOT edit `agents/*.md`, so these stay green (and prove the no-agents-write invariant from the other side).
- Any `pipeline.test.ts` suites — must stay green; do not import evolve from pipeline.

### Features That Could Be Affected
- **replay (Sprint 1-2)** — shares `runReplayHarness` and `.bober/replay`. evolve only READS via the harness; never writes the replay corpus. Verify `replay run` still works after your change.
- **CLI command registration** — shares `src/cli/index.ts`. Verify `node dist/cli/index.js --help` lists `evolve` alongside `replay`/`facts`.

### Recommended Regression Checks
1. `npm run build` (sc-4-1) and `npm run typecheck` (sc-4-2) exit 0.
2. `npm test -- gepa evolve` — new suites pass (sc-4-3/4-6/4-7/4-8).
3. `npm test -- replay-harness` and `npm test -- replay.test` — Sprint 1-2 stay green.
4. Manual: in a temp dir with a captured corpus, `node dist/cli/index.js evolve --role generator --dry-run` prints the decision, exits 0, writes NO `promoted/generator.md` (sc-4-8).
5. Independent grep (evaluatorNotes): `grep -n "agents" src/orchestrator/selfimprove/gepa.ts src/cli/commands/evolve.ts` shows no write-path join; `grep -n "evolve\|gepa" src/orchestrator/pipeline.ts` shows NONE; `grep -n "@anthropic-ai/sdk\|from \"openai\"" gepa.ts evolve.ts` shows NONE.
6. `npm run lint` (sc-4-9, optional) reports zero errors on new/modified files.

---

## 8. Implementation Sequence

1. **`gepa.ts` — PURE `mulberry32(seed)`** — hand-roll the 32-bit PRNG (no `Math.random`). 
   - Verify: same seed → same sequence (test asserts via `proposeVariants` determinism).
2. **`gepa.ts` — PURE `proposeVariants(basePrompt, seed)`** — small deterministic operator set (append a clarifying constraint sentence, paraphrase one heading, reorder two adjacent bullets), all driven by `mulberry32(seed)`. Return `string[]`. 
   - Verify: `proposeVariants("X", 7)` deep-equals a second call (sc-4-3).
3. **`gepa.ts` — PURE `paretoSet(scored: VariantScore[])`** — non-dominated frontier over `(replayPassCount desc, promptLength asc)`; drop any variant dominated on BOTH axes. 
   - Verify: doubly-dominated variant excluded (sc-4-3).
4. **`gepa.ts` — async `evolve(projectRoot, config, opts, deps?)`** — load base via `loadAgentDefinition("bober-"+role, projectRoot)` → `.systemPrompt`; compute baseline via `harness = deps.harness ?? runReplayHarness`; score each variant via `harness`; apply the strict predicate; keep `paretoSet`; pick top non-dominated eligible; `ensureDir(.bober/evolve/<runId>/promoted)`; write `report.json` ALWAYS; write `promoted/<role>.md` ONLY on win AND `!dryRun`. Return `GepaResult`. 
   - Verify: stub-harness tests (regressing → not promoted/no file; improving → promoted file) pass (sc-4-6). NO `join(projectRoot,"agents",...)` write anywhere.
5. **`gepa.test.ts`** — determinism + dominance (sc-4-3); DI-stub promotion cases (sc-4-6); sc-4-7 text-scan of `gepa.ts`/`evolve.ts`/`pipeline.ts`. 
   - Verify: `npm test -- gepa` green.
6. **`evolve.ts` — `registerEvolveCommand(program)`** — mirror `replay.ts`; `--role/--seed/--dry-run`; tolerant config; chalk; no-throw + `process.exitCode=1`. 
   - Verify: handler prints decision, exits 0 on dry-run.
7. **`evolve.test.ts`** — `invoke`-style CLI test (registration + dry-run exits 0, no promoted file) (sc-4-8). 
   - Verify: `npm test -- evolve` green.
8. **`src/cli/index.ts`** — add import (line ~38) + `registerEvolveCommand(program)` (line ~319). 
   - Verify: `node dist/cli/index.js --help` lists `evolve`.
9. **Full verification** — `npm run build`, `npm run typecheck`, `npm test -- gepa evolve`, `npm test -- replay`, (`npm run lint`).

---

## 9. Pitfalls & Warnings

- **sc-4-7 regex literal trap.** The guard greps `gepa.ts`/`evolve.ts` text for an `agents`-joined write. Do NOT write the literal string `"agents"` in a `join(...)` call ANYWHERE in those two files — not even in a comment that resembles `join(projectRoot, "agents", ...)`. If you must mention the rule in a comment, phrase it without that exact `join(..., "agents"` shape, or the generator's own assertion (and the evaluator's independent grep) will trip. Keep the banner wording like "never write under the live agents directory" without a join-shaped literal.
- **Do NOT touch `pipeline.ts`.** It is in `estimatedFiles`-adjacent only because sc-4-7 READS it. There is currently no evolve/gepa reference there (verified). Leave it exactly as-is.
- **Read agents/<role>.md, never write it.** `loadAgentDefinition` (agent-loader.ts:143) reads via the resolver and is fine. The agent name is `bober-<role>` (`bober-generator.md`, `bober-evaluator.md` exist in `agents/`), NOT `<role>.md`. Map `opts.role` → `"bober-" + role` for the loader, but write the promoted file as `promoted/<role>.md` (e.g. `generator.md`, per sc-4-5).
- **PURE fns must stay pure.** `proposeVariants` and `paretoSet` must not call `Date.now()`, `Math.random`, fs, or the network. Only `evolve` (orchestration) may stamp `runId` and write files (mirrors the eval-guards.ts/replay-harness.ts PURE-vs-async split).
- **No SDK import.** `gepa.ts`/`evolve.ts` must not `import "@anthropic-ai/sdk"` or `import ... from "openai"`. If variants need an LLM, go through `createClient` (factory.ts:172). The simplest compliant design uses purely textual deterministic operators and no LLM at all — the GATE (runReplayHarness), not the operator, is load-bearing.
- **Strict tie semantics.** `improvements.length > baseline.improvements.length` is strict `>`. A variant that ties the baseline does NOT promote. Equality is a non-promotion.
- **`report.json` always; `promoted/<role>.md` only on win AND `!dryRun`.** Dry-run must produce `report.json` but never a promoted file (sc-4-8 asserts no promoted file on `--dry-run`).
- **Path resolution in the guard test.** sc-4-7 reads SOURCE `.ts` via `new URL(..., import.meta.url)`, NOT compiled `dist`. From `src/orchestrator/selfimprove/gepa.test.ts`: gepa is `./gepa.ts`, pipeline is `../pipeline.ts`, evolve is `../../cli/commands/evolve.ts`.
- **ESM `.js` suffixes.** Every relative import uses `.js` even though the file is `.ts` (NodeNext). `type`-only imports for `BoberConfig`/`ReplayHarnessResult`.
- **Reset `process.exitCode`** in CLI test `beforeEach/afterEach` (replay.test.ts:27-37) — a prior failing test leaks `exitCode=1` and corrupts the dry-run-exits-0 assertion.
