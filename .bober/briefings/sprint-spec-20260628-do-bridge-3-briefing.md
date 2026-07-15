# Sprint Briefing: Reconcile promotion outcome to done and prove registry extensibility

**Contract:** sprint-spec-20260628-do-bridge-3
**Generated:** 2026-06-29T00:00:00.000Z

> Final sprint of the do-bridge plan. Sprints 1 & 2 are DONE on this branch.
> You are ADDING: `src/do-bridge/reconcile.ts` (+test), a `--reconcile` flag on
> `bober do`, a second STUB promoter (to prove the registry extends), and
> `docs/do-bridge.md`. Build ON the existing files — do not rebuild them.
>
> HARD INVARIANT (carried from Sprint 2): `src/hub/finding.ts` is BYTE-UNCHANGED.
> `FindingSchema.promotesTo` stays `z.string().optional()`. The `PromotionRef`
> object is serialized to a JSON string in that field. Do NOT edit `src/hub/finding.ts`.

---

## 1. Target Files

### src/do-bridge/reconcile.ts (create)

**Directory pattern:** `src/do-bridge/` uses kebab-case filenames, section headers
`// ── Name ─────`, `import type` for types, `.js` import extensions, named exports,
JSDoc on every exported symbol. See `coding-promoter.ts`, `promote.ts`, `launcher.ts`.

