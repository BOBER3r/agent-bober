# Sprint Briefing: Vault note model + frontmatter round-trip I/O

**Contract:** sprint-spec-20260628-obsidian-vault-store-1
**Generated:** 2026-06-28T00:00:00.000Z

> Goal: a NEW `src/vault/` module — typed `VaultNote`, PURE frontmatter parse/serialize,
> and fs+glob note-io (read/write/list). Domain-agnostic, no medical keys. All 5 files are
> `create` (verified: `src/vault/` does not exist).

---

## 1. Target Files (all CREATE)

All five files are new. There is NO existing `src/vault/` directory (verified via `ls`).
Follow the per-concern split the contract mandates: `types.ts` (no deps) → `frontmatter.ts`
(pure) → `note-io.ts` (fs + glob) → tests.

### src/vault/types.ts (create)
**Directory pattern:** modules live one-concern-per-file under `src/<module>/` (see `src/medical/`, `src/state/`).
**Most similar existing file:** `src/medical/types.ts` (interface-only type module) and the `FactRecord` interface at `src/state/facts.ts:37-49`.
**Contract requires:** `export interface VaultNote { frontmatter: Record<string, unknown>; body: string; path: string }`.
**Structure template (mirror `src/medical/types.ts:1-6` header + `src/state/facts.ts:37-49` interface):**
```typescript
/**
 * Vault note model — the canonical in-memory shape of an Obsidian markdown note.
 *
 * Domain-agnostic: frontmatter is an open Record; no domain-specific keys.
 */

// ── Vault note ──────────────────────────────────────────────────────

/** A parsed Obsidian vault note: YAML frontmatter + opaque markdown body + source path. */
export interface VaultNote {
  /** Parsed YAML frontmatter. Values are string | number | string[] (Dataview conventions). */
  frontmatter: Record<string, unknown>;
  /** Opaque markdown body — everything after the closing `---` delimiter, preserved verbatim. */
  body: string;
  /** Absolute or vault-relative path the note was read from / will be written to. */
  path: string;
}
```

