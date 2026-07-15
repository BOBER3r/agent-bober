# Sprint Briefing: Derived FactStore index over note frontmatter (reconcile-at-ingest)

**Contract:** sprint-spec-20260628-obsidian-vault-store-2
**Generated:** 2026-06-28T00:00:00.000Z

---

## 0. What you are building (in one breath)

Two NEW pure-ish modules under `src/vault/`:

1. `src/vault/index-map.ts` — `noteToFacts(note: VaultNote, opts: { scope: string; now: string; sourceRunId?: string }): FactInput[]` — PURE. One `FactInput` per frontmatter key. `subject` = `frontmatter.id` if present else `note.path`; `predicate` = the key; `value` = stringified frontmatter value; `tValid = tCreated = now`; `confidence = 1`; `sourceRunId = opts.sourceRunId ?? null`. Skip the `status` key itself? See Pitfalls — sc-2-2 says "one FactInput per frontmatter key", so DO map every key including `status`; a `status:superseded` note is filtered at the `reindexNotes` level, not the mapping level.
2. `src/vault/reindex.ts` — `reindexNotes(store: FactStore, notes: VaultNote[], opts: { scope: string; now: string; judge?: FactJudge }): Promise<ReindexSummary>` — walks each note, SKIPS notes whose `frontmatter.status === SUPERSEDED_STATUS`, calls `noteToFacts`, writes each `FactInput` via `writeFact`, tallies the returned `ReconcileAction`.

Plus `src/vault/index-map.test.ts` and `src/vault/reindex.test.ts`.

**Export `SUPERSEDED_STATUS = "superseded"` from `src/vault/reindex.ts`** (or index-map.ts). Sprint 5 has NOT landed yet (sprints run in order), so inline the literal and export the const for sprint 5 to consume. Do NOT import a constant that does not exist.

---

## 1. Target Files

### src/vault/index-map.ts (create)

**Directory pattern:** `src/vault/` uses kebab-case filenames, named exports, leading JSDoc block stating PURE + `bober:` notes. ESM with `.js` import extensions. See `src/vault/frontmatter.ts:1-21` (module header) and `src/vault/types.ts`.

**Most similar existing file:** `src/vault/frontmatter.ts` — pure transforms over `VaultNote`, no clock, no fs. Mirror its header style.

**The shape this consumes — `VaultNote` (`src/vault/types.ts:11-22`, verified):**
```ts
export interface VaultNote {
  frontmatter: Record<string, unknown>;
  body: string;
  path: string;
}
```

**The shape this PRODUCES — `FactInput` = `z.infer<typeof FactSchema>` (`src/state/facts.ts:22-33`, verified):**
```ts
export const FactSchema = z.object({
  scope: z.string(),
  subject: z.string().min(1),
  predicate: z.string().min(1),
  value: z.string().min(1),
  confidence: z.number().min(0).max(1).default(1),
  sourceRunId: z.string().nullable().default(null),
  tValid: z.string().datetime(),
  tCreated: z.string().datetime(),
});
export type FactInput = z.infer<typeof FactSchema>;
```
Required-and-validated invariants you MUST satisfy or `insertFact` throws (`src/state/facts.ts:173-180`): `subject`, `predicate`, `value` are `.min(1)` (NON-EMPTY strings); `confidence` 0..1; `tValid`/`tCreated` must be `.datetime()` ISO-8601 (an injected `now` like `"2026-06-28T00:00:00.000Z"` passes). A frontmatter key whose stringified value is the empty string would FAIL `value.min(1)` — decide to skip empty values or you will throw.

**Structure template (based on `frontmatter.ts` conventions):**
```ts
import type { VaultNote } from "./types.js";
import type { FactInput } from "../state/facts.js";

/** Stringify a frontmatter value stably so identical input yields identical fact ids. */
function stringifyValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v); // arrays / objects -> stable JSON
}

export function noteToFacts(
  note: VaultNote,
  opts: { scope: string; now: string; sourceRunId?: string },
): FactInput[] {
  const subject =
    typeof note.frontmatter.id === "string" && note.frontmatter.id.length > 0
      ? note.frontmatter.id
      : note.path;
  const facts: FactInput[] = [];
  for (const [key, val] of Object.entries(note.frontmatter)) {
    const value = stringifyValue(val);
    if (value.length === 0) continue; // value.min(1) guard
    facts.push({
      scope: opts.scope,
      subject,
      predicate: key,
      value,
      confidence: 1,
      sourceRunId: opts.sourceRunId ?? null,
      tValid: opts.now,
      tCreated: opts.now,
    });
  }
  return facts;
}
```

