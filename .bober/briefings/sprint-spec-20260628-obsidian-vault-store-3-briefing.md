# Sprint Briefing: `bober vault reindex` CLI command

**Contract:** sprint-spec-20260628-obsidian-vault-store-3
**Generated:** 2026-06-28T00:00:00.000Z

---

## 0. TL;DR for the Generator

Create `src/cli/commands/vault.ts` that exports:
1. `runVaultReindex(projectRoot, opts, deps?)` — the **extracted testable core** (mirror `runWhoopSync`, `src/cli/commands/medical.ts:43-121`).
2. `registerVaultCommand(program)` — declares `vault reindex --scope <domain> [--vault <dir>]` (mirror `registerFactsCommand` shape, `src/cli/commands/facts.ts:54`, and `registerMedicalCommand`, `src/cli/commands/medical.ts:130-189`).

Then wire `registerVaultCommand(program)` into `src/cli/index.ts` (import at top next to line 40; call next to line 319). Add `src/cli/commands/vault.test.ts`.

**The whole command is an orchestration of already-built pieces — write almost no new logic.** Flow inside `runVaultReindex`:
`loadConfig` -> resolve namespace (mirror `resolveDefaultNamespace`) -> `ensureFactsDir` -> stamp `now` ONCE -> `new FactStore(factsDbPath(...))` -> `listNotes(vaultDir)` -> `readNote` each -> `reindexNotes(store, notes, { scope, now })` -> print counts with `chalk.green` -> `finally { store.close() }`; catch -> `chalk.red` to stderr + `process.exitCode = 1` (NEVER throw).

---

## 1. Target Files

### `src/cli/commands/vault.ts` (create)

**Directory pattern:** Command modules in `src/cli/commands/` are kebab/lower-case `.ts` files, each exporting a `register<Name>Command(program)` (e.g. `facts.ts`, `medical.ts`, `blackboard.ts`). Some also export a standalone testable core (e.g. `medical.ts` exports `runWhoopSync`).

**Most similar existing file:** `src/cli/commands/medical.ts` — it has BOTH the `register*Command` registration AND the extracted, dependency-injectable testable core (`runWhoopSync`). Follow it almost line-for-line.

**Structure template (synthesized from `medical.ts` + `facts.ts`):**
```ts
// src/cli/commands/vault.ts
import chalk from "chalk";
import type { Command } from "commander";

import { findProjectRoot } from "../../utils/fs.js";
import { loadConfig } from "../../config/loader.js";
import { loadTeam } from "../../teams/registry.js";
import { FactStore, factsDbPath, ensureFactsDir } from "../../state/facts.js";
import { listNotes, readNote } from "../../vault/note-io.js";
import { reindexNotes } from "../../vault/reindex.js";
import type { VaultNote } from "../../vault/types.js";

async function resolveRoot(): Promise<string> {            // mirror facts.ts:29-32 / medical.ts:23-26
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

// Mirror facts.ts:41-50 — NOT exported from facts.ts, so re-implement here.
async function resolveDefaultNamespace(projectRoot: string): Promise<string | undefined> {
  try {
    const config = await loadConfig(projectRoot);
    return loadTeam(config, undefined).memoryNamespace || undefined;
  } catch {
    return undefined;
  }
}

export interface VaultReindexDeps { nowIso?: string }       // mirror WhoopSyncDeps medical.ts:30-36

export async function runVaultReindex(
  projectRoot: string,
  opts: { scope: string; vault?: string },
  deps: VaultReindexDeps = {},
): Promise<void> {
  let store: FactStore | undefined;                          // declare OUTSIDE try so finally can close (medical.ts:48)
  try {
    const ns = await resolveDefaultNamespace(projectRoot);
    await ensureFactsDir(projectRoot, ns);                   // facts.ts:83 / facts.ts:86-91
    const now = deps.nowIso ?? new Date().toISOString();     // STAMP ONCE at boundary (facts.ts:86, medical.ts:89)
    const vaultDir = opts.vault ?? projectRoot;              // DOCUMENTED DEFAULT — see §7 (generator decision)
    const paths = await listNotes(vaultDir);                 // throws/empties if dir missing -> caught below
    const notes: VaultNote[] = [];
    for (const p of paths) notes.push(await readNote(p));
    store = new FactStore(factsDbPath(projectRoot, ns));     // facts.ts:99
    const summary = await reindexNotes(store, notes, { scope: opts.scope, now });
    process.stdout.write(chalk.green(`Reindexed vault (scope: ${opts.scope})\n`)); // medical.ts:156/108
    process.stdout.write(`  notes parsed:      ${summary.notesParsed}\n`);
    process.stdout.write(`  facts added:       ${summary.factsAdded}\n`);
    process.stdout.write(`  facts superseded:  ${summary.factsSuperseded}\n`);
    process.stdout.write(`  facts unchanged:   ${summary.factsNoop}\n`);
  } catch (err) {                                            // facts.ts:135-142 / medical.ts:111-117
    process.stderr.write(
      chalk.red(`Failed to reindex vault: ${err instanceof Error ? err.message : String(err)}\n`),
    );
    process.exitCode = 1;
  } finally {
    store?.close();                                          // ALWAYS close (medical.ts:118-120 / facts.ts:132-134)
  }
}

export function registerVaultCommand(program: Command): void {
  const vaultCmd = program.command("vault").description("Vault knowledge-base utilities (reindex)");
  vaultCmd
    .command("reindex")
    .description("Rebuild the derived FactStore from a vault directory's note frontmatter")
    .requiredOption("--scope <domain>", "Fact scope label (e.g. medical, finance)")
    .option("--vault <dir>", "Vault directory to read notes from (default: project root)")
    .action(async (opts: { scope: string; vault?: string }) => {
      const projectRoot = await resolveRoot();
      await runVaultReindex(projectRoot, opts);             // production: no deps (medical.ts:185-188)
    });
}
```
> NOTE: `--vault` default of `projectRoot` is a generator decision — see §7. The `.requiredOption("--scope")` mirrors `facts.ts:65`. Decide whether the `--scope` validation message wording needs a default; `facts add` gives `--scope` a default of `"programming"` (`facts.ts:65`) but vault reindex should keep it required with no default so the user is explicit per scope/domain.

