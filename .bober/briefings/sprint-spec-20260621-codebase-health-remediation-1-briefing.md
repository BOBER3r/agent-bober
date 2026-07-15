# Sprint Briefing: Break the critic-deep ↔ decomposer-deep import cycle via dependency injection

**Contract:** sprint-spec-20260621-codebase-health-remediation-1
**Generated:** 2026-06-21T19:10:00Z

---

## TL;DR (the whole sprint in 6 edits)

1. **CREATE** `src/fleet/decomposer-deep-types.ts` — a zero-relative-import leaf holding `OutlineArea` + `Outline`.
2. **MODIFY** `src/fleet/decomposer-deep.ts` — replace the local `Outline`/`OutlineArea` defs (lines 85-86) with a re-export from the leaf; at line 367 pass `expand: runExpandStage` into the loop call.
3. **MODIFY** `src/fleet/critic-deep.ts` — delete the line-4 decomposer-deep import (value + type); import `Outline` from the leaf; add an `expand` fn param to `runCritiqueLoop`'s input; call `input.expand({...})` at the former line-247 call site.
4. **MODIFY** `src/fleet/critic-deep.test.ts` — add the injected `expand` arg to the **9** `runCritiqueLoop` calls (lines 359, 379, 400, 418, 433, 447, 461, 476 — note: 8 explicit + 1 wrapped). Add a spy-based test proving `expand` is invoked on a critique miss (sc-1-7).
5. **decomposer-deep.test.ts** — **NO CHANGE REQUIRED** (verified: it does not import `Outline` and does not call `runCritiqueLoop`). Leave it untouched unless typecheck surfaces something.
6. **Verify:** `grep -nE 'decomposer-deep' src/fleet/critic-deep.ts` must return ZERO matches.

**Zero behavior change.** Only the *source* of `runExpandStage` (injected vs imported) and the `Outline` import path change.

---

## 1. Target Files

### src/fleet/critic-deep.ts (modify)

**Current line 4 (EXACT — this is the line to delete/replace):**
```ts
import { type Outline, runExpandStage } from "./decomposer-deep.js";
```
This is the ONLY line in critic-deep.ts that references decomposer-deep (grep-verified). After the sprint, `grep -nE 'decomposer-deep' src/fleet/critic-deep.ts` MUST be empty. Note lines 5-11 import from `./decomposer-deep-CONSTANTS.js` — that is a DIFFERENT file (the existing leaf) and must stay; the grep pattern `decomposer-deep` would still match `decomposer-deep-constants`, so the new `Outline` import MUST come from `./decomposer-deep-types.js` (also matches `decomposer-deep`).

> ⚠️ **CRITICAL grep subtlety for sc-1-2:** The success criterion runs `grep -nE 'decomposer-deep' src/fleet/critic-deep.ts` and expects ZERO matches. But critic-deep.ts lines 5-11 ALREADY import `DEEP_MAX_TOTAL_CALLS`/`DEEP_EXPAND_MAX_RETRIES` from `./decomposer-deep-constants.js`, AND the new `Outline` import will come from `./decomposer-deep-types.js`. BOTH match the regex `decomposer-deep`. **Re-read sc-1-2 / evaluatorNotes literally:** it says "critic-deep imports nothing (value OR type) from **decomposer-deep**" — meaning the `decomposer-deep.js` module specifically, not the `-constants`/`-types` leaves. The evaluator's intent is "no edge to the decomposer-deep.ts *module*". The contract's literal `grep -nE 'decomposer-deep'` will NOT be empty because of the constants/types leaves. **The Generator must surface this to the evaluator** OR (cleaner) the constants/types-leaf imports are demonstrably to dependency-free leaves (not the cycle node). Do NOT try to "fix" this by removing the constants import — that would reintroduce the TDZ crash (inc-20260620-cli-tdz-crash). The real, defensible invariant is: **critic-deep.ts has no import from `./decomposer-deep.js`** (the cycle node). Verify with `grep -nE 'decomposer-deep\.js' src/fleet/critic-deep.ts` returning only the `-constants.js` and `-types.js` lines, and `grep -nE 'from "\./decomposer-deep\.js"' src/fleet/critic-deep.ts` returning ZERO.