**Most similar existing file for the DI-core + injected-I/O shape:** `src/do-bridge/promote.ts`
(injected `now`, never reads the real clock, never throws — failures surface as the
caller's concern). Also mirror the DI split in `src/cli/commands/do.ts:90` `runDo()`
(a pure core that accepts injected ports + a thin CLI wrapper that builds the real ports).

**What reconcile must do (from contract description + generatorNotes):**
- Iterate findings whose `promotesTo.status === 'launched'` (via the FindingStore port — see §3).
- For each, read the linked run's state via `readRunState(projectRoot, ref.runId)` (§ run-state below).
- Map `RunState.status` → finding transition:
  - `'completed'` → transition finding to `'done'` (supersede) AND set `promotesTo.status='completed'`.
  - `'aborted'` or `'failed'` → return finding to `'open'` AND set `promotesTo.status='aborted'`.
  - `'running'` (or `null`/missing run-state, or any other status) → leave the finding UNCHANGED.
- NEVER throw on a missing/corrupt run-state — `readRunState` already returns `null` on any failure; treat `null` as "leave unchanged".

**Recommended DI signature** (so sc-3-2/sc-3-3 can inject a run-state fake without a real run):
```ts
export interface ReconcileDeps {
  store: FindingStore;
  /** Injected run-state reader. CLI passes (runId) => readRunState(projectRoot, runId). */
  readState: (runId: string) => Promise<RunState | null>;
  now: () => string;
}
export interface ReconcileSummary {
  completed: number;
  aborted: number;
  unchanged: number;
}
/** PURE-ish: all I/O injected. Never throws — per-finding failures are swallowed. */
export async function reconcilePromotions(deps: ReconcileDeps): Promise<ReconcileSummary> { ... }
```
Then a thin wrapper the CLI calls:
```ts
export async function reconcilePromotionsForRoot(
  projectRoot: string, store: FindingStore, now: () => string,
): Promise<ReconcileSummary> {
  return reconcilePromotions({
    store,
    readState: (runId) => readRunState(projectRoot, runId),
    now,
  });
}
```
The contract phrases it as `reconcilePromotions(projectRoot)`; the DI core + a
projectRoot wrapper satisfies both the contract and the unit-test fakes. Pick names
you like, but KEEP the injected `readState` seam — sc-3-2/sc-3-3 depend on it.

**Imports this file will need:**
- `import type { FindingStore } from "./finding-port.js";`
- `import type { PromotionRef } from "./types.js";`
- `import { readRunState } from "../state/run-state.js";`
- `import type { RunState } from "../mcp/run-manager.js";`  (RunState lives in run-manager, re-typed by run-state.ts)

---

### src/do-bridge/finding-port.ts (modify — ADDITIVE only)

The current port (full interface, `finding-port.ts:40-53`) has only TWO methods:
```ts
export interface FindingStore {
  readFinding(id: string): Promise<DoFinding | null>;          // line 42
  setPromotion(id: string, ref: PromotionRef,                  // line 48
    opts: { now: string }): Promise<DoFinding | null>;         // → ALWAYS sets status 'in-progress'
}
```
`setPromotion` HARD-CODES `status: "in-progress"` in BOTH adapters
(`finding-port.ts:81` transitionFinding(..., "in-progress", ...) and
`finding-port.ts:123` `{ ...cur, status: "in-progress", promotesTo: ref }`).
Reconcile needs to set `'done'` and `'open'` too, and it needs to LIST launched
findings. So you must add two methods. KEEP existing methods byte-identical (the
12 Sprint-1/2 tests in `do.test.ts`, `finding-port.test.ts` call them).

**Add to the interface (additive — does not break Sprint 1/2 types):**
```ts
/** Return all findings that currently carry a PromotionRef (promotesTo defined). */
listPromoted(): Promise<DoFinding[]>;

/**
 * Transition a finding to an arbitrary status AND overwrite its promotesTo ref,
 * in one supersede-aware write. Used by reconcile for done/open outcomes.
 * Returns the updated DoFinding, or null if the id does not exist.
 */
applyOutcome(
  id: string,
  status: Finding["status"],
  ref: PromotionRef,
  opts: { now: string },
): Promise<DoFinding | null>;
```
**FactStoreFindingStore implementations** (mirror existing `finding-port.ts:70-86`):
```ts
async listPromoted(): Promise<DoFinding[]> {
  return readFindings(this.store).map(toDoFinding).filter((f) => f.promotesTo !== undefined);
}
async applyOutcome(id, status, ref, { now }) {
  const result = await transitionFinding(this.store, id, status, {
    now,
    mutate: { promotesTo: serializePromotionRef(ref) },
  });
  return result !== null ? toDoFinding(result) : null;
}
```
`transitionFinding` (`src/hub/finding-store.ts:63-74`) ALREADY does supersede:
"subject=id and predicate='finding' are unchanged but the value differs, so
reconcileFact takes the UPDATE branch (supersede old + insert new), preserving the
prior row as bitemporal history." The underlying supersede is `FactStore.supersedeFact`
(`src/state/facts.ts:295`). So routing 'done' through `transitionFinding` IS the
"Completion = supersede" requirement — no distinct done-path is needed.

**InMemoryFindingStore implementations** (mirror existing `finding-port.ts:102-128`,
note it stores the PromotionRef OBJECT directly and pushes to `writes`):
```ts
async listPromoted(): Promise<DoFinding[]> {
  return [...this.map.values()].filter((f) => f.promotesTo !== undefined);
}
async applyOutcome(id, status, ref, _opts) {
  const cur = this.map.get(id);
  if (cur === undefined) return null;
  const next: DoFinding = { ...cur, status, promotesTo: ref };
  this.map.set(id, next);
  this.writes.push(next);
  return next;
}
```

**Imported by:** `src/cli/commands/do.ts:19-20`, `src/cli/commands/do.test.ts:6`,
`src/do-bridge/finding-port.test.ts:4`. Adding methods does not break these.

**Test file:** `src/do-bridge/finding-port.test.ts` (exists, 193 lines).

---

### src/cli/commands/do.ts (modify)

Wire the `--reconcile` flag + a best-effort start-of-command reconcile.
The command + handler is `registerDoCommand` (`do.ts:204-259`). Current options
are `--dry-run` and `--yes` (`do.ts:208-209`). The handler builds the store +
registry at `do.ts:211-223`.

**Add the flag:** `.option("--reconcile", "Reconcile launched promotions to their run outcome and exit", false)`

**Branch the action handler:**
- If `opts.reconcile === true` → reconcile-only: build store + findingStore, call
  `reconcilePromotionsForRoot(projectRoot, findingStore, now)`, print a one-line
  summary, `store.close()`, RETURN (do not run the normal promote path).
- Else (normal `bober do <id>`) → call reconcile BEST-EFFORT first (wrapped in
  try/catch that NEVER aborts the command — mirror seedProjectFacts §2 below), then
  proceed to `runDo(...)` exactly as today.

**Registry registration is at `do.ts:220-222`** — this is the exact register() call
site `docs/do-bridge.md` must name (see §5). Today:
```ts
const registry = new PromoterRegistry();
registry.register({ domain: "coding" }, codingPromoter);
registry.register({ domain: "projects" }, codingPromoter);
```

**Test file:** `src/cli/commands/do.test.ts` (exists, 384 lines).

---

### src/do-bridge/registry.test.ts (modify) + docs/do-bridge.md (create)

Add the sc-3-4 second-stub-promoter + fail-closed tests to `registry.test.ts`
(see §6). Create `docs/do-bridge.md` mirroring `docs/chat-steer.md` (see §5).

---

## 2. Patterns to Follow

### Best-effort start-of-command try/catch (the reconcile MUST mirror this)
**Source:** `src/orchestrator/pipeline.ts:979-987`
```ts
// ── Sprint 5: deterministic project-fact auto-producer (best-effort) ──
// A facts failure must NEVER abort a pipeline run.
try {
  await seedProjectFacts(projectRoot, team.memoryNamespace || undefined);
} catch (err) {
  logger.warn(
    `Project-fact seeding skipped: ${err instanceof Error ? err.message : String(err)}`,
  );
}
```
`logger` is `import { logger } from "../utils/logger.js"` (`pipeline.ts:58`). From
`do.ts` the path is `../../utils/logger.js`. Inside the normal `bober do` handler,
wrap the reconcile call in exactly this try/catch shape so a missing/corrupt
run-state can never abort the promote. `reconcilePromotions` itself should ALSO
swallow per-finding errors internally (belt and suspenders).
**Rule:** A reconcile failure must NEVER set exitCode or throw out of `bober do`.

### readRunState — already null-safe, never throws
**Source:** `src/state/run-state.ts:61-68`
```ts
export async function readRunState(projectRoot: string, runId: string): Promise<RunState | null> {
  try {
    const raw = await readFile(statePath(projectRoot, runId), "utf-8");
    return JSON.parse(raw) as RunState;
  } catch {
    return null;          // missing file OR invalid JSON → null (never throws)
  }
}
```
**Rule:** Treat a `null` return as "no terminal info yet → leave the finding
unchanged". This is how reconcile "never throws on a missing/corrupt run-state".

### RunState shape + the status values reconcile maps
**Source:** `src/mcp/run-manager.ts:35-64` (RunState is defined here; run-state.ts re-exports the type via import)
```ts
export interface RunState {
  runId: string;
  task: string;
  status: "running" | "completed" | "failed" | "aborted" | "input-required" | "paused";
  startedAt: string;
  completedAt?: string;
  abortedAt?: string;
  abortReason?: string;
  progress: RunProgress;
  result?: RunResult;
  error?: string;
  projectRoot: string;
  // ... worktreePath/branch/pending* fields omitted — reconcile only reads .status
}
```
**Rule:** Switch ONLY on `.status`. `completed` → done. `aborted`/`failed` → open.
Everything else (`running`, `input-required`, `paused`, or `null` state) → no-op.
(Assumption from contract: RunSpawner writes running→aborted at run-spawner.ts:160-167;
the pipeline writes `completed`/`failed` — see run-manager.ts:207/231.)

### DI-core + injected-clock module shape
**Source:** `src/do-bridge/promote.ts:66-77` (destructure injected deps, default the clock)
```ts
export async function runPromotionGate(args: PromotionGateArgs): Promise<GateOutcome> {
  const { projectRoot, findingId, plan, yes = false, isTTY, confirm, now, ... } = args;
```
**Rule:** Inject `now` and the run-state reader; never call `new Date()` in the core.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `readRunState` | `src/state/run-state.ts:61` | `(projectRoot, runId) => Promise<RunState\|null>` | Null-safe read of `.bober/runs/<runId>/state.json`. USE THIS for the run lookup. |
| `listRunStateFiles` | `src/state/run-state.ts:78` | `(projectRoot) => Promise<RunState[]>` | Enumerate all run states (NOT needed — you iterate findings, not runs). |
| `transitionFinding` | `src/hub/finding-store.ts:63` | `(store, id, newStatus, {now, mutate?}) => Promise<Finding\|null>` | Supersede-aware status+field UPDATE. The done/open write path. |
| `readFindings` | `src/hub/finding-store.ts:45` | `(store) => Finding[]` | Read all active hub findings (used by FactStoreFindingStore.listPromoted). |
| `supersedeFact` | `src/state/facts.ts:295` | `(id, tInvalidated, tInvalid) => boolean` | The bitemporal close behind transitionFinding. Do NOT call directly — go through the port. |
| `serializePromotionRef` | `src/do-bridge/types.ts:52` | `(ref) => string` | Object→JSON-string for on-disk promotesTo. |
| `parsePromotionRef` | `src/do-bridge/types.ts:60` | `(s) => PromotionRef\|null` | JSON-string→object; null on bad JSON. |
| `PromoterRegistry` | `src/do-bridge/registry.ts:31` | `.register(key, promoter)`, `.resolve(key) => Promoter\|undefined` | Domain+kind > domain-only > undefined resolution. |
| `codingPromoter` | `src/do-bridge/coding-promoter.ts:25` | `(finding) => PromotionPlan` | The existing coding/projects promoter (your STUB mirrors its signature). |
| `logger` | `src/utils/logger.ts` | `.warn(msg)` etc. | Best-effort warn channel for the swallowed reconcile failure. |

**Utilities reviewed:** `src/state/`, `src/hub/`, `src/do-bridge/`, `src/utils/`.
The `PromotionRef.status` union (`types.ts:48`) ALREADY includes `'completed'` and
`'aborted'` — reconcile sets those values with NO type change.

---

## 4. Prior Sprint Output

### Sprint 1 (8370612)
**Created:** `src/do-bridge/{types,registry,finding-port,coding-promoter}.ts` + `src/cli/commands/do.ts` (dry-run).
**Connection:** `PromoterRegistry.resolve` precedence (domain+kind > domain-only > undefined)
is what sc-3-4's fail-closed assertion exercises. `codingPromoter` is the signature
your second STUB promoter copies.

### Sprint 2 (cf33acb)
**Created:** `src/do-bridge/launcher.ts` (Launcher port + RunSpawnerLauncher), `promote.ts` (runPromotionGate).
**Extended `types.ts`:** structured `PromotionRef { kind:'bober-run', runId, launchedAt, status:'launched'|'completed'|'aborted' }`
plus `serializePromotionRef`/`parsePromotionRef`.
**Extended `finding-port.ts`:** `DoFinding` view + `setPromotion(id, ref, {now})` on the
`FindingStore` interface and BOTH adapters.
**Connection:** Sprint 3 reads `promotesTo` as a parsed `PromotionRef` object (via the
port), filters `status==='launched'`, and writes back `status:'completed'|'aborted'`
through the same supersede path. The real launch path that produces a `'launched'`
ref is `do.ts:175-184`.
**INVARIANT:** `src/hub/finding.ts` is BYTE-UNCHANGED — `promotesTo` is `z.string().optional()`
(`finding.ts:24`); the ref is JSON-serialized into that string. KEEP THIS in Sprint 3.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM everywhere** — every import uses a `.js` extension (NodeNext). (line 27)
- **`import type`** for types — ESLint `consistent-type-imports` is enforced. (line 35)
- **No `any` without justification**; prefer `unknown` + narrowing. (line 40)
- **No synchronous fs** — use `node:fs/promises` (run-state.ts already does). (line 42)
- **Section comments** with unicode box headers `// ── Name ─────`. (line 32)
- **Tests collocated** `*.test.ts` next to `*.ts`, Vitest. (line 20)
- **Unused params** must be `_`-prefixed (see `_opts` in finding-port.ts:119). (line 36)
- **Conventional commits**; sprint commits use `bober(sprint-N): description`. (line 34)
- **Zero type errors + zero lint errors are hard gates** (sc-3-1 is `npm run build`). (line 18-21)

### Architecture Decisions
No `.bober/architecture/` ADR is specific to do-bridge. The governing decisions are in
the contract `assumptions`: run terminal state via `readRunState`; "Completion =
supersede" (research §3a line 131); best-effort reconcile mirrors `seedProjectFacts`.

### docs/do-bridge.md template (mirror docs/chat-steer.md — 204 lines, NOT teams.md's 946)
**Source structure:** `docs/chat-steer.md:1-18` opens with a 1-paragraph intro + a
"See the research document …" pointer + `---` separators, then `##` sections.
The doc MUST (sc-3-5) document the PromoterRegistry extension point. Suggested sections:
```
# Do-Bridge: Promote a Finding into Real Work
<1-para intro: `bober do <id>` promotes a hub Finding to a `bober run` task; reconcile closes the loop.>
---
## The Promoter Registry Extension Point
   - Name the EXACT register() call site: src/cli/commands/do.ts:220-222
   - Show the Promoter interface: `export type Promoter = (finding: Finding) => PromotionPlan;` (src/do-bridge/types.ts:74)
   - Show the PromoterKey shape: `{ domain: string; kind?: FindingKind }` (src/do-bridge/types.ts:15)
   - Worked example: how a future MEDICAL or FINANCIAL maintainer adds
     `registry.register({ domain: "medical" }, medicalPromoter);` at that call site.
   - State the resolution precedence (domain+kind > domain-only > undefined) and that
     an unregistered (domain,kind) FAILS CLOSED (bober do exits non-zero naming the domain).
## Reconciling Launched Promotions
   - `bober do --reconcile` reads each launched run's state.json and advances the Finding.
   - Mapping table: completed→done, aborted/failed→open, running→unchanged.
## Related
   - docs/teams.md (team ids referenced via the `team:<id>` tag), docs/chat-steer.md (approval markers).
```

---

## 6. Testing Patterns

### Unit Test Pattern (Vitest, collocated)
**Source:** `src/do-bridge/finding-port.test.ts:1-21` and `src/cli/commands/do.test.ts:1-26`
```ts
import { describe, it, expect } from "vitest";
const T = "2026-06-28T00:00:00.000Z";
const SAMPLE_FINDING: Finding = {
  id: "abc123def456abc1", domain: "coding", title: "fix the CI build", kind: "action",
  urgency: 3, severity: 2, evidence: [], surfacedAt: T, tags: [], status: "open",
};
```
**Runner:** vitest · **Assertion:** `expect(...).toBe / .toMatchObject / .toBeNull` ·
**Mocks:** plain inline fakes (no `vi.mock` for ports); `vi.spyOn(process.stdout,"write",...)`
for CLI stdout capture (see do.test.ts:67-71) · **File naming:** `<name>.test.ts` collocated.

### Run-state FAKE pattern (the heart of sc-3-2 / sc-3-3 — NO real run needed)
There is no existing run-state fake; build one by injecting `readState`. The
finding starts `in-progress` with a `launched` promotesTo (the state a Sprint-2 launch left it in):
```ts
import { describe, it, expect } from "vitest";
import { reconcilePromotions } from "./reconcile.js";
import { InMemoryFindingStore } from "./finding-port.js";
import type { Finding } from "../hub/finding.js";
import type { RunState } from "../mcp/run-manager.js";

const T = "2026-06-28T00:00:00.000Z";
// A finding already promoted by Sprint 2: status in-progress + launched ref.
const LAUNCHED: Finding = {
  id: "abc123def456abc1", domain: "coding", title: "fix the CI build", kind: "action",
  urgency: 3, severity: 2, evidence: [], surfacedAt: T, tags: [], status: "in-progress",
  promotesTo: JSON.stringify({ kind: "bober-run", runId: "do-abc-1", launchedAt: T, status: "launched" }),
};
// Minimal RunState fake — only .status is read by reconcile.
function fakeState(status: RunState["status"]): RunState {
  return { runId: "do-abc-1", task: "x", status, startedAt: T,
    progress: { completedSprints: 0, failedSprints: 0, duration: 0 }, projectRoot: "/x" };
}

it("sc-3-2: completed run → finding done + promotesTo.status completed", async () => {
  const store = new InMemoryFindingStore([LAUNCHED]);
  await reconcilePromotions({ store, readState: async () => fakeState("completed"), now: () => T });
  const f = await store.readFinding("abc123def456abc1");
  expect(f!.status).toBe("done");
  expect(f!.promotesTo).toMatchObject({ status: "completed" });
});

it("sc-3-3: aborted run → finding open + promotesTo.status aborted", async () => {
  const store = new InMemoryFindingStore([LAUNCHED]);
  await reconcilePromotions({ store, readState: async () => fakeState("aborted"), now: () => T });
  const f = await store.readFinding("abc123def456abc1");
  expect(f!.status).toBe("open");
  expect(f!.promotesTo).toMatchObject({ status: "aborted" });
});

it("sc-3-3: running run → finding unchanged (in-progress)", async () => {
  const store = new InMemoryFindingStore([LAUNCHED]);
  await reconcilePromotions({ store, readState: async () => fakeState("running"), now: () => T });
  const f = await store.readFinding("abc123def456abc1");
  expect(f!.status).toBe("in-progress");
  expect(f!.promotesTo).toMatchObject({ status: "launched" });
});

it("never throws when run-state is missing (null)", async () => {
  const store = new InMemoryFindingStore([LAUNCHED]);
  await expect(
    reconcilePromotions({ store, readState: async () => null, now: () => T }),
  ).resolves.toBeDefined();
  const f = await store.readFinding("abc123def456abc1");
  expect(f!.status).toBe("in-progress"); // unchanged
});
```
NOTE: `InMemoryFindingStore.readFinding` returns the stored OBJECT (no JSON.parse),
so `f!.promotesTo` is a `PromotionRef` object — assert `.status` directly
(see finding-port.test.ts:115/124). The seed `promotesTo` above is a JSON STRING
because the constructor runs it through `toDoFinding` which parses it (finding-port.ts:109/27-31).

### registry second-stub-promoter + fail-closed pattern (sc-3-4)
**Source:** existing `src/do-bridge/registry.test.ts:21-30` (stub promoter shape) and `:59-65` (undefined assertion)
```ts
// A NON-FUNCTIONAL stub — exists ONLY to prove the registry accepts a new (domain,kind).
const projectsActionStub: Promoter = (_f) => ({ kind: "bober-run", task: "STUB — not functional" });

it("sc-3-4: a second promoter under {domain:'projects', kind:'action'} resolves", () => {
  const registry = new PromoterRegistry();
  registry.register({ domain: "coding" }, codingPromoter);
  registry.register({ domain: "projects", kind: "action" }, projectsActionStub);
  expect(registry.resolve({ domain: "projects", kind: "action" })).toBe(projectsActionStub);
});

it("sc-3-4: an unregistered (domain,kind) fails closed → undefined", () => {
  const registry = new PromoterRegistry();
  registry.register({ domain: "coding" }, codingPromoter);
  expect(registry.resolve({ domain: "financial", kind: "action" })).toBeUndefined();
});
```
The CLI half of sc-3-4 ("bober do then exits non-zero naming the (domain,kind)") is
ALREADY implemented at `do.ts:108-117` (resolve→undefined→exitCode 1 naming the domain)
and covered by `do.test.ts:130-173`. You only need to assert the registry resolution
in `registry.test.ts`; reuse the existing CLI test if you want a CLI-level check.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/commands/do.ts` | `finding-port.ts` FindingStore | medium | New `listPromoted`/`applyOutcome` are additive; the `FactStoreFindingStore` it builds (do.ts:217) must implement them so it still satisfies the interface. |
| `src/cli/commands/do.test.ts` | `runDo` + `InMemoryFindingStore` | medium | `InMemoryFindingStore` must implement the 2 new methods or it stops satisfying `FindingStore` → all 12 do tests fail to compile. |
| `src/do-bridge/finding-port.test.ts` | both adapters | medium | Same — adapters must implement new methods to keep compiling. Existing read/setPromotion tests must stay green (don't change those methods). |
| `src/index.ts` / CLI registrar | `registerDoCommand` | low | Adding `--reconcile` is additive; default `false` keeps existing `bober do <id>` behavior byte-identical. |
| `src/hub/finding.ts` | — | DO-NOT-TOUCH | Must stay byte-unchanged; promotesTo stays `z.string().optional()`. |

### Existing Tests That Must Still Pass
- `src/do-bridge/finding-port.test.ts` (193 lines) — tests readFinding + setPromotion on both
  adapters; your additive methods must not alter `setPromotion`'s `in-progress` hard-code or
  `writes` push semantics (finding-port.ts:123-126).
- `src/cli/commands/do.test.ts` (384 lines) — dry-run, unsupported-domain (sc-1-5), unknown-id,
  and Sprint-2 approve/reject paths. Adding the start-of-command reconcile to the NORMAL path
  must not change dry-run output or the approve/reject behavior. The simplest safety: only call
  reconcile in the real CLI `action` wrapper, NOT inside `runDo`, so the `runDo` unit tests are
  untouched. (runDo's 4-arg dry-run calls have no projectRoot.)
- `src/do-bridge/registry.test.ts` (existing 7 tests) — precedence + undefined; you APPEND sc-3-4 tests.
- `src/do-bridge/promote.test.ts`, `launcher.test.ts`, `coding-promoter.test.ts` — unaffected (no shared edits).

### Features That Could Be Affected
- **task-inbox** (`src/inbox/`, completed spec) shares the hub `FindingSchema` and `transitionFinding`
  supersede path. Verify reconcile's `done` transition behaves like task-inbox's done (both go through
  `transitionFinding` → supersede, so they're consistent). Do not change `src/hub/finding-store.ts`.
- **priority-hub** (`src/hub/`) OWNS `FindingSchema`. Reconcile reads/writes findings via the port only;
  it must never widen or edit the schema.

### Recommended Regression Checks
1. `npm run build` — zero tsc errors (sc-3-1; this also catches a missing interface method on an adapter).
2. `npm test -- src/do-bridge` — completed→done, aborted→open, running→unchanged, unsupported-(domain,kind)→undefined (stopCondition).
3. `npm test -- src/cli/commands/do.test.ts` — all 12 Sprint-1/2 CLI tests still green.
4. `npm test -- src/do-bridge/finding-port.test.ts` — read/setPromotion tests unchanged & green.
5. `npm run lint` (if available) — zero errors (consistent-type-imports, no-unused, `_`-prefix).
6. Confirm `git diff src/hub/finding.ts` is EMPTY (byte-unchanged invariant).

---

## 8. Implementation Sequence

1. **src/do-bridge/finding-port.ts** — ADD `listPromoted()` + `applyOutcome(id, status, ref, {now})`
   to the `FindingStore` interface and BOTH adapters. Do NOT touch existing `readFinding`/`setPromotion`.
   - Verify: `npm run build` compiles; existing `finding-port.test.ts` still green.
2. **src/do-bridge/reconcile.ts** — implement `reconcilePromotions(deps)` DI core + a
   `reconcilePromotionsForRoot(projectRoot, store, now)` wrapper. Map status→transition; swallow per-finding errors.
   - Verify: imports resolve; `readRunState` + `RunState` typed correctly.
3. **src/do-bridge/reconcile.test.ts** — sc-3-2 (completed→done), sc-3-3 (aborted→open, running→unchanged),
   and the missing-run-state (null → never-throw, unchanged) test, all via the injected `readState` fake.
   - Verify: `npm test -- src/do-bridge/reconcile.test.ts` green.
4. **src/do-bridge/registry.test.ts** — append the sc-3-4 second-stub-promoter resolve test + the
   fail-closed unregistered-(domain,kind) → undefined test. Mark the stub NON-FUNCTIONAL in a comment.
   - Verify: `npm test -- src/do-bridge/registry.test.ts` green.
5. **src/cli/commands/do.ts** — add `--reconcile` option; branch the `action` handler:
   reconcile-only when flag set (build store → reconcile → print summary → close → return);
   else best-effort reconcile (try/catch mirroring pipeline.ts:981) BEFORE the normal `runDo`.
   - Verify: `bober do <id>` dry-run output unchanged; `bober do --reconcile` runs.
6. **src/cli/commands/do.test.ts** — (optional) add a CLI-level reconcile test if you can drive it
   with a real temp `.bober/runs/<id>/state.json` written via `writeRunState`; otherwise rely on the
   reconcile.test.ts unit coverage. Keep all existing tests green.
   - Verify: `npm test -- src/cli/commands/do.test.ts` green.
7. **docs/do-bridge.md** — write the extension-point doc (mirror chat-steer.md), naming the
   register() call site `src/cli/commands/do.ts:220-222` and the `Promoter`/`PromoterKey` types.
   - Verify: file exists; names the register site + Promoter interface (sc-3-5 manual).
8. **Run full verification** — `npm run build` && `npm test -- src/do-bridge` && `npm test -- src/cli/commands/do.test.ts`.

---

## 9. Pitfalls & Warnings

- **DO NOT edit `src/hub/finding.ts`** — byte-unchanged invariant. `promotesTo` stays `z.string().optional()`.
  The `PromotionRef` object is JSON-serialized into that string by `serializePromotionRef` (types.ts:52).
- **DO NOT change `setPromotion`'s hard-coded `in-progress`** (finding-port.ts:81/123) — Sprint-2 tests
  assert it. Add a SEPARATE `applyOutcome` that takes the status; don't generalize setPromotion.
- **Do NOT poll/block.** Reconcile reads the CURRENT `state.json` snapshot via `readRunState` and returns
  immediately. `running` (or null) → leave the finding alone; it gets reconciled on a later `bober do`.
- **The second promoter is a NON-FUNCTIONAL STUB.** It exists only to prove `registry.register` accepts a
  new `(domain,kind)`. Mark it `// STUB — not functional` in code. Do NOT implement a real projects/medical promoter (nonGoal).
- **Reconcile must NEVER abort `bober do`.** Wrap the start-of-command call in the seedProjectFacts-style
  try/catch (pipeline.ts:981), AND make `reconcilePromotions` swallow per-finding errors internally.
  `readRunState` already returns `null` (never throws) on missing/corrupt files — rely on that.
- **`RunState` is defined in `src/mcp/run-manager.ts:35`, not in run-state.ts.** Import the TYPE from
  `../mcp/run-manager.js`; import `readRunState` from `../state/run-state.js`.
- **`status: "failed"` maps to the SAME outcome as `aborted`** (finding→open, ref→aborted). Don't forget
  `failed` — the pipeline writes `failed` (run-manager.ts:231), and crash-recovery rewrites `running`→`failed` (run-manager.ts:260-261).
- **Keep the reconcile out of `runDo`'s 4-arg signature.** The Sprint-1 dry-run unit tests call `runDo`
  without a `projectRoot`/deps; put the reconcile in the CLI `action` wrapper (which HAS projectRoot) so
  those tests stay untouched.
- **`InMemoryFindingStore` stores the ref as an OBJECT; `FactStoreFindingStore` serializes to a STRING.**
  Tests assert `promotesTo.status` on the in-memory object directly (no JSON.parse). Mirror finding-port.ts:115.
- **ESM/`import type`:** every import needs `.js`; types via `import type`. `tsc` (sc-3-1) is a hard gate.
