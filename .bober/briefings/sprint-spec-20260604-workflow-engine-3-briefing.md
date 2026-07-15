# Sprint Briefing: Pure-JS reducer port and twin/port drift gate

**Contract:** sprint-spec-20260604-workflow-engine-3
**Generated:** 2026-06-04T00:00:00Z

---

## 0. The One Thing That Matters

This sprint is a **transcription + parity** task, not a design task. You hand-copy the
algorithm in `src/orchestrator/workflow/reconciler.ts` into a pure-JS file at
`.claude/workflows/lib/reconcile.js`, **byte-for-byte in behavior**, then write a
conformance test that runs both through shared fixtures and asserts `toEqual`.

If you change ONE character of the algorithm (a separator, a join string, a rounding
formula, the object field order), the conformance test trips. That is the gate working.
Mirror the twin EXACTLY.

---

## 1. Target Files

### `.claude/workflows/lib/reconcile.js` (create)

**Directory pattern:** `.claude/workflows/` does NOT yet exist — you create the full path
`.claude/workflows/lib/`. (`.claude/` currently holds only `agents/`, `commands/`,
`settings.local.json` — confirmed via `ls -la .claude/`.) This is intentional: the file
lives OUTSIDE `src/`, so it is outside tsc's `rootDir` and outside ESLint's `files` glob
(see §5 and §7).

**Most similar existing file:** `src/orchestrator/workflow/reconciler.ts` — the TS twin.
You are porting it. There is no other `.js` module in the project to copy structurally,
so model the JS file on the twin with all TypeScript syntax stripped.

**Authoritative algorithm — transcribe EXACTLY (source: `src/orchestrator/workflow/reconciler.ts:17-82`):**

1. **Signature:** `reconcile(_sprintId, _round, lensVerdicts, timestamp)` — 4 params.
   `_sprintId` and `_round` are accepted but UNUSED (underscore-prefixed in the twin at
   lines 18-19). In the JS port keep them as params; do NOT prefix-strip semantics — they
   must be positional args 1 and 2 so the conformance test calls
   `reconcile("s", 1, vectors, ts)` identically on both.
2. **Empty guard (lines 23-25):** `if (lensVerdicts.length === 0)` →
   `throw new Error("reconcile: lensVerdicts must be non-empty");` — EXACT message string.
3. **n (line 27):** `const n = lensVerdicts.length;`
4. **passCount (lines 30-35):** loop; increment only when `lens.passed === true` (strict
   `=== true`, not truthy).
5. **failCount (line 37):** `const failCount = n - passCount;`
6. **passed (line 40):** `const passed = passCount > failCount;` — strict majority,
   **fail-closed on tie** (a 2v2 tie yields `passed = false`).
7. **Details union (lines 43-56):** `const seenKeys = new Set();` and `const details = [];`.
   For each `lens`, for each `detail` in `lens.details`, **only if `detail.passed === false`**:
   build `const key = ` + the template literal `` `${detail.criterion}␟${detail.message}` ``.
   **The separator is U+241F (SYMBOL FOR UNIT SEPARATOR, the glyph `␟`)** — line 49, between
   `criterion` and `message`. Copy this exact character; do NOT substitute a plain ``
   or a pipe. If `!seenKeys.has(key)` then `seenKeys.add(key)` and `details.push(detail)`
   (pushes the original detail object, preserving insertion order — first occurrence wins).
8. **summary (line 59):** the template literal `` `Panel verdict: ${passCount}/${n} lenses passed` ``
   — exact wording, no trailing period, slash between passCount and n.
9. **feedback (lines 62-68):** `const feedbackParts = [];` loop over lenses; push
   `lens.feedback` ONLY when `!lens.passed && lens.feedback` (failing lens AND truthy
   feedback string). Then
   `const feedback = feedbackParts.length > 0 ? feedbackParts.join("\n") : "All lenses passed.";`
   — newline join (`"\n"`), fallback string `"All lenses passed."` (with the period).
10. **score (line 71):** `const score = Math.round((100 * passCount) / n);` — exact formula,
    multiply-then-divide-then-round.
