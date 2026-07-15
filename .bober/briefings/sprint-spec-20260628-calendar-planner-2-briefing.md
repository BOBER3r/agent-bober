# Sprint Briefing: Connector interface + .ics export (local-first, zero-egress)

**Contract:** sprint-spec-20260628-calendar-planner-2
**Generated:** 2026-06-29T00:00:00Z

> Sprint 2 adds ONE abstraction (`CalendarConnector`) + ONE concrete implementation
> (a hand-rolled RFC 5545 `.ics` writer with ZERO network egress) and wires
> `bober calendar plan --export-ics <path>` to it. REUSE the Sprint-1 types and the
> already-extracted `runCalendarPlan` core — do NOT redefine `PlanItem`, `ProposedPlan`,
> `BusyInterval`, or rewrite the slotter.

---

## 1. Target Files

### src/calendar/connector.ts (create)

**Directory pattern:** `src/calendar/*.ts`, kebab-case files, ESM with `.js` import
extensions, unicode `// ── Section ──` headers (see `types.ts:34`, `slotter.test.ts:9`).
**Most similar existing file for structure:** `src/calendar/types.ts` (pure interface module,
zero runtime imports except `zod` — this file needs NO zod, only `import type`).

**Structure template (interface-only module — no runtime logic):**
```ts
/** The single calendar abstraction both the .ics (Sprint 2) and Google (Sprint 3) connectors implement. */

import type { BusyInterval, PlanItem } from "./types.js";

// ── Connector contract ────────────────────────────────────────────────

/** The free/busy lookup window (subset of SlotConstraints — see types.ts:57). */
export interface FreeBusyWindow {
  windowStartIso: string;
  windowEndIso: string;
}

/** Outcome of writeEvents — what was written and where. */
export interface WriteResult {
  writtenCount: number;
  target: string;
}

/**
 * A calendar backend. The slotter/CLI depend ONLY on this interface so a second
 * connector can be added in Sprint 3 without touching the slotter (DoD).
 */
export interface CalendarConnector {
  readonly name: string;
  readFreeBusy(window: FreeBusyWindow): Promise<BusyInterval[]>;
  writeEvents(items: PlanItem[]): Promise<WriteResult>;
}
```
**Note:** `FreeBusyWindow` mirrors the two required fields of `SlotConstraints`
(`types.ts:59-61`). You MAY instead use `Pick<SlotConstraints, "windowStartIso" | "windowEndIso">`,
but a named interface reads better and is what the Google connector will share in Sprint 3.

---

### src/calendar/ics-connector.ts (create)

**Most similar existing file:** `src/calendar/finding-source.ts` (local-first file I/O via
`node:fs/promises`, fail-closed, JSDoc-per-export). REUSE its `readBusyIntervalsFromFile`
for `readFreeBusy` instead of re-parsing the free/busy file.
**Structure template:**
```ts
/** Local-first RFC 5545 (.ics) connector — materializes a plan to disk with ZERO network egress. */

import { writeFile } from "node:fs/promises";
import { readBusyIntervalsFromFile } from "./finding-source.js";
import type { BusyInterval, PlanItem } from "./types.js";
import type { CalendarConnector, FreeBusyWindow, WriteResult } from "./connector.js";

// ── ISO → RFC 5545 UTC basic-format ───────────────────────────────────

/** "2026-06-29T08:30:00.000Z" → "20260629T083000Z" (deterministic, no locale). */
function toIcsUtc(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

// ── RFC 5545 TEXT escaping (3.3.11) ───────────────────────────────────

/** Escape backslash FIRST, then newline, comma, semicolon. */
function escapeText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

// ── VEVENT / VCALENDAR serialization ──────────────────────────────────

const CRLF = "\r\n";

function serializePlan(items: PlanItem[], dtstampIso: string): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//agent-bober//calendar-planner//EN",
  ];
  const dtstamp = toIcsUtc(dtstampIso);
  for (const item of items) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${item.findingId}@agent-bober`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART:${toIcsUtc(item.startIso)}`,
      `DTEND:${toIcsUtc(item.endIso)}`,
      `SUMMARY:${escapeText(item.title)}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join(CRLF) + CRLF; // trailing CRLF per spec
}

