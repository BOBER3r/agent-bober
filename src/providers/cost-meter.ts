/**
 * Static USD cost estimation for LLM chat requests.
 *
 * Pure, no I/O, no dependencies on any other module in this project (other
 * than a type-only import of {@link ProviderName}, which is erased at
 * runtime). Maps `(provider, model, tokenUsage)` to a USD estimate via a
 * static, in-repo price table keyed by `${provider}:${modelPrefix}` and
 * resolved by longest-prefix match — the most specific known model prefix
 * wins over a shorter/broader one.
 *
 * The `claude-code` provider is NEVER estimated here (ADR-3): the `claude`
 * CLI reports its own vendor-authoritative `total_cost_usd` (which also
 * accounts for cache-read/cache-creation tokens this module never sees), so
 * `estimateCostUsd` unconditionally returns `undefined` for it.
 *
 * An unknown `provider:model` pair also returns `undefined` rather than a
 * guessed number — callers must never surface a silently-wrong cost.
 */

import type { ProviderName } from "./factory.js";

/** Per-million-token list prices for one model family. */
export interface PriceRow {
  /** USD per 1,000,000 input tokens. */
  inputPerMillion: number;
  /** USD per 1,000,000 output tokens. */
  outputPerMillion: number;
}

/** Price table keyed by `${provider}:${modelPrefix}`, longest-prefix-match resolved. */
export type PriceTable = Record<string, PriceRow>;

// ── Static price table ──────────────────────────────────────────────
//
// Prices as of 2026-07 (list prices; guardrail semantics, not billing).
// Rows are keyed by `${provider}:${modelPrefix}` and matched by longest
// prefix of `${provider}:${model}` — a specific row (e.g. "gpt-4.1-mini")
// always wins over a shorter one that is also a valid prefix (e.g. "gpt-4.1").
//
// Only model families that appear in `orchestrator/model-resolver.ts`'s
// SHORTHAND_MAP are priced here. Anything else (including deliberately
// unpriced/unknown model strings) falls through to `undefined` — the safe
// fail-open per ADR-3, rather than a guessed number. Prices are NOT
// config-overridable and are NOT fetched at runtime (explicitly out of scope
// for this sprint).
export const PRICE_TABLE: PriceTable = {
  // Anthropic (direct API — not claude-code, which is never estimated)
  "anthropic:claude-opus-4": { inputPerMillion: 15, outputPerMillion: 75 },
  "anthropic:claude-sonnet-4": { inputPerMillion: 3, outputPerMillion: 15 },
  "anthropic:claude-haiku-4-5": { inputPerMillion: 1, outputPerMillion: 5 },

  // OpenAI
  "openai:gpt-4.1-mini": { inputPerMillion: 0.4, outputPerMillion: 1.6 },
  "openai:gpt-4.1": { inputPerMillion: 2, outputPerMillion: 8 },
  "openai:o4-mini": { inputPerMillion: 1.1, outputPerMillion: 4.4 },
  "openai:o3": { inputPerMillion: 10, outputPerMillion: 40 },

  // OpenAI-compatible: DeepSeek (api.deepseek.com)
  "openai-compat:deepseek-v4-pro": { inputPerMillion: 0.55, outputPerMillion: 2.19 },
  "openai-compat:deepseek-v4-flash": { inputPerMillion: 0.14, outputPerMillion: 0.28 },

  // OpenAI-compatible: xAI / Grok (api.x.ai)
  "openai-compat:grok-4-fast": { inputPerMillion: 0.2, outputPerMillion: 0.5 },
  "openai-compat:grok-4": { inputPerMillion: 3, outputPerMillion: 15 },

  // Google Gemini (not yet wired into GoogleAdapter — table row reserved
  // for when the adapter is updated to populate ChatResponse.costUsd)
  "google:gemini-2.5-pro": { inputPerMillion: 1.25, outputPerMillion: 5 },
  "google:gemini-2.5-flash": { inputPerMillion: 0.075, outputPerMillion: 0.3 },
};

/**
 * Estimate the USD cost of a single chat request from its token usage.
 *
 * Resolution: builds `${provider}:${model}`, finds every price-table key
 * that is a prefix of it, and picks the longest (most specific) match. When
 * no key matches, or `provider` is `"claude-code"`, returns `undefined` —
 * the caller must treat `undefined` as "unknown," never as zero.
 *
 * @param input.provider - The resolved provider name.
 * @param input.model - The provider-native model ID actually used for the request.
 * @param input.usage - Token usage for the request (inline shape — this module
 *   has zero cross-module dependencies by design; see file header).
 * @returns The estimated USD cost, or `undefined` if unknown/unpriced.
 */
export function estimateCostUsd(input: {
  provider: ProviderName;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}): number | undefined {
  // claude-code reports its own real cost; never estimate here (ADR-3).
  if (input.provider === "claude-code") return undefined;

  const fullKey = `${input.provider}:${input.model}`;
  const match = Object.keys(PRICE_TABLE)
    .filter((k) => fullKey.startsWith(k))
    .sort((a, b) => b.length - a.length)[0]; // longest-prefix wins

  if (match === undefined) return undefined;

  const row = PRICE_TABLE[match]!;
  return (
    (input.usage.inputTokens / 1_000_000) * row.inputPerMillion +
    (input.usage.outputTokens / 1_000_000) * row.outputPerMillion
  );
}
