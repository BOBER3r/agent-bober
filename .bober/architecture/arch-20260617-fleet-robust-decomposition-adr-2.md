# ADR-2: New `decomposer-deep.ts` module vs extending `decomposer.ts`

**Decision:** Place the robust two-call engine (`decomposeGoalDeep`, PlanStage, ExpandStage, all `DEEP_*` constants) in a NEW file `src/fleet/decomposer-deep.ts` beside the locked `decomposer.ts`, importing only the exported `validateManifest` from it.

**Context:** The robust engine needs a second LLM stage, an `Outline` type, and its own prompt/budget constants. It must coexist with the single-shot path without altering it.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| New `decomposer-deep.ts` module | `decomposer.ts` stays byte-untouched; `validateManifest` imported, not duplicated; deep tests isolated | one extra file; one cross-module import edge |
| Extend `decomposer.ts` in place | single file; no new import | edits a LOCKED file; risks byte-drift in `decomposeGoal`/`DECOMPOSE_*`; couples deep prompts to single-shot ones |

**Rationale:** The CP1 constraint "the Phase-2 single-shot path (`decomposeGoal` + constants `decomposer.ts:7-40,159`) is LOCKED & byte-identical" eliminates the in-place option — editing `decomposer.ts` cannot guarantee byte-identity of the locked symbols. CP1 also mandates "additive", which a new sibling file satisfies cleanly while reusing the exported `validateManifest` (`decomposer.ts:95`).

**Consequences:** `decomposer.ts` diff is zero. `decomposer-deep.ts` imports `validateManifest` and the `FleetManifest` type; CLI wiring is additively appended to `index.ts`. The deep engine gets its own `decomposer-deep.test.ts` driven by the existing `ScriptedClient` pattern (`decomposer.test.ts:17-35`).

**Risk:** If `validateManifest`'s `ValidateResult` shape (`decomposer.ts:51-53`) ever changes, the EXPAND stage breaks; mitigation — it is consumed via its exported discriminated union, so a TypeScript compile error surfaces the break immediately.