### `src/cli/commands/vault.test.ts` (create)

**Most similar existing files:** `src/cli/commands/medical.test.ts` (drives the extracted core + exit-code/no-throw assertions) and `src/vault/note-io.test.ts` (temp-dir fixture creation). Combine both — see §6.

---

## 2. Patterns to Follow

### Pattern A — Extracted, injectable testable core (`runWhoopSync` shape)
**Source:** `src/cli/commands/medical.ts`, lines 30-47 and 118-120
```ts
/** Injectable dependencies for runWhoopSync — production callers pass undefined. */
export interface WhoopSyncDeps {
  client?: WhoopClient;
  /** Override the current time ISO string (default: new Date().toISOString()). */
  nowIso?: string;
}

export async function runWhoopSync(
  projectRoot: string,
  opts: { since?: string },
  deps: WhoopSyncDeps = {},
): Promise<void> {
  let store: HealthDataStore | undefined;
  try {
    // ...
  } finally {
    store?.close(); // always close — even if sync threw mid-pagination (sc-3-8)
  }
}
```
**Rule:** Export a `run*` core that takes `projectRoot` + `opts` + an optional `deps` (for `nowIso`); declare `store` with `let store: FactStore | undefined` OUTSIDE the `try` so the `finally` can `store?.close()`. The `.action()` calls the core with no deps.

### Pattern B — Now stamped ONCE at the handler boundary
**Source:** `src/cli/commands/facts.ts`, line 86 (and `src/cli/commands/medical.ts:89`)
```ts
// Stamp wall-clock time at handler boundary — NEVER inside the store
const now = new Date().toISOString();
```
**Rule:** Read the clock exactly once, at the top of the core, then thread `now` into `reindexNotes({ ..., now })`. Use `deps.nowIso ?? new Date().toISOString()` so tests can pin time (mirrors `medical.ts:89`). The store and `reindexNotes`/`noteToFacts` are PURE and must never read the clock (`reindex.ts:11-14`, `index-map.ts:1-10`).

