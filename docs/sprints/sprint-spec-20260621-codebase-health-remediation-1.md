# Break the critic-deep ↔ decomposer-deep import cycle via dependency injection

**Contract:** sprint-spec-20260621-codebase-health-remediation-1  ·  **Spec:** spec-20260621-codebase-health-remediation  ·  **Completed:** 2026-06-21

## What this sprint added

This sprint **fully eliminates the genuine runtime import cycle** between
`src/fleet/critic-deep.ts` and `src/fleet/decomposer-deep.ts` — the live (but, until now,
only *latently* safe) `fleet` cycle that `research-20260621-codebase-health-hotspots-cycles`
flagged as the highest-priority structural risk. Both directions previously carried a runtime
**value** import (`critic-deep` imported `runExpandStage` from `decomposer-deep`, which imports
`runCritiqueLoop` back) plus a **type** edge (`Outline`). The earlier incident fix `a73526c`
(inc-20260620-cli-tdz-crash) had only lifted the *module-init-time* constant reads into the
dependency-free `decomposer-deep-constants.ts` leaf — the cross-module value edges (and the
module-init TDZ they could re-introduce) remained. This sprint removes the **last edge** from
`critic-deep` to `decomposer-deep`: the value import is replaced by **dependency injection**
(`runExpandStage` is passed into `runCritiqueLoop` via an `expand` param), and the `Outline` /
`OutlineArea` types are relocated into a new dependency-free leaf. After this, `critic-deep.ts`
imports nothing from `./decomposer-deep.js` and only a **one-directional** `decomposer-deep →
critic-deep` edge remains — which is not a cycle. This is a **pure structural refactor with zero
behavior change**: 2815/2815 tests green.

## Public surface

This is an internal `src/fleet` refactor — no CLI command, flag, config key, or exported
public-API signature changed. `decomposeGoalDeep`'s exported signature is **byte-identical**, and
`Outline` / `OutlineArea` remain importable from `./decomposer-deep.js` (re-exported), so all
existing importers keep working.

- `src/fleet/decomposer-deep-types.ts` (**new**, `decomposer-deep-types.ts:11`) — dependency-free
  leaf holding `export type OutlineArea = { name: string; intent: string }` and
  `export type Outline = { areas: OutlineArea[] }`. **Zero relative imports** (mirrors the
  `decomposer-deep-constants.ts` precedent); exists solely to host the shared `Outline` type so
  both cyclic modules can import it without depending on each other.
- `runCritiqueLoop(input)` (`src/fleet/critic-deep.ts:211`) — gained an injected
  `expand: (input: { client; model; outline; goal; maxRetries; critiqueFeedback? }) => Promise<FleetManifest>`
  field on its input object (`critic-deep.ts:218`); the former imported-`runExpandStage` call in the
  re-expand branch now invokes `input.expand({ … })` (`critic-deep.ts:258`). Its return type and the
  critique→re-expand→accept-best / never-throw / accept-on-exhaustion semantics are unchanged.
- `Outline` / `OutlineArea` re-export (`src/fleet/decomposer-deep.ts:89-90`) — `decomposer-deep.ts`
  now `import type`s these from `./decomposer-deep-types.js` and re-exports them
  (`export type { Outline, OutlineArea }`), so its public surface is unchanged.
- `decomposeGoalDeep(...)` (`src/fleet/decomposer-deep.ts:341`) — the **sole production caller** of
  `runCritiqueLoop`; at `decomposer-deep.ts:371` it now passes its in-file `runExpandStage` in as
  `expand: runExpandStage`. **Exported signature unchanged.**

## How to use / how it fits

Nothing changes for callers. `decomposeGoalDeep` (and the `fleet expand-deep --critique` path that
reaches it) behaves exactly as before; `Outline` still resolves from `./decomposer-deep.js`. The
only difference is internal wiring:

```text
before:  critic-deep ──(value: runExpandStage)──▶ decomposer-deep
         critic-deep ◀──(value: runCritiqueLoop)── decomposer-deep      ← genuine runtime cycle
         critic-deep ──(type:  Outline)──────────▶ decomposer-deep

after:   critic-deep ◀──(value: runCritiqueLoop)── decomposer-deep      ← one direction only, no cycle
         critic-deep ──(type:  Outline)──▶ decomposer-deep-types (leaf, 0 imports)
         decomposer-deep ──▶ decomposer-deep-types (re-exports Outline)
         decomposeGoalDeep injects runExpandStage ──▶ runCritiqueLoop(expand: …)
```

`runCritiqueLoop` no longer reaches for an imported `runExpandStage`; the caller supplies the
re-expand function. Tests pass either the real `runExpandStage` (8 existing `runCritiqueLoop`
call sites in `critic-deep.test.ts`) or a spy (the new sc-1-7 test asserts the injected function is
invoked exactly once on a critique miss, proving the re-expand branch still fires).

## Notes for maintainers

- **The cycle is fully gone — do not re-add a `./decomposer-deep.js` import to `critic-deep.ts`.**
  The load-bearing invariant is that `grep -nE 'from "\./decomposer-deep\.js"' src/fleet/critic-deep.ts`
  returns **zero** matches (value *or* type). Imports of the two dependency-free leaves
  (`./decomposer-deep-types.js`, `./decomposer-deep-constants.js`) are fine — they contain the
  substring `decomposer-deep` but are **not** the cycle node. If you need another value from
  `decomposer-deep` inside `critic-deep`, inject it as a parameter (like `expand`) rather than
  importing it back.
- **`decomposer-deep → critic-deep` is intentional and fine.** One direction is not a cycle.
  `decomposer-deep.ts` still imports `runCritiqueLoop` from `./critic-deep.js`; leave it.
- **`Outline` lives in the leaf now; keep the re-export.** New shared `fleet` decomposition types
  that *both* modules need belong in `decomposer-deep-types.ts` (zero relative imports), with
  `decomposer-deep.ts` re-exporting them for back-compat. Do **not** move `Outline` back into
  `decomposer-deep.ts` — that re-introduces the type edge from `critic-deep`.
- **This supersedes the earlier `a73526c` mitigation, it does not replace the constants leaf.**
  `a73526c` removed the *module-init* TDZ by hoisting constants into `decomposer-deep-constants.ts`;
  this sprint removes the *remaining value cycle* by injection. Both leaves now coexist
  (`-constants.ts` for the init-time budget constants, `-types.ts` for `Outline`/`OutlineArea`).
  The `decomposer-deep-load-order.test.ts` native-ESM load-order guard from `a73526c` still applies.
- **Scope.** The diff is confined to `src/fleet/critic-deep.ts`, `src/fleet/decomposer-deep.ts`,
  the new `src/fleet/decomposer-deep-types.ts`, and `src/fleet/critic-deep.test.ts` (4 source files;
  `decomposer-deep.test.ts` did not need edits). Build / typecheck / lint clean (2 pre-existing
  warnings in `eval-persist.test.ts` only); `npx vitest run` → **2815/2815 passed** (219 files); no
  cockpit-integration failures appeared. Out of scope by contract: **Cycle 1**
  (`orchestrator/memory/fact-judge.ts` ↔ `reconcile.ts`) is type-only / `import type`, erased at
  compile time, and was deliberately left untouched. Commit `349c22c`.
