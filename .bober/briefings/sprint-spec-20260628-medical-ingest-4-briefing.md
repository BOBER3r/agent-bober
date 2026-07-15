# Sprint Briefing: Supplements markdown-frontmatter list -> FactStore + supplements CLI

**Contract:** sprint-spec-20260628-medical-ingest-4
**Generated:** 2026-06-28T00:00:00Z

---

## 0. TL;DR for the Generator

Build `src/medical/supplements.ts` that (a) replicates the hand-rolled frontmatter
fence-parse from `lab-note.ts` to read a LIST of `{ name, dose }` entries, and
(b) flattens each entry into a `FactInput` reconciled via `writeFact` (NO judge,
injected `now`). Add two cores `runSupplementAdd` / `runSupplementList` (deps-injected,
incl. an injectable `FactStore`) and register `medical supplements add|list` on the
existing `medical` command tree in `src/cli/commands/medical.ts`.

**The exact FactInput shape the Generator MUST build (from contract sc-4-2 + generatorNotes):**
```ts
const input = {
  scope: "medical",          // FactStore scope
  subject: name,             // the supplement name (e.g. "Vitamin D")
  predicate: "dose",         // fixed predicate that carries the dose
  value: dose ?? "unspecified", // FactSchema requires value.min(1) -> placeholder when --dose omitted
  confidence: 1,
  sourceRunId: null,
  tValid: now,               // injected ISO at the CLI boundary
  tCreated: now,             // injected ISO at the CLI boundary
};
await writeFact(store, input, { now }); // NO judge -> deterministic add/update/noop
```

**Why a re-add is a NOOP (sc-4-3):** `reconcileFact` first does an exact-key lookup
`getActiveFacts(scope, subject, predicate)`; if an active row has the SAME `value`, it
returns `"noop"` and inserts nothing (`reconcile.ts:57-68`). So adding the same
name+dose twice leaves `getActiveFacts("medical")` at length 1.

---

## 1. Target Files

### src/medical/supplements.ts (create)

**Directory pattern:** `src/medical/*.ts` kebab/lowercase single-word modules; tests collocated `*.test.ts`.
**Most similar existing file:** `src/medical/lab-note.ts` (frontmatter parse) + `src/vault/reindex.ts:60-102` (writeFact loop). Follow these two.

**Structure template (skeleton inferred from lab-note.ts + facts/reconcile usage):**
```ts
/**
 * Supplements list -> FactStore. PURE deterministic reconcile.
 * NO LLM, NO network, NO Date.now() — `now` is injected.
 * Hand-rolled frontmatter parse mirrors lab-note.ts:120-148; NEVER import src/vault.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FactStore, FactInput } from "../state/facts.js";
import { writeFact } from "../state/facts.js"; // re-exported there (facts.ts:13)

export interface SupplementEntry { name: string; dose: string; }

// fence-find + parse a LIST of entries (replicate lab-note.ts:121-136 fence logic)
export function parseSupplementsFile(raw: string): SupplementEntry[] { /* ... */ }

// flatten ONE entry -> FactInput (scope/subject/predicate/value above)
export function supplementToFact(name: string, dose: string | undefined, now: string): FactInput { /* ... */ }

export const DEFAULT_DOSE = "unspecified"; // value.min(1) placeholder
```

**Imports this file uses:** `readFile` from `node:fs/promises`; `writeFact` + types `FactStore`/`FactInput` from `../state/facts.js`.

**Imported by (after creation):** `src/cli/commands/medical.ts` (the new subcommand cores) and `src/medical/supplements.test.ts`.

**Test file:** `src/medical/supplements.test.ts` — does NOT exist yet (create).

---

### src/medical/supplements.test.ts (create)

**Most similar existing files:** `src/state/facts.test.ts` (in-memory FactStore + getActiveFacts assertions) and `src/cli/commands/medical.test.ts` (stdout spy + temp dir + deps injection).