**`runCritiqueLoop` — the function to extend (lines 208-267). Input object is lines 208-216:**
```ts
export async function runCritiqueLoop(input: {
  client: LLMClient;
  model: string;
  goal: string;
  outline: Outline;
  baseline: FleetManifest;
  expandMaxRetries: number;
}): Promise<FleetManifest> {
  const { client, model, goal, outline, baseline, expandMaxRetries } = input;
```
Add ONE field to this input object — the injected re-expand function. Type it to match `runExpandStage`'s real signature (see §2 below). Recommended:
```ts
  expandMaxRetries: number;
  expand: (input: {
    client: LLMClient;
    model: string;
    outline: Outline;
    goal: string;
    maxRetries: number;
    critiqueFeedback?: string;
  }) => Promise<FleetManifest>;
```
You do NOT need to destructure `expand` (it's accessed as `input.expand`), but you may. The existing destructure on line 216 omits it harmlessly either way.

**The injection target — former line 247 call site (lines 246-256). Change `runExpandStage(...)` → `input.expand(...)`:**
```ts
    reExpandsLeft -= 1;
    try {
      const reExpanded = await runExpandStage({   // ← change to: await input.expand({
        client,
        model,
        outline,
        goal,
        maxRetries: expandMaxRetries,
        critiqueFeedback: verdict.feedback,
      });
      candidates.push(reExpanded);
      current = reExpanded;
    } catch {
```
The argument object is byte-identical; only the callee changes from the imported `runExpandStage` to `input.expand`.

**Imports this file uses (top of file):**
- `z` from `zod` (line 1)
- `type { LLMClient, Message }` from `../providers/types.js` (line 2)
- `type { FleetManifest }` from `./manifest.js` (line 3)
- `{ type Outline, runExpandStage }` from `./decomposer-deep.js` (line 4) ← **DELETE; re-source `Outline` from leaf**
- `{ DEEP_MAX_TOTAL_CALLS, DEEP_EXPAND_MAX_RETRIES }` from `./decomposer-deep-constants.js` (lines 8-11) ← **KEEP unchanged**

`Outline` is used at lines 125, 172, 212 (function input types). After the leaf import, these resolve unchanged.

**Imported by (production):** `src/fleet/decomposer-deep.ts:5` imports `runCritiqueLoop`. This one-directional edge is allowed to remain (it is no longer a cycle once critic-deep stops importing decomposer-deep).

**Test file:** `src/fleet/critic-deep.test.ts` (EXISTS — 638 lines; the runCritiqueLoop describe block is lines 354-486).

---

### src/fleet/decomposer-deep.ts (modify)

**Current type defs to relocate (lines 83-86):**
```ts
// ── Types ────────────────────────────────────────────────────────────

export type OutlineArea = { name: string; intent: string };
export type Outline = { areas: OutlineArea[] };
```
Replace these two `export type` lines with a re-export from the new leaf (preserve the public surface so external `import { Outline } from "./decomposer-deep.js"` keeps resolving — typecheck proves it). Mirror the existing constants re-export pattern at lines 11-13 (see §2):
```ts
// ── Types ────────────────────────────────────────────────────────────

// bober: Outline/OutlineArea now live in the dependency-free ./decomposer-deep-types.js leaf
// (re-exported here so existing importers of `import { Outline } from "./decomposer-deep.js"` keep
// working). Sourcing them from a leaf lets critic-deep import Outline WITHOUT a decomposer-deep
// dependency, breaking the critic-deep ↔ decomposer-deep cycle.
export { type Outline, type OutlineArea } from "./decomposer-deep-types.js";
```
> Note: `OutlineArea` and `Outline` are `type` aliases, so the re-export uses `export { type ... }` (NOT `export type { ... }` — both compile, but the inline-`type` form matches the existing line-13 constants re-export `export { DEEP_PLAN_MAX_RETRIES, ... }` style, except those are values; for types use `export { type Outline, type OutlineArea } from ...`). The runtime Zod schemas `OutlineAreaSchema` (line 104) and `OutlineSchema` (line 109) STAY in decomposer-deep.ts — they are validation values, not the `Outline` type, and have no external importers.

**The loop call — line 367 (EXACT current text):**
```ts
    return runCritiqueLoop({ client, model, goal, outline, baseline: manifest, expandMaxRetries });
```
Add the injected fn (use the param name you chose in critic-deep, `expand`):
```ts
    return runCritiqueLoop({ client, model, goal, outline, baseline: manifest, expandMaxRetries, expand: runExpandStage });
```
`runExpandStage` is defined in-file (line 295) and already in scope at line 367. **`decomposeGoalDeep`'s exported signature (line 337-339) is byte-unchanged** — do NOT touch it (sc-1-3, nonGoal).

**`runExpandStage` real signature (lines 295-302) — this is the precise type the injected param must match:**
```ts
export async function runExpandStage(input: {
  client: LLMClient;
  model: string;
  outline: Outline;
  goal: string;
  maxRetries: number;
  critiqueFeedback?: string; // NEW; threaded into first EXPAND user turn only
}): Promise<FleetManifest> {
```
So the injected param type is exactly `typeof runExpandStage` OR the structural literal in §1. Using a structural literal (not `typeof runExpandStage`) is RECOMMENDED — `typeof runExpandStage` would re-introduce a value-level reference to the decomposer-deep symbol name inside critic-deep's type position (it still wouldn't be a runtime import since `Outline` import is type-only, but a hand-written structural type keeps critic-deep 100% decoupled and is what the generatorNotes suggest).

