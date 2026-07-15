# Sprint Briefing: executeRounds returns real round count → fleet-synthesis.json + fleet-report.json

**Contract:** sprint-spec-20260618-fleet-synthesis-round-count-1
**Generated:** 2026-06-18T20:30:00Z

> SCOPE: 3 source files + their 3 collocated tests. All under `src/fleet/`. synthesis.ts is UNCHANGED.
> TWO INVARIANTS DOMINATE THIS SPRINT (flagged in §9): **(1) byte-identical no-blackboard report** (no `rounds` key, no synthesis file) and **(2) the never-throw / exit-0 contract** of the coordinator round loop and `runChildRound`.

---

## 1. Target Files

### src/fleet/coordinator.ts (modify)

**Relevant section — executeRounds, EXACT current source (lines 46-82):**
```ts
  // ── executeRounds ─────────────────────────────────────────────────

  /**
   * Run children for up to opts.maxRounds rounds sharing the blackboard.
   * Round 1 scaffolds each child (writes config.fleet from scaffoldCfg).
   * Rounds 2..N skip scaffolding entirely and re-spawn via runner only.
   * Early-stops when a completed round adds zero new 'finding' facts.
   * Returns the FINAL round's ChildExecution[].
   */
  async executeRounds(
    manifest: FleetManifest,
    blackboard: SharedBlackboard,
    opts: { maxRounds: number; dbPath: string },
  ): Promise<ChildExecution[]> {                       // ← change return type
    const scaffoldCfg = {
      dbPath: opts.dbPath,
      namespace: manifest.blackboard!.namespace,
      maxRounds: opts.maxRounds,
    };

    let prevCount = blackboard.readAll().length;
    let lastExecutions: ChildExecution[] = [];
                                                        // ← add: let roundsRun = 0;
    for (let r = 1; r <= opts.maxRounds; r++) {
                                                        // ← add (FIRST stmt in body): roundsRun = r;
      lastExecutions = await mapBounded(
        manifest.children,
        manifest.concurrency,
        (child) => this.runChildRound(manifest.rootDir, child, r, r === 1 ? scaffoldCfg : undefined),
      );

      const count = blackboard.readAll().length;
      if (r > 1 && count === prevCount) break; // early-stop: no new findings this round
      prevCount = count;
    }

    return lastExecutions;                              // ← change to: return { executions: lastExecutions, roundsRun };
  }
```

**THE EXACT EDIT (3 mechanical changes, nothing else in this method):**
1. Return type signature (line 59): `): Promise<ChildExecution[]> {` → `): Promise<{ executions: ChildExecution[]; roundsRun: number }> {`
2. Declare before the loop (after `let lastExecutions: ChildExecution[] = [];`, before `for`): `let roundsRun = 0;`
3. The **FIRST** statement inside the for-body (before `lastExecutions = await mapBounded(...)`): `roundsRun = r;` — this MUST be before the body so it captures the round even if `break` fires later in the same iteration.
4. Return (line 81): `return lastExecutions;` → `return { executions: lastExecutions, roundsRun };`

**Trace (evaluator will run these):** full run, no break → `roundsRun === maxRounds`; break at r=2 → `roundsRun === 2`; maxRounds=1 → `roundsRun === 1`. `manifest.blackboard.maxRounds` is int min(1) max(3), loop always runs ≥1, so `roundsRun >= 1` on any real call.

**DO NOT TOUCH (non-goals):** the early-stop condition `if (r > 1 && count === prevCount) break;` (line 77), the scaffold-once gating `r === 1 ? scaffoldCfg : undefined` (line 73), `runChildRound` (lines 91-131 — the round-aware never-reject thunk), `runChild` (lines 134-155), and the no-blackboard `execute()` (lines 38-44).

**Imports this file uses (no new imports needed):** `mapBounded` from `../orchestrator/workflow/scheduler.js`; `ChildScaffolder` from `./scaffolder.js`; `ChildRunner` from `./runner.js`; `import type { ChildExecution }` from `./types.js`; `import type { SharedBlackboard }` from `./shared-blackboard.js`.