// ── Connector ─────────────────────────────────────────────────────────

export interface IcsConnectorOptions {
  /** Absolute path the .ics file is written to. */
  outPath: string;
  /** Optional local free/busy JSON file (BusyInterval[]). */
  freeBusyPath?: string;
  /** Injectable clock for DTSTAMP determinism (default: new Date().toISOString()). */
  nowIso?: string;
}

export function createIcsConnector(opts: IcsConnectorOptions): CalendarConnector {
  return {
    name: "ics",
    async readFreeBusy(_window: FreeBusyWindow): Promise<BusyInterval[]> {
      if (opts.freeBusyPath === undefined) return [];
      return readBusyIntervalsFromFile(opts.freeBusyPath); // node:fs/promises only
    },
    async writeEvents(items: PlanItem[]): Promise<WriteResult> {
      const ics = serializePlan(items, opts.nowIso ?? new Date().toISOString());
      await writeFile(opts.outPath, ics, "utf-8");
      return { writtenCount: items.length, target: opts.outPath };
    },
  };
}
```
**Why `writeFile` directly (not `writeJson`):** `.ics` is plain CRLF text, not JSON.
`src/utils/fs.ts:34` `writeJson` would `JSON.stringify` it — wrong. Use `writeFile` from
`node:fs/promises` (the same import `src/utils/fs.ts:1` and `slotter.test.ts:2` use).
**Class vs factory:** a factory returning an object literal (above) is fine and matches the
DI style; a `class IcsConnector implements CalendarConnector` is equally acceptable —
`sc-2-2` only requires it structurally satisfy the interface.

---

### src/cli/commands/calendar.ts (modify)

**Relevant section — `CalendarPlanDeps` (lines 25-32), extend it:**
```ts
export interface CalendarPlanDeps {
  readFindings?: (path: string) => Promise<Finding[]>;
  readFreeBusy?: (path: string) => Promise<BusyInterval[]>;
  nowIso?: string;
  // ADD: factory so tests inject a connector pointed at a temp path, prod uses the real one.
  makeConnector?: (outPath: string) => CalendarConnector;
}
```

**Relevant section — `runCalendarPlan` signature + body (lines 50-110).** Add `exportIcs`
to `opts`, and after the plan is built (line 83) add the export branch:
```ts
export async function runCalendarPlan(
  _projectRoot: string,
  opts: { findings?: string; freebusy?: string; dryRun?: boolean; exportIcs?: string },
  deps: CalendarPlanDeps = {},
): Promise<void> {
  try {
    // ... existing read findings (lines 56-65) + free/busy (lines 67-70) unchanged ...
    // ... existing constraints + planSlots (lines 72-83) unchanged ...

    // ── 5. Print proposed plan (existing, lines 85-106) ──────────────

    // ── 6. NEW: --export-ics → write VCALENDAR via the connector ─────
    if (opts.exportIcs !== undefined) {
      const makeConnector =
        deps.makeConnector ?? ((outPath) => createIcsConnector({ outPath, freeBusyPath: opts.freebusy }));
      const connector = makeConnector(opts.exportIcs);
      const result = await connector.writeEvents(plan.scheduled);
      process.stdout.write(
        chalk.green(`\nWrote ${result.writtenCount} event(s) to ${result.target}\n`),
      );
    }

    if (opts.dryRun === true) { /* existing lines 108-110 */ }
  } catch (err) { /* existing fail-closed, lines 111-117 */ }
}
```

**Add the new imports at the top (after line 9):**
```ts
import { createIcsConnector } from "../../calendar/ics-connector.js";
import type { CalendarConnector } from "../../calendar/connector.js";
```

**Register the option in `registerCalendarCommand` (lines 132-143):**
```ts
calendarCmd
  .command("plan")
  // ... existing .option lines 135-137 ...
  .option("--export-ics <path>", "write the scheduled plan to an RFC 5545 .ics file (local, no network)")
  .action(async (opts: { dryRun?: boolean; findings?: string; freebusy?: string; exportIcs?: string }) => {
    const projectRoot = await resolveRoot();
    await runCalendarPlan(projectRoot, opts);
  });
