# Sprint Briefing: Deterministic slot-fill engine + dry-run plan CLI

**Contract:** sprint-spec-20260628-calendar-planner-1
**Generated:** 2026-06-29

This sprint builds a NEW `src/calendar/` module: a PURE synchronous slot-fill engine (`slotter.ts`), a LOCAL Finding consume-type (`types.ts`), a JSON-file finding source (`finding-source.ts`), and a `bober calendar plan --dry-run` CLI (`cli/commands/calendar.ts` + registration). Nothing is written to any calendar. No LLM/async/fs/network in the slotter.

---

## 1. Target Files

### src/calendar/types.ts (create)

No existing file. Defines all data shapes. **Define a LOCAL `Finding` type — do NOT import from `src/hub`** (the contract assumptions line 61 and generatorNotes line 72 say this is a forward dependency; hub is a sibling spec). The field names MUST match the shipped hub schema below.

**Authoritative field list — copy field names + types EXACTLY from `src/hub/finding.ts:10-25`:**
```ts
// src/hub/finding.ts:10-25 (the shipped hub Zod schema — mirror these as a plain TS interface)
export const FindingSchema = z.object({
  id: z.string().min(1),
  domain: z.string().min(1),
  title: z.string().min(1),
  kind: z.enum(["action", "watch", "risk", "question"]),
  urgency: z.number().int().min(1).max(5),
  severity: z.number().int().min(1).max(5),
  evidence: z.array(z.string()),
  surfacedAt: z.string().datetime(),
  dueBy: z.string().datetime().optional(),
  tags: z.array(z.string()),
  estDurationMin: z.number().int().optional(),
  calendarSafeTitle: z.string().optional(),
  status: z.enum(["open", "in-progress", "snoozed", "done", "dropped"]),
  promotesTo: z.string().optional(),
});
```
The generator MAY define its own local Zod schema (for `finding-source.ts` validation) OR a plain `interface Finding`. A local Zod schema is recommended because `finding-source.ts` must validate untrusted JSON (see §6 task.ts pattern). Evidence the planner wants these exact fields: research §3a lines 121-126, contract evaluatorNotes line 73 ("dueBy, estDurationMin, calendarSafeTitle present").

**Other types required by generatorNotes line 72:**
- `BusyInterval { startIso: string; endIso: string }`
- `FreeInterval { startIso: string; endIso: string }`
- `SlotConstraints { windowStartIso: string; windowEndIso: string; workingHours?: ...; timezone?: string }`
- `PlanItem { findingId: string; title: string; startIso: string; endIso: string }`
- `UnscheduledReason` — a CLOSED string-literal union (see §2 exhaustive-switch pattern). Per sc-1-3 it must include at least `"does-not-fit"` and `"no-free-slot-before-dueBy"`.
- `ProposedPlan { scheduled: PlanItem[]; unscheduled: { findingId: string; reason: UnscheduledReason }[] }`

**Imports this file uses:** `import { z } from "zod";` only (if using Zod). No fs/async.

---

### src/calendar/slotter.ts (create)  — THE PURITY-CRITICAL FILE

No existing file. **Mirror `src/medical/numerics.ts` EXACTLY for the purity boundary.** Pure synchronous; NO `async`/`await`, NO `node:fs`, NO provider/LLM import (sc-1-5 scans this file). Identical input => deep-equal output (sc-1-4 — no `Date.now`/`Math.random`).

**Structure template (modeled on numerics.ts):**
```ts
/**
 * CalendarSlotter — deterministic LLM-free slot-fill.
 * NO async. NO fs. NO network. NO LLM import. Identical input => identical output.
 * The LLM NEVER packs slots — placement order is the input (pre-ranked) array order.
 */
import type { Finding, BusyInterval, SlotConstraints, ProposedPlan, PlanItem, UnscheduledReason } from "./types.js";

// ── Internal helpers ──────────────────────────────────────────────────
function deriveFreeIntervals(constraints: SlotConstraints, busy: BusyInterval[]): FreeInterval[] { /* window minus busy, clamped to working hours */ }

// ── Public entry (pure, synchronous) ──────────────────────────────────
export function planSlots(findings: Finding[], busy: BusyInterval[], constraints: SlotConstraints): ProposedPlan {
  // iterate findings in INPUT ORDER; place each into earliest free interval that
  // fits estDurationMin before dueBy; on placement, split the free interval;
  // else push { findingId, reason } with an exhaustive reason.
}
```

