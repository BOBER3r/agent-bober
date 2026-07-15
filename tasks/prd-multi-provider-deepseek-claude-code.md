# PRD: Multi-Provider Strategy — DeepSeek + Claude Code Subscription

## Introduction/Overview

agent-bober currently calls Claude through a metered `ANTHROPIC_API_KEY`. Two
gaps motivated this work:

1. **Cost / model choice.** Users want cheaper or alternative frontier models.
   DeepSeek v4-pro is OpenAI-compatible and — *proven live in a spike* — already
   works through agent-bober's existing `openai-compat` adapter **with full tool
   calling on every role**, at a fraction of Anthropic's cost.
2. **Subscription billing.** Claude Max subscribers want calls billed against
   their subscription instead of a per-token API key. The `claude` CLI in
   headless mode (`claude -p --output-format json`) does this — *also proven
   live* — but it runs its OWN tool loop and cannot return custom `tool_use`
   blocks, so it only works for prompt→text roles (planner, researcher).

This PRD turns both proven spikes into shippable, documented features, keeping
`anthropic` as the default. It also fixes a pre-existing eslint peer-dependency
conflict that breaks `npm install`.

### Empirical findings this PRD is built on (already verified)
- DeepSeek: `createClient("openai-compat","https://api.deepseek.com",…,"deepseek-v4-pro")`
  returned a normal completion AND a correct `tool_use` (`read_file` with parsed
  `file_path`). **Zero new adapter code needed.**
- claude-code: `claude -p --output-format json` returned `{result, stop_reason,
  usage}` with NO `ANTHROPIC_API_KEY` set (subscription auth). Throws by design
  when custom tools are passed.
- The `openai` package is an OPTIONAL peerDependency (not installed by default).
- `npm install` fails today with ERESOLVE: `@eslint/js@10` requires `eslint@^10`
  but `eslint@9` is installed.
- ToS (2026-06-15): programmatic subscription use is ALLOWED but METERED
  (separate monthly Agent-SDK credit = plan fee, billed at API rates, no
  rollover). So claude-code is NOT "free unlimited"; DeepSeek is the cheaper
  full-capability path.

## Goals

- Make DeepSeek a first-class, documented provider usable for ALL roles via a
  `deepseek` / `deepseek-v4-pro` shorthand → `openai-compat` @
  `https://api.deepseek.com`.
- Add a `claude-code` provider that bills against a Claude subscription (no API
  key) for prompt→text roles, with a clear capability boundary.
- Make `claude-code` a graceful FALLBACK: when a tool-using role needs a
  provider and another tool-capable provider is configured, prefer that one;
  use `claude-code` only when it is the sole option.
- Fix the eslint peer-dependency conflict so `npm install` (and therefore
  `npm install openai`) succeeds without `--legacy-peer-deps`.
- Keep `anthropic` as the default provider; DeepSeek and claude-code are opt-in.
- Document the provider capability matrix, prerequisites, and costs honestly.

## Provider Capability Matrix (the core of this feature)

| Role | anthropic (default) | deepseek (openai-compat) | claude-code (subscription) |
|------|---------------------|--------------------------|----------------------------|
| planner | ✅ | ✅ | ✅ (no tools needed) |
| researcher (phase 1/2) | ✅ | ✅ | ✅ (no tools needed) |
| curator | ✅ | ✅ (tools) | ❌ runs own loop |
| generator | ✅ | ✅ (tools) | ❌ runs own loop |
| evaluator | ✅ | ✅ (tools) | ❌ runs own loop |
| code-reviewer | ✅ | ✅ (tools) | ❌ runs own loop |

**Rule:** `claude-code` is valid only for roles that send no `tools`. For
tool-using roles, if `claude-code` is configured but another provider is also
configured, the other provider is used; if `claude-code` is the only configured
provider for a tool role, that is a configuration error surfaced at load time.

## User Stories

### US-001: Fix eslint peer-dependency conflict (unblocks everything)
**Description:** As a developer, I need `npm install` to succeed without
`--legacy-peer-deps` so optional peers like `openai` can be installed cleanly.

**Acceptance Criteria:**
- [ ] Upgrade `eslint` devDependency to `^10` to satisfy `@eslint/js@^10` peer.
- [ ] `npm install` completes with exit 0 and NO ERESOLVE error on a clean tree.
- [ ] `npm run lint` still runs (eslint.config.js compatible with eslint 10; fix
      any flat-config breakages).
- [ ] `npm run build` and `npm test` pass after the upgrade.
- [ ] No change to lint *rules* (only the version + any required config shims).

### US-002: DeepSeek shorthand in model-resolver
**Description:** As a user, I want to write `"deepseek-v4-pro"` (or `"deepseek"`)
in bober.config.json and have it resolve to the DeepSeek endpoint.