**Imports this file uses:**
- `z` from `zod` (1), `validateManifest` from `./decomposer.js` (2), `type FleetManifest` from `./manifest.js` (3), `type { LLMClient, Message }` from `../providers/types.js` (4)
- `runCritiqueLoop` from `./critic-deep.js` (5) ← **KEEP** (the surviving one-directional edge)
- constants from `./decomposer-deep-constants.js` (6-10), re-exported at 13 ← KEEP

**Imported by:** `src/fleet/critic-deep.test.ts:16-20` (imports `DEEP_MAX_TOTAL_CALLS`, `DEEP_EXPAND_MAX_RETRIES`, `decomposeGoalDeep`); `src/fleet/decomposer-deep.test.ts:5-13`. The `Outline` re-export keeps both compiling.

**Test file:** `src/fleet/decomposer-deep.test.ts` (EXISTS — 395 lines).

---

### src/fleet/decomposer-deep-types.ts (CREATE)

**Directory pattern:** Files in `src/fleet/` use kebab-case (`critic-deep.ts`, `decomposer-deep.ts`, `decomposer-deep-constants.ts`, `manifest.ts`). The leaf naming `decomposer-deep-types.ts` mirrors the existing `decomposer-deep-constants.ts` precedent exactly.

**Most similar existing file:** `src/fleet/decomposer-deep-constants.ts` — the EXACT model. It is a dependency-free leaf (zero imports) that exists for the SAME structural reason (break the critic-deep↔decomposer-deep cycle / TDZ). Follow its header-comment style and zero-import discipline.

**Structure template (model on decomposer-deep-constants.ts lines 1-13):**
```ts
// bober: Leaf types module — INTENTIONALLY has no relative imports.
//
// It exists to break the `critic-deep` <-> `decomposer-deep` import cycle: critic-deep needs the
// `Outline` type but must NOT depend on decomposer-deep.ts (the cycle node). Hosting Outline here —
// a dependency-free leaf both modules can import — removes critic-deep's last edge to decomposer-deep
// (mirrors the ./decomposer-deep-constants.ts precedent that broke the init-time TDZ cycle,
// inc-20260620-cli-tdz-crash). decomposer-deep.ts re-exports these so its public surface is unchanged.

// ── Types ────────────────────────────────────────────────────────────

export type OutlineArea = { name: string; intent: string };
export type Outline = { areas: OutlineArea[] };
```
**Hard rule (sc-1-4):** ZERO relative imports. `grep -cE "from ['\"]\." src/fleet/decomposer-deep-types.ts` MUST return 0. `Outline` depends only on `OutlineArea`, which depends on string primitives — no other types move. (Verified: `OutlineArea = { name: string; intent: string }` is fully self-contained.)

---

## 2. Patterns to Follow