### Pattern C — Namespace + facts.db path resolution (DO NOT invent a path)
**Source:** `src/cli/commands/facts.ts`, lines 41-50 (resolver) and 82-99 (usage)
```ts
async function resolveDefaultNamespace(projectRoot: string): Promise<string | undefined> {
  try {
    const config = await loadConfig(projectRoot);
    return loadTeam(config, undefined).memoryNamespace || undefined;
  } catch {
    return undefined;
  }
}
// ...in the handler:
const ns = await resolveDefaultNamespace(projectRoot);
await ensureFactsDir(projectRoot, ns);
// ...
const store = new FactStore(factsDbPath(projectRoot, ns));
```
**Rule:** Resolve the namespace via `loadTeam(config, undefined).memoryNamespace || undefined`, call `ensureFactsDir(projectRoot, ns)` BEFORE constructing the store, then `new FactStore(factsDbPath(projectRoot, ns))`. `resolveDefaultNamespace` is **private** in `facts.ts` (not exported) — re-implement it verbatim in `vault.ts`. NOTE: `--scope` is the FactStore **scope label** (passed to `reindexNotes`), NOT the team/namespace selector. Namespace comes from the default team (mirrors `facts.ts`). See §9.

### Pattern D — Error/finally discipline (handler MUST NOT throw)
**Source:** `src/cli/commands/facts.ts`, lines 132-142 (quoted EXACTLY)
```ts
          } finally {
            store.close();
          }
        } catch (err) {
          process.stderr.write(
            chalk.red(
              `Failed to add fact: ${err instanceof Error ? err.message : String(err)}\n`,
            ),
          );
          process.exitCode = 1;
        }
```
**Rule:** Wrap the body in `try/catch/finally`. On ANY error: write `chalk.red(...)` to `process.stderr` and set `process.exitCode = 1` — never re-throw. The `finally` always closes the store. (Contract non-goal: "mirror `src/cli/commands/facts.ts:135-142`".)

### Pattern E — Count printing with chalk.green
**Source:** `src/cli/commands/medical.ts`, lines 156-158 (and 108-110)
```ts
process.stdout.write(chalk.green(`Imported ${file}\n`));
process.stdout.write(`  records parsed: ${result.recordsParsed}\n`);
process.stdout.write(`  new rows:       ${result.newRows}\n`);
```
**Rule:** Print a `chalk.green` success headline, then one indented `  label: value` line per count. For vault reindex, print `summary.notesParsed`, `summary.factsAdded`, `summary.factsSuperseded`, `summary.factsNoop` (the four fields of `ReindexSummary`, `reindex.ts:35-47`). Use `process.stdout.write`, NOT `console.log`.