**Imported by:** `src/fleet/index.ts:19` (`FleetCoordinator`) and `src/fleet/coordinator.test.ts:5` + `src/fleet/index.test.ts:7`. `executeRounds` is a public method called ONLY at `index.ts:185` (production) and in the two test files (grep-verified — see §7).

**Test file:** `src/fleet/coordinator.test.ts` (exists — 380 lines).

---

### src/fleet/index.ts (modify)

**Relevant section — runFleet blackboard branch, EXACT current source (lines 164-213):**
```ts
  // ── Blackboard-aware execution branch ────────────────────────────
  const dbPath = resolveBlackboardPath(effectiveManifest);
  let executions: ChildExecution[];
  let bb: SharedBlackboard | null = null; // hoisted so it survives the if-block
  let roundsRun = 0; // capture the configured round cap          // ← line 168 STAYS (comment may be trimmed)

  try {
    if (dbPath) {
      // Blackboard path: open a shared WAL facts.db, run bounded rounds.
      // bb is hoisted to the outer scope so collect() can call bb.readAll()
      // BEFORE bb.close() (which moves to the outer finally below).
      await ensureDir(dirname(dbPath));
      bb = await SharedBlackboard.open({
        dbPath,
        namespace: effectiveManifest.blackboard!.namespace,
        maxRounds: effectiveManifest.blackboard!.maxRounds,
      });
      // bober: round count sourced from manifest cap; executeRounds returns only   ← DELETE lines 181-183
      // the final-round executions with no explicit count — swapping to a
      // returned-count shape would require touching the coordinator (non-goal #5).
      roundsRun = effectiveManifest.blackboard!.maxRounds;                          ← DELETE line 184
      executions = await coordinator.executeRounds(effectiveManifest, bb, {         ← change to destructure (line 185)
        maxRounds: effectiveManifest.blackboard!.maxRounds,
        dbPath,
      });
    } else {
      // No-blackboard path: single mapBounded pass, byte-identical to pre-Phase-B.
      executions = await coordinator.execute(effectiveManifest);
    }

    const outcomes: ChildOutcome[] = await Promise.all(
      executions.map((e) => aggregator.aggregate(e)),
    );

    // 5. Build + write report (UNCHANGED — always written on every run)
    const report = reporter.build(outcomes);                                        ← change (line 199)
    await reporter.write(effectiveManifest.rootDir, report);

    // 6. Synthesis (ADDITIVE — only on a blackboard run; AFTER the report write)
    // bb is still OPEN here so collect() → bb.readAll() works correctly.
    if (bb) {
      const bundle = collect(bb, report, roundsRun);                                ← STAYS AS-IS (now real)
      await writeSynthesis(effectiveManifest.rootDir, bundle);
    }

    return report;
  } finally {
    // Close moved here: runs AFTER synthesis collect+write, and on any error path.
    if (bb) bb.close();
  }
```

**THE EXACT EDIT (3 changes):**
1. **DELETE** the `bober:` ceiling comment block (lines 181-183, the three `//` lines).
2. **DELETE** the hardcoded `roundsRun = effectiveManifest.blackboard!.maxRounds;` (line 184).
3. **Destructure** the executeRounds call (line 185). Replace `executions = await coordinator.executeRounds(...)` with:
   ```ts
   const { executions: roundExecutions, roundsRun: rr } = await coordinator.executeRounds(effectiveManifest, bb, {
     maxRounds: effectiveManifest.blackboard!.maxRounds,
     dbPath,
   });
   executions = roundExecutions;
   roundsRun = rr;
   ```
   (Note: `executions` and `roundsRun` are already declared at the outer scope — lines 166 and 168 — so you assign into them. Cannot use a bare `const { executions, roundsRun }` here because they shadow / are already declared; use the renamed-destructure-then-assign shown above, per the contract assumption.)
4. **Change the report build** (line 199): `const report = reporter.build(outcomes);` → `const report = reporter.build(outcomes, bb ? { rounds: roundsRun } : undefined);`
5. **LEAVE** `collect(bb, report, roundsRun)` (line 205) as-is — it now receives the real count.

