import { AnthropicAdapter } from "./anthropic.js";
import { OpenAIAdapter } from "./openai.js";
import { GoogleAdapter } from "./google.js";
import { OpenAICompatAdapter } from "./openai-compat.js";
import type { LLMClient } from "./types.js";
import { resolveProviderModel } from "../orchestrator/model-resolver.js";

/**
 * The set of provider names currently supported.
 */
export type ProviderName = "anthropic" | "openai" | "google" | "openai-compat";

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
  // endpoint is used by OpenAI and openai-compat adapters as a base URL

  // Resolve provider: explicit wins; otherwise infer from model shorthand
  let resolvedProvider: string;

  if (provider) {
    resolvedProvider = provider;
  } else if (model) {
    const resolved = resolveProviderModel(model);
    resolvedProvider = resolved.provider;
  } else {
    resolvedProvider = "anthropic";
  }

  const apiKey =
    typeof providerConfig?.["apiKey"] === "string"
      ? providerConfig["apiKey"]
      : undefined;

  // Resolve the model ID (for cases where provider was inferred from shorthand)
  const resolvedModelId =
    !provider && model
      ? resolveProviderModel(model).modelId
      : model ?? resolvedProvider;

  switch (resolvedProvider) {
    case "anthropic":
      return new AnthropicAdapter(apiKey);
    case "openai":
      return new OpenAIAdapter(
        resolvedModelId,
        apiKey ?? process.env["OPENAI_API_KEY"],
        endpoint ?? undefined,
        providerConfig,
      );
    case "google":
      return new GoogleAdapter(
        resolvedModelId,
        apiKey ?? process.env["GOOGLE_API_KEY"] ?? process.env["GEMINI_API_KEY"],
      );
    case "openai-compat": {
      // Resolve endpoint: explicit arg wins, then model resolution (for ollama/ prefix),
      // then providerConfig, then error.
      const resolvedEndpoint =
        endpoint ??
        (!provider && model ? resolveProviderModel(model).endpoint : undefined) ??
        (typeof providerConfig?.["endpoint"] === "string"
          ? providerConfig["endpoint"]
          : undefined);

      if (!resolvedEndpoint) {
        throw new Error(
          'OpenAI-compatible provider requires an endpoint. Set endpoint in provider config or use the "ollama/" model prefix.',
        );
      }

      return new OpenAICompatAdapter(resolvedEndpoint, resolvedModelId, apiKey);
    }
    default:
      throw new Error(
        `Unsupported provider: "${resolvedProvider}". Supported providers: anthropic, openai, google, openai-compat.`,
      );
  }
}
