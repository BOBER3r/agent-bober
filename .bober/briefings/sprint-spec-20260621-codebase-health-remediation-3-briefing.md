# Sprint Briefing: Remove the two verified dead-code orphans (stashAndRestore, saveOutline)

**Contract:** sprint-spec-20260621-codebase-health-remediation-3
**Generated:** 2026-06-21T00:00:00Z

---

## 0. TL;DR (verified findings)

- **stashAndRestore** lives at `src/utils/git.ts:154` (def starts here; doc comment `:149-153`; body ends `:171`). Re-exported once at `src/utils/index.ts:8`. **Zero call sites** anywhere in `src/` (only the def + the barrel line). DELETE the function + doc comment + barrel line.
- **saveOutline** lives at `src/state/outline-state.ts:28` (def; doc comment `:17-27`; body ends `:37`). Re-exported once at `src/state/index.ts:44`. **Zero call sites** anywhere in `src/`. DELETE the function + doc comment + barrel line.
- **`outline-state.ts` has ANOTHER export: `readOutline` (`src/state/outline-state.ts:44`) which IS live** (called at `src/orchestrator/pipeline.ts:828`, mocked in two tests). So do **NOT** delete the file — remove only `saveOutline`, keep `readOutline` and the helpers.
- **Collocated tests: NONE.** There is no `src/utils/git.test.ts` and no `src/state/outline-state.test.ts`. A full-source grep for `stashAndRestore|saveOutline` in `*.test.ts` returns nothing. No test files to delete or edit.
- **The 3 false positives are genuinely live — VERIFIED, do not touch:** `runPlanAnswerInteractive` (called at `src/cli/index.ts:152`), `summarizeSprint` (called at `src/orchestrator/context-handoff.ts:171`), `readBriefing` (public API at `src/index.ts:153`).
- **Import cleanup is REQUIRED in outline-state.ts** (see §2). `writeFile` and `ensureDir` become unused there and WILL break `npm run build` (tsconfig `noUnusedLocals: true`) and `npm run lint` (`@typescript-eslint/no-unused-vars: error`). git.ts needs **no** import changes.

---

## 1. Target Files

### src/utils/git.ts (modify)

**Relevant section to DELETE — lines 149-171 (doc comment + function):**
```ts
/**
 * Stash any current changes, run the provided function, then restore.
 *
 * If the stash is empty (nothing to save) the restore step is skipped.
 */
export async function stashAndRestore<T>(
  cwd: string,
  fn: () => Promise<T>,
): Promise<T> {
  const dirty = await hasUncommittedChanges(cwd);

  if (dirty) {
    await execa("git", ["stash", "push", "-m", "bober-auto-stash"], { cwd });
  }

  try {
    return await fn();
  } finally {
    if (dirty) {
      await execa("git", ["stash", "pop"], { cwd, reject: false });
    }
  }
}
```
This is the LAST thing in the file (ends at `:171`, EOF). Delete `:149-171` inclusive (the blank line above the doc-comment at `:148` separates it from `isClean`).

**Imports / in-file symbols stashAndRestore uses — and whether they become unused:**
- `execa` (imported `src/utils/git.ts:1`) — still used by `getCurrentBranch`, `createBranch`, `commitAll`, `getChangedFiles`, `getDiff`, `hasUncommittedChanges`, `addWorktree`, `removeWorktree`, `isClean` (13 `execa(` call sites in the file). **STAYS.**
- `hasUncommittedChanges` (defined `src/utils/git.ts:79`) — its ONLY in-file caller is `stashAndRestore` (`:158`), BUT it is a sibling **export** (barrel line `src/utils/index.ts:9`). **DO NOT delete `hasUncommittedChanges`** — it is part of the public surface; an unused export is not flagged by `noUnusedLocals`/`no-unused-vars`.
- **Net result for git.ts: NO import line changes. Only delete lines 149-171.**

**Imported by (the barrel only):** `src/utils/index.ts:8` re-exports `stashAndRestore`.
**Test file:** `src/utils/git.test.ts` — **does not exist** (no collocated test).

---

### src/utils/index.ts (modify)

**Relevant section — lines 2-10 (remove ONLY the `stashAndRestore,` line at :8):**
```ts
export {
  getCurrentBranch,
  createBranch,
  commitAll,
  getChangedFiles,
  getDiff,
  stashAndRestore,   // <-- DELETE THIS LINE (line 8)
  hasUncommittedChanges,
} from "./git.js";
```
Keep all 6 remaining names. Do NOT remove `hasUncommittedChanges`.

---

### src/state/outline-state.ts (modify — DELETE FUNCTION + FIX IMPORTS, keep the file)