**KEEP:** `let roundsRun = 0;` at line 168 (the contract explicitly says it stays; only the `// capture the configured round cap` comment is now slightly stale — you may trim it but it is harmless). The no-blackboard branch `executions = await coordinator.execute(effectiveManifest);` (line 191) stays.

**Why `bb ? {rounds} : undefined`:** on the no-blackboard path `bb` is `null`, so `build` is called with `undefined` → byte-identical report (no `rounds` key). On the blackboard path `bb` is non-null → `{ rounds: roundsRun }` is passed.

**Imports this file uses (relevant):** `collect` from `./synthesis.js` (line 23); `import type { ChildExecution }` from `./types.js`; `import type { PortfolioReport }` from `./reporter.js`. No new imports needed.

**Imported by:** CLI entrypoint (`registerFleetCommand` is wired into the commander program) and `src/fleet/index.test.ts:6`.

**Test file:** `src/fleet/index.test.ts` (exists — 641 lines).

---

### src/fleet/reporter.ts (modify)

**Relevant sections — PortfolioReport interface + build, EXACT current source (lines 15-62):**
```ts
// ── Types ─────────────────────────────────────────────────────────────

export interface PortfolioReport {
  total: number;
  completed: number;
  failed: number;
  other: number;
  generatedAt: string;
  children: ChildOutcome[];
                          // ← add: rounds?: number;
}
...
  build(outcomes: ChildOutcome[]): PortfolioReport {       // ← change signature
    let completed = 0;
    let failed = 0;
    let other = 0;

    for (const o of outcomes) {
      if (o.status === "completed") {
        completed++;
      } else if (o.status === "failed") {
        failed++;
      } else {
        other++;
      }
    }

    return {
      total: outcomes.length,
      completed,
      failed,
      other,
      generatedAt: new Date().toISOString(),
      children: outcomes,
                              // ← add: ...(opts?.rounds !== undefined ? { rounds: opts.rounds } : {}),
    };
  }
```

**THE EXACT EDIT (2 changes):**
1. Add to the interface (after `children: ChildOutcome[];`, line 23): `rounds?: number;`
2. Change build signature (line 39): `build(outcomes: ChildOutcome[]): PortfolioReport {` → `build(outcomes: ChildOutcome[], opts?: { rounds?: number }): PortfolioReport {`
3. Add to the returned object literal (inside the `return { ... }`, after `children: outcomes,`): `...(opts?.rounds !== undefined ? { rounds: opts.rounds } : {}),`

**Byte-identical guarantee:** a no-arg `build(outcomes)` call → `opts` is `undefined` → `opts?.rounds` is `undefined` → spread is `{}` → returned object has NO `rounds` key. This is THE mechanism that keeps the no-blackboard report byte-identical.

**Imports this file uses:** `import type { ChildOutcome }` from `./types.js`. No new imports needed.

**Imported by:** `src/fleet/index.ts:21` (`PortfolioReporter`) + `PortfolioReport` type imported across the fleet module (`index.ts:32`, `synthesis.ts:10`). `PortfolioReport.rounds` is OPTIONAL so adding it does not break any existing structural consumer.

**Test file:** `src/fleet/reporter.test.ts` (exists — 108 lines).

---

### src/fleet/synthesis.ts (NO CHANGE — verified)

**collect, EXACT current source (lines 29-39):**
```ts
export function collect(
  blackboard: SharedBlackboard | null,
  childResults: PortfolioReport,
  rounds: number,
): SynthesisBundle {
  return {
    rounds,
    childResults,
    findings: blackboard ? blackboard.readAll() : [],
  };
}
```
`collect` already takes `rounds: number` and assigns it verbatim into the bundle. NO edit required — only the VALUE passed at `index.ts:205` changes (from the maxRounds cap to the real `roundsRun`). `SynthesisBundle.rounds` (synthesis.ts:16) is already `number`. Confirm in the final diff that synthesis.ts shows zero changes (evaluator note sc-1-7 greps for this).

---

## 2. Patterns to Follow

