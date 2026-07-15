# Sprint Briefing: Add bi-temporal SQLite semantic-facts store + `bober facts` CLI

**Contract:** sprint-spec-20260615-memory-self-improve-p0-1
**Generated:** 2026-06-15T16:30:00Z

---

## 0. TL;DR for the Generator

Build the project's FIRST relational store. Five files:

1. `package.json` — add `better-sqlite3` to deps, `@types/better-sqlite3` to devDeps, run `npm install`.
2. `src/state/facts.ts` (new) — `FactSchema` (Zod) + `FactStore` class over `better-sqlite3`. PURE: no `Date.now()`/`new Date()` inside the store — every timestamp is a parameter. Deterministic `id = sha256(scope|subject|predicate|value|tCreated).slice(0,16)`.
3. `src/state/facts.test.ts` (new) — vitest with a `':memory:'` DB.
4. `src/cli/commands/facts.ts` (new) — clone `src/cli/commands/memory.ts` structure; stamp timestamps at the handler boundary; handlers NEVER throw (`process.exitCode = 1; return`).
5. `src/cli/index.ts` (modify) — add one import + one `registerFactsCommand(program)` call next to `registerMemoryCommand`.

ESM/NodeNext: every relative import MUST end in `.js`. `esModuleInterop: true` is set, so `import Database from "better-sqlite3";` (default import) is correct.

---

## 1. Target Files

### package.json (modify)

**Relevant sections — `dependencies` (lines 62-74) and `devDependencies` (lines 87-98):**
```jsonc
  "dependencies": {
    "@anthropic-ai/sdk": "^0.100.1",
    "@modelcontextprotocol/sdk": "^1.28.0",
    "chalk": "^5.4.1",
    "commander": "^13.1.0",
    // ...add: "better-sqlite3": "^11.x"  (keep keys alphabetical-ish, the project is loose about it)
    "zod": "^3.24.2",
    "zod-to-json-schema": "^3.25.2"
  },
  // ...
  "devDependencies": {
    "@eslint/js": "^10.0.1",
    "@types/node": "^22.13.0",
    // ...add: "@types/better-sqlite3": "^7.x"
    "vitest": "^3.0.5"
  }
```
**Rule:** `engines.node` is `">=18.0.0"` (package.json:47-49) — `better-sqlite3` is correct (synchronous, Node>=18). Do NOT use `node:sqlite` (needs Node 22.5+). After editing, the Generator MUST run `npm install` so the native module compiles before `npm run build`.

**Imported by:** loaded at runtime by `src/cli/index.ts:44-53` (`loadVersion()` reads it from `dist/../../package.json`). Adding deps does not affect that path.

**Test file:** none.

---

### src/state/facts.ts (create)

**Directory pattern:** Files in `src/state/` are kebab-or-flat lowercase modules (`memory.ts`, `helpers.ts`, `history.ts`, `run-state.ts`). Layout convention (from `memory.ts:7-11`): `// ── Section ──` banner comments separating Constants → Schema → Core.

**Most similar existing file:** `src/state/memory.ts` — mirror its `memoryDir()` resolution, its `LessonEntrySchema` (Zod), and its `ensureDir` use. Mirror the deterministic-id helper from `src/orchestrator/memory/distill.ts:88-99`.