```

**Imports this file already uses:** `chalk` (1), `Command` type (2), `findProjectRoot`
(`../../utils/fs.js`, 6), `planSlots` (`../../calendar/slotter.js`, 7), `readFindingsFromFile`
+ `readBusyIntervalsFromFile` (`../../calendar/finding-source.js`, 8), types from
`../../calendar/types.js` (9).
**Imported by:** the CLI root that calls `registerCalendarCommand` (commander wiring) and
`src/cli/commands/calendar.test.ts:3` (imports `runCalendarPlan`).
**Test file:** `src/cli/commands/calendar.test.ts` — EXISTS (see §7, has a source-scan that
constrains how you wire this).

---

### src/calendar/ics-connector.test.ts (create)

See §6 for the full template (generation sc-2-3, round-trip sc-2-4, no-egress scan sc-2-5).

### src/calendar/__fixtures__/freebusy.json (already exists — `[]`, 3 bytes)

A `freebusy.json` already exists at `src/calendar/__fixtures__/freebusy.json` containing `[]`.
It validates as an empty `BusyInterval[]`. You may reuse it for `readFreeBusy` tests; only add a
non-empty fixture if you assert intervals are returned. Do NOT clobber `findings.json`.

---

## 2. Patterns to Follow

### Local-first file reader, fail-closed (REUSE for readFreeBusy)
**Source:** `src/calendar/finding-source.ts:39-42`
```ts
export async function readBusyIntervalsFromFile(path: string): Promise<BusyInterval[]> {
  const raw = await readJson<unknown>(path);
  return BusyIntervalArraySchema.parse(raw);
}
```
**Rule:** `ics-connector.ts.readFreeBusy` should DELEGATE to this function, not re-implement
JSON reading — it already uses `node:fs/promises` (via `readJson`, `utils/fs.ts:24`) and
Zod-validates, which satisfies `sc-2-5`'s "reads only a local file via node:fs/promises".

### Dependency injection for a testable CLI core
**Source:** `src/cli/commands/calendar.ts:25-32` + `:64`, `:69`, `:74`
```ts
const readFindings = deps.readFindings ?? readFindingsFromFile;
const nowIso = deps.nowIso ?? new Date().toISOString();
```
**Rule:** Default to the real implementation when the dep is absent; tests inject overrides.
Add `makeConnector` to `CalendarPlanDeps` the same way (default → `createIcsConnector`).

### Clock read ONLY at the boundary (determinism)
**Source:** `src/cli/commands/calendar.ts:73-74`
```ts
// Clock read ONLY here at the CLI boundary (mirrors medical.ts:102).
const nowIso = deps.nowIso ?? new Date().toISOString();
```
**Rule:** DTSTAMP needs a "now" — thread it through `IcsConnectorOptions.nowIso` (defaulting to
`new Date().toISOString()`) so the generation test can pass a fixed value and stay deterministic.

### Fail-closed CLI handler (never throw)
**Source:** `src/cli/commands/calendar.ts:111-117`
```ts
} catch (err) {
  process.stderr.write(chalk.red(`Failed to plan: ${err instanceof Error ? err.message : String(err)}\n`));
  process.exitCode = 1; // CLI handlers MUST NOT throw — set exitCode and return.
}
```
**Rule:** Keep the new `--export-ics` write INSIDE the existing try/catch so a write failure
sets `exitCode = 1` instead of throwing.

### Unicode section headers + ESM `.js` imports + `import type`
**Source:** `src/calendar/types.ts:34`, `src/calendar/finding-source.ts:4-6`
```ts
import { readJson } from "../utils/fs.js";
import type { BusyInterval, Finding } from "./types.js";
// ── Calendar data types ───────────────────────────────────────────────
```
**Rule:** All relative imports end in `.js`; types imported with `import type`
(ESLint `consistent-type-imports`, principles.md:35); sections use `// ── … ──`.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `readBusyIntervalsFromFile` | `src/calendar/finding-source.ts:39` | `(path: string): Promise<BusyInterval[]>` | Reads + Zod-validates a local free/busy JSON file via `node:fs/promises`. USE for `readFreeBusy`. |
| `readJson` | `src/utils/fs.ts:24` | `<T>(path: string): Promise<T>` | Reads a file and `JSON.parse`s it (async). Used by the reader above. |
| `writeJson` | `src/utils/fs.ts:34` | `(path, data): Promise<void>` | Pretty-prints JSON. **NOT for .ics** — .ics is CRLF text, use `writeFile`. |
| `writeFile` | `node:fs/promises` (`utils/fs.ts:1`) | `(path, data, enc): Promise<void>` | The correct primitive for writing the plain-text `.ics`. |
| `ensureDir` | `src/utils/fs.ts:45` | `(path): Promise<void>` | `mkdir -p`. Optional — call before `writeFile` if you want parent dirs auto-created. |
| `planSlots` | `src/calendar/slotter.js` (imported `calendar.ts:7`) | `(findings, busy, constraints): ProposedPlan` | The Sprint-1 slotter. DO NOT modify (nonGoal). Feed its `plan.scheduled` to `writeEvents`. |
| `findProjectRoot` | `src/utils/fs.ts:58` | `(startDir?): Promise<string \| null>` | Already used at `calendar.ts:13-15`; no change needed. |

