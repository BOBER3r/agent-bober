# Bi-temporal SQLite semantic-facts store + `bober facts` CLI

**Contract:** sprint-spec-20260615-memory-self-improve-p0-1  ·  **Spec:** spec-20260615-memory-self-improve-p0  ·  **Completed:** 2026-06-15

## What this sprint added

The first relational store in the project: a bi-temporal **semantic-facts** store
(`src/state/facts.ts`) backed by `better-sqlite3`, plus a `bober facts add|list|show|invalidate`
CLI. A fact is a `(scope, subject, predicate, value)` row with a confidence score, optional
source-run provenance, and four temporal columns (`t_valid`, `t_invalid`, `t_created`,
`t_invalidated`). Facts are **never deleted** — invalidation is a soft-delete that stamps
`t_invalidated`, so history is preserved and "what did we believe at time T" stays answerable.
This is the storage foundation for the memory-self-improvement plan (P0); later sprints will
produce/reconcile facts automatically — this sprint only lands the store and a manual CLI.

The driver is deliberately hidden behind the `FactStore` class so it can be swapped for the
built-in `node:sqlite` once `engines.node` is raised to `>=22.5`. The store is **pure**: it
never reads the wall clock — every timestamp is a caller-supplied parameter — mirroring the
discipline already used in `src/orchestrator/memory/distill.ts`.

## Public surface

- `class FactStore` (`src/state/facts.ts:130`) — bi-temporal SQLite fact store. Constructor `new FactStore(dbPath)` takes a DB path (file path or `':memory:'`) and idempotently bootstraps the `semantic_facts` table + two indexes. Methods:
  - `insertFact(input: FactInput): FactRecord` (`facts.ts:158`) — validates with `FactSchema`, derives the deterministic id, upserts (`INSERT OR REPLACE`), returns the record.
  - `getActiveFacts(scope, subject?, predicate?): FactRecord[]` (`facts.ts:207`) — all non-invalidated facts (`t_invalidated IS NULL`) in `scope`, optionally narrowed by `subject` and/or `predicate`.
  - `getFact(id): FactRecord | null` (`facts.ts:248`) — one fact by id **regardless of invalidation status** (so invalidated facts remain inspectable).
  - `invalidateFact(id, tInvalidated): boolean` (`facts.ts:260`) — soft-delete; sets `t_invalidated` only if currently active. Returns `false` if the id is unknown or already invalidated (never deletes a row).
  - `close(): void` (`facts.ts:272`) — closes the underlying connection.
- `FactSchema` Zod schema + `FactInput` type (`src/state/facts.ts:16`) — input shape: `scope`, non-empty `subject`/`predicate`/`value`, `confidence` (0–1, default 1), nullable `sourceRunId`, ISO-8601 `tValid`/`tCreated`. The store never stamps these itself.
- `interface FactRecord` (`src/state/facts.ts:31`) — persisted shape returned by the store, including the two read-side temporal columns `tInvalid` and `tInvalidated`.
- `factId(scope, subject, predicate, value, tCreated): string` (`src/state/facts.ts:52`) — deterministic 16-char hex content hash, `sha256(\`${scope}|${subject}|${predicate}|${value}|${tCreated}\`).slice(0,16)`, mirroring `lessonIdFromSignature` in `distill.ts`. Identical inputs always yield the same id.
- `factsDbPath(projectRoot, namespace?): string` (`src/state/facts.ts:71`) — resolves `<memoryDir>/facts.db`, reusing the same `memoryDir(projectRoot, namespace)` mapping rule as the lessons store (no duplication).
- `ensureFactsDir(projectRoot, namespace?): Promise<void>` (`src/state/facts.ts:80`) — `ensureDir` for the memory directory; the CLI handler calls this before opening a file-backed store (not needed for `':memory:'`).
- `registerFactsCommand(program)` (`src/cli/commands/facts.ts:53`) — registers the `bober facts` command group; wired in `src/cli/index.ts:314` next to `registerMemoryCommand`.
- CLI `bober facts add|list|show <id>|invalidate <id>` (`src/cli/commands/facts.ts`) — see usage below.
- **Dependency:** `better-sqlite3 ^11.9.1` (runtime) + `@types/better-sqlite3 ^7.6.13` (dev) added to `package.json`. This is the project's first relational/native dependency.