11. **Return object — FIELD ORDER MATTERS for byte-identity (lines 73-81):**
    `{ evaluator: "panel", passed, score, details, summary, feedback, timestamp }`
    in EXACTLY that key order. `evaluator` is the literal string `"panel"`. `timestamp` is
    the injected arg echoed verbatim. (`toEqual` is order-insensitive for objects, but keep
    the order anyway so the two files read identically and future diffs are trivial.)

**Purity constraints (success criterion C1, evaluatorNotes):** NO `Date.now`, NO `new Date`,
NO `Math.random`, NO `fs`/`require`/`import` of Node builtins, NO TypeScript syntax (no type
annotations, no `: EvalResult`, no `import type`). Pure ESM: a single
`export function reconcile(...) { ... }`. `Math.round` and `Set` are pure JS built-ins and
are allowed (the twin uses both).

**ESM note:** the file must be valid ES module syntax. The package is `"type": "module"`
(`package.json:5`), and a `.js` file is treated as ESM. Use `export function`, not
`module.exports`.

---

### `src/orchestrator/workflow/__fixtures__/lens-vectors.json` (create)

**Directory pattern:** No `__fixtures__` directory exists anywhere in `src/` yet (confirmed
`find src -type d -name __fixtures__` → empty). You create
`src/orchestrator/workflow/__fixtures__/`. Living under `src/` is fine: `.json` is excluded
from tsc compilation behavior (see §5) but importable.

**Shape (contract C2 + generatorNotes):** a JSON array of objects, each
`{ "name": string, "lensVerdicts": EvalResult[] }`. Each element of `lensVerdicts` must be a
**minimal valid `EvalResult`** (see §3 for the schema). The conformance test feeds
`vector.lensVerdicts` into both reconcilers.

**Minimal valid EvalResult for a fixture lens** (derived from `reconciler.test.ts:10-20`
`lens()` helper and `EvalResultSchema` at `src/contracts/eval-result.ts:60-75`):
```json
{
  "evaluator": "lens-a",
  "passed": true,
  "details": [],
  "summary": "ok",
  "feedback": "",
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```
- `evaluator`: non-empty string (`z.string().min(1)`).
- `passed`: boolean — this is what the reducer counts.
- `details`: array of `EvalDetail`; for failing-detail vectors use
  `{ "criterion": "c1", "passed": false, "message": "broken", "severity": "error" }`
  (`criterion` min length 1, `severity` ∈ `error|warning|info`).
- `summary`: any string. `feedback`: any string (use a distinct value like `"issue A"` on
  failing lenses so the feedback-join assertion has signal).
- `timestamp`: must be `z.string().datetime()` valid — use the sentinel
  `"2026-01-01T00:00:00.000Z"` for every fixture lens. (NOTE: the input lens timestamps are
  irrelevant to the reducer output — only the injected arg is echoed — but they must be
  schema-valid because the conformance test schema-validates inputs is NOT required; still
  keep them valid for cleanliness.)

**Required fixture vectors (contract C2 + Instruction 6) — use these exact 7 names+compositions:**
| name | lensVerdicts composition |
|------|--------------------------|
| `single-lens-pass` | 1 passing lens |
| `unanimous-pass` | 3 passing |
| `unanimous-fail` | 3 failing |
| `majority-pass` | 3 passing + 2 failing (5 total) |
| `majority-fail` | 2 passing + 3 failing (5 total) |
| `tie` | 2 passing + 2 failing (4 total) |
| `empty-detail` | ≥2 lenses all with `"details": []` (mix pass/fail; verifies output `details=[]`) |

Recommended extra (not required, strengthens the gate — covers the dedup separator and
detail-union path which the 7 above leave untested):
| `failing-details-dedup` | 2 failing lenses sharing one `{criterion,message}` detail + 1 unique → output details length 2 |

Add `failing-details-dedup` only if you also want to exercise the `␟` key path through the
conformance gate (recommended, since that separator is the most drift-prone line). Give
failing lenses non-empty `feedback` so `majority-fail`/`unanimous-fail`/`tie` also exercise
the feedback-join branch.

---

### `src/orchestrator/workflow/reconcile-conformance.test.ts` (create)

**Most similar existing file:** `src/orchestrator/workflow/reconciler.test.ts` — same dir,
same Vitest `describe`/`it`/`expect` style, same sentinel constant. Model imports + structure
on it.

