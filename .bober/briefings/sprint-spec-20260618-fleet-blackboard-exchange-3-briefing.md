# Sprint Briefing: Coordinator re-run loop (rounds, idempotent re-spawn, early-stop)

**Contract:** sprint-spec-20260618-fleet-blackboard-exchange-3
**Generated:** 2026-06-18T00:00:00Z
**Ambiguity:** 5 (highest in plan)

> TWO LOAD-BEARING INVARIANTS (read first, re-read last):
> 1. **BYTE-IDENTICAL no-blackboard path.** When `manifest.blackboard` is `undefined`, `coordinator.execute(manifest)` MUST run exactly one `mapBounded` pass and return EXACTLY what it returns today (`src/fleet/coordinator.ts:30-36`). No blackboard opened, no rounds. The 5 existing coordinator tests + the runFleet index tests MUST pass unchanged.
> 2. **NEVER-THROW per-child contract.** Per-child failures stay data inside the `runChild` try/catch (`src/fleet/coordinator.ts:39-60`). Only batch-setup (bad manifest / missing creds / report IO) throws. `runFleet` resolves with a `PortfolioReport` even when children fail (exit-0 contract).

---

## 1. Target Files

### src/fleet/coordinator.ts (modify)

**Full current file is only 61 lines. The structure the rounds loop WRAPS (lines 21-61):**
```typescript
export class FleetCoordinator {
  private readonly scaffolder: Scaffolder;
  private readonly runner: Runner;

  constructor(deps?: { scaffolder?: Scaffolder; runner?: Runner }) {
    this.scaffolder = deps?.scaffolder ?? new ChildScaffolder();
    this.runner = deps?.runner ?? new ChildRunner();
  }

  async execute(manifest: FleetManifest): Promise<ChildExecution[]> {          // :30
    return mapBounded(
      manifest.children,
      manifest.concurrency,
      (child) => this.runChild(manifest.rootDir, child),
    );
  }

  // The never-reject thunk: EVERYTHING (incl. the awaits) is inside try/catch.
  private async runChild(rootDir: string, child: FleetChild): Promise<ChildExecution> {   // :39
    try {
      const scaffold = await this.scaffolder.scaffold(rootDir, child);
      if (scaffold.error) {
        return { folder: child.folder, scaffold, spawn: undefined };
      }
      const spawn = await this.runner.run({ cwd: scaffold.absPath, task: child.task });
      return { folder: child.folder, scaffold, spawn };
    } catch (e) {
      return {
        folder: child.folder,
        scaffold: { folder: child.folder, absPath: "", configWritten: false,
                    gitInitialized: false, error: String(e) },
        spawn: undefined,
      };
    }
  }
}
```

**DI seam interfaces (lines 11-17) — DO NOT change their shape; the rounds loop calls through them:**
```typescript
export interface Scaffolder {
  scaffold(rootDir: string, child: FleetChild): Promise<ScaffoldResult>;   // :12  (2-arg)
}
export interface Runner {
  run(spec: { cwd: string; task: string; timeoutMs?: number }): Promise<ChildSpawnResult>;  // :16
}
```
> ⚠️ **CRITICAL signature mismatch to resolve.** The `Scaffolder` interface declares a **2-arg** `scaffold(rootDir, child)` (`coordinator.ts:12`), but the REAL `ChildScaffolder.scaffold` accepts a **3rd `blackboard?` param** (`src/fleet/scaffolder.ts:20-24`). To thread the Sprint-2 fleet config in round 1, you must add the optional 3rd param to the `Scaffolder` interface: `scaffold(rootDir: string, child: FleetChild, blackboard?: { dbPath: string; namespace: string; maxRounds: number }): Promise<ScaffoldResult>;`. Adding an OPTIONAL param keeps every existing fake (`coordinator.test.ts:10-22`, `116-127`, `148-158`) type-compatible — they just ignore the 3rd arg. Verify the existing tests still compile.

**Imports this file uses (lines 1-7):**
- `mapBounded` from `../orchestrator/workflow/scheduler.js`
- `ChildScaffolder` from `./scaffolder.js`, `ChildRunner` from `./runner.js`
- `import type` { `FleetManifest`, `FleetChild` } from `./manifest.js`
- `import type` { `ScaffoldResult` } from `./scaffolder.js`, { `ChildSpawnResult` } from `./runner.js`, { `ChildExecution` } from `./types.js`

