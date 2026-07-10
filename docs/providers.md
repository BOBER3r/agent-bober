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

### Provider refusals (`StopReason "refusal"`)

A provider **refusal** is surfaced provider-agnostically as `StopReason "refusal"`
(`src/providers/types.ts`) — a first-class outcome, never a silent success. Each adapter maps its
own refusal signal onto that value:

| Provider      | Refusal signal                                                                 |
| ------------- | ------------------------------------------------------------------------------ |
| `anthropic`   | `stop_reason: "refusal"`                                                        |
| `openai`      | `finish_reason: "content_filter"` **or** a non-empty `message.refusal` (structured-output refusal; takes precedence over the normal content path) |
| `openai-compat` (DeepSeek, Grok, Ollama, LM Studio) | inherits the OpenAI mapping via the shared adapter |
| `claude-code` | not applicable (text-only boundary; untouched)                                 |

`runAgenticLoop` detects a refusal at its completion branch and returns
`AgenticLoopResult.refused: true` — it **never throws**. The `refused` key is **absent** (not
`false`) on non-refusal runs, so ordinary completions are unchanged. **Write-capable roles**
(generator, curator) treat `refused` as `success: false`: a sprint whose provider refuses is
reported as a failed sprint (with the refusal excerpt in `notes`), even if some files were already
written — the refusal guard runs **before** the "files written implies success" shortcut.
**Read-only / advisory roles** (researcher, code-reviewer) surface the refusal text as their output
without failing the run.

### Per-request cost (`ChatResponse.costUsd`)

Every adapter populates an **optional** `costUsd` field on `ChatResponse`
(`src/providers/types.ts`) — the USD cost of that single request, when known. The field is
**additive and default-absent**: a request whose cost cannot be determined omits the key entirely
(it is **not** set to `undefined` or `0`), so callers must treat absence as **"unknown," never as
free**.