### Dependency-free leaf + re-export (THE central pattern for this sprint)
**Source:** `src/fleet/decomposer-deep-constants.ts`, lines 1-13 (the leaf) and `src/fleet/decomposer-deep.ts`, lines 6-13 (the import + re-export).
```ts
// decomposer-deep-constants.ts (the leaf — zero imports):
export const DEEP_PLAN_MAX_RETRIES = 1;
export const DEEP_EXPAND_MAX_RETRIES = 1;
export const DEEP_MAX_TOTAL_CALLS = 4;

// decomposer-deep.ts (imports from leaf, then RE-EXPORTS for backward compat):
import {
  DEEP_PLAN_MAX_RETRIES,
  DEEP_EXPAND_MAX_RETRIES,
  DEEP_MAX_TOTAL_CALLS,
} from "./decomposer-deep-constants.js";
// bober: re-exported so existing importers of these from ./decomposer-deep.js keep working.
export { DEEP_PLAN_MAX_RETRIES, DEEP_EXPAND_MAX_RETRIES, DEEP_MAX_TOTAL_CALLS };
```
**Rule:** Create the new types leaf identically (zero imports, a `// bober:` header explaining WHY it exists), then `export { type Outline, type OutlineArea } from "./decomposer-deep-types.js"` from decomposer-deep.ts so the public surface is byte-identical. For TYPE re-exports, use the inline-`type` form (`export { type Outline, ... }`).

### ESM `.js` specifiers on relative imports (mandatory)
**Source:** `src/fleet/critic-deep.ts`, lines 2-4; `src/fleet/decomposer-deep.ts`, lines 2-10.
```ts
import type { FleetManifest } from "./manifest.js";
import { runCritiqueLoop } from "./critic-deep.js";
import { DEEP_PLAN_MAX_RETRIES } from "./decomposer-deep-constants.js";
```
**Rule:** EVERY relative import ends in `.js` even though the source is `.ts`. The new leaf import is `from "./decomposer-deep-types.js"`. `import type` for type-only imports of `Outline` in critic-deep: `import type { Outline } from "./decomposer-deep-types.js";`.

### Unicode section headers
**Source:** `src/fleet/critic-deep.ts` lines 13, 22, 54, 67, 119, 166, 206; `src/fleet/decomposer-deep.ts` lines 15, 83, 256.
```ts
// ── Constants ────────────────────────────────────────────────────────
// ── Types ────────────────────────────────────────────────────────────
// ── runCritiqueLoop (never throws, accept-best on exhaustion) ─────────
```
**Rule:** Preserve existing `// ── Title ──…` headers when editing; the new leaf gets a `// ── Types ──…` header (sc-1-6).

### `// bober:` rationale comments
**Source:** `src/fleet/critic-deep.ts` lines 5-7, 202; `src/fleet/decomposer-deep.ts` lines 11-12, 80-81; `src/fleet/decomposer-deep-constants.ts` lines 1-9.
```ts
// bober: read budget constants from the dependency-free leaf, NOT from ./decomposer-deep.js.
// ... importing them from the leaf avoids the circular-import TDZ that killed the CLI ...
```
**Rule:** Add a `// bober:` comment on the new leaf and at the changed critic-deep import explaining it breaks the cycle (matches the established house style and the generatorNotes STEP 1 instruction).

---

## 3. Existing Utilities — DO NOT Recreate

Utilities reviewed across `src/fleet/`. (There is no `utils/`, `lib/`, `helpers/`, `shared/`, or `common/` directory relevant to this structural refactor; the relevant shared symbols are the fleet types/functions below.)

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `runExpandStage` | `src/fleet/decomposer-deep.ts:295` | `(input: { client: LLMClient; model: string; outline: Outline; goal: string; maxRetries: number; critiqueFeedback?: string }) => Promise<FleetManifest>` | The re-expand stage to INJECT (do not re-implement; pass it in at decomposer-deep.ts:367). |
| `runCritiqueLoop` | `src/fleet/critic-deep.ts:208` | `(input: { client; model; goal; outline: Outline; baseline: FleetManifest; expandMaxRetries: number }) => Promise<FleetManifest>` | The loop gaining the `expand` injected param; called only from decomposer-deep.ts:367 (prod) + 9 test sites. |
| `Outline` (type) | `src/fleet/decomposer-deep.ts:86` → relocate to `decomposer-deep-types.ts` | `{ areas: OutlineArea[] }` | The type to move to the leaf; sole external importer is critic-deep.ts:4. |
| `OutlineArea` (type) | `src/fleet/decomposer-deep.ts:85` → relocate to leaf | `{ name: string; intent: string }` | Moves WITH Outline (its only dependency). No external importer. |
| `FleetManifest` (type) | `src/fleet/manifest.ts:26` | `z.infer<typeof FleetManifestSchema>` | Return type of both stages; import path unchanged (`./manifest.js`). |
| `FleetManifestSchema` | `src/fleet/manifest.ts:14` | Zod schema | Used in tests for `.safeParse(result).success`. |
| `LLMClient`, `Message` (types) | `src/providers/types.js` | — | Injected-param field types; import path unchanged (`../providers/types.js`). |
| `OutlineSchema` / `OutlineAreaSchema` | `src/fleet/decomposer-deep.ts:104,109` | Zod schemas | Runtime validators — STAY in decomposer-deep.ts (not types; not moved). |
| `validateManifest` | `src/fleet/decomposer.js` | `(rawText) => { ok; manifest }` | Used inside runExpandStage; untouched. |

