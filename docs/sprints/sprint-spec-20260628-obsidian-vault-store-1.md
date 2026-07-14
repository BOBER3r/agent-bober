# Vault note model + frontmatter round-trip I/O

**Contract:** sprint-spec-20260628-obsidian-vault-store-1  ·  **Spec:** spec-20260628-obsidian-vault-store  ·  **Completed:** 2026-06-28

## What this sprint added

The **first of a 5-sprint vault storage layer** (`spec-20260628-obsidian-vault-store`) that
treats each per-domain repo as an Obsidian vault where markdown + YAML frontmatter is the
**canonical source of truth** and FactStore becomes a derived, rebuildable index. This sprint
lays the **domain-agnostic foundation only**: a new `src/vault/` module with a typed
`VaultNote` model, **pure** parse/serialize functions for a Dataview-compatible YAML
frontmatter subset, and filesystem `read`/`write`/`list` helpers over a vault directory.

The frontmatter parser is **hand-rolled with no YAML dependency** — it covers exactly the
documented Dataview conventions (string, number, ISO-8601 date *string*, block/inline list,
status enum) and nothing more. The parse/serialize layer is **pure**: it never touches the
filesystem and never reads the clock (`Date.now()` / `new Date()`), so it round-trips
deterministically. The module is **domain-agnostic** — no medical-specific keys, no imports
from `src/medical/`, no network imports. The downstream FactStore index, the
`bober vault reindex` CLI, the Obsidian MCP adapter, and the `profile.yaml`/SOPS hook are all
**deferred to sprints 2–5** and are out of scope here.

## Public surface

- `VaultNote` interface (`src/vault/types.ts:12`) — the canonical in-memory shape of a note:
  `{ frontmatter: Record<string, unknown>; body: string; path: string }`. `frontmatter` is an
  **open** record (consumers narrow at their own use sites); `body` is the opaque markdown
  preserved verbatim after the closing `---`; `path` is where the note was read from / will be
  written to.
- `NoteStatus` type (`src/vault/types.ts:30`) — the documented Dataview status enum,
  `"active" | "superseded"`. Stored as a plain string in frontmatter; **no runtime coercion**.
- `parseFrontmatter(raw)` (`src/vault/frontmatter.ts:53`) — PURE. Splits a raw note into
  `{ frontmatter, body }`. If the input does not begin with `---`, or has no closing `---`,
  returns `{ frontmatter: {}, body: raw }`.
- `serializeFrontmatter(frontmatter, body)` (`src/vault/frontmatter.ts:145`) — PURE. Produces
  `---\n<yaml>\n---\n<body>`. Arrays are emitted as block-style lists (`  - item` per element).
- `parseNote(raw, path)` (`src/vault/frontmatter.ts:172`) / `serializeNote(note)`
  (`src/vault/frontmatter.ts:180`) — PURE `VaultNote` wrappers over the two functions above;
  `path` is stored verbatim, no filesystem access.
- `readNote(path)` (`src/vault/note-io.ts:27`) — `readFile` + `parseNote`, returns a typed
  `VaultNote` with `path` set.
- `writeNote(note)` (`src/vault/note-io.ts:38`) — `ensureDir(dirname)` + `writeFile(serializeNote)`.
  Parent directories are created automatically.
- `listNotes(vaultDir)` (`src/vault/note-io.ts:49`) — returns the **absolute** paths of every
  `.md` file under `vaultDir`, recursively, via the existing `glob` dependency
  (`glob("**/*.md", { cwd, absolute: true, nodir: true })`).

## How to use / how it fits

```ts
import { readNote, writeNote, listNotes } from "./vault/note-io.js";

const paths = await listNotes("/path/to/vault");   // absolute paths of every .md
const note = await readNote(paths[0]);             // { frontmatter, body, path }
note.frontmatter.status = "superseded";            // edit in place
await writeNote(note);                             // frontmatter + body preserved
```

`src/vault/` is split into three layers, mirroring `src/medical/`'s conventions
(`node:`-prefixed imports, `.js` extensions on relative imports, file-header doc-comments):
`types.ts` (data only) → `frontmatter.ts` (pure parse/serialize) → `note-io.ts` (the fs bridge,
the only layer that imports `node:fs/promises` + `glob` + `ensureDir` from `utils/fs.ts`).
Sprint 2 will build the derived FactStore index on top of `parseFrontmatter`/`listNotes` via the
existing reconcile-at-ingest path.

## Notes for maintainers

- **The frontmatter parser is a deliberately small hand-rolled YAML subset**, not a full YAML
  library. It supports unquoted string scalars, integer/float numbers (incl. negative),
  ISO-8601 date *strings* (kept as strings — **never coerced to `Date`**), block-style lists
  (`- item`), inline lists (`[a, b, c]`), and status enum strings. **Quoted strings, nested
  objects, and multi-line scalars are NOT supported** — a `// bober:` header comment in
  `frontmatter.ts` flags that you should swap in a vetted YAML library if those are ever needed.
- **Round-trip fidelity is the contract, not byte-identity.** `serializeFrontmatter` emits
  arrays as block lists regardless of the original inline/block form, so the serialized text may
  differ from the input — but `serializeNote(parseNote(input))` **re-parses deep-equal** for the
  documented types (number `5.4` stays numeric, an ISO date stays a parseable string, a list
  stays an array, and the body is preserved). Tests assert the *re-parse*, not string equality.
- **Purity is load-bearing.** `frontmatter.ts` has no fs/clock/network imports; keep it that way
  so the FactStore index (sprint 2) can rebuild deterministically. All fs access lives in
  `note-io.ts` and uses `node:fs/promises` only (no sync variants), per project principles.
- **Domain-agnostic by construction.** No medical keys, no `src/medical/` imports. Sprints 2–5
  layer the FactStore index, `bober vault reindex`, the Obsidian MCP adapter, and the
  `profile.yaml`/SOPS hook on top — do not document those as shipped yet.
- **Scope.** Five files, all new, commit `e576e77`: `src/vault/types.ts`,
  `src/vault/frontmatter.ts`, `src/vault/note-io.ts`, plus collocated tests
  `src/vault/frontmatter.test.ts` (13 tests: sc-1-3 typed parse + sc-1-4 round-trip) and
  `src/vault/note-io.test.ts` (5 tests: sc-1-5 write/read/list in a `mkdtemp` temp dir). No new
  dependencies. Full suite **2849 tests** green, zero regressions; all five criteria
  (sc-1-1..sc-1-5) passed iteration 1.
