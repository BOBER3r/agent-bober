# Cost substrate: CostMeter price table, ChatResponse.costUsd, Budget maxUsd

**Contract:** sprint-spec-20260709-agent-loop-capability-port-2  ·  **Spec:** spec-20260709-agent-loop-capability-port  ·  **Completed:** 2026-07-09

## What this sprint added

This second sprint of the agent-loop capability port builds the **money layer** with **no loop
changes** — every symbol it adds is **dormant** until Sprint 3 wires it in. A new pure
`estimateCostUsd` maps `(provider, model, tokenUsage)` to a USD estimate via a static, dated,
in-repo price table (longest-prefix match; unknown or unpriced → `undefined`, never a guess). Every
API adapter now populates an **optional** `ChatResponse.costUsd`: `claude-code` returns its **real,
previously-discarded** `total_cost_usd` and **never estimates** (ADR-3), while `anthropic` /
`openai` / `openai-compat` derive the estimate from the `CostMeter`. `Budget` gains an **additive**
`maxUsd` ceiling alongside its existing tokens/agents axes, with a `BudgetExceededError` kind
`"usd"`. Everything is **byte-identical when absent** — the `costUsd` key is omitted (not
`undefined`-valued) on unpriced requests, and `Budget` has **zero production callers** this sprint.
No new dependency.

## Public surface

- `estimateCostUsd({ provider, model, usage })` (`src/providers/cost-meter.ts:86`) — pure, no I/O,
  no cross-module runtime deps (only a type-only import of `ProviderName`). Builds
  `` `${provider}:${model}` ``, finds every `PRICE_TABLE` key that is a prefix of it, and returns the
  **longest** (most specific) match's `inputTokens/1e6·in + outputTokens/1e6·out`. Returns
  `undefined` for `claude-code` unconditionally and for any unknown/unpriced pair.
- `PRICE_TABLE` (`src/providers/cost-meter.ts:46`) — static `PriceTable` dated **`2026-07` (list
  prices; guardrail semantics, not billing)**. Rows (each a real model-family prefix drawn from
  `model-resolver.ts` SHORTHAND_MAP — no broad catch-alls like `anthropic:claude`, which would
  falsely prefix-match unknown models):
  - `anthropic:` `claude-opus-4` (15/75), `claude-sonnet-4` (3/15), `claude-haiku-4-5` (1/5)
  - `openai:` `gpt-4.1-mini` (0.4/1.6), `gpt-4.1` (2/8), `o4-mini` (1.1/4.4), `o3` (10/40)
  - `openai-compat:` `deepseek-v4-pro` (0.55/2.19), `deepseek-v4-flash` (0.14/0.28),
    `grok-4-fast` (0.2/0.5), `grok-4` (3/15)
  - `google:` `gemini-2.5-pro` (1.25/5), `gemini-2.5-flash` (0.075/0.3) — **reserved**; `GoogleAdapter`
    is **not** wired this sprint (see Notes).
- `PriceRow` / `PriceTable` types (`src/providers/cost-meter.ts:23`, `:31`) — `{ inputPerMillion,
  outputPerMillion }` and the `Record<`` `${provider}:${modelPrefix}` ``, PriceRow>` alias.
- `ChatResponse.costUsd?: number` (`src/providers/types.ts:238`) — **optional**. Real
  vendor-authoritative cost for `claude-code`; a `CostMeter` estimate for other providers. The key is
  **absent** (not `undefined`-valued) when the cost cannot be determined. `LLMClient.chat` signature
  unchanged.
- `OpenAIAdapter.costProvider` (`src/providers/openai.ts:340`) — new `protected readonly` provider
  discriminator, default `"openai"`. `OpenAICompatAdapter` **overrides** it to `"openai-compat"`
  (`src/providers/openai-compat.ts:36`) so DeepSeek/Grok price via the compat rows even though they
  share the parent's `chat()`.
- `Budget.maxUsd` axis (`src/orchestrator/workflow/budget.ts`) — `BudgetOptions.maxUsd?: number |
  null` (null/omitted = unlimited); `chargeUsd(usd)` (NaN/±Infinity/negative → no-op),
  `usdSpent` getter, `remainingUsd()` (`Infinity` when uncapped); `exceeded()` and
  `assertWithinBudget()` extended to the USD axis; `BudgetExceededError.kind` union grows `"usd"`.