**Structure template (mirrors `reconciler.test.ts:1-7` import + sentinel convention):**
```ts
import { describe, it, expect } from "vitest";
import { reconcile as tsReconcile } from "./reconciler.js";
import { reconcile as jsReconcile } from "../../../.claude/workflows/lib/reconcile.js";
import { EvalResultSchema } from "../../contracts/eval-result.js";
import type { EvalResult } from "../../contracts/eval-result.js";
import vectors from "./__fixtures__/lens-vectors.json" with { type: "json" };

const TS = "2026-01-01T00:00:00.000Z"; // sentinel timestamp (matches reconciler.test.ts:6)

interface LensVector {
  name: string;
  lensVerdicts: EvalResult[];
}

describe("reconcile twin/port conformance (ADR-4 drift gate)", () => {
  for (const vector of vectors as LensVector[]) {
    it(`twin and port agree for "${vector.name}"`, () => {
      const tsOut = tsReconcile("s", 1, vector.lensVerdicts, TS);
      const jsOut = jsReconcile("s", 1, vector.lensVerdicts, TS);
      expect(jsOut).toEqual(tsOut);                       // C3 byte-identity
      expect(EvalResultSchema.safeParse(jsOut).success).toBe(true); // C4 schema-valid port
    });
  }
});
```

**Import-path notes (verified — see §5/§7 for the why):**
- Test file is at `src/orchestrator/workflow/reconcile-conformance.test.ts`. To reach
  `.claude/workflows/lib/reconcile.js` (repo root) go up THREE levels
  (`workflow/` → `orchestrator/` → `src/`) then one more into root, i.e.
  `../../../.claude/workflows/lib/reconcile.js`. Count: `../` (→orchestrator) `../`
  (→src) `../` (→repo root) `.claude/...`. **Three `../` segments — confirm by counting the
  test's own depth from repo root: `src/orchestrator/workflow/` is 3 dirs deep, so 3 `../`.**
- TS imports of the twin and contracts use the `.js` extension (NodeNext convention — see
  `reconciler.test.ts:2-3`). Keep `.js` on `./reconciler.js` and `../../contracts/eval-result.js`.
- JSON import: use `with { type: "json" }` (NodeNext + Node ≥18 ESM import attributes).
  `resolveJsonModule: true` is set in `tsconfig.json:13`, so tsc accepts a typed default
  import. Vitest (v3) handles JSON imports natively. If `with { type: "json" }` causes any
  parser friction, the fallback is `assert { type: "json" }`, but prefer `with`.

---

## 2. Patterns to Follow

### Pattern: Vitest test structure (describe/it/expect, named-export reconcile)
**Source:** `src/orchestrator/workflow/reconciler.test.ts:1-20`
```ts
import { describe, it, expect } from "vitest";
import { reconcile } from "./reconciler.js";
import { EvalResultSchema } from "../../contracts/eval-result.js";
import type { EvalResult, EvalDetail } from "../../contracts/eval-result.js";

const TS = "2026-01-01T00:00:00.000Z"; // sentinel timestamp
```
**Rule:** Import vitest primitives by name, import the implementation with a `.js`
extension, reuse the `TS = "2026-01-01T00:00:00.000Z"` sentinel for the injected timestamp.

### Pattern: Minimal-valid-EvalResult fixture factory
**Source:** `src/orchestrator/workflow/reconciler.test.ts:10-24`
```ts
function lens(passed: boolean, over: Partial<EvalResult> = {}): EvalResult {
  return {
    evaluator: passed ? "lens-a" : "lens-b",
    passed, details: [], summary: passed ? "ok" : "nope",
    feedback: passed ? "" : "needs work", timestamp: TS, ...over,
  };
}
function failingDetail(criterion: string, message: string): EvalDetail {
  return { criterion, passed: false, message, severity: "error" };
}
```
**Rule:** The fixture JSON objects must match exactly these field shapes. A failing lens
needs a non-empty `feedback` (e.g. `"needs work"`) to drive the feedback-join branch; a
failing detail needs `criterion`, `passed:false`, `message`, `severity:"error"`.

### Pattern: Pure-reducer field-order return object
**Source:** `src/orchestrator/workflow/reconciler.ts:73-81`
```ts
return {
  evaluator: "panel",
  passed, score, details, summary, feedback, timestamp,
};
```
**Rule:** Reproduce this exact object literal (sans TS) in the JS port.