### Optional-key guarded spread (the byte-identical mechanism)
**Source:** `src/fleet/index.ts`, lines 149-153 (existing precedent in this same file)
```ts
  const effectiveManifest = {
    ...manifest,
    ...(options?.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    ...(options?.rootDir !== undefined ? { rootDir: options.rootDir } : {}),
  };
```
**Rule:** Conditional object keys use `...(cond ? { key: val } : {})` so the key is fully ABSENT (not `undefined`) when the condition is false. Mirror this exactly in `reporter.build` for `rounds`.

### Object destructure-with-rename then assign into outer-scope let
**Source:** new pattern; contract assumption (contract line 35) prescribes it. The outer `let executions` / `let roundsRun` already exist (index.ts:166, 168), so you cannot redeclare — use `const { executions: roundExecutions, roundsRun: rr } = ...; executions = roundExecutions; roundsRun = rr;`.
**Rule:** When a destructure target name collides with an outer-scope binding, rename in the destructure and assign across.

### ESM `.js` import extensions + `import type`
**Source:** `src/fleet/index.ts`, lines 16-34
```ts
import { collect } from "./synthesis.js";
import type { ChildOutcome, ChildExecution } from "./types.js";
import type { PortfolioReport } from "./reporter.js";
```
**Rule:** All relative imports carry `.js`; type-only imports use `import type` (ESLint `consistent-type-imports` is a hard gate — principles.md:35).

### Unicode box-drawing section headers
**Source:** `src/fleet/coordinator.ts`, line 46 (`  // ── executeRounds ─────────...`) and `reporter.ts`, line 15 (`// ── Types ───────...`)
**Rule:** Keep existing `// ── Name ──` headers; do not introduce ASCII `// ---` headers (principles.md:32).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `collect` | `src/fleet/synthesis.ts:29` | `(blackboard: SharedBlackboard \| null, childResults: PortfolioReport, rounds: number): SynthesisBundle` | Pure assembly of the synthesis bundle; already takes `rounds` — pass real `roundsRun`, do not reshape. |
| `PortfolioReporter.build` | `src/fleet/reporter.ts:39` | `(outcomes: ChildOutcome[], opts?: { rounds?: number }): PortfolioReport` (after edit) | Tally outcomes into a report; you are EXTENDING it, not adding a new builder. |
| `PortfolioReporter.write` | `src/fleet/reporter.ts:76` | `(rootDir, report): Promise<string>` | Atomic tmp+rename write of fleet-report.json; UNCHANGED — do not touch. |
| `writeSynthesis` | `src/fleet/index.ts:61` | `(rootDir, bundle): Promise<string>` | Atomic write of fleet-synthesis.json; UNCHANGED. |
| `resolveBlackboardPath` | `src/fleet/index.ts:47` | `(manifest): string \| undefined` | Returns the absolute facts.db path or undefined; the gate for the blackboard branch. UNCHANGED. |
| `mapBounded` | `src/orchestrator/workflow/scheduler.js` | `(items, concurrency, fn)` | Bounded-concurrency fan-out used by the round loop; UNCHANGED. |
| `SharedBlackboard.readAll` | `src/fleet/shared-blackboard.ts:103` | `(): FactRecord[]` | Reads all active findings; used for early-stop count and by collect. UNCHANGED. |

**Utilities reviewed:** `src/utils/` (logger.ts etc.), `src/state/helpers.ts` (`ensureDir`), `src/fleet/*` — none beyond the above are needed; this sprint adds NO new utility. No new helper should be created.

---

## 4. Prior Sprint Output