**Acceptance Criteria:**
- [ ] `SHORTHAND_MAP` (or resolver logic) maps `deepseek` and `deepseek-v4-pro`
      (and `deepseek-v4-flash`) to `{ provider: "openai-compat", modelId:
      "deepseek-v4-pro" (resp. flash), endpoint: "https://api.deepseek.com" }`.
- [ ] `resolveProviderModel("deepseek-v4-pro")` returns the DeepSeek endpoint.
- [ ] Explicit `provider: "openai-compat"` + `endpoint` still works unchanged
      (no regression to the ollama/ path or existing behavior).
- [ ] Unit tests cover the new shorthands. Typecheck + lint pass.

### US-003: DeepSeek API key resolution + validation
**Description:** As a user, I want agent-bober to read my DeepSeek key from a
sensible place and fail clearly if it's missing.

**Acceptance Criteria:**
- [ ] DeepSeek key resolves from `providerConfig.apiKey` else
      `process.env.DEEPSEEK_API_KEY` (add this fallback to the openai-compat
      path; do NOT hardcode any key).
- [ ] `validateApiKey` for a DeepSeek-resolved openai-compat target gives a
      DeepSeek-specific error ("set DEEPSEEK_API_KEY") rather than the generic
      Ollama "key optional" skip, when the endpoint is api.deepseek.com.
- [ ] No API key is ever written to a committed file; `.env` remains gitignored.
- [ ] Unit tests for key-present and key-missing. Typecheck + lint pass.

### US-004: `openai` optional-peer-dep prerequisite (DX + clear error)
**Description:** As a user choosing DeepSeek/OpenAI, I need a clear path to
install the required `openai` package.

**Acceptance Criteria:**
- [ ] The existing "OpenAI provider requires the openai package" error is kept
      and verified to fire when openai is absent.
- [ ] README + docs document `npm install openai` as the prerequisite for
      `openai`, `openai-compat`, and `deepseek` providers.
- [ ] `agent-bober` startup (or `init`) detects a DeepSeek/OpenAI provider in
      config without `openai` installed and prints an actionable hint BEFORE the
      first model call (preflight check), not a deep stack trace.
- [ ] Typecheck + lint pass.

### US-005: Promote claude-code provider (subscription, no key)
**Description:** As a Claude Max subscriber, I want planner/researcher calls to
bill against my subscription via the `claude` CLI.

**Acceptance Criteria:**
- [ ] `ClaudeCodeAdapter` (from the spike) moved into the supported provider set;
      `createClient` accepts `provider: "claude-code"`.
- [ ] `validateApiKey` for `claude-code` requires NO API key; instead it
      preflight-checks that the `claude` binary is on PATH and errors clearly if
      not.
- [ ] `chat()` still throws a clear error if `tools` are passed (no silent drop).
- [ ] Maps stop_reason/usage into `ChatResponse` (already implemented; add tests
      using a mocked execa so no real subscription call in CI).
- [ ] Config supports `providerConfig.binary` and `timeoutMs` overrides.
- [ ] Typecheck + lint pass.

### US-006: Role-aware provider fallback for claude-code
**Description:** As a user who sets claude-code globally, I want tool-using roles
to automatically use another configured provider, and to be told if none exists.

**Acceptance Criteria:**
- [ ] At config load: if a tool-using role (curator/generator/evaluator/
      code-reviewer) resolves to `claude-code` AND another provider is configured
      (per-role override or a non-claude-code default), that role uses the other
      provider.
- [ ] If a tool-using role resolves to `claude-code` and NO other provider is
      configured, config load FAILS with an explicit message naming the role and
      explaining claude-code cannot drive tools.
- [ ] planner/researcher on claude-code are always allowed (no tools).
- [ ] The resolution decision is logged (which provider each role ended up on).
- [ ] Unit tests for: fallback applied, hard error when sole provider, no-tool
      roles unaffected. Typecheck + lint pass.

### US-007: Documentation — provider matrix, costs, ToS
**Description:** As a user, I need honest guidance on which provider to pick.

**Acceptance Criteria:**
- [ ] README "Supported Providers" updated with the capability matrix above.
- [ ] Documents: anthropic = default; deepseek = cheap, all roles, needs
      `npm install openai` + `DEEPSEEK_API_KEY`; claude-code = subscription,
      planner/researcher only, metered per 2026-06-15 ToS (link), `claude -p`
      injects ~40k-token system prompt overhead per call.
- [ ] A short `docs/providers.md` with copy-paste config examples for each.
- [ ] Explicitly states agent-bober never persists API keys; use env/.env.
- [ ] Markdownlint passes.

### US-008: End-to-end provider smoke (opt-in, key-gated)
**Description:** As a maintainer, I want a repeatable way to verify each provider
without baking secrets into CI.

