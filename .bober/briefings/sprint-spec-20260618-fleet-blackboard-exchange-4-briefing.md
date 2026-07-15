# Sprint Briefing: SynthesisStep + fleet-synthesis.json artifact

**Contract:** sprint-spec-20260618-fleet-blackboard-exchange-4
**Generated:** 2026-06-18T20:00:00Z

> FINAL sprint of Phase B. PURE data-assembly step. NO LLM, NO network. Two load-bearing
> invariants dominate everything: (1) **the bb.close() ordering trap** — collect() calls
> bb.readAll(), so the blackboard MUST still be open when collect runs; (2) the
> **byte-identical no-blackboard invariant** — a no-blackboard run must write NOTHING extra.

---

## 1. Target Files

### src/fleet/synthesis.ts (create)

**Directory pattern:** `src/fleet/*.ts` — kebab/camel single-purpose modules, unicode box section
headers (`// ── Name ──`), ESM `.js` imports, `import type` for type-only imports.
**Most similar existing file:** `src/fleet/reporter.ts` (a small pure-ish data module with a
`Types` section then logic). Synthesis is even simpler — one interface + one pure function.

**Structure template (follow this skeleton):**
```ts
// ── fleet/synthesis.ts ────────────────────────────────────────────────
//
// SynthesisStep (CP3): PURE data assembly. After the rounds complete,
// bundle the final-round child results + ALL blackboard findings + the
// round count for the head/dynamic-workflow to synthesize.
//
// NO LLM call. NO network. NO provider/client construction.

import type { SharedBlackboard } from "./shared-blackboard.js";
import type { PortfolioReport } from "./reporter.js";
import type { FactRecord } from "../state/facts.js";

// ── Types ─────────────────────────────────────────────────────────────

export interface SynthesisBundle {
  rounds: number;
  childResults: PortfolioReport;   // the same report the reporter built
  findings: FactRecord[];          // blackboard.readAll() (all active 'finding' facts)
}

// ── collect ───────────────────────────────────────────────────────────

/**
 * Assemble a SynthesisBundle from the final-round child results, the round
 * count, and (if a blackboard was used) all of its findings.
 * PURE: no LLM, no network, no IO — just shapes existing data into JSON.
 * When blackboard is null, findings is [].
 */
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

**Note on `childResults` type:** The contract / generatorNotes leave it as "PortfolioReport or the
outcomes array". RECOMMENDED: use `PortfolioReport` (the exact object `reporter.build(outcomes)`
returns at `src/fleet/index.ts:165`). It is already in hand in runFleet as `report`, it carries the
round-agnostic tallies + `children: ChildOutcome[]`, and the contract sc-4-4 says "final-round
childResults". Passing `report` keeps it a single typed object.

---

### src/fleet/index.ts (modify) — the runFleet blackboard branch

**EXACT current sequence after Sprint 3 (lines 134-168). This is what you edit:**
```ts
  // ── Blackboard-aware execution branch ────────────────────────────
  const dbPath = resolveBlackboardPath(effectiveManifest);          // :135
  let executions: ChildExecution[];                                  // :136

  if (dbPath) {
    await ensureDir(dirname(dbPath));                                // :141
    const bb = await SharedBlackboard.open({                         // :142
      dbPath,
      namespace: effectiveManifest.blackboard!.namespace,
      maxRounds: effectiveManifest.blackboard!.maxRounds,
    });
    try {                                                            // :147
      executions = await coordinator.executeRounds(effectiveManifest, bb, {
        maxRounds: effectiveManifest.blackboard!.maxRounds,
        dbPath,
      });
    } finally {                                                      // :152
      bb.close();                                                    // :153  <-- MOVE THIS
    }
  } else {
    executions = await coordinator.execute(effectiveManifest);       // :157
  }

  const outcomes: ChildOutcome[] = await Promise.all(                // :160
    executions.map((e) => aggregator.aggregate(e)),
  );

  // 5. Build + write report
  const report = reporter.build(outcomes);                          // :165
  await reporter.write(effectiveManifest.rootDir, report);          // :166

  return report;                                                     // :168
