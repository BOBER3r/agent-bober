# Sprint Briefing: Gate the promotion through the approve marker and launch real work

**Contract:** sprint-spec-20260628-do-bridge-2
**Generated:** 2026-06-29T00:00:00.000Z

---

## 0. TL;DR — what Sprint 2 adds (and the one design decision you MUST make)

Sprint 1 shipped `src/do-bridge/` (types/registry/finding-port/coding-promoter) and a **dry-run-only** `bober do` (`src/cli/commands/do.ts:62` `runDo` + `src/cli/commands/do.test.ts`). Sprint 2 fills in **Branch 4** of `runDo` (the real, non-dry-run path):

1. Build the `PromotionPlan` (already works — reuse `promoter(finding)`).
2. Write a pending approval marker `promote-<findingId>.pending.json` via **`savePending`** (reuse `src/state/approval-state.ts:49` — NO new format).
3. Gate: TTY + not `--yes` → `prompts()` confirm; non-TTY → poll `readPending`→approved/rejected (mirror `src/orchestrator/checkpoints/mechanisms/disk.ts:104`); `--yes` short-circuits to approved.
4. On approve → `launcher.launch(plan)` **exactly once** (injected port; default adapter wraps `RunSpawner`), then `findingStore.setPromotion(...)` to set `status='in-progress'` + `promotesTo` ref. Write `saveApproved` + `deletePending`.
5. On reject → `deletePending`, launch ZERO times, finding untouched.

### ⚠️ DESIGN DECISION — `promotesTo` is currently a STRING, sc-2-3 needs an OBJECT
- `src/hub/finding.ts:24` → `promotesTo: z.string().optional()` (a **string**).
- `src/do-bridge/types.ts:42` → `export type PromotionRef = string;` (a **string alias**, comment says "Sprint 3 may add structure").
- BUT **sc-2-3** asserts `promotesTo.runId === runId` and `promotesTo.status === 'launched'` — i.e. an **object** `{kind:'bober-run', runId, launchedAt, status:'launched'}`. The contract description and `definitionOfDone` both describe the object shape.
- **You MUST widen `promotesTo` to the object shape this sprint** (see §2 "PromotionRef widening"). This is an edit to `src/hub/finding.ts` and `src/do-bridge/types.ts` that is NOT in `estimatedFiles` but is required to satisfy sc-2-3 + `sc-2-1` (zero type errors). It is low-risk — every current `promotesTo` use is `undefined` (see §7).

---

## 1. Target Files

### `src/cli/commands/do.ts` (modify)

`runDo` is the DI core. **Branch 4** (lines 104-109) is currently a stub you replace with the real gate+launch flow. Branches 1-3 stay unchanged. Existing signature (do.ts:62-67):

```ts
export async function runDo(
  store: FindingStore,
  registry: PromoterRegistry,
  findingId: string,
  opts: { dryRun?: boolean },
): Promise<void> {
```

**Extend the signature with injected deps + `--yes`**, keeping deps OPTIONAL so the 12 existing Sprint-1 tests (which call `runDo(store, registry, id, { dryRun: true })` with 4 args) still compile and pass — the dry-run/error branches return before deps are touched:

```ts
export interface RunDoDeps {
  launcher: Launcher;                 // src/do-bridge/launcher.ts (new)
  projectRoot: string;
  confirm: () => Promise<boolean>;    // injected TTY confirm (default wraps prompts())
  isTTY?: boolean;                    // default process.stdout.isTTY
  now?: () => string;                 // default () => new Date().toISOString()
  pollMs?: number; timeoutMs?: number;// non-TTY wait knobs (test passes small values)
}
export async function runDo(
  store: FindingStore,
  registry: PromoterRegistry,
  findingId: string,
  opts: { dryRun?: boolean; yes?: boolean },
  deps?: RunDoDeps,                   // OPTIONAL — only the real-launch branch uses it
): Promise<void>
```

Current dry-run/error branches to preserve (do.ts:68-102):
```ts
  const finding = await store.readFinding(findingId);
  if (finding === null) { /* stderr + exitCode 1 + return */ }
  const promoter = registry.resolve({ domain: finding.domain, kind: finding.kind });
  if (promoter === undefined) { /* stderr + exitCode 1 + return */ }
  const plan = promoter(finding);
  if (opts.dryRun) { /* print + return — NO writes */ }
  // ← Branch 4 (real launch) goes HERE; replace the yellow "not implemented" stub
```