**Imports this file uses:** `VaultNote` from `./types.js`; `FactInput` from `../state/facts.js`.
**Test file:** `src/vault/index-map.test.ts` (create).

---

### src/vault/reindex.ts (create)

**Most similar existing file for the write loop:** `src/cli/commands/facts.ts:88-103` (builds input, calls `writeFact`, switches on the action) and `src/orchestrator/memory/reconcile.test.ts:43-78` (action tallying).

**Structure template:**
```ts
import type { VaultNote } from "./types.js";
import { FactStore, writeFact } from "../state/facts.js"; // writeFact re-exported here
import type { ReconcileAction } from "../state/facts.js";
import type { FactJudge } from "../orchestrator/memory/fact-judge.js";
import { noteToFacts } from "./index-map.js";

/** Frontmatter status that excludes a note from the active index. Sprint 5 consumes this. */
export const SUPERSEDED_STATUS = "superseded" as const;

export interface ReindexSummary {
  notesParsed: number;
  factsAdded: number;
  factsSuperseded: number;
  factsNoop: number;
}

export async function reindexNotes(
  store: FactStore,
  notes: VaultNote[],
  opts: { scope: string; now: string; judge?: FactJudge; sourceRunId?: string },
): Promise<ReindexSummary> {
  const summary: ReindexSummary = { notesParsed: 0, factsAdded: 0, factsSuperseded: 0, factsNoop: 0 };
  for (const note of notes) {
    if (note.frontmatter.status === SUPERSEDED_STATUS) continue; // contributes no active facts
    summary.notesParsed++;
    const inputs = noteToFacts(note, { scope: opts.scope, now: opts.now, sourceRunId: opts.sourceRunId });
    for (const input of inputs) {
      const action: ReconcileAction = await writeFact(store, input, { judge: opts.judge, now: opts.now });
      if (action === "add") summary.factsAdded++;
      else if (action === "update") summary.factsSuperseded++;
      else if (action === "noop") summary.factsNoop++;
      // "delete" cannot occur without a judge returning delete; ignore or count separately.
    }
  }
  return summary;
}
```

**Imports this file uses:** `VaultNote` from `./types.js`; `FactStore` + `writeFact` (value) and `ReconcileAction` (type) from `../state/facts.js`; `FactJudge` (type) from `../orchestrator/memory/fact-judge.js`; `noteToFacts` from `./index-map.js`.
**Test file:** `src/vault/reindex.test.ts` (create).

---

## 2. Patterns to Follow

### writeFact re-export from the facts barrel (use `../state/facts.js`, NOT reconcile.js)
**Source:** `src/state/facts.ts:10-14` (verified)
```ts
// writeFact lives in reconcile.ts (to avoid a runtime import cycle) but is
// re-exported here so consumers can import it from the facts module.
export { writeFact } from "../orchestrator/memory/reconcile.js";
export type { ReconcileAction } from "../orchestrator/memory/reconcile.js";
```
**Rule:** Import `FactStore`, `FactInput`, `writeFact`, and `ReconcileAction` all from `../state/facts.js`. The generatorNotes mandate this; the evaluator will inspect imports to confirm you route through `writeFact` (not `store.insertFact` directly).

### `writeFact` signature + the exact `ReconcileAction` literals
**Source:** `src/orchestrator/memory/reconcile.ts:16` and `:148-154` (verified)
```ts
export type ReconcileAction = "add" | "update" | "delete" | "noop";

export async function writeFact(
  store: FactStore,
  incoming: FactInput,
  opts: { judge?: FactJudge; now: string },
): Promise<ReconcileAction> {
  return reconcileFact(store, incoming, opts);
}
```
**Rule:** Tally `"add"`/`"update"`/`"noop"`. Map `update -> factsSuperseded`. `delete` only arises if a judge returns it — you wire no judge by default, so it won't fire deterministically.