**Structure template (synthesized from the cited files):**
```typescript
import { join } from "node:path";
import { createHash } from "node:crypto";          // mirror distill.ts:23
import Database from "better-sqlite3";              // esModuleInterop default import
import type { Database as DatabaseType } from "better-sqlite3";
import { z } from "zod";

import { ensureDir } from "./helpers.js";           // mirror memory.ts:5
import { memoryDir } from "./memory.js";            // resolve .bober/memory dir

// ── Schema ──  (mirror LessonEntrySchema, memory.ts:45-56)
export const FactSchema = z.object({
  scope: z.string(),                                // "" or "programming" => default team
  subject: z.string().min(1),
  predicate: z.string().min(1),
  value: z.string().min(1),
  confidence: z.number().min(0).max(1).default(1),
  sourceRunId: z.string().nullable().default(null),
  tValid: z.string().datetime(),
  tCreated: z.string().datetime(),
});
export type FactInput = z.infer<typeof FactSchema>;

export interface FactRecord {
  id: string; scope: string; subject: string; predicate: string;
  value: string; confidence: number; sourceRunId: string | null;
  tValid: string; tInvalid: string | null;
  tCreated: string; tInvalidated: string | null;
}

// ── Deterministic id ──  (mirror lessonIdFromSignature, distill.ts:88-99)
export function factId(scope: string, subject: string, predicate: string,
                       value: string, tCreated: string): string {
  return createHash("sha256")
    .update(`${scope}|${subject}|${predicate}|${value}|${tCreated}`)
    .digest("hex").slice(0, 16);
}

// ── Path helper ──
export function factsDbPath(projectRoot: string, namespace?: string): string {
  return join(memoryDir(projectRoot, namespace), "facts.db");
}

// ── Store ──  better-sqlite3 hidden behind this interface
export class FactStore {
  private db: DatabaseType;
  constructor(dbPath: string) {            // accepts ':memory:' or a file path
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS semantic_facts (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, subject TEXT NOT NULL,
        predicate TEXT NOT NULL, value TEXT NOT NULL, confidence REAL NOT NULL,
        source_run_id TEXT, t_valid TEXT NOT NULL, t_invalid TEXT,
        t_created TEXT NOT NULL, t_invalidated TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_facts_sp ON semantic_facts(scope, subject, predicate);
      CREATE INDEX IF NOT EXISTS idx_facts_active ON semantic_facts(scope, t_invalidated);
    `);
  }
  insertFact(input: FactInput): FactRecord { /* validate w/ FactSchema, derive id, prepared INSERT */ }
  getActiveFacts(scope: string, subject?: string, predicate?: string): FactRecord[] { /* WHERE t_invalidated IS NULL [+ optional subject/predicate], all params via ? */ }
  getFact(id: string): FactRecord | null { /* SELECT ... WHERE id = ? */ }
  invalidateFact(id: string, tInvalidated: string): boolean { /* UPDATE ... SET t_invalidated = ? WHERE id = ? AND t_invalidated IS NULL; return info.changes > 0 */ }
  close(): void { this.db.close(); }
}
```
**CRITICAL — sc-1-3 / evaluatorNotes:** grep of `facts.ts` for `Date.now`/`new Date(` must return ZERO hits inside the store. The handler passes timestamps in.
**CRITICAL — sc-1-4:** 11 columns (id, scope, subject, predicate, value, confidence, source_run_id, t_valid, t_invalid, t_created, t_invalidated), exactly two `CREATE INDEX`, all data bound via `?` placeholders (never `${}` interpolated into SQL).

---

### src/state/facts.test.ts (create)

**Most similar existing file:** `src/state/memory.test.ts` (vitest, temp resource + afterEach cleanup) and `src/config/loader.test.ts:1-33` (mkdtemp pattern). For facts, use `':memory:'` (no temp dir needed) — see Section 6.

---

### src/cli/commands/facts.ts (create)

**Most similar existing file:** `src/cli/commands/memory.ts` — clone EXACTLY (resolveRoot, resolveDefaultNamespace, chalk output, never-throw). See Section 2.

**Directory pattern:** every file in `src/cli/commands/` exports a `registerXxxCommand(program: Command): void`. The handler stamps wall-clock time (see `memory.ts:76` `const now = new Date().toISOString();`) — that is the ONLY place a clock is read.

---

### src/cli/index.ts (modify)

**Relevant section — imports (line 36) and registration (lines 309-313):**
```typescript
import { registerMemoryCommand } from "./commands/memory.js";   // line 36 — add registerFactsCommand import below this
// ...
  // ── memory ────────────────────────────────────────────────────────
  registerMemoryCommand(program);                                // line 310

  // ── facts ─────────────────────────────────────────────────────────
  registerFactsCommand(program);                                 // ADD HERE (after line 310)

  // ── fleet ─────────────────────────────────────────────────────────
  registerFleetCommand(program);                                 // line 313
```
**Rule:** Add `import { registerFactsCommand } from "./commands/facts.js";` near line 36, and one `registerFactsCommand(program);` call between the `memory` and `fleet` blocks. That is the entire diff to this file.

**Imported by:** this is the CLI entrypoint (`bin.agent-bober` → `dist/cli/index.js`, package.json:8-10). No source file imports it.

**Test file:** none (CLI entry is exercised manually / by evaluator).

---

## 2. Patterns to Follow

### CLI command module — clone this exactly for facts.ts
**Source:** `src/cli/commands/memory.ts`, lines 13-53 (resolvers) and 57-103 (handler shape)
```typescript
import chalk from "chalk";
import type { Command } from "commander";
import { findProjectRoot } from "../../utils/fs.js";
import { loadConfig } from "../../config/loader.js";
import { loadTeam } from "../../teams/registry.js";

async function resolveRoot(): Promise<string> {              // memory.ts:33-36
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

async function resolveDefaultNamespace(projectRoot: string): Promise<string | undefined> { // memory.ts:45-53
  try {
    const config = await loadConfig(projectRoot);
    return loadTeam(config, undefined).memoryNamespace || undefined;
  } catch {
    return undefined;                                        // config absence is never fatal
  }
}

export function registerFactsCommand(program: Command): void {
  const factsCmd = program.command("facts").description("Inspect semantic facts (add, list, show, invalidate)");
  factsCmd.command("add").action(async (/* opts */) => {
    const projectRoot = await resolveRoot();
    try {
      const ns = await resolveDefaultNamespace(projectRoot);
      // ... open FactStore(factsDbPath(projectRoot, ns)); stamp now; insert
      process.stdout.write(chalk.green(`...\n`));
    } catch (err) {
      process.stderr.write(chalk.red(`Failed to ...: ${err instanceof Error ? err.message : String(err)}\n`));
      process.exitCode = 1;                                  // NEVER throw
    }
  });
}
```
**Rule:** Every subcommand handler is wrapped in `try/catch`; on error write a chalk message to stderr, set `process.exitCode = 1`, and `return` — never `throw`. (memory.ts:95-102, 144-151, 185-200.)

### Scope default from the team (the `--scope` default)
**Source:** `src/cli/commands/memory.ts:45-53` + `src/teams/registry.ts:62-72`
```typescript
// loadTeam(config, undefined).memoryNamespace -> "" for the built-in programming team (registry.ts:66)
```
**Rule:** For `facts add`, default `--scope` to `resolveDefaultNamespace(projectRoot) ?? "programming"`. Note the built-in programming team's `memoryNamespace` is `""` (registry.ts:66), and `memoryDir` maps both `""` and `"programming"` to the base `.bober/memory/` dir (memory.ts:26-31) — so a single `facts.db` lives at `.bober/memory/facts.db` for the default team, satisfying sc-1-6.

### Memory directory resolution
**Source:** `src/state/memory.ts:26-31`
```typescript
export function memoryDir(projectRoot: string, namespace?: string): string {
  const ns = namespace && namespace !== "programming" ? namespace : undefined;
  return ns
    ? join(projectRoot, BOBER_DIR, MEMORY_DIR, ns)
    : join(projectRoot, BOBER_DIR, MEMORY_DIR);
}
```
**Rule:** Resolve the DB directory with `memoryDir(projectRoot, namespace)`, then `join(..., "facts.db")`. Do NOT hardcode `.bober/memory`.

### Zod schema co-located with the module
**Source:** `src/state/memory.ts:45-56`
```typescript
export const LessonEntrySchema = z.object({
  lessonId: z.string().min(1),
  createdAt: z.string().datetime(),
  // ...
  severity: z.enum(["info", "warn", "high"]),
});
export type LessonEntry = z.infer<typeof LessonEntrySchema>;
```
**Rule:** Define `FactSchema` the same way, `export type FactInput = z.infer<typeof FactSchema>`, and `safeParse` inputs in `insertFact` (mirror `appendLesson` validation at memory.ts:217-223 — throw a descriptive error on failure; the CLI's try/catch converts it to exitCode=1).

### Deterministic content-hash id + purity sentinel
**Source:** `src/orchestrator/memory/distill.ts:23, 38, 88-99`
```typescript
import { createHash } from "node:crypto";                    // line 23
// ...
function lessonIdFromSignature(category, tags, refs): string { // line 88
  const canonical = JSON.stringify({ category, tags: [...tags].sort(), refs: [...refs].sort() });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);   // line 98
}
```
**Rule:** `factId(scope, subject, predicate, value, tCreated)` = `sha256("${scope}|${subject}|${predicate}|${value}|${tCreated}").slice(0,16)`. Identical inputs ⇒ identical id (sc-1-5 determinism assertion). The store is pure — the handler stamps `tCreated`/`tValid` (distill.ts header lines 4-6: "createdAt is stamped at PERSIST TIME by the CLI handler, not here").

### ensureDir before touching disk
**Source:** `src/state/memory.ts:225-226`, helper at `src/state/helpers.ts:6-8`
```typescript
const dir = memoryDir(projectRoot, namespace);
await ensureDir(dir);                                        // mkdir { recursive: true }
```
**Rule:** Before constructing a file-backed `FactStore` (NOT for `':memory:'`), call `await ensureDir(memoryDir(projectRoot, ns))` in the CLI handler so `better-sqlite3` can create `facts.db`. `ensureDir` exists in BOTH `src/state/helpers.ts:6` and `src/utils/fs.ts:45` — facts.ts should import from `./helpers.js` to match memory.ts:5.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `memoryDir` | `src/state/memory.ts:26` | `(projectRoot: string, namespace?: string): string` | Resolves the `.bober/memory[/ns]` dir; centralizes the `""`/`programming` sentinel mapping — reuse to locate `facts.db`. |
| `ensureDir` | `src/state/helpers.ts:6` | `(dirPath: string): Promise<void>` | `mkdir { recursive: true }` — call before opening the file DB. (Duplicate exists at `src/utils/fs.ts:45`; import the `state/helpers` one.) |
| `findProjectRoot` | `src/utils/fs.ts:58` | `(startDir?: string): Promise<string \| null>` | Walks up to the dir holding `bober.config.json`/`package.json`; used by `resolveRoot`. |
| `loadConfig` | `src/config/loader.ts:142` | `(projectRoot: string): Promise<BoberConfig>` | Loads `bober.config.json`; used by `resolveDefaultNamespace`. |
| `loadTeam` | `src/teams/registry.ts:34` | `(config: BoberConfig, teamId?: string): Team` | Returns resolved team; `.memoryNamespace` gives the scope default (`""` for programming). |
| `lessonIdFromSignature` | `src/orchestrator/memory/distill.ts:88` | `(category, tags[], refs[]): string` | NOT importable (file-private) — it is the TEMPLATE to copy for `factId`, not a dependency. |
| `chalk` (dep) | `chalk` (package.json:65) | `chalk.green/red/gray/bold(str)` | All CLI coloring. Already a dependency. |
| `z` (Zod, dep) | `zod` (package.json:72) | `z.object({...})` | Input validation for `FactSchema`. |

**Utilities reviewed:** `src/state/` (memory.ts, helpers.ts, history.ts), `src/utils/` (fs.ts, logger.ts, index.ts), `src/config/`, `src/teams/`. No existing SQLite/DB helper exists — `grep -rl "better-sqlite3|Database(" src/` returns NOTHING, confirming this is the first relational store. Build the table-bootstrap inline in the constructor; there is nothing to reuse.

---

## 4. Prior Sprint Output

No prior sprints completed (`dependsOn: []`). This is Sprint 1 of 5. It establishes the `FactStore` interface that Sprints 2-5 will depend on — keep the public surface (`insertFact`, `getActiveFacts`, `getFact`, `invalidateFact`, `close`) clean so `better-sqlite3` can be swapped for `node:sqlite` later (generatorNotes: "callers in later sprints must depend on the interface, not the driver").

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` file found. Conventions are enforced by tsconfig (`strict`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `isolatedModules`) and ESLint.

### Architecture Decisions
`.bober/architecture/` exists (untracked, per git status) but contains no ADR relevant to a facts store. Inline doc-discipline that governs this sprint: `src/orchestrator/memory/distill.ts:1-21` (PURITY header — no `Date.now()`, no fs, timestamps stamped at persist time) and `src/cli/commands/memory.ts:9-11` ("CLI handlers MUST NOT throw. They set process.exitCode=1 and return").

### Other Docs / Build conventions
- **ESM/NodeNext (tsconfig:3-4):** every relative import ends in `.js` (e.g. `./helpers.js`, `../../utils/fs.js`). Package imports (`better-sqlite3`, `zod`, `chalk`) do NOT.
- **esModuleInterop: true (tsconfig):** `import Database from "better-sqlite3";` (default import) is valid; `better-sqlite3` is a CommonJS module.
- **isolatedModules + verbatim type discipline:** use `import type { ... }` for type-only imports (e.g. `import type { Command } from "commander";` as in memory.ts:15).
- Scripts (package.json:11-20): `build` = `tsc`, `typecheck` = `tsc --noEmit`, `test` = `vitest`, `lint` = `eslint src/`.

---

## 6. Testing Patterns

### Unit Test Pattern (use `':memory:'` — no temp dir needed for the store)
**Source:** `src/state/memory.test.ts:1-43` (vitest imports + lifecycle), `src/config/loader.test.ts:1-33` (mkdtemp template if a file-DB test is wanted)
```typescript
import { describe, it, expect, afterEach } from "vitest";
import { FactStore, factId, FactSchema } from "./facts.js";

describe("FactStore (in-memory)", () => {
  let store: FactStore;
  afterEach(() => { store?.close(); });           // mirror memory.test.ts afterEach cleanup (line 27-29)

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
    expect(rec.id).toBe(factId("programming", "project", "testCommand", "vitest", t));
  });

  it("invalidateFact removes from active but keeps it for getFact", () => {
    store = new FactStore(":memory:");
    const t = "2026-06-15T00:00:00.000Z";
    const { id } = store.insertFact({ scope: "programming", subject: "project",
      predicate: "testCommand", value: "vitest", confidence: 1, sourceRunId: null, tValid: t, tCreated: t });
    store.invalidateFact(id, "2026-06-16T00:00:00.000Z");
    expect(store.getActiveFacts("programming")).toHaveLength(0);   // absent from active
    expect(store.getFact(id)).not.toBeNull();                      // still retrievable
    expect(store.getFact(id)?.tInvalidated).toBe("2026-06-16T00:00:00.000Z");
  });

  it("ids are deterministic for identical (scope|subject|predicate|value|tCreated)", () => {
    const t = "2026-06-15T00:00:00.000Z";
    expect(factId("programming","project","testCommand","vitest",t))
      .toBe(factId("programming","project","testCommand","vitest",t));
  });
});
```
**Runner:** vitest (^3.0.5, package.json:97). **Assertion style:** `expect(...).toBe/.toHaveLength/.not.toBeNull`.
**Mock approach:** none needed for the store — use a real `':memory:'` DB (project principle: "real temp directories, no fs mocking", loader.test.ts:5). `vi.mock` is only used to silence the logger (loader.test.ts:15-23) — not required here.
**File naming:** co-located `facts.test.ts` next to `facts.ts` (matches `memory.ts`/`memory.test.ts`).
**Location:** co-located in `src/state/`. tsconfig excludes `**/*.test.ts` (tsconfig:exclude) so tests never break the `build`/`typecheck` — but `npm test -- facts` runs them.

### E2E Test Pattern
Not applicable — no Playwright in this repo. The CLI is verified manually by the evaluator (evaluatorNotes: exercise `node dist/cli/index.js facts add|list|show|invalidate` in a temp dir).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/index.ts` | (modify) the only edit is +1 import +1 call | low | Build must still wire all existing commands; mis-placed import breaks the whole CLI bundle. |
| `dist/cli/index.js` (bin) | rebuilt from index.ts | low | After `npm run build`, `node dist/cli/index.js --help` must list `facts` AND all prior commands. |
| `src/state/memory.ts` | facts.ts IMPORTS `memoryDir` from it (no change to memory.ts) | low | Importing is read-only; do not modify memory.ts. |
| native `better-sqlite3` module | new dep | medium | `npm install` must compile the native addon BEFORE `npm run build`; on failure the whole build fails. |

`grep -rln "state/memory" src/` dependents (`chat-session.ts`, `cli/commands/memory.ts`, `orchestrator/memory/retrieve.ts`, `distill.ts`) are UNAFFECTED — this sprint only reads `memoryDir`, it does not change memory.ts.

### Existing Tests That Must Still Pass
- `src/state/memory.test.ts` — tests `memoryDir`/`LessonEntrySchema`/`appendLesson`; verify still passes (this sprint imports `memoryDir` but does not alter it).
- `src/orchestrator/memory/distill.test.ts` — tests the deterministic id discipline you are mirroring; must remain green (distill.ts is untouched).
- `src/config/loader.test.ts` — `loadConfig` used by `resolveDefaultNamespace`; unchanged, must pass.
- Whole suite (~2139 tests per project memory) — `npm test` must stay green; adding a dep + a new isolated module should not perturb others.

### Features That Could Be Affected
- **`bober memory` command** — shares `src/cli/index.ts` registration block and the `resolveRoot`/`resolveDefaultNamespace` idiom. Verify `bober memory list` still works after adding the `facts` registration.
- **Sprints 2-5 (this spec)** — will consume `FactStore`. Keep the interface driver-agnostic (no `better-sqlite3` types leaking through public method signatures beyond what's necessary).

### Recommended Regression Checks (run after implementation)
1. `npm install` — native `better-sqlite3` compiles with exit 0.
2. `npm run build` — exit 0 (sc-1-1).
3. `npm run typecheck` — zero type errors (sc-1-2).
4. `npm test -- facts` — new suite passes (sc-1-5); then `npm test` for full regression.
5. `npm run lint` — zero errors on new/modified files (sc-1-7, non-required).
6. Manual (sc-1-6) in a temp dir with a `package.json` marker:
   `node dist/cli/index.js facts add --scope programming --subject project --predicate testCommand --value vitest` → then `... facts list` (shows it) → `... facts show <id>` (prints provenance) → `... facts invalidate <id>` → `... facts list` (empty) → `... facts show <id>` (STILL prints). Invalidating an unknown id prints a friendly message and sets exitCode=1 (does not throw).
7. `grep -nE "Date\.now|new Date\(" src/state/facts.ts` → must return NOTHING (sc-1-3 purity).
8. `grep -n '\${' src/state/facts.ts` → no `${value}`-style interpolation inside SQL strings (sc-1-4 parameterization).

---

## 8. Implementation Sequence (dependency-ordered)

1. **package.json** — add `better-sqlite3` (deps) + `@types/better-sqlite3` (devDeps), then `npm install`.
   - Verify: `npm ls better-sqlite3` resolves; `node -e "require('better-sqlite3')"` does not throw.
2. **src/state/facts.ts** — `FactSchema`, `factId`, `factsDbPath`, `FactStore` (constructor bootstraps table+indexes; pure — timestamps are params; all SQL parameterized).
   - Verify: `npm run typecheck` passes; grep shows no `Date.now`/`new Date(` and no `${}`-in-SQL.
3. **src/state/facts.test.ts** — three assertions against a `':memory:'` store (insert→active, invalidate→absent-but-getFact, id determinism).
   - Verify: `npm test -- facts` green (sc-1-5).
4. **src/cli/commands/facts.ts** — clone memory.ts; `registerFactsCommand`; subcommands `add|list|show|invalidate`; stamp `now = new Date().toISOString()` at handler boundary; `ensureDir` before file DB; never throw.
   - Verify: `npm run typecheck` passes; handler bodies are try/catch + `process.exitCode = 1`.
5. **src/cli/index.ts** — add `import { registerFactsCommand } from "./commands/facts.js";` (~line 36) and `registerFactsCommand(program);` between the memory and fleet blocks (~line 311).
   - Verify: `npm run build`, then `node dist/cli/index.js facts --help` lists the four subcommands.
6. **Run full verification** — `npm install` → `npm run build` → `npm run typecheck` → `npm test` → `npm run lint` → manual CLI exercise (Section 7 step 6).

---

## 9. Pitfalls & Warnings

- **Clock leakage (sc-1-3, the #1 failure):** NO `Date.now()`/`new Date()` anywhere in `facts.ts`. The store receives `tValid`, `tCreated`, `tInvalidated` as string parameters. The wall-clock is read ONLY in the CLI handler (`facts.ts` command, mirroring memory.ts:76).
- **SQL injection / parameterization (sc-1-4):** use `db.prepare("... WHERE id = ?").get(id)` / `.run(...)`. Never build SQL with template-literal `${value}`. The `CREATE TABLE`/`CREATE INDEX` DDL (static, no user data) may use a template literal; data statements must use `?`.
- **`node:sqlite` trap:** do NOT use Node's built-in `node:sqlite` — it requires Node 22.5+, but `engines.node` is `">=18.0.0"` (package.json:48). Use `better-sqlite3` (synchronous, Node>=18).
- **Default import:** `import Database from "better-sqlite3";` (not `import * as` and not a named import). `esModuleInterop: true` makes the default import correct; `import type { Database } from "better-sqlite3";` for the instance type.
- **`.js` import specifiers (NodeNext):** `./helpers.js`, `./memory.js`, `../../utils/fs.js`, `../../config/loader.js`, `../../teams/registry.js`. Forgetting `.js` is the most common ESM build break.
- **`noUnusedLocals`/`noUnusedParameters` (tsconfig):** every imported symbol and parameter must be used, or `tsc` fails. Prefix intentionally-unused params with `_` (see memory.test.ts:61 `lessonId: _unused`).
- **ensureDir only for file DBs:** skip `ensureDir` when path is `':memory:'`. For `facts add`, the handler must `ensureDir(memoryDir(projectRoot, ns))` before `new FactStore(factsDbPath(...))` or `better-sqlite3` throws (dir missing).
- **Always `close()` the DB:** in tests use `afterEach(() => store?.close())` (memory.test.ts:27-29 cleanup analog); in CLI handlers, `close()` in a `finally` or before return so the process exits cleanly and the file is flushed.
- **Scope sentinel:** the default team's `memoryNamespace` is `""` (registry.ts:66), which `memoryDir` maps to the base `.bober/memory/` — so `--scope programming` and the default both resolve to `.bober/memory/facts.db` (sc-1-6). Store the literal `scope` STRING the user passes (e.g. `"programming"`) in the `scope` COLUMN; the namespace only chooses the DB directory.
- **Unknown-id invalidate (evaluator edge case):** `invalidateFact` returns `false` (0 rows changed) for an unknown/already-invalidated id; the handler prints a friendly chalk message and sets `process.exitCode = 1` — it does NOT throw.
- **`isolatedModules`:** re-export types with `export type`, and import types with `import type` — a value import of a type-only symbol fails under isolatedModules.
- **Run `npm install` BEFORE `npm run build`:** the native addon must compile first or every build/typecheck fails with a module-not-found for `better-sqlite3`.