**`registerDoCommand` (do.ts:114-147)** must add a `--yes` option and construct the real deps at the CLI boundary (it currently only builds `store`+`registry`):
```ts
    .option("--yes", "Auto-approve the promotion without prompting", false)
```
At the boundary, after building `findingStore`/`registry`, construct the default `Launcher` (RunSpawner-backed) + a `prompts()`-backed confirm and pass them into `runDo` as `deps`. `projectRoot` is already resolved via `resolveRoot()` (do.ts:25). NOTE the file's HARD BOUNDARY comment (do.ts:5-9) says do.ts must not import execa/RunSpawner directly — keep that: import the `Launcher` adapter from `src/do-bridge/launcher.ts` instead (the adapter owns the RunSpawner import).

**Imports do.ts already has:** `chalk`, `Command`, `findProjectRoot` (`../../utils/fs.js`), `loadConfig`, `loadTeam`, `FactStore/factsDbPath/ensureFactsDir` (`../../state/facts.js`), `FindingStore`+`FactStoreFindingStore` (`../../do-bridge/finding-port.js`), `PromoterRegistry`, `codingPromoter`.
**Imported by:** `src/cli/index.ts:45,344` (`registerDoCommand`).
**Test file:** `src/cli/commands/do.test.ts` (EXISTS — extend it).

---

### `src/do-bridge/finding-port.ts` (modify)

Add a write method to the `FindingStore` interface + both implementations. Current interface (finding-port.ts:12-14) and fake (finding-port.ts:42-58):

```ts
export interface FindingStore {
  readFinding(id: string): Promise<Finding | null>;
}
export class InMemoryFindingStore implements FindingStore {
  private readonly map: Map<string, Finding>;
  readonly writes: Finding[] = [];           // tests assert .length for mutation count
  constructor(seed: Finding[] = []) { this.map = new Map(seed.map((f) => [f.id, f])); }
  async readFinding(id: string): Promise<Finding | null> { return this.map.get(id) ?? null; }
}
```

**Add `setPromotion`** (sets `status='in-progress'` + `promotesTo` in ONE call — the only transition this sprint needs):
```ts
export interface FindingStore {
  readFinding(id: string): Promise<Finding | null>;
  /** Link a launched promotion: set promotesTo=ref AND status open->in-progress. */
  setPromotion(id: string, ref: PromotionRef, opts: { now: string }): Promise<Finding | null>;
}
```
- **`FactStoreFindingStore.setPromotion`** → delegate to the hub's existing `transitionFinding` (DO NOT hand-roll a write):
  ```ts
  import { transitionFinding } from "../hub/finding-store.js";
  async setPromotion(id, ref, { now }) {
    return transitionFinding(this.store, id, "in-progress", { now, mutate: { promotesTo: ref } });
  }
  ```
  `transitionFinding` (`src/hub/finding-store.ts:63`) reads the active finding, applies `{...current, ...mutate, status}`, writes via `writeFinding` (reconcile UPDATE/supersede — bitemporal history preserved). Returns the new Finding or `null` if id not found.
- **`InMemoryFindingStore.setPromotion`** → update the map entry, push to `writes`, return it:
  ```ts
  async setPromotion(id, ref, _opts) {
    const cur = this.map.get(id);
    if (cur === undefined) return null;
    const next: Finding = { ...cur, status: "in-progress", promotesTo: ref };
    this.map.set(id, next);
    this.writes.push(next);     // sc-2-3 reads back via readFinding; sc-2-4 asserts writes.length===0 on reject
    return next;
  }
  ```

**Imported by:** `src/cli/commands/do.ts:18-19`, `src/do-bridge/finding-port.test.ts`.
**Test file:** `src/do-bridge/finding-port.test.ts` (EXISTS — see §6 for its exact shape; extend it for setPromotion).

---

### `src/do-bridge/launcher.ts` (create)

