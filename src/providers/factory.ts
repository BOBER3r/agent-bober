import { AnthropicAdapter } from "./anthropic.js";
import { OpenAIAdapter } from "./openai.js";
import { GoogleAdapter } from "./google.js";
import { OpenAICompatAdapter } from "./openai-compat.js";
import type { LLMClient, ChatParams, ChatResponse } from "./types.js";
import { resolveProviderModel } from "../orchestrator/model-resolver.js";

/**
 * The set of provider names currently supported.
 */
export type ProviderName = "anthropic" | "openai" | "google" | "openai-compat";

// ── Deterministic stub (BOBER_TEST_DETERMINISTIC) ─────────────────────────────
//
// When BOBER_TEST_DETERMINISTIC=1 is set in the environment, createClient()
// returns a stub LLMClient that immediately returns a deterministic "abort me"
// response instead of calling any real LLM provider. This prevents e2e tests
// from hitting real API endpoints or failing due to missing API keys.
//
// The stub returns end_turn immediately with empty tool calls, which causes
// the agentic loop to terminate. The pipeline will fail (no plan produced),
// but the run is still tracked in RunManager and can be tested via the
// list/abort MCP tools.
//
// Sprint 6 (cockpit-integration)

class DeterministicStubClient implements LLMClient {
  async chat(_params: ChatParams): Promise<ChatResponse> {
    return {
      text: "[BOBER_TEST_DETERMINISTIC] Stub response — no real LLM call made.",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}

/**
 * Validate that the required API key environment variable is set for a given provider.
 *
 * @param resolvedProvider - The resolved provider name.
 * @param role - Optional role label (e.g. "Planner", "Generator", "Evaluator") for the error message.
 * @param apiKey - Optional explicit API key from providerConfig (skips env var check if set).
 * @param endpoint - Optional endpoint URL used to distinguish DeepSeek from other openai-compat servers.
 * @throws If the required environment variable is missing and no explicit apiKey was provided.
 */
export function validateApiKey(
  resolvedProvider: string,
  role?: string,
  apiKey?: string,
  endpoint?: string,
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
      // API key is optional for Ollama and other local servers.
      // DeepSeek (api.deepseek.com) requires a key — check specifically for it.
      if (endpoint?.includes("api.deepseek.com")) {
        const key = apiKey ?? process.env["DEEPSEEK_API_KEY"];
        if (!key) {
          throw new Error(
            `${roleLabel} is configured to use DeepSeek but neither providerConfig.apiKey nor DEEPSEEK_API_KEY is set. ` +
              `Set the DEEPSEEK_API_KEY environment variable and try again.`,
          );
        }
      }
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
  // ── BOBER_TEST_DETERMINISTIC guard ─────────────────────────────────
  // When set, skip all provider resolution and return a stub client.
  // This suppresses real LLM calls in e2e tests (cockpit-integration sprint 6).
  if (process.env["BOBER_TEST_DETERMINISTIC"] === "1") {
    return new DeterministicStubClient();
  }

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

  // Hoist endpoint resolution so validateApiKey can distinguish DeepSeek from
  // other openai-compat servers (e.g. Ollama). Explicit arg wins, then model
  // resolution (for deepseek/ and ollama/ shorthands), then providerConfig.
  const resolvedEndpoint =
    endpoint ??
    (!provider && model ? resolveProviderModel(model).endpoint : undefined) ??
    (typeof providerConfig?.["endpoint"] === "string"
      ? providerConfig["endpoint"]
      : undefined);

  // Validate API key before constructing the adapter.
  validateApiKey(resolvedProvider, role, apiKey, resolvedEndpoint);

  // Resolve the model ID (for cases where provider was inferred from shorthand)
  const resolvedModelId =
    !provider && model
      ? resolveProviderModel(model).modelId
      : model ?? resolvedProvider;

  switch (resolvedProvider) {
    case "anthropic": {
      const promptCaching =
        typeof providerConfig?.["promptCaching"] === "boolean"
          ? providerConfig["promptCaching"]
          : true;
      return new AnthropicAdapter(apiKey, { promptCaching });
    }
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
      if (!resolvedEndpoint) {
        throw new Error(
          'OpenAI-compatible provider requires an endpoint. Set endpoint in provider config or use the "ollama/" model prefix.',
        );
      }

      // Inject DEEPSEEK_API_KEY env fallback only for the api.deepseek.com endpoint.
      // Ollama and other openai-compat endpoints keep the no-key (not-needed) behavior.
      const compatKey =
        apiKey ??
        (resolvedEndpoint.includes("api.deepseek.com")
          ? process.env["DEEPSEEK_API_KEY"]
          : undefined);

      return new OpenAICompatAdapter(resolvedEndpoint, resolvedModelId, compatKey);
    }
    default:
      throw new Error(
        `Unsupported provider: "${resolvedProvider}". Supported providers: anthropic, openai, google, openai-compat.`,
      );
  }
}