### Pattern F — Command registration (commander subcommand tree)
**Source:** `src/cli/commands/facts.ts`, lines 54-71 and `src/cli/commands/medical.ts:130-188`
```ts
export function registerFactsCommand(program: Command): void {
  const factsCmd = program
    .command("facts")
    .description("Inspect and manage semantic bi-temporal facts (...)");
  factsCmd
    .command("add")
    .description("Insert a new semantic fact into the store")
    .requiredOption("--scope <scope>", "Fact scope (e.g. programming)", "programming")
    // ...
    .action(async (opts: { /*...*/ }) => { /*...*/ });
}
```
And the medical action delegating to the extracted core (`medical.ts:185-188`):
```ts
    .action(async (opts: { since?: string }) => {
      const projectRoot = await resolveRoot();
      await runWhoopSync(projectRoot, opts);
    });
```
**Rule:** `program.command("vault")` -> `.command("reindex")` with `.requiredOption("--scope <domain>", ...)` and `.option("--vault <dir>", ...)`; the `.action` resolves the root then calls `runVaultReindex(projectRoot, opts)`.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `findProjectRoot` | `src/utils/fs.ts:58-79` | `(startDir?: string) => Promise<string \| null>` | Walk up for `bober.config.json`/`package.json`; resolver returns `?? process.cwd()`. |
| `ensureDir` | `src/utils/fs.ts:45-47` | `(path: string) => Promise<void>` | mkdir recursive (used transitively by `ensureFactsDir`/`writeNote`). |
| `loadConfig` | `src/config/loader.ts:142` | `(projectRoot: string) => Promise<BoberConfig>` | Load+validate config; THROWS if no config file found — wrap in try/catch (the namespace resolver swallows it). |
| `loadTeam` | `src/teams/registry.ts:35` | `(config: BoberConfig, teamId?: string) => Team` | Resolve a Team; `undefined`/`"programming"` => programming team with `memoryNamespace: ""` (`registry.ts:72`). |
| `factsDbPath` | `src/state/facts.ts:77-79` | `(projectRoot: string, namespace?: string) => string` | Absolute path to `facts.db` under the namespace memory dir. DO NOT build this path by hand. |
| `ensureFactsDir` | `src/state/facts.ts:86-91` | `(projectRoot: string, namespace?: string) => Promise<void>` | Create the memory dir before constructing a file-backed `FactStore`. Call before `new FactStore`. |
| `FactStore` (ctor) | `src/state/facts.ts:136-167` | `new FactStore(dbPath: string, opts?: { journalModeWal?; busyTimeoutMs? })` | SQLite-backed store; pass `factsDbPath(...)`. Use `":memory:"` in pure tests. |
| `FactStore.getActiveFacts` | `src/state/facts.ts:222` | `(scope, subject?, predicate?) => FactRecord[]` | Active (non-invalidated) facts — use in tests to assert reindex results. |
| `FactStore.close` | `src/state/facts.ts:303-305` | `() => void` | Close the DB connection — MUST be in the `finally`. |
| `memoryDir` | `src/state/memory.ts:27-32` | `(projectRoot, namespace?) => string` | Namespace->dir mapping (`""`/`"programming"`/undefined -> `.bober/memory/`). Used internally by `factsDbPath`; do not duplicate. |
| `listNotes` (Sprint 1) | `src/vault/note-io.ts:49-51` | `(vaultDir: string) => Promise<string[]>` | Absolute paths of every `.md` under `vaultDir`, recursive (glob). |
| `readNote` (Sprint 1) | `src/vault/note-io.ts:27-30` | `(path: string) => Promise<VaultNote>` | readFile + parse frontmatter -> typed `VaultNote`. |
| `reindexNotes` (Sprint 2) | `src/vault/reindex.ts:66-108` | `(store, notes, { scope, now, sourceRunId?, judge? }) => Promise<ReindexSummary>` | Reconcile-at-ingest builder; returns `{ notesParsed, factsAdded, factsSuperseded, factsNoop }`. |
| `ReindexSummary` (type) | `src/vault/reindex.ts:35-47` | interface | The four counts to print. |
| `SUPERSEDED_STATUS` | `src/vault/reindex.ts:30` | `NoteStatus = "superseded"` | Already consumed inside `reindexNotes`; you don't filter notes yourself. |
| `VaultNote` (type) | `src/vault/types.ts:12-22` | `{ frontmatter: Record<string,unknown>; body: string; path: string }` | Shape returned by `readNote`. |
| `writeNote` (Sprint 1, tests) | `src/vault/note-io.ts:38-41` | `(note: VaultNote) => Promise<void>` | Write a note to disk — useful for building a fixture vault in the test. |

**Utilities reviewed:** `src/utils/fs.ts`, `src/state/facts.ts`, `src/state/memory.ts`, `src/config/loader.ts`, `src/teams/registry.ts`, `src/vault/*` — all relevant ones listed above. There is NO config-declared vault path field (verified: `grep -rni "vault" src/config/` returns nothing), so the `--vault` default is hardcoded — see §7.

---

## 4. Prior Sprint Output

### Sprint 1: Vault note I/O (`src/vault/note-io.ts`, `frontmatter.ts`, `types.ts`)
**Created/exports:** `listNotes(dir)` (`note-io.ts:49`), `readNote(path)` (`note-io.ts:27`), `writeNote(note)` (`note-io.ts:38`); `parseNote`/`serializeNote` (`frontmatter.ts:172,180`); `VaultNote`/`NoteStatus` (`types.ts:12,30`).
**Connection:** This sprint calls `listNotes(vaultDir)` then `readNote(p)` per path to build the `VaultNote[]` fed to `reindexNotes`. Use `writeNote`/`serializeFrontmatter` to author fixture notes in the test.

