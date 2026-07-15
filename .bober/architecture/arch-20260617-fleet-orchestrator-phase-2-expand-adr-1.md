# ADR-1: Lightweight FleetDecomposer over Planner Reuse

**Decision:** Build a new lightweight `FleetDecomposer` module that turns one goal string into a `FleetManifest` via a single structured `LLMClient` call plus `FleetManifestSchema.parse` and a bounded retry, rather than reusing the existing planner agent.

**Context:** Phase 2 must convert a high-level goal into a runnable `FleetManifest` (N `{folder,task}` children) so `runFleet()` (`src/fleet/index.ts:88`) can spawn children. The decomposition LLM step must be cheap and its output must pass the locked `FleetManifestSchema` (`src/fleet/manifest.ts:13-17`).

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A: Reuse planner agent | Zero new module; proven JSON+coercion retry (`planner-agent.ts:250-270`) | Returns `PlanSpec` for ONE repo (`planner-agent.ts:148-149`), needs brittle adapter; multi-turn + opus = costly |
| B: New `FleetDecomposer` | One cheap call; validates directly vs `FleetManifestSchema.parse`; no provider/concurrency emitted | New module to build/test; only bounded-retry self-correction |
| C: Two-call plan-then-expand | Better on huge/ambiguous goals; simpler prompts | Doubles call cost; intermediate shape adds failure surface |

**Rationale:** Checkpoint 1's "decomposition call must be cheap (single bulk call + bounded retry)" eliminates the heavyweight multi-turn planner (A) and the doubled-call plan-then-expand (C); "output MUST pass `FleetManifestSchema.parse`" eliminates A's `PlanSpec → FleetManifest` adapter.

**Consequences:** A new additive `FleetDecomposer` module is created using `agentic-loop`/`LLMClient`/`factory`; it emits no provider config (injected by `buildChildConfig`, `child-config.ts:21`) and no concurrency override (governed by `mapBounded`), so no second concurrency model appears. `runFleet()` and the `fleet <manifest>` command stay byte-unchanged.

**Risk:** If single-shot decomposition proves unreliable for large or ambiguous goals, child quality may degrade; if the retry budget is exhausted on malformed JSON it must fail clearly rather than emit an invalid manifest (Approach C remains a later escalation path).