**Directory pattern:** `src/do-bridge/` uses kebab-case files, named exports, section headers `// ── Name ──`, JSDoc on every export, and PURE/port separation (see `finding-port.ts`, `registry.ts`). Co-located `*.test.ts`.
**Most similar existing file:** `src/do-bridge/finding-port.ts` (port interface + real adapter + in-memory fake — mirror this exact 3-part shape).
**Structure template:**
```ts
import { RunSpawner } from "../chat/run-spawner.js";
import type { PromotionPlan } from "./types.js";

// ── Launcher port ─────────────────────────────────────────────────────
/** Launches the work behind an approved PromotionPlan. Injected so tests never spawn. */
export interface Launcher {
  launch(plan: PromotionPlan): Promise<{ runId: string; pid?: number }>;
}

// ── RunSpawnerLauncher (default adapter) ──────────────────────────────
export interface RunSpawnerLauncherOptions {
  projectRoot: string;
  findingId: string;                 // for runId = `do-<findingId>-<timestamp>`
  sessionId?: string;                // default e.g. `do-${findingId}`
  now?: () => string;                // default () => new Date().toISOString()
  spawner?: RunSpawner;              // INJECT a RunSpawner for launcher.test.ts (no real execa)
}
export class RunSpawnerLauncher implements Launcher {
  // construct RunSpawner({ projectRoot, sessionId }) unless one is injected
  async launch(plan: PromotionPlan): Promise<{ runId: string; pid?: number }> {
    const runId = `do-${this.findingId}-${this.now()}`;     // generatorNotes
    const ack = await this.spawner.spawn(plan.task, runId);  // run-spawner.ts:97
    return { runId, pid: ack.pid };
  }
}
```
**Why `findingId` lives on the adapter, not in `launch(plan)`:** the port signature is fixed as `launch(plan)` (generatorNotes), but the runId needs the findingId — so pass it at construction. The CLI builds a fresh adapter per `bober do` invocation.

**For `launcher.test.ts`:** inject a fake `RunSpawner` (or use the real `RunSpawner` with an injected fake `spawn` fn — see §6 `makeFakeSpawn`). Assert `spawn` called once with `plan.task` and a `do-...` runId; assert no real process. Sidecar/run-state writes land in a `mkdtemp` temp dir.

---

### `src/do-bridge/promote.ts` (create)

**Purpose (per estimatedFiles):** the gate orchestration — write pending marker → resolve approve/reject → on approve call `launcher.launch` + `store.setPromotion`; on reject `deletePending`. Keep it a PURE-ish DI core (all I/O via injected `projectRoot` paths + `approval-state.ts` functions + injected `confirm`/`now`/`launcher`). `runDo` Branch 4 calls into this. Co-locate `promote.test.ts`.
**Most similar existing file:** the gate/poll loop in `src/orchestrator/checkpoints/mechanisms/disk.ts:104-176` (mirror its readdir-poll → approved/rejected/timeout structure, but reuse `readPending`/the approval-state helpers rather than re-reading raw paths).

Recommended shape:
```ts
import { savePending, readPending, saveApproved, saveRejected, deletePending } from "../state/approval-state.js";
import type { PromotionPlan } from "./types.js";
import type { Launcher } from "./launcher.js";
import type { FindingStore } from "./finding-port.js";

export interface GateOutcome { approved: boolean; }
// writes promote-<findingId>.pending.json, resolves via confirm (TTY) or poll (non-TTY/--yes)
export async function runPromotionGate(args: {
  projectRoot: string; findingId: string; plan: PromotionPlan;
  yes?: boolean; isTTY: boolean; confirm: () => Promise<boolean>;
  now: () => string; pollMs?: number; timeoutMs?: number;
}): Promise<GateOutcome>
```

---

## 2. Patterns to Follow

### Reuse the approval-state marker API (NO new format)
**Source:** `src/state/approval-state.ts:49-59, 106-140`
```ts
export interface PendingMarker {
  checkpointId: string; runId?: string;
  artifact: { type?: string; path?: string; summary?: string; lines?: number };
  prompt: string; requestedAt: string; timeoutAt: string;
}
export async function savePending(projectRoot: string, m: PendingMarker): Promise<void> { /* writes <checkpointId>.pending.json */ }
export async function readPending(projectRoot: string, id: string): Promise<PendingMarker | null> { /* null if absent */ }
export async function saveApproved(projectRoot: string, id: string, m: ApprovedMarker): Promise<void> { /* <id>.approved.json */ }
export async function saveRejected(projectRoot: string, id: string, m: RejectedMarker): Promise<void> { /* <id>.rejected.json */ }
export async function deletePending(projectRoot: string, id: string): Promise<void> { /* best-effort unlink, never throws */ }
```
**Rule:** `checkpointId = `promote-${findingId}``; the file written is `.bober/approvals/promote-<findingId>.pending.json`. Build the `PendingMarker` with `prompt` = a one-line summary of `plan.task`, `runId` optional, `requestedAt`/`timeoutAt` from your injected `now()`, and `artifact: { type: "bober-run", summary: plan.task }`. `ApprovedMarker = { approvedAt, approverId, editDelta? }`, `RejectedMarker = { rejectedAt, rejecterId, feedback }` (approval-state.ts:34-44).

