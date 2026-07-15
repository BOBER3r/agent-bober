# ADR-4: Grok/xAI as an OpenAI-Compat Endpoint, Not a New Provider Adapter

**Decision:** Grok/xAI is added by mirroring the existing DeepSeek OpenAI-compat wiring at three touch-points plus credential validation, reusing the `openai-compat` provider rather than writing a new provider adapter.

**Context:** The provider pool must include Grok/xAI (`api.x.ai/v1`). DeepSeek already runs through an `openai-compat` adapter pointed at `api.deepseek.com` (`src/orchestrator/model-resolver.ts:38`). xAI exposes an OpenAI-compatible API, so the question is whether it needs a bespoke adapter or can reuse the existing one.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A: New dedicated xAI provider adapter | Full control over xAI quirks | Duplicates the openai-compat client; new provider enum value ripples through schema/factory/resolver; more surface |
| B (chosen): Reuse openai-compat, add endpoint + key arms | 3 small DeepSeek-mirror touch-points; one host predicate; additive | Assumes xAI stays OpenAI-compatible; endpoint hard-coded in SHORTHAND_MAP |
| C: Generic "bring-your-own-endpoint" provider config | Maximally flexible | Over-engineered for one provider; no Checkpoint-1 constraint demands generality |

**Rationale:** Constraint "Grok/xAI (NEW openai-compat api.x.ai/v1)" plus "ADDITIVE" makes Option B the minimal change: SHORTHAND_MAP `grok*` + endpoint selector (`src/orchestrator/model-resolver.ts:22`), `validateApiKey` xAI arm -> `XAI_API_KEY` (`factory.ts:86`), `createClient` key injection xAI arm (`factory.ts:251-255`), and `validateManifestCredentials` xAI recognition (`src/fleet/index.ts:46`). Option C is rejected — YAGNI; no constraint requires arbitrary endpoints.

**Consequences:** Host detection is centralized in `isXaiEndpoint()` so the three arms share one predicate. Adding a future OpenAI-compat provider follows the same three-touch-point recipe.

**Risk:** If xAI diverges from OpenAI wire format (e.g. auth header or streaming shape), the shared client breaks for Grok only. Mitigation: `isXaiEndpoint()` isolates the branch; a divergence is contained to one predicate plus the key-injection arm.
