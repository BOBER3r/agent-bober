# ADR-1: Robust Decomposition Engine — Two-Call Plan-Then-Expand

**Decision:** The `fleet expand-deep` engine decomposes a goal in two bounded LLM stages — an in-memory coarse outline, then an expansion of that outline into a children-only `FleetManifest` validated by the existing `validateManifest`.

**Context:** The single-shot loop (`src/fleet/decomposer.ts:159-187`) bounds attempts at `maxAttempts = 1 + DECOMPOSE_MAX_RETRIES` (`:40,161`) but only re-prompts on SHAPE failure, so a shape-valid-but-degenerate single/coarse child passes `FleetManifestSchema` (`manifest.ts:16`) unchallenged — the named Phase-2 open risk. A robust engine must improve sizing while keeping a bounded call budget and the locked children-only on-disk contract.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A: Two-call plan-then-expand | Fixed-constant budget (~2-4 calls); outline stays in-memory; reuses `validateManifest` + 3-message coercion; easiest `ScriptedClient` test | one expand call not self-judged; adds one stage + `Outline` type |
| B: Iterative critique/refine loop | rubric can reject degenerate single-child that `validateManifest` cannot; bounded by `CRITIQUE_MAX_ROUNDS` | highest call count; extra rubric/verdict prompt + parseable verdict schema = most surface and parse-failure modes |
| C: Hierarchical recursive tree | best for huge multi-domain goals; most granular | budget is model-data-dependent ceiling (`1+areas`), weakest fit for explicit-constant constraint; needs folder de-collision + most fragile test script |

**Rationale:** The CP1 latency constraint requires the budget be "bounded by an explicit constant, never an open loop" (analogous to `DECOMPOSE_MAX_RETRIES`, `decomposer.ts:40`); only A yields a fixed call count, whereas C's budget is a model-chosen `1+areas` ceiling — C eliminated. Against B, the in-memory-interim-only and deterministic-fake-testability constraints are met by A with strictly less new state and no rubric/verdict parse surface, so B's extra cost is unjustified and it is deferred.

**Consequences:** A new additive `decomposeGoalDeep` is introduced beside the byte-unchanged `decomposeGoal`; it emits one transient in-memory outline then reuses `validateManifest` on the second stage, writes the same `FleetManifestSchema`-valid children-only manifest, and is wired only behind the new `fleet expand-deep <goal>` sibling subcommand. No schema, `runFleet`, or `--yes`-gate change.

**Risk:** If a goal's coarseness stems from the model under-expanding even AFTER an explicit outline (e.g. 2 children for a 12-area outline), Approach A will not self-correct it — that quality gap is Approach B's domain and would require revisiting this decision to add a bounded critique round.
