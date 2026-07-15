# ADR-2: Child Config Built via createDefaultConfig() Templating, Not Hand-Written JSON

**Decision:** `ChildScaffolder.buildChildConfig` produces each child's `bober.config.json` by calling `createDefaultConfig()` and applying DeepSeek overrides across the per-role provider fields, rather than emitting hand-authored JSON.

**Context:** Each scaffolded child must receive a config that is Zod-valid and points every role at DeepSeek (openai-compat, src/providers/openai-compat.ts). The config schema evolves over time, and hand-written JSON drifts from the live schema.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A: `createDefaultConfig()` + DeepSeek overrides | Always Zod-valid by construction; tracks schema evolution automatically | Coupled to the default-config factory's shape |
| B: Hand-written JSON template per child | Fully explicit; no factory coupling | Drifts from the Zod schema; silently produces invalid configs as the schema changes |

**Rationale:** The CP1 HARD backward-compat constraint (configs must stay Zod-valid and provider-agnostic) and the cost constraint (DeepSeek across per-role provider fields) are satisfied by construction only when the config is generated from the same factory the rest of the system uses; hand-written JSON cannot guarantee this as the schema evolves.

**Consequences:** Child configs stay valid as the schema changes; DeepSeek selection lives in one override step; any new required config field is inherited automatically from `createDefaultConfig()`.

**Risk:** If `createDefaultConfig()` changes its default provider or omits a field the DeepSeek override assumes, children may be misconfigured; mitigated by validating the built config against the Zod schema before writing.