### Sprint 2: Reindex builder (`src/vault/reindex.ts`, `index-map.ts`)
**Created/exports:** `reindexNotes(store, notes, opts)` (`reindex.ts:66`), `ReindexSummary` (`reindex.ts:35`), `SUPERSEDED_STATUS` (`reindex.ts:30`); `noteToFacts` (`index-map.ts:47`).
**Connection:** This sprint is the CLI driver for `reindexNotes`. Pass `{ scope: opts.scope, now }`. Do NOT touch the mapping/reconcile logic (contract non-goal). `reindexNotes` already skips superseded notes and routes through `writeFact` — you only orchestrate I/O + store lifecycle + printing.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` consulted for this briefing scope. The governing rules are encoded in the contract `nonGoals`/`assumptions` and the code patterns above:
- CLI handlers MUST NOT throw — set `process.exitCode = 1` and return (`facts.ts:10-12`, `facts.ts:135-142`).
- Clock is read ONCE at the handler boundary; stores/mappers are PURE (`facts.ts:86`, `reindex.ts:11-14`, `state/facts.ts:130`).
- Do not invent a facts.db location — resolve via `loadTeam(...).memoryNamespace` + `factsDbPath` (`facts.ts:41-50,99`).

### Architecture Decisions
`.bober/architecture/` exists but contains no ADR specific to the vault store. Relevant cross-cutting ADR referenced in memory: facts via FactStore (ADR-7). No vault-specific ADR found — none required.

### Other Docs / Module-level contracts (authoritative comments)
- `src/state/memory.ts:16-32` — namespace mapping rule (`""`/`"programming"`/undefined -> `.bober/memory/`, else `.bober/memory/<ns>/`).
- `src/state/facts.ts:81-91` — `ensureFactsDir` "Must be called by the CLI handler before constructing a file-backed FactStore."
- `src/vault/reindex.ts:1-14` — reindex is PURE w.r.t. clock; `now` is injected.
- ESM rule: every relative import uses an explicit `.js` extension (see all imports in `facts.ts:17-25`, `medical.ts:7-19`).

---

## 6. Testing Patterns

### Unit Test Pattern (extracted-core + temp project root + exit-code/no-throw)
**Source:** `src/cli/commands/medical.test.ts` (lifecycle 49-65, no-throw + finally 249-292, commander wiring 297-332) and `src/vault/note-io.test.ts:8-19` (temp dir).
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
const originalExitCode = process.exitCode;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-vault-cli-"));
  process.exitCode = 0;
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = originalExitCode as number | undefined;
});
```
**Success path (sc-3-3)** — build a fixture vault, run the core, assert facts.db has active facts + counts > 0:
```ts
it("reindexes a fixture vault into the namespace facts.db", async () => {
  // 1. author fixture notes under a vault subdir (use writeNote from Sprint 1)
  const { writeNote } = await import("../../vault/note-io.js");
  const vaultDir = join(tmpDir, "kb");
  await writeNote({ frontmatter: { id: "p1", drug: "metformin", dose: "500mg" }, body: "", path: join(vaultDir, "p1.md") });
  await writeNote({ frontmatter: { id: "p2", drug: "aspirin" }, body: "", path: join(vaultDir, "p2.md") });

  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

  // 2. run the extracted core against the temp project root (no config => ns undefined)
  const { runVaultReindex } = await import("./vault.js");
  await runVaultReindex(tmpDir, { scope: "medical", vault: vaultDir }, { nowIso: "2026-06-28T00:00:00.000Z" });
  stdoutSpy.mockRestore();

  // 3. assert facts.db at the resolved namespace path has the expected active facts
  const { FactStore, factsDbPath } = await import("../../state/facts.js");
  const store = new FactStore(factsDbPath(tmpDir, undefined)); // ns undefined -> .bober/memory/facts.db
  try {
    const active = store.getActiveFacts("medical");
    expect(active.length).toBeGreaterThan(0);
    expect(active.some((f) => f.predicate === "drug" && f.value === "metformin")).toBe(true);
  } finally { store.close(); }
  expect(process.exitCode).toBe(0);
});
```
**Missing-vault path (sc-3-4)** — point `--vault` at a nonexistent dir; assert exitCode=1, red stderr, NO throw, store closed:
```ts
it("does not throw on a missing vault: sets exitCode=1, writes red stderr, closes store", async () => {
  const stderrWrites: string[] = [];
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((c) => { stderrWrites.push(String(c)); return true; });
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const { FactStore } = await import("../../state/facts.js");
  const closeSpy = vi.spyOn(FactStore.prototype, "close");

  const { runVaultReindex } = await import("./vault.js");
  // MUST NOT reject (mirrors medical.test.ts:282)
  await expect(
    runVaultReindex(tmpDir, { scope: "medical", vault: join(tmpDir, "does-not-exist") }, { nowIso: "2026-06-28T00:00:00.000Z" }),
  ).resolves.toBeUndefined();

  stderrSpy.mockRestore(); stdoutSpy.mockRestore();
  expect(process.exitCode).toBe(1);
  expect(stderrWrites.join("")).toMatch(/Failed to reindex vault/);
  // NOTE: see §9 — if the store is constructed AFTER listNotes(), a glob that
  // resolves to [] will NOT throw. Force the error path with a real failure
  // (e.g. an unreadable path) OR construct/close the store before listNotes.
});
```
**Commander wiring smoke test (sc-3-2)** — mirror `medical.test.ts:297-332`:
```ts
it("vault reindex is registered and reachable via parseAsync", async () => {
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const fsUtils = await import("../../utils/fs.js");
  const rootSpy = vi.spyOn(fsUtils, "findProjectRoot").mockResolvedValue(tmpDir);
  try {
    const { Command } = await import("commander");
    const { registerVaultCommand } = await import("./vault.js");
    const program = new Command();
    program.exitOverride();
    registerVaultCommand(program);
    await program.parseAsync(["node", "bober", "vault", "reindex", "--scope", "medical", "--vault", join(tmpDir, "kb")]);
  } finally { stderrSpy.mockRestore(); stdoutSpy.mockRestore(); rootSpy.mockRestore(); }
});
```
**Runner:** vitest. **Assertion style:** `expect`. **Mock approach:** `vi.spyOn(process.stdout/stderr, "write")`, `vi.spyOn(FactStore.prototype, "close")`, `vi.spyOn(fsUtils, "findProjectRoot")`; inject `deps.nowIso` instead of mocking the clock. **File naming:** `vault.test.ts` co-located in `src/cli/commands/`. **Location:** co-located (not in a `__tests__/`).

