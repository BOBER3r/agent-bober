# Sprint Briefing: Canonical panel reference, lensVerdicts schema field, and drift gate

**Contract:** sprint-spec-20260604-native-lens-panel-1
**Generated:** 2026-06-04T00:00:00Z

---

## 0. TL;DR for the Generator

Four files, zero runtime behavior change:
1. **CREATE** `skills/shared/lens-panel.md` — canonical reference embedding the 4 verbatim lens fragments + protocol prose. (`skills/` exists; `skills/shared/` does NOT — create the dir.)
2. **MODIFY** `src/contracts/eval-result.ts` — add one optional `lensVerdicts` field to `EvalResultSchema` after line 74.
3. **CREATE** `src/contracts/eval-result.test.ts` — parse test for with/without lensVerdicts (file does NOT exist yet).
4. **CREATE** `src/orchestrator/lens-panel-parity.test.ts` — drift gate reading the markdown and asserting each `resolveLensFocus(lens)` string is present.

**The drift-gate file-read idiom to use:** `await readFile(new URL("../../skills/shared/lens-panel.md", import.meta.url), "utf-8")`. This is the repo's established idiom for reading a committed file relative to the test's own location (see Section 6).

---

## 1. Target Files

### `skills/shared/lens-panel.md` (create)

**Directory pattern:** `skills/` currently holds only `bober.*` skill dirs (verified via `ls skills/`). There is NO `skills/shared/` dir yet — the Generator must create it. Per contract assumption, `skills/shared/` is NOT a `bober.*` dir so `scripts/update-all.mjs` / `init.ts` will never emit it as a command — safe neutral home.

**Most similar existing file:** No exact structural twin (this is prose documentation, not a SKILL.md). Treat it as a standalone Markdown reference. Keep it markdownlint-clean (repo enforces `.markdownlint.json`; see Section 9).

**Content requirements (C1 + generatorNotes STEP 1):**

The file MUST embed, **verbatim**, the four fragment strings returned by `resolveLensFocus(...)`. The EXACT strings (copy character-for-character from `src/orchestrator/eval-lenses.ts:5-12`) are reproduced in Section 2 below. Each fragment block must be PREFIXED with its lens name (e.g. a "Lens focus fragments" section with one quoted/fenced block per lens).