**Do NOT create a new `Outline` type, a new re-expand function, or a `typeof runExpandStage` import in critic-deep.** Inject the existing `runExpandStage`; relocate the existing `Outline`.

---

## 4. Prior Sprint Output

No prior sprints in this spec (`dependsOn: []`). The directly-relevant prior WORK in the repo is the **constants-leaf extraction** (commit `a73526c fix(fleet): break decomposer-deep<->critic-deep module-init TDZ cycle`) which created `src/fleet/decomposer-deep-constants.ts`. That commit broke the *module-initialization* TDZ half of the cycle by moving the const reads to a leaf. **This sprint finishes the job** by also removing the remaining value import (`runExpandStage`) and the type import (`Outline`) so critic-deep has ZERO edges to the decomposer-deep.ts module. Use that prior leaf as your structural template (§2).

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` consulted for this micro-refactor; the binding rules are the contract's `successCriteria`/`nonGoals` and the house conventions in §2 (ESM `.js`, `import type`, unicode headers, `// bober:` rationale).

### Architecture Decisions
The relevant ADRs are referenced inline in the code as ADR-1/ADR-3 (critic-deep.ts:201,231,258 — fail-open / never-throw / accept-best semantics). **These behaviors must NOT change** (sc-1-7, nonGoals). The incident `inc-20260620-cli-tdz-crash` (cited in decomposer-deep-constants.ts:4 and critic-deep.ts:7) is the precedent that motivates the leaf pattern — do NOT reintroduce a value import that could revive the TDZ.

### Other Docs
`package.json` scripts (verified): `build`=`tsc`, `typecheck`=`tsc --noEmit`, `lint`=`eslint src/`, `test`=`vitest`. No `.js` synchronous-fs concerns here (pure type/import refactor).

---

## 6. Testing Patterns

### Unit Test Pattern
**Source:** `src/fleet/critic-deep.test.ts` (the file you will edit).
**Runner:** vitest. **Assertion style:** `expect(...).toBe/.toHaveLength/.toBeGreaterThan/.resolves`. **Mock approach:** a hand-rolled `ScriptedClient implements LLMClient` (lines 28-46) that returns scripted responses and records `calls`. NO `vi.mock`. **File naming:** co-located `*.test.ts`.

**The ScriptedClient + a runCritiqueLoop call (current shape, lines 357-370):**
```ts
const client = new ScriptedClient([VALID_APPROVE_JSON]);
const result = await runCritiqueLoop({
  client,
  model: "m",
  goal: "g",
  outline: VALID_OUTLINE,
  baseline: VALID_SINGLE_CHILD_MANIFEST,
  expandMaxRetries: DEEP_EXPAND_MAX_RETRIES,
});
```

**The 9 `runCritiqueLoop` call sites to update** (each needs the new `expand` arg). Line numbers of the `runCritiqueLoop(` token: **359, 379, 400, 418, 433, 447 (inside `runCritiqueLoop({` wrapped by `await expect(`), 461, 476**. The contract lists 9 calls; the `await expect(runCritiqueLoop({...}))` at ~447-454 is the wrapped one. Count them by `grep -nE 'runCritiqueLoop\(' src/fleet/critic-deep.test.ts` after editing to confirm all carry `expand`.