**Current imports — lines 1-4:**
```ts
import { readFile, writeFile } from "node:fs/promises";  // line 1
import { join } from "node:path";                        // line 2
                                                         // line 3 (blank)
import { ensureDir } from "./helpers.js";                // line 4
```

**Relevant section to DELETE — lines 17-37 (doc comment + saveOutline):**
```ts
/**
 * Save a structure outline document to disk as a markdown file.
 * Overwrites any existing outline with the same specId.
 *
 * The content should be a complete markdown document with sections per phase:
 * - Phase title
 * - Key Changes (types, signatures, interfaces)
 * - Files affected
 * - Test Checkpoint (how to verify independently)
 * - Depends On (prior phases)
 */
export async function saveOutline(
  projectRoot: string,
  specId: string,
  content: string,
): Promise<void> {
  await ensureDir(outlinesDir(projectRoot));
  const filePath = outlinePath(projectRoot, specId);
  await writeFile(filePath, content, "utf-8");
}
```

**KEEP these (the rest of the file):**
- `OUTLINES_DIR` const (`:6`), `outlinesDir` (`:8`), `outlinePath` (`:12`) helpers — `outlinePath`/`outlinesDir` are still used by the surviving `readOutline`.
- `readOutline` (`:44-58`) — LIVE export (see §4 impact). Uses `readFile` (`:51`) and `join` indirectly via `outlinePath`.

**MANDATORY import cleanup after deleting saveOutline (else build/lint FAIL):**
- `writeFile` — used ONLY in saveOutline (`:36`). After deletion it is unused. Change line 1 from
  `import { readFile, writeFile } from "node:fs/promises";` → `import { readFile } from "node:fs/promises";`
- `ensureDir` — used ONLY in saveOutline (`:33`). After deletion it is unused. **Delete the entire import line 4** (`import { ensureDir } from "./helpers.js";`) AND the blank line 3 if it leaves a stray gap.
- `readFile` STAYS (used by `readOutline` at `:51`). `join` STAYS (used by `outlinesDir`/`outlinePath`).

**Imported by (the barrel only):** `src/state/index.ts:44` re-exports `saveOutline`.
**Test file:** `src/state/outline-state.test.ts` — **does not exist**.

---

### src/state/index.ts (modify)

**Relevant section — lines 43-46 (remove ONLY the `saveOutline,` line at :44):**
```ts
export {
  saveOutline,   // <-- DELETE THIS LINE (line 44)
  readOutline,
} from "./outline-state.js";
```
Keep `readOutline,` — it is live. The block becomes a single-name export of `readOutline`.

---

## 2. Patterns to Follow

### Pattern: collocated module + barrel re-export
**Source:** `src/utils/index.ts:2-10`, `src/state/index.ts:43-46`
```ts
export {
  getCurrentBranch,
  ...
} from "./git.js";
```
**Rule:** Every util/state function is re-exported by name through the directory `index.ts` barrel. To fully remove a symbol you must delete the source definition AND its name in the barrel block — both, or grep (sc-3-3) fails.

### Pattern: strict unused-import enforcement
**Source:** `tsconfig.json:19-20` (`"noUnusedLocals": true`, `"noUnusedParameters": true`) and `eslint.config.js:33-36` (`"@typescript-eslint/no-unused-vars": ["error", ...]`)
```jsonc
"noUnusedLocals": true,
"noUnusedParameters": true,
```
**Rule:** Any import that becomes unused after a deletion breaks BOTH `npm run build`/`npm run typecheck` AND `npm run lint`. You MUST prune `writeFile` and `ensureDir` in outline-state.ts.

### Pattern: doc-comment travels with the function
**Source:** `src/utils/git.ts:149-171`, `src/state/outline-state.ts:17-37`
**Rule:** Each exported function has a leading `/** ... */` block. Delete the doc comment together with its function — leaving an orphan doc comment is sloppy and may attach to the wrong symbol.

---

## 3. Existing Utilities — DO NOT Recreate

This sprint creates no code; the relevant inventory is the sibling symbols that MUST SURVIVE in the touched files.

