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

| Role                   | anthropic (default)  | deepseek (openai-compat) | grok / xAI (openai-compat) | claude-code (subscription) |
| ---------------------- | -------------------- | ------------------------ | -------------------------- | -------------------------- |
| planner                | yes                  | yes                      | yes                        | yes (no tools needed)      |
| researcher (phase 1/2) | yes                  | yes                      | yes                        | yes (no tools needed)      |
| curator                | yes                  | yes (tools)              | yes (tools)                | no (runs own loop)         |
| generator              | yes                  | yes (tools)              | yes (tools)                | no (runs own loop)         |
| evaluator              | yes                  | yes (tools)              | yes (tools)                | no (runs own loop)         |
| code-reviewer          | yes                  | yes (tools)              | yes (tools)                | no (runs own loop)         |

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

### Provider-agnostic PDF document blocks (`ChatParams.documents`)

The programmatic provider layer exposes an **additive, optional** `documents` field on `ChatParams`
(`src/providers/types.ts`):

```ts
documents?: { base64: string; mediaType: string }[];
```

This is a **provider-agnostic input shape**: each adapter renders it in that provider's native document
format, prepended to the **first user message**:

| Provider      | Native rendering                                                                 |
| ------------- | -------------------------------------------------------------------------------- |
| `anthropic`   | `document` content block (`{ type: "document", source: { type: "base64", media_type, data } }`) |
| `openai`      | `file` content part (`{ type: "file", file: { filename, file_data: "data:<mime>;base64,<…>" } }`) |
| `google`      | `inlineData` part (`{ inlineData: { mimeType, data } }`)                          |

Providers that have **no document-input surface** fail loudly rather than silently dropping the PDF (a
dropped document would let the model answer from nothing):

- **`openai-compat`** (DeepSeek, Grok, Ollama, LM Studio, …) — throws a clear "does not support `documents`"
  error. These endpoints share OpenAI's wire format but not its file-input capability.
- **`claude-code`** — throws; the `claude` CLI accepts only a text prompt.

A request **without** `documents` (or with an empty array) renders byte-identically to prior behaviour on
every adapter — so adding the field never changes existing calls. The medical lab-PDF parser
(`parseLabPdf`, `src/medical/lab-pdf-parser.ts`) is the first consumer: it pairs `documents` with
`responseSchema` to extract a Zod-validated structured lab report, and works against any provider that
renders documents (Anthropic, OpenAI, or Gemini) — route the call to one of those, not to an
`openai-compat`/`claude-code` client.

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

Or use the model shorthand `deepseek` / `deepseek-v4-pro` / `deepseek-v4-flash` with **no**
`provider` field — the harness infers the `openai-compat` provider and sets the
`https://api.deepseek.com` endpoint automatically:

```jsonc
// bober.config.json — DeepSeek shorthand (provider + endpoint inferred from the model)
{
  "planner": { "model": "deepseek-v4-pro" },
  "generator": { "model": "deepseek-v4-pro" }
}
```

> Write the shorthand as a **model**, not a provider. `"provider": "deepseek"` is rejected
> ("unsupported provider") — `deepseek` is a model shorthand that resolves to the
> `openai-compat` provider, not a provider name of its own.

---

## Grok (xAI)

**Prerequisites:**

- Install the OpenAI SDK (used as an OpenAI-compatible client): `npm install openai`
- Set `XAI_API_KEY` in your environment (get a key at <https://console.x.ai>).

Grok is **not a provider of its own** — like DeepSeek, it is routed through the built-in
`openai-compat` adapter, pointed at `https://api.x.ai/v1`. xAI exposes an OpenAI-wire-compatible
API, so the same adapter handles it unchanged, and Grok supports **all** agent roles including
the tool-calling roles (curator, generator, evaluator, code-reviewer).

```jsonc
// bober.config.json — Grok via openai-compat
{
  "planner": {
    "provider": "openai-compat",
    "model": "grok-4",
    "providerConfig": {
      "endpoint": "https://api.x.ai/v1",
      "apiKey": "env:XAI_API_KEY"
    }
  },
  "generator": {
    "provider": "openai-compat",
    "model": "grok-4-fast",
    "providerConfig": {
      "endpoint": "https://api.x.ai/v1",
      "apiKey": "env:XAI_API_KEY"
    }
  }
}
```

Or use the model shorthand `grok` / `grok-4` / `grok-4-fast` with **no** `provider` field — the
harness infers the `openai-compat` provider and sets the `https://api.x.ai/v1` endpoint
automatically:

```jsonc
// bober.config.json — Grok shorthand (provider + endpoint inferred from the model)
{
  "planner": { "model": "grok-4" },
  "generator": { "model": "grok-4-fast" }
}
```

> Write the shorthand as a **model**, not a provider. Like `deepseek`, `grok` is a model
> shorthand that resolves to the `openai-compat` provider — `"provider": "grok"` is rejected.
> If `XAI_API_KEY` is unset and no `providerConfig.apiKey` is supplied for an `api.x.ai`
> endpoint, the harness fails fast with a clear "configured to use Grok/xAI but `XAI_API_KEY`
> is not set" error.

> The `grok-4` / `grok-4-fast` model ids the shorthands resolve to are sensible defaults;
> override the exact model id via the role's `model` field if xAI's catalog changes.

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

- The process environment (`ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `XAI_API_KEY`, etc.).
- `providerConfig.apiKey` in `bober.config.json` at runtime (not persisted by the harness).

`.env` is gitignored (`.gitignore` entries: `.env`, `.env.local`, `.env.*.local`). Never
commit a real key or `.env` file to version control.