**Utilities reviewed:** `src/utils/` (`fs.ts`), `src/calendar/` (`finding-source.ts`,
`types.ts`, `slotter.ts`). No existing `.ics`/VEVENT/VCALENDAR writer exists anywhere in `src/`
(grep for `vevent\|vcalendar\|\.ics` returns only a comment at `calendar.ts:48`) — you are
building the first one. There is no date-format helper for the `YYYYMMDDTHHMMSSZ` form; the
`toIcsUtc` snippet in §1 is the deterministic conversion.

---

## 4. Prior Sprint Output

### Sprint 1 (DONE, commit 0d141c1): deterministic slotter + finding source + CLI
**Created `src/calendar/types.ts`** — exports `PlanItem { findingId, title, startIso, endIso }`
(`:69-74`), `ProposedPlan { scheduled: PlanItem[]; unscheduled: {findingId, reason}[] }`
(`:87-90`), `BusyInterval { startIso, endIso }` (`:37-40`), `SlotConstraints` (`:57-66`),
`Finding`/`FindingSchema` (`:12-29`). **REUSE these; do not redefine.**
**Created `src/calendar/slotter.ts`** — `planSlots(findings, busy, constraints): ProposedPlan`.
Sprint 2 must NOT change the slot-fill algorithm (nonGoal).
**Created `src/calendar/finding-source.ts`** — `readFindingsFromFile`, `readBusyIntervalsFromFile`.
**Created `src/cli/commands/calendar.ts`** — extracted `runCalendarPlan(root, opts, deps)` core
+ `CalendarPlanDeps` (`:25-32`) + `registerCalendarCommand` (`:126-144`).
**Connection to this sprint:** the connector consumes `plan.scheduled` (`PlanItem[]`) from the
slotter; `--export-ics` is a new branch inside the EXISTING `runCalendarPlan`; the new
`makeConnector` dep extends the EXISTING `CalendarPlanDeps`.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM everywhere, `.js` import extensions** for NodeNext (`:27`). Honor in every new file.
- **No synchronous fs** — all I/O via `node:fs/promises` (`:42`). `writeFile`/`readFile` only.
- **`import type` for types** — `consistent-type-imports` is enforced (`:35`).
- **Tests collocated** `*.test.ts` next to `*.ts` (`:20`); **no fs mocks — use real temp dirs and
  clean up** (`:44`). See the `mkdtemp`/`rm` idiom in §6.
- **Zod for validation** (`:29`) — already satisfied by reusing `readBusyIntervalsFromFile`.
- **Unicode box section headers** `// ── … ──` (`:32`).
- **Type safety hard gate:** strict mode incl. `noUnusedParameters` (`:18`) — prefix the unused
  `window` param `_window` in `readFreeBusy` (the `_` escape hatch, `:36`).
- **Provider-agnostic / no SDK lock-in** (`:28`, `:41`): the `.ics` connector imports NO provider
  or MCP SDK — reinforces `sc-2-5`.