**Imported by:** `src/fleet/index.ts:17` (`runFleet`), `src/fleet/coordinator.test.ts:2`, `src/fleet/index.test.ts:7` (type-only).

**Test file:** `src/fleet/coordinator.test.ts` (exists, 176 lines)

---

### src/fleet/index.ts (modify)

**The branch point — `runFleet` lines 127-141 (this is what you replace):**
```typescript
  // 4. Execute → aggregate
  const coordinator = deps?.coordinator ?? new FleetCoordinator();
  const aggregator = deps?.aggregator ?? new OutcomeAggregator();
  const reporter = deps?.reporter ?? new PortfolioReporter();

  const executions = await coordinator.execute(effectiveManifest);          // :132  ← BRANCH HERE
  const outcomes: ChildOutcome[] = await Promise.all(
    executions.map((e) => aggregator.aggregate(e)),                          // :133-135  UNCHANGED
  );

  // 5. Build + write report
  const report = reporter.build(outcomes);                                  // :138  UNCHANGED
  await reporter.write(effectiveManifest.rootDir, report);                  // :139  UNCHANGED
  return report;
```

**`resolveBlackboardPath` already exists (Sprint 2) — lines 41-44, reuse it verbatim:**
```typescript
export function resolveBlackboardPath(manifest: FleetManifest): string | undefined {
  if (!manifest.blackboard) return undefined;
  return join(resolve(manifest.rootDir), ".bober", "memory", manifest.blackboard.namespace, "facts.db");
}
```

**Imports already present:** `join, resolve` from `node:path` (line 12), `FleetCoordinator` (17), `FleetManifest` type (25). You must ADD: `SharedBlackboard` from `./shared-blackboard.js`, and `ensureDir` from `../state/helpers.js` (note: `SharedBlackboard.open` ALREADY calls `ensureDir(dirname(dbPath))` internally — see Pitfalls; the contract still asks for an explicit `ensureDir(dirname(dbPath))` for sc-3-6, which is harmless/idempotent).

**Imported by:** `src/cli/index.ts` (registers the command), `src/fleet/index.test.ts:6`.

**Test file:** `src/fleet/index.test.ts` (exists, 324 lines)

---

## 2. Patterns to Follow

### Bounded fan-out via mapBounded
**Source:** `src/fleet/coordinator.ts:30-36`
```typescript
return mapBounded(
  manifest.children,
  manifest.concurrency,           // concurrency source — always read from the manifest
  (child) => this.runChild(manifest.rootDir, child),
);
```
**Rule:** Each round runs ONE `mapBounded(children, manifest.concurrency, …)` pass. Concurrency comes from `manifest.concurrency`, never a literal.

### The never-reject child thunk
**Source:** `src/fleet/coordinator.ts:39-60`
**Rule:** Wrap ALL per-child awaits (scaffold AND run) in try/catch and return a `ChildExecution` with `scaffold.error = String(e)` on failure. `runChildRound` (round-aware) MUST preserve this exact shape — a throwing fake child must still yield a `ChildExecution`, never reject the `mapBounded` batch.

### open → try → finally close (resource lifecycle)
**Source:** generatorNotes pseudocode + `src/fleet/shared-blackboard.ts:54,108`
```typescript
const bb = await SharedBlackboard.open({ dbPath, namespace, maxRounds });
try {
  executions = await coordinator.executeRounds(effectiveManifest, bb, { maxRounds });
} finally {
  bb.close();                     // ALWAYS close (WAL checkpoint) even if a round throws
}
```
**Rule:** `SharedBlackboard.open` is `async` (`shared-blackboard.ts:54`) — `await` it. `close()` is sync (`:108`). Always close in `finally`.

### Section headers (project-wide convention)
**Source:** `src/fleet/index.ts:32`, `src/fleet/coordinator.ts:9,19`, principles.md:32
```typescript
// ── resolveBlackboardPath ─────────────────────────────────────────────
```
**Rule:** Use unicode box-drawing `// ── Name ──` headers for new sections (e.g. `// ── executeRounds ──`).