### Pattern: NodeNext `.js`-extension relative imports
**Source:** `src/orchestrator/workflow/reconciler.ts:1` (`from "../../contracts/eval-result.js"`)
and `reconciler.test.ts:2` (`from "./reconciler.js"`).
**Rule:** All relative imports carry the `.js` extension even when the source is `.ts`.
This is mandatory under `moduleResolution: "NodeNext"` (`tsconfig.json:5`).

---

## 3. Existing Utilities / Types — DO NOT Recreate

| Utility / Type | Location | Signature | Purpose |
|----------------|----------|-----------|---------|
| `reconcile` (TS twin) | `src/orchestrator/workflow/reconciler.ts:17` | `(_sprintId: string, _round: number, lensVerdicts: EvalResult[], timestamp: string): EvalResult` | The authoritative reducer. Port mirrors it; conformance test imports it as `tsReconcile`. |
| `EvalResultSchema` | `src/contracts/eval-result.ts:60` | `z.object({...})` | Zod schema; used in test for C4 port-validity check. |
| `EvalResult` (type) | `src/contracts/eval-result.ts:76` | `z.infer<typeof EvalResultSchema>` | Type for fixture lens arrays + reducer return. |
| `EvalDetail` (type) | `src/contracts/eval-result.ts:18` | `z.infer<typeof EvalDetailSchema>` | Type of items in `lens.details`. |
| `EvalDetailSchema` | `src/contracts/eval-result.ts:10` | `z.object({criterion,passed,message,file?,line?,severity})` | Detail shape; informs the fixture detail objects. |
| `SeveritySchema` | `src/contracts/eval-result.ts:5` | `z.enum(["error","warning","info"])` | Valid `severity` values for fixture details. |

**EvalResultSchema field requirements (source `src/contracts/eval-result.ts:60-75`)** — the
JS port output and every fixture lens must satisfy:
- `evaluator`: `z.string().min(1)` (non-empty)
- `passed`: `z.boolean()`
- `score`: `z.number().min(0).max(100).optional()` — port emits it; range 0..100 always holds
  since `Math.round(100*passCount/n)` ∈ [0,100].
- `details`: `z.array(EvalDetailSchema)`
- `summary`: `z.string()`, `feedback`: `z.string()`
- `timestamp`: `z.string().datetime()` — **must be ISO-8601 with `Z`/offset.** The sentinel
  `"2026-01-01T00:00:00.000Z"` is valid; a bare date is NOT.

**Utilities reviewed:** there is no `src/utils/`, `src/lib/`, `src/helpers/`, or `src/shared/`
relevant to this sprint. The only shared code is the `eval-result.ts` contract above and the
TS twin. No JSON-loading helper exists (no `readFileSync`/`JSON.parse` in
`src/orchestrator/workflow/`) — import the fixture JSON directly, do not write a loader.

---

## 4. Prior Sprint Output

### Sprint 1: engine seam + selector
**Created:** `src/orchestrator/workflow/engine.ts` (exports `PipelineEngine` interface,
`PipelineEngineName`), `ts-engine.ts`, `selector.ts`, `eligibility.ts`.
**Connection to this sprint:** NONE directly — do not import or touch these. They establish
the `src/orchestrator/workflow/` package this sprint adds files to.

### Sprint 2: TS twin reconciler
**Created:** `src/orchestrator/workflow/reconciler.ts` — exports
`reconcile(_sprintId, _round, lensVerdicts, timestamp): EvalResult`. Test:
`reconciler.test.ts`.
**Connection to this sprint:** This is the SOURCE OF TRUTH you port to JS and the `tsReconcile`
side of the conformance gate. Read it line-by-line (transcribed in §1). Per contract nonGoals,
**do NOT modify `reconciler.ts`** — if the port diverges, fix the port, not the twin (unless
the twin has a genuine bug, which you then note).

---

## 5. Build / Type-Check Tooling Analysis (THE RISKY PART)

