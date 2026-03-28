import { AnthropicAdapter } from "./anthropic.js";
import type { LLMClient } from "./types.js";
import { resolveProviderModel } from "../orchestrator/model-resolver.js";

/**
 * The set of provider names currently supported.
 * Additional providers (openai, google, openai-compat) will be added
 * in subsequent sprints.
 */
export type ProviderName = "anthropic";

/**
 * Create an LLMClient for the given provider.
 *
 * Provider resolution order:
 * 1. If `provider` is explicitly set, use it directly with `model` as-is.
 * 2. If `model` is set but `provider` is not, infer the provider from the
 *    model shorthand using resolveProviderModel().
 * 3. If neither is set, default to "anthropic".
 *
 * @param provider - Optional provider name. When omitted, inferred from model.
 * @param endpoint - Optional base URL override (used by OpenAI-compat adapters in future sprints).
 * @param providerConfig - Optional provider-specific configuration (e.g., apiKey).
 * @param model - Optional model string used for provider inference when provider is not set.
 * @returns An LLMClient instance for the resolved provider.
 * @throws If the resolved provider is unsupported.
 */
export function createClient(
  provider?: string | null,
  endpoint?: string | null,
  providerConfig?: Record<string, unknown>,
  model?: string,
): LLMClient {
  // Resolve provider: explicit wins; otherwise infer from model shorthand
  let resolvedProvider: string;
  let resolvedEndpoint: string | undefined = endpoint ?? undefined;

  if (provider) {
    resolvedProvider = provider;
  } else if (model) {
    const resolved = resolveProviderModel(model);
    resolvedProvider = resolved.provider;
    // Only use the inferred endpoint when the caller didn't supply one
    if (!resolvedEndpoint && resolved.endpoint) {
      resolvedEndpoint = resolved.endpoint;
    }
  } else {
    resolvedProvider = "anthropic";
  }

  const apiKey =
    typeof providerConfig?.["apiKey"] === "string"
      ? providerConfig["apiKey"]
      : undefined;

  switch (resolvedProvider) {
    case "anthropic":
      return new AnthropicAdapter(apiKey);
    default:
      throw new Error(
        `Unsupported provider: "${resolvedProvider}". Currently supported providers: anthropic.`,
      );
  }
}