### src/vault/frontmatter.ts (create)
**Most similar existing file:** `src/state/facts.ts` (pure helpers + box-section comments). The `factId` function at `src/state/facts.ts:58-69` is the canonical "pure exported function" shape.
**Contract requires:** `parseFrontmatter` / `serializeFrontmatter` — PURE (no clock, no fs, no network).
**Signatures (generator's call, but match contract intent):**
```typescript
// parse the leading ---\n...\n--- block; return { frontmatter, body }
export function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string };
// inverse: produce ---\n<yaml>\n---\n<body>
export function serializeFrontmatter(frontmatter: Record<string, unknown>, body: string): string;
```
The contract's `parseNote` / `serializeNote` (success criteria sc-1-3/sc-1-4) operate on `VaultNote`. Decide whether `parseNote` wraps `parseFrontmatter` + adds `path`, or whether `parseFrontmatter` IS the round-trip primitive. Keep names consistent between impl and tests.

### src/vault/note-io.ts (create)
**Most similar existing file:** `src/graph/artifact-store.ts` (fs/promises + glob + `../utils/fs.js` helpers) and `src/discovery/scanners/test-conventions.ts` (glob enumeration).
**Contract requires:** `readNote` / `writeNote` / `listNotes` — fs + glob. Reuse the existing `glob` dependency.
**Signatures:**
```typescript
export async function readNote(path: string): Promise<VaultNote>;       // readFile + parseFrontmatter
export async function writeNote(note: VaultNote): Promise<void>;          // ensureDir(dirname) + writeFile(serialize)
export async function listNotes(vaultDir: string): Promise<string[]>;     // glob("**/*.md", { cwd: vaultDir, absolute: true })
```

### src/vault/frontmatter.test.ts and src/vault/note-io.test.ts (create)
Co-located `*.test.ts` (principle: tests sit next to source — `.bober/principles.md:20`). See Section 6 for the exact temp-dir + fixture patterns to copy.

---

## 2. Patterns to Follow

### Pattern A — File-header doc-comment (module banner)
**Source:** `src/medical/health-store.ts:1-16` and `src/medical/types.ts:1-6`
```typescript
/**
 * HealthDataStore — SQLite-backed health observation store (Phase 6, Sprint 4).
 *
 * Mirrors FactStore (src/state/facts.ts) exactly:
 *   - better-sqlite3 SYNC (no await anywhere)
 *   ...
 * PURE: Never calls Date.now() or new Date() — every timestamp is an injected parameter.
 */
```
**Rule:** Every module opens with a `/** ... */` banner: one-line summary, a short bullet list of invariants, and a PURE note where applicable.

### Pattern B — Import conventions (node: prefix + .js relative extensions + type imports)
**Source:** `src/state/facts.ts:1-8` and `src/medical/health-store.ts:18-22`
```typescript
import { join } from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

import { ensureDir } from "./helpers.js";
import { memoryDir } from "./memory.js";
```
**Rule:** Node builtins use the `node:` prefix; relative imports carry the `.js` extension (NodeNext); type-only imports use `import type` (ESLint `consistent-type-imports` — `.bober/principles.md:35`).

### Pattern C — Box-drawing section comments
**Source:** `src/state/facts.ts:51`, `:71`, `:93`, `:125`; `src/medical/health-store.ts:24`, `:55`, `:103`
```typescript
// ── Deterministic id ──────────────────────────────────────────────────
// ── Path helpers ──────────────────────────────────────────────────────
```
**Rule:** Organize files with `// ── Section Name ──────` headers (`.bober/principles.md:32`).

### Pattern D — Purity discipline (NO clock, NO fs in pure helpers)
**Source:** `src/state/facts.ts:127-135` (the note the contract tells you to mirror)
```typescript
/**
 * Bi-temporal SQLite-backed fact store.
 *
 * PURE: Never calls Date.now() or new Date() — every timestamp is a parameter.
 * Hidden behind this interface so the driver (better-sqlite3) is swappable.
 */
```
Reinforced at `src/medical/health-store.ts:11` and `src/medical/types.ts:56` (`/** ISO 8601; INJECTED parameter — never Date.now(). */`).
**Rule:** `parseFrontmatter` / `serializeFrontmatter` and any mapping helper must NOT call `Date.now()` or `new Date()`, must NOT touch fs, must NOT import anything network-related. The evaluator greps for `Date.now`/`new Date` in parse/serialize (evaluatorNotes).

### Pattern E — glob enumeration (the recipe for `listNotes`)
**Source:** `src/discovery/scanners/test-conventions.ts:251-254` (closest analog), `src/discovery/scanners/code-conventions.ts:212-216`, `src/graph/artifact-store.ts:91-95`
```typescript
import { glob } from "glob";

testFiles = await glob(
  "**/*.{test,spec}.{ts,tsx,js,jsx}",
  { cwd: projectRoot, ignore, absolute: true },
);
```
And the `nodir` variant from `artifact-store.ts:91-95`:
```typescript
const candidates = await glob("**/*", {
  cwd: this.projectRoot,
  nodir: true,
  ignore: ["node_modules/**", ".git/**", "dist/**", ".bober/**"],
});
```
**Rule:** For `listNotes`, call `glob("**/*.md", { cwd: vaultDir, absolute: true, nodir: true })`. `absolute: true` returns full paths (sc-1-5 asserts "every .md file recursively"); `nodir: true` excludes directories. Do NOT hand-roll a recursive `readdir` walker — the repo standardises on `glob`.

### Pattern F — fs helpers already exist (reuse, do not re-implement)
**Source:** `src/utils/fs.ts` and consumer `src/graph/artifact-store.ts:5`
```typescript
import { ensureDir, fileExists, readJson, writeJson } from "../utils/fs.js";
```
**Rule:** `writeNote` must create parent dirs before writing — use `ensureDir(dirname(path))` from `src/utils/fs.ts:45` (mkdir recursive), exactly as `writeJson` does at `src/utils/fs.ts:34-40`. Use raw `readFile`/`writeFile` from `node:fs/promises` for the markdown text (the `readJson`/`writeJson` helpers are JSON-specific — markdown is not JSON, so read/write the string directly).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `ensureDir` | `src/utils/fs.ts:45` | `(path: string): Promise<void>` | `mkdir(path, { recursive: true })` — call before `writeNote`'s writeFile |
| `fileExists` | `src/utils/fs.ts:10` | `(path: string): Promise<boolean>` | Async readable check via `access(..., R_OK)` |
| `readJson<T>` | `src/utils/fs.ts:24` | `(path): Promise<T>` | JSON read — NOT for markdown; shows the read+parse house style |
| `writeJson` | `src/utils/fs.ts:34` | `(path, data): Promise<void>` | JSON write w/ auto ensureDir — mirror its dir-create step for `writeNote` |
| `ensureDir` (dup) | `src/state/helpers.ts:5` | `(dirPath): Promise<void>` | Same as utils — prefer the `utils/fs.ts` one |
| `glob` | dependency `glob@^11.0.1` (`package.json:69`) | `(pattern, opts): Promise<string[]>` | Recursive file enumeration for `listNotes` |

**No YAML utility exists.** Confirmed: `package.json:62-75` has NO `yaml`/`js-yaml` dependency, and no `import ... "yaml"` anywhere in `src/`. The contract (assumptions, line 59) leaves the choice to the generator: hand-roll a minimal parser for the documented Dataview conventions (RECOMMENDED — zero new deps, zero network, easy to keep pure) OR add a small well-maintained YAML lib. If hand-rolling, document the restriction in the file banner (Pattern A).

Utilities reviewed: `src/utils/` (fs.ts, git.ts, logger.ts), `src/state/helpers.ts` — none cover YAML/markdown parsing.

---

## 4. Prior Sprint Output

No prior sprints (contract `dependsOn: []`). This is sprint 1 of 5 and the foundation. Nothing to import from earlier work. Sprints 2 (FactStore index), 3 (CLI) are explicit non-goals here (`nonGoals` lines 45-46).

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM everywhere** — `.js` extensions on relative imports for NodeNext (`:27`).
- **No synchronous fs** — all fs via `node:fs/promises`; no `readFileSync` (`:42`).
- **No `any` without justification** — prefer `unknown` + narrowing (`:40`). `VaultNote.frontmatter` is `Record<string, unknown>` (contract) — narrow at use sites.
- **`import type` enforced** — ESLint `consistent-type-imports` (`:35`).
- **Prefix unused params with `_`** (`:36`).
- **Tests co-located** `*.test.ts` next to source, Vitest (`:20`).
- **No fs mocks** — tests create real temp dirs and clean up (`:44`). This is load-bearing for `note-io.test.ts`.
- **Box-drawing section comments** (`:32`).

### Architecture Decisions
No ADR doc specific to `src/vault/` exists. The relevant cross-cutting convention is the "PURE / inject timestamps" discipline carried in `src/state/facts.ts` and `src/medical/` (Pattern D). Parse/serialize are pure by contract.

### Other Docs
`tsconfig.json` is strict (`noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `isolatedModules`, `strict`) and **excludes `**/*.test.ts` from the build** (`tsconfig.json` exclude). So `npm run typecheck` (`tsc --noEmit`) checks the 3 source files, not the tests; type errors in tests surface only when Vitest runs. Build output is `dist/` with `rootDir: src`.

---

## 6. Testing Patterns

**Runner:** Vitest (`package.json:101`, script `"test": "vitest"`). **Assertion style:** `expect(...)`. **Mock approach:** none for fs — REAL temp dirs (principle `:44`). **File naming:** `*.test.ts`. **Location:** co-located in `src/vault/`.

### Unit Test Pattern — pure function (frontmatter.test.ts)
**Source:** `src/state/facts.test.ts:1-34` (pure assertions, no fs)
```typescript
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { FactStore, factId } from "./facts.js";

describe("FactStore (in-memory)", () => {
  it("ids are deterministic ...", () => {
    const t = "2026-06-15T00:00:00.000Z";
    expect(factId("programming", "project", "testCommand", "vitest", t)).toBe(
      factId("programming", "project", "testCommand", "vitest", t),
    );
  });
});
```
**For sc-1-3 / sc-1-4** assert types after parse, e.g.:
```typescript
const { frontmatter, body } = parseFrontmatter(fixture);
expect(typeof frontmatter.title).toBe("string");
expect(typeof frontmatter.weight).toBe("number");        // 5.4 stays numeric (NOT "5.4")
expect(frontmatter.weight).toBe(5.4);
expect(Array.isArray(frontmatter.tags)).toBe(true);      // YAML list → array
expect(Number.isNaN(Date.parse(frontmatter.created as string))).toBe(false); // ISO date is parseable
expect(frontmatter.status).toBe("active");               // enum stays a string
expect(body).toBe(expectedBodyVerbatim);                 // byte-for-byte, incl. blank lines
// round-trip (sc-1-4):
expect(parseFrontmatter(serializeFrontmatter(frontmatter, body)).frontmatter).toEqual(frontmatter);
```

### Unit Test Pattern — temp dir read/write (note-io.test.ts)  ← COPY THIS EXACTLY
**Source:** `src/state/facts.test.ts:111-145` and `src/medical/health-store.test.ts:141-186`
```typescript
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("note-io (file-backed, temp dir)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-vault-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writeNote -> readNote round-trips; listNotes finds every .md recursively", async () => {
    const note = { frontmatter: { status: "active", n: 5.4 }, body: "# Hi\n\nbody\n", path: join(tmpDir, "a/b/note.md") };
    await writeNote(note);
    const back = await readNote(note.path);
    expect(back.frontmatter).toEqual(note.frontmatter);
    expect(back.body).toBe(note.body);
    const all = await listNotes(tmpDir);
    expect(all.some((p) => p.endsWith("note.md"))).toBe(true);
  });
});
```
**Rule:** `mkdtemp(join(tmpdir(), "bober-vault-"))` in `beforeEach`, `rm(tmpDir, { recursive: true, force: true })` in `afterEach`. Nest a subdir in the write path to prove `writeNote` creates parents (ensureDir) and `listNotes` recurses.

### Fixture Pattern (if you commit a fixture note instead of inline strings)
**Source:** `src/medical/retrieval/medline-source.test.ts:16-21`
```typescript
const fixtureUrl = new URL("./__fixtures__/medlineplus-sample.json", import.meta.url);
async function loadFixture(): Promise<unknown> {
  const raw = await readFile(fixtureUrl, "utf-8");
  return JSON.parse(raw) as unknown;
}
```
**Rule:** Committed fixtures live in a co-located `__fixtures__/` dir (existing examples: `src/medical/retrieval/__fixtures__/`, `src/fleet/__fixtures__/`). Resolve via `new URL("./__fixtures__/<name>", import.meta.url)` + `readFile`. A `.md` fixture is NOT compiled by tsc (only `.ts` under `src/`), so it is build-safe. Inline template-string fixtures are equally acceptable for the pure parse test and avoid an extra file.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
This sprint adds a brand-new module; NO existing file is modified and nothing imports `src/vault/` yet.
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| (none) | `src/vault/*` | low | No existing importer of `src/vault/` (module is new) |
| `tsconfig.json` build graph | new `src/vault/*.ts` | low | New strict-mode files must compile clean (`noUnusedLocals`/`noUnusedParameters`/`noImplicitReturns`) |
| ESLint flat config (`src/`) | new files | low | `consistent-type-imports`, unused-var error, `no-explicit-any` warn apply globally |

### Existing Tests That Must Still Pass
The whole suite must stay green (stopConditions line 53). Risk is only "new files break compile/lint, which fails the run", not behavioral regression. Sanity-reference tests for the patterns you copy:
- `src/state/facts.test.ts` — the temp-dir + deterministic-helper template; verify your copy of the mkdtemp/rm pattern matches.
- `src/medical/health-store.test.ts` — second temp-dir example; confirms `rm(..., {recursive,force})` cleanup is the norm.
- `src/medical/retrieval/medline-source.test.ts` — the `__fixtures__` + `import.meta.url` loader template.

### Features That Could Be Affected
- **None at runtime.** `src/vault/` is isolated. Do NOT import from `src/medical/` (nonGoal line 47) and do NOT introduce medical keys — that would couple an isolated module to a fenced one.

### Recommended Regression Checks
1. `npm run build` — tsc clean (sc-1-1).
2. `npm run typecheck` — no type errors (sc-1-2).
3. `npm test` — full suite green, new `src/vault/` tests included, zero pre-existing regressions (stopConditions).
4. `npm run lint` — ESLint clean (hard gate, `.bober/principles.md:19`).
5. `grep -rn "biomarker\|marker\|whoop\|medical" src/vault/` returns nothing (evaluatorNotes — domain-agnostic check).
6. `grep -rn "Date.now\|new Date" src/vault/frontmatter.ts` returns nothing (purity, evaluatorNotes).

---

## 8. Implementation Sequence (dependency order)

1. **src/vault/types.ts** — define `VaultNote` interface (no imports). File banner per Pattern A.
   - Verify: `npx tsc --noEmit` has no error for the new file.
2. **src/vault/frontmatter.ts** — PURE `parseFrontmatter` / `serializeFrontmatter` (+ `parseNote`/`serializeNote` if you wrap). Imports `VaultNote` via `import type { VaultNote } from "./types.js"`. NO fs, NO clock.
   - Critical conventions to encode: number stays numeric (`Number()` only when the scalar matches a numeric regex; otherwise keep string); ISO date stays a STRING (do NOT coerce to `Date` — round-trip + `Date.parse` must hold); inline `[a, b]` and block `- item` lists → `string[]`; `status` stays a plain string. Keep body = everything after the closing `---` line, verbatim.
   - Verify: round-trip `serialize(parse(x))` re-parses deep-equal (sc-1-4).
3. **src/vault/note-io.ts** — `readNote` (readFile + parseFrontmatter), `writeNote` (`ensureDir(dirname)` from `../utils/fs.js` + writeFile(serialize)), `listNotes` (`glob("**/*.md", { cwd, absolute:true, nodir:true })`). Imports: `node:fs/promises`, `node:path`, `glob`, `../utils/fs.js`, `./frontmatter.js`, `./types.js`.
   - Verify: writeNote then readNote round-trips on a temp dir.
4. **src/vault/frontmatter.test.ts** — sc-1-3 (typed parse of string/number/ISO-date/list/status + body) and sc-1-4 (round-trip deep-equal). Inline or `__fixtures__` fixture.
   - Verify: `npx vitest run src/vault/frontmatter.test.ts` green.
5. **src/vault/note-io.test.ts** — sc-1-5 (temp-dir write→read equality + recursive listNotes). Copy the Section 6 temp-dir template verbatim.
   - Verify: `npx vitest run src/vault/note-io.test.ts` green.
6. **Run full verification** — `npm run build`, `npm run typecheck`, `npm test`, `npm run lint` (+ the two greps in Section 7).

---

## 9. Pitfalls & Warnings

- **No YAML dependency exists.** Do not `import` from a `yaml` package that isn't installed — it will fail. Either hand-roll within the documented conventions (recommended) or add the dep to `package.json` first.
- **ISO dates must stay parseable STRINGS, not `Date` objects.** A naive YAML lib (or `JSON`-ish parsing) may coerce `2026-01-01` into a `Date`, breaking the deep-equal round-trip (sc-1-4) and the "stays a parseable date string" check (evaluatorNotes). Keep dates as strings; validate with `Date.parse` in tests only.
- **Numbers must stay numeric.** `5.4` must parse to `number` 5.4, not `"5.4"`. But arbitrary strings that merely contain digits (e.g. a status, an id) must stay strings — gate numeric coercion on a strict numeric regex.
- **Body must be byte-for-byte preserved, including blank lines.** Define the body as the exact substring after the closing `---` line and reproduce it exactly on serialize. Watch the single newline after the closing delimiter — pick one convention (e.g. body excludes the delimiter's trailing `\n`) and make serialize the exact inverse.
- **`.js` extensions on relative imports** — `./types.js`, `./frontmatter.js`, `../utils/fs.js`. Omitting them breaks NodeNext resolution (`.bober/principles.md:27`).
- **`import type` for `VaultNote`** — ESLint `consistent-type-imports` is enforced; importing a type without `import type` is a lint error (hard gate).
- **No sync fs** — use `node:fs/promises` (`readFile`/`writeFile`/`mkdtemp`/`rm`), never `*Sync` (`.bober/principles.md:42`).
- **Strict unused checks** — `noUnusedLocals`/`noUnusedParameters` will fail the build on a stray import or unused var; prefix intentional unused with `_`.
- **Domain-agnostic** — no `marker`/`biomarker`/`whoop`/`medical` identifiers and no import from `src/medical/` (nonGoals 47, evaluatorNotes). Frontmatter keys in fixtures should be generic (`title`, `tags`, `created`, `weight`, `status`).
- **Do NOT use `readJson`/`writeJson` for the note body** — they JSON-parse/stringify; markdown is raw text. Use plain `readFile`/`writeFile` with `"utf-8"`. Borrow only the `ensureDir(dirname(path))` step from `writeJson` (`src/utils/fs.ts:34-40`).
- **`listNotes` via glob, not a manual walker** — match the repo standard (`glob` is already a dependency); use `absolute: true` so sc-1-5's "returns every .md file" yields usable paths.
