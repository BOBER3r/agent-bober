# SharedBlackboard module (WAL facts.db wrapper)

**Contract:** sprint-spec-20260618-fleet-blackboard-exchange-1  ·  **Spec:** spec-20260618-fleet-blackboard-exchange  ·  **Completed:** 2026-06-18

## What this sprint added

The **risk-first foundation of Phase B** of `arch-20260618-heterogeneous-multi-provider-agent-team`:
a bounded inter-agent exchange channel over **one shared `facts.db` opened in WAL mode**. New file
`src/fleet/shared-blackboard.ts` exports `BLACKBOARD_MAX_ROUNDS` (= 3), the `BlackboardFinding`
shape, and the `SharedBlackboard` class (a thin wrapper over `FactStore` that publishes findings as
`predicate='finding'` rows and reads siblings'/all findings within a hard round cap). To give the
blackboard WAL concurrency **without changing any existing `FactStore` caller**, `FactStore`'s
constructor gained an **optional second argument** `{ journalModeWal?, busyTimeoutMs? }` that is
default-**off** — when unset, every existing caller (medical, memory, lessons) is byte-identical and
keeps the prior default journal mode (`delete`). This sprint adds **no** coordinator, `runFleet`,
CLI, or `config.fleet` wiring — those are Sprints 2-4. WAL concurrency was the highest unknown in the
architecture, so it was built and proven first.

## Public surface

- `BLACKBOARD_MAX_ROUNDS` (`src/fleet/shared-blackboard.ts:9`) — the hard cap (`3`) on exchange
  rounds. The effective per-instance cap is `min(maxRounds ?? 3, 3)`, so a caller can lower it but
  never raise it above 3.
- `interface BlackboardFinding` (`src/fleet/shared-blackboard.ts:13`) —
  `{ childFolder: string; round: number; payload: string; confidence?: number }`. One finding
  published by one fleet child in one round.
- `interface SharedBlackboardOpts` (`src/fleet/shared-blackboard.ts:20`) —
  `{ dbPath; namespace; busyTimeoutMs?; maxRounds? }` for `open`.
- `SharedBlackboard.open(opts): Promise<SharedBlackboard>` (`src/fleet/shared-blackboard.ts:54`) —
  static async factory. `ensureDir`s the parent directory (skipped for `:memory:`), constructs a
  `FactStore` with `{ journalModeWal: true, busyTimeoutMs: opts.busyTimeoutMs ?? 5000 }` for a
  file-backed db (WAL is **not** forced for `:memory:`), and clamps `maxRounds` to
  `BLACKBOARD_MAX_ROUNDS`. The constructor is `private` — `open` is the only entry point.
- `SharedBlackboard.publish(finding, now): FactRecord` (`src/fleet/shared-blackboard.ts:74`) —
  **throws** `blackboard round <n> exceeds cap <cap>` when `finding.round > maxRounds`; otherwise
  writes a `FactRecord` via `FactStore.insertFact` with `scope=namespace`, `subject=childFolder`,
  `predicate='finding'`, `value=payload`, `confidence=finding.confidence ?? 1`, `sourceRunId=null`,
  and `tValid=tCreated=now`. `now` is a caller-supplied ISO-8601 timestamp — the store never reads
  the clock.
- `SharedBlackboard.readSiblings(selfFolder): FactRecord[]` (`src/fleet/shared-blackboard.ts:96`) —
  all active `'finding'` facts in the namespace **except** those whose `subject === selfFolder`.
  Returns `[]` when empty (never throws).
- `SharedBlackboard.readAll(): FactRecord[]` (`src/fleet/shared-blackboard.ts:103`) — all active
  `'finding'` facts in the namespace. Returns `[]` when empty.
- `SharedBlackboard.close(): void` (`src/fleet/shared-blackboard.ts:108`) — closes the underlying
  `FactStore` connection.
- `FactStore` optional 2nd constructor arg (`src/state/facts.ts:139`) —
  `constructor(dbPath, opts?: { journalModeWal?: boolean; busyTimeoutMs?: number })`. When
  `opts.journalModeWal` is truthy it runs `PRAGMA journal_mode = WAL`; when `opts.busyTimeoutMs` is
  defined it runs `PRAGMA busy_timeout = <ms>`. **Default (no opts) is byte-identical to before** —
  no existing caller passes a second argument, and a default `FactStore`'s `journal_mode` stays
  `delete`.

## How to use / how it fits

`SharedBlackboard` is the on-disk channel by which isolated fleet children (separate OS processes in
separate cwds) will exchange findings. The head injects **one absolute** `facts.db` path; each child
opens it in WAL mode so concurrent writers don't deadlock under `SQLITE_BUSY`.

```ts
import { SharedBlackboard } from "../fleet/shared-blackboard.js";

const bb = await SharedBlackboard.open({
  dbPath: "/abs/path/.bober/memory/<ns>/facts.db",
  namespace: "fleet-run-123",
  busyTimeoutMs: 5000, // default
  maxRounds: 3,        // clamped to BLACKBOARD_MAX_ROUNDS
});

const now = new Date().toISOString();
bb.publish({ childFolder: "child-a", round: 1, payload: "found X" }, now);

bb.readSiblings("child-a"); // findings from every child except child-a
bb.readAll();               // every child's findings
bb.close();
```

Findings live in the **existing** `semantic_facts` schema — there is no migration; the shared db is
just a `facts.db` opened in WAL mode with `predicate='finding'` rows scoped to the run's namespace.
This module **depends only on `FactStore`** (and `better-sqlite3` transitively) — it adds **no**
network or SDK import, keeping it within the fleet module's boundaries.

## Notes for maintainers

- **WAL is opt-in by design.** The blackboard is the *only* caller that asks for WAL today. Do not
  flip the `FactStore` default to WAL — sc-1-7 explicitly guards that a default `FactStore` reports
  `journal_mode === 'delete'`, and the medical / memory / lessons stores rely on the prior default.
- **`:memory:` skips WAL.** WAL has no meaning for an in-memory db, so `open` only requests WAL for a
  file-backed path. Tests that assert WAL use a tmp file path; the `:memory:` path is non-WAL.
- **The round cap is a hard ceiling.** `maxRounds` can lower the cap but `Math.min(..., 3)` prevents
  raising it — `publish` throws past the effective cap (a `maxRounds: 5` instance is still capped at
  3). This is the architecture's bounded-convergence guarantee (ADR-3), not a soft limit.
- **`close()` checkpoints the WAL.** Per ADR-3, closing the connection checkpoints the WAL sidecar;
  a child that crashes mid-write leaves a recoverable WAL (a partial finding is tolerable because
  synthesis is best-effort over whatever findings exist).
- **Not yet wired anywhere.** No coordinator / `runFleet` / CLI / `config.fleet` / `manifest.blackboard`
  references this class yet — those land in Sprints 2-4. This sprint is the standalone, proven module
  only. Architecture: `.bober/architecture/arch-20260618-heterogeneous-multi-provider-agent-team-adr-3.md`
  (and ADR-5 for the head-injected absolute path) — note the ADR sketch's `open(absDbPath)` signature
  was realized as a static `open(opts)` factory taking `{ dbPath, namespace, busyTimeoutMs?, maxRounds? }`.
- **Scope.** Exactly 4 files in `e1d4b00`: `src/fleet/shared-blackboard.ts` (new),
  `src/state/facts.ts` (optional opts param), and their collocated tests. +15 tests; full suite
  **2749 passed** (only the 6 pre-existing cockpit-integration MCP failures remain). All 8 criteria
  passed iteration 1.
