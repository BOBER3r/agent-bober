import { AnthropicAdapter } from "./anthropic.js";
import type { LLMClient } from "./types.js";

/**
 * The set of provider names currently supported.
 * Additional providers (openai, google, openai-compat) will be added
 * in subsequent sprints.
 */
export type ProviderName = "anthropic";

/**
 * Create an LLMClient for the given provider.
 *
 * @param provider - Provider name. Defaults to "anthropic".
 * @param _endpoint - Optional base URL override (used by OpenAI-compat adapters in future sprints).
 * @param providerConfig - Optional provider-specific configuration (e.g., apiKey).
 * @returns An LLMClient instance for the requested provider.
 * @throws If the provider is unsupported.
 */
export function createClient(
  provider: string = "anthropic",
  _endpoint?: string | null,
  providerConfig?: Record<string, unknown>,
): LLMClient {
  const apiKey =
    typeof providerConfig?.["apiKey"] === "string"
      ? providerConfig["apiKey"]
      : undefined;

  switch (provider) {
    case "anthropic":
      return new AnthropicAdapter(apiKey);
    default:
      throw new Error(
        `Unsupported provider: "${provider}". Currently supported providers: anthropic.`,
      );
  }
}