### Non-TTY poll loop (mirror disk.ts)
**Source:** `src/orchestrator/checkpoints/mechanisms/disk.ts:104-159`
```ts
// 2) Poll until resolution OR timeout.
const startedAt = this.now();
return await new Promise<CheckpointOutcome>((resolve, reject) => {
  const tick = async (): Promise<void> => {
    const entries = new Set(await readdir(this.approvalsDir).catch(() => [] as string[]));
    if (entries.has(`${checkpoint}.approved.json`)) { /* read, unlink pending+approved, resolve approved */ return; }
    if (entries.has(`${checkpoint}.rejected.json`)) { /* read, unlink pending+rejected, resolve rejected */ return; }
    if (this.now() - startedAt >= timeoutMs) { /* write timeout, unlink pending, resolve false */ return; }
    pollHandle = setTimeout(() => { tick().catch(reject); }, pollMs);
  };
  pollHandle = setTimeout(() => { tick().catch(reject); }, pollMs);
});
```
**Rule:** In `promote.ts`'s non-TTY branch, poll with `readPending`/readdir on `.bober/approvals` for `promote-<id>.approved.json` vs `.rejected.json` (written by external `bober approve`/`bober reject`). Use a **small injected `pollMs`/`timeoutMs`** in tests so the unit test resolves fast. Always `clearTimeout(pollHandle)` in a `finally` (disk.ts:170-175) — "never leak timers."

### TTY confirm via prompts()
**Source:** `src/cli/commands/rollback.ts:97-106` (the canonical `type:"confirm"` pattern)
```ts
const { confirm } = await prompts({
  type: "confirm",
  name: "confirm",
  message: `Proceed with ${plan.steps.length}-step rollback? ...`,
  initial: false,
});
if (!confirm) { /* cancel path */ }
```
**Rule:** The CLI boundary builds the default `confirm: () => prompts({type:"confirm",...}).then(a => a.confirm === true)` and passes it as a `deps` field. The DI core calls the **injected** `confirm`, so `promote.test.ts`/`do.test.ts` pass a stub returning `true`/`false`. `import prompts from "prompts";` (default import — see run.ts:1, rollback.ts:21). `prompts` + `@types/prompts` are already deps (package.json:71,93).

### RunSpawner construct + spawn
**Source:** `src/chat/run-spawner.ts:71-140`, real construction at `src/chat/chat-session.ts:131-134`
```ts
// construction (chat-session.ts:131):
new RunSpawner({ projectRoot: this.projectRoot, sessionId: this.sessionId });
// spawn (run-spawner.ts:97-131): writes run-state running BEFORE spawn, shells the CLI, records pid sidecar:
async spawn(task: string, runId: string, opts: { careful?: boolean } = {}): Promise<SpawnAck> {
  await writeRunState(cwd, { runId, task, status: "running", startedAt: this.now(), ... });
  const args = [this.cliEntry, "run", task, "--run-id", runId];   // run-spawner.ts:113
  const child = this.spawnFn(this.nodeBin, args, { cwd, detached: true, stdio: "ignore" });
  child.unref();
  await this.sidecar.record(runId, { pid: child.pid, task, spawnedAt: this.now() });
  return { runId, task, pid: child.pid, cwd };
}
```
**Rule:** The default `Launcher` calls `spawner.spawn(plan.task, runId)`. `RunSpawnerOptions` (run-spawner.ts:44-57) accepts injected `spawn`, `cliEntry`, `nodeBin`, `now`, `kill` — use these in `launcher.test.ts` so no real `execa` runs. **Do NOT await pipeline completion** — `spawn` returns immediately (detached); this is the contract's "no blocking runPipeline await" requirement.

### PromotionRef widening (the §0 decision, concretely)
**Source files to edit:** `src/hub/finding.ts:24`, `src/do-bridge/types.ts:42`
- In `src/hub/finding.ts` (the hub OWNS the schema — keep ownership there; do-bridge cannot be imported by hub due to layering): add a Zod object + inferred type, and reference it in `FindingSchema`:
  ```ts
  export const PromotionRefSchema = z.object({
    kind: z.literal("bober-run"),
    runId: z.string().min(1),
    launchedAt: z.string().datetime(),
    status: z.enum(["launched", "completed", "aborted"]),
  });
  export type PromotionRef = z.infer<typeof PromotionRefSchema>;
  // in FindingSchema:
  promotesTo: PromotionRefSchema.optional(),   // was z.string().optional()
  ```
- In `src/do-bridge/types.ts:42`, replace `export type PromotionRef = string;` with a re-export so existing do-bridge importers keep working:
  ```ts
  export type { PromotionRef } from "../hub/finding.js";
  ```
