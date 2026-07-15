# Sprint Briefing: Cross-repo read-only collector with sibling resolution and dedup

**Contract:** sprint-spec-20260628-priority-hub-2
**Generated:** 2026-06-28T00:00:00.000Z

> Goal: (1) add an additive `{ readonly?: boolean }` flag to `FactStore` (the ONLY edit to an existing core file; default path stays byte-identical), (2) add `src/hub/repo-resolver.ts` (hub.repos config OR discovered `kb-*` siblings -> absolute repo paths whose facts.db exists), (3) add `src/hub/collector.ts` (`collectFindings` opens each sibling read-only, pools Findings, dedups by `Finding.id`), (4) extend `bober hub list` to aggregate across siblings. PURE data shaping, no LLM, no network, never mutate a sibling.

---

## 1. Target Files

### src/state/facts.ts (modify) — additive `readonly` flag ONLY

**Relevant section (lines 136-167) — the constructor is the ONLY thing you touch in this file:**
```ts
export class FactStore {
  private db: DatabaseType;

  constructor(
    dbPath: string,
    opts?: { journalModeWal?: boolean; busyTimeoutMs?: number },   // line 139-142
  ) {
    this.db = new Database(dbPath);                                 // line 143
    if (opts?.journalModeWal) {                                     // line 144-146
      this.db.pragma("journal_mode = WAL");
    }
    if (opts?.busyTimeoutMs !== undefined) {                        // line 147-149
      this.db.pragma(`busy_timeout = ${opts.busyTimeoutMs}`);
    }
    this.db.exec(`                                                  // line 150-166
      CREATE TABLE IF NOT EXISTS semantic_facts ( ... );
      CREATE INDEX IF NOT EXISTS idx_facts_sp ...;
      CREATE INDEX IF NOT EXISTS idx_facts_active ...;
    `);
  }
```