**Imports this file uses:** `import type { ... } from "./types.js"` (type-only — principles line 35). NOTHING else. Use `Date.parse(iso)` / arithmetic on epoch-ms for time math (numerics.ts:50 uses `Date.parse` and it is permitted — it is pure). Do NOT call `new Date()` with no args.

**Imported by:** `src/calendar/finding-source.ts` (no), `src/cli/commands/calendar.ts` (yes — the CLI core calls `planSlots`).

**Test file:** `src/calendar/slotter.test.ts` (create — sc-1-3/1-4/1-5).

---

### src/calendar/finding-source.ts (create)

No existing file. Reads a ranked-findings JSON array from a file via `node:fs/promises` into `Finding[]`. This file IS async/fs (it is NOT the slotter — the purity rule applies ONLY to slotter.ts).

**Closest models:** `src/cli/commands/task.ts:256-298` (readFile + JSON.parse + Zod validate, never-throw) and `src/hub/finding-source.ts` (a `FindingSource` interface + a concrete class that `safeParse`s each row and skips invalid). Prefer reusing `readJson<T>` from utils (see §3) for the file read.

**Structure template:**
```ts
import { z } from "zod"; // if validating
import { readJson } from "../utils/fs.js";       // see src/utils/fs.ts:24
import type { Finding } from "./types.js";
import { FindingArraySchema } from "./types.js"; // local Zod, defined in types.ts

/** Read a ranked Finding[] from a JSON file. Order is preserved (= priority order). */
export async function readFindingsFromFile(path: string): Promise<Finding[]> {
  const raw = await readJson<unknown>(path);
  return FindingArraySchema.parse(raw); // or safeParse + filter, per hub finding-source.ts:43-48
}
```

**Imports this file uses:** `node:fs/promises` indirectly via `readJson`, `./types.js` (type-only for `Finding`). **Test file:** `src/calendar/finding-source.test.ts` (create).

---

### src/cli/commands/calendar.ts (create)

No existing file. **Model the extracted-core + injectable-deps + chalk + `process.exitCode` pattern on `runWhoopSync` in `src/cli/commands/medical.ts:43-134` and `runImportLabs` at :160-220.** Export a `runCalendarPlan(projectRoot, opts, deps)` core that tests invoke directly, plus a `registerCalendarCommand(program)` that mirrors `registerMedicalCommand` (medical.ts:229-297).

**Extracted-core signature template (mirror medical.ts:43-60):**
```ts
/** Injectable deps for runCalendarPlan — production callers pass undefined. */
export interface CalendarPlanDeps {
  readFindings?: (path: string) => Promise<Finding[]>;   // override in tests
  readFreeBusy?: (path: string) => Promise<BusyInterval[]>;
  nowIso?: string;                                        // clock read ONLY at CLI boundary
}

export async function runCalendarPlan(
  projectRoot: string,
  opts: { findings?: string; freebusy?: string; dryRun?: boolean },
  deps: CalendarPlanDeps = {},
): Promise<void> {
  try {
    // 1. read fixtures (deps override OR readFindingsFromFile / readJson)
    // 2. const plan = planSlots(findings, busy, constraints)  // PURE
    // 3. print scheduled (ISO start/end + title) + unscheduled (reason) via chalk
    //    --dry-run writes NOTHING to any calendar (sc-1-6) — stdout only
  } catch (err) {
    process.stderr.write(chalk.red(`Failed to plan: ${err instanceof Error ? err.message : String(err)}\n`));
    process.exitCode = 1; // CLI handlers MUST NOT throw — set exitCode and return (medical.ts:268-269)
  }
}
```