---

### src/cli/commands/medical.ts (modify)

**Relevant sections to mirror — `runImportLabs` core + deps interface (lines 129-213):**
```ts
/** Injectable dependencies for runImportLabs — production callers pass undefined. */
export interface ImportLabsDeps {
  parse?: typeof parseLabPdf;
  nowIso?: string;            // <- injected clock; default new Date().toISOString()
}

export async function runImportLabs(
  projectRoot: string,
  pdfPath: string,
  deps: ImportLabsDeps = {},
  opts: { vault?: string } = {},
): Promise<void> {
  let store: HealthDataStore | undefined;
  try {
    // ...
    const nowIso = deps.nowIso ?? new Date().toISOString();   // clock read ONLY at boundary
    const medicalDir = join(projectRoot, ".bober", "medical");
    await ensureDir(medicalDir);
    // ...
  } catch (err) {
    process.stderr.write(chalk.red(`Failed to import labs: ${err instanceof Error ? err.message : String(err)}\n`));
    process.exitCode = 1;     // handlers NEVER throw — set exitCode + return
  } finally {
    store?.close();
  }
}
```

**Subcommand registration to mirror — `registerMedicalCommand` (lines 222-291):**
```ts
export function registerMedicalCommand(program: Command): void {
  const medicalCmd = program.command("medical").description("Medical team utilities (health data import)");

  // existing: medical import <file>, medical import-labs <pdf>
  medicalCmd
    .command("import-labs <pdf>")
    .description("Parse a lab PDF and ingest results into the medical health store")
    .option("--vault <dir>", "vault dir (default: under .bober/medical)")
    .action(async (pdf: string, opts: { vault?: string }) => {
      const projectRoot = await resolveRoot();
      await runImportLabs(projectRoot, pdf, {}, opts);
    });

  // existing nested sub-tree precedent: const whoopCmd = medicalCmd.command("whoop")...
  //   whoopCmd.command("sync")...   <- use the SAME nested pattern for `supplements`
}
```

**ADD a nested `supplements` sub-tree (mirror the `whoop` nesting at lines 277-290):**
```ts
const suppCmd = medicalCmd.command("supplements").description("Supplements list -> FactStore");
suppCmd
  .command("add <name>")
  .option("--dose <d>", "dose string (default: unspecified)")
  .action(async (name, opts) => { const root = await resolveRoot(); await runSupplementAdd(root, name, opts); });
suppCmd
  .command("list")
  .option("--file <path>", "supplements markdown file (default: .bober/medical/supplements.md)")
  .action(async (opts) => { const root = await resolveRoot(); await runSupplementList(root, opts); });
```

**Imports this file already has (reuse, do NOT re-add):** `readFile` (node:fs/promises:4), `join` (node:path:5), `chalk` (6), `Command` type (7), `findProjectRoot`+`ensureDir` from `../../utils/fs.js` (9), `resolveRoot()` helper (lines 29-32).
**You MUST ADD:** `import { FactStore, factsDbPath, ensureFactsDir } from "../../state/facts.js";` and `import { runSupplementAdd, runSupplementList } from "../../medical/supplements.js";` (or define the cores in medical.ts importing the pure helpers from supplements.ts — generatorNotes say cores live where they are testable; placing the cores in medical.ts next to runImportLabs matches the established pattern).

**Imported by:** `src/cli/index.ts:40,320` (`registerMedicalCommand` is wired into the root program — no change needed there).

**Test file:** `src/cli/commands/medical.test.ts` (exists) — but sc-4-2/3/4 tests live in `src/medical/supplements.test.ts` per `estimatedFiles`.

---

## 2. Patterns to Follow