### Phase B: spec-20260618-fleet-blackboard-exchange (just completed, same branch)
**Created/modified:** `executeRounds` (coordinator.ts:55), the runFleet blackboard branch (index.ts:165-213), `collect` + `SynthesisBundle` (synthesis.ts), `writeSynthesis` (index.ts:61), `resolveBlackboardPath` (index.ts:47), and the `fleet-synthesis.json` write path.
**Connection to this sprint:** Phase B introduced the hardcoded `roundsRun = maxRounds` placeholder (index.ts:184) with the `bober:` comment explicitly deferring the real count to this sprint. THIS sprint replaces that placeholder with the real terminating round returned by `executeRounds`, and threads it into both the synthesis bundle (already wired via `collect`) and a new optional report field. No Phase-B behavior (rounds cap, early-stop, scaffold-once, never-throw) changes.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`) — HARD RULES that bite here
- **ESM everywhere, `.js` import extensions** (line 27) — already satisfied by existing imports; do not drop `.js`.
- **Use `type` imports** — `consistent-type-imports` is a HARD lint gate (line 35). The reporter `opts` type is inline `{ rounds?: number }`, no new import.
- **TypeScript strict, zero type errors is a hard gate** (line 18) — the destructure rename must type-check; `roundsRun` is `number`.
- **Section comments `// ── Name ──`** (line 32) — preserve.
- **No synchronous fs** (line 42) — irrelevant to this sprint (no fs added) but do not introduce any.
- **Tests collocated `*.test.ts`** (line 20), **Vitest** — tests live next to source; create temp dirs and clean up (line 44).
- **Conventional commit:** `bober(sprint-1): real executed round count in fleet synthesis + report` (line 34; contract generatorNotes).

### Architecture Decisions
- **ADR-5 (cited at index.ts:42-45):** the caller bears absolute-path responsibility (`resolveBlackboardPath` applies `resolve()`). Not changed here, but do not regress it.
- No new ADRs apply to this sprint (round-count threading is an internal value change).

### Other Docs
README/CLAUDE.md not re-read — principles.md is the governing doc for `src/fleet/`. Contract `evaluatorNotes` are the authoritative acceptance script.

---

## 6. Testing Patterns

### Unit Test Pattern — coordinator (executeRounds round-count)
**Source:** `src/fleet/coordinator.test.ts`, lines 199-300 (the existing executeRounds describe block). The fakes `Scaffolder`/`Runner` and `makeManifest(children, concurrency, blackboard)` (lines 37-43) are the templates.

The EXISTING early-stop test (sc-3-4, lines 249-300) drives early-stop by publishing findings ONLY in round 1:
```ts
  it("sc-3-4: early-stop — round 2 adds zero new findings → loop runs exactly 2 rounds", async () => {
    ...
    let runnerCallCount = 0;
    const numChildren = 2;
    const runner: Runner = {
      async run(spec) {
        runCalls.push(spec.cwd);
        runnerCallCount++;
        const currentRound = Math.ceil(runnerCallCount / numChildren);
        if (currentRound === 1) {
          bb.publish({ childFolder: spec.cwd, round: 1, payload: "finding-round1" }, now);
        }
        return { cwd: spec.cwd, exitCode: 0, stdout: "", stderr: "" };
      },
    };
    ...
    await coord.executeRounds(manifest, bb, { maxRounds: 3, dbPath });   // ← line 292: was bare; now destructure
    bb.close();
    expect(runCalls).toHaveLength(4);    // 2 children × 2 rounds
    expect(scaffoldCalls).toHaveLength(2);
  });
```
The FULL-RUN test (sc-3-3, lines 199-247) publishes a finding on EVERY runner call so count grows each round → no early-stop → full maxRounds:
```ts
    const results = await coord.executeRounds(manifest, bb, { maxRounds: 3, dbPath });  // ← line 239: destructure
    ...
    expect(results).toHaveLength(2);
```

**Runner:** vitest. **Assertion style:** `expect(...).toHaveLength / .toBe / .toEqual`. **Mock approach:** hand-rolled fake `Scaffolder`/`Runner` objects (NO `vi.mock`). **File naming:** `*.test.ts` collocated. **Temp dirs:** `mkdtemp(join(tmpdir(), "bober-coordinator-rounds-"))` in `beforeEach`, `rm(..., {recursive,force})` in `afterEach` (lines 191-197).

### Unit Test Pattern — reporter build optional key
**Source:** `src/fleet/reporter.test.ts`, lines 16-50 (`PortfolioReporter.build (sc-4-4)` describe). Existing assertions on `report.total/completed/...`. Add new `it` blocks here for the optional `rounds` key:
```ts
    const report = reporter.build([]);            // no opts
    expect('rounds' in report).toBe(false);       // ← key ABSENT

    const r2 = reporter.build([], { rounds: 2 }); // with opts
    expect(r2.rounds).toBe(2);
```