**Registration block template (mirror medical.ts:229-297):**
```ts
export function registerCalendarCommand(program: Command): void {
  const calendarCmd = program.command("calendar").description("Calendar planner utilities");
  calendarCmd
    .command("plan")
    .description("Propose a schedule from ranked findings + free/busy (deterministic)")
    .option("--dry-run", "print the proposed plan; write nothing to any calendar")
    .option("--findings <path>", "ranked findings JSON file")
    .option("--freebusy <path>", "free/busy JSON file")
    .action(async (opts: { dryRun?: boolean; findings?: string; freebusy?: string }) => {
      const projectRoot = await resolveRoot();   // see medical.ts:36-39 resolveRoot()
      await runCalendarPlan(projectRoot, opts);
    });
}
```
**Imports:** `import type { Command } from "commander";`, `import chalk from "chalk";`, `findProjectRoot` from `../../utils/fs.js`, `planSlots` from `../../calendar/slotter.js`, `readFindingsFromFile` from `../../calendar/finding-source.js`, types from `../../calendar/types.js`. **Test file:** put CLI tests in `src/calendar/slotter.test.ts`/`finding-source.test.ts` per estimatedFiles, OR a `src/cli/commands/calendar.test.ts` (sc-1-6 needs `runCalendarPlan` invoked with injected fixtures).

---

### src/cli/index.ts (modify)

Two edits, both additive:
1. **Add the import** next to medical.ts at line 41:
   - Existing: `import { registerMedicalCommand } from "./commands/medical.js";` (`src/cli/index.ts:41`)
   - Add: `import { registerCalendarCommand } from "./commands/calendar.js";`
2. **Add the registration call** — `registerMedicalCommand(program);` is at `src/cli/index.ts:326` inside a unicode-headered block (lines 325-326). Add directly after it:
```ts
  // ── medical ───────────────────────────────────────────────────────
  registerMedicalCommand(program);

  // ── calendar ──────────────────────────────────────────────────────
  registerCalendarCommand(program);
```
All registrations sit before `await program.parseAsync(process.argv);` (`src/cli/index.ts:347`).

**Imported by:** this is the CLI entrypoint (`#!/usr/bin/env node`, line 1). No module imports it.

---

### src/calendar/__fixtures__/findings.json (create)

Convention exists: `src/medical/retrieval/__fixtures__/`, `src/fleet/__fixtures__/`, `src/orchestrator/workflow/__fixtures__/` (e.g. `src/orchestrator/workflow/__fixtures__/lens-vectors.json`). Place a ranked `Finding[]` JSON array here for the stop-condition CLI run. Per sc-1-3, include 3 findings with `estDurationMin` 30/60/90 and a free window with room for only two. Add a sibling free/busy fixture (e.g. `freebusy.json`) for the `--freebusy` flag.

---

## 2. Patterns to Follow

### Purity contract doc-comment (slotter.ts header)
**Source:** `src/medical/numerics.ts`, lines 9-11 and 159-163
```ts
// numerics.ts:9-11
 * NO async. NO fs. NO network. NO LLM import. NO dynamic execution. NO subprocess.
 * Identical input => identical output.
// numerics.ts:161-163
 * All methods are SYNCHRONOUS. No async, no fs, no network, no LLM import.
```
**Rule:** Open slotter.ts with this exact purity declaration; the sc-1-5 source-scan asserts the words/absence hold.

### Exhaustive switch + `never` guard (the closed reason enum)
**Source:** `src/medical/numerics.ts`, lines 110-153 (esp. 147-152)
```ts
// numerics.ts:147-152 — closed-union dispatch
    default: {
      // Exhaustive never guard: if a new primitive is added to the union without
      // a case here, TypeScript will raise a compile error (ADR-3).
      const _exhaustive: never = primitive;
      throw new Error(`Unhandled NumericPrimitive: ${String(_exhaustive)}`);
    }
```
**Rule:** Model `UnscheduledReason` as a closed string-literal union and resolve it with a `switch` ending in a `const _exhaustive: never = reason;` default — this is the project's enforced way to keep enums closed (also satisfies the `noFallthroughCasesInSwitch` strict flag, principles line 18).

### Extracted-core + injectable-deps CLI
**Source:** `src/cli/commands/medical.ts`, lines 43-60 (interface + signature) and 124-133 (try/catch/finally → exitCode)
```ts
// medical.ts:43-60
export interface WhoopSyncDeps { client?: WhoopClient; nowIso?: string; }
export async function runWhoopSync(projectRoot: string, opts: { since?: string }, deps: WhoopSyncDeps = {}): Promise<void> {
// medical.ts:124-131
  } catch (err) {
    process.stderr.write(chalk.red(`Failed to sync WHOOP: ${err instanceof Error ? err.message : String(err)}\n`));
    process.exitCode = 1;
  } finally { store?.close(); }
```
**Rule:** Export the core with a `deps = {}` default; the `.action()` calls it with no deps (production). Tests inject fixtures (medical.test.ts:93 `runWhoopSync(tmpDir, {}, { client: fixtureClient, nowIso: ... })`).