> Tip: prefer `vi.spyOn(fsUtils, "findProjectRoot")` + injecting `projectRoot` directly over `vi.mock` — the medical test only `vi.mock`s `loadConfig`/`WhoopTokenStore` because of network/credentials; your core has no network so you can drive it directly with a temp `projectRoot` and a fixture `--vault`.

### E2E Test Pattern
Not applicable — no Playwright/`e2e/` for CLI command sprints. The "commander wiring smoke test" above is the closest analog (drives the real `program.parseAsync`).

---

## 7. The `--vault` Default — GENERATOR DECISION (documented)

There is **no config-declared vault path** in the schema (verified `grep -rni "vault" src/config/` -> empty). So when `--vault` is omitted the default must be hardcoded and documented. Candidates from the contract assumption (`facts.ts`-style, contract line 56):
1. **`projectRoot`** (recommended default) — `opts.vault ?? projectRoot`. Simplest, no new config, matches the contract's first listed candidate. RISK: `listNotes(projectRoot)` recursively globs ALL `.md` in the repo (docs, READMEs) — fine for correctness but noisy in this monorepo. Document clearly in the `--option` help text and the command description.
2. A config-declared vault path — NOT available (no schema field); adding one is out of scope for this sprint.

**Recommendation:** default to `projectRoot`, set the option help to `"Vault directory to read notes from (default: project root)"`, and document it in the command description. Keep `--scope` `requiredOption` (no default) so the user is explicit about the domain. If the generator prefers a narrower default (e.g. require `--vault`), it may, but must keep `--vault` optional per sc-3-2 — so a default is mandatory.

---

## 8. Implementation Sequence

1. **`src/cli/commands/vault.ts` — extracted core `runVaultReindex`** — implement the template in §1 using Patterns A-E. Reuse ALL listed utilities; write no new mapping/reconcile/path logic.
   - Verify: `let store: FactStore | undefined` is declared outside `try`; `now` is stamped once; `finally { store?.close() }`; catch sets `process.exitCode = 1` and writes `chalk.red` (never `throw`).
2. **`src/cli/commands/vault.ts` — `registerVaultCommand(program)`** — declare `vault reindex --scope <domain> [--vault <dir>]` (Pattern F); `.action` calls `runVaultReindex(projectRoot, opts)`.
   - Verify: `tsc` has no unused-import errors; `--scope` is `requiredOption`, `--vault` is `option`.
3. **`src/cli/index.ts` — wire it in** — add `import { registerVaultCommand } from "./commands/vault.js";` next to line 40 (the `registerMedicalCommand` import) / line 41, and add `registerVaultCommand(program);` next to line 319 (after `registerMedicalCommand(program);`). See §10 for exact lines.
   - Verify: `grep -n registerVaultCommand src/cli/index.ts` shows BOTH the import and the call (evaluatorNotes require this).
4. **`src/cli/commands/vault.test.ts`** — add the three tests from §6 (success sc-3-3, missing-vault no-throw sc-3-4, commander wiring sc-3-2).
   - Verify: success test asserts active facts + counts > 0; missing-vault test uses `.resolves.toBeUndefined()` and asserts `process.exitCode === 1` + red stderr + `close` called.