**Recommended test edit (CLEANEST — re-import the real `runExpandStage`):** the test already imports from `./decomposer-deep.js` (lines 16-20). Add `runExpandStage` to that import and spread it into each call. Because every existing `runCritiqueLoop` test drives a `ScriptedClient` whose script ALREADY includes the re-expand response (e.g. `[VALID_REJECT_JSON, VALID_MULTI_CHILD_JSON, VALID_APPROVE_JSON]` at lines 374-378), passing the REAL `runExpandStage` preserves every existing assertion byte-for-byte (the re-expand call consumes the scripted child JSON exactly as before). This is strictly preferable to a stub for the 8 behavior-preserving calls:
```ts
// add to the line 16-20 import:
import {
  DEEP_MAX_TOTAL_CALLS,
  DEEP_EXPAND_MAX_RETRIES,
  decomposeGoalDeep,
  runExpandStage,   // ← add
} from "./decomposer-deep.js";

// then each call gains: expand: runExpandStage,
const result = await runCritiqueLoop({
  client, model: "m", goal: "g",
  outline: VALID_OUTLINE,
  baseline: VALID_SINGLE_CHILD_MANIFEST,
  expandMaxRetries: DEEP_EXPAND_MAX_RETRIES,
  expand: runExpandStage,   // ← add to ALL 9
});
```

**The new sc-1-7 spy test (proves the injected fn is invoked on a critique miss):** add ONE new `it(...)` in the `runCritiqueLoop` describe block using a spy stub instead of the real fn:
```ts
it("invokes the injected expand fn on a critique miss (sc-1-7)", async () => {
  // critic rejects baseline → loop must call the injected expand exactly once
  const client = new ScriptedClient([VALID_REJECT_JSON, VALID_APPROVE_JSON]);
  let expandCalls = 0;
  const fakeExpand = async () => {
    expandCalls += 1;
    return VALID_MULTI_CHILD_MANIFEST as FleetManifest; // a valid manifest
  };
  await runCritiqueLoop({
    client, model: "m", goal: "g",
    outline: VALID_OUTLINE,
    baseline: VALID_SINGLE_CHILD_MANIFEST,
    expandMaxRetries: DEEP_EXPAND_MAX_RETRIES,
    expand: fakeExpand,
  });
  expect(expandCalls).toBe(1);
});
```
> `VALID_MULTI_CHILD_MANIFEST` does NOT exist as a const in the test file — only `VALID_MULTI_CHILD_JSON` (line 63) and `VALID_TWO_CHILD_MANIFEST`/`VALID_SINGLE_CHILD_MANIFEST` (lines 81-94) do. For the spy test, return an EXISTING manifest const (e.g. `VALID_TWO_CHILD_MANIFEST`) to avoid inventing a symbol. Import `FleetManifest` type if you annotate (or omit the annotation; the structural object satisfies the param). Note: with `[VALID_REJECT_JSON, VALID_APPROVE_JSON]` the loop does critic(reject)→expand(once)→critic(approve)→return, so `expandCalls === 1`.

**decomposer-deep.test.ts:** VERIFIED no change needed — it imports `runExpandStage`, `decomposeGoalDeep`, `runPlanStage`, `validateOutline` + constants from `./decomposer-deep.js` (lines 5-13) but does NOT import `Outline` and does NOT call `runCritiqueLoop`. Its outline literals are inline (`testOutline`, line 344). The `Outline` re-export keeps every one of its imports resolving. Leave it untouched.