| Utility | Location | Signature | Purpose / why it stays |
|---------|----------|-----------|------------------------|
| `hasUncommittedChanges` | `src/utils/git.ts:79` | `(cwd: string): Promise<boolean>` | Public export (`utils/index.ts:9`). Its only in-file caller is the deleted fn, but it stays a live export. |
| `getCurrentBranch` / `createBranch` / `commitAll` / `getChangedFiles` / `getDiff` | `src/utils/git.ts:8/18/27/45/64` | various | All retained `git.js` exports — keep their barrel lines. |
| `readOutline` | `src/state/outline-state.ts:44` | `(projectRoot, specId): Promise<string>` | LIVE — called at `pipeline.ts:828`. Keep fn + barrel line `state/index.ts:45`. |
| `outlinePath` / `outlinesDir` | `src/state/outline-state.ts:12/8` | private helpers | Still used by surviving `readOutline`. Keep. |
| `ensureDir` | `src/utils/helpers.js` (imported `outline-state.ts:4`) | — | The HELPER survives; only the *import in outline-state.ts* is removed because it becomes unused there. Do not delete `helpers.ts`. |

Utilities reviewed: `src/utils/` (git.ts, fs.ts, logger.ts, helpers via import), `src/state/` barrels. No new utility is needed.

---

## 4. Prior Sprint Output

### Sprint 1 (broke fleet cycle) & Sprint 2 (runSprintCycle params object)
**Connection to this sprint:** NONE. Both passed and touched unrelated files (fleet module / runSprintCycle signature). `dependsOn: []` in the contract. No imports to inherit, no shared files. This sprint is fully independent.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` consulted for this micro-sprint; the contract's `nonGoals`/`assumptions` ARE the binding spec. Key binding rules:
- Do NOT remove other exports from the touched files (contract nonGoals).
- Do NOT touch the 3 false positives.
- Do NOT change behavior of any retained function; do NOT touch `dist/` or `.gitignore`.

### Architecture Decisions
No ADR governs dead-code removal. N/A.

### Build/lint config (load-bearing)
- `package.json`: `"build": "tsc"`, `"typecheck": "tsc --noEmit"`, `"lint": "eslint src/"`.
- `tsconfig.json:19-20`: `noUnusedLocals`/`noUnusedParameters` true.
- `eslint.config.js:34-36`: `@typescript-eslint/no-unused-vars` = error.

---

## 6. Testing Patterns

### Unit Test Pattern (for context — NO test changes needed this sprint)
**Source:** `src/orchestrator/code-reviewer-agent.test.ts:44` and `src/orchestrator/documenter-agent.test.ts:41`
```ts
readOutline: vi.fn().mockRejectedValue(new Error("no outline")),
```
**Runner:** vitest. **Assertion style:** `expect`. **Mock approach:** `vi.fn()` / `vi.mock`. **File naming:** `<name>.test.ts`, **co-located** next to source.

**IMPORTANT:** These two test files reference `readOutline` (which SURVIVES). They must remain green and must NOT be edited. Neither references `stashAndRestore` nor `saveOutline`. No test in the repo references the two deleted symbols (grep-verified), so there are **zero test edits/deletions** in this sprint.

### E2E Test Pattern
Not applicable to this sprint.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/utils/index.ts` | `stashAndRestore` re-export | low | Remove line 8 only; keep the other 6 git exports. |
| `src/state/index.ts` | `saveOutline` re-export | low | Remove line 44 only; keep `readOutline`. |
| `src/state/outline-state.ts` | self (imports `writeFile`, `ensureDir`) | **medium** | After deleting saveOutline, prune `writeFile` + `ensureDir` or build/lint FAIL. |
| `src/index.ts` | re-exports from state/utils barrels | low | Does NOT import stashAndRestore or saveOutline (grep clean). It DOES re-export `readBriefing` (`:153`) — must stay untouched. |
| `src/orchestrator/pipeline.ts:58,828` | `readOutline` (sibling) | low | Unaffected — readOutline is retained. Verify still imports/works. |

### Existing Tests That Must Still Pass
- `src/orchestrator/code-reviewer-agent.test.ts` — mocks `readOutline` (`:44`); unaffected, must stay green.
- `src/orchestrator/documenter-agent.test.ts` — mocks `readOutline` (`:41`); unaffected, must stay green.
- No test references `stashAndRestore` or `saveOutline` (grep-verified). Nothing to delete.

### False-Positive Guard — VERIFIED LIVE, MUST NOT BE TOUCHED
- `runPlanAnswerInteractive` — defined `src/cli/commands/plan.ts:307`, imported `src/cli/index.ts:16`, **called `src/cli/index.ts:152`**. LIVE.
- `summarizeSprint` — defined `src/orchestrator/context-handoff.ts:68`, **called `src/orchestrator/context-handoff.ts:171`**. LIVE (intra-file).
- `readBriefing` — defined `src/state/briefing-state.ts:35`, re-exported `src/state/index.ts:58`, **public API `src/index.ts:153`**. LIVE.
- `readOutline` — defined `src/state/outline-state.ts:44`, **called `src/orchestrator/pipeline.ts:828`**. LIVE (this is the sibling of saveOutline IN THE SAME FILE — do not delete the file).