### Deterministic no-judge ADD fallback (no judge wired here)
**Source:** `src/orchestrator/memory/reconcile.ts:87-100` (verified)
```ts
  if (candidate !== undefined) {
    if (judge !== undefined) {
      const action = await judge.resolve(incoming, candidate);
      return applyJudgeDecision(store, incoming, candidate, action, now);
    }
    // ── Step 4b: Collision but NO judge → deterministic ADD fallback ──
    store.insertFact(incoming);
    return "add";
  }
  // ── Step 4c: No collision → ADD ───────────────────────────────────────
  store.insertFact(incoming);
  return "add";
```
**Rule:** With distinct predicates per frontmatter key, the normalize-key ambiguity branch is unlikely; first write of each key is `"add"`, identical re-write is `"noop"`, changed value is `"update"`.

### Exact-key NOOP vs UPDATE (drives sc-2-3 and sc-2-4)
**Source:** `src/orchestrator/memory/reconcile.ts:63-78` (verified)
```ts
  if (exactMatches.length > 0) {
    const same = exactMatches.find((r) => r.value === incoming.value);
    if (same !== undefined) {
      return "noop";
    }
    for (const old of exactMatches) {
      store.supersedeFact(old.id, now, incoming.tValid); // t_invalidated = now, t_invalid = incoming.tValid
    }
    store.insertFact(incoming);
    return "update";
  }
```
**Rule:** NOOP is gated on EXACT value match for the same `scope|subject|predicate`. So your `stringifyValue` MUST be stable run-to-run (this is why arrays/objects need `JSON.stringify`, not `String([...])` which yields comma-join and is order-fragile for objects). On UPDATE, the prior row's `t_invalidated` is set to `now` (this is what sc-2-4 asserts is non-null).

### Deterministic fact id depends on the stringified value
**Source:** `src/state/facts.ts:58-69` (verified) and `:182`
```ts
export function factId(scope, subject, predicate, value, tCreated): string {
  return createHash("sha256")
    .update(`${scope}|${subject}|${predicate}|${value}|${tCreated}`)
    .digest("hex").slice(0, 16);
}
```
**Rule:** Identical frontmatter + identical injected `now` => identical id => NOOP on second pass. NOTE: `tCreated` is part of the id. In the sc-2-3 "run twice / all noop" test you MUST pass the SAME `now` on both passes, otherwise the id changes and you get duplicate ADDs instead of NOOPs. (NOOP short-circuits on value-match BEFORE id derivation, so same-`now` is required for the id to match but NOOP is decided by value equality at `reconcile.ts:65` — pass the same `now` anyway to keep ids stable.)

### now-injection boundary discipline (timestamps stamped at the CLI/caller, never inside)
**Source:** `src/cli/commands/facts.ts:85-103` (verified)
```ts
// Stamp wall-clock time at handler boundary — NEVER inside the store
const now = new Date().toISOString();
const input = {
  scope: opts.scope, subject: opts.subject, predicate: opts.predicate,
  value: opts.value, confidence: ..., sourceRunId: opts.runId ?? null,
  tValid: now, tCreated: now,
};
const store = new FactStore(factsDbPath(projectRoot, ns));
const action = await writeFact(store, input, { now });
```
**Rule:** `noteToFacts` and `reindexNotes` accept `now` as an ISO-string param. The ONLY place `new Date().toISOString()` is allowed is the future sprint-3 CLI handler. The evaluator greps your two new files for `Date.now()`/`new Date(` — there must be NONE. (See the purity test pattern in section 6.)

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---|---|---|---|
| `writeFact` | `src/orchestrator/memory/reconcile.ts:148` (re-exported `src/state/facts.ts:13`) | `(store, incoming: FactInput, { judge?, now }): Promise<ReconcileAction>` | The sanctioned reconcile-at-ingest write path. Use this — never `store.insertFact`. |
| `reconcileFact` | `src/orchestrator/memory/reconcile.ts:51` | `(store, incoming, { judge?, now }): Promise<ReconcileAction>` | Underlying reconcile; `writeFact` is the thin wrapper. Prefer `writeFact`. |
| `FactStore` | `src/state/facts.ts:136` | `new FactStore(dbPath, opts?)` | SQLite fact store; `:memory:` for tests. |
| `FactStore#getActiveFacts` | `src/state/facts.ts:222` | `(scope, subject?, predicate?): FactRecord[]` | Active rows (t_invalidated IS NULL). Use to assert sc-2-3/sc-2-5. |
| `FactStore#getFact` | `src/state/facts.ts:263` | `(id): FactRecord \| null` | Raw row by id regardless of status; use with `factId(...)` to assert `tInvalidated` non-null (sc-2-4). |
| `factId` | `src/state/facts.ts:58` | `(scope, subject, predicate, value, tCreated): string` | Recompute the deterministic id in tests to look up the superseded row. |
| `FactSchema` / `FactInput` | `src/state/facts.ts:22,33` | zod schema / inferred type | The exact shape your mapping must emit. |
| `ReconcileAction` | `src/orchestrator/memory/reconcile.ts:16` (re-exported `src/state/facts.ts:14`) | `"add"\|"update"\|"delete"\|"noop"` | The tally enum. |
| `FactJudge` | `src/orchestrator/memory/fact-judge.ts` | `{ resolve(incoming, candidate): Promise<ReconcileAction> }` | Optional judge type to thread through (default unused). |
| `parseNote` / `VaultNote` | `src/vault/frontmatter.ts:172`, `src/vault/types.ts:11` | Sprint-1 outputs | Source of the notes your reindex consumes. |