```

**THE EDIT — TWO coupled changes (the close-ordering trap):**

The problem: `collect(bb, ...)` calls `bb.readAll()`, but `bb` is closed in the `finally` at
**line 153 BEFORE** the report build/write at 165-166 even runs. You must keep `bb` reachable and
OPEN until AFTER collect. Recommended shape:

1. **Hoist `bb` so it survives the if-block** AND **do NOT close it in the round `finally`.** Declare
   the handle in the outer scope and capture the rounds count. Then wrap the whole region in a single
   try/finally so close still happens on any error path.

```ts
  const dbPath = resolveBlackboardPath(effectiveManifest);
  let executions: ChildExecution[];
  let bb: SharedBlackboard | null = null;          // hoisted handle
  let roundsRun = 0;                               // capture the round count

  try {
    if (dbPath) {
      await ensureDir(dirname(dbPath));
      bb = await SharedBlackboard.open({
        dbPath,
        namespace: effectiveManifest.blackboard!.namespace,
        maxRounds: effectiveManifest.blackboard!.maxRounds,
      });
      roundsRun = effectiveManifest.blackboard!.maxRounds;   // see "round count" note below
      executions = await coordinator.executeRounds(effectiveManifest, bb, {
        maxRounds: effectiveManifest.blackboard!.maxRounds,
        dbPath,
      });
    } else {
      executions = await coordinator.execute(effectiveManifest);
    }

    const outcomes: ChildOutcome[] = await Promise.all(
      executions.map((e) => aggregator.aggregate(e)),
    );

    // 5. Build + write report (UNCHANGED — always written, shape unchanged)
    const report = reporter.build(outcomes);
    await reporter.write(effectiveManifest.rootDir, report);

    // 6. Synthesis (ADDITIVE — ONLY on a blackboard run; AFTER the report write)
    if (bb) {
      const bundle = collect(bb, report, roundsRun);   // bb STILL OPEN here — readAll() works
      await writeSynthesis(effectiveManifest.rootDir, bundle);
    }

    return report;
  } finally {
    if (bb) bb.close();   // close moved here — runs after synthesis, and on any error
  }
```

- The original `finally { bb.close(); }` at lines 152-154 is REMOVED; close moves to the OUTER
  finally that wraps report+synthesis. This preserves the Sprint-3 guarantee (close on any error)
  while keeping `bb` open through `collect`.
- The `else` branch (line 157) is UNCHANGED. The no-blackboard path runs `coordinator.execute`,
  builds+writes the report, and (because `bb` is null) the `if (bb)` synthesis block is skipped →
  **byte-identical**.
- `report` is the same object as before; `reporter.write` call at line 166 is UNCHANGED.

**Round count — `executeRounds` does NOT return the rounds run.** It returns only the final
`ChildExecution[]` (`src/fleet/coordinator.ts:53-82` — `Returns the FINAL round's ChildExecution[]`,
and it can early-stop before maxRounds at `coordinator.ts:77`). So the precise number of rounds
actually executed is NOT exposed. Pragmatic options for `roundsRun`:
- (Simplest, contract-acceptable) use `effectiveManifest.blackboard!.maxRounds` — the configured cap.
  The contract sc-4-4 just says "the round count"; the cap is a defensible value and is what the
  rounds loop was bounded by.
- Do NOT change `executeRounds` to return a count — non-goal #5 forbids touching the Sprint-3 rounds
  loop. Keep the round number derived in runFleet from the manifest cap.

