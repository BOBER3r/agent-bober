# ADR-2: Tier-to-Provider as a Post-EXPAND Manifest Mapping, Not a Decomposer-Prompt Change

**Decision:** A child's difficulty tier maps to a provider overlay block as a POST-EXPAND step in `buildChildConfig`, applied before the existing shallow-merge; the EXPAND/decomposer prompt is unchanged.

**Context:** The head assigns each child a difficulty tier; that tier must become a concrete provider block (planner/generator/evaluator) in the child's config. The mapping could live in the decomposer prompt (the LLM emits provider) or as a deterministic mapping after EXPAND.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A: Decomposer prompt emits provider/config per child | One LLM pass; no post-step | EXPAND prompt explicitly forbids config/provider injection; non-deterministic; couples routing to model output |
| B (chosen): Deterministic tier->provider mapping in buildChildConfig | Deterministic, testable, additive; tier-absent -> byte-identical | Mapping table is hand-maintained; tier itself still LLM-chosen (see Open Questions) |
| C: Separate post-fleet rewrite pass over scaffolded configs | Fully decoupled | Extra file I/O pass; rewrites already-written configs; more moving parts |

**Rationale:** Constraint "EXPAND prompt forbids config/provider injection" and "no-flag path byte-identical" eliminate Option A — the decomposer must not emit provider blocks. The overlay runs before `const merged = { ...base, ...(child.config ?? {}) }` (`src/fleet/child-config.ts:43`), so an absent tier returns the base unchanged. Option C's extra rewrite pass is rejected as unnecessary I/O when the overlay can run inline.

**Consequences:** `TierProviderPolicy.resolveTier` returns `undefined` for default/absent tier (no overlay). Routing is deterministic and unit-testable. The decomposer stays frozen.

**Risk:** If the tier->provider table drifts from real provider capabilities (e.g. a tier maps to a deprecated model), children fail at runtime. Mitigation: `validateManifestCredentials` checks provider keys up front (`src/fleet/index.ts:46`); per-child failure is data, not a fleet throw.