**Rule:** This satisfies sc-2-3 (`promotesTo.runId`, `promotesTo.status`) AND `sc-2-1` (tsc clean) because `transitionFinding`'s `JSON.stringify(finding)` round-trips the object and `FindingSchema.parse` validates it. The on-launch ref you build is `{ kind:"bober-run", runId, launchedAt: now(), status:"launched" }`.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `savePending` | `src/state/approval-state.ts:49` | `(projectRoot, m: PendingMarker) => Promise<void>` | Write `promote-<id>.pending.json` |
| `readPending` | `src/state/approval-state.ts:64` | `(projectRoot, id) => Promise<PendingMarker \| null>` | Read pending marker (null if absent) |
| `saveApproved` | `src/state/approval-state.ts:106` | `(projectRoot, id, m: ApprovedMarker) => Promise<void>` | Write `<id>.approved.json` |
| `saveRejected` | `src/state/approval-state.ts:122` | `(projectRoot, id, m: RejectedMarker) => Promise<void>` | Write `<id>.rejected.json` |
| `deletePending` | `src/state/approval-state.ts:138` | `(projectRoot, id) => Promise<void>` | Best-effort unlink pending (never throws) |
| `pendingExists` | `src/state/approval-state.ts:145` | `(projectRoot, id) => Promise<boolean>` | Guard used by approve/reject CLI |
| `transitionFinding` | `src/hub/finding-store.ts:63` | `(store, id, newStatus, {now, mutate?}) => Promise<Finding \| null>` | Status+field UPDATE via reconcile (use for setPromotion real adapter) |
| `readFindings` | `src/hub/finding-store.ts:45` | `(store) => Finding[]` | Read active hub findings |
| `RunSpawner` | `src/chat/run-spawner.ts:61` | `new RunSpawner(opts).spawn(task, runId)` | Detached `agent-bober run` launch |
| `codingPromoter` | `src/do-bridge/coding-promoter.ts:25` | `(finding) => PromotionPlan` | Already wired in do.ts |
| `PromoterRegistry.resolve` | `src/do-bridge/registry.ts:43` | `({domain, kind?}) => Promoter \| undefined` | Already wired in do.ts |
| `ensureDir` | `src/state/helpers.ts:6` | `(dirPath) => Promise<void>` | savePending calls this internally — you don't need it directly |
| `findProjectRoot` | `src/utils/fs.ts` | `() => Promise<string \| null>` | Already used in do.ts:25 |

Utilities reviewed: `src/state/` (approval-state, helpers, facts, run-state), `src/hub/` (finding-store), `src/do-bridge/`, `src/chat/` (run-spawner). No new helper is needed — the gate is composition of the above.

---

## 4. Prior Sprint Output

### Sprint 1: do-bridge types + registry + finding-port + coding-promoter + dry-run CLI (commit 8370612)
**Created:**
- `src/do-bridge/types.ts` — `PromoterKey`, `PromotionPlan {kind:'bober-run', task, teamId?}`, `PromotionRef` (currently `= string` — widen this sprint, §2), `Promoter = (finding) => PromotionPlan`, `FindingKind`.
- `src/do-bridge/registry.ts` — `PromoterRegistry` with `register`/`resolve` (precedence domain+kind > domain-only > undefined).
- `src/do-bridge/finding-port.ts` — `FindingStore` (read-only so far), `FactStoreFindingStore` adapter, `InMemoryFindingStore` fake with a `writes` tracker.
- `src/do-bridge/coding-promoter.ts` — `codingPromoter`, `isCodingDomain`.
- `src/cli/commands/do.ts` — `runDo` DI core (dry-run + error branches done; Branch 4 stub) + `registerDoCommand`.
- `src/cli/commands/do.test.ts` — 12 tests for dry-run/error/unknown-id paths (call `runDo` with 4 args).