### Vitest (`npm run test` → `vitest`)
- **No `vitest.config.ts` / `vite.config.ts` exists** (confirmed `ls` → no matches; `package.json`
  test script is bare `vitest`). Vitest therefore uses **defaults**: `include` =
  `["**/*.{test,spec}.?(c|m)[jt]s?(x)"]`, scanning the whole repo (minus `node_modules`,
  `dist`). **There is NO `include` restriction that would exclude
  `src/orchestrator/workflow/reconcile-conformance.test.ts`** — it will be picked up
  automatically and run under `npm run test`. (Satisfies C5 "runs as part of npm run test".)
- **Importing `.claude/workflows/lib/reconcile.js` from the test:** vitest resolves ESM `.js`
  relative imports natively; `.claude/` is NOT in any exclude. No `server.deps` /
  `resolve.alias` config exists, so no constraint blocks importing across the `src/` boundary.
  The relative path `../../../.claude/workflows/lib/reconcile.js` resolves from the test's
  on-disk location regardless of `rootDir`.
- **JSON import:** vitest v3 (`package.json:95`) loads JSON imports natively. `with { type: "json" }`
  works.

### TypeScript (`npm run typecheck` → `tsc --noEmit`, and `npm run build` → `tsc`)
- `tsconfig.json`: `rootDir: "src"` (line 8), `include: ["src/**/*"]` (line 25),
  `exclude: ["node_modules","dist","**/*.test.ts"]` (line 26).
- **The `.js` port is OUTSIDE the program:** `.claude/workflows/lib/reconcile.js` is not under
  `src/` and not matched by `include`, so tsc never compiles or type-checks it. `allowJs` is
  NOT set, reinforcing that `.js` files are not part of the program. **`npx tsc --noEmit`
  stays exit 0** w.r.t. the port file itself.
- **Does importing the `.js` port from a `.ts` test force tsc to typecheck it?** The
  conformance test is `*.test.ts`, which is in `tsconfig.json` `exclude` (line 26
  `"**/*.test.ts"`). **tsc never compiles the conformance test at all**, so it never follows
  the import edge to the `.js` port. The twin reconciler's own test is likewise excluded —
  this is the established pattern. ⇒ The cross-boundary import is invisible to `tsc`. RISK
  NEUTRALIZED.
- **`resolveJsonModule: true`** (line 13) + `isolatedModules: true` (line 23): JSON imports in
  `.ts` are allowed by the compiler. Since the only JSON import is inside the (excluded)
  conformance test, tsc won't even see it — but it is safe regardless.
- **Net:** `tsc` only ever compiles non-test `.ts` under `src/`. This sprint adds ZERO non-test
  `.ts` under `src/`. Therefore `npm run typecheck` and `npm run build` are unaffected and stay
  exit 0. (Verify anyway per C5.)

### ESLint (`npm run lint` → `eslint src/`)
- `eslint.config.js` `files: ["src/**/*.ts"]` (line 8) — the lint config block ONLY applies to
  `.ts` under `src/`. **The JS port at `.claude/workflows/lib/reconcile.js` is never linted**
  (not under `src/`, not `.ts`, and `eslint src/` only walks `src/`). No `.claude/` ignore is
  needed.
- The conformance test IS `src/**/*.ts`, so it IS linted. Relevant rules
  (`eslint.config.js:31-40`): `@typescript-eslint/consistent-type-imports` ("error"),
  `@typescript-eslint/no-unused-vars` (error, `_`-prefixed ignored),
  `@typescript-eslint/no-explicit-any` (warn). **To stay green:**
  - Import the `EvalResult` type with `import type { EvalResult }` (NOT a value import) to
    satisfy `consistent-type-imports`. (The twin test does exactly this — `reconciler.test.ts:4`.)
  - Don't leave unused imports. Don't use `any` (use the `LensVector` interface in the
    template).
