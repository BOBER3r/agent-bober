# Sprint Briefing: SharedBlackboard module (WAL facts.db wrapper)

**Contract:** sprint-spec-20260618-fleet-blackboard-exchange-1
**Generated:** 2026-06-18T20:00:00Z

This sprint builds ONE new module (`src/fleet/shared-blackboard.ts`) that wraps a single shared `facts.db` opened in WAL mode, plus an OPTIONAL opts arg on `FactStore`'s constructor to enable WAL + busy_timeout. No coordinator/CLI/config wiring. The contract's `generatorNotes` already give a near-complete skeleton — this briefing supplies the exact file:line evidence, the test patterns to mirror, and the no-regression guardrails.

---

## 1. Target Files

### `src/state/facts.ts` (modify)

**Only change: the constructor.** Add an optional 2nd arg. Current constructor is `src/state/facts.ts:139-158`:

```ts
export class FactStore {
  private db: DatabaseType;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS semantic_facts (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        ...
      );
      CREATE INDEX IF NOT EXISTS idx_facts_sp ON semantic_facts(scope, subject, predicate);
      CREATE INDEX IF NOT EXISTS idx_facts_active ON semantic_facts(scope, t_invalidated);
    `);
  }
```

**Required change (byte-identical when opts omitted):**

```ts
constructor(
  dbPath: string,
  opts?: { journalModeWal?: boolean; busyTimeoutMs?: number },
) {
  this.db = new Database(dbPath);
  if (opts?.journalModeWal) {
    this.db.pragma("journal_mode = WAL");
  }
  if (opts?.busyTimeoutMs !== undefined) {
    this.db.pragma(`busy_timeout = ${opts.busyTimeoutMs}`);
  }
  this.db.exec(`
    CREATE TABLE IF NOT EXISTS semantic_facts ( ... );  // UNCHANGED
  `);
}
```

- `DatabaseType` is `import type { Database as DatabaseType } from "better-sqlite3"` (`facts.ts:4`); `Database` (the value ctor) is `import Database from "better-sqlite3"` (`facts.ts:3`). `.pragma()` is a `better-sqlite3` instance method — there is NO existing `.pragma()` usage anywhere in `src/` (grep returned nothing), so the Generator introduces it for the first time. Its signature: `db.pragma("journal_mode = WAL")` returns the new mode; `db.pragma("journal_mode", { simple: true })` returns just the string value (useful in tests).
- Do NOT change `CREATE TABLE` / indexes — the shared db reuses the existing `semantic_facts` schema (contract assumption: "no migration needed").

**Write primitive — `insertFact` (`facts.ts:164-206`):** validates with `FactSchema.safeParse` then INSERT OR REPLACE on deterministic id. SharedBlackboard.publish calls this. Note `FactInput` REQUIRES `tValid` and `tCreated` (both `z.string().datetime()`), and `sourceRunId` (nullable, default null) — see the FactInput notes below. The contract's publish skeleton omits these — **you MUST supply `tValid`/`tCreated`/`sourceRunId` or `safeParse` will throw.** Pass the `now` arg as both timestamps.

**Read primitive — `getActiveFacts(scope, subject?, predicate?)` (`facts.ts:213-248`):** returns `FactRecord[]` where `t_invalidated IS NULL`. The `(scope, undefined, predicate)` branch (`facts.ts:232-240`) is exactly what `readSiblings`/`readAll` need (filter by scope + predicate='finding', no subject).

**FactInput / FactRecord types (`facts.ts:22-49`):**

```ts
export const FactSchema = z.object({          // facts.ts:22-31
  scope: z.string(),
  subject: z.string().min(1),
  predicate: z.string().min(1),
  value: z.string().min(1),
  confidence: z.number().min(0).max(1).default(1),
  sourceRunId: z.string().nullable().default(null),
  tValid: z.string().datetime(),
  tCreated: z.string().datetime(),
});
export type FactInput = z.infer<typeof FactSchema>;   // facts.ts:33

