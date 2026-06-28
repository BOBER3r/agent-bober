# Derived FactStore index over note frontmatter (reconcile-at-ingest)

**Contract:** sprint-spec-20260628-obsidian-vault-store-2  ·  **Spec:** spec-20260628-obsidian-vault-store  ·  **Completed:** 2026-06-28

## What this sprint added

The **second of the 5-sprint vault storage layer** (`spec-20260628-obsidian-vault-store`).
Sprint 1 built the canonical note model (`VaultNote` + pure parse/serialize + fs I/O); this
sprint makes **FactStore a derived, rebuildable active-state index over note frontmatter**. It
adds a **pure** mapping from a note's frontmatter to `FactInput` records and a `reindexNotes`
function that applies them through the **existing** `writeFact` reconcile-at-ingest path. Because
every write goes through `writeFact`, re-running reindex over unchanged notes mutates nothing
(every action is `noop`), a changed frontmatter value supersedes the prior fact, and a note
flagged `status: superseded` contributes no active facts. No new persistence mechanism is
introduced — `src/state/facts.ts` and `src/orchestrator/memory/reconcile.ts` are consumed as-is.

## Public surface

- `noteToFacts(note, opts)` (`src/vault/index-map.ts:47`) — **PURE.** Maps one `VaultNote` to one
  `FactInput` per frontmatter key. `opts` is `{ scope: string; now: string; sourceRunId?: string | null }`.
  Per emitted fact: `scope = opts.scope`, `predicate = the frontmatter key`,
  `subject = frontmatter.id` (when a non-empty string) **else** `note.path`,
  `value = ` the stringified frontmatter value, `confidence = 1`, `sourceRunId = opts.sourceRunId ?? null`,
  and `tValid = tCreated = opts.now`. Never calls `Date.now()`/`new Date()` and never touches the
  filesystem. Maps **all** keys unconditionally — `status:superseded` filtering lives in
  `reindexNotes`, not here.
- `SUPERSEDED_STATUS` (`src/vault/index-map.ts:80` as `"superseded" as const`, and
  `src/vault/reindex.ts:30` typed as `NoteStatus`) — the frontmatter `status` value that excludes a
  note from the active index. Exported for **Sprint 5** (status lifecycle) to consume; do not rename.
- `ReindexSummary` interface (`src/vault/reindex.ts:35`) — the tally returned by a reindex pass:
  `notesParsed` (notes actually indexed, i.e. non-superseded), `factsAdded` (`ReconcileAction "add"`),
  `factsSuperseded` (`"update"` — the prior fact row is invalidated), and `factsNoop` (`"noop"` —
  identical value already active, no write).
- `reindexNotes(store, notes, opts)` (`src/vault/reindex.ts:66`) — `async`, returns
  `Promise<ReindexSummary>`. Walks `notes`, **skips** any whose `frontmatter.status === SUPERSEDED_STATUS`,
  maps each surviving note via `noteToFacts`, and writes every fact through `writeFact(store, input, { judge, now })`
  (never `store.insertFact`), tallying the returned `ReconcileAction`. `opts` is
  `{ scope: string; now: string; sourceRunId?: string | null; judge?: FactJudge }`. Clock-free —
  `now` is injected and stamped on every new fact.

## How to use / how it fits

```ts
import { FactStore } from "../state/facts.js";
import { listNotes, readNote } from "./note-io.js";       // Sprint 1
import { reindexNotes } from "./reindex.js";

const store = new FactStore(":memory:");                  // or a real facts.db path
const notes = await Promise.all((await listNotes(vaultDir)).map(readNote));
const summary = await reindexNotes(store, notes, {
  scope: "medical",                                       // any domain label
  now: new Date().toISOString(),                          // injected at the boundary
});
// summary => { notesParsed, factsAdded, factsSuperseded, factsNoop }
```

`reindexNotes` reuses the same reconcile-at-ingest entry point (`writeFact`) that the memory
subsystem uses, so the FactStore stays a **rebuildable projection** of the canonical markdown:
delete `facts.db`, re-run reindex over the vault, and the active-fact set is reconstructed from
frontmatter. Identical frontmatter produces identical fact ids (scalars via `String()`,
arrays/objects via `JSON.stringify`), so a second pass over unchanged notes is all-`noop`.
**Sprint 3** wires this into a `bober vault reindex` CLI command that walks the filesystem and
supplies the parsed notes (loading notes is explicitly out of scope here).

## Notes for maintainers

- **No judge is wired by default.** Reconcile runs without an `LLMClient` judge, so an
  ambiguous-key collision falls back to a deterministic ADD (`reconcile.ts:93-96`). Pass
  `opts.judge` to enable LLM-assisted conflict resolution in a future sprint — the seam exists but
  is unused today.
- **Empty-stringified frontmatter values are skipped.** `noteToFacts` drops any key whose
  stringified value is empty (including `null`/`undefined`) to satisfy `FactSchema`'s
  `value.min(1)` constraint — those keys produce no fact rather than a schema error.
- **`"update"` is named `factsSuperseded` in the summary** because a changed value supersedes the
  prior fact (the old row gets `t_invalidated` set). A `ReconcileAction` of `"delete"` (only
  possible if a judge returns delete) is intentionally **not** counted in the summary shape.
- **`SUPERSEDED_STATUS` is currently exported from two modules** (`index-map.ts` as a literal
  `const`, `reindex.ts` as a `NoteStatus`-typed const that `reindexNotes` actually uses). They
  agree on the value `"superseded"`; Sprint 5 should converge on a single canonical export. Noted,
  not changed.
- **Purity is load-bearing.** Neither `index-map.ts` nor `reindex.ts` reads the clock or the
  filesystem — `now` is injected throughout — so reindex is deterministic and the derived index is
  reproducible. Keep it that way.
- **Scope.** Two new source files plus collocated tests, commit `01d17b4`:
  `src/vault/index-map.ts`, `src/vault/reindex.ts`, `src/vault/index-map.test.ts` (13 tests:
  sc-2-2 mapping + purity), `src/vault/reindex.test.ts` (7 tests: sc-2-3 second-pass-all-noop with
  per-fact `ReconcileAction === "noop"` assertions, sc-2-4 value-change supersede via
  `getFact(oldId).tInvalidated` non-null, sc-2-5 `status:superseded` skip + mixed-notes, summary
  shape, purity). 38 vault tests; full suite **2869 tests** green, zero regressions; all five
  criteria (sc-2-1..sc-2-5) passed iteration 1. `src/state/facts.ts` and
  `src/orchestrator/memory/reconcile.ts` untouched.