### CLI handler never throws
**Source:** `src/cli/commands/medical.ts`, lines 262-270 (comment at :268)
**Rule:** `// CLI handlers MUST NOT throw — set exitCode and return`. Catch, `chalk.red` to stderr, `process.exitCode = 1`, return.

### Clock read ONLY at the CLI boundary
**Source:** `src/cli/commands/medical.ts`, line 102 `const nowIso = deps.nowIso ?? new Date().toISOString();` (and :366, :421 comments "Clock read ONLY here at the CLI boundary")
**Rule:** The slotter takes time as input (`SlotConstraints` ISO strings) and never reads the clock — keeps sc-1-4 determinism. `new Date()` lives only in the CLI core, behind a `deps.nowIso` override.

### File read → JSON.parse → validate, never-throw (finding-source)
**Source:** `src/cli/commands/task.ts`, lines 256-298 and `src/hub/finding-source.ts`, lines 32-50
```ts
// task.ts:256-258
async function readIngestInput(file?: string): Promise<string> {
  if (file !== undefined) { return await readFile(file, "utf-8"); }
// hub finding-source.ts:43-48 — safeParse + skip-invalid
      const result = FindingSchema.safeParse(parsed);
      if (result.success) { findings.push(result.data); }
```
**Rule:** Read with `node:fs/promises` (or `readJson` util), `JSON.parse`, then Zod-validate. Decide: hard `.parse()` (throws → caught by CLI core) OR `safeParse` per-element skip — sc-1-6 only needs valid fixtures, so either is acceptable; match the hub's skip-invalid style if robustness is desired.

### Local type derived/aligned to a shared schema (do NOT widen the shared one)
**Source:** `src/do-bridge/types.ts`, lines 1-6 (derives from hub but does not redefine)
```ts
// do-bridge/types.ts:5-6
/** Mirror of Finding["kind"] — derived, never redefined. */
export type FindingKind = Finding["kind"];
```
**Rule:** do-bridge IMPORTS hub; this sprint must NOT (hub is a forward dep). So the calendar `Finding` is a LOCAL standalone type whose FIELD NAMES match `src/hub/finding.ts:10-25` exactly. Note in a comment that it intentionally mirrors the hub schema for future alignment.

### Unicode section headers
**Source:** every file, e.g. `src/medical/numerics.ts:42` `// ── Internal computation helpers ──────` and `.bober/principles.md:32`
**Rule:** Organize each new file with `// ── Section Name ─────` box-drawing headers.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `readJson<T>` | `src/utils/fs.ts:24` | `(path: string): Promise<T>` | readFile(utf-8) + JSON.parse — use this in finding-source.ts instead of hand-rolling |
| `findProjectRoot` | `src/utils/fs.ts:58` | `(startDir?: string): Promise<string \| null>` | Walk up to project root; the CLI `resolveRoot()` wraps it (medical.ts:36-39) |
| `ensureDir` | `src/utils/fs.ts:45` | `(path: string): Promise<void>` | mkdir recursive — only if you ever write (you do NOT this sprint) |
| `fileExists` | `src/utils/fs.ts:10` | `(path: string): Promise<boolean>` | Existence check before read |
| `writeJson` | `src/utils/fs.ts:34` | `(path: string, data: unknown): Promise<void>` | NOT used this sprint (no writes) — listed so you don't recreate it |
| `FindingSchema` / `Finding` | `src/hub/finding.ts:10-27` | Zod schema + `z.infer` type | The shipped schema whose FIELDS you mirror locally — but do NOT import it (forward-dep rule) |
| `resolveRoot()` | `src/cli/commands/medical.ts:36-39` | `(): Promise<string>` | Pattern to copy into calendar.ts (findProjectRoot ?? process.cwd()) |
| `chalk` | npm, used `src/cli/commands/medical.ts:8` | `chalk.green/red/yellow(str)` | All CLI colored output |