export interface FactRecord {                  // facts.ts:37-49
  id: string; scope: string; subject: string; predicate: string;
  value: string; confidence: number; sourceRunId: string | null;
  tValid: string; tInvalid: string | null;
  tCreated: string; tInvalidated: string | null;
}
```

CAUTION: `confidence` is `z.number().min(0).max(1)` — `BlackboardFinding.confidence` must be in [0,1] or `insertFact` throws. Default to `1`.

**Imports `facts.ts` uses:** `join` from `node:path` (:1), `createHash` from `node:crypto` (:2), `Database` + `type Database as DatabaseType` from `better-sqlite3` (:3-4), `z` from `zod` (:5), `ensureDir` from `./helpers.js` (:7), `memoryDir` from `./memory.js` (:8).

**Imported by (all pass ONLY `dbPath` — must stay byte-identical):** `src/cli/commands/facts.ts:99,164,217,270`, `src/medical/engine.ts:374`, `src/orchestrator/memory/fact-detector.ts:193`, `src/orchestrator/memory/fact-retrieve.ts:93`, plus `:memory:` callers in `src/medical/engine.test.ts` (10 sites), `src/orchestrator/memory/reconcile.test.ts`, `fact-detector.test.ts`, `fact-retrieve.test.ts`, and `src/state/facts.test.ts`. NONE pass a 2nd arg today; the new arg is optional so they remain unaffected.

**Test file:** `src/state/facts.test.ts` (exists — add the default-journal-mode regression test here, sc-1-7).

---

### `src/fleet/shared-blackboard.ts` (create)

**Directory pattern:** `src/fleet/*.ts` are small focused modules with unicode box section headers (`// ── Section ──`), `import type { ... }` for types, `.js` import extensions, named exports only (no default). See `src/fleet/tier-policy.ts` and `src/fleet/types.ts`.
**Most similar existing file for module shape:** `src/fleet/tier-policy.ts` (types-then-API). For the SQLite-wrapper-class shape, `src/medical/health-store.ts` (`class` with `private db`, constructor opens db, methods, `close()`).

**Structure template (assembled from contract generatorNotes + verified primitives):**

```ts
import { dirname } from "node:path";

import { ensureDir } from "../state/helpers.js";
import { FactStore } from "../state/facts.js";
import type { FactRecord } from "../state/facts.js";

// ── Constants ────────────────────────────────────────────────────────

export const BLACKBOARD_MAX_ROUNDS = 3;

// ── Types ────────────────────────────────────────────────────────────

export interface BlackboardFinding {
  childFolder: string;
  round: number;
  payload: string;
  confidence?: number;
}

export interface SharedBlackboardOpts {
  dbPath: string;
  namespace: string;
  busyTimeoutMs?: number;
  maxRounds?: number;
}

// ── SharedBlackboard ─────────────────────────────────────────────────

export class SharedBlackboard {
  private store: FactStore;
  private namespace: string;
  private maxRounds: number;

  private constructor(store: FactStore, namespace: string, maxRounds: number) {
    this.store = store;
    this.namespace = namespace;
    this.maxRounds = maxRounds;
  }

  static async open(opts: SharedBlackboardOpts): Promise<SharedBlackboard> {
    if (opts.dbPath !== ":memory:") {
      await ensureDir(dirname(opts.dbPath));   // ensureDir is async — open() is async
    }
    const store = new FactStore(opts.dbPath, {
      journalModeWal: true,
      busyTimeoutMs: opts.busyTimeoutMs ?? 5000,
    });
    const maxRounds = Math.min(opts.maxRounds ?? BLACKBOARD_MAX_ROUNDS, BLACKBOARD_MAX_ROUNDS);
    return new SharedBlackboard(store, opts.namespace, maxRounds);
  }

  publish(finding: BlackboardFinding, now: string): FactRecord {
    if (finding.round > this.maxRounds) {
      throw new Error(`blackboard round ${finding.round} exceeds cap ${this.maxRounds}`);
    }
    return this.store.insertFact({
      scope: this.namespace,
      subject: finding.childFolder,
      predicate: "finding",
      value: finding.payload,
      confidence: finding.confidence ?? 1,
      sourceRunId: null,
      tValid: now,
      tCreated: now,
    });
  }

  readSiblings(selfFolder: string): FactRecord[] {
    return this.store
      .getActiveFacts(this.namespace, undefined, "finding")
      .filter((f) => f.subject !== selfFolder);
  }

  readAll(): FactRecord[] {
    return this.store.getActiveFacts(this.namespace, undefined, "finding");
  }

  close(): void {
    this.store.close();
  }
}
```

DESIGN NOTE on `open()` being async: `ensureDir` is `async` (returns `Promise<void>`, `src/state/helpers.ts:6`) and principles forbid sync fs. The contract generatorNotes sketch `ensureDir(...)` inside a synchronous constructor — that would float an unawaited promise. The clean fix is a `static async open()` factory that awaits `ensureDir` then constructs the store. Tests therefore `await SharedBlackboard.open(...)`. If the Generator prefers a sync constructor, it must `await ensureFactsDir`/`ensureDir` BEFORE constructing — but the async factory is cleaner and matches the contract's named `open()` entry point.

**Test file:** `src/fleet/shared-blackboard.test.ts` (create — collocated).

---

## 2. Patterns to Follow

### SQLite wrapper class shape
**Source:** `src/medical/health-store.ts:115-148, 264-268`
```ts
export class HealthDataStore {
  private db: DatabaseType;
  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(` CREATE TABLE IF NOT EXISTS ... `);
  }
  // ...methods...
  close(): void { this.db.close(); }
}
```
**Rule:** Wrapper classes hold a `private db`/`private store`, open in the constructor (or factory), expose typed methods, and always provide `close()`. SharedBlackboard wraps a `FactStore` rather than a raw `Database`.

### Fleet module: section headers + named exports + type imports
**Source:** `src/fleet/tier-policy.ts:1-22`
```ts
import type { ProviderName } from "../providers/factory.js";

// ── Types ────────────────────────────────────────────────────────────

export type DifficultyTier = "default" | "cheap" | "standard" | "hard" | "frontier";

export interface TierProviderPolicy { ... }
```
**Rule:** Use `// ── Name ──` unicode box section headers, `import type` for type-only imports (ESLint `consistent-type-imports` is a hard gate per principles.md:35), `.js` extensions on relative imports, and named exports only.

### Deterministic-id INSERT (already done inside FactStore — do NOT reimplement)
**Source:** `src/state/facts.ts:164-191` — `insertFact` validates + derives id via `factId` (`facts.ts:58-69`, SHA-256 of `scope|subject|predicate|value|tCreated`, sliced to 16). Two findings with identical `(namespace, childFolder, 'finding', payload, now)` collapse to one row (INSERT OR REPLACE). For the concurrency test (sc-1-6, N distinct findings) use distinct `payload` (or distinct `childFolder`) values so ids differ and all N persist.

### ensureDir usage
**Source:** `src/state/helpers.ts:1-8`
```ts
import { mkdir } from "node:fs/promises";
export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}
```
**Rule:** Create parent dirs via `ensureDir(dirname(dbPath))` — never `fs.mkdirSync` (principles.md:42 forbids sync fs).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `FactStore` | `src/state/facts.ts:136` | `class FactStore(dbPath, opts?)` | Bi-temporal SQLite fact store; wrap it — do NOT open a raw Database in shared-blackboard.ts |
| `FactStore.insertFact` | `src/state/facts.ts:164` | `(input: FactInput): FactRecord` | The write primitive for publish() |
| `FactStore.getActiveFacts` | `src/state/facts.ts:213` | `(scope, subject?, predicate?): FactRecord[]` | The read primitive for readSiblings/readAll |
| `FactStore.close` | `src/state/facts.ts:294` | `(): void` | Close the db; SharedBlackboard.close() delegates here |
| `factId` | `src/state/facts.ts:58` | `(scope,subject,predicate,value,tCreated): string` | Deterministic 16-char id (used internally by insertFact; exported for test assertions) |
| `FactInput` / `FactRecord` | `src/state/facts.ts:33 / :37` | type / interface | Import these as `import type`; do NOT redefine a finding-record type |
| `ensureDir` | `src/state/helpers.ts:6` | `(dirPath: string): Promise<void>` | Recursive mkdir; use before opening a file-backed db |
| `factsDbPath` | `src/state/facts.ts:77` | `(projectRoot, namespace?): string` | Resolves facts.db path (NOT needed this sprint — wiring is Sprint 2) |
| `ensureFactsDir` | `src/state/facts.ts:86` | `(projectRoot, namespace?): Promise<void>` | Async dir ensure (alternative to ensureDir; not needed since SharedBlackboard takes an explicit dbPath) |

Utilities reviewed: `src/utils/` (logger.ts, git.ts, fs.ts — none relevant; fs ops here go through `state/helpers.ts`), `src/state/helpers.ts`, `src/state/facts.ts`. No new utility should be created — everything publish/read/close needs already exists on FactStore.

---

## 4. Prior Sprint Output

No prior sprints within this spec (`dependsOn: []`). Phase A (tier-provider-routing) is complete on this same branch and added `src/fleet/tier-policy.ts`, `src/fleet/child-config.ts`, `src/fleet/tool-role-guard.ts`. **Connection:** none functional this sprint — Phase B is additive and isolated to `shared-blackboard.ts` + the optional `facts.ts` opts arg. The only contract with the rest of the fleet is the module-convention pattern captured in section 2 (mirror `tier-policy.ts`).

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM + `.js` extensions** on all relative imports (principles.md:27). Use `import type { ... }` (`consistent-type-imports` is a hard gate, principles.md:35).
- **No synchronous fs** (principles.md:42) — use `ensureDir` (async), never `mkdirSync`.
- **Section comments:** `// ── Section ──` unicode box headers (principles.md:32).
- **Tests collocated** as `*.test.ts` next to source, Vitest (principles.md:20). No fs mocks — use real temp dirs and clean up (principles.md:44).
- **TS strict + zero type/lint errors are hard gates** (principles.md:18-19). Prefix unused params with `_` (principles.md:36); avoid `any` (principles.md:40).
- **No SDK/network imports** outside provider adapters (principles.md:41). sc-1-8 explicitly forbids any network/SDK import in shared-blackboard.ts — it depends only on FactStore + better-sqlite3 (transitively).

### Architecture Decisions
ADR-7 (memory facts via FactStore) is the relevant decision: findings live in the existing `semantic_facts` schema; no migration. No new ADR docs apply to this sprint.

### Other Docs
better-sqlite3 is synchronous. WAL is enabled via `db.pragma("journal_mode = WAL")`. `db.pragma("journal_mode", { simple: true })` returns the bare mode string (lowercased, e.g. `"wal"` or `"memory"`) — use this form in tests.

---

## 6. Testing Patterns

### Unit Test Pattern — in-memory store
**Source:** `src/state/facts.test.ts:1-30`
```ts
import { describe, it, expect, afterEach } from "vitest";
import { FactStore, factId } from "./facts.js";

describe("FactStore (in-memory)", () => {
  let store: FactStore;
  afterEach(() => { store?.close(); });

  it("insert -> getActiveFacts returns the row", () => {
    store = new FactStore(":memory:");
    const t = "2026-06-15T00:00:00.000Z";
    const rec = store.insertFact({
      scope: "programming", subject: "project", predicate: "testCommand",
      value: "vitest", confidence: 1, sourceRunId: null, tValid: t, tCreated: t,
    });
    const active = store.getActiveFacts("programming");
    expect(active).toHaveLength(1);
    expect(active[0].value).toBe("vitest");
  });
});
```
**Runner:** Vitest. **Assertion style:** `expect(...).toBe/.toHaveLength/.toEqual`. **Mock approach:** none — real stores. **File naming:** `*.test.ts` collocated. Note: a fixed ISO timestamp string `t` is reused for `tValid`/`tCreated`.

### Unit Test Pattern — file-backed db with temp dir (mirror for WAL + concurrency tests)
**Source:** `src/medical/health-store.test.ts:1-8, 143-170`
```ts
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("HealthDataStore (file-backed dedup — sc-4-4)", () => {
  let tmpDir: string;
  beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-health-")); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it("...", () => {
    const store = new HealthDataStore(join(tmpDir, "health.db"));
    // ...assertions...
    store.close();
  });
});
```
**Rule:** WAL must be tested on a FILE-backed db (`:memory:` does not behave like a real WAL file). Use `mkdtemp(join(tmpdir(), "bober-blackboard-"))` in `beforeEach`, `rm(tmpDir, { recursive: true, force: true })` in `afterEach`.

### Asserting journal_mode (sc-1-3 and sc-1-7)
There is NO existing `.pragma()` test in the repo to copy. The mechanism: open a raw `better-sqlite3` Database at the SAME file path and read the pragma. Note `health-store.test.ts:129` shows the precedent for reaching the private `db` via index access (`store["db"]`) — you may instead add a tiny test-only raw read:
```ts
import Database from "better-sqlite3";
// after `const bb = await SharedBlackboard.open({ dbPath, namespace: "ns", maxRounds: 3 });`
const raw = new Database(dbPath);
const mode = raw.pragma("journal_mode", { simple: true });
expect(mode).toBe("wal");
raw.close();
```
For sc-1-7 (default FactStore unchanged): a `:memory:` db reports `"memory"` for journal_mode; a default FILE-backed FactStore reports `"delete"`. Assert it is NOT `"wal"`:
```ts
const store = new FactStore(join(tmpDir, "default.db"));   // no opts
const raw = new Database(join(tmpDir, "default.db"));
expect(raw.pragma("journal_mode", { simple: true })).not.toBe("wal");  // 'delete'
raw.close(); store.close();
```
(Reading the pragma from a second connection avoids needing a getter on FactStore. If you prefer not to open a raw connection, expose a minimal test seam, but a raw read is simplest and matches the evaluatorNotes.)

### Concurrency test (sc-1-6)
better-sqlite3 is synchronous, so "concurrent" means `Promise.all` over async wrappers and/or multiple connections to truly contend. Simplest within one process:
```ts
const bb = await SharedBlackboard.open({ dbPath: join(tmpDir, "c.db"), namespace: "ns", maxRounds: 3 });
const now = "2026-06-18T00:00:00.000Z";
await Promise.all(
  Array.from({ length: 5 }, (_, i) =>
    Promise.resolve().then(() => bb.publish({ childFolder: `child-${i}`, round: 1, payload: `p${i}` }, now)),
  ),
);
expect(bb.readAll()).toHaveLength(5);
bb.close();
```
Use DISTINCT `childFolder`/`payload` so the deterministic ids differ (identical findings would collapse via INSERT OR REPLACE). To exercise real WAL contention you may open multiple SharedBlackboard instances on the same dbPath inside the Promise.all — busy_timeout (5000ms) prevents SQLITE_BUSY deadlock.

### E2E Test Pattern
Not applicable — no Playwright/E2E for a backend module.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
The ONLY modify target is `src/state/facts.ts` (constructor). The new arg is optional, so dependents are safe — but verify.
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/commands/facts.ts:99,164,217,270` | `new FactStore(dbPath)` | low | Passes only dbPath; optional arg → unchanged |
| `src/medical/engine.ts:374` | `new FactStore(dbPath)` | low | Passes only dbPath; medical FactStore usage must pass unchanged (sc-1-7) |
| `src/medical/consent.ts`, `src/medical/health-store.ts` | import FactStore (HealthDataStore mirrors it) | low | No constructor signature dependency broken |
| `src/orchestrator/memory/fact-detector.ts:193`, `fact-retrieve.ts:93`, `reconcile.ts` | `new FactStore(...)` | low | dbPath-only; unchanged |

### Existing Tests That Must Still Pass
- `src/state/facts.test.ts` — exercises `new FactStore(":memory:")` insert/getActiveFacts/invalidate; must pass unchanged (sc-1-7).
- `src/medical/engine.test.ts` (10 `new FactStore(":memory:")` sites) — must pass unchanged (sc-1-7 calls out medical usage explicitly).
- `src/orchestrator/memory/reconcile.test.ts`, `fact-detector.test.ts`, `fact-retrieve.test.ts` — all construct FactStore with `:memory:`; verify unchanged.
- `src/medical/health-store.test.ts` — HealthDataStore is independent but shares the better-sqlite3 pattern; should be untouched.

### Features That Could Be Affected
- **Memory / facts CLI (`bober facts`)** — shares `FactStore`. Verify default journal mode is unchanged for these callers (the regression test in facts.test.ts asserts this).
- **Medical engine** — shares `FactStore` (ADR-7). Same guarantee: opts omitted → byte-identical.
- **Fleet (Phase A)** — no shared code with shared-blackboard.ts; no impact.

### Recommended Regression Checks
1. `npm run build` — zero TS errors (sc-1-1).
2. `npm run typecheck` — zero errors (sc-1-1).
3. `npm run lint` — zero errors; confirm `import type` used and no `any` (sc-1-8).
4. `npm run test` — full suite green except the 6 known cockpit-integration MCP failures (sc-1-2). In particular `src/state/facts.test.ts` and `src/medical/engine.test.ts` must be unchanged.
5. `grep -n "import" src/fleet/shared-blackboard.ts` — confirm NO `@anthropic-ai/sdk`, `openai`, network, or provider imports (sc-1-8).

---

## 8. Implementation Sequence

1. **`src/state/facts.ts`** — Add the optional 2nd constructor arg `opts?: { journalModeWal?: boolean; busyTimeoutMs?: number }`; inside the constructor, after `new Database(dbPath)` and BEFORE `this.db.exec(...)`, call `this.db.pragma("journal_mode = WAL")` when `opts?.journalModeWal`, and `this.db.pragma(\`busy_timeout = ${opts.busyTimeoutMs}\`)` when `opts?.busyTimeoutMs !== undefined`. Leave CREATE TABLE/indexes untouched.
   - Verify: `npm run typecheck` clean; existing `facts.test.ts`/`engine.test.ts` still pass (no behavior change when opts omitted).
2. **`src/fleet/shared-blackboard.ts`** — Create the module per the section-1 template: `BLACKBOARD_MAX_ROUNDS = 3`, `BlackboardFinding` interface, `SharedBlackboard` class with `static async open()`, `publish(finding, now)` (round-cap throw + insertFact with tValid/tCreated/sourceRunId filled), `readSiblings(selfFolder)`, `readAll()`, `close()`. Use `import type { FactRecord }` and `.js` extensions; unicode section headers.
   - Verify: `npm run build` + `npm run lint` clean; no network/SDK imports.
3. **`src/state/facts.test.ts`** — Add the sc-1-7 regression test: a default file-backed `new FactStore(join(tmpDir, "default.db"))` whose `journal_mode` (read via a raw better-sqlite3 connection) is NOT `"wal"`. Add `mkdtemp`/`rm` temp-dir scaffolding (mirror health-store.test.ts) if not present.
   - Verify: that test passes and asserts `'delete'`/non-wal.
4. **`src/fleet/shared-blackboard.test.ts`** — Create collocated tests covering: (sc-1-3) WAL mode after open + file exists; (sc-1-4) publish writes the expected FactRecord fields AND throws on `round=4`; (sc-1-5) two subjects → readSiblings excludes self, readAll returns both, empty namespace → `[]`; (sc-1-6) Promise.all of >=5 distinct publishes → `readAll().length === 5`. Use `mkdtemp`/`tmpdir`/`rm` temp dirs and `await SharedBlackboard.open(...)`.
   - Verify: all new tests green.
5. **Run full verification** — `npm run build`, `npm run typecheck`, `npm run lint`, `npm run test` (only the 6 known cockpit MCP failures allowed). Grep shared-blackboard.ts for forbidden imports.

---

## 9. Pitfalls & Warnings

- **insertFact REQUIRES `tValid`, `tCreated`, and `sourceRunId`.** The contract's publish skeleton omits them; `FactSchema.safeParse` (facts.ts:165) will throw "Invalid fact input" if `tValid`/`tCreated` are missing (they are `z.string().datetime()`, no default). Pass the `now` arg into both timestamp fields and `sourceRunId: null`.
- **`confidence` must be in [0,1]** (facts.ts:27). `BlackboardFinding.confidence` is optional `number?`; default to `1` and do not pass values >1 or the schema rejects.
- **WAL cannot be meaningfully tested on `:memory:`.** `:memory:` reports journal_mode `"memory"`, not `"wal"`. The WAL/concurrency tests MUST use a file-backed temp-dir db (mirror health-store.test.ts:143-170).
- **Deterministic id collapses identical findings.** Two publishes with identical `(namespace, childFolder, 'finding', payload, now)` map to the SAME id and INSERT OR REPLACE into one row (facts.ts:173-179). For the N-concurrent test, vary `childFolder` or `payload` so ids differ.
- **No sync fs.** `ensureDir` is async (helpers.ts:6); that is why `open()` is a `static async` factory. Do not call `mkdirSync` or float an unawaited `ensureDir` inside a sync constructor (lint/principles violation).
- **Do NOT change FactStore default behavior.** The opts arg must default OFF. A default `new FactStore(file)` must remain journal_mode `'delete'` (sc-1-7 is the CRITICAL no-regression gate — the medical engine and facts CLI rely on it).
- **Scope creep is out of bounds.** Do NOT touch the coordinator, runFleet, CLI, config.fleet, manifest.blackboard, rounds loop, or synthesis (nonGoals lines 21-26). Change is confined to `shared-blackboard.ts` (new), `facts.ts` (optional opts), and the two test files.
- **`.pragma()` is new to this codebase** — there is no prior usage to copy. Read it from a raw better-sqlite3 connection in tests using `raw.pragma("journal_mode", { simple: true })` to get the bare string.
- **`import type` is a hard lint gate.** Import `FactRecord` (and any type-only symbol) with `import type`. Importing it as a value will fail `consistent-type-imports`.
