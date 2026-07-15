# Design Discussion: Multi-Provider — DeepSeek + Claude Code Subscription

**Spec ID:** spec-20260531-multi-provider-deepseek-claude-code
**Date:** 2026-05-31
**Status:** reviewed

---

## Current State

The provider architecture established by spec-20260328 lives in `src/providers/`:
- `types.ts` — `LLMClient.chat()` interface, `ChatParams`, `ChatResponse`, `ToolDef`.
- `factory.ts` — `createClient(provider, endpoint, providerConfig, model, role)` and `validateApiKey()`. `ProviderName` (line 11) = `anthropic | openai | google | openai-compat`. `validateApiKey` for `openai-compat` skips validation entirely (line 87-89: "key optional for Ollama").
- `src/orchestrator/model-resolver.ts` — `SHORTHAND_MAP` (line 22) and `resolveProviderModel()`. Handles anthropic/openai/google shorthands and the `ollama/` prefix; no DeepSeek entry.
- `openai.ts` — `OpenAIAdapter` dynamically `import("openai")` and throws `'OpenAI provider requires the "openai" package. Run: npm install openai'` (line 284-286). Key resolution falls back to `process.env["OPENAI_API_KEY"]` (line 293).
- `openai-compat.ts` — `OpenAICompatAdapter extends OpenAIAdapter`, passes `apiKey ?? "not-needed"`.
- `claude-code.ts` — SPIKE adapter already present. Shells `claude -p --output-format json ...`, throws on non-empty `tools` (line 112-119), maps stop_reason/usage. Constructor takes `binary` and `timeoutMs`. NOT wired into `factory.ts` or `index.ts`.

Each role-agent calls `createClient(config.<role>.provider ?? null, config.<role>.endpoint ?? null, config.<role>.providerConfig, config.<role>.model)` — see `planner-agent.ts:147`. Role schemas (`schema.ts`) all carry optional `provider`, `endpoint`, `providerConfig`.

Gaps: `package.json` pins `eslint@^9.19.0` while `@eslint/js@^10.0.1` requires eslint 10 (ERESOLVE on clean install). No DeepSeek shorthand, no `DEEPSEEK_API_KEY` fallback, no DeepSeek-specific missing-key error, claude-code not in factory, no role-aware fallback, no preflight for missing `openai`, no provider docs.

## Desired End State

- `npm install` exits 0 with no ERESOLVE (`eslint@^10`).
- `resolveProviderModel("deepseek"|"deepseek-v4-pro"|"deepseek-v4-flash")` → `{ provider: "openai-compat", modelId, endpoint: "https://api.deepseek.com" }`.
- openai-compat key resolution adds `DEEPSEEK_API_KEY` fallback; `validateApiKey` gives a DeepSeek-specific error when endpoint is `api.deepseek.com`.
- `createClient(provider: "claude-code")` returns `ClaudeCodeAdapter`; `validateApiKey("claude-code")` requires no key but preflights the `claude` binary on PATH.
- New `resolveRoleProviders(config)` helper applies role-aware fallback for claude-code on tool roles; hard-errors when claude-code is the sole option for a tool role; logs each role's resolved provider.
- A preflight check warns when a DeepSeek/OpenAI provider is configured but `openai` is not installed.
- README + `docs/providers.md` document the capability matrix, costs, ToS, prerequisites, no-key-persistence.
- `scripts/spike-deepseek.mjs` (key-gated) plus a claude-code smoke, excluded from `npm test`.

## Patterns to Follow

- `src/orchestrator/model-resolver.ts` — `SHORTHAND_MAP` literal + `resolveProviderModel` switch is the model-mapping pattern; tests in `model-resolver.test.ts`.
- `src/providers/factory.ts` — `validateApiKey` switch + `createClient` switch is where new providers/keys are wired; tests in `factory.test.ts`.
- `src/providers/openai.ts` (line 280-298) — dynamic `import("openai")` + missing-package throw is the optional-peer pattern; key env fallback chain.
- `src/providers/claude-code.ts` — the adapter shape to promote (already implements `LLMClient`).
- `src/orchestrator/planner-agent.ts:147` — the `createClient(provider, endpoint, providerConfig, model)` call shape every role-agent uses.
- `src/config/schema.ts` — Zod `*SectionSchema` with optional `provider/endpoint/providerConfig`; `BoberConfigSchema` is the config-load entry; tests use `z.parse`.
- `src/utils/logger.ts` — `logger` for the resolution-decision logging in US-006.

## Resolved Design Decisions

### Q1: tech-constraints — Map only deepseek v4 line, or also deepseek-reasoner/deepseek-chat?
**Decision:** v4 line only (`deepseek`, `deepseek-v4-pro`, `deepseek-v4-flash`).
**Rationale:** PRD Open Questions leans "v4 only to avoid shipping soon-dead aliases" (reasoner/chat deprecate 2026-07-24). Task instructions confirm "map only the deepseek v4 line."

### Q2: tech-constraints — claude-code `--model` mapping or pass-through?
**Decision:** Pass the model string through verbatim (adapter already does `args.push("--model", model)` at claude-code.ts:137-139).
**Rationale:** Lowest-risk; the spike already passes verbatim. No shorthand expansion needed since claude-code roles set their own model string.

### Q3: error-handling — openai-compat preflight: hard error or warning?
**Decision:** Warning (actionable hint), not hard error.
**Rationale:** PRD US-004 says "prints an actionable hint BEFORE the first model call"; Open Question leans warning because "users may set it intentionally and install openai later." Keep the existing call-time hard error as the backstop.

### Q4: tech-constraints — generic `DEEPSEEK_API_KEY` special-case acceptable?
**Decision:** Yes, special-case `DEEPSEEK_API_KEY` keyed on endpoint `api.deepseek.com`.
**Rationale:** PRD FR-3 specifies exactly this; per-endpoint configurable key-env is explicitly deferred (Non-Goals: "Other OpenAI-compatible vendors beyond DeepSeek").

### Q5: tech-constraints — eslint 10 flat-config breakage scope?
**Decision:** Upgrade `eslint` to `^10`, run lint, fix only flat-config shims required by eslint 10; no rule changes.
**Rationale:** PRD US-001 AC: "No change to lint rules (only the version + any required config shims)." `eslint.config.js` exists (flat config). `@eslint/js@^10.0.1` already present.

## Open Questions

None blocking. All four PRD Open Questions resolved above with PRD/task-instruction evidence. The exact set of eslint-10 flat-config shims (if any) is discovered empirically during US-001 by running `npm run lint`; the contract's success criteria gate on lint passing rather than predicting the diff.
