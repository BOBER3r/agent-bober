# ADR-2: Decomposer emits children-only; reuse locked FleetManifestSchema as the validator

**Decision:** The decomposer's LLM output and Zod validation target `{ children: [{ folder, task }] }` only — it emits no per-child `config`, no `concurrency`, and no `rootDir`, and validates against the unmodified Phase 1 `FleetManifestSchema` (`src/fleet/manifest.ts:13`) plus a guard rejecting any child carrying a `config` key.

**Context:** Phase 2 turns a goal into a manifest that feeds the locked `runFleet` (`src/fleet/index.ts:88`). The component boundary question is what the decomposer owns vs. what downstream owns, and whether a new/relaxed schema is needed.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| Children-only against locked FleetManifestSchema | No schema drift; provider stays a downstream concern; smallest prompt | LLM must omit fields it might "helpfully" add (handled by coercion re-prompt + config-key guard) |
| Decomposer emits full manifest incl. per-child `config`/`concurrency` | One object, fully specified | Duplicates `buildChildConfig` (`child-config.ts:21`); risks provider/SDK leak; fights `mapBounded` concurrency |
| Add a relaxed Phase-2 schema variant | Looser LLM target | Two schemas to keep in sync; `load`/`runFleet` parse the original — mismatch ships invalid manifests |

**Rationale:** The CP1 constraints "decomposer emits NO provider config (injected by `buildChildConfig`)", "NO concurrency override (governed by `mapBounded`)", and "no schema relaxation — output MUST pass `FleetManifestSchema.parse`" eliminate options 2 and 3; `rootDir`/`concurrency` schema defaults (`manifest.ts:14-15`) make children-only sufficient.

**Consequences:** `validateManifest` calls `FleetManifestSchema.safeParse` directly and additionally rejects any child with a `config` key; the prompt forbids `config`/`concurrency`/provider keys; `runFleet`/`load`/`buildChildConfig` stay byte-unchanged.

**Risk:** `FleetChildSchema` (`manifest.ts:6-10`) accepts an optional `config`, so a model-emitted `config` would pass the raw schema and silently override `buildChildConfig` downstream — the explicit config-key guard in `ManifestValidator` is required to close this, and the prompt must forbid it.