## How to use / how it fits

No new command, flag, or config key — the price table is **not** config-overridable and is **not**
fetched at runtime (all explicit non-goals). The surface is a substrate the next sprint consumes:

- Adapters populate `costUsd` automatically wherever they already normalize `usage`. A caller can
  read it, but **must treat `undefined`/absence as "unknown," never as `0`** — an unpriced model
  (or an older `claude` CLI without `total_cost_usd`) simply omits the key.
- The `Budget` USD axis mirrors the existing tokens/agents shape and is meant to be fed from
  `costUsd`:

  ```ts
  const budget = new Budget({ maxUsd: 5 });
  budget.chargeUsd(response.costUsd ?? 0); // absent/undefined cost is a safe no-op
  budget.assertWithinBudget();             // throws BudgetExceededError { kind: "usd" } at the ceiling
  ```

Provider cost-source summary:

| Provider family | `costUsd` source |
| --- | --- |
| `claude-code` | the CLI's real `total_cost_usd` (vendor-authoritative; never a `CostMeter` estimate) |
| `anthropic` | `estimateCostUsd({ provider: "anthropic", … })` |
| `openai` | `estimateCostUsd({ provider: "openai", … })` |
| `openai-compat` (DeepSeek, Grok, Ollama, LM Studio) | `estimateCostUsd({ provider: "openai-compat", … })` via the `costProvider` override |
| `google` | **not wired this sprint** (price rows reserved) |

## Notes for maintainers

- **`undefined` is "unknown," not "free."** Both `estimateCostUsd` and `ChatResponse.costUsd` fail
  **open** to absence — an unpriced model must never surface a silently-wrong number. Any future
  consumer that sums costs has to skip/`?? 0` the absent key rather than assume zero cost was real.
- **Prices are a guardrail, not a bill.** The table carries best-known list prices as of
  **2026-07**; refresh the dated comment and rows when vendor pricing changes. `claude-code` is the
  only source of *actual* spend.
- **No broad catch-all rows on purpose.** Every key is a concrete model-family prefix from
  `model-resolver.ts` SHORTHAND_MAP. Adding a shorter row like `anthropic:claude` would make
  `claude-nonexistent-99` falsely prefix-match and defeat the fail-open. Add new rows at the full
  model-family granularity.
- **`costProvider` is the DeepSeek/Grok fix.** `OpenAICompatAdapter` reuses `OpenAIAdapter.chat()`;
  without the `protected` override its requests would price against OpenAI's rows. When adding a new
  openai-compat vendor, add its price rows under the `openai-compat:` prefix — no adapter change
  needed.
- **`GoogleAdapter` is intentionally unwired.** `sc-2-3` scoped adapter wiring to
  anthropic/openai/openai-compat; the `google:` rows exist (satisfying `sc-2-1`) but nothing
  populates `ChatResponse.costUsd` for Gemini yet. Wiring it is a one-line `estimateCostUsd` call at
  its usage-normalization site.
- **`claude-code.ts` has no `cost-meter` import (ADR-3).** It threads the already-parsed
  `total_cost_usd` via conditional spread; do not route it through the `CostMeter`.
- **`Budget` is dormant.** No production caller charges USD yet (Sprint 3 wires the ceiling into the
  loop). All pre-existing token/agent `Budget` tests are unchanged and the non-USD path is
  byte-identical; `package.json` / `src/config` were untouched.
- **Scope.** Four commits (`8d68248`, `c73b95d`, `d5c8b9d`, `73053c0`) touched 13 files
  (2 new: `cost-meter.ts` + its test) — the nine `estimatedFiles` plus the four collocated adapter
  test files. Full suite **3731/3731** green (3699 baseline + 32 new); all 6 required criteria
  (sc-2-1..2-6) passed iteration 1, no regressions.
- **Follow-ups (later in this spec, out of scope here):** Sprint 3 wires `Budget.maxUsd` (fed from
  `costUsd`) into the agentic loop and adds the config schema + history/report persistence of cost;
  per-role effort and parallel read-only tool execution remain.