### import type for type-only symbols
**Source:** `src/fleet/coordinator.ts:4-7`, principles.md:35
**Rule:** ESLint `consistent-type-imports` is a hard gate. `FleetManifest`, `ChildExecution`, `ScaffoldResult`, `ChildSpawnResult` are TYPES → `import type`. `SharedBlackboard`, `ensureDir`, `mapBounded` are VALUES → plain `import`.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `mapBounded` | `src/orchestrator/workflow/scheduler.js` (used `coordinator.ts:1,31`) | `(items, concurrency, fn) => Promise<R[]>` | Order-preserving bounded-concurrency fan-out. Use for each round. |
| `resolveBlackboardPath` | `src/fleet/index.ts:41` | `(manifest) => string \| undefined` | ABSOLUTE blackboard db path, or undefined when no blackboard. Reuse — do not recompute. |
| `SharedBlackboard.open` | `src/fleet/shared-blackboard.ts:54` | `static async (opts:{dbPath,namespace,busyTimeoutMs?,maxRounds?}) => Promise<SharedBlackboard>` | Opens WAL facts.db; ensures parent dir; caps maxRounds at 3. |
| `SharedBlackboard.readAll` | `src/fleet/shared-blackboard.ts:103` | `() => FactRecord[]` | ALL active 'finding' facts in namespace. **Use `.length` for the new-findings count.** |
| `SharedBlackboard.close` | `src/fleet/shared-blackboard.ts:108` | `() => void` | Close db (WAL checkpoint). Call in `finally`. |
| `ensureDir` | `src/state/helpers.ts:6` | `(dirPath:string) => Promise<void>` | `mkdir(dir,{recursive:true})`. For the explicit db-dir ensure in runFleet (sc-3-6). |
| `buildChildConfig` | `src/fleet/child-config.ts:22` | `(child:FleetChild) => BoberConfig` | (Used inside scaffolder, not directly here) — do not call. |
| `OutcomeAggregator.aggregate` | `src/fleet/aggregator.ts:15` | `(exec) => Promise<ChildOutcome>` | UNCHANGED aggregate of one execution. Final round's executions feed this. |
| `PortfolioReporter.build` / `.write` | `src/fleet/reporter.ts:39,67` | `build(outcomes)=>report` / `write(rootDir,report)=>Promise` | UNCHANGED report build + atomic write to `<rootDir>/.bober/fleet-report.json`. |

> Utilities reviewed: `src/utils/` (logger only, used at index.ts:21 for CLI error logging — not needed in the loop), `src/state/helpers.ts` (ensureDir), `src/fleet/*`. The early-stop "count" needs ONLY `readAll().length` — do NOT invent a new counting helper.

---

## 4. Prior Sprint Output

### Sprint 1 (e1d4b00): src/fleet/shared-blackboard.ts
**Created:** `SharedBlackboard` with `open` / `publish` / `readSiblings` / `readAll` / `close` + `BLACKBOARD_MAX_ROUNDS = 3` (`shared-blackboard.ts:9,54,74,96,103,108`).
**Connection:** This sprint OWNS the lifecycle — `runFleet` opens/closes it; `executeRounds` calls `readAll().length` before/after each round for the early-stop decision. The coordinator NEVER publishes — children publish via `agent-bober blackboard` (nonGoal: do not auto-publish).

### Sprint 2 (2784f71): manifest.blackboard + resolveBlackboardPath + scaffolder 3rd param
**Created/extended:**
- `manifest.blackboard` schema `{ namespace: string≥1, maxRounds: int 1..3 default 3 }` (`src/fleet/manifest.ts:18-25`).
- `resolveBlackboardPath(manifest)` → ABSOLUTE path | undefined (`src/fleet/index.ts:41-44`).
- `ChildScaffolder.scaffold` gained optional 3rd `blackboard?: { dbPath, namespace, maxRounds }` param that writes `config.fleet` inside an `if (blackboard)` guard — byte-identical when absent (`src/fleet/scaffolder.ts:20-24, 62-69`).
**Connection:** In round 1 ONLY, `executeRounds` passes `{ dbPath, namespace, maxRounds }` as the 3rd arg so the child config carries the `fleet` section (sc-3-6 asserts the section is present). `namespace`/`maxRounds` come from `manifest.blackboard`; `dbPath` is the resolved absolute path.