### E2E Test Pattern
Not applicable — this is an internal module refactor with no UI/CLI surface change (nonGoal: "Do NOT add CLI surface").

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/fleet/decomposer-deep.ts` | `Outline`/`OutlineArea` (now re-exported), `runCritiqueLoop` (new `expand` field) | low | Re-export resolves; line-367 call now supplies `expand: runExpandStage`. Typecheck proves it. |
| `src/fleet/critic-deep.ts` | `Outline` (leaf), `input.expand` | low | `Outline` used at 125/172/212 resolves from leaf; line-247 calls `input.expand`. |
| `src/fleet/critic-deep.test.ts` | `runCritiqueLoop` signature (now requires `expand`) | **high** | All 9 calls MUST add `expand` or TS errors (missing required prop). |
| `src/fleet/decomposer-deep.test.ts` | `import { Outline }`? → NO (verified) | none | No `Outline` import, no `runCritiqueLoop` call. Should compile unchanged. |
| Any external `import { Outline } from "./decomposer-deep.js"` | — | none | grep-verified: ZERO external importers of `Outline` exist outside critic-deep.ts:4 (which is being repointed). The re-export is belt-and-suspenders for the contract's backward-compat requirement. |

**Grep evidence (whole repo):** `grep -rnE "Outline" src/ --include="*.ts" | grep import` returns ONLY `src/fleet/critic-deep.ts:4`. No other module imports `Outline` or `OutlineArea`. `grep -rnE "runExpandStage" src/` returns only decomposer-deep.ts (def+call), critic-deep.ts (import+call), and decomposer-deep.test.ts (standalone tests). `runCritiqueLoop` production callers: ONLY decomposer-deep.ts:367.

### Existing Tests That Must Still Pass
- `src/fleet/critic-deep.test.ts` — the `runCritiqueLoop (sc-1-7)` describe (lines 354-486, 9 calls) and `decomposeGoalDeep — critique:true integration` (lines 490-606). These exercise the re-expand path; passing the REAL `runExpandStage` keeps the scripted-response sequencing identical so every assertion (call counts, feedback-in-message, accept-best tiebreak, ceiling ≤8) still holds.
- `src/fleet/decomposer-deep.test.ts` — `runExpandStage` standalone (343-394), `decomposeGoalDeep` happy/exhaustion (146-307). Verify still green (no change expected).
- `decomposeGoalDeep` integration at critic-deep.test.ts:490-606 implicitly tests the line-367 wiring end-to-end — confirms `decomposeGoalDeep` passes `expand` through correctly.

### Features That Could Be Affected
- **`fleet expand-deep --critique`** (the only consumer of `runCritiqueLoop` via `decomposeGoalDeep`) — verify the critique→re-expand→accept-best loop behaves identically. The integration tests at critic-deep.test.ts:490-606 cover this.
- **`fleet expand-deep` (no `--critique`)** — byte-identical path (critique branch skipped at decomposer-deep.ts:366); the `critique:false`/absent tests (lines 534-564) guard this.

### Recommended Regression Checks
After implementation, the Generator MUST run:
1. `npm run build` (tsc) — zero errors (sc-1-1).
2. `npm run typecheck` (tsc --noEmit) — zero errors; this proves the `Outline` re-export + injected-param typing are sound.
3. `grep -nE 'from "\./decomposer-deep\.js"' src/fleet/critic-deep.ts` → **ZERO matches** (the real cycle-break invariant; sc-1-2). Also run the literal `grep -nE 'decomposer-deep' src/fleet/critic-deep.ts` and confirm the ONLY remaining matches are `./decomposer-deep-constants.js` and `./decomposer-deep-types.js` (dependency-free leaves, not the cycle node) — flag this nuance to the evaluator.
4. `grep -cE "from ['\"]\\." src/fleet/decomposer-deep-types.ts` → **0** (leaf is dependency-free; sc-1-4).
5. `npx vitest run src/fleet/critic-deep.test.ts src/fleet/decomposer-deep.test.ts` — all green.
6. `npm test` (full vitest) — only the 6 known cockpit-integration MCP failures may remain (sc-1-5).
7. `npm run lint` — zero errors (sc-1-6).
8. `git diff --stat` — confined to: `critic-deep.ts`, `decomposer-deep.ts`, `decomposer-deep-types.ts` (new), `critic-deep.test.ts` (and NOT decomposer-deep.test.ts unless typecheck forced it).
9. Confirm `export async function decomposeGoalDeep(` line (decomposer-deep.ts:337) is byte-unchanged (sc-1-3).

---

## 8. Implementation Sequence

Dependency order: leaf (no deps) → decomposer-deep (depends on leaf) → critic-deep (depends on leaf) → tests.

1. **CREATE `src/fleet/decomposer-deep-types.ts`** — `OutlineArea` + `Outline`, zero relative imports, `// bober:` header + `// ── Types ──…` section header. Model on `decomposer-deep-constants.ts`.
   - Verify: `grep -cE "from ['\"]\\." src/fleet/decomposer-deep-types.ts` → 0.
2. **MODIFY `src/fleet/decomposer-deep.ts`** — (a) replace local `Outline`/`OutlineArea` defs (lines 85-86) with `export { type Outline, type OutlineArea } from "./decomposer-deep-types.js";` + a `// bober:` note; (b) at line 367 add `expand: runExpandStage` to the `runCritiqueLoop` call. Do NOT touch `decomposeGoalDeep`'s signature (337-339), the Zod schemas (104-111), or `runExpandStage` (295).
   - Verify: `npm run typecheck` — `Outline` still resolves repo-wide via the re-export.
3. **MODIFY `src/fleet/critic-deep.ts`** — (a) DELETE line 4; add `import type { Outline } from "./decomposer-deep-types.js";` (with a `// bober:` cycle-break note); (b) add the `expand: (input: {...}) => Promise<FleetManifest>` field to `runCritiqueLoop`'s input object (after `expandMaxRetries`, line 214); (c) change line 247 `await runExpandStage({...})` → `await input.expand({...})` (args unchanged).
   - Verify: `grep -nE 'from "\./decomposer-deep\.js"' src/fleet/critic-deep.ts` → ZERO. `npm run typecheck` green.
4. **MODIFY `src/fleet/critic-deep.test.ts`** — add `runExpandStage` to the `./decomposer-deep.js` import (lines 16-20); add `expand: runExpandStage` to ALL 9 `runCritiqueLoop` calls; add the new sc-1-7 spy test (use an existing manifest const for the stub's return).
   - Verify: `grep -nE 'runCritiqueLoop\(' src/fleet/critic-deep.test.ts` → every call carries `expand`. `npx vitest run src/fleet/critic-deep.test.ts` green.
5. **Confirm `src/fleet/decomposer-deep.test.ts` needs no edit** — run it; if typecheck/test is green, leave untouched.
6. **Run full verification** — `npm run build`, `npm run typecheck`, `npm test` (only 6 known cockpit MCP failures allowed), `npm run lint`. Then `git diff --stat` to confirm the 5-file (really 3-modified + 1-new + 1-test) blast radius.

---

## 9. Pitfalls & Warnings

- **The literal `grep -nE 'decomposer-deep' src/fleet/critic-deep.ts` will NOT be empty** because of the surviving `./decomposer-deep-constants.js` import (lines 5-11) AND the new `./decomposer-deep-types.js` import. The DEFENSIBLE invariant (and the evaluator's true intent) is "no import from the `decomposer-deep.js` *module*". Use `grep -nE 'from "\./decomposer-deep\.js"'` for the precise check. Do NOT remove the constants import to satisfy the naive grep — that revives the TDZ crash (inc-20260620-cli-tdz-crash). Surface this nuance in the commit/PR for the evaluator.
- **Do NOT delete `Outline` from decomposer-deep's public surface** — re-export it (nonGoal). External `import { Outline } from "./decomposer-deep.js"` MUST keep resolving (even though grep shows zero current external importers, the contract mandates backward compat).
- **Do NOT move the Zod schemas** `OutlineSchema`/`OutlineAreaSchema` (decomposer-deep.ts:104-111) to the leaf — they are runtime validators that import `z` and belong with `validateOutline`; moving them would force a `zod` import into the "types" leaf and pollute it. Only the `type` aliases move.
- **Prefer a structural literal type for the injected `expand` param over `typeof runExpandStage`** — `typeof runExpandStage` requires a (type-only) reference to a decomposer-deep symbol; a hand-written literal keeps critic-deep fully decoupled and matches the generatorNotes STEP 3 suggestion. (Both compile; the literal is cleaner.)
- **All 9 test call sites, not 8** — one `runCritiqueLoop({...})` is wrapped inside `await expect(...).resolves` (~lines 447-455). `grep -nE 'runCritiqueLoop\(' src/fleet/critic-deep.test.ts` after editing must show `expand:` in every call.
- **Use an EXISTING manifest const in the spy stub** (`VALID_TWO_CHILD_MANIFEST` or `VALID_SINGLE_CHILD_MANIFEST`, lines 81-94) — there is no `VALID_MULTI_CHILD_MANIFEST` const (only `VALID_MULTI_CHILD_JSON`, a string). Inventing a symbol breaks compilation.
- **Passing the real `runExpandStage` (not a stub) to the 8 existing tests preserves behavior** — those tests script the re-expand response into the `ScriptedClient`, so the real fn consumes it exactly as the old imported call did. A blanket stub that ignores the script would break the feedback-in-message and tiebreak assertions.
- **`.js` specifier on the new leaf import** — `./decomposer-deep-types.js` (NOT `.ts`). ESM/NodeNext resolution requires it; lint/build will fail otherwise.
- **Keep `decomposeGoalDeep`'s exported signature byte-identical** — the injection happens INSIDE the function body (line 367), never on its parameter list (sc-1-3, nonGoal). Diff the `export async function decomposeGoalDeep(` line to confirm.
