# `bober vault reindex` CLI command

**Contract:** sprint-spec-20260628-obsidian-vault-store-3  ·  **Spec:** spec-20260628-obsidian-vault-store  ·  **Completed:** 2026-06-28

## What this sprint added

The **third of the 5-sprint vault storage layer** (`spec-20260628-obsidian-vault-store`). Sprint 1
built the canonical note model and Sprint 2 made FactStore a derived, in-process index over note
frontmatter. This sprint exposes that index as a **user-facing CLI command**: `bober vault reindex`
walks a vault directory, parses every note, and rebuilds the derived FactStore at the
team/namespace memory path by orchestrating the Sprint 1/2 modules (`listNotes` / `readNote` /
`reindexNotes`). It is a thin, domain-agnostic orchestration layer — the reindex/mapping logic from
Sprint 2 is unchanged; this sprint only loads notes from the filesystem and drives them through it.
The command mirrors the existing `facts.ts` / `medical.ts` CLI pattern exactly: it never throws,
always closes the store, and reads the wall clock once at the handler boundary.

## Public surface

- `bober vault reindex --scope <domain> [--vault <dir>]` (CLI command, `src/cli/commands/vault.ts:148`) —
  rebuilds the derived FactStore from a vault directory's note frontmatter and prints per-run counts.
  `--scope` is **required** (the fact scope label, e.g. `medical`, `finance`); `--vault` is optional
  and **defaults to the project root**.
- `registerVaultCommand(program)` (`src/cli/commands/vault.ts:141`) — registers the `vault` command
  tree (currently the single `reindex` subcommand). Imported and called in `src/cli/index.ts`
  (import `:41`, call `:323`) in a `// -- vault --` block between `registerMedicalCommand` and
  `registerFleetCommand`, mirroring `registerFactsCommand` / `registerMedicalCommand`.
- `runVaultReindex(projectRoot, opts, deps?)` (`src/cli/commands/vault.ts:72`) — the extracted,
  testable command core. `opts` is `{ scope: string; vault?: string }`; `deps` is the injectable
  `VaultReindexDeps`. Returns `Promise<ReindexSummary | undefined>` — the Sprint 2 `ReindexSummary`
  on success, or `undefined` when an error occurred (in which case `process.exitCode` is set to `1`).
  Tests inject a temp `projectRoot` and assert on the resulting `facts.db` without spawning a process.
- `VaultReindexDeps` interface (`src/cli/commands/vault.ts:54`) — `{ nowIso?: string }`, the single
  injectable dependency so tests can pin the timestamp; production `.action()` calls pass no deps.

## How to use / how it fits

```bash
# Rebuild the derived FactStore for the 'medical' scope from an Obsidian vault directory
bober vault reindex --scope medical --vault ./kb-medical
# prints:
#   Reindexed vault (scope: medical)
#     notes parsed:      <n>
#     facts added:       <n>
#     facts superseded:  <n>
#     facts unchanged:   <n>
```

`runVaultReindex` resolves the FactStore location via a local `resolveDefaultNamespace` — the active
team's `memoryNamespace` (`loadTeam(config).memoryNamespace`) fed to `factsDbPath(projectRoot, ns)`,
after `ensureFactsDir`. This resolution is **byte-identical to the private `resolveDefaultNamespace`
in `src/cli/commands/facts.ts`** (path parity confirmed by the evaluator), so `bober vault reindex`
and `bober facts` read and write the **same `facts.db`**. Because the reindex writes through the
Sprint 2 `reindexNotes` → existing `writeFact` reconcile-at-ingest path, the FactStore stays a
**rebuildable projection** of the canonical markdown: re-running over unchanged notes is all-`noop`,
a changed frontmatter value supersedes the prior fact, and `status: superseded` notes contribute no
active facts. The command is **read-only over the vault** — it never mutates notes and never touches
git.

## Notes for maintainers

- **`resolveDefaultNamespace` is re-implemented locally.** `facts.ts` does not export its private
  resolver, so `vault.ts` carries a verbatim copy (flagged in the source comment at `:38`). The two
  are byte-identical today and the evaluator confirmed path parity — but they are **not** DRY: if
  `facts.ts` ever changes how it resolves the namespace, `vault.ts` must change in lockstep or the
  two commands will silently diverge on the `facts.db` location. A shared exported helper is the
  obvious follow-up.
- **The store is constructed *before* the vault-directory guard, on purpose.** `listNotes` uses
  `glob`, which returns `[]` (not a throw) for a nonexistent directory, so the command does an
  explicit `stat()` check and throws `Vault directory does not exist: <dir>` (or
  `Vault path is not a directory`) on a bad path. The `FactStore` is opened *before* that `stat()`
  so the `finally` block's `store?.close()` always runs — proven by the missing-vault test, which
  asserts the close spy fires on the error path. On any error the handler writes a `chalk.red`
  `Failed to reindex vault: <message>` to stderr, sets `process.exitCode = 1`, and returns
  `undefined` — it **never** throws.
- **`--vault` defaults to the project root** because there is no config field for a vault path yet.
  Sprint 5's `profile.yaml`/SOPS hook is the natural place to introduce a config-declared default
  vault location; until then callers should pass `--vault` explicitly for a real vault.
- **Wall-clock time is read once** (`deps.nowIso ?? new Date().toISOString()`) at the handler
  boundary and threaded into `reindexNotes` as `now` — neither the store nor the reindex reads the
  clock, preserving the Sprint 2 determinism guarantee.
- **Scope.** One new source file + collocated tests, plus a 4-line wiring change to
  `src/cli/index.ts`; commit `82ebc23`: `src/cli/commands/vault.ts`, `src/cli/commands/vault.test.ts`
  (3 tests: sc-3-3 success path → `facts.db` at the namespace path has active facts with counts > 0,
  sc-3-4 missing-vault no-throw/`exitCode=1`/store-closed, sc-3-2 commander wiring). No new deps;
  full suite **2872 tests** green (was 2869), zero regressions; all four criteria (sc-3-1..sc-3-4)
  passed iteration 1. The Sprint 2 `src/vault/` modules and `src/state/facts.ts` are untouched.
- **Remaining plan.** The Obsidian MCP read/write adapter (Sprint 4) and the `profile.yaml`/SOPS
  hook + status lifecycle (Sprint 5) are still pending. This command reads notes from the local
  filesystem via `note-io`, not via the MCP adapter.