---

## 5. Relevant Documentation

### Project Principles (.bober/principles.md)
- **ESM .js imports** mandatory (line 27). **`import type`** enforced by ESLint (35). **No `any` without justification** (40). **No sync fs** (42) — `SharedBlackboard.open` is async; await it. **Section headers** unicode box (32). **Collocated `*.test.ts`** (20). **Vitest** (20). Build + typecheck + lint are HARD gates (18-21).

### Architecture Decisions (arch-20260618-heterogeneous-multi-provider-agent-team)
- **ADR-3 (adr-3.md):** Siblings exchange findings through ONE shared WAL `facts.db`, capped at hard `BLACKBOARD_MAX_ROUNDS=3`. Exchange is "bounded capped-round, NOT free discussion (prior research found free discussion fails to converge)". Findings are FactRecord rows (scope=namespace, subject=childFolder, predicate="finding").
- **ADR-5 (adr-5.md):** Head computes ONE absolute path ONCE and injects it into each child's declared `config.fleet`. Children NEVER derive the path. `BoberConfigSchema` strips unknown keys → the field must be the DECLARED section (handled by Sprint-2 scaffolder). **"blackboard-absent path is byte-identical."**
- **CP4 Data-Flow (architecture.md:263-285):** `runFleet → resolveBlackboardPath (one absolute path) → ToolRoleGuard → validateManifestCredentials → coordinator.execute → mapBounded(children, concurrency, runChild) → scaffolder writes config incl. fleet.blackboardDbPath → ChildRunner.run (execa, separate cwd) → coordinator collects ChildSpawnResult[]`. Line 285: **"every new branch is gated on `undefined` (child.tier, manifest.blackboard, config.fleet) → byte-identical."** Line 281's SynthesisStep is **Sprint 4 — NOT this sprint** (nonGoal).

---

## 6. Testing Patterns

### Unit Test Pattern — fake DI for the coordinator
**Source:** `src/fleet/coordinator.test.ts:10-35` (fake factory) + `:46-47` (injection)
```typescript
function makeScaffolder(overrides?: Partial<Scaffolder>): Scaffolder {
  return {
    async scaffold(_root: string, child: { folder: string }): Promise<ScaffoldResult> {
      return { folder: child.folder, absPath: "/tmp/" + child.folder,
               configWritten: true, gitInitialized: true };
    },
    ...overrides,
  };
}
function makeRunner(overrides?: Partial<Runner>): Runner {
  return {
    async run(spec: { cwd: string; task: string; timeoutMs?: number }): Promise<ChildSpawnResult> {
      return { cwd: spec.cwd, exitCode: 0, stdout: "", stderr: "" };
    },
    ...overrides,
  };
}
// injection:
const coord = new FleetCoordinator({ scaffolder: makeScaffolder(), runner: makeRunner() });
```
**Recording-fake pattern** for call-count assertions (mirror this for scaffold-once / re-spawn-per-round):
```typescript
const scaffoldCalls: string[] = [];
const runCalls: string[] = [];
const scaffolder: Scaffolder = {
  async scaffold(_root, child, _bb) { scaffoldCalls.push(child.folder); return {/* ScaffoldResult */}; },
};
const runner: Runner = {
  async run(spec) { runCalls.push(spec.cwd); return { cwd: spec.cwd, exitCode: 0, stdout: "", stderr: "" }; },
};
```
**Failing-child fake** (`coordinator.test.ts:88-93`): `if (spec.task === "BOOM") throw new Error("kaboom");` then assert `await coord.execute/executeRounds` does NOT reject and `results[i].scaffold.error` contains the message.

**Runner:** Vitest. **Assertion style:** `expect().toBe/toEqual/toHaveLength/toContain`. **Mock approach:** hand-rolled fakes via DI constructor (NO `vi.mock`). **File naming:** `*.test.ts` collocated.