It must then document, in prose (NOT by calling reconcile()):
- **(a) SPLIT fan-out:** orchestrator spawns ONE evaluator in deterministic mode (runs build/test/lint/typecheck ONCE) and N evaluators in qualitative mode (one per configured lens, each judging the contract's success criteria through its lens focus, WITHOUT re-running the strategy suite).
- **(b) Reconciliation:** majority vote over lens verdicts, `passed = passCount > failCount` (strict majority, FAIL-CLOSED on tie), mirroring `src/orchestrator/workflow/reconciler.ts`.
- **(c) Combine:** `final.passed = deterministic.passed && reconciled.passed`.
- **(d) Output:** orchestrator writes a `lensVerdicts` array `[{ lens, passed, summary }]` into the saved eval-result JSON and sets `evaluator='panel'`.

---

### `src/contracts/eval-result.ts` (modify)

**Relevant section — `EvalResultSchema`, lines 60-76:**
```ts
export const EvalResultSchema = z.object({
  evaluator: z.string().min(1),
  passed: z.boolean(),
  score: z.number().min(0).max(100).optional(),
  details: z.array(EvalDetailSchema),
  summary: z.string(),
  feedback: z.string(),
  timestamp: z.string().datetime(),
  // Enriched fields (optional, populated by agent evaluator)
  iteration: z.number().int().min(1).optional(),
  contractId: z.string().optional(),
  criteriaResults: z.array(CriterionResultSchema).optional(),
  regressions: z.array(RegressionSchema).optional(),
  designScore: z.number().min(0).max(100).optional(),
  generatorFeedback: z.array(GeneratorFeedbackItemSchema).optional(), // ← line 74
});
export type EvalResult = z.infer<typeof EvalResultSchema>;
```

**EXACT change (STEP 2 / C2):** insert ONE new line immediately after line 74 (`generatorFeedback: ...`), inside the enriched-fields block, BEFORE the closing `});`. Do not reorder existing fields:
```ts
  lensVerdicts: z
    .array(z.object({ lens: z.string(), passed: z.boolean(), summary: z.string() }))
    .optional(),
```
(A single-line form is also fine; match the file's prettier width. The contract's canonical shape is `z.array(z.object({ lens: z.string(), passed: z.boolean(), summary: z.string() })).optional()`.)

**Imports this file uses:** `import { z } from "zod";` (line 1) — no new import needed.

**Imported by (verified — these consume `EvalResult`/`EvalResultSchema` and must keep compiling):**
- `src/orchestrator/workflow/reconciler.ts:1` — `import type { EvalResult, EvalDetail }`
- `src/orchestrator/workflow/reconciler.test.ts:3` and `reconcile-conformance.test.ts:4` — import `EvalResultSchema` / `EvalResult`
- (additive optional field is backward-compatible; these are low risk — see Section 7.)

**Test file:** `src/contracts/eval-result.test.ts` — **does NOT exist** (verified). Generator creates it (STEP 3).

---

### `src/contracts/eval-result.test.ts` (create)

**Most similar existing file:** `src/config/schema.test.ts` (a sibling Zod-schema parse test). Mirror its `describe/it/expect` + `.parse(...)` structure (see Section 6).

A valid minimal `EvalResult` object for the parse test (every required field present, derived from `EvalResultSchema` lines 60-67):
```ts
const base = {
  evaluator: "panel",
  passed: true,
  details: [],
  summary: "ok",
  feedback: "",
  timestamp: "2026-01-01T00:00:00.000Z", // must satisfy z.string().datetime()
};
```
Note: `timestamp` uses `z.string().datetime()` — it MUST be a valid ISO-8601 datetime (the `.000Z` form above is what `reconciler.test.ts:6` uses as a sentinel).

---

### `src/orchestrator/lens-panel-parity.test.ts` (create)

**Most similar existing file:** `src/orchestrator/workflow/reconcile-conformance.test.ts` (a drift/parity gate that imports a live symbol and asserts agreement with a committed artifact). For the file-read idiom, mirror `src/graph/onboarding-composer-markdown.test.ts:88` / `onboarding-composer.test.ts:40-43`.

**Structure template:**
```ts
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolveLensFocus } from "./eval-lenses.js";

// ── Lens-panel drift gate ──────────────────────────────────────────

const BUILT_IN_LENSES = ["correctness", "security", "regression", "quality"] as const;

describe("lens-panel.md drift gate", () => {
  it("embeds every resolveLensFocus fragment verbatim", async () => {
    const md = await readFile(
      new URL("../../skills/shared/lens-panel.md", import.meta.url),
      "utf-8",
    );
    for (const lens of BUILT_IN_LENSES) {
      expect(md).toContain(resolveLensFocus(lens));
    }
  });
});
```
**Path math:** test lives at `src/orchestrator/`; repo root is `../../` from there; target is `../../skills/shared/lens-panel.md` (verified).

---

## 2. The Four Verbatim Fragments — COPY EXACTLY

Source: `src/orchestrator/eval-lenses.ts:4-13` (the `LENS_CATALOG` literal). These MUST appear verbatim in `skills/shared/lens-panel.md`, or the drift gate goes red.

**correctness** (`eval-lenses.ts:5-6`):
```
Focus on whether the implementation actually satisfies each success criterion verbatim. Check that all required behaviours exist, all edge cases are handled, and the contract's definitionOfDone is met.
```

**security** (`eval-lenses.ts:7-8`):
```
Focus on injection vulnerabilities, authentication and authorisation gaps, secret handling, unsafe input validation, and any path traversal or privilege escalation risks.
```

**regression** (`eval-lenses.ts:9-10`):
```
Focus on whether previously working behaviour still works after the changes. Verify that pre-existing tests pass, that no public API or config interface was broken, and that the sprint diff does not silently remove functionality.
```

**quality** (`eval-lenses.ts:11-12`):
```
Focus on principles violations, dead code, misleading naming, smells, duplicated logic, and whether the implementation follows the project's established patterns and conventions.
```

**CRITICAL:** Note British spellings ("behaviours", "authorisation") and the apostrophes in "contract's" / "project's". Copy character-for-character. The drift gate compares the LIVE `resolveLensFocus(lens)` output against the markdown via `toContain` — any divergence (added/removed char) fails the test.

---

## 3. Accessor Facts — resolveLensFocus / LENS_CATALOG

Verified in `src/orchestrator/eval-lenses.ts`:
- `resolveLensFocus` IS exported: `export function resolveLensFocus(lens: string): string` (line 22).
- `LENS_CATALOG` is NOT exported: `const LENS_CATALOG: Record<string, string> = {` (line 4) — module-private.
- Therefore the drift gate MUST use `resolveLensFocus(lens)` as the accessor (no new export needed; do NOT modify eval-lenses.ts — contract nonGoal).
- `resolveLensFocus` never throws: returns `LENS_CATALOG[lens] ?? \`Evaluate specifically through the '${lens}' lens.\`` (lines 23-25).
- Import specifier from the orchestrator test: `import { resolveLensFocus } from "./eval-lenses.js"` (same dir; ESM `.js` specifier).

---

## 4. Reconciler semantics the markdown must DESCRIBE (in prose only)

Source: `src/orchestrator/workflow/reconciler.ts` — `reconcile(_sprintId, _round, lensVerdicts: EvalResult[], timestamp): EvalResult`. The markdown documents these in prose; it does NOT call reconcile().

- Empty `lensVerdicts` → throws `"reconcile: lensVerdicts must be non-empty"` (lines 23-25).
- `passed = passCount > failCount` — strict majority, **fail-closed on tie** (lines 30-40).
- `details` = union of all FAILING details, de-duped by `(criterion, message)` key (lines 43-56).
- `feedback` = failing lenses' feedback joined with `\n`, else `"All lenses passed."` (lines 62-68).
- `summary` = `` `Panel verdict: ${passCount}/${n} lenses passed` `` (line 59).
- `score` = `Math.round((100 * passCount) / n)` (line 71).
- `evaluator = "panel"` (line 74); `timestamp` echoed verbatim from the arg (no `Date.now`/`new Date` — pure, per ADR-4 header comment lines 6-8).

---

## 5. Patterns to Follow

### Pattern: Zod schema parse test (mirror for STEP 3)
**Source:** `src/config/schema.test.ts:1-32`
```ts
import { describe, it, expect } from "vitest";
import { EvaluatorSectionSchema } from "./schema.js";

describe("EvaluatorSectionSchema.panel", () => {
  it("accepts a fully-specified enabled panel", () => {
    const parsed = EvaluatorSectionSchema.parse({ strategies: [], panel: { enabled: true, lenses: ["correctness", "security"], maxConcurrent: 2 } });
    expect(parsed.panel.enabled).toBe(true);
  });
});
```
**Rule:** use `vitest` `{ describe, it, expect }`, import the schema with a `.js` specifier, assert via `Schema.parse(...)` and `expect(...).toEqual/toBe`. For the "rejects" case, wrap in a thunk: `expect(() => Schema.parse(bad)).toThrow()`.

### Pattern: Drift/parity gate comparing live code to a committed artifact
**Source:** `src/orchestrator/workflow/reconcile-conformance.test.ts:15-24`
```ts
describe("reconcile twin/port conformance (ADR-4 drift gate)", () => {
  for (const vector of vectors as LensVector[]) {
    it(`twin and port agree for "${vector.name}"`, () => {
      const tsOut = tsReconcile("s", 1, vector.lensVerdicts, TS);
      expect(jsOut).toEqual(tsOut);
    });
  }
});
```
**Rule:** import the live symbol, derive the expected value from it at test time, and assert the committed artifact matches — so editing the source without updating the artifact turns the test red (this is exactly the "teeth" the evaluator will verify).

### Pattern: Unicode box-drawing section headers
**Source:** `src/contracts/eval-result.ts:3,8,20,58` and `src/orchestrator/eval-lenses.ts:1,15`
```ts
// ── Section name ────────────────────────────────────────────────────
```
**Rule:** organize the new test files with `// ── ... ──` headers (mandated by `.bober/principles.md:32`).

### Pattern: `import type` for type-only imports
**Source:** `src/orchestrator/workflow/reconciler.ts:1`
```ts
import type { EvalResult, EvalDetail } from "../../contracts/eval-result.js";
```
**Rule:** ESLint `consistent-type-imports` is enforced (principles.md:35). If the schema test references the `EvalResult` type, import it with `import type`.

---

## 6. File-read idiom for committed repo files (the load-bearing decision)

The repo has TWO idioms in test files; for reading a COMMITTED file relative to the test's own location, the established form is `new URL(..., import.meta.url)`:

**Primary idiom to use (mirror this):** `src/graph/onboarding-composer-markdown.test.ts:88`
```ts
const configPath = join(new URL("../../.markdownlint.json", import.meta.url).pathname);
```
And `src/graph/onboarding-composer.test.ts:40-43`:
```ts
const src = await readFile(
  join(import.meta.dirname ?? process.cwd(), "onboarding-composer.ts"),
  "utf-8",
);
```

**For the drift gate use:**
```ts
const md = await readFile(new URL("../../skills/shared/lens-panel.md", import.meta.url), "utf-8");
```
`readFile` accepts a `URL` directly (no `.pathname`/`join` needed). This resolves relative to the COMPILED test file location. NOTE: the build compiles `src/**` to `dist/**` but vitest runs the TS source directly, so `import.meta.url` points at `src/orchestrator/lens-panel-parity.test.ts` and `../../` correctly reaches the repo root. (The scanner tests at `src/discovery/scanner.test.ts:28` use `process.cwd()` instead — that also works since vitest runs from repo root — but prefer the `import.meta.url` form to match the markdown-reading siblings.)

**Async-only fs:** principles.md:42 forbids `readFileSync`. Use `import { readFile } from "node:fs/promises"`.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/orchestrator/workflow/reconciler.ts` | `EvalResult` type (line 1) | low | Additive optional field — type still satisfied; reconcile() does NOT need to populate it (out of scope). |
| `src/orchestrator/workflow/reconciler.test.ts` | `EvalResultSchema`, `EvalResult` | low | Existing objects omit `lensVerdicts` → still parse (field is optional). |
| `src/orchestrator/workflow/reconcile-conformance.test.ts` | `EvalResultSchema` (line 4), `lens-vectors.json` | low | `EvalResultSchema.safeParse(jsOut)` still succeeds — adding an optional field cannot reject previously-valid objects. |
| `src/contracts/index.ts` | re-exports eval-result | low | Barrel re-export unaffected by an added field. |
| `.claude/workflows/lib/reconcile.js` (JS port) | shape-compatible with EvalResult | none | Not imported by eval-result.ts; not touched. The optional field does not affect the port (it never emits lensVerdicts). |

### Existing Tests That Must Still Pass
- `src/orchestrator/workflow/reconciler.test.ts` — exercises reconcile() majority/fail-closed; uses EvalResult objects without lensVerdicts → must still parse and behave identically.
- `src/orchestrator/workflow/reconcile-conformance.test.ts` — asserts `EvalResultSchema.safeParse(jsOut).success === true`; an added optional field cannot break this.
- `src/config/schema.test.ts` — the `EvaluatorSectionSchema.panel` tests (panel config already exists); untouched by this sprint but in the same feature area — verify still green.

### Features That Could Be Affected
- **Workflow engine / reconciler (already built on this branch, commits 5dc7a5e / 1560050):** shares `EvalResult` shape and `eval-lenses.ts`. Verify reconcile semantics & schema parse remain green. This sprint is additive-only and must NOT modify `eval-lenses.ts` or `reconciler.ts` (contract nonGoals).

### Recommended Regression Checks
1. `npx tsc --noEmit` → exit 0.
2. `npm run build` → exit 0.
3. `npx eslint src/` → exit 0 (watch `consistent-type-imports`).
4. `npx vitest run` → green, tolerating ONLY the pre-existing skipped baseline (e.g. markdownlint `it.skipIf`).
5. `git diff --name-only` → confirm ONLY the four target files changed; no SKILL.md / `.claude/agents/*` / `agents/*.md` touched.
6. Teeth check: confirm that mutating a fragment in `eval-lenses.ts` (without updating the md) would make `lens-panel-parity.test.ts` red (it must, because it compares live `resolveLensFocus(lens)` output via `toContain`).

---

## 8. Implementation Sequence (dependency-ordered)

1. **`skills/shared/lens-panel.md`** (create) — mkdir `skills/shared/`, write the reference embedding the four verbatim fragments (Section 2) PREFIXED by lens name, plus the split fan-out / majority-vote-fail-closed / combine / lensVerdicts-output prose (Section 4).
   - Verify: file exists; each fragment string from Section 2 appears character-for-character; markdownlint-clean.
2. **`src/contracts/eval-result.ts`** (modify) — add the optional `lensVerdicts` field after line 74 inside `EvalResultSchema`; do not reorder.
   - Verify: `npx tsc --noEmit` clean; `EvalResult` type now includes optional `lensVerdicts`.
3. **`src/contracts/eval-result.test.ts`** (create) — mirror `src/config/schema.test.ts`; assert (a) base object WITHOUT lensVerdicts parses and `parsed.lensVerdicts === undefined`; (b) a 2-entry lensVerdicts array parses and round-trips (`toEqual`).
   - Verify: `npx vitest run src/contracts/eval-result.test.ts` green.
4. **`src/orchestrator/lens-panel-parity.test.ts`** (create) — drift gate per Section 1 template; read md via `new URL("../../skills/shared/lens-panel.md", import.meta.url)`; loop the four built-in lenses asserting `expect(md).toContain(resolveLensFocus(lens))`.
   - Verify: `npx vitest run src/orchestrator/lens-panel-parity.test.ts` green; mentally confirm teeth.
5. **Run full verification** — `npx tsc --noEmit`, `npm run build`, `npx eslint src/`, `npx vitest run` (all exit 0 / green beyond skipped baseline).

---

## 9. Pitfalls & Warnings

- **Verbatim is literal.** British spellings (behaviours, authorisation) and apostrophes (contract's, project's) MUST be copied exactly into the md or the drift gate fails. Do not "fix" spelling. Source: `eval-lenses.ts:5-12`.
- **Do NOT export LENS_CATALOG or modify eval-lenses.ts** — contract nonGoal. The drift gate uses the existing `resolveLensFocus` export only.
- **Do NOT call reconcile() in the markdown** — the md only DESCRIBES the semantics in prose.
- **`skills/shared/` does not exist** — create the directory. Do NOT place the md under any `bober.*` skill dir (that's sprint 3).
- **No `git add -A` / `git add .`** — working tree has unrelated pre-existing uncommitted changes (see git status). Stage ONLY the four files with explicit paths. Branch is NOT main.
- **Async fs only** — use `node:fs/promises` `readFile`; `readFileSync` is forbidden (principles.md:42).
- **`consistent-type-imports`** — use `import type` for the `EvalResult` type if referenced in tests.
- **Markdownlint:** the repo has `.markdownlint.json` and a markdownlint compliance test exists (`onboarding-composer-markdown.test.ts`). It targets temp dirs, not `skills/shared/`, so it will NOT lint your new md — but keep the md tidy (single H1, blank lines around fences/headings) to avoid surprises.
- **`timestamp` is `z.string().datetime()`** — the schema-test fixture must use a valid ISO datetime (`"2026-01-01T00:00:00.000Z"`), not an arbitrary string.
- **Do not add evaluator.panel config** — it already exists (`EvaluatorSectionSchema.panel`, tested in `schema.test.ts`). Contract nonGoal.