### Recommended Regression Checks (run after implementation)
1. `grep -rnE '\b(stashAndRestore|saveOutline)\b' src/` → MUST return **zero** matches (sc-3-3).
2. `grep -rnE '\breadOutline\b' src/state/index.ts` → must still match (sibling export preserved).
3. `grep -n 'readBriefing' src/index.ts` → must still match (public API intact, sc-3-4).
4. `git diff --name-only` → must be confined to exactly: `src/utils/git.ts`, `src/utils/index.ts`, `src/state/outline-state.ts`, `src/state/index.ts`. MUST NOT include `src/cli/commands/plan.ts`, `src/orchestrator/context-handoff.ts`, `src/state/briefing-state.ts`, or `src/index.ts`.
5. `npm run build` and `npm run typecheck` → zero errors (catches leftover unused `writeFile`/`ensureDir` via `noUnusedLocals`).
6. `npm run lint` → zero errors (catches the same via `@typescript-eslint/no-unused-vars`).
7. `npx vitest run` → green except the 6 known cockpit-integration MCP failures (pre-existing, not a regression).

---

## 8. Implementation Sequence

1. **src/utils/git.ts** — delete lines 149-171 (doc comment + `stashAndRestore`). No import changes (`execa` and `hasUncommittedChanges` both stay).
   - Verify: `grep -n stashAndRestore src/utils/git.ts` → empty. File still ends cleanly after `isClean`.
2. **src/utils/index.ts** — delete the `stashAndRestore,` line (:8). Keep the other 6 names incl. `hasUncommittedChanges`.
   - Verify: `grep -n stashAndRestore src/utils/index.ts` → empty.
3. **src/state/outline-state.ts** — delete lines 17-37 (doc comment + `saveOutline`); change line 1 to `import { readFile } from "node:fs/promises";`; delete the `import { ensureDir } from "./helpers.js";` line (and tidy the surrounding blank line). Keep `readOutline`, `outlinePath`, `outlinesDir`, `OUTLINES_DIR`.
   - Verify: `grep -nE 'saveOutline|writeFile|ensureDir' src/state/outline-state.ts` → empty; `grep -n readOutline src/state/outline-state.ts` → still matches.
4. **src/state/index.ts** — delete the `saveOutline,` line (:44). Keep `readOutline,`.
   - Verify: `grep -n saveOutline src/state/index.ts` → empty; `readOutline` still present.
5. **Run full verification** — `grep -rnE '\b(stashAndRestore|saveOutline)\b' src/` (zero), then `npm run build`, `npm run typecheck`, `npm run lint`, `npx vitest run` (only the 6 cockpit failures allowed). `git diff --name-only` confined to the 4 target files.
6. **Commit:** `bober(sprint-3): remove verified dead-code orphans stashAndRestore + saveOutline`.

---

## 9. Pitfalls & Warnings

- **DO NOT delete `outline-state.ts` wholesale.** It still exports the LIVE `readOutline` (called at `pipeline.ts:828`). Remove only `saveOutline`. (Contract assumption #4 explicitly warns this.)
- **MUST prune `writeFile` and `ensureDir` imports in outline-state.ts.** They are used solely by `saveOutline`. Leaving them triggers BOTH `tsc` (`noUnusedLocals: true`, `tsconfig.json:19`) and eslint (`no-unused-vars: error`, `eslint.config.js:34`). This is the single most likely cause of a failed iteration — `readFile` and `join` STAY.
- **DO NOT remove `hasUncommittedChanges` from git.ts or its barrel line.** It is a sibling public export; its only in-file caller is the deleted fn, but it must survive. git.ts needs NO import edits.
- **Keep `readBriefing` at `src/index.ts:153` and the `summarizeSprint`/`runPlanAnswerInteractive` definitions untouched.** sc-3-4 fails if `git diff --name-only` includes plan.ts, context-handoff.ts, briefing-state.ts, or if `readBriefing` disappears from src/index.ts.
- **Barrel + source must both change for each symbol** — deleting only the function leaves a broken barrel re-export (build fails: re-exporting a non-existent name); deleting only the barrel line leaves the symbol matched by the sc-3-3 grep. Do both, per symbol.
- **No test files to touch** — grep confirms no `*.test.ts` references the two symbols, and neither `git.test.ts` nor `outline-state.test.ts` exists. Do not invent or delete a test file.
- **Do not touch `dist/`** — `build` regenerates it; the diff should be source-only.
