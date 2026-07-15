# Structure Outline: Multi-Provider — DeepSeek + Claude Code

**Spec ID:** spec-20260531-multi-provider-deepseek-claude-code

## Phase 1: Fix eslint peer-dep conflict (US-001) — unblocks install
**Key Changes:** Bump `eslint` devDependency to `^10`; regenerate lockfile; apply any eslint-10 flat-config shims in `eslint.config.js` (no rule changes).
**Files:** package.json, package-lock.json, eslint.config.js
**Test Checkpoint:** `npm install` exits 0 with no ERESOLVE; `npm run lint`, `npm run build`, `npm test` all pass.
**Depends On:** nothing

## Phase 2: DeepSeek shorthand + key resolution (US-002, US-003)
**Key Changes:** Add `deepseek`/`deepseek-v4-pro`/`deepseek-v4-flash` to `SHORTHAND_MAP` → openai-compat @ `https://api.deepseek.com`; add `DEEPSEEK_API_KEY` env fallback in the openai-compat key chain; DeepSeek-specific missing-key error in `validateApiKey` when endpoint is api.deepseek.com.
**Files:** src/orchestrator/model-resolver.ts, src/providers/factory.ts, src/providers/openai-compat.ts, src/orchestrator/model-resolver.test.ts, src/providers/factory.test.ts, src/providers/openai-compat.test.ts
**Test Checkpoint:** Unit tests: `resolveProviderModel("deepseek-v4-pro")` returns deepseek endpoint; key-present and key-missing paths verified with mocked openai client.
**Depends On:** Phase 1

## Phase 3: openai optional-peer preflight + missing-package error (US-004)
**Key Changes:** Verify existing `'requires the "openai" package'` throw fires; add a preflight that warns (actionable hint) when a DeepSeek/OpenAI provider is configured but `openai` is not installed, before the first model call.
**Files:** src/providers/factory.ts (or new src/providers/preflight.ts), src/providers/openai.ts, src/providers/preflight.test.ts
**Test Checkpoint:** Unit test: preflight with openai absent emits the hint; with openai present is silent; missing-package error asserted in openai adapter test.
**Depends On:** Phase 2

## Phase 4: Promote claude-code provider into the factory (US-005)
**Key Changes:** Add `"claude-code"` to `ProviderName` and `createClient` switch → `ClaudeCodeAdapter`; `validateApiKey("claude-code")` requires no key but preflights `claude` binary on PATH; honor `providerConfig.binary`/`timeoutMs`; export from index.ts; tests mock execa.
**Files:** src/providers/factory.ts, src/providers/claude-code.ts, src/providers/index.ts, src/providers/claude-code.test.ts, src/providers/factory.test.ts
**Test Checkpoint:** Unit tests (mocked execa): completion maps result/usage; tools-passed throws; binary-missing preflight errors clearly.
**Depends On:** Phase 3

## Phase 5: Role-aware provider fallback for claude-code (US-006)
**Key Changes:** New `resolveRoleProviders(config)` helper: tool roles (curator/generator/evaluator/code-reviewer) on claude-code fall back to another configured provider; hard-error when claude-code is the sole option for a tool role; planner/researcher always allowed; log each role's resolved provider. Call it at config load.
**Files:** src/config/role-providers.ts, src/config/loader.ts, src/config/role-providers.test.ts
**Test Checkpoint:** Unit tests: fallback applied; hard error when sole provider for a tool role; no-tool roles unaffected; resolution logged.
**Depends On:** Phase 4

## Phase 6: Documentation + key-gated smoke scripts (US-007, US-008)
**Key Changes:** Update README "Supported Providers" with the capability matrix/costs/ToS; add `docs/providers.md` with copy-paste config per provider + no-key-persistence note; ensure `scripts/spike-deepseek.mjs` and a claude-code smoke are key/binary-gated and excluded from `npm test`.
**Files:** README.md, docs/providers.md, scripts/spike-deepseek.mjs, scripts/provider-smoke.mjs
**Test Checkpoint:** Markdownlint passes on docs; smoke scripts skip (exit 0) when key/binary absent; `npm test` does not invoke them.
**Depends On:** Phase 5