### FactInput construction + writeFact in a CLI handler (deterministic, no judge)
**Source:** `src/cli/commands/facts.ts`, lines 85-103
```ts
// Stamp wall-clock time at handler boundary — NEVER inside the store
const now = new Date().toISOString();
const input = {
  scope: opts.scope, subject: opts.subject, predicate: opts.predicate,
  value: opts.value, confidence: 1, sourceRunId: opts.runId ?? null,
  tValid: now, tCreated: now,
};
const store = new FactStore(factsDbPath(projectRoot, ns));
try {
  // No judge wired here — deterministic ADD/UPDATE/NOOP only.
  const action = await writeFact(store, input, { now });
} finally { store.close(); }
```
**Rule:** Read the clock ONCE at the CLI boundary, pass it as `now` AND `tValid`/`tCreated`; never pass a `judge`; always `store.close()` in `finally`.

### writeFact loop over flattened entries (the supplements add maps onto a 1-entry version of this)
**Source:** `src/vault/reindex.ts`, lines 88-97
```ts
const action: ReconcileAction = await writeFact(store, input, {
  judge: opts.judge, now: opts.now,
});
if (action === "add") summary.factsAdded++;
else if (action === "update") summary.factsSuperseded++;
else if (action === "noop") summary.factsNoop++;
```
**Rule:** `writeFact` returns `"add"|"update"|"delete"|"noop"` — branch on it for output messaging; `delete` only occurs with a judge (won't happen here).

### Hand-rolled frontmatter fence parse to REPLICATE (do NOT add a YAML dep, do NOT import src/vault)
**Source:** `src/medical/lab-note.ts`, lines 120-148 (function header at :9-12 forbids importing src/vault/frontmatter.ts)
```ts
export function parseLabNote(raw: string): LabNoteFrontmatter {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") throw new Error("parseLabNote: missing opening '---' fence");
  let closingIdx = -1;
  for (let i = 1; i < lines.length; i++) { if (lines[i].trim() === "---") { closingIdx = i; break; } }
  if (closingIdx === -1) throw new Error("parseLabNote: missing closing '---' fence");
  const yamlLines = lines.slice(1, closingIdx);
  // ... per-line: const colonIdx = line.indexOf(":"); key = slice(0,colonIdx).trim(); val = slice(colonIdx+1).trim();
}
```
**Rule:** Replicate the `---` fence-finding loop. CAUTION: `parseLabNote` returns the lab-specific flat-scalar shape (marker/value/unit/...) and CANNOT parse a LIST — it is exported but the WRONG shape for supplements. `serializeLabFrontmatter` is NOT exported (lab-note.ts:95, private). So author a small list-aware parser locally in supplements.ts; do NOT import `parseLabNote`. A pragmatic list format the fence loop handles well:
```
---
supplements:
  - Vitamin D | 1000 IU
  - Magnesium | 200 mg
---
```
(after the `supplements:` line, collect each `  - ` line and split on `|` into name/dose). Format is the Generator's choice as long as it is markdown-frontmatter holding a list.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `writeFact` | `src/orchestrator/memory/reconcile.ts:148` (re-exported `src/state/facts.ts:13`) | `(store: FactStore, incoming: FactInput, opts: { judge?: FactJudge; now: string }): Promise<ReconcileAction>` | Reconcile-then-write; exact-match NOOP/UPDATE; no-judge => deterministic ADD. Import from `../state/facts.js`. |
| `reconcileFact` | `src/orchestrator/memory/reconcile.ts:51` | same as writeFact | Underlying reconcile; writeFact is a thin wrapper. Either is fine. |
| `FactStore` | `src/state/facts.ts:136` | `new FactStore(dbPath: string, opts?: {...})` | SQLite fact store; pass `":memory:"` in tests. |
| `FactStore.getActiveFacts` | `src/state/facts.ts:222` | `(scope: string, subject?: string, predicate?: string): FactRecord[]` | Active (t_invalidated IS NULL) facts; assert `.length` for NOOP/dedup. |
| `FactStore.insertFact` | `src/state/facts.ts:173` | `(input: FactInput): FactRecord` | Validates with FactSchema; do NOT call directly — go through writeFact. |
| `FactStore.close` | `src/state/facts.ts:303` | `(): void` | Close DB; call in `finally`. |
| `factsDbPath` | `src/state/facts.ts:77` | `(projectRoot: string, namespace?: string): string` | Resolve facts.db path; medical uses namespace `"medical"` (engine.ts:372). |
| `ensureFactsDir` | `src/state/facts.ts:86` | `(projectRoot: string, namespace?: string): Promise<void>` | mkdir for the facts.db dir; call before constructing a file-backed FactStore. |
| `FactSchema` / `FactInput` | `src/state/facts.ts:22,33` | zod schema / `z.infer` type | The exact input contract (see Section 4). |
| `ensureDir` | `src/utils/fs.ts:45` | `(path: string): Promise<void>` | Async mkdir -p (used by medical.ts already). |
| `findProjectRoot` | `src/utils/fs.ts:58` | `(): Promise<string \| undefined>` | Used by `resolveRoot()` in medical.ts:29-32. |
| `readFile` | `node:fs/promises` | stdlib | Read the supplements markdown file (async only — principles). |

**Frontmatter:** there is NO shared frontmatter util to import — `lab-note.ts` and `src/vault/frontmatter.ts` each hand-roll their own and explicitly forbid cross-import (lab-note.ts:9-12). Replicate, don't import.

---

## 4. The FactInput / FactSchema shape (load-bearing)

**Source:** `src/state/facts.ts:22-33`
```ts
export const FactSchema = z.object({
  scope: z.string(),
  subject: z.string().min(1),       // REQUIRED non-empty
  predicate: z.string().min(1),     // REQUIRED non-empty
  value: z.string().min(1),         // REQUIRED non-empty -> need a placeholder when --dose omitted
  confidence: z.number().min(0).max(1).default(1),
  sourceRunId: z.string().nullable().default(null),
  tValid: z.string().datetime(),    // ISO 8601 REQUIRED
  tCreated: z.string().datetime(),  // ISO 8601 REQUIRED
});
export type FactInput = z.infer<typeof FactSchema>;
```
**`insertFact` throws on invalid input (facts.ts:174-180)** — so an empty `value` (omitted dose with no placeholder) will throw. Default `value` to `"unspecified"` (or similar non-empty marker) when `--dose` is absent. `tValid`/`tCreated` must be `.datetime()` ISO strings (e.g. `new Date().toISOString()`), NOT a bare date.

### Established medical scope/subject/predicate convention (reference, NOT the supplement shape)
**Source:** `src/medical/engine.ts:370` + `src/medical/engine.test.ts:490-499`
```ts
// MEDICATIONS use subject "patient", predicate "takes-medication":
facts.getActiveFacts("medical", "patient", "takes-medication");
facts.insertFact({ scope: "medical", subject: "patient", predicate: "takes-medication",
                   value: "metformin 500mg", confidence: 1, sourceRunId: null,
                   tValid: "...Z", tCreated: "...Z" });
```
**Divergence note:** Meds use `subject:"patient"`. Per contract sc-4-2 + generatorNotes, **supplements use `subject = the supplement name`, `predicate = "dose"`, `value = dose`**. Use the supplement shape (Section 0), NOT the meds shape — they intentionally differ so each supplement is its own subject row.

---

## 5. Prior Sprint Output

### Sprint 2 (181f30c): src/medical/lab-note.ts
**Created/exports:** `parseLabNote` (exported, flat-scalar lab shape), `slugify`, `deriveLabStatus`, `writeLabNote`; `serializeLabFrontmatter` is PRIVATE.
**Connection:** Reuse the hand-rolled `---` fence-parse APPROACH (lab-note.ts:121-136), NOT the function itself (wrong shape / list-unaware). No YAML dependency.

### Sprint 3 (cd4a2ea): src/cli/commands/medical.ts
**Created/exports:** `runImportLabs` (core), `ImportLabsDeps`, `runWhoopSync`, `WhoopSyncDeps`, `registerMedicalCommand`.
**Connection:** Mirror the extracted-core + injected-deps (incl injected `nowIso`) + subcommand-registration pattern. Add `runSupplementAdd`/`runSupplementList` cores and register `supplements add|list` under the existing `medical` tree (use the nested `whoop`-subtree pattern, medical.ts:277-290).

---

## 6. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM everywhere** — all imports use `.js` extensions (NodeNext). (line 27)
- **`import type`** — `consistent-type-imports` is enforced; import `FactStore`/`FactInput` as `import type`. (line 35)
- **No synchronous fs** — use `node:fs/promises` only (`readFile`, no `readFileSync`). (line 42)
- **No `any`** — use `unknown` + narrowing. (line 40)
- **Tests collocated** `*.test.ts`, vitest, real temp dirs (no fs mocks). (lines 20, 44)
- **Injected clock** — the pure reconcile path never calls `Date.now()`; stamp `now` at the CLI boundary (matches facts.ts:85, reconcile.ts:49). The Generator MUST inject `now` into the pure path; `new Date().toISOString()` only at the CLI `.action()`/core boundary.
- **Section comments** — `// -- Section --` box headers in long files. (line 32)

### Architecture Decisions
- **ADR-7:** FactStore is the canonical structured store for meds/supplements (engine.ts:9,365; not HealthDataStore lab_results). No `.bober/architecture/` ADR file is specific to this sprint; ADR-7 is referenced inline in `src/medical/engine.ts`.

### Other Docs
- Contract nonGoals (sprint JSON:40-45): NO LLM/network; NOT a HealthDataStore lab row; NOT a new top-level command (nest under `medical`); only `name` required, dose optional.

---

## 7. Testing Patterns

### Unit Test Pattern — in-memory FactStore + getActiveFacts assertion (NOOP/dedup)
**Source:** `src/state/facts.test.ts:17-34` and `src/orchestrator/memory/reconcile.test.ts:141-176`
```ts
import { afterEach, describe, it, expect } from "vitest";
import { FactStore } from "../state/facts.js";

describe("runSupplementAdd", () => {
  let store: FactStore;
  afterEach(() => { store?.close(); });

  it("adds a supplement then re-add is a NOOP (count stays 1) — sc-4-2/sc-4-3", async () => {
    store = new FactStore(":memory:");
    const now = "2026-06-15T00:00:00.000Z";
    await runSupplementAdd("/root", "Vitamin D", { dose: "1000 IU" }, { store, now });
    let active = store.getActiveFacts("medical");      // or ("medical","Vitamin D","dose")
    expect(active).toHaveLength(1);
    expect(active[0].value).toBe("1000 IU");
    // Re-add identical name+dose -> exact-match NOOP, no second row
    await runSupplementAdd("/root", "Vitamin D", { dose: "1000 IU" }, { store, now });
    expect(store.getActiveFacts("medical")).toHaveLength(1);   // sc-4-3
  });
});
```
**Runner:** vitest. **Assertion:** `expect(...)`. **Mock approach:** prefer dependency injection (pass `{ store, now }`) over `vi.mock`; `:memory:` FactStore (no temp dir needed). **File naming:** `supplements.test.ts` collocated in `src/medical/`.

### CLI / stdout-capture Pattern (for `list` — sc-4-4)
**Source:** `src/cli/commands/medical.test.ts:194-198, 312-353`
```ts
const stdoutWrites: string[] = [];
const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
  stdoutWrites.push(String(c)); return true;
});
// ... seed a temp supplements.md, then:
await runSupplementList(tmpDir, { file: suppPath });
stdoutSpy.mockRestore();
const out = stdoutWrites.join("");
expect(out).toContain("Vitamin D");
expect(out).toContain("1000 IU");
```
**Temp dir setup (medical.test.ts:50-66):**
```ts
let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-supp-")); process.exitCode = 0; });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); vi.restoreAllMocks(); });
```
**Seed the file with `writeFile(join(tmpDir, "supplements.md"), "---\nsupplements:\n  - Vitamin D | 1000 IU\n---\n")`.**

### Commander wiring smoke test (optional, mirrors medical.test.ts:452-487)
```ts
const program = new Command(); program.exitOverride();
registerMedicalCommand(program);
await program.parseAsync(["node", "bober", "medical", "supplements", "list", "--file", suppPath]);
```

### E2E Test Pattern
Not applicable — this is a CLI/library sprint; no Playwright config in scope.

---

## 8. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/index.ts:40,320` | `registerMedicalCommand` (medical.ts) | low | Adding a nested `supplements` subtree is additive; existing `medical import` / `import-labs` / `whoop sync` registration unchanged. |
| `src/cli/commands/medical.test.ts` | `runImportLabs`, `runWhoopSync`, `registerMedicalCommand` exports | low | Do NOT change existing exports' signatures; only ADD `runSupplementAdd`/`runSupplementList`/registration. |
| `src/state/facts.ts` consumers (engine.ts, facts CLI, vault/reindex, fact-detector) | `FactStore`, `writeFact`, `getActiveFacts` | low/none | You only CALL these (read-only consumer); do NOT modify facts.ts or reconcile.ts. |

### Existing Tests That Must Still Pass
- `src/cli/commands/medical.test.ts` — tests `runImportLabs`/`runWhoopSync`/commander wiring; must stay green after additive edits to medical.ts.
- `src/state/facts.test.ts` — FactStore insert/getActiveFacts/invalidate; you import these unchanged.
- `src/orchestrator/memory/reconcile.test.ts` — NOOP/UPDATE/ADD semantics your sprint relies on; do not touch reconcile.ts (it has purity assertions at :337-366).
- `src/medical/engine.test.ts:481-538` — ADR-7 meds-via-FactStore; confirm you did not change the `("medical","patient","takes-medication")` convention.

### Features That Could Be Affected
- **Medications-in-FactStore (base medical-team, ADR-7)** — shares `FactStore` scope `"medical"`. Your supplements use a DIFFERENT subject/predicate (`name`/`"dose"`), so they coexist; verify `getActiveFacts("medical","patient","takes-medication")` is untouched by a supplements add.
- **`bober facts add` CLI** — shares `writeFact`; read-only reuse, no change.

### Recommended Regression Checks (run after implementation)
1. `npm run build` — exits 0 (sc-4-1).
2. `npx vitest run src/medical/supplements.test.ts` — new suite green (sc-4-2/3/4).
3. `npx vitest run src/cli/commands/medical.test.ts` — existing medical CLI suite still green.
4. `npx vitest run src/state/facts.test.ts src/orchestrator/memory/reconcile.test.ts` — FactStore/reconcile unchanged.
5. Grep guard: `grep -nE "createClient|fetch\(|Date\.now\(\)|FactJudge" src/medical/supplements.ts` returns nothing in the pure path (no LLM/network; injected now).

---

## 9. Implementation Sequence

1. **src/medical/supplements.ts — types + pure parser** — define `SupplementEntry`, `parseSupplementsFile(raw): SupplementEntry[]` (replicate lab-note.ts:121-136 fence loop, list-aware), `DEFAULT_DOSE`, and `supplementToFact(name, dose, now): FactInput`.
   - Verify: a unit test parses a seeded `---\nsupplements:\n  - X | Y\n---` string into `[{name:"X",dose:"Y"}]`; `supplementToFact("X", undefined, now).value === "unspecified"`.
2. **src/medical/supplements.ts — cores** (or place cores in medical.ts; either satisfies estimatedFiles since medical.ts is also a target) — `runSupplementAdd(projectRoot, name, opts:{dose?}, deps:{store?:FactStore; now?:string})` builds the FactInput and calls `writeFact(store, input, { now })` (NO judge); `runSupplementList(projectRoot, opts:{file?}, deps?)` reads the markdown file via `readFile`, `parseSupplementsFile`, and `process.stdout.write` each `name + dose`.
   - Verify: deps default to a real FactStore via `factsDbPath(projectRoot,"medical")` + `ensureFactsDir`; tests inject `{ store: new FactStore(":memory:"), now }`.
3. **src/cli/commands/medical.ts — register subcommands** — add the nested `supplements` subtree (`add <name> [--dose]`, `list [--file]`) mirroring the `whoop` subtree (medical.ts:277-290); `.action()` resolves `resolveRoot()` then calls the cores with no injected deps.
   - Verify: `registerMedicalCommand` still compiles; commander smoke test reaches `medical supplements list`.
4. **src/medical/supplements.test.ts — tests** — sc-4-2 (add -> getActiveFacts returns the fact), sc-4-3 (re-add same name+dose -> count stays 1), sc-4-4 (list parses seeded file -> stdout contains name+dose). Use `:memory:` FactStore + stdout spy + temp file.
   - Verify: all three pass; no network/LLM.
5. **Run full verification** — `npm run build` (sc-4-1), `npx vitest run src/medical/supplements.test.ts src/cli/commands/medical.test.ts`, and the regression checks in Section 8.

---

## 10. Pitfalls & Warnings

- **`value` is `.min(1)` (facts.ts:25)** — omitting `--dose` with an empty value makes `insertFact` THROW (facts.ts:174-180). Default to a non-empty placeholder (`"unspecified"`).
- **Do NOT pass a judge.** `writeFact(store, input, { now })` only — passing a `FactJudge` opens an LLM/async surface the contract forbids (nonGoals:41). No `import` of `fact-judge` needed.
- **`tValid`/`tCreated` must be `.datetime()` ISO strings.** A bare `YYYY-MM-DD` fails zod `.datetime()`. Use `new Date().toISOString()` at the boundary (or the injected `now`).
- **Do NOT import `parseLabNote`** for parsing — it returns the lab flat-scalar shape and cannot read a list. Replicate the fence loop locally. **Do NOT import `src/vault/frontmatter.ts`** (forbidden, lab-note.ts:9-12).
- **Re-add NOOP requires the EXACT same (scope, subject, predicate, value).** If `--dose` differs, it is an UPDATE/supersede (still length 1, but `value` changes); if the supplement NAME differs it is a new ADD (length grows). For sc-4-3 the test must re-add identical name AND dose.
- **Ambiguity branch coexistence:** two supplements whose names normalize-equal after stripping non-alphanumerics (e.g. `"Vitamin D"` vs `"vitamin-d"`) with the same predicate `"dose"` but different value will, with NO judge, ADD a second active row (reconcile.ts:93-96). Keep names consistent if you want a NOOP/UPDATE; not a concern for the seeded tests.
- **Stamp the clock ONCE at the CLI `.action()`/core boundary** and thread it as `now` (and `tValid`/`tCreated`). The pure path must never call `Date.now()` (principles; reconcile purity test at reconcile.test.ts:355-359).
- **CLI handlers must not throw** — wrap in try/catch, set `process.exitCode = 1`, write a chalk.red message (medical.ts:203-212 pattern). `supplements` is a SUBcommand of `medical`, never a new top-level command (nonGoals:43).
- **Use `import type` for `FactStore`/`FactInput`** (eslint consistent-type-imports) but a VALUE import for `FactStore` when you `new` it in tests/cores and for `writeFact`/`factsDbPath`/`ensureFactsDir`.
- **medical.ts already imports `readFile`, `join`, `chalk`, `ensureDir`** — reuse; do not duplicate the import lines.