**`writeSynthesis` atomic helper** — add a tiny local async helper in index.ts (or inline) mirroring
`reporter.write` exactly (see §3). Suggested:
```ts
import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

async function writeSynthesis(rootDir: string, bundle: SynthesisBundle): Promise<string> {
  const dir = resolve(join(rootDir, ".bober"));
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, "fleet-synthesis.json");
  const rnd = randomBytes(4).toString("hex");
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${rnd}.tmp`;
  await writeFile(tmp, JSON.stringify(bundle, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  await rename(tmp, filePath);
  return filePath;
}
```
`resolve`, `join` are already imported at `index.ts:12`. You must ADD `mkdir, rename, writeFile`
from `node:fs/promises` and `randomBytes` from `node:crypto`, plus `import { collect } from
"./synthesis.js"` and `import type { SynthesisBundle } from "./synthesis.js"`.

**Imports index.ts currently uses (relevant):**
- `join, resolve, dirname` from `node:path` (`index.ts:12`)
- `SharedBlackboard` from `./shared-blackboard.js` (`index.ts:20`)
- `ensureDir` from `../state/helpers.js` (`index.ts:26`)
- `PortfolioReport` (value re-export + type) from `./reporter.js` (`index.ts:19,29,32`)
- `ChildOutcome, ChildExecution` (type) from `./types.js` (`index.ts:28`)

**Imported by:** `src/fleet/index.test.ts` (`runFleet, registerFleetCommand`), the CLI registration
chain, and `runFleetExpand`/`runFleetExpandDeep` (call `runFleet` internally, same file).

**Test file:** `src/fleet/index.test.ts` (exists — see §6).

---

## 2. Patterns to Follow

### Pure data module + unicode section headers
**Source:** `src/fleet/reporter.ts`, lines 1-24
```ts
// ── reporter.ts ───────────────────────────────────────────────────────
import type { ChildOutcome } from "./types.js";

// ── Types ─────────────────────────────────────────────────────────────
export interface PortfolioReport {
  total: number;
  ...
  children: ChildOutcome[];
}
```
**Rule:** Box-drawing section headers, `import type` for type-only, ESM `.js` extensions, exported
interface in a `// ── Types ──` section. synthesis.ts follows this exactly.

### Atomic tmp+rename write (THE canonical pattern to reuse)
**Source:** `src/fleet/reporter.ts`, lines 76-91
```ts
async write(rootDir: string, report: PortfolioReport): Promise<string> {
  const dir = resolve(join(rootDir, ".bober"));
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, "fleet-report.json");
  const rnd = randomBytes(4).toString("hex");
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${rnd}.tmp`;
  await writeFile(tmp, JSON.stringify(report, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  await rename(tmp, filePath);
  return filePath;
}
```
**Rule:** Mirror this byte-for-byte for fleet-synthesis.json — `randomBytes(4).toString("hex")` tmp
suffix with pid+Date.now(), `mkdir recursive`, `JSON.stringify(x, null, 2) + "\n"`, `mode: 0o600`,
then `rename`. (manifest-write.ts `src/fleet/manifest-write.ts:114-118` uses the SAME tmp+rename
shape but WITHOUT the trailing `\n` and WITHOUT mode 0o600 — prefer the reporter.ts variant since
fleet-synthesis.json sits beside fleet-report.json.)

### Round-results return shape
**Source:** `src/fleet/coordinator.ts`, lines 55-82
```ts
async executeRounds(manifest, blackboard, opts: { maxRounds; dbPath }): Promise<ChildExecution[]> {
  ...
  return lastExecutions;   // FINAL round only; may early-stop before maxRounds (line 77)
}
```
**Rule:** `executeRounds` returns the FINAL round's executions; it does NOT return a round count.
Derive `roundsRun` from the manifest cap (`effectiveManifest.blackboard!.maxRounds`); do NOT modify
the coordinator (non-goal).

### readAll() — the findings source
**Source:** `src/fleet/shared-blackboard.ts`, lines 102-105
```ts
/** Return ALL active 'finding' facts in this namespace. */
readAll(): FactRecord[] {
  return this.store.getActiveFacts(this.namespace, undefined, "finding");
}
```
**Rule:** `collect`'s findings is EXACTLY `blackboard.readAll()` — no transform. Returns
`FactRecord[]` (synchronous; no await). Must be called while the blackboard is OPEN.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `PortfolioReporter.write` | `src/fleet/reporter.ts:76` | `(rootDir, report) => Promise<string>` | Atomic tmp+rename write of fleet-report.json — the canonical write pattern to mirror |
| `PortfolioReporter.build` | `src/fleet/reporter.ts:39` | `(outcomes: ChildOutcome[]) => PortfolioReport` | Tallies outcomes; called at index.ts:165 to produce `report` (= childResults) |
| `SharedBlackboard.readAll` | `src/fleet/shared-blackboard.ts:103` | `() => FactRecord[]` | All active 'finding' facts in namespace — the findings source |
| `SharedBlackboard.publish` | `src/fleet/shared-blackboard.ts:74` | `(finding, now) => FactRecord` | Seed findings in tests (childFolder/round/payload/confidence?) |
| `SharedBlackboard.open` | `src/fleet/shared-blackboard.ts:54` | `(opts) => Promise<SharedBlackboard>` | Open WAL facts.db; use in collect test to seed a real bb |
| `SharedBlackboard.close` | `src/fleet/shared-blackboard.ts:108` | `() => void` | Closes underlying db; MUST run AFTER collect (the ordering trap) |
| `ensureDir` | `src/state/helpers.ts` | `(dir) => Promise<void>` | Already used at index.ts:141 for the db dir |
| `resolveBlackboardPath` | `src/fleet/index.ts:43` | `(manifest) => string \| undefined` | Already the gate for "was a blackboard used" (dbPath truthy) |
| `factId` | `src/state/facts.ts:58` | `(scope,subject,predicate,value,tCreated) => string` | Deterministic fact id (not needed by synthesis; informational) |
| `writeManifestWithProvenance` | `src/fleet/manifest-write.ts:68` | `(args) => Promise<void>` | Alt tmp+rename example (NO trailing \n / mode); reference only |

`randomBytes` (`node:crypto`), `mkdir/rename/writeFile` (`node:fs/promises`) — Node builtins, not
custom utils. NO custom JSON-write helper exists that you should reach for instead — the reporter's
inline pattern IS the convention.

---

## 4. Prior Sprint Output

### Sprint 1 (e1d4b00): SharedBlackboard.readAll()
**File:** `src/fleet/shared-blackboard.ts` — exports `SharedBlackboard` with `readAll(): FactRecord[]`
(`:103`), `open` (`:54`), `publish` (`:74`), `close` (`:108`), `BLACKBOARD_MAX_ROUNDS=3` (`:9`).
**Connection:** `collect` calls `blackboard.readAll()` to populate `findings`.

### Sprint 2 (2784f71): resolveBlackboardPath
**File:** `src/fleet/index.ts:43` — `resolveBlackboardPath(manifest): string | undefined`.
**Connection:** Already wired at `index.ts:135` as `dbPath`. A truthy `dbPath` (equivalently, a
non-null `bb`) is the "blackboard was used" gate for whether to write fleet-synthesis.json.

### Sprint 3 (2e16f19): runFleet rounds branch
**File:** `src/fleet/index.ts:134-158` — the `if (dbPath)` block: `ensureDir` →
`SharedBlackboard.open` → `try { executeRounds(...) } finally { bb.close() }`; else
`coordinator.execute`. Report built+written at `:165-166`.
**Connection:** Sprint 4 inserts the synthesis collect+write AFTER `reporter.write` (`:166`) and
MOVES `bb.close()` (currently `:153`) out of the inner rounds-finally to an OUTER finally that wraps
the report+synthesis region, so `bb` is still open when `collect` runs `readAll()`.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`) — HARD RULES that gate this sprint
- **ESM everywhere; `.js` import extensions** (line 27). synthesis.ts imports must end in `.js`.
- **`import type { ... }`** — `consistent-type-imports` is enforced (lines 19, 35). `SharedBlackboard`,
  `PortfolioReport`, `FactRecord`, `SynthesisBundle` are type-only imports.
- **No synchronous filesystem ops** (line 42). Use `node:fs/promises` only — no `*Sync`.
- **No SDK/provider imports outside adapters** (lines 28, 41). synthesis.ts must import ZERO
  provider/network code (sc-4-5). No `@anthropic-ai/sdk`, `openai`, `fetch`, `node:http`, `node:net`.
- **Section comments** with unicode box headers (line 32).
- **Tests collocated** `*.test.ts` next to source; **no fs mocks** — use real temp dirs + cleanup
  (lines 20, 44).
- **Prefix unused params with `_`** (line 36).

### Architecture
SynthesisStep is component CP3 of the Phase B arch (referenced in generatorNotes/evaluatorNotes):
"PURE data assembly, NOT an LLM call." The head / dynamic-workflow consumes fleet-synthesis.json
later; this sprint only produces the artifact.

---

## 6. Testing Patterns

### Unit test pattern (collocated, real temp dirs, Vitest)
**Source:** `src/fleet/index.test.ts:66-136` (runFleet DI harness) + `src/fleet/shared-blackboard.test.ts:1-114`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-fleet-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });
```
**Runner:** vitest. **Assertion:** `expect(...).toBe/toEqual/toThrow`. **Mock approach:** hand-rolled
DI fakes cast `as unknown as FleetCoordinator` (see `makeFakeCoordinator` index.test.ts:32-44), NOT
`vi.mock`. **File naming:** `synthesis.test.ts`, additions in `index.test.ts`. **Location:** collocated.

**DI harness to reuse for the runFleet tests** (index.test.ts:17-62):
```ts
function fakeExecution(folder) { return { folder, scaffold: {...}, spawn: {...} }; }
function fakeOutcome(folder, status) { return { folder, status, source: "exit-code" }; }
function makeFakeCoordinator(executions) { /* records calls; execute() returns executions */ }
function makeFakeAggregator(outcomes) { /* aggregate() returns outcomes[idx++] */ }
async function writeManifest(dir, manifest) { /* writes fleet.json, returns path */ }
// beforeEach sets process.env["DEEPSEEK_API_KEY"] = "fake-key-for-test" so cred check passes
```

**Seeding a real blackboard for the collect test** (pattern from shared-blackboard.test.ts:76-97):
```ts
const NOW = "2026-06-18T00:00:00.000Z";
const bb = await SharedBlackboard.open({ dbPath: join(tmpDir, "bb.db"), namespace: "ns", maxRounds: 3 });
bb.publish({ childFolder: "child-a", round: 1, payload: "analysis done" }, NOW);
const found = bb.readAll();           // FactRecord[]
const bundle = collect(bb, fakeReport, 2);
bb.close();
expect(bundle.findings).toEqual(found);
```

### The 4 required test scenarios

**A. `synthesis.test.ts` — collect with a real seeded blackboard (sc-4-3):**
open a tmp-db SharedBlackboard, publish ≥1 finding, build a fake `PortfolioReport`, call
`collect(bb, report, 2)` → assert `bundle.rounds === 2`, `bundle.childResults === report`,
`bundle.findings` deep-equals `bb.readAll()` (non-empty). Close bb AFTER collect.

**B. `synthesis.test.ts` — collect(null, ...) (sc-4-3):**
`collect(null, report, 1)` → `bundle.findings` is `[]`, `bundle.childResults === report`,
`bundle.rounds === 1`. (Optional sc-4-5 belt-and-suspenders: a test/assert that synthesis.ts source
contains none of `@anthropic-ai/sdk`/`openai`/`fetch`/`node:http`/`node:net` — read the source file
and assert no match; evaluatorNotes greps for these.)

**C. `index.test.ts` — synthesis file written on a blackboard run, report still present (sc-4-4):**
Add a describe block mirroring `runFleet blackboard path (sc-3-6)` (index.test.ts:414-503). Write a
manifest WITH `blackboard: { namespace, maxRounds: 2 }`, run with the `FleetCoordinator({ scaffolder,
runner })` real-coordinator DI fakes (so executeRounds actually opens/uses the bb), then:
```ts
const syn = JSON.parse(await readFile(join(tmpDir, ".bober", "fleet-synthesis.json"), "utf-8"));
expect(syn).toHaveProperty("rounds");
expect(syn).toHaveProperty("childResults");
expect(Array.isArray(syn.findings)).toBe(true);
// report STILL written + shape unchanged:
const rep = JSON.parse(await readFile(join(tmpDir, ".bober", "fleet-report.json"), "utf-8"));
expect(rep).toMatchObject({ total: 1, completed: 1 });
```

**D. `index.test.ts` — synthesis file ABSENT on a no-blackboard run (sc-4-6, byte-identical):**
Mirror `runFleet no-blackboard single-pass (sc-3-5)` (index.test.ts:330-409). Manifest with NO
`blackboard` field, run via `makeFakeCoordinator`, then assert fleet-synthesis.json does NOT exist:
```ts
let exists = false;
try { await access(join(tmpDir, ".bober", "fleet-synthesis.json")); exists = true; } catch {}
expect(exists).toBe(false);
// fleet-report.json IS written (unchanged):
const rep = JSON.parse(await readFile(join(tmpDir, ".bober", "fleet-report.json"), "utf-8"));
expect(rep.total).toBe(1);
```

### FactRecord shape (the `findings[]` element type)
**Source:** `src/state/facts.ts:37-49`
```ts
export interface FactRecord {
  id: string; scope: string; subject: string; predicate: string; value: string;
  confidence: number; sourceRunId: string | null;
  tValid: string; tInvalid: string | null; tCreated: string; tInvalidated: string | null;
}
```

### PortfolioReport shape (the `childResults` type)
**Source:** `src/fleet/reporter.ts:17-24`
```ts
export interface PortfolioReport {
  total: number; completed: number; failed: number; other: number;
  generatedAt: string; children: ChildOutcome[];
}
```

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/fleet/index.test.ts` | `runFleet` (index.ts) | high | Existing 5 describe blocks (sc-3-5, sc-3-6, sc-4-6, cred, guard) must pass UNCHANGED. The close-move must not break the round-finally error guarantee or change the no-bb path. |
| `src/fleet/index.ts` (runFleetExpand/Deep) | `runFleet` (same file) | medium | They call `runFleet(outPath)` internally (index.ts:275,405). The synthesis write only fires when the produced manifest has a blackboard — expand manifests have none, so no change. |
| `src/cli` fleet registration | `registerFleetCommand` | low | Signature unchanged; only runFleet internals change. |
| `src/fleet/coordinator.ts` | — | none | NOT modified (non-goal #5). `executeRounds` return shape unchanged. |
| `src/fleet/shared-blackboard.ts` | — | none | NOT modified (non-goal). |
| `src/fleet/reporter.ts` | — | none | NOT modified; report shape MUST stay identical (sc-4-4/sc-4-7). |

### Existing Tests That Must Still Pass
- `src/fleet/index.test.ts` — `runFleet end-to-end (sc-4-6)` (lines 66-176): report counts + write
  to `.bober/fleet-report.json`. Verify the report write is byte-identical (you did not touch
  `reporter.write` or its call).
- `src/fleet/index.test.ts` — `runFleet no-blackboard single-pass (sc-3-5)` (330-409): asserts no
  facts.db dir is created on a no-blackboard run. Your `if (bb)` synthesis gate must not change this.
- `src/fleet/index.test.ts` — `runFleet blackboard path (sc-3-6)` (414-503): the real-coordinator DI
  path; your close-move must keep db-dir creation + scaffold dbPath injection working.
- `src/fleet/index.test.ts` — credential (178-244) + ToolRoleGuard (246-302) fail-fast: unaffected.
- `src/fleet/shared-blackboard.test.ts` — readAll/publish/WAL tests: unaffected (you don't touch it).
- `src/fleet/reporter.test.ts` (if present) — report shape: unaffected.

### Features That Could Be Affected
- **fleet expand / expand-deep** — share `runFleet`. Their generated manifests carry no `blackboard`
  field, so the synthesis block is skipped → byte-identical. Verify expand tests still pass.
- **Phase A fleet run** (no blackboard) — the byte-identical invariant (sc-4-6). The ONLY observable
  change on a no-blackboard run must be none.

### Recommended Regression Checks (run after implementation)
1. `npm run build` (tsc) — zero type errors (sc-4-1).
2. `npx vitest run src/fleet` — all fleet tests green (the 4 new + all prior unchanged) (sc-4-2/3/4/6).
3. `npx vitest run` — FULL suite; ONLY the 6 known cockpit-integration MCP failures may fail (sc-4-2).
4. `npm run lint` — `consistent-type-imports`, no unused vars (sc-4-7).
5. Grep `src/fleet/synthesis.ts` for `@anthropic-ai/sdk|openai|fetch|node:http|node:net` → zero hits (sc-4-5).
6. Confirm `git diff` of the no-blackboard path shows the report write is untouched.

---

## 8. Implementation Sequence

1. **src/fleet/synthesis.ts** (create) — `SynthesisBundle` interface + pure `collect`. Type-only
   imports of `SharedBlackboard`, `PortfolioReport`, `FactRecord` (all `.js`, `import type`).
   - Verify: `npm run build` compiles; no provider/network import (grep).
2. **src/fleet/synthesis.test.ts** (create) — scenarios A (seeded bb) + B (null) + the no-network
   source assertion. Uses `SharedBlackboard.open/publish/readAll/close` + a fake `PortfolioReport`.
   - Verify: `npx vitest run src/fleet/synthesis.test.ts` green.
3. **src/fleet/index.ts** (modify) — add imports (`collect` value + `SynthesisBundle` type from
   `./synthesis.js`; `mkdir, rename, writeFile` from `node:fs/promises`; `randomBytes` from
   `node:crypto`). Add `writeSynthesis` helper. Hoist `bb`/`roundsRun`, wrap report+synthesis in an
   outer try/finally, MOVE `bb.close()` to that outer finally, insert `if (bb) { collect + write }`
   AFTER `reporter.write`.
   - Verify: build green; existing index.test.ts blocks (sc-3-5, sc-3-6, sc-4-6, cred, guard) pass.
4. **src/fleet/index.test.ts** (modify) — add scenario C (synthesis written + report present on bb
   run) and scenario D (synthesis absent on no-bb run).
   - Verify: `npx vitest run src/fleet` fully green.
5. **Run full verification** — `npm run build` && `npx vitest run` (only 6 cockpit MCP may fail) &&
   `npm run lint`.

---

## 9. Pitfalls & Warnings

- **CLOSE-ORDERING TRAP (highest risk).** Sprint 3 closes `bb` in a `finally` at `index.ts:153`,
  which runs BEFORE the report build/write (165-166) and before synthesis. If you leave it there,
  `collect(bb, ...)` will call `readAll()` on a CLOSED db → runtime error. You MUST move `bb.close()`
  to run AFTER collect, while still guaranteeing close on any error (use a single outer try/finally).
- **BYTE-IDENTICAL NO-BLACKBOARD INVARIANT (sc-4-6).** The synthesis write MUST be gated on `bb`
  being non-null (equivalently `dbPath` truthy). A no-blackboard run must create NO fleet-synthesis.json
  and write nothing extra. The existing sc-3-5 / sc-4-6 tests assert this — do not regress them.
- **Do NOT change reporter.write or PortfolioReport** (sc-4-4/sc-4-7). fleet-report.json is always
  written, shape unchanged, and synthesis is written AFTER it.
- **`executeRounds` returns NO round count** (`coordinator.ts:53-82`) and may early-stop (`:77`).
  Do not modify the coordinator (non-goal #5). Derive `roundsRun` from
  `effectiveManifest.blackboard!.maxRounds`.
- **No LLM/network/provider import in synthesis.ts** (sc-4-5 + principles lines 28/41). `collect` is
  pure data shaping — no client construction, no `fetch`, no SDK.
- **No synchronous fs** (principle line 42). Use `node:fs/promises` for the atomic write; mirror
  reporter.write's `mkdir → writeFile(tmp) → rename`.
- **ESM `.js` extensions + `import type`** (principles 27/35). `import { collect } from "./synthesis.js"`
  (value) and `import type { SynthesisBundle } from "./synthesis.js"` (type). ESLint will error
  otherwise.
- **`readAll()` is synchronous** (`shared-blackboard.ts:103`) — do NOT `await` it inside collect.
- **`children`/findings are object references, not deep copies.** `JSON.stringify(bundle, null, 2)`
  serializes them fine; no need to clone. Trailing `\n` + `mode: 0o600` to match reporter.write.