### Integration-ish Test Pattern — real SharedBlackboard with tmp db
**Source:** `src/fleet/shared-blackboard.test.ts:1-44` (real db in a tmpdir)
```typescript
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const NOW = "2026-06-18T00:00:00.000Z";
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-blackboard-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });
// open a real bb, publish findings, assert readAll().length
const bb = await SharedBlackboard.open({ dbPath: join(tmpDir, "bb.db"), namespace: "ns", maxRounds: 3 });
bb.publish({ childFolder: "a", round: 1, payload: "f1" }, NOW); // drive early-stop by NOT publishing in round 2
```

### runFleet harness — fake coordinator + env key + tmp manifest
**Source:** `src/fleet/index.test.ts:29-59, 67-81, 84-115`
```typescript
function makeFakeCoordinator(executions: ChildExecution[]): { coord: FleetCoordinator; calls: FleetManifest[] } {
  const calls: FleetManifest[] = [];
  const coord = {
    async execute(manifest: FleetManifest): Promise<ChildExecution[]> { calls.push(manifest); return executions; },
  } as unknown as FleetCoordinator;
  return { coord, calls };
}
// env + tmp manifest required: DEEPSEEK_API_KEY must be set or validateManifestCredentials throws (index.ts:125)
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-fleet-")); process.env["DEEPSEEK_API_KEY"] = "fake-key-for-test"; });
```
> ⚠️ For the runFleet blackboard test you must ALSO stub/extend the fake coordinator with an `executeRounds` method (cast via `as unknown as FleetCoordinator`), OR use a real `FleetCoordinator` with fake scaffolder+runner deps. The existing fakes only implement `execute` (`index.test.ts:35`), so the no-blackboard tests stay green; a blackboard test needs a fake exposing `executeRounds`.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/fleet/index.ts` | `coordinator.execute` (:132) | high | Branch must keep the no-blackboard path calling `execute` UNCHANGED; aggregate+report (:133-139) untouched. |
| `src/fleet/coordinator.test.ts` | `Scaffolder` interface (:3) | high | Adding optional 3rd `blackboard?` param to `Scaffolder` must keep all 5 existing tests compiling/passing (fakes ignore the arg). |
| `src/fleet/index.test.ts` | `coordinator.execute` fake (:35) | medium | No-blackboard manifests still call `execute`; existing `calls`-length assertions (`:114` expects 1) must hold. |
| `src/fleet/scaffolder.ts` | `Scaffolder` interface conformance | low | `ChildScaffolder.scaffold` already has the 3rd param (`scaffolder.ts:20-24`); widening the interface aligns them. |
| `src/cli/index.ts` | `registerFleetCommand` | low | CLI unchanged; rounds are internal to runFleet. |

### Existing Tests That Must Still Pass (grep: importers of coordinator/index)
- `src/fleet/coordinator.test.ts` — 5 tests (execute order, concurrency cap, runner-throw, scaffolder-throw, scaffold-error-skips-spawn). The no-blackboard manifests in these have NO `blackboard` field → must hit the byte-identical `execute` path unchanged.
- `src/fleet/index.test.ts` — `runFleet` end-to-end (counts, report write, overrides), credential fail-fast, ToolRoleGuard fail-fast, `registerFleetCommand`. All use no-blackboard manifests → must pass unchanged.
- `src/fleet/shared-blackboard.test.ts` — Sprint-1 tests; untouched, must stay green.

### Features That Could Be Affected
- **`fleet expand` / `expand-deep`** (`index.ts:184,309`) — both call `runFleet(outPath)` with no blackboard → must keep working (byte-identical path). Verify `runFleetExpand` tests pass.
- **fleet credential / tool-role guards** (`index.ts:124-125`) — run BEFORE the new branch; do not move them.

### Recommended Regression Checks (run after implementation)
1. `npm run build` (tsc clean — sc-3-1)
2. `npm test -- src/fleet` (all fleet tests; sc-3-2 — only the 6 known cockpit-integration MCP failures may fail, NONE in fleet)
3. `npm run lint` (consistent-type-imports + no-unused; sc-3-8)
4. Confirm `src/fleet/coordinator.test.ts` + `src/fleet/index.test.ts` pass UNCHANGED (no edits to existing test bodies — only ADD new tests).

---

## 8. Implementation Sequence

1. **src/fleet/coordinator.ts — widen `Scaffolder` interface (types first).**
   Add optional 3rd param: `scaffold(rootDir, child, blackboard?: { dbPath: string; namespace: string; maxRounds: number }): Promise<ScaffoldResult>;` (`:11-13`).
   - Verify: existing fakes (`coordinator.test.ts`) still type-check (optional arg = ignorable).

2. **src/fleet/coordinator.ts — add `runChildRound` (round-aware never-reject thunk).**
   Mirror `runChild` (`:39-60`) but: signature `private async runChildRound(rootDir, child, round, blackboardScaffoldCfg?): Promise<ChildExecution>`. Scaffold ONLY when `round === 1` (pass `blackboardScaffoldCfg` as 3rd arg); on rounds ≥2 skip scaffolding entirely and reuse the round-1 `absPath` (`resolve(rootDir, child.folder)` — same formula the scaffolder uses at `scaffolder.ts:25`) for `runner.run({ cwd, task })`. Keep the full try/catch.
   - Verify: a thrown error still returns a `ChildExecution` with `scaffold.error`.

3. **src/fleet/coordinator.ts — add `executeRounds(manifest, blackboard, { maxRounds })`.**
   Pseudocode (from generatorNotes):
   ```typescript
   async executeRounds(manifest, blackboard, opts: { maxRounds: number }): Promise<ChildExecution[]> {
     const ns = manifest.blackboard!.namespace;
     const scaffoldCfg = { dbPath: <resolved absolute path>, namespace: ns, maxRounds: opts.maxRounds };
     let prevCount = blackboard.readAll().length;
     let lastExecutions: ChildExecution[] = [];
     for (let r = 1; r <= opts.maxRounds; r++) {
       lastExecutions = await mapBounded(manifest.children, manifest.concurrency,
         (child) => this.runChildRound(manifest.rootDir, child, r, r === 1 ? scaffoldCfg : undefined));
       const count = blackboard.readAll().length;
       if (r > 1 && count === prevCount) break;   // early-stop: no new findings
       prevCount = count;
     }
     return lastExecutions;
   }
   ```
   > The absolute dbPath: prefer threading it in (e.g. via `scaffoldCfg.dbPath` passed from runFleet) rather than recomputing — runFleet already has it from `resolveBlackboardPath`. Cleanest: have runFleet pass `{ dbPath, namespace, maxRounds }` so executeRounds doesn't re-derive. (You may add it to the opts object.)
   - Verify: with `maxRounds=3` and growing findings each round → 3 mapBounded passes; scaffold called once per child.

4. **src/fleet/index.ts — branch `runFleet` at line 132.**
   ```typescript
   const dbPath = resolveBlackboardPath(effectiveManifest);
   let executions: ChildExecution[];
   if (dbPath) {
     await ensureDir(dirname(dbPath));
     const bb = await SharedBlackboard.open({
       dbPath, namespace: effectiveManifest.blackboard!.namespace,
       maxRounds: effectiveManifest.blackboard!.maxRounds,
     });
     try {
       executions = await coordinator.executeRounds(effectiveManifest, bb,
         { maxRounds: effectiveManifest.blackboard!.maxRounds });
     } finally { bb.close(); }
   } else {
     executions = await coordinator.execute(effectiveManifest);   // BYTE-IDENTICAL no-blackboard path
   }
   ```
   Add imports: `SharedBlackboard` from `./shared-blackboard.js`, `ensureDir` from `../state/helpers.js`, `dirname` to the `node:path` import (line 12), and the `ChildExecution` type. Leave aggregate (:133-135) + report (:138-139) UNCHANGED.
   - Verify: no-blackboard manifest → `execute` called once, no `SharedBlackboard.open`.

5. **src/fleet/coordinator.test.ts — ADD (do not edit existing) 4 tests:**
   - **scaffold-once / re-spawn-per-round (sc-3-3):** recording fakes, real bb (tmp db) that gains a finding each round, maxRounds=3 → assert `scaffoldCalls` length === children.length (one per child total), `runCalls` length === children.length × 3.
   - **early-stop-at-2 (sc-3-4):** seed bb so round 1 publishes a finding but round 2 publishes none (e.g. fake runner publishes only on round 1) → assert exactly 2 rounds ran (runner called twice per child, not 3×).
   - **no-blackboard byte-identical single pass (sc-3-5):** manifest WITHOUT blackboard → `coord.execute(manifest)` runs one mapBounded pass; assert runner called once per child (the existing 5 tests already cover the return shape — add an explicit "single pass / no rounds" assertion).
   - **failing-child-no-throw (sc-3-7):** failing fake child inside `executeRounds` → does NOT reject; the `ChildExecution` carries the error as data.

6. **src/fleet/index.test.ts — ADD blackboard-path tests:**
   - **path injection + rounds (sc-3-6):** manifest WITH `blackboard:{namespace, maxRounds}`, real `FleetCoordinator` with recording scaffolder → assert the scaffolder received the 3rd `blackboard` arg with the ABSOLUTE `dbPath` (matches `resolveBlackboardPath`), the db dir was created, and `bb` opened+closed. Set `DEEPSEEK_API_KEY` (env, `index.test.ts:71`) + tmp manifest.
   - **no-blackboard opens no blackboard (sc-3-5 at runFleet):** no-blackboard manifest → fake coordinator's `execute` called, `executeRounds` NOT called, no facts.db created on disk.

7. **Run full verification:** `npm run build` && `npm test -- src/fleet` && `npm run lint`.

---

## 9. Pitfalls & Warnings

- **DOUBLE `ensureDir` is fine.** `SharedBlackboard.open` already calls `ensureDir(dirname(opts.dbPath))` (`shared-blackboard.ts:55-57`). sc-3-6 asks runFleet to ALSO `ensureDir(dirname(dbPath))` — keep it (idempotent, `mkdir recursive`). Do NOT remove the internal one.
- **`SharedBlackboard.open` is ASYNC** (`shared-blackboard.ts:54`) — `await` it. `close()` is SYNC. Wrong await placement = unhandled rejection in the `finally`.
- **Scaffolder no-op myth:** the real `ChildScaffolder.scaffold` does NOT silently skip an already-scaffolded folder — it returns an ERROR `"folder exists and is non-empty"` (`scaffolder.ts:33-40`). So you MUST gate scaffolding to `round === 1` in `runChildRound`; you CANNOT rely on idempotent re-scaffolding. Re-calling scaffold on round 2 would taint every `ChildExecution.scaffold.error` and corrupt the report (sc-3-5/sc-3-7 regression). This is the #1 trap.
- **absPath on rounds ≥2:** the round-1 scaffold returns `absPath = resolve(rootDir, child.folder)` (`scaffolder.ts:25`). On later rounds recompute the SAME value the same way for `runner.run({ cwd })` — do not invent a different path.
- **Early-stop is `r > 1 && count === prevCount`** — round 1 NEVER early-stops (there's no prior round to compare). "New findings" = `readAll().length` delta ONLY (nonGoal: no semantic convergence). Update `prevCount` AFTER the break check.
- **`manifest.blackboard.maxRounds` defaults to 3** via Zod (`manifest.ts:23`) and is already 1..3-clamped; `SharedBlackboard.open` re-clamps to `BLACKBOARD_MAX_ROUNDS=3` (`shared-blackboard.ts:62-65`). Use `manifest.blackboard.maxRounds` as the loop bound; it is always present (defaulted) when `blackboard` is set.
- **Do NOT publish findings from the coordinator.** Findings come only from children calling `agent-bober blackboard` (Sprint 2 nonGoal). The coordinator only READS (`readAll().length`).
- **Do NOT write fleet-synthesis.json** — that's Sprint 4. This sprint keeps writing ONLY `fleet-report.json` from the FINAL round's executions.
- **Optional-3rd-param, not overload.** Widen the `Scaffolder` interface with an optional param — do not add a second overload signature; the existing fakes are object literals and break on overloads but tolerate optional params.
- **Do NOT edit existing test bodies.** sc-3-2/sc-3-5 require the existing coordinator/index tests to pass UNCHANGED. Only ADD new `it(...)` blocks.
- **ESLint will catch:** non-`import type` on types, unused vars (prefix `_`), `any`. The `effectiveManifest.blackboard!` non-null assertions are safe inside the `if (dbPath)` branch (dbPath truthy ⟺ blackboard set, per `resolveBlackboardPath`).