| Provider      | `costUsd` source                                                                 |
| ------------- | -------------------------------------------------------------------------------- |
| `claude-code` | the `claude` CLI's **real, vendor-authoritative** `total_cost_usd` — never an estimate (ADR-3). Absent when an older CLI doesn't report it. |
| `anthropic`   | a static `CostMeter` estimate (`estimateCostUsd`, `src/providers/cost-meter.ts`) |
| `openai`      | a `CostMeter` estimate                                                           |
| `openai-compat` (DeepSeek, Grok, Ollama, LM Studio) | a `CostMeter` estimate priced via the `openai-compat:` rows (a `costProvider` discriminator ensures DeepSeek/Grok use their own prices, not OpenAI's) |
| `google`      | not wired yet — the price rows exist but `GoogleAdapter` does not populate `costUsd` |

The `CostMeter` is a **pure, static** price table (`PRICE_TABLE`, `src/providers/cost-meter.ts`) of
best-known **list prices as of 2026-07** — a **guardrail estimate, not a bill**. Lookup is
longest-prefix match on `` `${provider}:${model}` `` (a specific model family wins over a broader
one); an unknown or unpriced model resolves to **absent** rather than a guessed number. The table is
**not** config-overridable and is **not** fetched at runtime. Only `claude-code` reports *actual*
spend.

This field is substrate for the `Budget` USD ceiling (`Budget.maxUsd` /
`BudgetExceededError` kind `"usd"`, `src/orchestrator/workflow/budget.ts`). The agentic loop **now
charges it per turn** — see [Per-role reasoning effort & USD budget ceiling](#per-role-reasoning-effort--usd-budget-ceiling)
below for the config that turns it on.

### Per-role reasoning effort & USD budget ceiling

Each per-role config section (`planner`, `curator`, `generator`, `evaluator`) accepts two
**optional, additive** fields on top of `provider` / `model` / `providerConfig`:

```jsonc
// bober.config.json — optional per-role effort + budget ceiling
{
  "generator": {
    "provider": "anthropic",
    "model": "sonnet",
    "effort": "high",            // low | medium | high | xhigh | max
    "budget": { "maxUsd": 5 }    // per-run USD ceiling; null/omitted = uncapped
  }
}
```

- **`effort`** — one of `low | medium | high | xhigh | max`. Forwarded into the request as
  `ChatParams.effort`, which the **Anthropic** adapter renders as `output_config.effort`.
  **Non-Anthropic adapters never carry it on the wire** — the field is inert for
  `openai` / `openai-compat` / `claude-code`.
- **`budget: { maxUsd }`** — a positive number, or `null` / omitted for **uncapped** (the default).
  The loop constructs a `Budget` from this value and **charges it once per turn** (tokens +
  `costUsd`, fed by the per-request cost above). When the ceiling is crossed, the run ends
  **gracefully at the next turn boundary** with `stopReason: "budget_exceeded"` and returns the
  partial result so far — the loop **never throws** `BudgetExceededError` (ADR-4), and the ceiling
  fires **between** turns, not mid-turn.

Both fields are **default-absent**: omit them and config parsing, the request payload, and the loop
invocation are all **byte-identical** to before (no defaults are injected). Per-run cost, when known,
is summed onto the loop result and surfaces as an **optional `costUsd`** on the generator result and
on the `sprint-passed` event in `.bober/history.jsonl` (absent when no cost was reported).

> **Wiring status.** The **generator** role reads `effort` / `budget.maxUsd` from config today. The
> other three sections accept the fields but do not yet wire them into their loop calls; the shared
> `budgetFromMaxUsd` helper (`src/orchestrator/workflow/budget.ts`) is the adoption point when they
> are. This repo's own `bober.config.json` sets neither field.

### Parallel read-only tool execution (`parallelReadOnlyTools`)

The **`generator`** config section accepts one more **optional, additive** boolean:

```jsonc
// bober.config.json
{
  "generator": {
    "provider": "anthropic",
    "model": "sonnet",
    "parallelReadOnlyTools": true   // overlap read-only tool calls in a turn; default off
  }
}
```

When `true`, within a single turn the agentic loop executes **maximal contiguous runs of
read-only-annotated tool calls concurrently** (via `Promise.all`) instead of strictly serially;
everything else stays serial. "Read-only" is a **`ToolDef.readOnly` annotation** that travels with
each tool schema (ADR-2 — the loop never hard-codes a tool-name allow-list), marked on exactly
`read_file`, `glob`, and `grep`. **`bash`, `write_file`, and `edit_file` are never annotated**, so a
turn's writes and any mixed batch stay serial (a write breaks the run). Results always preserve the
model's original tool-call order (keyed by `toolUseId`) and per-tool failures stay **in-slot** — the
batch never rejects.

- **Generator-only.** Unlike `effort` / `budget`, this flag lives **only** on `GeneratorSectionSchema`.
- **No default.** Omit it (or set `false`) and tool execution is **byte-identical** to the pre-change
  serial loop — same order, same error shapes, same `onToolUse` behaviour. `graph_*` and MCP-bridged
  tools have no `readOnly` annotation, so they run serially until they opt in explicitly.
- Delegated to `src/orchestrator/tools/executor.ts#executeToolBatch`; the loop derives its
  `readOnlyTools` set from the tool schemas it was configured with.

### Streaming text deltas (`ChatParams.onTextDelta`)

`ChatParams` (`src/providers/types.ts`) carries an **optional, provider-agnostic** streaming
callback `onTextDelta?: (delta: string) => void`. When set, an adapter that supports server-sent
streaming invokes it **once per text delta** as the response is generated; the **concatenation of
all deltas equals the final `ChatResponse.text`**. It is an **own type, safe for any adapter to
ignore** — a throwing callback **never kills the request** (the adapter wraps each invocation in
`try/catch`), and the returned `ChatResponse` (`text`, `toolCalls`, `stopReason`, `usage`, `costUsd`)
is **deep-equal** to what the same underlying response produces on the non-streaming path.

| Provider      | `onTextDelta` behavior                                                            |
| ------------- | -------------------------------------------------------------------------------- |
| `anthropic`   | **streams** — switches from `messages.create()` to the SDK's accumulating `messages.stream()`, forwards each `text_delta`, then normalizes the stream's `finalMessage()` through the **same** `normalizeResponse()` helper the non-streamed path uses |
| `openai`      | **no-op** — always uses the non-streaming completions endpoint; callback never invoked, nothing extra on the wire |
| `openai-compat` (DeepSeek, Grok, Ollama, LM Studio) | **no-op** — delegates to `OpenAIAdapter.chat()`, which never streams |
| `google`      | **no-op** — always uses the non-streaming `generateContent` call                 |
| `claude-code` | **no-op** — the `claude` CLI's text-only boundary stays; always parses the final JSON result |

Because streamed and non-streamed responses normalize identically, agentic **tool turns stream
safely**: a streamed `tool_use` block surfaces the same `toolCalls` (with ids and parsed inputs) as
the non-streaming path (tool calls surface only when complete — no partial-input streaming). A
**mid-stream provider error is not swallowed** — only the per-delta callback is `try/catch`'d, so
stream/`finalMessage()` errors propagate and get the **same `chatWithRetry` / `isTransientError`
classification** as a rejecting non-streaming call (transient retried, else `stopReason "error"`).

`runAgenticLoop` threads `onTextDelta` into **every** `chat()` call and, when its `onEvent` callback
is also set, additionally emits a `{ type: "text-delta", turn, delta }` `LoopEvent` per delta (see
[docs/sprints](./sprints/README.md) for the loop-event stream). The field is **default-absent**: omit
it and no `onTextDelta` key reaches the adapter, the Anthropic path uses non-streaming `create()`, and
the request payload + loop behavior are **byte-identical** to before.

> **Not yet combined with structured output.** Streaming and forced structured output
> (`responseSchema` / `tool_choice`) have no interaction guard: with both set, deltas fire while the
> final `text` is derived from the forced tool's JSON, so the delta-join-equals-`text` guarantee would
> **not** hold. Don't rely on that combination until it is explicitly documented or guarded.

### Mid-turn interrupt (`ChatParams.abortSignal`)

`ChatParams` (`src/providers/types.ts`) carries an **optional, provider-agnostic**
`abortSignal?: AbortSignal` — a **web-standard type, not an SDK type**, so it belongs on the
provider-agnostic surface. It is how a caller **cancels an in-flight request**. The loop layer
(`AgenticLoopParams.abortSignal`) threads the same signal into **every** `chat()` call, and
`runAgenticLoop` additionally checks it at each turn boundary; an aborted run resolves gracefully with
`StopReason "aborted"` plus accumulated partial telemetry — **never a throw** (see
[docs/sprints](./sprints/README.md) for the loop-level behavior). Absent the field, every adapter's
request is **byte-identical** — `create(body, undefined)` is identical to `create(body)`, and the
signal is **never** part of the request payload / on the wire.

| Provider      | `abortSignal` behavior                                                            |
| ------------- | -------------------------------------------------------------------------------- |
| `anthropic`   | **cancels in-flight** — forwarded as the SDK's `signal` request option (2nd arg) on **both** `messages.create()` and `messages.stream()`, so a streaming or non-streaming request is aborted the instant the signal fires (kept out of `requestBody`) |
| `openai`      | **boundary-degrade** — field ignored; the request completes, and the loop discards that response at its next post-response check without running its tools |
| `openai-compat` (DeepSeek, Grok, Ollama, LM Studio) | **boundary-degrade** — delegates to `OpenAIAdapter.chat()`, which ignores the signal |
| `google`      | **boundary-degrade** — field ignored; loop degrades at the boundary as above     |
| `claude-code` | **boundary-degrade** — the `claude` CLI path has no native cancellation; loop degrades at the boundary |

Because non-cancellable adapters only degrade at the loop **boundary**, their in-flight request runs to
completion but its response is **discarded** (usage never accumulated, `Budget` never charged, tool
batch never executed) rather than driving a further turn. On the Anthropic path the abort surfaces as
the SDK's `APIUserAbortError`; the loop classifies it as an abort via the **signal's own `aborted`
flag** (that error leaves `err.name` as `"Error"`, not `"AbortError"`) and **never retries** it.

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