Utilities reviewed for value-stringify helper: `src/vault/`, `src/state/` — NONE exists for "frontmatter value -> stable string". Write a small local `stringifyValue`; do not import a phantom. There is NO existing `SUPERSEDED_STATUS` const anywhere (grep confirmed) — you create and export it.

---

## 4. Prior Sprint Output (Sprint 1 — DONE)

### src/vault/types.ts
**Exports:** `VaultNote { frontmatter: Record<string, unknown>; body: string; path: string }` (`:11-22`); `NoteStatus = "active" | "superseded"` (`:30`).
**Connection:** Your mapping's input type. NOTE: `NoteStatus` already documents `"superseded"` — but it is a TYPE, not a runtime value. You still export a runtime `SUPERSEDED_STATUS` const (the type cannot be used in `frontmatter.status === ...`). Consider `export const SUPERSEDED_STATUS: NoteStatus = "superseded"` to tie them together.

### src/vault/frontmatter.ts
**Exports:** `parseFrontmatter`, `serializeFrontmatter`, `parseNote(raw, path): VaultNote` (`:172`), `serializeNote`.
**Connection:** Sprint-3 CLI will use these to load notes; you only consume the resulting `VaultNote` objects. Note `serializeFrontmatter` arrays become `String(item)` block lists (`:152-159`) — that is YAML serialization, unrelated to your fact `value` stringification (use `JSON.stringify` for arrays in facts).

### src/vault/note-io.ts
**Exports:** `readNote` / `writeNote` / `listNotes` (returns absolute paths). Out of scope here (sprint-3 loads from disk); your tests construct `VaultNote` literals directly.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` consulted for this sprint scope. The governing invariant is encoded in the contract `nonGoals`: (1) do NOT modify `facts.ts` or `reconcile.ts`; (2) no `Date.now()`/`new Date()` inside the two new modules — inject `now`; (3) write ONLY through `writeFact`; (4) do not hardcode medical frontmatter keys — iterate whatever keys the note carries.

### Architecture Decisions
The reconcile-at-ingest design is documented inline at `src/orchestrator/memory/reconcile.ts:1-9` (PURE header) and `:32-50` (the 5-step algorithm). `FactStore` purity contract: `src/state/facts.ts:127-135` ("Never calls Date.now() or new Date() — every timestamp is a parameter"). Honor the same contract in your modules.

### Other Docs
ESM project: `package.json` scripts — build `tsc`, typecheck `tsc --noEmit`, test `vitest`, lint `eslint src/`. All intra-`src` imports use explicit `.js` extensions (verified across `frontmatter.ts:21`, `reconcile.ts:11-12`, `facts.ts:13`).

---

## 6. Testing Patterns

### Unit Test Pattern (vitest, `:memory:` FactStore)
**Source:** `src/orchestrator/memory/reconcile.test.ts:1-78` (verified)
```ts
import { describe, it, expect, afterEach } from "vitest";
import { FactStore, factId } from "../../state/facts.js";
import { writeFact } from "./reconcile.js";