**Acceptance Criteria:**
- [ ] Keep `scripts/spike-deepseek.mjs` (or fold into a `scripts/provider-smoke.mjs`)
      that runs only when the relevant key/binary is present; skips otherwise.
- [ ] Covers: deepseek completion + tool_use; claude-code completion + tools-guard
      throw.
- [ ] Documented as manual/local, NOT part of `npm test` (no secrets in CI).

## Functional Requirements

- FR-1: Upgrade `eslint` to `^10`; `npm install` succeeds with no ERESOLVE.
- FR-2: `resolveProviderModel` maps `deepseek`, `deepseek-v4-pro`,
  `deepseek-v4-flash` → openai-compat @ `https://api.deepseek.com`.
- FR-3: openai-compat key resolution adds `DEEPSEEK_API_KEY` env fallback and a
  DeepSeek-specific missing-key error when the endpoint is api.deepseek.com.
- FR-4: `createClient` supports `provider: "claude-code"` → `ClaudeCodeAdapter`,
  requiring no API key but preflighting the `claude` binary.
- FR-5: `ClaudeCodeAdapter.chat()` throws when `tools` is non-empty.
- FR-6: Config-load resolution: tool-using roles never run on `claude-code` if
  any other provider is configured; hard error if claude-code is the only option
  for a tool role.
- FR-7: Preflight check warns when a DeepSeek/OpenAI provider is configured but
  the `openai` package is not installed.
- FR-8: README + `docs/providers.md` document the capability matrix, costs, ToS,
  prerequisites, and the no-key-persistence rule.
- FR-9: No secrets committed; `.env` stays gitignored; smoke scripts are key-gated
  and excluded from CI `npm test`.

## Non-Goals (Out of Scope)

- Making `claude-code` work for tool-using roles (would require driving
  agent-bober's tools THROUGH Claude Code's native loop via custom MCP — a
  separate, much larger effort; explicitly deferred).
- Changing the default provider away from `anthropic`.
- Adding the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) as a dependency.
- Auto-installing `openai` on the user's behalf.
- Bundling/committing any API key, or a key manager/secrets vault.
- Cost dashboards or usage metering UI.
- Other OpenAI-compatible vendors beyond DeepSeek (the pattern generalizes, but
  only DeepSeek is in-scope to document/test here).

## Technical Considerations

- Providers live in `src/providers/`: `LLMClient.chat()` interface (`types.ts`),
  `factory.ts` (`createClient`, `validateApiKey`), `model-resolver.ts`
  (`SHORTHAND_MAP`, `resolveProviderModel`).
- `OpenAICompatAdapter` extends `OpenAIAdapter`; both dynamically `import("openai")`
  so it stays an optional peer. The dynamic import resolves relative to the
  importing module, so `openai` must be in agent-bober's own `node_modules`.
- The spike's `src/providers/claude-code.ts` and `scripts/spike-deepseek.mjs`
  exist on branch `spike/claude-code-provider` and are the implementation
  starting point.
- claude-code adapter shells `claude -p PROMPT --output-format json
  --disallowed-tools "..." --strict-mcp-config [--append-system-prompt S]
  [--model M]` and parses the JSON `result`.
- Tests must mock `execa` (claude-code) and the `openai` client (deepseek) so CI
  needs no binary, no subscription, and no keys.
- eslint 10 upgrade may require flat-config (`eslint.config.js`) tweaks; verify
  `@typescript-eslint/*` versions remain compatible.

## Success Metrics

- `npm install` on a clean clone succeeds with exit 0, no `--legacy-peer-deps`.
- A user can run the full pipeline on DeepSeek by setting `DEEPSEEK_API_KEY`,
  `npm install openai`, and `model: "deepseek-v4-pro"` — all roles including
  tool-driven ones complete.
- A Max subscriber can set planner/researcher to `claude-code` and run those
  phases with no `ANTHROPIC_API_KEY`.
- Misconfiguring a tool role to claude-code (with no alternative) fails at load
  with a clear message, never mid-sprint.
- Docs let a new user pick the right provider in under 2 minutes.

## Open Questions

- Should `deepseek-reasoner`/`deepseek-chat` (deprecating 2026-07-24) be mapped
  too, or only the v4 line? (Leaning v4 only to avoid shipping soon-dead aliases.)
- For claude-code, should we expose `--model` mapping (e.g. bober `opus` →
  `--model opus`) or pass the model string through verbatim?
- Should the openai-compat preflight be a hard error or a warning when the role
  is non-default (some users may set it intentionally and install openai later)?
- Is a generic `openai-compat` + `DEEPSEEK_API_KEY` special-case acceptable, or
  should key-env be configurable per endpoint (future multi-vendor)?