### Architecture Decisions
No `.bober/architecture/` ADR file is specific to the calendar planner (the dir exists from
other specs). The contract's own `assumptions`/`nonGoals` are the governing decisions:
connector-agnostic planner, zero egress on the `.ics` path, hand-rolled VEVENT acceptable.

### RFC 5545 minimal VEVENT (authoritative for sc-2-3/sc-2-4)
Required structure (CRLF line endings, `\r\n`):
```
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//agent-bober//calendar-planner//EN
BEGIN:VEVENT
UID:<findingId>@agent-bober
DTSTAMP:20260629T080000Z
DTSTART:20260629T083000Z
DTEND:20260629T090000Z
SUMMARY:<escaped title>
END:VEVENT
END:VCALENDAR
```
- Timestamps are UTC **basic format** `YYYYMMDDTHHMMSSZ` (no dashes/colons, trailing `Z`).
  Convert with `new Date(iso).toISOString().replace(/[-:]/g,"").replace(/\.\d{3}Z$/,"Z")`.
- SUMMARY escaping (RFC 5545 §3.3.11): backslash → `\\`, newline → `\n`, comma → `\,`,
  semicolon → `\;`. Escape backslash FIRST.
- Minimal required props per VEVENT: `UID`, `DTSTAMP`, `DTSTART`, `DTEND`, `SUMMARY` (per the
  contract assumptions). No RRULE/VALARM/attendees/non-UTC TZ (outOfScope).

---

## 6. Testing Patterns

### Unit Test Pattern — temp-dir file write (sc-2-3, sc-2-6)
**Source:** `src/chat/pid-sidecar.test.ts:1-16` (real temp dir, cleaned up — principles.md:44)
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-ics-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });
```
Then for sc-2-3 / sc-2-4:
```ts
import { createIcsConnector } from "./ics-connector.js";
import type { PlanItem } from "./types.js";

const ITEMS: PlanItem[] = [
  { findingId: "f-1", title: "Task A, with comma", startIso: "2026-06-29T08:30:00.000Z", endIso: "2026-06-29T09:00:00.000Z" },
  { findingId: "f-2", title: "Task B", startIso: "2026-06-29T10:00:00.000Z", endIso: "2026-06-29T11:00:00.000Z" },
];

it("writes a VCALENDAR with one VEVENT per item in UTC Z form (sc-2-3)", async () => {
  const out = join(tmpDir, "plan.ics");
  const connector = createIcsConnector({ outPath: out, nowIso: "2026-06-29T08:00:00.000Z" });
  const res = await connector.writeEvents(ITEMS);
  expect(res.writtenCount).toBe(2);

  const ics = await readFile(out, "utf8");
  expect(ics).toContain("BEGIN:VCALENDAR");
  expect(ics).toContain("END:VCALENDAR");
  expect((ics.match(/BEGIN:VEVENT/g) ?? []).length).toBe(2);
  expect((ics.match(/END:VEVENT/g) ?? []).length).toBe(2);
  expect(ics).toMatch(/DTSTART:20260629T083000Z/);
  expect(ics).toMatch(/DTEND:20260629T090000Z/);
});

it("round-trips DTSTART/DTEND/SUMMARY back to the source items (sc-2-4)", async () => {
  const out = join(tmpDir, "plan.ics");
  await createIcsConnector({ outPath: out }).writeEvents(ITEMS);
  const ics = await readFile(out, "utf8");
  const starts = [...ics.matchAll(/DTSTART:(\d{8}T\d{6}Z)/g)].map((m) => m[1]);
  expect(starts[0]).toBe("20260629T083000Z");
  // SUMMARY round-trip — comma was escaped to "\,"
  expect(ics).toContain("SUMMARY:Task A\\, with comma");
});
```

### Unit Test Pattern — no-egress SOURCE SCAN (sc-2-5)
**Source idiom:** `src/calendar/slotter.test.ts:217-231` (purity boundary scan). Copy this exactly.
```ts
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