## How to use / how it fits

The on-disk DB lives at `.bober/memory/facts.db` (the default `programming` scope; per-team
namespaces map under `.bober/memory/<ns>/facts.db`, following the same rule as the lessons
`INDEX.md`). The CLI resolves the namespace from the active team via a non-fatal
`loadConfig` + `loadTeam(config).memoryNamespace`, defaulting to `.bober/memory/` when no
config is present. Handlers never throw — on error they print a friendly message and set
`process.exitCode = 1` (the `src/cli/commands/memory.ts` convention).

```bash
# Add a fact (t_created/t_valid are stamped at the handler boundary, not in the store)
bober facts add --scope programming --subject project --predicate testCommand --value vitest

# List active (non-invalidated) facts, optionally filtered
bober facts list
bober facts list --subject project --predicate testCommand

# Inspect one fact with full provenance + temporal fields (works even after invalidation)
bober facts show <id>

# Soft-delete: removes it from `list` but `show` still returns it
bober facts invalidate <id>
```

Programmatic use stamps the clock at the call site, then hands ISO strings to the store:

```ts
import { FactStore, factsDbPath, ensureFactsDir } from "./state/facts.js";

await ensureFactsDir(projectRoot, ns);
const store = new FactStore(factsDbPath(projectRoot, ns));
try {
  const now = new Date().toISOString();           // clock read OUTSIDE the store
  const rec = store.insertFact({
    scope: "programming", subject: "project", predicate: "testCommand",
    value: "vitest", confidence: 1, sourceRunId: null, tValid: now, tCreated: now,
  });
  const active = store.getActiveFacts("programming");   // includes rec
  store.invalidateFact(rec.id, new Date().toISOString());
  store.getActiveFacts("programming");                  // excludes rec
  store.getFact(rec.id);                                // still returns rec
} finally {
  store.close();
}
```

## Notes for maintainers

- **`better-sqlite3` is a native module.** It must compile during `npm install`
  (prebuilt binaries normally make this transparent). It is **synchronous** by design —
  this is intentional and does not violate the async-fs principle, which targets
  `node:fs` bulk reads/writes, not a transactional DB driver.
- **Swappability is the point.** Callers in later sprints must depend on the `FactStore`
  class / its method shape, **not** on `better-sqlite3` directly — no driver type leaks
  through the public surface, so the engine can be swapped for `node:sqlite` later.
- **The store never reads the clock.** Every timestamp (`tValid`, `tCreated`,
  `tInvalidated`) is a parameter; the CLI stamps `new Date().toISOString()` at the handler
  boundary. Do not introduce `Date.now()` / `new Date()` inside `facts.ts`.
- **`insertFact` is an upsert** (`INSERT OR REPLACE`). Because the id is a content hash over
  `scope|subject|predicate|value|tCreated`, re-inserting the identical fact with the same
  `tCreated` overwrites the same row (and resets it to active) rather than creating a
  duplicate — this is by design for deterministic, idempotent producers.
- **Scope is the per-team isolation axis** in-table; the DB **file path** is also
  namespaced. Active fact = `t_invalidated IS NULL`. Indexes: `idx_facts_sp(scope, subject,
  predicate)` and `idx_facts_active(scope, t_invalidated)`.
- **`t_invalid` is currently always written `NULL`.** It is reserved as the valid-time
  upper bound for the bi-temporal model; only `t_invalidated` (transaction-time soft-delete)
  is exercised by this sprint's CLI.
- **Not yet wired into planning or the pipeline.** The planner still consumes only the
  lessons `INDEX.md`; nothing reads `facts.db` automatically yet. Producers and a
  reconcile/retrieval path are later sprints in `spec-20260615-memory-self-improve-p0`.
