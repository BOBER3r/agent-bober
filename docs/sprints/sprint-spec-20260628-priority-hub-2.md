# Cross-repo read-only collector with sibling resolution and dedup

**Contract:** sprint-spec-20260628-priority-hub-2  ·  **Spec:** spec-20260628-priority-hub  ·  **Completed:** 2026-06-28

## What this sprint added

Sprint 2 turns `bober hub list` from a **single-store** read into a **cross-repo aggregator**.
It adds a sibling-repo resolver (`hub.repos` config → absolute paths, else discover `kb-*`
siblings beside the project root), a pure collector that opens each sibling's derived
`facts.db` **read-only** and pools their findings into one `Finding[]` deduplicated by
`Finding.id`, and a single additive `{ readonly?: boolean }` flag on the `FactStore`
constructor — the spec's only permitted edit to the existing core. The hub can now read
findings from sibling knowledge-base repos **without ever mutating a sibling file**, while
the no-flag `FactStore` path stays byte-identical for the existing ~17 importers.

## Public surface

- `FactStore` constructor opt `{ readonly?: boolean }` (`src/state/facts.ts:141`) — when
  `true`, opens better-sqlite3 with `{ readonly: true }` and **skips** the `CREATE TABLE` /
  `CREATE INDEX` bootstrap; when absent the constructor behaves exactly as before (table
  created, WAL/`busy_timeout` branches untouched). This is the **single permitted existing-core
  edit** for this sprint and is genuinely additive (`git diff` + tests confirm the no-flag path
  is byte-identical).
- `resolveSiblingRepos(projectRoot, configuredRepos?)` (`src/hub/repo-resolver.ts:18`) —
  `async ⇒ Promise<string[]>`. If `configuredRepos` is non-empty it `path.resolve`s each entry
  against `projectRoot` (→ absolute); otherwise it discovers directories named `kb-*` in the
  **parent** of `projectRoot`. Either way it keeps only repos whose derived `facts.db` actually
  exists (`fileExists(factsDbPath(repo))`). **Never throws**: a non-existent configured path or
  a missing/unreadable parent dir is skipped, not fatal.
- `collectFindings(repoPaths, scope = HUB_SCOPE)` (`src/hub/collector.ts:16`) — **pure** (no LLM,
  no network). Opens each repo's `facts.db` as `new FactStore(factsDbPath(repo), { readonly: true })`,
  wraps it in the Sprint 1 `FactStoreFindingSource`, and pools all findings, **deduplicating by
  `Finding.id` (keep-first, stable order)**. Each store open is wrapped in `try/catch/finally` so
  a missing or corrupt sibling is skipped and the handle is always `close()`d.
- `bober hub list` (CLI, `src/cli/commands/hub.ts`) — now lists the project's **own** findings
  **plus** findings aggregated across every resolved sibling. Own-store findings come first and
  win dedup ties; sibling findings whose `id` is already present are dropped. Output format,
  empty-state (`No findings found.`), never-throw error handling, and `process.exitCode = 1` on
  failure are unchanged from Sprint 1.
- `resolveConfiguredRepos(projectRoot)` (`src/cli/commands/hub.ts:59`) — module-private helper.
  Reads the **raw** config JSON (trying `bober.config.json` then `.bober/config.json`,
  `CONFIG_CANDIDATES` at `:24`) with a narrow cast and returns `hub.repos` as `string[]`, or
  `undefined` (→ fall through to `kb-*` discovery) on any error. **It deliberately bypasses the
  Zod config schema** — see Notes.

## How to use / how it fits

```bash
bober hub list
# Lipid panel overdue       [question]  urgency=4  severity=2   # from this repo (own store)
# Portfolio rebalance due   [action]    urgency=3  severity=2   # from ../kb-financial (read-only)
```

The wiring in the `list` action is: read own findings → `resolveConfiguredRepos(projectRoot)`
→ `resolveSiblingRepos(projectRoot, configuredRepos)` → `collectFindings(siblings, HUB_SCOPE)`
→ merge (own first, then unseen sibling ids) → `runHubList({ read: () => merged })`. Because
`runHubList` is the Sprint 1 DI seam, no CLI re-wiring was needed — the multi-store collector is
injected as just another `FindingSource`. To aggregate **explicit** repos, add a `hub.repos`
array of paths (resolved relative to the project root) to `bober.config.json` or
`.bober/config.json`; omit it and the hub discovers `kb-*` clones sitting next to the project root.

## Notes for maintainers

- **The readonly flag is the spec's only allowed core edit — keep the no-flag path byte-identical.**
  The constructor branches on `opts?.readonly` for both the `Database` open and the `CREATE TABLE`
  block. Any future change here must preserve the default path: existing callers must still get a
  writable store with the table bootstrapped and the WAL/`busy_timeout` pragmas applied.
- **`schema.ts` was intentionally NOT edited; `hub.repos` is read from raw JSON.** `BoberConfigSchema`
  runs in Zod strip mode, so an unknown `hub` key would be **silently dropped** by `loadConfig`.
  Rather than promote `hub` to a typed config field this sprint (out of scope), `resolveConfiguredRepos`
  reads the raw config file directly with a narrow `{ hub?: { repos?: unknown } }` cast and filters to
  strings. If a later sprint formalizes `hub` in the config schema, this raw-read helper should be
  retired in favor of the typed `config.hub.repos`.
- **Read-only is a safety guarantee, not just an optimization.** Sibling stores are opened
  `{ readonly: true }`; a write attempt through that handle is rejected by SQLite (`SQLITE_READONLY`),
  and a collect leaves the sibling's `facts.db` byte-unchanged (size + mtime stable, evaluator-verified).
  Never open a sibling store writable and never run a migration against one.
- **The collector mirrors fleet `synthesis.collect`** (`src/fleet/synthesis.ts`): pure data shaping,
  resilient to a bad sibling (skip, never fatal), always closing handles. Keep it LLM-free and
  network-free.
- **Sibling paths are absolute by discipline** (the `resolveBlackboardPath` ABSOLUTE convention from
  fleet). `resolveSiblingRepos` always returns absolute paths; do not pass relative paths downstream.

## Scope

Commit `708c799`: additive `{ readonly?: boolean }` on the `FactStore` constructor
(`src/state/facts.ts`, the lone existing-core edit; no-flag path byte-identical), two new
`src/hub/` modules (`repo-resolver.ts` `resolveSiblingRepos` + private `discoverKbSiblings`;
`collector.ts` `collectFindings`), and an extended `src/cli/commands/hub.ts` `list` action with
the private `resolveConfiguredRepos` raw-JSON helper. No new dependencies; `schema.ts` untouched.
36 new tests (facts readonly read-ok/write-throws + no-flag-still-creates-table regression;
6 resolver tests; 7 collector tests); full suite **3178** green (+36 from baseline 3142). All six
required criteria (`sc-2-1..sc-2-6`) passed **iteration 1** (zero reworks); typecheck + build + lint
exit 0 (2 pre-existing unrelated lint warnings). Eval
`eval-sprint-spec-20260628-priority-hub-2-1` → **pass** (6/6 required).

Cross-repo aggregation now lands; the lens judge / scope parsing / ranking are **Sprint 3**,
`priority.md` rendering + `decide` are **Sprint 4**, and the chat hub surface is **Sprint 5**.