**Connection to this sprint:** Reuse ALL of the above unchanged except: extend `FindingStore` (+`setPromotion`), widen `PromotionRef`, fill `runDo` Branch 4, add `--yes`. The `InMemoryFindingStore.writes` tracker is your sc-2-3/sc-2-4 assertion surface (0 writes on reject, 1 write on approve).

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM + `.js` extensions** on all imports (NodeNext). `"type": "module"`.
- **`import type { ... }`** — `consistent-type-imports` is enforced (hard lint gate). Import `Launcher`, `PromotionPlan`, `Finding`, `PromotionRef`, `FindingStore` as types.
- **No synchronous fs** — `node:fs/promises` only (approval-state already complies).
- **Zod for validation** — the promotesTo widening uses Zod (don't hand-roll).
- **Section headers** `// ── Name ──────`; small focused modules; JSDoc exports.
- **Collocated tests** `*.test.ts` next to source; **real temp dirs, no fs mocks** (`mkdtemp(join(tmpdir(), ...))` + `rm` cleanup — see §6).
- **Prefix unused params with `_`** (e.g. `_opts` in the in-memory `setPromotion`).

### Architecture / convention: handler never throws
**Source:** `src/cli/commands/do.ts:1-9, 70-88, 138-145` and the generatorNotes' "memory.ts pattern": CLI handlers set `process.exitCode = 1` and `return` — never `throw`. The outer `try/catch` in `registerDoCommand` (do.ts:138) converts unexpected errors to `exitCode=1`. Keep `runDo`/`promote.ts` failure branches on this pattern.

### Other Docs
No `CLAUDE.md`/`CONTRIBUTING.md` coding-guideline file in repo root governs this module beyond `.bober/principles.md`. No dedicated ADR for do-bridge under `.bober/architecture/`.

---

## 6. Testing Patterns

### Unit Test Pattern — do-bridge port tests
**Source:** `src/do-bridge/finding-port.test.ts:1-55`
```ts
import { describe, it, expect } from "vitest";
import { FactStore } from "../state/facts.js";
import { writeFinding } from "../hub/finding-store.js";
import { FactStoreFindingStore, InMemoryFindingStore } from "./finding-port.js";
import type { Finding } from "../hub/finding.js";

const T = "2026-06-28T00:00:00.000Z";
const SAMPLE_FINDING: Finding = { id:"abc123def456abc1", domain:"coding", title:"fix the CI build",
  kind:"action", urgency:3, severity:2, evidence:["..."], surfacedAt:T, tags:[], status:"open" };

it("reads back a persisted finding by id", async () => {
  const store = new FactStore(":memory:");                 // real in-mem SQLite — NO fs mock
  await writeFinding(store, SAMPLE_FINDING, { now: T });
  const port = new FactStoreFindingStore(store);
  const result = await port.readFinding(SAMPLE_FINDING.id);
  expect(result!.id).toBe(SAMPLE_FINDING.id);
  store.close();                                            // always close
});
```
**For setPromotion (extend this file):** with `FactStore(":memory:")`, write a finding, call `port.setPromotion(id, { kind:"bober-run", runId:"r1", launchedAt:T, status:"launched" }, { now:T })`, then `readFinding(id)` and assert `status==="in-progress"` and `promotesTo.runId==="r1"`. For the fake: `new InMemoryFindingStore([f])`, call setPromotion, assert `store.writes.length===1` and the read-back object.

### Unit Test Pattern — runDo with injected fakes (the sc-2 tests)
**Source:** existing `src/cli/commands/do.test.ts:1-87` (process.exitCode reset + stdout spy)
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runDo } from "./do.js";
import { InMemoryFindingStore } from "../../do-bridge/finding-port.js";
import { PromoterRegistry } from "../../do-bridge/registry.js";
import { codingPromoter } from "../../do-bridge/coding-promoter.js";

beforeEach(() => { process.exitCode = 0; });
afterEach(() => { vi.restoreAllMocks(); /* restore process.exitCode */ });

// Fake Launcher — records calls, returns a deterministic runId, never spawns:
function makeFakeLauncher(runId = "do-x-1") {
  const calls: PromotionPlan[] = [];
  const launcher: Launcher = { async launch(plan) { calls.push(plan); return { runId, pid: 4242 }; } };
  return { launcher, calls };
}

