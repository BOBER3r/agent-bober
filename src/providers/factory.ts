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
 * Validate that the required API key environment variable is set for a given provider.
 *
 * @param resolvedProvider - The resolved provider name.
 * @param role - Optional role label (e.g. "Planner", "Generator", "Evaluator") for the error message.
 * @param apiKey - Optional explicit API key from providerConfig (skips env var check if set).
 * @throws If the required environment variable is missing and no explicit apiKey was provided.
 */
export function validateApiKey(
  resolvedProvider: string,
  role?: string,
  apiKey?: string,
): void {
  const roleLabel = role ?? resolvedProvider;

  switch (resolvedProvider) {
    case "anthropic": {
      const key = apiKey ?? process.env["ANTHROPIC_API_KEY"];
      if (!key) {
        throw new Error(
          `${roleLabel} is configured to use Anthropic but ANTHROPIC_API_KEY is not set. ` +
            `Set the ANTHROPIC_API_KEY environment variable and try again.`,
        );
      }
      break;
    }
    case "openai": {
      const key = apiKey ?? process.env["OPENAI_API_KEY"];
      if (!key) {
        throw new Error(
          `${roleLabel} is configured to use OpenAI but OPENAI_API_KEY is not set. ` +
            `Set the OPENAI_API_KEY environment variable and try again.`,
        );
      }
      break;
    }
    case "google": {
      const key =
        apiKey ??
        process.env["GOOGLE_API_KEY"] ??
        process.env["GEMINI_API_KEY"];
      if (!key) {
        throw new Error(
          `${roleLabel} is configured to use Google Gemini but neither GOOGLE_API_KEY nor GEMINI_API_KEY is set. ` +
            `Set one of those environment variables and try again.`,
        );
      }
      break;
    }
    case "openai-compat":
      // API key is optional for Ollama and other local servers — skip validation.
      break;
    default:
      // Unknown providers: no validation, let createClient handle the error.
      break;
  }
}

/**
 * Create an LLMClient for the given provider.
 *
 * Provider resolution order:
 * 1. If `provider` is explicitly set, use it directly with `model` as-is.
 * 2. If `model` is set but `provider` is not, infer the provider from the
 *    model shorthand using resolveProviderModel().
 * 3. If neither is set, default to "anthropic".
 *
 * API key validation is performed before constructing any adapter. Pass a
 * `role` string (e.g. "Planner") so error messages identify which role is
 * misconfigured.
 *
 * @param provider - Optional provider name. When omitted, inferred from model.
 * @param endpoint - Optional base URL override (used by OpenAI-compat adapters).
 * @param providerConfig - Optional provider-specific configuration (e.g., apiKey).
 * @param model - Optional model string used for provider inference when provider is not set.
 * @param role - Optional role label used in API key error messages.
 * @returns An LLMClient instance for the resolved provider.
 * @throws If the resolved provider is unsupported or the required API key is missing.
 */
export function createClient(
  provider?: string | null,
  endpoint?: string | null,
  providerConfig?: Record<string, unknown>,
  model?: string,
  role?: string,
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

  // Validate API key before constructing the adapter.
  validateApiKey(resolvedProvider, role, apiKey);

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