describe("sc-2-5: ics-connector.ts no-egress boundary", () => {
  it("imports no http/https/fetch and no external-client, reads only node:fs/promises", async () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const src = await readFile(join(dir, "ics-connector.ts"), "utf8");

    expect(src).not.toMatch(/node:http\b/);
    expect(src).not.toMatch(/node:https\b/);
    expect(src).not.toMatch(/\bfetch\b/);
    expect(src).not.toMatch(/external-client/);
    expect(src).not.toMatch(/child_process|execa/);
    // Positive assertion: it DOES read local files via node:fs/promises.
    expect(src).toMatch(/node:fs\/promises/);
  });
});
```
**What a forbidden network import looks like** (so you are CERTAIN not to add one) —
`src/mcp/external-client.ts:20-21` imports the MCP SDK + `StdioClientTransport`. `ics-connector.ts`
must import NONE of `@modelcontextprotocol/sdk`, `external-client`, `node:http`, `node:https`,
or `fetch`.

### CLI-core test (sc-2-6) — invoke runCalendarPlan with --export-ics
**Source idiom:** `src/cli/commands/calendar.test.ts:49-90` (stdout spy + injected deps + temp dir).
```ts
it("--export-ics writes a valid VCALENDAR and exits 0 (sc-2-6)", async () => {
  const out = join(tmpDir, "out.ics");
  process.exitCode = 0;
  await runCalendarPlan(
    "/tmp/root",
    { findings: "/fake/findings.json", exportIcs: out },
    { readFindings: async () => FIXTURE_FINDINGS, readFreeBusy: async () => [], nowIso: "2026-06-29T08:00:00.000Z" },
  );
  const ics = await readFile(out, "utf8");
  expect(ics).toContain("BEGIN:VCALENDAR");
  expect(ics).toContain("END:VCALENDAR");
  expect(process.exitCode).toBe(0);
});
```
**Runner:** vitest. **Assertion style:** `expect(...)`. **Mock approach:** `vi.spyOn` on
`process.stdout.write` + injected deps (NO `vi.mock`); real temp dirs via `mkdtemp`/`rm`.
**File naming:** `*.test.ts` collocated. **Location:** next to source.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/commands/calendar.test.ts` | `runCalendarPlan` (modified) | **high** | Its source-scan (`:126-138`) asserts `calendar.ts` contains **NO** `writeFile`/`writeJson`/`appendFile`. Your `--export-ics` branch must call `connector.writeEvents(...)` — the file write lives in `ics-connector.ts`, NOT `calendar.ts`. If you add `writeFile` to `calendar.ts`, this test FAILS. |
| CLI root (commander wiring that calls `registerCalendarCommand`) | new `--export-ics` option | low | Adding an option is additive; existing `plan` invocations are unaffected. |
| `src/calendar/finding-source.ts` | `readBusyIntervalsFromFile` (reused, not changed) | low | You import it — do not modify it. |

### Existing Tests That Must Still Pass
- `src/cli/commands/calendar.test.ts` — covers `runCalendarPlan` (dry-run output, missing-findings
  fail-closed, throw→exitCode=1, **source-scan forbidding writeFile in calendar.ts**). All 7 cases
  must still pass; the source-scan is the one most likely to break (see table).
- `src/calendar/slotter.test.ts` — covers `planSlots` + slotter purity. You don't touch the slotter,
  so these must remain green; the existing purity scan at `:219` is your template for sc-2-5.
- `src/calendar/finding-source.test.ts` — covers the readers you reuse. Must stay green (no edits).

### Features That Could Be Affected
- **feat-1 (Sprint 1 slotter/CLI)** — shares `src/cli/commands/calendar.ts` and `src/calendar/types.ts`.
  Verify `bober calendar plan --dry-run` (no `--export-ics`) is byte-identical in behavior:
  the export branch only runs when `opts.exportIcs !== undefined`.
- **feat-3+ (Sprint 3 Google connector)** — will implement the SAME `CalendarConnector` interface.
  Keep `connector.ts` minimal and connector-agnostic (no `.ics` specifics leaking into it).