it("sc-2-2/sc-2-3: approve → launch once → link runId + in-progress", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "bober-do-"));   // real temp dir for markers
  const store = new InMemoryFindingStore([CODING_FINDING]);
  const { launcher, calls } = makeFakeLauncher("do-abc-123");
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);

  await runDo(store, buildCodingRegistry(), CODING_FINDING.id, { yes: true }, {
    launcher, projectRoot, confirm: async () => true, isTTY: false, now: () => "2026-06-28T00:00:00.000Z",
  });

  expect(calls).toHaveLength(1);                                    // launch exactly once
  expect(calls[0].task).toBe(CODING_FINDING.title);                // promoter's task
  const f = await store.readFinding(CODING_FINDING.id);
  expect(f!.status).toBe("in-progress");
  expect(f!.promotesTo).toMatchObject({ runId: "do-abc-123", status: "launched" });
  // marker side-effects: promote-<id>.approved.json exists, .pending.json removed
  await rm(projectRoot, { recursive: true, force: true });
});
```
**For sc-2-4 (reject):** pass `confirm: async () => false` (and `yes:false`, `isTTY:true`), assert `calls.length===0`, `store.writes.length===0`, `(await store.readFinding(id))!.status==="open"`, and that `promote-<id>.pending.json` no longer exists (`deletePending` ran).
**Temp-dir + fake-spawn helpers source:** `src/chat/run-spawner.test.ts:1-35` (`mkdtemp`/`rm` in `beforeEach`/`afterEach`, `makeFakeSpawn` records `calls`):
```ts
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-spawner-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });
function makeFakeSpawn(pid = 4242) {
  const calls: Array<{file:string; args:string[]; options:unknown}> = [];
  const spawn = (file, args, options) => { calls.push({file,args,options}); return { pid, unref(){} }; };
  return { spawn, calls };
}
```
**Runner:** vitest. **Assertion style:** `expect(...)`. **Mock approach:** dependency injection + `vi.spyOn(process.stdout/stderr,"write")`; real `mkdtemp` temp dirs (NO fs mocks per principles). **File naming:** `*.test.ts` collocated.

### E2E Test Pattern
Not applicable — no Playwright in this repo; `bober do` is a CLI. sc-2-5 is a **manual** criterion (run in a real non-TTY shell, `bober approve promote-<id>`). The approve/reject CLI already resolves `promote-<id>` markers via `pendingExists` (approve.ts:44, reject.ts:44) — confirm your `checkpointId` is exactly `promote-<findingId>` so the external commands line up.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/commands/do.test.ts` | `runDo` signature | medium | Add an OPTIONAL 5th `deps` param + `yes` in opts so the 12 existing 4-arg calls still compile (they only hit dry-run/error branches). |
| `src/do-bridge/finding-port.test.ts` | `FindingStore` interface | low | Adding `setPromotion` doesn't break existing read tests; ADD new tests for it. |
| `src/hub/finding.test.ts` | `FindingSchema.promotesTo` | low | Lines 20, 95 set/destructure `promotesTo: undefined` — still valid after widening (field stays `.optional()`). |
| `src/hub/finding-store.test.ts` | `FindingSchema.promotesTo` | low | Line 55 asserts `promotesTo` `toBeUndefined()` on a finding with no promotesTo — still passes. |
| `src/hub/task-inbox.ts` | `FindingSchema.promotesTo` | none | Line 45 only OMITS promotesTo (comment); no read. |
| `src/medical/analysis/finding.ts` | its OWN `promotesTo?: string` | none | SEPARATE type (medical analysis Finding), NOT the hub Finding — widening hub does NOT touch it. |
| `src/cli/index.ts` | `registerDoCommand` | low | `--yes` option is additive; no signature change to the exported registrar. |

### Existing Tests That Must Still Pass
- `src/cli/commands/do.test.ts` — 12 dry-run/error/unknown-id tests; verify still pass after the signature extension (deps optional).
- `src/do-bridge/finding-port.test.ts` — read-path + `writes`-empty tests; the `writes`-stays-empty tests (lines 73-83) are about *reads* not mutating — still valid.
- `src/hub/finding.test.ts`, `src/hub/finding-store.test.ts` — promotesTo widening must not break them (all current values undefined).
- `src/chat/run-spawner.test.ts` — you reuse but do not modify `RunSpawner`; must stay green.

### Features That Could Be Affected
- **Hub Findings (the shared FindingSchema)** — the `promotesTo` widening is the only cross-module change. Every current writer sets it `undefined`, so reconcile/round-trip is unaffected. This is the canonical hub schema imported by task-inbox/medical/priority-hub — keep it a *widening* (string→object, still optional), never a narrowing.
- **`bober approve`/`bober reject` CLI** — reused as-is for sc-2-5; they resolve any `<checkpointId>.pending.json`, so `promote-<id>` Just Works.

### Recommended Regression Checks
1. `npm run build` — zero tsc errors (sc-2-1), especially after the promotesTo widening + runDo signature change.
2. `npm test -- src/do-bridge` — approve path launches once + links runId + in-progress; reject path launches zero + status stays 'open' + pending removed (stopConditions).
3. `npm test -- src/cli/commands/do.test.ts` — all 12 Sprint-1 tests still green.
4. `npm test -- src/hub/finding` — finding + finding-store schema tests still green after widening.
5. `npm run lint` — `consistent-type-imports` + unused-var gates (use `import type`, `_`-prefix unused params).

---

## 8. Implementation Sequence

1. **`src/hub/finding.ts`** — add `PromotionRefSchema` + `export type PromotionRef`; change `promotesTo` to `PromotionRefSchema.optional()`.
   - Verify: `npm test -- src/hub/finding` green; `npx tsc --noEmit` clean for hub.