describe("reconcileFact — supersession", () => {
  let store: FactStore;
  afterEach(() => { store?.close(); });

  it("changed value supersedes prior and returns 'update'", async () => {
    store = new FactStore(":memory:");
    const t1 = "2026-06-15T00:00:00.000Z";
    const t2 = "2026-06-16T00:00:00.000Z";
    await writeFact(store, makeInput({ value: "metformin", tValid: t1, tCreated: t1 }), { now: t1 });
    const action2 = await writeFact(store, makeInput({ value: "ozempic", tValid: t2, tCreated: t2 }), { now: t2 });
    expect(action2).toBe("update");

    const active = store.getActiveFacts("programming", "patient", "medication");
    expect(active).toHaveLength(1);
    expect(active[0].value).toBe("ozempic");

    const oldId = factId("programming", "patient", "medication", "metformin", t1);
    const old = store.getFact(oldId);
    expect(old?.tInvalidated).toBe(t2); // record-time set on supersede  ← sc-2-4 assertion shape
    expect(old?.tInvalid).toBe(t2);
  });
});
```
**Runner:** vitest. **Assertion:** `expect(...)`. **Mock approach:** none — real `:memory:` SQLite; for judge use an inline stub object `{ async resolve() { return "update"; } }` (see `reconcile.test.ts:202-206`). **File naming:** co-located `*.test.ts`. **Setup/teardown:** `let store; afterEach(() => store?.close());` (always close `:memory:` stores).

### Purity assertion test (REQUIRED — evaluator checks no clock calls)
**Source:** `src/orchestrator/memory/reconcile.test.ts:337-365` (verified)
```ts
async function readSourceNoComments(): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./reconcile.ts", import.meta.url), "utf-8");
  return source.split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
    .join("\n");
}
it("source does not CALL Date.now() or new Date()", async () => {
  const code = await readSourceNoComments();
  expect(code).not.toMatch(/Date\.now\(\)/);
  expect(code).not.toMatch(/new Date\(\)/);
});
```
**Rule:** Add an equivalent purity test pointing at `./index-map.ts` and `./reindex.ts`. This directly satisfies the evaluatorNote "Confirm no Date.now/new Date".

### How to satisfy each success criterion in tests
- **sc-2-2 (index-map.test.ts):** build a `VaultNote` literal with frontmatter `{ id: "p1", drug: "metformin", tags: ["a","b"] }`; assert `noteToFacts(note, { scope:"medical", now })` yields one `FactInput` per key with `scope:"medical"`, `subject:"p1"`, `predicate:"drug"`, `value:"metformin"`; for the `id`-absent case assert `subject === note.path`; for the array assert `value === JSON.stringify(["a","b"])`.
- **sc-2-3 (reindex.test.ts):** call `reindexNotes` twice with the SAME `now` over identical notes; assert second `summary.factsNoop === <key count>` and `factsAdded === 0`, and `getActiveFacts("medical").length` unchanged. (Evaluator wants action==='noop' per fact, which the tallies prove.)
- **sc-2-4:** first pass with frontmatter `{ id:"p1", dose:"500mg" }`; second pass change `dose:"1000mg"` (use a later `now`); recompute `factId("medical","p1","dose","500mg", now1)` and assert `store.getFact(oldId)?.tInvalidated` is non-null; assert `getActiveFacts("medical","p1","dose")` has length 1 value "1000mg".
- **sc-2-5:** note with frontmatter `{ id:"p1", status:"superseded", drug:"x" }`; after `reindexNotes`, assert `getActiveFacts("medical")` returns ZERO facts contributed by that note (notesParsed should not count it; or count it but contribute nothing — prefer skipping so `notesParsed` reflects indexed notes).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
You are only CREATING files and NOT modifying `facts.ts`/`reconcile.ts` (hard nonGoal). Risk to existing code is therefore near-zero. Existing `FactStore`/`writeFact` consumers are unaffected because you add no exports to their modules.
| File | Depends On | Risk | What to Check |
|---|---|---|---|
| `src/medical/engine.ts` | `FactStore`/`writeFact` from `../state/facts` | low | You don't touch facts.ts; verify suite still green. |
| `src/fleet/synthesis.ts`, `src/fleet/shared-blackboard.ts` | `FactStore` | low | Same — read-only consumers, unchanged. |

### Existing Tests That Must Still Pass
- `src/state/facts.test.ts` — covers `FactStore` insert/active/supersede; must stay green (you don't modify facts.ts).
- `src/orchestrator/memory/reconcile.test.ts` — covers `writeFact`/`reconcileFact` add/noop/update/judge; must stay green.
- `src/vault/frontmatter.test.ts`, `src/vault/note-io.test.ts` — sprint-1 vault tests; unaffected, verify still pass.

### Features That Could Be Affected
- **Sprint 5 (status lifecycle):** will consume your `SUPERSEDED_STATUS` const — export it with a stable name/value `"superseded"`. Do not rename later.
- **Sprint 3 (CLI):** will call `reindexNotes` after loading notes from disk and will stamp `now` at the handler boundary. Keep `reindexNotes`/`noteToFacts` clock-free so sprint 3 can inject.

### Recommended Regression Checks
1. `npm run build` (tsc) — zero errors.
2. `npm run typecheck` — `tsc --noEmit` clean.
3. `npm test` — full vitest suite, no pre-existing test regressed; new `src/vault/index-map.test.ts` + `src/vault/reindex.test.ts` pass.
4. `npm run lint` — `eslint src/` clean (named exports, `.js` import extensions).

---

## 8. Implementation Sequence

1. **src/vault/index-map.ts** — write `noteToFacts` + local `stringifyValue`. Import `VaultNote` (`./types.js`) and `FactInput` (`../state/facts.js`). No clock, no fs.
   - Verify: `npm run typecheck` resolves `FactInput` import; subject fallback handles missing `id`.
2. **src/vault/index-map.test.ts** — sc-2-2 mapping assertions + a purity test (no `new Date(`).
   - Verify: `npx vitest run src/vault/index-map.test.ts` green.
3. **src/vault/reindex.ts** — write `SUPERSEDED_STATUS`, `ReindexSummary`, `reindexNotes`. Import `FactStore`+`writeFact` (value) and `ReconcileAction` (type) from `../state/facts.js`, `noteToFacts` from `./index-map.js`. Loop, skip superseded, tally actions.
   - Verify: `npm run build` clean; imports come from `../state/facts.js` (evaluator inspects this).
4. **src/vault/reindex.test.ts** — sc-2-3 (twice→all noop, same `now`), sc-2-4 (change value→`tInvalidated` non-null via `getFact(factId(...))`), sc-2-5 (status:superseded→0 active facts), plus a purity test for `./reindex.ts`. Use `new FactStore(":memory:")` + `afterEach(() => store?.close())`.
   - Verify: `npx vitest run src/vault/` green.
5. **Run full verification** — `npm run build`, `npm test`, `npm run typecheck`, `npm run lint`.

---

## 9. Pitfalls & Warnings

- **DO NOT import `writeFact`/`ReconcileAction` from `../orchestrator/memory/reconcile.js`.** The contract + generatorNotes mandate the re-export barrel `../state/facts.js` (`facts.ts:13-14`). The evaluator inspects imports.
- **DO NOT call `store.insertFact` directly.** Route every write through `writeFact` or reconcile (noop/supersede) never runs and sc-2-3/sc-2-4 fail.
- **`value` must be a NON-EMPTY string** (`FactSchema value.min(1)`, `facts.ts:26`). A frontmatter key with value `""`, `null`, or `undefined` stringifies to empty/`"null"` — `insertFact` THROWS on empty. Skip empty-stringified values (the template's `if (value.length === 0) continue;`).
- **Stable stringification is load-bearing for NOOP.** Use `JSON.stringify` for arrays/objects, raw string for strings, `String()` for number/boolean. `String(["a","b"])` → `"a,b"` is also stable but loses structure; prefer `JSON.stringify`. NOOP is decided by exact value-string equality (`reconcile.ts:65`).
- **Same `now` across reindex passes for the noop test.** `tCreated` feeds `factId` (`facts.ts:63`); varying `now` changes ids. NOOP itself keys on value equality, but keep `now` identical to mirror real "unchanged note" reindex semantics and avoid surprising id churn.
- **`status:superseded` is filtered in `reindexNotes`, NOT in `noteToFacts`.** sc-2-2 says one FactInput per frontmatter key — the mapping is total over keys. The note-level skip lives in `reindexNotes` (`frontmatter.status === SUPERSEDED_STATUS`).
- **`NoteStatus` (types.ts:30) is a type, not a value** — you cannot compare `frontmatter.status === NoteStatus`. Export a runtime `const SUPERSEDED_STATUS = "superseded"` (optionally typed `: NoteStatus`).
- **No `Date.now()`/`new Date(` anywhere in the two new modules** — inject `now`. Add the source-scan purity test (section 6) or the evaluator flags it.
- **`delete` action** only occurs via a judge; with no judge you won't see it. Don't add a `factsDeleted` field unless you also thread a judge — the contract's summary shape is exactly `{ notesParsed, factsAdded, factsSuperseded, factsNoop }`.
- **Close `:memory:` stores in `afterEach`** to avoid leaking handles across the suite (pattern: `reconcile.test.ts:39-41`).
