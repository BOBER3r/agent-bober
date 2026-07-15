# Sprint Briefing: Approve-gate — propose → /approve|/tell → write events

**Contract:** sprint-spec-20260628-calendar-planner-4
**Generated:** 2026-06-29T00:00:00Z

---

## 0. TL;DR — the load-bearing facts (read this first)

1. **The contract's GUESSED approval function names are CORRECT.** `src/state/approval-state.ts` really exports `savePending`, `saveApproved`, `saveRejected`, `readPending`, `deletePending` (plus `pendingExists`, `listPending`, `listPendingApprovals`). Use them verbatim. The guessed `PendingMarker.artifact` shape is ALSO compatible: the real type is `{ type?, path?, summary?, lines? }` — all fields optional (`src/state/approval-state.ts:28`). Do NOT redefine these.
2. **checkpointId convention:** do-bridge uses `` `promote-${findingId}` `` (`src/do-bridge/promote.ts:79`). Mirror it → use **`` `calendar-${planId}` ``** so the EXISTING `bober approve calendar-<id>` / `/approve calendar-<id>` flow resolves it unchanged.
3. **There is NO `readApproved` / `readRejected` export.** `applyPlan` must detect the approved/rejected marker by building the path inline (`join(projectRoot, ".bober", "approvals", `${checkpointId}.approved.json`)`) — exactly how `approve.ts:41` and the do-bridge poll (`promote.ts:140,146`) do it.
4. **`PendingMarker.artifact` cannot hold the PlanItems** (its shape is fixed: type/path/summary/lines). Persist the `ProposedPlan` to a sidecar JSON file and point `artifact.path` at it, so `applyPlan` can reload the scheduled items. Suggested deterministic path: `.bober/calendar/<checkpointId>.plan.json`.
5. **CRITICAL PITFALL — `calendar.ts` must contain NO `writeFile`/`writeJson`/`appendFile` token.** A Sprint-1 source-scan test asserts this (`src/cli/commands/calendar.test.ts:129-141`). Put ALL filesystem writes in `proposal-gate.ts`; `calendar.ts` only imports and calls `proposePlan`/`applyPlan`.
6. **`writeEvents` exactly once on approval, never before, never on reject.** `connector.writeEvents(plan.scheduled)` is called ONLY inside the approved branch of `applyPlan`. No auto-approve anywhere (do-bridge has `--yes`; **calendar must NOT** — the contract's nonGoals forbid auto-approve in any mode).
7. **`adjustPlan` is PURE** — it re-runs `planSlots` (Sprint 1) with a tweaked input and returns a new `ProposedPlan`. It writes NOTHING. Note: `SlotConstraints` has **no `excludeInterval` field** — model an "exclude interval" by appending a `BusyInterval` to the `busy[]` array passed to `planSlots`, OR shift `windowStartIso`/`windowEndIso`.

---

## 1. Target Files

### src/calendar/proposal-gate.ts (create)

**Directory pattern:** `src/calendar/` uses kebab-case filenames, one focused module each (`slotter.ts`, `connector.ts`, `ics-connector.ts`, `calendar-egress.ts`). Tests are collocated `*.test.ts`.
**Most similar existing file:** `src/do-bridge/promote.ts` — the closest precedent (it wraps the SAME approval-state machinery). Mirror its DI-core / injected-`now` / never-throw style, but DROP the `--yes` auto-approve, TTY-confirm, and non-TTY poll loop (the calendar gate is propose-then-exit; approval arrives out-of-band via `bober approve`).

**Structure template (based on promote.ts + the generatorNotes):**
```typescript
/** Calendar approval gate — propose (write pending marker, ZERO events) →
 *  approve out-of-band → apply (writeEvents exactly once) → adjust (pure re-slot). */

import { join } from "node:path";
import { readFile, access } from "node:fs/promises";

import {
  savePending,
  deletePending,
} from "../state/approval-state.js";
import { ensureDir } from "../state/helpers.js";
import { planSlots } from "./slotter.js";
import type { CalendarConnector } from "./connector.js";
import type {
  ProposedPlan, Finding, BusyInterval, SlotConstraints,
} from "./types.js";

// ── proposePlan: write pending marker + plan sidecar, NO events ────────
export interface ProposeArgs {
  projectRoot: string;
  planId: string;                 // checkpointId = `calendar-${planId}`
  plan: ProposedPlan;
  connectorName: string;
  now: () => string;
  timeoutMs?: number;
}
export async function proposePlan(args: ProposeArgs): Promise<{ checkpointId: string }> {
  const checkpointId = `calendar-${args.planId}`;
  // write plan sidecar (artifact.path) — proposal-gate owns ALL fs writes
  // savePending({ checkpointId, artifact: { type: "calendar-plan", path, summary, lines }, prompt, requestedAt, timeoutAt })
  // NO connector.writeEvents here.
  return { checkpointId };
}

// ── applyPlan: gate on approved/rejected, writeEvents ONCE on approve ──
export type ApplyOutcome =
  | { status: "applied"; writtenCount: number }
  | { status: "rejected"; feedback?: string }
  | { status: "pending" };
export async function applyPlan(
  projectRoot: string,
  checkpointId: string,
  connector: CalendarConnector,
): Promise<ApplyOutcome> {
  // read .approved.json / .rejected.json paths inline (no readApproved export exists)
  // approved  → reload plan sidecar → connector.writeEvents(scheduled) ONCE → deletePending → { applied }
  // rejected  → NO write → { rejected, feedback }
  // neither   → { pending }
}

// ── adjustPlan: PURE re-slot under a constraint delta, writes NOTHING ──
export interface ConstraintDelta {
  excludeInterval?: BusyInterval;   // appended to busy[]
  windowStartIso?: string;          // shift window
  windowEndIso?: string;
}
export function adjustPlan(
  findings: Finding[],
  busy: BusyInterval[],
  constraints: SlotConstraints,
  delta: ConstraintDelta,
): ProposedPlan {
  const newBusy = delta.excludeInterval ? [...busy, delta.excludeInterval] : busy;
  const newConstraints: SlotConstraints = {
    ...constraints,
    ...(delta.windowStartIso ? { windowStartIso: delta.windowStartIso } : {}),
    ...(delta.windowEndIso ? { windowEndIso: delta.windowEndIso } : {}),
  };
  return planSlots(findings, newBusy, newConstraints); // pure, no write
}
```

---

### src/cli/commands/calendar.ts (modify)

**Relevant sections — the `plan` action + `registerCalendarCommand` (lines 142-161):**
```typescript
// src/cli/commands/calendar.ts:148-160 — CURRENT plan subcommand
calendarCmd
  .command("plan")
  .option("--dry-run", "print the proposed plan; write nothing to any calendar")
  .option("--findings <path>", "...")
  .option("--freebusy <path>", "...")
  .option("--export-ics <path>", "...")
  .action(async (opts) => {
    const projectRoot = await resolveRoot();
    await runCalendarPlan(projectRoot, opts);
  });
```
The live (no `--dry-run`, no `--export-ics`) branch must call `proposePlan`. `runCalendarPlan` currently branches on `opts.dryRun` (line 124) and `opts.exportIcs` (line 113); add a new branch: when NEITHER flag is set → live propose path. **Keep the `--dry-run` and `--export-ics` branches BYTE-IDENTICAL** (existing tests at calendar.test.ts cover them).

**Add a NEW subcommand `calendar apply <checkpointId>`** alongside `plan` inside `registerCalendarCommand` (after line 160). Its `.action` resolves the connector, calls `applyPlan`, and prints the outcome.

**Connector selection (the live path):** read config via `loadConfig(projectRoot)` (`src/config/loader.ts:142`), branch on `config.calendar?.connector ?? "ics"` (default 'ics', schema at `src/config/schema.ts:473`):
- `"ics"` → `createIcsConnector({ outPath, freeBusyPath, nowIso })` (`src/calendar/ics-connector.ts:63`).
- `"google"` → `createGoogleConnector({ adapter, egress: CalendarEgressGuard.fromConfig(config), token, findings })` (`src/calendar/google-connector.ts:109`). The egress guard STILL gates the write (`calendar-egress.ts:35` throws when `calendar.egress.cloudCalendar` is false). Do NOT bypass it.

**Imports this file uses (current):** `chalk`, `Command` (commander), `findProjectRoot` (`../../utils/fs.js`), `planSlots` (`../../calendar/slotter.js`), readers from `../../calendar/finding-source.js`, `createIcsConnector`, types from `../../calendar/types.js`, `CalendarConnector` from `../../calendar/connector.js`.
**Add imports:** `proposePlan`, `applyPlan` from `../../calendar/proposal-gate.js`; `loadConfig` from `../../config/loader.js`; connector factories as needed.
**Imported by:** `src/cli/index.ts:42` (`import { registerCalendarCommand }`), wired at `src/cli/index.ts:330`.
**Test file:** `src/cli/commands/calendar.test.ts` (EXISTS — 10 tests). **DO NOT break the source-scan test at line 129-141** (see Pitfalls).

---

### src/calendar/proposal-gate.test.ts (create)
Collocated unit test. Use the temp-`.bober` idiom from `src/do-bridge/promote.test.ts` (see §6).

### src/calendar/calendar-e2e.test.ts (create)
End-to-end propose → approve → apply lifecycle test (sc-4-6). Use a stub `CalendarConnector` and a real temp dir.

---

## 2. Patterns to Follow

### Marker lifecycle via approval-state (the WHOLE point of this sprint)
**Source:** `src/do-bridge/promote.ts:84-100`
```typescript
// 1. Write the pending marker
await savePending(projectRoot, {
  checkpointId,
  artifact: { type: "bober-run", summary: plan.task },
  prompt: `Promote to bober run: "${plan.task}"`,
  requestedAt,
  timeoutAt,
});
// ... on approval:
await saveApproved(projectRoot, checkpointId, { approvedAt: now(), approverId: "tty" });
await deletePending(projectRoot, checkpointId);
```
**Rule:** Reuse `savePending`/`deletePending` directly; never invent a parallel store. For calendar, `proposePlan` calls `savePending` and STOPS (no approve here — approval is out-of-band).

### Detecting the approved/rejected marker without a reader export
**Source:** `src/do-bridge/promote.ts:136-150` (directory scan) and `src/cli/commands/approve.ts:40-41` (inline path build)
```typescript
const entries = new Set(await readdir(approvalsDir).catch(() => [] as string[]));
if (entries.has(`${checkpointId}.approved.json`)) { /* approved */ }
if (entries.has(`${checkpointId}.rejected.json`)) { /* rejected */ }
```
**Rule:** `applyPlan` must read the approved/rejected files itself (no `readApproved` exists). Reading the `.rejected.json` JSON gives you `feedback` (shape at `approval-state.ts:40-44`).

### checkpointId derivation
**Source:** `src/do-bridge/promote.ts:79`, `` `promote-${findingId}` `` — comment at promote.ts:62-64 explains "so external `bober approve promote-<id>` resolves it".
**Rule:** Use `` `calendar-${planId}` `` so `bober approve calendar-<id>` / `/approve calendar-<id>` works with ZERO new wiring.

### Extracted-core + injectable deps (testability)
**Source:** `src/cli/commands/calendar.ts:27-36, 54-58` (`CalendarPlanDeps`) and `src/do-bridge/promote.ts:32-55` (`PromotionGateArgs` with injected `now`/`confirm`).
**Rule:** Inject `now: () => string` and the connector so tests are deterministic and never spawn real I/O. Clock is read ONLY at the CLI boundary (`calendar.ts:78` comment).

### CLI handlers MUST NOT throw
**Source:** `src/cli/commands/calendar.ts:127-133`
```typescript
} catch (err) {
  process.stderr.write(chalk.red(`Failed to plan: ${err instanceof Error ? err.message : String(err)}\n`));
  process.exitCode = 1;  // set exitCode + return, never throw
}
```
**Rule:** Wrap the new live/apply branches the same way.

### Unicode section headers + ESM `.js` imports + `import type`
**Source:** `src/calendar/slotter.ts:18-26`, `principles.md:27,32,35`.
**Rule:** `// ── Section ─────`, all relative imports end in `.js`, types imported with `import type`.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `savePending` | `src/state/approval-state.ts:49` | `(projectRoot, m: PendingMarker): Promise<void>` | Write `.bober/approvals/<id>.pending.json` |
| `readPending` | `src/state/approval-state.ts:64` | `(projectRoot, id): Promise<PendingMarker \| null>` | Read pending marker (null if absent) |
| `saveApproved` | `src/state/approval-state.ts:106` | `(projectRoot, id, m: ApprovedMarker): Promise<void>` | Write `.approved.json` |
| `saveRejected` | `src/state/approval-state.ts:122` | `(projectRoot, id, m: RejectedMarker): Promise<void>` | Write `.rejected.json` |
| `deletePending` | `src/state/approval-state.ts:138` | `(projectRoot, id): Promise<void>` | Best-effort unlink pending (never throws) |
| `pendingExists` | `src/state/approval-state.ts:145` | `(projectRoot, id): Promise<boolean>` | Guard before approve/reject |
| `listPending` | `src/state/approval-state.ts:80` | `(projectRoot): Promise<PendingMarker[]>` | All pending markers |
| `ensureDir` | `src/state/helpers.ts:6` | `(dirPath): Promise<void>` | mkdir -p (used by savePending; use for plan sidecar dir) |
| `planSlots` | `src/calendar/slotter.ts:169` | `(findings, busy, constraints): ProposedPlan` | The Sprint-1 pure slotter `adjustPlan` re-runs |
| `createIcsConnector` | `src/calendar/ics-connector.ts:63` | `(opts: IcsConnectorOptions): CalendarConnector` | Local .ics connector |
| `createGoogleConnector` | `src/calendar/google-connector.ts:109` | `(opts: GoogleConnectorOptions): CalendarConnector` | Cloud connector (egress-gated) |
| `CalendarEgressGuard.fromConfig` | `src/calendar/calendar-egress.ts:20` | `(config): CalendarEgressGuard` | Build egress guard; `.assertCloudCalendarAllowed()` throws when off |
| `loadConfig` | `src/config/loader.ts:142` | `(projectRoot): Promise<BoberConfig>` | Load config to read `calendar.connector` |
| `findProjectRoot` | `src/utils/fs.js` (used `calendar.ts:6`) | `(): Promise<string \| undefined>` | Resolve project root |
| `resolveApprover` | `src/cli/commands/approve.ts:29` | `(): string` | `$USER` identity for markers |

**Marker type shapes (REAL — `src/state/approval-state.ts:25-44`):**
- `PendingMarker { checkpointId: string; runId?: string; artifact: { type?: string; path?: string; summary?: string; lines?: number }; prompt: string; requestedAt: string; timeoutAt: string }`
- `ApprovedMarker { approvedAt: string; approverId: string; editDelta?: unknown }`
- `RejectedMarker { rejectedAt: string; rejecterId: string; feedback: string }`

**`CalendarConnector` (`src/calendar/connector.ts:23-27`):** `{ readonly name; readFreeBusy(window): Promise<BusyInterval[]>; writeEvents(items: PlanItem[]): Promise<WriteResult> }` where `WriteResult = { writtenCount: number; target: string }` (connector.ts:14-17).

---

## 4. Prior Sprint Output

### Sprint 1 (0d141c1): slotter
**Created:** `src/calendar/slotter.ts` — exports `planSlots(findings, busy, constraints): ProposedPlan` (pure, LLM-free, deterministic, `slotter.ts:169`). `src/calendar/types.ts` — `Finding`, `BusyInterval`, `SlotConstraints`, `PlanItem`, `ProposedPlan`, `UnscheduledReason`.
**Connection:** `adjustPlan` calls `planSlots` directly with a mutated busy/constraints input. `proposePlan` receives the `ProposedPlan` it produced.

### Sprint 2 (0481407): connector contract + .ics
**Created:** `src/calendar/connector.ts` (`CalendarConnector`, `WriteResult`, `FreeBusyWindow`); `src/calendar/ics-connector.ts` (`createIcsConnector`).
**Connection:** `applyPlan(projectRoot, checkpointId, connector)` calls `connector.writeEvents(plan.scheduled)`.

### Sprint 3 (123c7c4): Google connector + egress axis + config
**Created:** `src/calendar/google-connector.ts` (`createGoogleConnector`, egress-gated); `src/calendar/calendar-egress.ts` (`CalendarEgressGuard`); `calendar` config section (`src/config/schema.ts:464-477`): `connector` default `'ics'`, `egress.cloudCalendar` default `false`.
**Connection:** The live path selects the connector from `config.calendar.connector`; Google writes stay gated by `CalendarEgressGuard`.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM everywhere** — all relative imports end in `.js` (NodeNext) (`principles.md:27`).
- **`import type`** enforced by ESLint `consistent-type-imports` (`principles.md:35`).
- **No synchronous fs** — `node:fs/promises` only (`principles.md:42`).
- **Filesystem state** — all mutable state is JSON in `.bober/`; no DB (`principles.md:31`).
- **Section comments** — unicode box-drawing headers (`principles.md:32`).
- **Tests collocated** `*.test.ts`, temp dirs created+cleaned, **no fs mocks** (`principles.md:20,44`).
- **Prefix unused params with `_`** (`principles.md:36`).

### Architecture Decisions
No `.bober/architecture/*` ADR file specific to the calendar planner was found in this read. Lineage references in code: ADR-6 (egress axis, `calendar-egress.ts:1`), ADR-3 (exhaustive-switch gate, `slotter.ts:89`). The contract embeds the design (research §3a: propose → /approve → write, contract assumption line 66).

### Other Docs
do-bridge precedent documented at `docs/do-bridge.md` (referenced from `do.ts:258`); the calendar gate is the analog for calendar plans.

---

## 6. Testing Patterns

**Runner:** Vitest. **Assertion style:** `expect(...)`. **Mock approach:** real temp dirs (no fs mocks per principles); `vi.spyOn(process.stdout, "write")` for CLI output. **File naming:** `*.test.ts` collocated.

### Unit Test Pattern — temp `.bober` + marker assertions
**Source:** `src/do-bridge/promote.test.ts:50-71`
```typescript
const tmpDir = await mkdtemp(join(tmpdir(), "bober-cal-"));
try {
  await proposePlan({ projectRoot: tmpDir, planId: "p1", plan, connectorName: "ics", now: () => T });
  const approvalsDir = join(tmpDir, ".bober", "approvals");
  await access(join(approvalsDir, "calendar-p1.pending.json")); // pending written
  // assert stub connector.writeEvents NOT called yet
} finally {
  await rm(tmpDir, { recursive: true, force: true });
}
```
Helper to assert absence (promote.test.ts:17-24):
```typescript
async function expectMissing(path: string): Promise<void> {
  try { await access(path); throw new Error(`Expected ${path} absent`); }
  catch (err) { if ((err as { code?: string }).code !== "ENOENT") throw err; }
}
```

### Stub connector + writeEvents call-count (sc-4-4 / sc-4-6)
**Pattern source:** `src/cli/commands/calendar.test.ts:246-256` injects a fake connector via `makeConnector`.
```typescript
let writeCalls = 0;
let lastItems: PlanItem[] = [];
const stubConnector: CalendarConnector = {
  name: "stub",
  async readFreeBusy() { return []; },
  async writeEvents(items) { writeCalls++; lastItems = items; return { writtenCount: items.length, target: "stub" }; },
};
// inject an ApprovedMarker, then:
const outcome = await applyPlan(tmpDir, "calendar-p1", stubConnector);
expect(writeCalls).toBe(1);                  // EXACTLY once
expect(lastItems).toEqual(plan.scheduled);
// reject case: inject .rejected.json instead → expect(writeCalls).toBe(0);
```
Inject markers directly (mirrors promote.test.ts:188-193):
```typescript
await mkdir(join(tmpDir, ".bober", "approvals"), { recursive: true });
await writeFile(join(approvalsDir, "calendar-p1.approved.json"),
  JSON.stringify({ approvedAt: T, approverId: "test" }), "utf-8");
```

### Pure adjustPlan test (sc-4-5)
**Source idiom:** `src/calendar/slotter.test.ts:1-40` — build `Finding[]`, `BusyInterval[]`, `SlotConstraints`, call directly, assert on returned `ProposedPlan.scheduled`/`unscheduled`. For sc-4-5, call `adjustPlan(findings, busy, constraints, { excludeInterval })` and assert the schedule shifts AND that no `.bober/approvals` file was created (writes-nothing).

### E2E lifecycle (sc-4-6)
Compose: `proposePlan` (assert pending written, `writeCalls===0`) → write `.approved.json` → `applyPlan` (assert `writeCalls===1`, pending deleted via `expectMissing`).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/index.ts:42,330` | `registerCalendarCommand` | low | Adds a subcommand; signature of `registerCalendarCommand(program)` unchanged |
| `src/cli/commands/calendar.test.ts` | `runCalendarPlan` + calendar.ts source | **high** | Source-scan test (line 129-141) forbids `writeFile`/`writeJson`/`appendFile` tokens in calendar.ts; dry-run + export-ics tests must stay green |
| `src/state/approval-state.ts` consumers (do.ts, chat-session.ts, approve.ts, reject.ts, list-approvals.ts) | the marker store | low | You only IMPORT from it; do not modify approval-state.ts |

### Existing Tests That Must Still Pass
- `src/cli/commands/calendar.test.ts` — 10 tests covering dry-run output, `--export-ics` write, and the **no-write source-scan** (line 129). Keep dry-run/export-ics branches byte-identical; keep all fs writes out of calendar.ts.
- `src/calendar/slotter.test.ts` — `planSlots` purity/placement. `adjustPlan` must not alter slotter.ts.
- `src/calendar/ics-connector.test.ts`, `google-connector.test.ts`, `calendar-egress.test.ts`, `calendar-token.test.ts` — connector + egress behavior unchanged.
- `src/do-bridge/promote.test.ts` + `src/cli/commands/approve.test.ts` / `reject.test.ts` — confirm the shared marker contract you are reusing is unbroken.

### Features That Could Be Affected
- **do-bridge promotion gate** — shares `src/state/approval-state.ts`. Verify `bober do` still gates (you must not change marker file naming or the type shapes).
- **chat /approve //reject //tell** — `src/chat/chat-session.ts:359-389` resolves checkpoints by id via `pendingExists` + `saveApproved`/`saveRejected`. Your `calendar-<id>` checkpointId is resolvable by this exact flow with no change.

### Recommended Regression Checks
1. `npm run build` (sc-4-1) — zero tsc errors.
2. `npm run typecheck` (sc-4-2) — zero errors.
3. `npm test -- src/calendar src/cli/commands/calendar.test.ts src/do-bridge/promote.test.ts src/cli/commands/approve.test.ts` — all green.
4. `npm run lint` — `consistent-type-imports` + unused-var gates.
5. Manual: `bober calendar plan --findings <f>` prints a `calendar-<id>` checkpointId + "bober approve <id>" instructions and writes ZERO events; `bober calendar apply <id>` before approval reports "pending" (no write).

---

## 8. Implementation Sequence

1. **src/calendar/proposal-gate.ts** — implement `proposePlan` (savePending + plan sidecar via `ensureDir`+JSON), `applyPlan` (inline approved/rejected path detection → `writeEvents` once → `deletePending`; rejected → no write; neither → pending), `adjustPlan` (pure `planSlots` re-run). Import from `state/approval-state.js` — do NOT re-implement storage.
   - Verify: `tsc` clean; module imports `savePending`/`deletePending` (evaluator reads this).
2. **src/cli/commands/calendar.ts** — add the live `plan` branch (no flags → `loadConfig` → select connector → `planSlots` → `proposePlan` → print checkpointId + "bober approve <id> or /approve <id>"); add `calendar apply <checkpointId>` subcommand. Keep `--dry-run`/`--export-ics` byte-identical. **No `writeFile` token in this file.**
   - Verify: `calendar.test.ts:129` source-scan still passes; dry-run/export-ics tests green.
3. **src/calendar/proposal-gate.test.ts** — sc-4-3 (pending written, writeEvents not called before approval), sc-4-4 (approved → once / rejected → never), sc-4-5 (adjustPlan re-slots, no write).
   - Verify: stub-connector call-count assertions pass.
4. **src/calendar/calendar-e2e.test.ts** — sc-4-6 propose → approve → apply lifecycle + marker deletion.
   - Verify: pending written → approved → pending deleted, exactly one `writeEvents`.
5. **Run full verification** — `npm run build`, `npm run typecheck`, `npm test`, `npm run lint`.

---

## 9. Pitfalls & Warnings

- **DO NOT put any `writeFile`/`writeJson`/`appendFile` token in `src/cli/commands/calendar.ts`.** `calendar.test.ts:129-141` source-scans for these and will fail the build. All writes go through `proposal-gate.ts` (which calls `savePending`).
- **No auto-approve, ever.** Unlike `runPromotionGate` (which has `--yes` and TTY-confirm), the calendar gate must NOT self-approve in any mode including autopilot (contract nonGoal line 56). `proposePlan` writes pending and returns; approval is strictly out-of-band.
- **`writeEvents` exactly once, only inside the approved branch.** Never call it in `proposePlan`, never on the rejected/pending branches. The e2e + sc-4-4 tests assert the call count.
- **There is no `readApproved`/`readRejected` export.** Build the marker paths inline (`join(projectRoot, ".bober", "approvals", `${id}.approved.json`)`) — `approval-state.ts`'s `pendingPath`/`approvedPath`/`rejectedPath` are PRIVATE (not exported, lines 13-23).
- **`PendingMarker.artifact` is a FIXED shape** (`{ type?, path?, summary?, lines? }`) — you cannot stuff `PlanItem[]` into it. Persist the `ProposedPlan` to a sidecar JSON file and reference it via `artifact.path`; reload it in `applyPlan`.
- **`SlotConstraints` has NO `excludeInterval` field** (`types.ts:57-66`). Model the /tell "exclude interval" delta as an extra `BusyInterval` appended to the `busy[]` array fed to `planSlots`, or as a window shift. Do not invent a constraints field.
- **Google connector still gated.** When `config.calendar.connector === "google"`, build `CalendarEgressGuard.fromConfig(config)`; the write throws if `calendar.egress.cloudCalendar` is false — do not catch-and-swallow that as success.
- **`deletePending` is best-effort and never throws** (`approval-state.ts:138`). Don't rely on its return for control flow; gate on the approved/rejected marker presence.
- **Do not modify `slotter.ts`, `connector.ts`, or the connector implementations** (contract nonGoal line 57). `adjustPlan` only CALLS `planSlots`.
- **`bober approve` writes `.approved.json` but does NOT delete pending** (`approve.ts:74-79`). So a pending marker can coexist with an approved one until `applyPlan` runs `deletePending`. Your `applyPlan` is responsible for the cleanup, mirroring `promote.ts:141`.