### Unit Test Pattern — runFleet blackboard synthesis + report (sc-4-4)
**Source:** `src/fleet/index.test.ts`, lines 507-584 (`runFleet synthesis file written on blackboard run (sc-4-4)`). It builds a real `FleetCoordinator({ scaffolder, runner })` with hand-rolled fakes and a manifest with `blackboard: { namespace, maxRounds: 2 }`, then reads `fleet-synthesis.json` and `fleet-report.json`:
```ts
    const synRaw = await readFile(join(tmpDir, ".bober", "fleet-synthesis.json"), "utf-8");
    const syn = JSON.parse(synRaw) as { rounds: unknown; ... };
    expect(typeof syn.rounds).toBe("number");
    const repRaw = await readFile(join(tmpDir, ".bober", "fleet-report.json"), "utf-8");
    const rep = JSON.parse(repRaw) as { total: number; completed: number };
    expect(rep).toMatchObject({ total: 1, completed: 1 });
```
To assert the REAL early-stop count, you need a runner that publishes findings only in round 1 (so the loop stops at round 2 of maxRounds=3) — copy the round-detection trick from `coordinator.test.ts:272-283` (`Math.ceil(runnerCallCount/numChildren)`), set the manifest `blackboard: { namespace, maxRounds: 3 }`, then assert `syn.rounds === 2` AND `rep.rounds === 2`.