Utilities reviewed: `src/utils/` (fs.ts, logger.ts, git.ts) — fs.ts is the relevant one. No new util needed; the slotter math is self-contained pure TS.

---

## 4. Prior Sprint Output

No prior sprints in THIS plan (`dependsOn: []`). Sibling specs are complete and inform field names only:
- **spec-20260628-priority-hub (COMPLETE):** owns the canonical `Finding` schema at `src/hub/finding.ts:10-27`. This sprint defines a LOCAL copy of those fields (forward dependency — contract assumption line 61). Do NOT `import` from `src/hub`.
- **spec-20260628-task-inbox (COMPLETE):** `src/cli/commands/task.ts:256-298` is the closest existing "read findings JSON from a file and validate" precedent — reuse its readFile/JSON.parse/never-throw shape.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM + `.js` import extensions** for NodeNext (line 27): `import { planSlots } from "./slotter.js"`.
- **`node:fs/promises` only — NO sync fs** (line 42). Slotter has NO fs at all.
- **`import type { ... }`** — `consistent-type-imports` enforced (line 35). Import `Finding`, intervals etc. as types.
- **Unicode box section headers** `// ── Name ──` (line 32).
- **Strict TS flags** incl. `noUnusedLocals`, `noUnusedParameters` (`_` prefix escape), `noFallthroughCasesInSwitch`, `isolatedModules` (line 18). Tests collocated `*.test.ts` (line 20). Zero type/lint errors are hard gates.
- **Zod for validation** (line 29): finding-source.ts validation uses a Zod schema.