**Exact additive change (mirror this precisely):**
```ts
  constructor(
    dbPath: string,
    opts?: { journalModeWal?: boolean; busyTimeoutMs?: number; readonly?: boolean },
  ) {
    this.db = opts?.readonly
      ? new Database(dbPath, { readonly: true })   // better-sqlite3 readonly open
      : new Database(dbPath);                       // <-- byte-identical default branch
    if (opts?.journalModeWal) {                     // UNCHANGED
      this.db.pragma("journal_mode = WAL");
    }
    if (opts?.busyTimeoutMs !== undefined) {        // UNCHANGED
      this.db.pragma(`busy_timeout = ${opts.busyTimeoutMs}`);
    }
    if (!opts?.readonly) {                          // skip bootstrap when readonly
      this.db.exec(`CREATE TABLE IF NOT EXISTS semantic_facts ( ... )`);
    }
  }
```
- **Why this stays byte-identical for existing callers (sc-2-1, nonGoal #1):** when `opts.readonly` is absent, `opts?.readonly` is `undefined` -> falsy. The DB open falls to `new Database(dbPath)` (literally unchanged), and `!opts?.readonly` is `true` so CREATE TABLE still runs. WAL/busy_timeout branches are guarded by their own keys and never executed by the collector (it passes only `{ readonly: true }`).
- **better-sqlite3 supports `{ readonly: true }`** — `new Database(path, { readonly: true })` requires the file to already exist and rejects any write statement at `.run()` time (`SQLITE_READONLY: attempt to write a readonly database`).
- **Additive-opts precedent already exists:** `journalModeWal` / `busyTimeoutMs` were added the same way and `SharedBlackboard.open` passes them (`src/fleet/shared-blackboard.ts:58-61`). Add `readonly` as a third optional key the same way.

**Imports this file uses (already present — do NOT add new ones):** `Database` (default) + `type { Database as DatabaseType }` from `"better-sqlite3"` (lines 3-4).

**Imported by:** 17 non-test modules (see Impact Analysis §7). The change MUST be invisible to all of them.

**Test file:** `src/state/facts.test.ts` (exists) — extend it for sc-2-1 / sc-2-4.

---

### src/hub/repo-resolver.ts (create)

**Directory pattern:** `src/hub/` files are kebab-noun, named-export only, section-commented (`// ── X ──`). See `src/hub/finding-source.ts`.
**Most similar existing file:** `src/hub/finding-source.ts` (module shape) + `src/utils/fs.ts` (async fs discovery).
**Structure template:**
```ts
import { resolve, dirname, basename } from "node:path";
import { readdir } from "node:fs/promises";              // ASYNC ONLY (principles)

import { fileExists } from "../utils/fs.js";             // reuse — do NOT recreate
import { factsDbPath } from "../state/facts.js";         // reuse facts.ts:77

// ── resolveSiblingRepos ───────────────────────────────────────────────
/**
 * Turn configured hub.repos (if any) OR discovered `kb-*` siblings into
 * absolute repo-root paths whose derived facts.db actually exists.
 * Never throws: a configured path that does not exist is skipped.
 */
export async function resolveSiblingRepos(
  projectRoot: string,
  configuredRepos?: string[],          // pass config.hub?.repos here; see PITFALL on config
): Promise<string[]> {
  const candidates: string[] =
    configuredRepos && configuredRepos.length > 0
      ? configuredRepos.map((r) => resolve(projectRoot, r))   // absolute
      : await discoverKbSiblings(projectRoot);
  const out: string[] = [];
  for (const repo of candidates) {
    if (await fileExists(factsDbPath(repo))) out.push(repo);  // filter to existing facts.db
  }
  return out;
}

async function discoverKbSiblings(projectRoot: string): Promise<string[]> {
  const parent = dirname(projectRoot);
  let entries;
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && /^kb-/.test(e.name))
    .map((e) => resolve(parent, e.name));
}
```
- `path.resolve` makes everything absolute (assumption: siblings are clones beside the project root; mirrors fleet's "ABSOLUTE path discipline").
- `readdir(parent, { withFileTypes: true })` then `e.isDirectory()` + `/^kb-/` — directories only, name match.
- Filter by `fileExists(factsDbPath(repo))` so non-existent / facts.db-less candidates are dropped (sc-2-5).

---

### src/hub/collector.ts (create)

**Most similar existing file:** `src/fleet/synthesis.ts` (PURE pooling, lines 29-39) + `src/hub/finding-source.ts` (the read+dedup loop convention).
**Structure template:**
```ts
import { FactStore, factsDbPath } from "../state/facts.js";
import { FactStoreFindingSource, HUB_SCOPE } from "./finding-source.js";
import type { Finding } from "./finding.js";

// ── collectFindings ───────────────────────────────────────────────────
/**
 * Open each sibling repo's derived FactStore READ-ONLY, read its findings,
 * pool them into one Finding[] deduplicated by Finding.id (keep first,
 * stable order). PURE: no LLM, no network. A missing/corrupt sibling is
 * skipped, never fatal.
 */
export function collectFindings(
  repoPaths: string[],
  scope: string = HUB_SCOPE,
): Finding[] {
  const pooled: Finding[] = [];
  const seen = new Set<string>();
  for (const repo of repoPaths) {
    let store: FactStore | undefined;
    try {
      store = new FactStore(factsDbPath(repo), { readonly: true }); // never writes
      for (const f of new FactStoreFindingSource(store, scope).read()) {
        if (seen.has(f.id)) continue;        // dedup by Finding.id (sc-2-3)
        seen.add(f.id);
        pooled.push(f);                      // keep first, stable order
      }
    } catch {
      // missing or corrupt sibling -> skip, never fatal
    } finally {
      store?.close();                        // always release the handle
    }
  }
  return pooled;
}
```
- **Dedup key is the parsed `Finding.id`** (e.g. `"f-001"`), NOT the FactStore row id (the sha256 `factId`). `FactStoreFindingSource.read()` already returns validated `Finding[]` whose `.id` is the JSON id (`src/hub/finding-source.ts:32-50`).
- `repoPaths` are repo ROOTS; `factsDbPath(repo)` (`src/state/facts.ts:77`) derives `<repo>/.bober/memory/facts.db`.
- Pooled length == distinct-id count (sc-2-2); an id present in two siblings appears once (sc-2-3).

---

### src/cli/commands/hub.ts (modify) — extend the `list` action to aggregate

**Current `list` action (lines 70-92) sources findings from the project's OWN store only:**
```ts
  hubCmd.command("list")
    .action(async () => {
      const projectRoot = await resolveRoot();
      try {
        const ns = await resolveDefaultNamespace(projectRoot);
        await ensureFactsDir(projectRoot, ns);
        const store = new FactStore(factsDbPath(projectRoot, ns));
        try {
          runHubList(new FactStoreFindingSource(store, HUB_SCOPE));  // OWN store only
        } finally {
          store.close();
        }
      } catch (err) { /* exitCode=1; never throw — lines 84-91 */ }
    });
```
**`runHubList` (lines 50-61) — keep its signature unchanged (Sprint 1 tests depend on it):**
```ts
export function runHubList(source: FindingSource): void { /* prints findings */ }
```
**Recommended extension (own findings + sibling findings, merged & deduped):**
```ts
      const own = new FactStoreFindingSource(store, HUB_SCOPE).read();      // own first
      const siblings = await resolveSiblingRepos(projectRoot /*, configuredRepos */);
      const sibFindings = collectFindings(siblings, HUB_SCOPE);
      const seen = new Set(own.map((f) => f.id));
      const merged = [...own];
      for (const f of sibFindings) if (!seen.has(f.id)) { seen.add(f.id); merged.push(f); }
      runHubList({ read: () => merged });   // FindingSource is just { read(): Finding[] }
```
- `FindingSource` is the minimal interface `{ read(): Finding[] }` (`src/hub/finding-source.ts:13-15`), so an inline `{ read: () => merged }` is a valid source — `runHubList`'s signature does not change.
- New imports for hub.ts: `resolveSiblingRepos` from `"../../hub/repo-resolver.js"`, `collectFindings` from `"../../hub/collector.js"`.
- **Keep all existing error handling** (handlers MUST NOT throw; `process.exitCode = 1` on failure — lines 84-91). The resolver/collector are async-but-never-throw, but keep them inside the existing try.

**Imported by / wiring:** `registerHubCommand` is invoked at `src/cli/index.ts:336` (imported at `src/cli/index.ts:43`). No new CLI wiring needed — you only extend the existing `list` action body.

**Test file:** none for hub.ts (`runHubList` is covered indirectly). No new hub.ts test required by the contract (sc-2 criteria target resolver/collector/FactStore).

---

## 2. Patterns to Follow

### PURE pooling / data-shaping (no LLM, no network)
**Source:** `src/fleet/synthesis.ts:29-39`
```ts
export function collect(blackboard, childResults, rounds): SynthesisBundle {
  return { rounds, childResults, findings: blackboard ? blackboard.readAll() : [] };
}
```
**Rule:** `collectFindings` shapes existing FactStore data into JSON only — no provider/client construction, no network, no clock.

### Read 'finding' predicate rows via getActiveFacts
**Source:** `src/fleet/shared-blackboard.ts:103-105` and `src/hub/finding-source.ts:32-33`
```ts
readAll(): FactRecord[] {
  return this.store.getActiveFacts(this.namespace, undefined, "finding");
}
```
**Rule:** Findings live at predicate `"finding"` in a scope. Reuse `FactStoreFindingSource(store, scope).read()` — do NOT re-query `getActiveFacts` yourself.

### Additive FactStore open opts
**Source:** `src/fleet/shared-blackboard.ts:58-61`
```ts
const store = new FactStore(opts.dbPath, {
  journalModeWal: opts.dbPath !== ":memory:",
  busyTimeoutMs: opts.busyTimeoutMs ?? 5000,
});
```
**Rule:** `readonly` joins `journalModeWal`/`busyTimeoutMs` as a third optional opts key — additive, never positional, never required.

### Never-throw handler / contract
**Source:** `src/cli/commands/hub.ts:1-5, 84-91` and `src/hub/finding-source.ts:36-48`
**Rule:** CLI handlers set `process.exitCode = 1` and return (never throw); the collector swallows per-sibling open errors in try/catch so one bad sibling never aborts the aggregation.

### Section comments + named exports + `import type`
**Source:** `src/hub/finding-source.ts:1-10`, principles.md:32,35,43
```ts
import { FindingSchema } from "./finding.js";
import type { Finding } from "./finding.js";
// ── Constants ────────────────────────────────────────────────────────
export const HUB_SCOPE = "hub";
```
**Rule:** `// ── X ──` headers, named exports only (no default), `import type` for type-only imports, `.js` extensions on every relative import (NodeNext ESM).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `FactStore` | `src/state/facts.ts:136` | `new (dbPath, opts?)` | SQLite-backed fact store; add `readonly` to opts |
| `factsDbPath` | `src/state/facts.ts:77` | `(projectRoot, namespace?) => string` | Derive `<root>/.bober/memory/facts.db` — use to open each sibling |
| `ensureFactsDir` | `src/state/facts.ts:86` | `(projectRoot, namespace?) => Promise<void>` | mkdir the memory dir (use in TESTS to seed sibling stores) |
| `FactStoreFindingSource` | `src/hub/finding-source.ts:26` | `new (store, scope=HUB_SCOPE)` -> `.read(): Finding[]` | Parse/validate predicate-'finding' rows into Findings; never throws |
| `HUB_SCOPE` | `src/hub/finding-source.ts:8` | `= "hub"` | Default scope the hub stores/reads findings under |
| `FindingSchema` / `Finding` | `src/hub/finding.ts:10,27` | Zod schema / type | Canonical Finding shape (`.id` is the dedup key) |
| `fileExists` | `src/utils/fs.ts:10` | `(path) => Promise<boolean>` | Async existence check — use to filter siblings whose facts.db exists |
| `findProjectRoot` | `src/utils/fs.ts:58` | `(startDir?) => Promise<string\|null>` | Walk up to project root (already used by hub.ts `resolveRoot`) |
| `memoryDir` | `src/state/memory.ts:27` | `(projectRoot, namespace?) => string` | Namespace->dir mapping (factsDbPath wraps it; do not duplicate) |
| `ensureDir` | `src/state/helpers.ts:6` / `src/utils/fs.ts:45` | `(dir) => Promise<void>` | recursive mkdir |
| `collect` (reference) | `src/fleet/synthesis.ts:29` | `(bb, results, rounds) => Bundle` | The PURE pooling pattern to mirror |

**Utilities reviewed:** `src/utils/` (fs.ts), `src/state/` (facts.ts, memory.ts, helpers.ts), `src/hub/` (finding-source.ts, finding.ts), `src/fleet/` (synthesis.ts, shared-blackboard.ts). No path/dedup helper exists to recreate — use `node:path` `resolve`/`dirname` + a local `Set<string>`.

---

## 4. Prior Sprint Output

### Sprint 1: Finding schema + FactStore source + `bober hub list`
**Created `src/hub/finding.ts`** — exports `FindingSchema`, `Finding` (`.id`,`domain`,`title`,`kind`,`urgency`,`severity`,`evidence`,`surfacedAt`,`tags`,`status`,...). The hub OWNS this; import from here, never redefine.
**Created `src/hub/finding-source.ts`** — exports `FindingSource` interface (`{ read(): Finding[] }`), `FactStoreFindingSource` class (`constructor(store, scope=HUB_SCOPE)`), `HUB_SCOPE = "hub"`. The collector REUSES `FactStoreFindingSource` + `HUB_SCOPE` verbatim.
**Created `src/cli/commands/hub.ts`** — exports `runHubList(source)`, `registerHubCommand(program)`. This sprint EXTENDS the `list` action body (not the `runHubList` signature).
**Connection:** Sprint 2's collector opens each sibling FactStore read-only and feeds it through Sprint 1's `FactStoreFindingSource`; `bober hub list` merges Sprint 1's own-store findings with the new cross-sibling pool.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **No synchronous fs** (line 42): use `node:fs/promises`. `readdir`/`stat` MUST come from `node:fs/promises`, never `fs.readdirSync`.
- **ESM `.js` extensions** (line 27): every relative import ends in `.js` for NodeNext.
- **`import type`** (line 35): `consistent-type-imports` is enforced — type-only imports use `import type`.
- **Collocated tests** (line 20): `*.test.ts` next to source; Vitest. No fs mocks — tests create temp dirs and clean up (line 44).
- **Zod for config** (line 29): if you add a config field, it is a Zod schema in `config/schema.ts` (but see PITFALL — schema.ts is NOT in scope).
- **Strict TS** (line 18) + **zero lint** (line 19): prefix unused params with `_`; no `any`.

### Architecture Decisions
No `.bober/architecture/` ADR specific to the hub. Relevant assumption from the contract: siblings are clones beside the project root, resolved to ABSOLUTE paths (research:109-112; fleet `resolveBlackboardPath` ABSOLUTE discipline).

### Config section pattern (for reference if a `hub` field is added)
**Optional nested section example:** `src/config/schema.ts:419-451` (`VaultSectionSchema`/`VaultSection` + wired at line 487 `vault: VaultSectionSchema.optional()`), `src/config/schema.ts:376-403` (`MedicalSection`). Full config object at `src/config/schema.ts:455-489`. There is currently **NO `hub` field** in `BoberConfig`. `loadConfig(projectRoot)` is at `src/config/loader.ts:142`.

---

## 6. Testing Patterns

### Unit Test Pattern — temp file-backed FactStores
**Source:** `src/state/facts.test.ts:113-145` (temp dir + raw second connection) and `src/hub/finding-source.test.ts:22-37` (seed a finding).
```ts
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactStore, factsDbPath, ensureFactsDir } from "../state/facts.js";
import { HUB_SCOPE } from "./finding-source.js";

const T = "2026-06-28T00:00:00.000Z";

function findingJson(id: string) {
  return JSON.stringify({
    id, domain: "medical", title: `t-${id}`, kind: "action",
    urgency: 3, severity: 4, evidence: ["e"], surfacedAt: T,
    tags: ["x"], status: "open",
  });
}

// seed a WRITABLE file-backed store at <repo>/.bober/memory/facts.db, then close
async function seedRepo(repoRoot: string, ids: string[]): Promise<void> {
  await ensureFactsDir(repoRoot);                 // mkdir .bober/memory
  const store = new FactStore(factsDbPath(repoRoot));   // default (no WAL) — keeps mtime test deterministic
  for (const id of ids) {
    store.insertFact({
      scope: HUB_SCOPE, subject: id, predicate: "finding",
      value: findingJson(id), confidence: 1, sourceRunId: null,
      tValid: T, tCreated: T,
    });
  }
  store.close();
}

describe("collectFindings", () => {
  let tmp: string;
  beforeEach(async () => { tmp = await mkdtemp(join(tmpdir(), "bober-hub-")); });
  afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

  it("pools distinct ids across two siblings (sc-2-2)", async () => {
    const a = join(tmp, "kb-a"), b = join(tmp, "kb-b");
    await seedRepo(a, ["f-1", "f-2"]);
    await seedRepo(b, ["f-3"]);
    expect(collectFindings([a, b], HUB_SCOPE)).toHaveLength(3);
  });

  it("dedups an overlapping id to one entry (sc-2-3)", async () => {
    const a = join(tmp, "kb-a"), b = join(tmp, "kb-b");
    await seedRepo(a, ["f-1", "f-2"]);
    await seedRepo(b, ["f-2", "f-3"]);     // f-2 overlaps
    const pooled = collectFindings([a, b], HUB_SCOPE);
    expect(pooled).toHaveLength(3);
    expect(pooled.filter((f) => f.id === "f-2")).toHaveLength(1);
  });
});
```

**readonly byte-unchanged + write-rejected (sc-2-4):**
```ts
it("collect leaves the sibling facts.db byte-unchanged and rejects writes (sc-2-4)", async () => {
  const a = join(tmp, "kb-a");
  await seedRepo(a, ["f-1"]);
  const dbFile = factsDbPath(a);
  const before = await stat(dbFile);
  collectFindings([a], HUB_SCOPE);
  const after = await stat(dbFile);
  expect(after.size).toBe(before.size);
  expect(after.mtimeMs).toBe(before.mtimeMs);

  const ro = new FactStore(dbFile, { readonly: true });
  expect(() => ro.insertFact({
    scope: HUB_SCOPE, subject: "f-x", predicate: "finding",
    value: findingJson("f-x"), confidence: 1, sourceRunId: null,
    tValid: T, tCreated: T,
  })).toThrow();                  // SQLITE_READONLY
  ro.close();
});
```

**FactStore readonly flag (sc-2-1) — extend `src/state/facts.test.ts`:**
```ts
it("readonly:true skips CREATE TABLE and opens read-only", async () => {
  const p = join(tmpDir, "ro.db");
  const w = new FactStore(p);                        // creates table
  w.insertFact({ scope: "s", subject: "x", predicate: "finding",
    value: "v", confidence: 1, sourceRunId: null, tValid: T, tCreated: T });
  w.close();
  const ro = new FactStore(p, { readonly: true });
  expect(ro.getActiveFacts("s")).toHaveLength(1);    // reads fine
  expect(() => ro.invalidateFact("nope", T)).toThrow(); // or insertFact throws
  ro.close();
});
// no-flag regression already covered by facts.test.ts:124-134 (default journal mode + table created)
```

**resolver (sc-2-5) — point at a temp parent with kb-a, kb-b, a non-kb dir, and a missing configured path:**
```ts
it("discovers existing kb-* siblings as absolute paths", async () => {
  const parent = await mkdtemp(join(tmpdir(), "bober-parent-"));
  const projectRoot = join(parent, "agent-bober");
  await seedRepo(join(parent, "kb-a"), ["f-1"]);     // has facts.db
  await seedRepo(join(parent, "kb-b"), ["f-2"]);     // has facts.db
  await mkdtemp(join(parent, "not-kb-"));            // ignored (no kb- prefix)
  const repos = await resolveSiblingRepos(projectRoot);
  expect(repos.sort()).toEqual([join(parent,"kb-a"), join(parent,"kb-b")].sort());
});
it("skips a configured path that does not exist", async () => {
  const repos = await resolveSiblingRepos(projectRoot, [join(tmp,"kb-a"), join(tmp,"ghost")]);
  // only kb-a (seeded) is returned; ghost skipped, no throw
});
```

**Runner:** vitest. **Assertion:** `expect`. **Mock approach:** none — real temp dirs (principles.md:44). **File naming:** `*.test.ts` collocated (`src/hub/collector.test.ts`, `src/hub/repo-resolver.test.ts`).

### E2E Test Pattern
N/A — no Playwright surface for this sprint (CLI-only). The contract's `verificationMethod` is `unit-test` + `build`.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
`src/state/facts.ts` has **17 non-test importers** — but the change is purely additive (a new optional opts key), so risk is mitigated to LOW *iff* the default branch stays byte-identical.

| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/fleet/shared-blackboard.ts` | `new FactStore(path,{journalModeWal,busyTimeoutMs})` | medium | WAL/busy_timeout branches still fire; readonly absent => CREATE TABLE still runs |
| `src/cli/commands/facts.ts`, `vault.ts`, `hub.ts` | `new FactStore(path)` (no opts) | low | default open unchanged; table created |
| `src/medical/{engine,supplements,recommend/*}.ts` | `FactStore`/`factsDbPath` | low | no opts passed -> byte-identical |
| `src/orchestrator/memory/{reconcile,fact-detector,fact-retrieve,fact-judge}.ts` | `FactStore`/`writeFact` | low | constructor signature is additive; writeFact re-export untouched |
| `src/vault/{reindex,index-map}.ts` | `FactStore`/`factsDbPath` | low | unchanged default path |
| `src/cli/index.ts:336` | `registerHubCommand` | low | hub `list` still registers; only the action body grows |

### Existing Tests That Must Still Pass
- `src/state/facts.test.ts` — covers default (no-opts) construction + journal mode (lines 124-134 assert default is NOT WAL and the table exists). MUST stay green = proof the default path is byte-identical (sc-2-1 no-flag half).
- `src/fleet/shared-blackboard.test.ts` — exercises `new FactStore(path,{journalModeWal,busyTimeoutMs})` heavily (WAL mode, concurrency). Verifies the WAL/busy_timeout branches you must leave untouched.
- `src/hub/finding-source.test.ts` — `FactStoreFindingSource.read()` contract the collector relies on (never-throw, schema-skip). Do not change finding-source.ts.
- `src/config/schema.test.ts`, `src/config/loader.test.ts` — only matter if you touch schema.ts (you should NOT — see PITFALL).

### Features That Could Be Affected
- **fleet blackboard** (`src/fleet/`) — shares `FactStore`. Verify WAL writes still work after the readonly branch is added.
- **medical analysis/recommend** (`src/medical/`) — heavy FactStore users. Default construction must be untouched.
- **hub Sprint 3-5 (future)** — own `Finding.id` schema; do not redefine Finding or change `runHubList` signature.

### Recommended Regression Checks (run after implementation)
1. `npm run build` — zero TS errors (sc-2-6). Confirms readonly opts type + new modules typecheck.
2. `npx vitest run src/state/facts.test.ts` — existing no-opts + WAL tests green (byte-identical proof).
3. `npx vitest run src/fleet/shared-blackboard.test.ts` — WAL/busy_timeout path intact.
4. `npx vitest run src/hub/` — Sprint 1 finding/finding-source tests + new collector/resolver tests green.
5. `npm run lint` — `consistent-type-imports`, no unused vars, `.js` extensions.

---

## 8. Implementation Sequence (dependency-ordered)

1. **`src/state/facts.ts`** — add `readonly?: boolean` to the opts type (line ~141); branch the `new Database` open and gate the CREATE TABLE on `!opts?.readonly`. Leave WAL/busy_timeout branches verbatim.
   - Verify: `npx vitest run src/state/facts.test.ts` still green (no-opts path unchanged); add the sc-2-1 readonly test and watch it pass.
2. **`src/hub/repo-resolver.ts`** — `resolveSiblingRepos(projectRoot, configuredRepos?)`; reuse `fileExists` + `factsDbPath`; async `readdir` from `node:fs/promises`.
   - Verify: resolver returns absolute kb-* paths, skips non-kb + non-existent (sc-2-5).
3. **`src/hub/collector.ts`** — `collectFindings(repoPaths, scope=HUB_SCOPE)`; open `{ readonly: true }`, wrap in `FactStoreFindingSource`, dedup by `Finding.id` via `Set`, `finally` close.
   - Verify: pool length == distinct ids (sc-2-2), overlap once (sc-2-3), sibling file byte-unchanged + write rejected (sc-2-4).
4. **`src/cli/commands/hub.ts`** — in the `list` action, after reading own findings, call `resolveSiblingRepos` + `collectFindings`, merge+dedup, pass `{ read: () => merged }` to `runHubList`. Keep error handling (exitCode=1, never throw).
   - Verify: `npm run build` green; manual `bober hub list` still prints own findings and now reflects siblings.
5. **`src/state/facts.test.ts`, `src/hub/repo-resolver.test.ts`, `src/hub/collector.test.ts`** — add the tests from §6.
   - Verify: `npx vitest run src/hub src/state/facts.test.ts` green.
6. **Run full verification** — `npm run build` && `npm run lint` && `npx vitest run` (or at minimum the targeted suites in §7).

---

## 9. Pitfalls & Warnings

- **`config.hub?.repos` does not typecheck against `BoberConfig`.** There is NO `hub` field in `src/config/schema.ts:455-489`, and `schema.ts` is NOT in `estimatedFiles` (the project overview says the FactStore readonly flag is the ONLY permitted core-file edit). **Decouple:** make `resolveSiblingRepos(projectRoot, configuredRepos?)` take `configuredRepos` as a plain parameter (the sc-2-5 test drives it directly). In `hub.ts`, until a typed `hub` section exists, read it defensively, e.g. `const repos = (config as { hub?: { repos?: string[] } }).hub?.repos;` — or pass `undefined` and rely on `kb-*` discovery. Do NOT add a `HubSection` to schema.ts in this sprint unless you also accept the regression surface of `schema.test.ts`/`loader.test.ts`.
- **Do not pass `journalModeWal` when opening readonly.** Setting `PRAGMA journal_mode = WAL` on a read-only connection errors. The collector passes only `{ readonly: true }`, so the WAL branch never runs — keep it that way.
- **better-sqlite3 readonly requires the file to exist.** That is exactly why the resolver filters to `fileExists(factsDbPath(repo))` and the collector wraps each open in try/catch — a sibling without a facts.db is skipped, not fatal (sc-2-5, generator note "skip non-existent").
- **Dedup on `Finding.id`, not the FactStore row id.** The row id is a sha256 `factId` (`src/state/facts.ts:58-69`); two siblings can hold the same `Finding.id` under different row ids. Dedup the parsed `Finding.id`.
- **Keep the default `new Database(dbPath)` branch literally unchanged.** Write `opts?.readonly ? new Database(dbPath,{readonly:true}) : new Database(dbPath)` so the non-readonly path is byte-identical (nonGoal #1, sc-2-1). Do NOT collapse to `new Database(dbPath, opts?.readonly && {...})`.
- **Seed sibling test stores with a default (non-WAL) FactStore.** A WAL store leaves a `-wal` sidecar and can mutate `facts.db` mtime on checkpoint, breaking the sc-2-4 byte-unchanged assertion. Use `new FactStore(factsDbPath(repo))` (no opts) to seed.
- **`runHubList` signature is frozen.** Sprint 1 tests call it with a `FindingSource`. Aggregate by building a merged `Finding[]` and wrapping in an inline `{ read: () => merged }` — do not change `runHubList`'s parameters.
- **Async fs only** (principles.md:42): `readdir`/`stat`/`access` must come from `node:fs/promises`. No `*Sync`.
- **`.js` import extensions + `import type`** on every new file or lint fails.