### Byte-identical no-blackboard test
**Source:** `src/fleet/index.test.ts`, lines 588-640 (`runFleet synthesis file absent on no-blackboard run (sc-4-6 byte-identical)`). It uses `makeFakeCoordinator([...])` (lines 32-44, whose fake only has `execute`) and asserts synthesis.json is absent + report.total. EXTEND this test (or its block) to also read `fleet-report.json` and assert the absent `rounds` key:
```ts
    const rep = JSON.parse(repRaw) as Record<string, unknown>;
    expect('rounds' in rep).toBe(false);   // ← no-blackboard report has NO rounds key
```

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
`executeRounds` return shape changes from `ChildExecution[]` to `{ executions, roundsRun }`. grep-verified call-sites (only these):
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/fleet/index.ts:185` | `coordinator.executeRounds` | HIGH | Production caller. MUST destructure `.executions` / `.roundsRun` (this is part of the sprint). |
| `src/fleet/coordinator.test.ts:239` | `coord.executeRounds` (sc-3-3 full run) | HIGH | `const results = await coord.executeRounds(...)` then `expect(results).toHaveLength(2)` — must become `const { executions: results, roundsRun } = ...`; add `expect(roundsRun).toBe(3)`. |
| `src/fleet/coordinator.test.ts:292` | `coord.executeRounds` (sc-3-4 early-stop) | HIGH | bare `await coord.executeRounds(...)` — change to `const { roundsRun } = await ...`; add `expect(roundsRun).toBe(2)`. |
| `src/fleet/coordinator.test.ts:367` | `coord.executeRounds` (sc-3-7 failing child, maxRounds=1) | HIGH | `const results = await coord.executeRounds(...)` then `results.find(...)` — change to `const { executions: results, roundsRun } = ...`; optionally `expect(roundsRun).toBe(1)`. |
| `src/fleet/index.test.ts:381` | fake coordinator `executeRounds` stub (sc-3-5) | MEDIUM | The fake returns `Promise<ChildExecution[]>` and `[]`; it is NEVER awaited as a value in the no-blackboard path (executeRoundsCalled stays 0), so it does not strictly break — BUT update its return type to `Promise<{ executions: ChildExecution[]; roundsRun: number }>` and `return { executions: [], roundsRun: 0 };` to keep the type honest and avoid a strict-mode mismatch if structural typing is enforced. Verify the test still asserts `executeRoundsCalled === 0`. |

`PortfolioReport.rounds?` is OPTIONAL → adding it breaks no structural consumer (`index.ts:32`, `synthesis.ts:10`). `SynthesisBundle.rounds` already `number` → no change.

### Existing Tests That Must Still Pass
- `src/fleet/coordinator.test.ts` — sc-3-3 (line 199, full-run runner-count), sc-3-4 (line 249, early-stop), sc-3-5 (line 302, no-blackboard execute), sc-3-7 (line 337, failing child never-throws). All four executeRounds call-sites change shape; the existing `runCalls`/`scaffoldCalls` length assertions MUST stay green (round loop behavior unchanged).
- `src/fleet/reporter.test.ts` — all build/write tests (lines 16-108): byte-identical builds must still produce the same shape; the no-arg `build()` calls (lines 20,37,46,65,77,91,102) must continue to omit `rounds`.
- `src/fleet/index.test.ts` — sc-4-6 (line 86 counts), credential fail-fast (line 197), ToolRoleGuard (line 268), no-blackboard single-pass (line 349, `executeRoundsCalled===0`), blackboard path (line 433), sc-4-4 synthesis written (line 526), sc-4-6 byte-identical (line 607). The blackboard sc-4-4 test currently only asserts `typeof syn.rounds === "number"` — it stays green; you EXTEND it for the real count.

### Features That Could Be Affected
- **fleet synthesis bundle (`fleet-synthesis.json`)** — shares `collect` + `roundsRun`. Verify `syn.rounds` is now the REAL count (2 on early-stop), not 3.
- **fleet report (`fleet-report.json`)** — shares `reporter.build`. Verify blackboard run has `rounds`, no-blackboard run does NOT.
- **`fleet expand --yes` / `expand-deep --yes`** (index.ts:318, 448) — both call `runFleet` and only read `report.total/completed/failed/other` for the Fleet Summary; the new optional `rounds` does not affect them. No change needed.

### Recommended Regression Checks
After implementation, the Generator MUST run:
1. `npm run build` — zero errors (sc-1-1).
2. `npm run typecheck` — zero errors (sc-1-1); confirms the destructure + optional field type-check under strict.
3. `npx vitest run src/fleet` — all fleet tests pass (coordinator/index/reporter/synthesis).
4. `npm test` (or `npx vitest run`) — FULL suite; ONLY the 6 known cockpit-integration MCP failures may fail (sc-1-2). Nothing else.
5. `npm run lint` — zero errors (sc-1-7; `consistent-type-imports`).
6. `git status --porcelain src/` — ONLY `coordinator.ts`, `index.ts`, `reporter.ts` + their 3 test files modified; `synthesis.ts` UNCHANGED (evaluator greps for this).
7. Confirm the `bober:` ceiling comment is GONE from index.ts: `grep -n "bober:" src/fleet/index.ts` returns nothing.

---

## 8. Implementation Sequence

(types → core → integration → tests; the contract's STEP order is dependency-correct.)

1. **src/fleet/reporter.ts** — add `rounds?: number` to `PortfolioReport`; change `build` to `(outcomes, opts?: { rounds?: number })` with the guarded spread.
   - Verify: `npm run typecheck` clean; a no-arg `build` still returns no `rounds` key (mentally trace the spread → `{}`).
2. **src/fleet/coordinator.ts** — change `executeRounds` return type; add `let roundsRun = 0;` before the loop, `roundsRun = r;` as the first for-body statement, and `return { executions: lastExecutions, roundsRun };`. Touch nothing else in the method.
   - Verify: `npm run typecheck` — the new shape compiles; early-stop condition / scaffold-once / runChildRound untouched.
3. **src/fleet/index.ts** — destructure the `executeRounds` call into the outer `executions`/`roundsRun`; delete the `bober:` comment (181-183) + hardcoded line (184); change report build to `reporter.build(outcomes, bb ? { rounds: roundsRun } : undefined)`; leave `collect(bb, report, roundsRun)`.
   - Verify: `npm run build` + `npm run typecheck` clean; `grep "bober:" src/fleet/index.ts` empty.
4. **src/fleet/coordinator.test.ts** — update the 3 `executeRounds` call-sites (239, 292, 367) to destructure `.executions`; add `roundsRun === maxRounds` to the full-run (sc-3-3) test and `roundsRun === 2` to the early-stop (sc-3-4) test; assert `executions` is still the final round's array.
   - Verify: `npx vitest run src/fleet/coordinator.test.ts` green.
5. **src/fleet/reporter.test.ts** — add `it` blocks: `build([])` → `expect('rounds' in report).toBe(false)`; `build([], { rounds: 2 }).rounds === 2`.
   - Verify: `npx vitest run src/fleet/reporter.test.ts` green.
6. **src/fleet/index.test.ts** — fix the fake-coordinator `executeRounds` stub return type/value (line 381); extend/add a blackboard early-stop runFleet test (runner publishes only round 1, maxRounds=3) asserting `syn.rounds === 2` AND `rep.rounds === 2`; extend the no-blackboard test (line 607) to assert `'rounds' in rep === false`.
   - Verify: `npx vitest run src/fleet/index.test.ts` green.
7. **Run full verification** — `npm run build`, `npm run typecheck`, `npx vitest run`, `npm run lint`. Confirm only the 6 known cockpit failures, and `git status` shows only the 6 expected files.

---

## 9. Pitfalls & Warnings

- **INVARIANT 1 — byte-identical no-blackboard report.** The ONLY thing standing between you and a regression here is `bb ? { rounds: roundsRun } : undefined` at the build call AND the guarded spread in `build`. If you ever pass `{ rounds: undefined }` or always pass `{ rounds: roundsRun }`, the no-blackboard report grows a `rounds` key (or a `rounds: undefined` that serializes away but changes the in-memory shape) → sc-1-6 fails. Use `... !== undefined ? {...} : {}` exactly. A no-blackboard run also must write NO `fleet-synthesis.json` (the `if (bb)` guard at index.ts:204 already enforces this — do not touch it).
- **INVARIANT 2 — never-throw / exit-0.** `runChildRound` (coordinator.ts:91-131) and `runChild` (134-155) wrap EVERYTHING in try/catch and return error-as-data. The round loop and `runFleet`'s `try/finally` (index.ts:170-213) preserve exit-0 on per-child failure. Do NOT add a throw, do NOT move the `roundsRun = r` outside the loop, do NOT alter the `finally { if (bb) bb.close(); }`.
- **`roundsRun = r` MUST be the FIRST statement in the for-body**, not after the `mapBounded` and not after the early-stop check. The `break` fires AFTER the body runs (`if (r > 1 && count === prevCount) break;`), and on the break the loop has executed round `r` — so `roundsRun` must already equal `r`. Putting it last would still work for break-after-body, but putting it FIRST is the contract's explicit instruction and is unambiguously correct for all paths.
- **Do NOT redeclare `executions`/`roundsRun` in the blackboard branch.** They are outer-scope `let` (index.ts:166, 168). A `const { executions, roundsRun } = ...` inside the `if (dbPath)` block would create new bindings that never reach `collect`/`build`. Use the rename-then-assign pattern.
- **Keep `let roundsRun = 0;` at index.ts:168.** The contract says it stays. It is the no-blackboard default; on a no-blackboard run `roundsRun` is never read (build gets `undefined`, collect is never called), but removing the declaration breaks the outer-scope assignment in the blackboard branch.
- **synthesis.ts is a non-goal.** Do not "improve" `collect`. The evaluator greps that synthesis.ts is unchanged (or trivially so) with no network import. Leave it byte-for-byte identical.
- **The fake coordinator in index.test.ts (lines 32-44, `makeFakeCoordinator`) only defines `execute`, not `executeRounds`.** Tests that use it are no-blackboard (sc-4-6 byte-identical), so they never call `executeRounds` — that's fine. The SEPARATE inline fake at line 381 DOES define `executeRounds` and needs its return type/value updated to the new shape.
- **`mkdtemp` cleanup:** every new test must `mkdtemp` in `beforeEach` and `rm(..., { recursive: true, force: true })` in `afterEach`, and save/restore `DEEPSEEK_API_KEY` (see the existing blocks). The runFleet credential fail-fast (validateManifestCredentials) requires `DEEPSEEK_API_KEY` set for blackboard tests.
- **Commit message:** `bober(sprint-1): real executed round count in fleet synthesis + report` (conventional-commit gate).
