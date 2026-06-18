# Grok/xAI provider wiring

**Contract:** sprint-spec-20260618-fleet-tier-provider-routing-1  ·  **Spec:** spec-20260618-fleet-tier-provider-routing  ·  **Completed:** 2026-06-18

## What this sprint added

Wires **Grok / xAI** into agent-bober as the **existing `openai-compat` provider** pointed
at `https://api.x.ai/v1` — mirroring the DeepSeek wiring at its three resolution sites. xAI
exposes an OpenAI-wire-compatible API, so `OpenAICompatAdapter` handles it **unchanged**:
there is **no new `ProviderName` value and no new adapter class**. The model resolver gains
`grok` / `grok-4` / `grok-4-fast` shorthands that resolve to `openai-compat` and attach the
`api.x.ai/v1` endpoint, and the provider factory gains parallel `XAI_API_KEY`
validation/injection arms gated by a single shared `isXaiEndpoint()` predicate. Because the
fleet's pre-spawn credential check (`validateManifestCredentials`) already passes each
child's `endpoint` into `validateApiKey`, the new xAI arm makes the fleet recognize Grok
**with zero edits to `src/fleet/index.ts`**. This sprint changes **no fleet behavior and no
tier logic** — that is Sprint 2. This is **Sprint 1 of 3** in
`spec-20260618-fleet-tier-provider-routing` (Phase A of
`arch-20260618-heterogeneous-multi-provider-agent-team`).

## Public surface

- `isXaiEndpoint(endpoint?: string): boolean` (`src/providers/factory.ts:83`) — returns
  `true` when the endpoint includes the `api.x.ai` host. This is the **sole** place the
  `api.x.ai` host substring is matched (sc-1-6); both `validateApiKey` and `createClient`
  call it rather than inlining the substring twice. Mirrors how the DeepSeek host is matched.
- `grok` / `grok-4` / `grok-4-fast` model shorthands (`src/orchestrator/model-resolver.ts:42`) —
  added to `SHORTHAND_MAP` as `{ provider: "openai-compat", modelId: "grok-4" | "grok-4-fast" }`.
  `resolveProviderModel("grok")` returns `{ provider: "openai-compat", modelId: "grok-4",
  endpoint: "https://api.x.ai/v1" }`, exactly mirroring the DeepSeek shorthand shape. The
  `openai-compat` endpoint-attach branch now selects `https://api.x.ai/v1` when the resolved
  `modelId` starts with `grok` (`model-resolver.ts:86`), else keeps `https://api.deepseek.com`.
- `validateApiKey("openai-compat", role, apiKey?, endpoint?)` xAI arm (`src/providers/factory.ts:151`) —
  when `isXaiEndpoint(endpoint)`, requires `apiKey ?? process.env.XAI_API_KEY` and otherwise
  **throws** `"<role> is configured to use Grok/xAI but XAI_API_KEY is not set. …"`. The
  existing `api.deepseek.com` (requires `DEEPSEEK_API_KEY`) and bare-Ollama (no key) behaviors
  are unchanged.
- `createClient(...)` xAI key-injection arm (`src/providers/factory.ts:276`) — for an
  `openai-compat` provider at an `api.x.ai` endpoint, injects `XAI_API_KEY` into the
  **unchanged** `OpenAICompatAdapter` constructor, parallel to the `DEEPSEEK_API_KEY` arm.
  Ollama / other `openai-compat` endpoints keep the no-key behavior.

**Unchanged on purpose:** the `ProviderName` union (`src/providers/factory.ts:13`) is still
`"anthropic" | "openai" | "google" | "openai-compat" | "claude-code"` — Grok is **not** a
provider name; it is a model shorthand resolving to `openai-compat`. The `OpenAICompatAdapter`
constructor signature, the DeepSeek/Ollama paths, and `src/fleet/index.ts` are byte-unchanged.

## How to use / how it fits

Use `grok` (or `grok-4` / `grok-4-fast`) as a **model** shorthand — the harness infers the
`openai-compat` provider and the `https://api.x.ai/v1` endpoint, and reads the key from
`XAI_API_KEY`:

```jsonc
// bober.config.json — Grok via the model shorthand (provider + endpoint inferred)
{
  "planner": { "model": "grok-4" },
  "generator": { "model": "grok-4-fast" }
}
```

Set `XAI_API_KEY` in the environment (or pass `providerConfig.apiKey`). As with `deepseek`,
`grok` is a **model**, not a provider — `"provider": "grok"` would be rejected. Provider
setup details are in [`docs/providers.md`](../providers.md) under **Grok (xAI)**.

## Notes for maintainers

- **`api.x.ai` lives in exactly one place.** `isXaiEndpoint` is the single matcher (sc-1-6,
  grep-asserted in tests). If you need to match the host elsewhere, call `isXaiEndpoint` —
  do not re-inline the substring. The same pattern is recommended for DeepSeek (an optional
  `isDeepseekEndpoint` symmetry refactor was noted but not required, and was not done).
- **The grok model ids are placeholders, config-overridable.** `grok-4` / `grok-4-fast` are
  the default ids the shorthands resolve to; the actual model id is overridable via the
  child/role `config.model`. Tests assert **routing / endpoint / key wiring**, not a live API
  call — no test depends on `grok-4` being a real model id at xAI.
- **The fleet works for free.** `validateManifestCredentials` (`src/fleet/index.ts`) already
  forwards each child section's `endpoint` into `validateApiKey`, so the new xAI arm makes the
  pre-spawn credential check recognize Grok with **no edit** to the fleet loop. Do not add a
  Grok branch there.
- **Scope.** This sprint touched only `src/orchestrator/model-resolver.ts` +
  `src/providers/factory.ts` (and their collocated tests). Tier mapping / `FleetChild.tier`
  (Sprint 2) and the `ToolRoleGuard` (Sprint 3) are out of scope. Full suite: 2690 passed;
  fleet 203/203; the only failures are the 6 pre-existing `tests/e2e/cockpit-integration.test.ts`
  MCP "Connection closed" failures, confirmed unrelated.