### Recommended Regression Checks (run after implementation)
1. `npm run build` — zero tsc errors (sc-2-1).
2. `npm run typecheck` — confirms `createIcsConnector` return value satisfies `CalendarConnector` (sc-2-2).
3. `npx vitest run src/calendar src/cli/commands/calendar.test.ts` — new + existing calendar tests green.
4. `npm run lint` — zero errors (`consistent-type-imports`, unused `_window`).
5. Confirm `src/cli/commands/calendar.test.ts:126-138` (no-writeFile-in-calendar.ts scan) still passes.

---

## 8. Implementation Sequence

1. **src/calendar/connector.ts** — define `FreeBusyWindow`, `WriteResult`, `CalendarConnector`.
   Pure `import type` from `./types.js`, no runtime code.
   - Verify: `npx tsc --noEmit` resolves the imports; no value imports.
2. **src/calendar/ics-connector.ts** — `toIcsUtc`, `escapeText`, `serializePlan`, `createIcsConnector`.
   `readFreeBusy` delegates to `readBusyIntervalsFromFile`; `writeEvents` uses `node:fs/promises` `writeFile`.
   - Verify: the returned object is assignable to `CalendarConnector` (typecheck); no http/https/fetch/external-client imports.
3. **src/cli/commands/calendar.ts** — add the two imports; add `exportIcs` to `opts`; add `makeConnector`
   to `CalendarPlanDeps`; add the `if (opts.exportIcs !== undefined)` branch INSIDE the existing try/catch
   AFTER `planSlots`; register `--export-ics <path>`. Do NOT add `writeFile` to this file.
   - Verify: existing `calendar.test.ts` source-scan still passes; dry-run path unchanged.
4. **src/calendar/ics-connector.test.ts** — generation (sc-2-3), round-trip (sc-2-4), no-egress scan
   (sc-2-5), plus a CLI sc-2-6 case (either here or in `calendar.test.ts`). Use `mkdtemp`/`rm`.
   - Verify: `npx vitest run src/calendar/ics-connector.test.ts` passes.
5. **src/calendar/__fixtures__/freebusy.json** — already exists (`[]`). Add a non-empty fixture only
   if a `readFreeBusy` test needs intervals; otherwise leave as-is.
6. **Run full verification** — `npm run build` && `npm run typecheck` && `npx vitest run src/calendar src/cli/commands/calendar.test.ts` && `npm run lint`.

---

## 9. Pitfalls & Warnings

- **Do NOT call `writeFile`/`writeJson`/`appendFile` in `src/cli/commands/calendar.ts`.** The existing
  test `calendar.test.ts:135-137` scans for those tokens and fails the build if present. The file write
  MUST live in `ics-connector.ts`; `calendar.ts` only calls `connector.writeEvents(...)`.
- **Do NOT use `writeJson` for the .ics file** — it `JSON.stringify`s. `.ics` is CRLF plain text;
  use `writeFile(path, ics, "utf-8")`.
- **CRLF, not LF.** Join lines with `"\r\n"` and end the file with a trailing `\r\n`. A round-trip regex
  like `/DTSTART:(\d{8}T\d{6}Z)/` works regardless, but importers expect CRLF.
- **UTC basic format, not extended.** `DTSTART:2026-06-29T08:30:00Z` is WRONG. It must be
  `DTSTART:20260629T083000Z` (no dashes/colons, no milliseconds). Use the `toIcsUtc` regex.
- **Escape SUMMARY, escape backslash FIRST.** Reordering (comma before backslash) double-escapes.
- **`noUnusedParameters` is a hard gate.** The local-file `readFreeBusy` ignores its `window` arg —
  name it `_window` (the only permitted unused-var escape, principles.md:36).
- **`.js` import extensions everywhere** (`./connector.js`, `./types.js`, `./finding-source.js`) — omitting
  them breaks NodeNext resolution and the build.
- **Zero egress is verified by SOURCE SCAN, not behavior.** Even an unused `import "node:https"` fails
  sc-2-5. Import only `node:fs/promises`, `./finding-source.js`, `./connector.js`, `./types.js`.
- **Reuse, don't redefine.** `PlanItem`/`BusyInterval`/`ProposedPlan` come from `./types.js`. Defining a
  second `PlanItem` in the connector would diverge from the slotter output.
- **`__fixtures__/freebusy.json` already exists** — don't overwrite `findings.json` next to it.