### Architecture Decisions
No `.bober/architecture/*` ADR specific to calendar (the dir exists but holds other specs' arch docs). The governing design note is research §3a/§3 line 135: "LLM ranks → deterministic JS slot-fill … (respect dueBy + estDurationMin + priority order — do NOT let the LLM pack slots)". Finding shape: research §3a lines 121-126.

### Other Docs
`.bober/research/research-20260627-knowledge-platform-landscape.md` lines 121-135 — Finding schema + calendar-planner design (privacy: cloud events use `calendarSafeTitle`; that field is in scope as a type field but NOT written anywhere this sprint).

---

## 6. Testing Patterns

### Unit Test Pattern (pure-logic + determinism)
**Source:** `src/medical/numerics.test.ts:51-66`
```ts
import { describe, it, expect } from "vitest";
import { planSlots } from "./slotter.js";

describe("CalendarSlotter — fit/overflow (sc-1-3)", () => {
  it("schedules the two that fit, returns the third unscheduled with a reason", () => {
    const plan = planSlots(FINDINGS_30_60_90, BUSY, WINDOW_ROOM_FOR_TWO);
    expect(plan.scheduled).toHaveLength(2);
    expect(plan.unscheduled[0]).toMatchObject({
      reason: expect.stringMatching(/does-not-fit|no-free-slot-before-dueBy/),
    });
  });
});
```
**Determinism test (sc-1-4):** call twice, deep-equal:
```ts
it("is deterministic — identical input => deep-equal output (sc-1-4)", () => {
  const a = planSlots(FINDINGS, BUSY, WINDOW);
  const b = planSlots(FINDINGS, BUSY, WINDOW);
  expect(a).toEqual(b);
});
```
**Runner:** vitest. **Assertion style:** `expect(...).toBe/.toEqual/.toMatchObject/.toHaveLength`. **Mock approach:** none needed for the pure slotter; CLI tests use `vi.spyOn(process.stdout,"write")` + injected deps (no `vi.mock` for the core). **File naming:** `*.test.ts` collocated next to source.

### Source-scan purity test (sc-1-5) — CRITICAL, copy this idiom
**Source:** `src/medical/numerics.test.ts:341-356`
```ts
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

describe("sc-1-5: slotter.ts purity boundary", () => {
  it("contains no await, no node:fs import, no provider/LLM import", async () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = await readFile(join(dir, "slotter.ts"), "utf8");
    expect(src).not.toMatch(/\bawait\b/);
    expect(src).not.toMatch(/node:fs/);
    expect(src).not.toMatch(/providers\//);     // no provider/LLM client import
    expect(src).not.toMatch(/child_process|execa/);
  });
});
```
**Note:** also avoid the word `async` in slotter.ts (no async fns). The numerics test scans `numerics.ts + health-store.ts`; here scan just `slotter.ts`.

### CLI extracted-core test (sc-1-6)
**Source:** `src/cli/commands/medical.test.ts:1-99` (mocks + spies) and :92-99, :194-226 (stdout capture)
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

it("runCalendarPlan prints ISO start/end + title, writes nothing (sc-1-6)", async () => {
  const stdout: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((c) => { stdout.push(String(c)); return true; });
  const { runCalendarPlan } = await import("./calendar.js");
  await runCalendarPlan(tmpDir, { dryRun: true }, {
    readFindings: async () => FIXTURE_FINDINGS,
    readFreeBusy: async () => FIXTURE_BUSY,
    nowIso: "2026-06-29T08:00:00.000Z",
  });
  const out = stdout.join("");
  expect(out).toContain("2026-06-29T");          // ISO start/end present
  expect(out).toContain(FIXTURE_FINDINGS[0].title);
});
```
Reset `process.exitCode` in before/afterEach (medical.test.ts:51-62). Use `mkdtemp(join(tmpdir(), "bober-calendar-"))` if a tmp dir is needed (medical.test.ts:54) — but a dry-run with injected deps needs no tmp dir. **The "writes nothing" assertion:** since the slotter is pure and the CLI core has no write path, asserting stdout-only + that no `writeJson`/`writeFile` is imported in calendar.ts satisfies sc-1-6; a source-scan on calendar.ts for `writeFile`/`writeJson` is the strongest proof.

### E2E Test Pattern
Not applicable — no Playwright. This is a CLI/library sprint (principles "Design Principles: N/A — no UI", line 48).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/index.ts` | new `./commands/calendar.js` import | low | The only existing-file edit. A missing/typo export breaks the whole CLI build. Mirror the medical import (line 41) + register block (lines 325-326) exactly. |
| (nothing else) | new `src/calendar/*` | none | All other files are NEW and additive; no existing module imports `src/calendar/`. |

`src/cli/index.ts` is the CLI entrypoint (`#!/usr/bin/env node`); nothing imports it, so the blast radius of the edit is the CLI binary itself.

### Existing Tests That Must Still Pass
- `src/cli/commands/medical.test.ts` — adjacent CLI-core test idiom you are copying; verify it still passes (it shares no code, but confirms the spy/exitCode harness is intact).
- The full suite (~3400 tests per project memory) — `npm test`. Since this sprint is purely additive (one additive import + register call in index.ts), zero existing tests should change behavior. If any CLI smoke test enumerates top-level commands, a new `calendar` command is additive and should not break it (none observed).

### Features That Could Be Affected
- **None directly.** `src/calendar/` is a brand-new module. The hub `Finding` schema (`src/hub/finding.ts`) is READ-ONLY reference for field names — do NOT edit it (that would ripple into hub/task-inbox/do-bridge which all import it: `src/do-bridge/types.ts:1`, `src/hub/finding-source.ts:1-2`).

### Recommended Regression Checks
1. `npm run build` — tsc zero errors (sc-1-1), confirms the index.ts import resolves with `.js` extension.
2. `npm run typecheck` — zero errors across the new modules (sc-1-2).
3. `npm test` — the new `src/calendar/slotter.test.ts` + `finding-source.test.ts` pass AND no prior test regresses.
4. Manual stop-condition: `node dist/cli/index.js calendar plan --dry-run --findings src/calendar/__fixtures__/findings.json --freebusy src/calendar/__fixtures__/freebusy.json` exits 0, prints the plan, writes nothing.
5. `npm run lint` (if present) — `consistent-type-imports`, unused-var (`_` escape) clean.

---

## 8. Implementation Sequence

Dependency order (types → pure core → io → cli → wiring → tests/fixtures):

1. **src/calendar/types.ts** — define `Finding` (local, fields per hub/finding.ts:10-25), `BusyInterval`, `FreeInterval`, `SlotConstraints`, `PlanItem`, closed `UnscheduledReason` union, `ProposedPlan`. Optionally a local `FindingArraySchema` (Zod) for finding-source validation.
   - Verify: `npm run typecheck` clean for types.ts; field names match the hub schema exactly.
2. **src/calendar/slotter.ts** — `planSlots(findings, busy, constraints): ProposedPlan`, pure synchronous, derive free intervals, iterate in input order, split-on-place, exhaustive-`never` reason mapping. Type-only imports from `./types.js`.
   - Verify: no `await`/`async`/`node:fs`/provider import in the file (pre-check the sc-1-5 scan); typecheck clean.
3. **src/calendar/finding-source.ts** — `readFindingsFromFile(path): Promise<Finding[]>` via `readJson` (utils/fs.ts:24) + Zod validate; preserve array order.
   - Verify: reads the fixture, returns Finding[] in order.
4. **src/cli/commands/calendar.ts** — `CalendarPlanDeps` interface, `runCalendarPlan(projectRoot, opts, deps)` core (calls `planSlots`, chalk output, exitCode-on-error, never-throw, dry-run = no writes), `registerCalendarCommand(program)`. Copy `resolveRoot()` from medical.ts:36-39.
   - Verify: typecheck clean; no `writeFile`/`writeJson` import present.
5. **src/cli/index.ts** — add `import { registerCalendarCommand } from "./commands/calendar.js";` (by line 41) and `registerCalendarCommand(program);` after line 326.
   - Verify: `npm run build` green; `bober calendar plan --help` lists the command.
6. **src/calendar/__fixtures__/findings.json** (+ freebusy.json) — 3 findings 30/60/90 min, window with room for two, plus a free/busy fixture.
   - Verify: fixture parses against the local Finding schema.
7. **src/calendar/slotter.test.ts** + **src/calendar/finding-source.test.ts** — sc-1-3 (fit/overflow), sc-1-4 (determinism deep-equal), sc-1-5 (source-scan purity), sc-1-6 (runCalendarPlan extracted-core with injected deps, ISO start/end/title, no calendar write).
   - Verify: `npm test` green.
8. **Run full verification** — `npm run build` && `npm run typecheck` && `npm test` (and `npm run lint` if configured).

---

## 9. Pitfalls & Warnings

- **slotter.ts is the purity gate.** sc-1-5 greps the FILE TEXT — even a comment containing the word `await` or `node:fs` fails the scan. Keep the file free of those tokens entirely; numerics.ts scans for `\beval\b`, `new Function`, `child_process`, `execa` (numerics.test.ts:350-354) — mirror that exact `not.toMatch` idiom.
- **Do NOT `import` from `src/hub`.** The Finding type is LOCAL (forward dependency, contract assumption line 61). Importing hub would also create a real coupling the planner explicitly avoided. Mirror the field names; add a comment citing `src/hub/finding.ts`.
- **Do NOT widen/edit `src/hub/finding.ts`.** It is imported by do-bridge (`src/do-bridge/types.ts:1`) and hub modules; any edit ripples into completed siblings.
- **No `new Date()` (no-arg) inside slotter.** Determinism (sc-1-4) forbids `Date.now`/`Math.random`. Time enters only as ISO strings in `SlotConstraints`/findings. `Date.parse(iso)` for epoch-ms math is fine and pure (numerics.ts:50 precedent).
- **ESM `.js` extensions on every relative import**, incl. the new index.ts import (`./commands/calendar.js`) — NodeNext build fails otherwise (principles line 27).
- **`import type` for all type-only imports** (Finding, intervals) — `consistent-type-imports` is errored (principles line 35); a value import of a type fails lint.
- **CLI handler must NOT throw** — wrap in try/catch, `process.exitCode = 1`, return (medical.ts:268). sc-1-6 + stop-conditions need exit 0 on the happy path.
- **No writes in --dry-run** — the CLI core must have zero `writeFile`/`writeJson`/`appendFile` calls and not import them. The strongest sc-1-6 proof is a stdout-only assertion plus the absence of any write API in calendar.ts.
- **`noUnusedLocals`/`noUnusedParameters` strict.** If a helper param is unused, prefix with `_` (principles line 36). The exhaustive-`never` default must actually consume the union variable.
- **`noFallthroughCasesInSwitch`** — every case in the reason/kind switch must `return`/`break`; the `never` default closes it.
- **Fixtures live in `__fixtures__/`** (convention: `src/medical/retrieval/__fixtures__/`, `src/fleet/__fixtures__/`), NOT `fixtures/` or `test-data/`.