- **`no-restricted-imports`** (lines 46-63) applies ONLY to `src/telemetry/**` — irrelevant
  here. There is **no `import/no-unresolved` rule and no `eslint-plugin-import`** configured
  (not in devDependencies), so importing a path outside `src/` does NOT trip any unresolved-import
  rule. **You do NOT need any eslint ignore additions.** (Contract allows "at most a minimal
  eslint ignore tweak if strictly required" — it is NOT required; add none.)

**RECOMMENDED IMPORT APPROACH (cleanest, lint+type+test all green, zero config changes):**
In the conformance test, use a plain relative ESM import
`import { reconcile as jsReconcile } from "../../../.claude/workflows/lib/reconcile.js";`
plus `import type { EvalResult }` for types and `import vectors from "./__fixtures__/lens-vectors.json" with { type: "json" };`.
No shim, no eslint ignore, no tsconfig change. The test file is tsc-excluded and ESLint has no
unresolved-import rule, so the cross-boundary `.js` import is clean.

---

## 6. Recommended Fixture Vector List (exact)

Build `lens-vectors.json` as an array with these named entries. P = passing lens
(`"passed": true`, `feedback:""`), F = failing lens (`"passed": false`, distinct
`feedback`). All timestamps = `"2026-01-01T00:00:00.000Z"`.

1. `"single-lens-pass"` — `[P]`  (n=1, passed=true, summary "Panel verdict: 1/1 lenses passed", score 100, feedback "All lenses passed.")
2. `"unanimous-pass"` — `[P,P,P]`  (passed=true, 3/3, score 100)
3. `"unanimous-fail"` — `[F,F,F]`  (passed=false, 0/3, score 0, feedback = the 3 failing feedbacks joined by `\n`)
4. `"majority-pass"` — `[P,P,P,F,F]`  (passed=true, 3/5, score 60)
5. `"majority-fail"` — `[P,P,F,F,F]`  (passed=false, 2/5, score 40)
6. `"tie"` — `[P,P,F,F]`  (passed=false fail-closed, 2/4, score 50)
7. `"empty-detail"` — `[P(details:[]), F(details:[])]`  (output details=[], passed=false 1/2 fail-closed... NOTE: 1P/1F is a tie → passed=false; if you want passed=true here use `[P,P,F]`. Recommend `[P(details:[]),F(details:[])]` to assert details=[] regardless of verdict.)

**Strongly recommended 8th vector to exercise the `␟` dedup key (most drift-prone line):**
8. `"failing-details-dedup"` — two F lenses, lensA `details:[{c1,"same msg"},{c2,"other"}]`,
   lensB `details:[{c1,"same msg"}]` → reconciled `details` length 2, order
   `[{c1,"same msg"},{c2,"other"}]`. This is the only vector that proves the JS port copied
   the U+241F separator and the dedup/order logic correctly.

Give each F lens a DISTINCT `feedback` value (e.g. `"issue A"`, `"issue B"`, `"issue C"`) so
the `\n`-join is non-trivial and a wrong join separator in the port would fail `toEqual`.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| (none) | — | **low** | All three target files are NEW. No existing file imports them. `reconciler.ts` is NOT modified (nonGoal). No production code path consumes the new files this sprint. |

`grep -rn "from .*reconcile"` shows only `reconciler.test.ts` importing `reconciler.js`; the
new conformance test adds a second importer of the twin but does not alter it. Zero blast
radius on existing modules.

### Existing Tests That Must Still Pass
- `src/orchestrator/workflow/reconciler.test.ts` — tests the TS twin directly. NOT touched by
  this sprint; must remain green (it imports `./reconciler.js`, unchanged). If it goes red, you
  accidentally edited the twin — revert.
- `src/orchestrator/workflow/selector.test.ts` — Sprint 1; unrelated; must stay green.
- Whole suite under `npm run test` — the new conformance test is auto-included; ensure it does
  not throw at collection time (e.g. a malformed JSON fixture or an unresolvable import would
  fail the WHOLE vitest run).

### Features That Could Be Affected
- **feat-2 (workflow engine reconciliation)** — this sprint IS feat-2's drift gate. Later
  sprints (sprint 5 `bober-pipeline.js`) will consume `reconcile.js`. Keeping the port
  byte-identical now protects those future sprints. No other current feature shares these files.

### Recommended Regression Checks (run all; all must be exit 0 / green)
1. `npx vitest run src/orchestrator/workflow/reconcile-conformance.test.ts` — every fixture
   shows `toEqual` parity AND `safeParse(...).success === true`.
2. `npx vitest run src/orchestrator/workflow/reconciler.test.ts` — twin tests still pass
   (proves twin untouched).
3. `npm run typecheck` (`tsc --noEmit`) — exit 0 (the `.js` port must NOT be type-checked).
4. `npm run build` (`tsc`) — exit 0, no `.js` port emitted into `dist`.
5. `npm run lint` (`eslint src/`) — exit 0, no new warnings/errors from the conformance test.
6. `npm run test` (full suite) — green except the known-flaky tool-count baseline the
   evaluatorNotes tolerate.
7. Confirm `git diff --name-only` lists ONLY: `.claude/workflows/lib/reconcile.js`,
   `src/orchestrator/workflow/__fixtures__/lens-vectors.json`,
   `src/orchestrator/workflow/reconcile-conformance.test.ts` (stopCondition).
8. **Drift-gate smoke test:** temporarily change one char in `reconcile.js` (e.g. the `␟` to
   `|`) → conformance test MUST fail; revert. (Optional but proves the gate trips.)

---

## 8. Implementation Sequence (dependency-ordered)

1. **`.claude/workflows/lib/reconcile.js`** — create the dir path, hand-port the twin per §1
   (strip all TS syntax; keep algorithm byte-identical). Pure ESM `export function reconcile`.
   - Verify: `node --input-type=module -e "import('./.claude/workflows/lib/reconcile.js').then(m=>console.log(typeof m.reconcile))"` prints `function`; grep the file for `Date`/`Math.random`/`require`/`: ` (type annotations) → none except `Math.round`.
2. **`src/orchestrator/workflow/__fixtures__/lens-vectors.json`** — create the dir + JSON array
   with the 7 (or 8) vectors from §6, each lens a minimal valid `EvalResult`.
   - Verify: `node -e "JSON.parse(require('fs').readFileSync('src/orchestrator/workflow/__fixtures__/lens-vectors.json'))"` parses without error; spot-check compositions (3p/2f etc).
3. **`src/orchestrator/workflow/reconcile-conformance.test.ts`** — write the test from the §1
   template; loop over fixtures, `toEqual` + `safeParse`.
   - Verify: `npx vitest run src/orchestrator/workflow/reconcile-conformance.test.ts` all green.
4. **Run full verification** — `npm run typecheck` && `npm run build` && `npm run lint` &&
   `npm run test` all exit 0 (per §7 checks 1-8). Confirm git diff is confined.

---

## 9. Pitfalls & Warnings

- **The separator is U+241F `␟` (a real glyph), NOT `` and NOT `|`** (`reconciler.ts:49`).
  Copy-paste the exact character from the twin into the JS port. This is the single most
  drift-prone line; the `failing-details-dedup` fixture exists to catch a wrong copy.
- **Do NOT add `allowJs`/`checkJs` to tsconfig or add the `.claude` path to `include`.** Doing
  so would pull the `.js` port into the tsc program and break the "port is outside type-check"
  guarantee (success criterion C5 / Instruction 5). The whole point is the port stays
  un-type-checked.
- **Do NOT add an eslint ignore for `.claude/`.** It is unnecessary (`eslint src/` never walks
  `.claude/`) and the contract restricts diffs. There is no `eslint-plugin-import`, so no
  `import/no-unresolved` fires on the cross-boundary import.
- **Use `import type { EvalResult }`** in the conformance test, not a value import — else
  `@typescript-eslint/consistent-type-imports` (error, `eslint.config.js:39`) fails lint.
- **Do NOT modify `src/orchestrator/workflow/reconciler.ts`** (nonGoal). If port and twin
  disagree, the BUG IS IN YOUR PORT — fix the port. Only touch the twin if it has a genuine
  bug, and then NOTE it explicitly.
- **`module.exports` is WRONG** — the package is `"type": "module"`. Use ESM `export function`.
- **Field-order / object shape:** the twin returns `score` always (it's computed, not optional
  at the value level). Your port must also always include `score`. `toEqual` would catch a
  missing `score`, but emit it to match.
- **Fixture timestamps must be `z.string().datetime()`-valid** (`eval-result.ts:67`) — always
  use `"2026-01-01T00:00:00.000Z"`. A bare `"2026-01-01"` would fail schema validation if you
  ever validate inputs.
- **A malformed fixture JSON or an unresolvable import fails the ENTIRE vitest run, not just
  this file** — Vitest has no `include` filter to isolate it. Validate the JSON and the import
  path (count three `../`) before running the full suite.
- **`_sprintId` / `_round` are unused but positional** — keep them as the first two params in
  the JS port so `reconcile("s", 1, vectors, ts)` lines up identically on both sides.
