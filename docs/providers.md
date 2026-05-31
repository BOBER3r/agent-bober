# Provider Configuration Guide

This guide covers all supported providers in agent-bober: how to configure each one,
which roles each supports, and what prerequisites are required.

**Scope:** Everything in this guide applies to the **standalone CLI / programmatic
provider layer** (`npx agent-bober run …`), where bober calls each provider's API
directly. It does **not** apply to the **Claude Code plugin** — when you run a skill
such as `/bober-run` inside Claude Code, the pipeline roles are spawned as Claude Code
subagents on your Claude subscription, and provider selection (including `claude-code`)
is irrelevant. Install the plugin with `/plugin marketplace add BOBER3r/agent-bober`
then `/plugin install bober@agent-bober`; see the README for details.

agent-bober **never persists API keys**. Keys are read from the environment (or
`providerConfig` at runtime). `.env` is gitignored — see `.gitignore` lines 10-12
(`.env`, `.env.local`, `.env.*.local`).

---

## Providers at a Glance

### Capability Matrix

| Role                   | anthropic (default)  | deepseek (openai-compat) | claude-code (subscription) |
| ---------------------- | -------------------- | ------------------------ | -------------------------- |
| planner                | yes                  | yes                      | yes (no tools needed)      |
| researcher (phase 1/2) | yes                  | yes                      | yes (no tools needed)      |
| curator                | yes                  | yes (tools)              | no (runs own loop)         |
| generator              | yes                  | yes (tools)              | no (runs own loop)         |
| evaluator              | yes                  | yes (tools)              | no (runs own loop)         |
| code-reviewer          | yes                  | yes (tools)              | no (runs own loop)         |

claude-code is valid only for roles that send no `tools`. For tool-using roles, if
claude-code is configured alongside another provider, the other provider is used. If
claude-code is the **only** configured provider for a tool role, that is a configuration
error surfaced at load time.

---

## Anthropic (default)

No extra install required. Set `ANTHROPIC_API_KEY` in your environment.

```jsonc
// bober.config.json — Anthropic (default)
{
  "planner": {
    "provider": "anthropic",
    "model": "opus"
  },
  "researcher": {
    "provider": "anthropic",
    "model": "sonnet"
  },
  "curator": {
    "provider": "anthropic",
    "model": "sonnet"
  },
  "generator": {
    "provider": "anthropic",
    "model": "sonnet"
  },
  "evaluator": {
    "provider": "anthropic",
    "model": "haiku"
  }
}
```

Shorthands (`opus`, `sonnet`, `haiku`) resolve to the latest model version automatically.

---

## DeepSeek

**Prerequisites:**

- Install the OpenAI SDK (used as an OpenAI-compatible client): `npm install openai`
- Set `DEEPSEEK_API_KEY` in your environment (get a key at <https://platform.deepseek.com>).

DeepSeek is routed through the built-in `openai-compat` adapter pointed at
`https://api.deepseek.com`. It supports **all** agent roles including tool-calling roles
(curator, generator, evaluator, code-reviewer), making it a cost-effective full-capability
alternative to Anthropic.

```jsonc
// bober.config.json — DeepSeek via openai-compat
{
  "planner": {
    "provider": "openai-compat",
    "model": "deepseek-v4-pro",
    "providerConfig": {
      "endpoint": "https://api.deepseek.com",
      "apiKey": "env:DEEPSEEK_API_KEY"
    }
  },
  "researcher": {
    "provider": "openai-compat",
    "model": "deepseek-v4-flash",
    "providerConfig": {
      "endpoint": "https://api.deepseek.com",
      "apiKey": "env:DEEPSEEK_API_KEY"
    }
  },
  "generator": {
    "provider": "openai-compat",
    "model": "deepseek-v4-pro",
    "providerConfig": {
      "endpoint": "https://api.deepseek.com",
      "apiKey": "env:DEEPSEEK_API_KEY"
    }
  },
  "evaluator": {
    "provider": "openai-compat",
    "model": "deepseek-v4-flash",
    "providerConfig": {
      "endpoint": "https://api.deepseek.com",
      "apiKey": "env:DEEPSEEK_API_KEY"
    }
  }
}
```

Or use the shorthand `deepseek` / `deepseek-v4-pro` / `deepseek-v4-flash` to have the
harness set the endpoint automatically:

```jsonc
// bober.config.json — DeepSeek shorthand
{
  "planner": { "provider": "deepseek", "model": "deepseek-v4-pro" },
  "generator": { "provider": "deepseek", "model": "deepseek-v4-pro" }
}
```

---

## claude-code (Subscription)

**Prerequisites:**

- An active Claude subscription (Pro, Max, or Team). **No `ANTHROPIC_API_KEY` required.**
- The `claude` CLI must be installed and authenticated on PATH (`claude --version` must succeed).

**Important limitations and cost considerations:**

- claude-code is **planner and researcher only**. It cannot be used for curator, generator,
  evaluator, or code-reviewer because those roles require tool-calling, which the
  `claude -p` interface does not support. Attempting to configure claude-code for a
  tool-using role without a fallback provider is a hard configuration error.
- As of the **2026-06-15 ToS update**, programmatic subscription use via the Agent SDK is
  **metered** (a separate monthly Agent-SDK credit equal to the plan fee, billed at API
  rates, with no rollover). claude-code is **not** "free unlimited."
- Each `claude -p` invocation injects approximately **40,000 tokens of system-prompt
  overhead**, which counts against metered usage. For high-frequency pipelines, DeepSeek
  or Anthropic API is likely more economical.

```jsonc
// bober.config.json — claude-code for planner + researcher only
// Tool-using roles (curator, generator, evaluator) must use a different provider.
{
  "planner": {
    "provider": "claude-code",
    "model": "opus",
    "providerConfig": {
      "binary": "claude",
      "timeoutMs": 120000
    }
  },
  "researcher": {
    "provider": "claude-code",
    "model": "sonnet",
    "providerConfig": {
      "binary": "claude",
      "timeoutMs": 60000
    }
  },
  "curator": {
    "provider": "anthropic",
    "model": "sonnet"
  },
  "generator": {
    "provider": "anthropic",
    "model": "sonnet"
  },
  "evaluator": {
    "provider": "anthropic",
    "model": "haiku"
  }
}
```

---

## Security: No Key Persistence

agent-bober **never writes API keys to disk**. Keys are read from:

- The process environment (`ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, etc.).
- `providerConfig.apiKey` in `bober.config.json` at runtime (not persisted by the harness).

`.env` is gitignored (`.gitignore` entries: `.env`, `.env.local`, `.env.*.local`). Never
commit a real key or `.env` file to version control.
