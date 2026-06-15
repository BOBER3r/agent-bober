# Sprint Briefing: Replay store + selfImprove config section + `bober replay capture|list|show`

**Contract:** sprint-spec-20260615-self-improve-p1-p2-1
**Generated:** 2026-06-15T00:00:00Z

> This is a pure brownfield mirror sprint. Every new module copies an existing,
> proven pattern. The single most important instruction: **clone the discipline in
> `src/state/facts.ts` (FactStore) and `src/cli/commands/facts.ts` (registerFactsCommand)
> EXACTLY.** Do not invent new shapes. Snippets below are the literal templates.

---

## 1. Target Files

### src/orchestrator/selfimprove/replay-store.ts (create)

**Directory pattern:** `src/orchestrator/selfimprove/` does not yet exist — create it. Modules under `src/orchestrator/` use kebab-case filenames and the section-comment style (`// ── Section ──`). The store class is the SQLite analog of `FactStore` in `src/state/facts.ts:136`.

**Most similar existing file:** `src/state/facts.ts` — follow it line-for-line.

**Structure template (mirror `src/state/facts.ts:1-7, 136-158, 164-206, 293-296`):**
```ts
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

import { ReplayCaseSchema, type ReplayCaseInput, type ReplayCaseRecord } from "./replay-types.js";

// caseId = sha256(`${contractId}|${iteration}|${diffDigest}`).slice(0,16)
// MIRRORS factId at src/state/facts.ts:58-69
export function caseId(contractId: string, iteration: number, diffDigest: string): string {
  return createHash("sha256")
    .update(`${contractId}|${iteration}|${diffDigest}`)
    .digest("hex")
    .slice(0, 16);
}

export class ReplayStore {
  private db: DatabaseType;
  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS replay_cases (
        case_id TEXT PRIMARY KEY,
        contract_id TEXT NOT NULL,
        iteration INTEGER NOT NULL,
        baseline_verdict TEXT NOT NULL,
        diff_digest TEXT NOT NULL,
        eval_details_json TEXT NOT NULL,
        t_captured TEXT NOT NULL
      );
    `);
  }
  putCase(input: ReplayCaseInput): ReplayCaseRecord { /* safeParse → caseId → INSERT OR REPLACE with ? params */ }
  getCase(id: string): ReplayCaseRecord | null { /* SELECT ... WHERE case_id = ? */ }
  listCases(): ReplayCaseRecord[] { /* SELECT * FROM replay_cases */ }
  getBaselineVerdict(id: string): string | null { /* SELECT baseline_verdict ... return row?.baseline_verdict ?? null */ }
  close(): void { this.db.close(); }
}
```

**Imports this file uses:** `better-sqlite3` (default + type), `node:crypto` createHash, the co-located `replay-types.js`.
**PURITY (sc-1-3):** NO `Date.now()` / `new Date(` anywhere in this file. `t_captured` is a parameter only.

---

### src/orchestrator/selfimprove/replay-types.ts (create)

**Most similar existing pattern:** `FactSchema` + `FactInput` + `FactRecord` in `src/state/facts.ts:22-49`.
**Structure template:**
```ts
import { z } from "zod";

export const ReplayCaseSchema = z.object({
  contractId: z.string().min(1),
  iteration: z.number().int(),
  baselineVerdict: z.enum(["pass", "fail"]),
  diffDigest: z.string().min(1),
  evalDetailsJson: z.string(),        // JSON.stringify(results)
  tCaptured: z.string().datetime(),   // ISO string stamped by the CLI handler
});
export type ReplayCaseInput = z.infer<typeof ReplayCaseSchema>;

export interface ReplayCaseRecord extends ReplayCaseInput {
  caseId: string;
}
```
**Note:** Column names in SQL are snake_case (`case_id`, `contract_id`, `t_captured`); the TS record/schema uses camelCase. `FactStore` does this exact split — see the `RawRow` interface + `rowToRecord` mapper at `src/state/facts.ts:95-123`. Replicate that mapper for `replay_cases`.

---

### src/config/schema.ts (modify)

**Relevant section — template to mirror (lines 104-118), `EvaluatorSectionSchema`:**
```ts
export const EvaluatorSectionSchema = z.object({
  model: GeneratorModelSchema.default("sonnet"),
  strategies: z.array(EvalStrategySchema),
  ...
  panel: z.object({
    enabled: z.boolean().default(false),
    ...
  }).default({ enabled: false, lenses: [], maxConcurrent: 4 }),
});
export type EvaluatorSection = z.infer<typeof EvaluatorSectionSchema>;
```
**Add near line 118** (after `EvaluatorSectionSchema`, before the Architect section at :120):
```ts
export const SelfImproveSectionSchema = z.object({
  deterministicGate: z.boolean().default(false),
  rubricIsolation: z.boolean().default(false),
  requireCitedArtifact: z.boolean().default(false),
  replayDir: z.string().default(".bober/replay"),
});
export type SelfImproveSection = z.infer<typeof SelfImproveSectionSchema>;
```

**Wire into `BoberConfigSchema` (lines 376-403).** Existing optional-section pattern at :385-402 (`graph: GraphSectionSchema.optional()`, etc.). Add one line alongside them:
```ts
  // ── Phase 5: self-improvement (off by default) ──
  selfImprove: SelfImproveSectionSchema.optional(),
```
**Imported by:** `src/config/loader.ts` (loadConfig), `src/config/schema.test.ts`. The `.optional()` means a config omitting `selfImprove` parses cleanly (`result.data.selfImprove === undefined`) — confirmed by the architect-optional test at `src/config/schema.test.ts:71-86`.

---

### src/config/schema.test.ts (modify)

**Relevant section — defaults-assertion template (lines 10-39), `EvaluatorSectionSchema.panel`:**
```ts
describe("EvaluatorSectionSchema.panel", () => {
  it("defaults panel to disabled/empty/4 when omitted", () => {
    const parsed = EvaluatorSectionSchema.parse({ strategies: [] });
    expect(parsed.panel).toEqual({ enabled: false, lenses: [], maxConcurrent: 4 });
  });
});
```
**Add (sc-1-5):** import `SelfImproveSectionSchema` (extend the import block at `:2-8`) and a describe block asserting `SelfImproveSectionSchema.parse({})` yields all three booleans `false` and `replayDir === ".bober/replay"`. Also mirror the optional-section test at `:71-86`: a `BoberConfigSchema.safeParse({...})` that omits `selfImprove` → `result.data.selfImprove` is `undefined`.

---

### src/cli/commands/replay.ts (create)

**Most similar existing file:** `src/cli/commands/facts.ts` — copy its skeleton EXACTLY (resolveRoot, no-throw handlers, chalk output).
**Structure template (mirror `src/cli/commands/facts.ts:14-32, 54-59`):**
```ts
import chalk from "chalk";
import type { Command } from "commander";
import { join } from "node:path";
import { writeFile, readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import { findProjectRoot } from "../../utils/fs.js";
import { ensureDir } from "../../state/helpers.js";
import { ReplayStore, caseId } from "../../orchestrator/selfimprove/replay-store.js";

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

export function registerReplayCommand(program: Command): void {
  const replayCmd = program.command("replay").description("Frozen replay corpus (capture, list, show)");
  // capture / list / show subcommands here — see facts.ts:62, :147, :208
}
```
**capture handler logic (per generatorNotes):**
1. `const projectRoot = await resolveRoot();` then `try { ... } catch (err) { process.stderr.write(chalk.red(...)); process.exitCode = 1; }`
2. Resolve `replayDir` (default `.bober/replay`) under projectRoot. `await ensureDir(join(root, replayDir))` and `await ensureDir(join(root, replayDir, "cases"))`.
3. Read `.bober/eval-results/eval-*.json` (the payload shape from `src/orchestrator/eval-persist.ts:45-66` — fields `evalId`, `contractId`, `iteration`, `passed`, `results[]`).
4. For each: `const tCaptured = new Date().toISOString();` (**stamp here, NOT in the store**), `baselineVerdict = passed ? "pass" : "fail"`, `diffDigest = sha256(JSON.stringify(results)).slice(...)` , `evalDetailsJson = JSON.stringify(results)`.
5. `store.putCase({...})` against `new ReplayStore(join(root, replayDir, "replay.db"))`, and `await writeFile(join(casesDir, ` + "`${id}.json`" + `), JSON.stringify(case, null, 2), "utf-8")`.
6. `finally { store.close(); }` — mirror `facts.ts:132-134`.

**list / show:** mirror `facts.ts:147-205` (list table) and `facts.ts:208-255` (show one + the not-found path: `process.stderr.write(chalk.yellow(...)); process.exitCode = 1; return;` at `:221-224`).

---

### src/cli/index.ts (modify)

**Relevant sections:** import block at `:36-37`, registration block at `:310-314`.
```ts
// line 37 (add directly below):
import { registerFactsCommand } from "./commands/facts.js";
import { registerReplayCommand } from "./commands/replay.js";   // ADD
...
// line 314 (add directly below):
  registerFactsCommand(program);
  // ── replay ────────────────────────────────────────────────────────
  registerReplayCommand(program);                                 // ADD
```

### src/cli/commands/replay.test.ts (create)

No CLI test exists for facts; the canonical CLI-handler test template is `src/cli/commands/memory.test.ts` (see §6).

---

## 2. Patterns to Follow

### Deterministic content-hash id
**Source:** `src/state/facts.ts:58-69`
```ts
export function factId(scope, subject, predicate, value, tCreated): string {
  return createHash("sha256")
    .update(`${scope}|${subject}|${predicate}|${value}|${tCreated}`)
    .digest("hex")
    .slice(0, 16);
}
```
**Rule:** `caseId = createHash("sha256").update(`${contractId}|${iteration}|${diffDigest}`).digest("hex").slice(0, 16)`. Note: `tCreated` is part of factId's hash, but the contract deliberately EXCLUDES `tCaptured` from caseId (caseId is `contractId|iteration|diffDigest` only) so the id stays stable across captures (sc-1-4, sc-1-6).

### CREATE TABLE IF NOT EXISTS in the constructor
**Source:** `src/state/facts.ts:139-158`
```ts
constructor(dbPath: string) {
  this.db = new Database(dbPath);
  this.db.exec(`CREATE TABLE IF NOT EXISTS semantic_facts ( id TEXT PRIMARY KEY, ... );`);
}
```
**Rule:** Idempotent DDL in the ctor; constructor takes a path string and works with `":memory:"`.

### Parameterized INSERT OR REPLACE (never interpolate)
**Source:** `src/state/facts.ts:175-191`
```ts
this.db.prepare(
  `INSERT OR REPLACE INTO semantic_facts (id, scope, ...) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
).run(id, data.scope, data.subject, /* ...all bound positionally... */);
```
**Rule:** Every value goes through a `?` placeholder + `.run(...)` / `.get(...)` / `.all(...)`. Zero string interpolation of values into SQL (sc-1-4).

### safeParse-then-throw input validation
**Source:** `src/state/facts.ts:164-173`
```ts
const result = FactSchema.safeParse(input);
if (!result.success) {
  const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
  throw new Error(`Invalid fact input:\n${issues}`);
}
const data = result.data;
```
**Rule:** `putCase` validates with `ReplayCaseSchema.safeParse` and throws a formatted error on failure. The store may throw; the CLI handler is the no-throw boundary that catches it.

### Row mapper (snake_case row → camelCase record)
**Source:** `src/state/facts.ts:95-123`
**Rule:** Define a `RawRow` interface with snake_case columns and a `rowToRecord` function. `getCase`/`listCases` map raw rows through it.

### CLI handler — never throws, sets exitCode
**Source:** `src/cli/commands/facts.ts:80-143` (add) and `:211-255` (show, incl. not-found)
```ts
.action(async (id: string) => {
  const projectRoot = await resolveRoot();
  try {
    const store = new FactStore(factsDbPath(projectRoot, ns));
    try {
      const rec = store.getFact(id);
      if (rec === null) {
        process.stderr.write(chalk.yellow(`Fact not found: ${id}\n`));
        process.exitCode = 1;
        return;
      }
      // ... chalk output ...
    } finally { store.close(); }
  } catch (err) {
    process.stderr.write(chalk.red(`Failed to show fact: ${err instanceof Error ? err.message : String(err)}\n`));
    process.exitCode = 1;
  }
});
```
**Rule:** Wrap the body in try/catch; on any error `process.exitCode = 1` and return — NEVER `throw`, NEVER `process.exit()`. Always `store.close()` in `finally`.

### Stamp wall-clock at the handler boundary only
**Source:** `src/cli/commands/facts.ts:85-86` and `:267-268`
```ts
// Stamp wall-clock time at handler boundary — NEVER inside the store
const now = new Date().toISOString();
```
**Rule:** `const tCaptured = new Date().toISOString();` lives in the `replay capture` handler. The store receives it as the `tCaptured` parameter (sc-1-3 purity).

### Eval-result payload shape (capture source)
**Source:** `src/orchestrator/eval-persist.ts:42-66` — files at `.bober/eval-results/eval-<contractId>-<iteration>.json`
```ts
const payload = {
  evalId,                              // `${contractId}-${iteration}`
  contractId,
  iteration,
  passed: evaluation.passed,           // boolean → baseline_verdict
  overallResult: evaluation.passed ? "pass" : "fail",
  score, summary, timestamp,
  results: evaluation.results.map((r) => ({ evaluator, passed, score, summary, ... })),
};
```
**Rule:** `replay capture` reads `passed` → `baselineVerdict`, `JSON.stringify(results)` → both `evalDetailsJson` and the input to the `diffDigest` sha256. Parse leniently: the file may contain extra fields; only read the five named ones (`evalId`, `contractId`, `iteration`, `passed`, `results`).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `ensureDir` | `src/state/helpers.ts:6` | `(dirPath: string): Promise<void>` | Recursive `mkdir`. Call before opening the file-backed DB and before writing case fixtures. **Reuse — do not re-import mkdir.** |
| `findProjectRoot` | `src/utils/fs.ts:58` | `(startDir?: string): Promise<string \| null>` | Walks up to find `bober.config.json`/`package.json`. The `resolveRoot` helper wraps it with a `?? process.cwd()` fallback (facts.ts:29-32). |
| `factId` | `src/state/facts.ts:58` | `(scope, subject, predicate, value, tCreated): string` | The hashing template `caseId` must mirror (sha256 → hex → slice 0,16). Do NOT call it; write your own `caseId`. |
| `persistEvalResult` | `src/orchestrator/eval-persist.ts:32` | `(projectRoot, contractId, iteration, evaluation): Promise<string \| undefined>` | The WRITER of the eval-result files capture reads. Defines the on-disk shape; do not modify. |
| `createHash` | node:crypto (used at `src/state/facts.ts:2,65`) | stdlib | sha256 for `caseId` and `diffDigest`. |
| `loadConfig` | `src/config/loader.ts` (used facts.ts:18,45) | `(projectRoot): Promise<BoberConfig>` | Reads/validates config. Not strictly required this sprint (replay needs no namespace), but available if you read `selfImprove.replayDir`. |

**Directories reviewed:** `src/state/helpers.ts` (only `ensureDir`), `src/utils/fs.ts` (`findProjectRoot`, `fileExists`), `src/state/facts.ts` (the store template). No additional path/hash util needs creating — all primitives exist.

---

## 4. Prior Sprint Output

No prior sprints in THIS plan (`dependsOn: []`). The directly relevant prior work is the **Phase 3 memory/self-improvement layer**, already merged behavior on main:

### `src/state/facts.ts` — FactStore (the EXACT adapter to mirror)
**Exports:** `FactStore` class, `FactSchema`, `factId`, `factsDbPath`, `ensureFactsDir`, `FactInput`, `FactRecord`.
**Connection:** `ReplayStore` is the structural clone of `FactStore` for a new `replay_cases` table. Same better-sqlite3 import, same ctor-DDL, same parameterized INSERT OR REPLACE, same `:memory:`-testable constructor, same "store never reads the clock" purity rule.

### `src/orchestrator/eval-persist.ts` — persistEvalResult
**Connection:** It produces the `.bober/eval-results/eval-*.json` corpus that `replay capture` ingests. This sprint READS those files; it does not modify the writer.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` checked into the working tree was read as load-bearing for this sprint. The operative principles are encoded directly in the contract `nonGoals` and `assumptions`:
- Store purity (no clock reads inside `ReplayStore`).
- No new runtime dependency (`better-sqlite3` already present — see §8).
- Do NOT touch `src/orchestrator/evaluator-agent.ts`, `src/orchestrator/pipeline.ts`, or `agents/<role>.md`.

### Architecture Decisions
The store is "hidden behind an interface so the driver (better-sqlite3) is swappable" — documented inline at `src/state/facts.ts:128-135` (the swap-for-`node:sqlite` note). Carry the same comment intent into `ReplayStore`.

### Other Docs
The `bober replay` command is new top-level CLI surface registered like every other command in `src/cli/index.ts:54-323`. Follow the `// ── name ──` comment-block convention used throughout the registration list (`:295-320`).

---

## 6. Testing Patterns

### Unit Test Pattern — in-memory SQLite store (for replay-store.test.ts)
**Source:** `src/state/facts.test.ts:1-56`
```ts
import { describe, it, expect, afterEach } from "vitest";
import { FactStore, factId } from "./facts.js";

describe("FactStore (in-memory)", () => {
  let store: FactStore;
  afterEach(() => { store?.close(); });

  it("insert -> getActiveFacts returns the row", () => {
    store = new FactStore(":memory:");
    const t = "2026-06-15T00:00:00.000Z";
    const rec = store.insertFact({ /* ...fixed timestamps... */ tValid: t, tCreated: t });
    expect(rec.id).toBe(factId("programming", "project", "testCommand", "vitest", t));
  });

  it("ids are deterministic for identical signature", () => {
    const t = "2026-06-15T00:00:00.000Z";
    expect(factId("programming","project","testCommand","vitest",t))
      .toBe(factId("programming","project","testCommand","vitest",t));
  });
});
```
**Runner:** vitest. **Assertion style:** `expect(...)`. **Mock approach:** none — real `:memory:` DB. **File naming:** co-located `<name>.test.ts`. 
**Map to sc-1-6:** `new ReplayStore(":memory:")` in `beforeEach`/inline; assert (a) `putCase` then `getCase` returns the row; (b) `listCases` returns inserted cases; (c) `caseId` identical for identical `(contractId|iteration|diffDigest)` and DIFFERENT when `diffDigest` changes; (d) `getBaselineVerdict` returns the stored `"pass"`/`"fail"`. Use FIXED ISO timestamp strings (`"2026-06-15T00:00:00.000Z"`), never `new Date()`.

### Unit Test Pattern — Zod section defaults (for schema.test.ts)
**Source:** `src/config/schema.test.ts:10-39, 71-86`
```ts
import { EvaluatorSectionSchema, BoberConfigSchema } from "./schema.js";
it("defaults panel to disabled/empty/4 when omitted", () => {
  const parsed = EvaluatorSectionSchema.parse({ strategies: [] });
  expect(parsed.panel).toEqual({ enabled: false, lenses: [], maxConcurrent: 4 });
});
// optional-section: omit it entirely and assert undefined
const result = BoberConfigSchema.safeParse({ project:{name:"t",mode:"greenfield"}, planner:{}, generator:{}, evaluator:{strategies:[]}, sprint:{}, pipeline:{}, commands:{} });
expect(result.data.architect).toBeUndefined();
```
**Map to sc-1-5:** assert `SelfImproveSectionSchema.parse({})` → `{ deterministicGate:false, rubricIsolation:false, requireCitedArtifact:false, replayDir:".bober/replay" }`, and that a `BoberConfigSchema` parse omitting `selfImprove` leaves it `undefined`.

### CLI Handler Test Pattern (for replay.test.ts)
**Source:** `src/cli/commands/memory.test.ts:11-33, 137-163, 440-463` (no facts.test.ts exists — memory.test.ts is the canonical sibling)
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-replay-cmd-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

async function invokeCapture(): Promise<string> {
  const writes: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((c) => { writes.push(String(c)); return true; });
  const fsUtils = await import("../../utils/fs.js");
  const rootSpy = vi.spyOn(fsUtils, "findProjectRoot").mockResolvedValue(tmpDir);
  try {
    const { Command } = await import("commander");
    const { registerReplayCommand } = await import("./replay.js");
    const program = new Command();
    program.exitOverride();
    registerReplayCommand(program);
    await program.parseAsync(["node", "bober", "replay", "capture"]);
  } finally { stdoutSpy.mockRestore(); rootSpy.mockRestore(); }
  return writes.join("");
}
```
**Key techniques (copy exactly):**
- Seed a temp project: `await mkdir(join(tmpDir, ".bober", "eval-results"), { recursive: true })` then `writeFile` an `eval-c1-1.json` with `{ evalId:"c1-1", contractId:"c1", iteration:1, passed:true, results:[] }` (the evaluatorNotes fixture).
- Mock the root: `vi.spyOn(fsUtils, "findProjectRoot").mockResolvedValue(tmpDir)`.
- Capture output: `vi.spyOn(process.stdout, "write")` / `process.stderr.write`.
- Drive via commander: `new Command()` → `program.exitOverride()` → `registerReplayCommand(program)` → `program.parseAsync(["node","bober","replay","capture"])`.
- **exitCode discipline (sc-1-7):** the not-found `show` test (template at `memory.test.ts:440-463`) must reset `process.exitCode = 0` first (see `memory.test.ts:502`), run `replay show <unknown>`, then assert the stderr message AND `expect(process.exitCode).toBe(1)`. Restore exitCode in `afterEach` if you set it.

**Assertions to cover sc-1-7:** after `capture`, assert `.bober/replay/cases/*.json` and `.bober/replay/replay.db` exist (via `node:fs/promises` `readdir`/`access`); `replay list` prints one row; `replay show <id>` prints `contractId`, `iteration`, `baselineVerdict`, and the source eval-result path.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/config/loader.ts` | `src/config/schema.ts` (BoberConfigSchema) | low | Adding an `.optional()` section is purely additive; existing configs still parse. Confirm `loadConfig` of a config without `selfImprove` does not throw. |
| `src/config/schema.test.ts` | `src/config/schema.ts` | low | New describe block added; existing assertions untouched. |
| `src/cli/index.ts` | new `replay.ts` | low | One import + one registration line; mirrors `registerFactsCommand` at `:37/:314`. Any other command's tests are unaffected. |
| Everything importing `src/state/facts.ts` | NOT modified | none | `facts.ts` is the TEMPLATE, not a target. Do not edit it. |

### Existing Tests That Must Still Pass
- `src/config/schema.test.ts` — tests every config section's defaults/optionality; the additive `selfImprove` section must not perturb `EvaluatorSectionSchema`/`BoberConfigSchema` parsing (`:10-105`).
- `src/state/facts.test.ts` — the FactStore template; must remain green (it must not be touched).
- `src/cli/commands/memory.test.ts` — the CLI-handler test template; unaffected, but confirms the `findProjectRoot` mock + commander-drive pattern you are copying still works.
- Any `src/config/loader` test suite — verify it still loads configs lacking `selfImprove`.

### Features That Could Be Affected
- **Config loading (all commands)** — every CLI command calls `loadConfig`. The new optional section must default-absent cleanly. Risk mitigated by `.optional()`.
- **Self-improve P1/P2 Sprints 2-4** — they will build `replay run` / verdict comparison ON TOP of this store. Keep `ReplayStore`'s public surface minimal and exact (`putCase`, `getCase`, `listCases`, `getBaselineVerdict`, `close`) so downstream sprints extend rather than rewrite.

### Recommended Regression Checks
1. `npm run build` exits 0 (tsc, includes new selfimprove modules) — sc-1-1.
2. `npm run typecheck` zero errors — sc-1-2.
3. `npm test -- replay-store schema` exits 0 with new tests included — stopConditions.
4. `git diff --name-only` shows NO change to `src/orchestrator/evaluator-agent.ts`, `src/orchestrator/pipeline.ts`, `agents/`, or `src/state/facts.ts`.
5. `grep -nE "Date\.now|new Date\(" src/orchestrator/selfimprove/replay-store.ts` → ZERO matches (sc-1-3).
6. `git diff package.json` → no new dependency line (non-goal; better-sqlite3 already present).
7. Manual: in a temp dir with `.bober/eval-results/eval-c1-1.json`, run `node dist/cli/index.js replay capture|list|show <id>` per sc-1-7.

---

## 8. Dependency Confirmation (non-goal: add no new dep)

`better-sqlite3` is ALREADY a runtime dependency — **add nothing**:
- `package.json:65` → `"better-sqlite3": "^11.9.1"` (dependencies)
- `package.json:90` → `"@types/better-sqlite3": "^7.6.13"` (devDependencies)
- Also confirmed present: `chalk` (`:66`), `commander` (`:67`), `zod` (`:73`), `vitest` (`:99`). Import them; do not install anything.

---

## 9. Implementation Sequence

Dependency order: types → store → config → CLI → wiring → tests.

1. **src/orchestrator/selfimprove/replay-types.ts** — `ReplayCaseSchema` (Zod), `ReplayCaseInput`, `ReplayCaseRecord`. Mirror `FactSchema`/`FactInput`/`FactRecord` (facts.ts:22-49).
   - Verify: `npm run typecheck` resolves the type imports.
2. **src/orchestrator/selfimprove/replay-store.ts** — `caseId()` + `ReplayStore` (ctor DDL, `putCase`, `getCase`, `listCases`, `getBaselineVerdict`, `close`) + `RawRow`/`rowToRecord` mapper. NO clock reads.
   - Verify: `grep -nE "Date\.now|new Date\(" src/orchestrator/selfimprove/replay-store.ts` returns nothing; `:memory:` ctor compiles.
3. **src/config/schema.ts** — add `SelfImproveSectionSchema` after `:118`; add `selfImprove: SelfImproveSectionSchema.optional()` in `BoberConfigSchema` (`:376-403`).
   - Verify: `npm run typecheck` clean.
4. **src/config/schema.test.ts** — add defaults + optional-section assertions (sc-1-5).
   - Verify: `npm test -- schema` green.
5. **src/orchestrator/selfimprove/replay-store.test.ts** — in-memory store tests (sc-1-6): put/get, list, caseId determinism & sensitivity to diffDigest, getBaselineVerdict.
   - Verify: `npm test -- replay-store` green.
6. **src/cli/commands/replay.ts** — `registerReplayCommand` with `capture`/`list`/`show`. Stamp `tCaptured = new Date().toISOString()` in the capture handler; read eval-results; write `cases/<id>.json` + `replay.db`; no-throw handlers.
   - Verify: `npm run typecheck` clean.
7. **src/cli/index.ts** — add the import (below `:37`) and the registration (below `:314`).
   - Verify: `node dist/cli/index.js replay --help` lists capture/list/show after `npm run build`.
8. **src/cli/commands/replay.test.ts** — temp-dir capture/list/show handler tests incl. unknown-id `exitCode=1` (copy memory.test.ts technique).
   - Verify: `npm test -- replay` green.
9. **Run full verification** — `npm run build`, `npm run typecheck`, `npm test -- replay-store schema replay`, `npm run lint`.

---

## 10. Pitfalls & Warnings

- **Do NOT include `tCaptured` in the `caseId` hash.** Unlike `factId` (which hashes `tCreated`), `caseId` must be `contractId|iteration|diffDigest` ONLY — sc-1-6 asserts the id is stable across captures and changes only when `diffDigest` changes. Putting the timestamp in would break determinism.
- **Never call `new Date()`/`Date.now()` inside `replay-store.ts` or `replay-types.ts`.** The evaluator greps the store body (sc-1-3). Stamp `tCaptured` only in the CLI `capture` handler (pattern: `src/cli/commands/facts.ts:85-86`).
- **Use snake_case in SQL, camelCase in TS.** Column `case_id`/`contract_id`/`t_captured` in DDL and bound params; `caseId`/`contractId`/`tCaptured` in the record. Add a `RawRow`+`rowToRecord` mapper like `facts.ts:95-123`. Mismatching these silently returns `undefined` fields.
- **ESM import extensions:** every relative import ends in `.js` (NodeNext) even though the source is `.ts` — see `facts.ts:7` `from "./helpers.js"` and `facts.ts:13` `from "../orchestrator/memory/reconcile.js"`. The new CLI imports the store as `"../../orchestrator/selfimprove/replay-store.js"`.
- **Handlers must NOT `throw` and must NOT call `process.exit()`.** Set `process.exitCode = 1` and `return` (facts.ts:135-142, :221-224). The unknown-id `show` path is a friendly stderr message + exitCode, NOT a thrown error (sc-1-7, evaluatorNotes).
- **`bober.config.json`/`package.json` are project markers for `findProjectRoot` (fs.ts:63).** In CLI tests, mock `findProjectRoot` to the temp dir rather than relying on a real marker (memory.test.ts:147).
- **Do NOT add a dependency.** `better-sqlite3` is at `package.json:65`. The evaluator diffs `package.json` (evaluatorNotes).
- **Do NOT touch** `src/orchestrator/evaluator-agent.ts`, `src/orchestrator/pipeline.ts`, `agents/<role>.md`, or `src/state/facts.ts` (nonGoals). `facts.ts` is read-only template.
- **Parse eval-result files leniently.** They carry extra fields (`overallResult`, `score`, `summary`, `timestamp`, per-result `feedback`/`lensVerdicts`/`failures` — eval-persist.ts:51-65). Read only `contractId`, `iteration`, `passed`, `results`; skip files that don't match `eval-*.json` or fail JSON.parse without crashing the whole capture.