2. **`src/do-bridge/types.ts`** — replace `PromotionRef = string` with `export type { PromotionRef } from "../hub/finding.js";`.
   - Verify: no do-bridge importer of `PromotionRef` breaks.
3. **`src/do-bridge/finding-port.ts`** — add `setPromotion` to interface + `FactStoreFindingStore` (delegate to `transitionFinding`) + `InMemoryFindingStore` (mutate map + push `writes`).
   - Verify: tsc clean; the fake returns updated finding with `promotesTo` object + `status:'in-progress'`.
4. **`src/do-bridge/launcher.ts`** — `Launcher` port + `RunSpawnerLauncher` adapter (runId `do-<findingId>-<ts>`, injectable `spawner`/`now`).
   - Verify: `launcher.test.ts` injects fake spawn → `spawn` called once with `plan.task`; no real execa.
5. **`src/do-bridge/promote.ts`** — `runPromotionGate`: `savePending` → (`--yes`→approve) / (TTY→`confirm()`) / (non-TTY→poll readPending+readdir) → `saveApproved`+`deletePending` or `saveRejected`+`deletePending`.
   - Verify: `promote.test.ts` (temp dir) — approve writes `.approved.json` + removes pending; reject removes pending; poll resolves on an externally written `.approved.json`.
6. **`src/cli/commands/do.ts`** — extend `runDo` signature with `opts.yes` + optional `deps`; implement Branch 4: build ref `{kind:'bober-run',runId,launchedAt,status:'launched'}`, call `runPromotionGate`; on approve `launcher.launch(plan)` then `store.setPromotion(id, ref, {now})`; on reject return (gate already deleted pending). Add `--yes` option + construct real `Launcher`+`confirm` in `registerDoCommand`.
   - Verify: handler never throws; dry-run/error branches unchanged.
7. **`src/cli/commands/do.test.ts`** + **`src/do-bridge/*.test.ts`** — add sc-2-2/2-3/2-4 tests (fake Launcher, confirm stub, temp dir).
   - Verify: launch-once / launch-zero / link / no-mutation / marker presence+removal.
8. **Run full verification** — `npm run build`, `npm test -- src/do-bridge src/cli/commands/do.test.ts src/hub/finding`, `npm run lint`.

---

## 9. Pitfalls & Warnings

- **`promotesTo` is a STRING today** (`src/hub/finding.ts:24`) — sc-2-3 needs an object. You MUST widen it (§2). Do NOT just `JSON.stringify` into the string field; `finding.promotesTo.runId` must type-check (sc-2-1).
- **The orchestrator's spawn note claims `PromotionRef` is already an object — it is NOT.** The committed `src/do-bridge/types.ts:42` is `export type PromotionRef = string;`. Trust the file, not the summary; widen it.
- **Do NOT mark the finding `'done'`** — that's Sprint 3 (terminal reconciliation). This sprint only does `open → in-progress`.
- **Do NOT `await runPipeline` in-process** — launch detached via `RunSpawner.spawn` (returns immediately). No blocking pipeline call in `do`.
- **The Launcher MUST be injected** into `runDo`/the gate so unit tests use a fake and never run real `execa`. `do.ts` itself must keep its HARD BOUNDARY (do.ts:5-9): no direct execa/RunSpawner import — the RunSpawner import lives in `launcher.ts`.
- **Reuse `approval-state.ts` ONLY** — no new pending/approved/rejected format. `checkpointId = `promote-${findingId}`` exactly, so external `bober approve promote-<id>` (approve.ts) resolves it (sc-2-5).
- **`deletePending` is best-effort** (approval-state.ts:138 — swallows errors). On reject, call it and return; don't assert it threw.
- **Keep the new `deps` param OPTIONAL** on `runDo` or the 12 existing Sprint-1 tests (4-arg calls) fail to compile (sc-2-1).
- **Poll timers:** in the non-TTY branch, `clearTimeout` in a `finally` (disk.ts:170-175) and use small injected `pollMs`/`timeoutMs` in tests so they don't hang.
- **`InMemoryFindingStore.writes`** is the mutation-count assertion surface: push to it in `setPromotion` so sc-2-4 can assert `writes.length===0` on reject and sc-2-2/2-3 can assert exactly one mutation on approve.
- **Use `import type`** for `Launcher`, `PromotionPlan`, `PromotionRef`, `Finding`, `FindingStore` (lint gate), and `_`-prefix the unused `opts` in the in-memory `setPromotion`.