5. **Run full verification** — `npm run build` (tsc, sc-3-1), `npm test` (full suite, no regressions per stopConditions), and manually `node dist/cli/index.js vault --help` (or the built binary) to confirm `reindex` lists (sc-3-2 / evaluatorNotes).

---

## 9. Pitfalls & Warnings

- **The handler must NEVER throw.** Any thrown error (missing vault, parse failure) must be caught -> `chalk.red` stderr + `process.exitCode = 1`. The sc-3-4 test asserts the promise RESOLVES (`.resolves.toBeUndefined()`, mirror `medical.test.ts:282`). A `throw` fails the sprint.
- **Store ordering vs. the missing-vault error path (IMPORTANT for sc-3-4).** `listNotes(missingDir)` uses `glob` which, for a nonexistent dir, typically returns `[]` rather than throwing — so reindex would silently succeed with zero notes and NOT set exitCode=1. To honor sc-3-4 ("missing/nonexistent vault directory ... sets a non-zero exit code"), the core must DETECT the missing vault explicitly: e.g. check `fileExists(vaultDir)` (`src/utils/fs.ts:10-17`) before listing and `throw`/error when absent, OR stat the dir. Decide this and make the sc-3-4 test deterministic. Also ensure the store is still `close()`d on that path — construct it before the throw point or guard with `store?.close()`.
- **`resolveDefaultNamespace` is private in `facts.ts`** (not exported, `facts.ts:41`). Re-implement it inside `vault.ts` (copy verbatim). Do NOT try to import it.
- **`--scope` is the FactStore scope label, NOT the team/namespace.** It is passed straight to `reindexNotes({ scope })` and lands in the `scope` column. The namespace (facts.db location) is resolved independently via `loadTeam(config, undefined).memoryNamespace` — which for the default/programming team is `""` -> `.bober/memory/facts.db` (`registry.ts:72`, `memory.ts:27-32`). Do NOT use `--scope` to pick the namespace dir.
- **`loadConfig` throws when no config file exists** (`loader.ts:144-148`). The namespace resolver swallows this (`catch { return undefined }`). In tests with a bare temp `projectRoot` (no `bober.config.json`), `ns` will be `undefined` so facts.db lands at `<root>/.bober/memory/facts.db` — assert against `factsDbPath(tmpDir, undefined)`.
- **Call `ensureFactsDir(projectRoot, ns)` BEFORE `new FactStore(factsDbPath(...))`** (`facts.ts:83` then `:99`). better-sqlite3 will throw "unable to open database file" if the parent dir is missing.
- **ESM `.js` import extensions are mandatory.** All relative imports need `.js` (e.g. `../../vault/note-io.js`, `../../state/facts.js`) even though the source is `.ts` — see `facts.ts:17-25`. tsc/NodeNext will fail otherwise.
- **Use `process.stdout.write` / `process.stderr.write`, not `console.log`** (consistent with `facts.ts`/`medical.ts`; tests spy on `process.stdout.write`).
- **Do not mutate the vault** (contract non-goal) — only `listNotes`/`readNote` (read-only). No `writeNote` in the command itself (only in the test fixture builder).
- **Wire the import AND the call in `index.ts`** — adding only the call (or only the import) fails the build; the evaluator greps for `registerVaultCommand` in `index.ts`.

---

## 10. Exact `src/cli/index.ts` Registration Sites (quoted)

**Import block (top) — add the new import here, next to line 40:**
```ts
40	import { registerMedicalCommand } from "./commands/medical.js";
41	import { registerBlackboardCommand } from "./commands/blackboard.js";
```
Add: `import { registerVaultCommand } from "./commands/vault.js";` (e.g. immediately after line 40 or 41).

**Call block (inside `main`) — add the call here, after line 319:**
```ts
315	  // ── facts ─────────────────────────────────────────────────────────
316	  registerFactsCommand(program);
317
318	  // ── medical ───────────────────────────────────────────────────────
319	  registerMedicalCommand(program);
320
321	  // ── fleet ─────────────────────────────────────────────────────────
322	  registerFleetCommand(program);
```
Add a `// ── vault ──` comment block + `registerVaultCommand(program);` after line 319 (before `registerFleetCommand`), matching the surrounding style.
