/**
 * Centralized model name resolution for multi-provider support.
 *
 * Maps user-friendly model shorthand names (from bober.config.json) to
 * actual provider + model ID pairs. Also handles explicit provider overrides
 * and the ollama/ prefix convention.
 */

export interface ResolvedModel {
  /** Provider name (e.g. "anthropic", "openai", "google", "openai-compat") */
  provider: string;
  /** Provider-native model ID (e.g. "claude-sonnet-4-6", "gpt-4.1") */
  modelId: string;
  /** Optional base URL override (set for ollama/ prefix models) */
  endpoint?: string;
}

/**
 * Shorthand -> { provider, modelId } mapping.
 * Keys are the shorthand names users write in bober.config.json.
 */
const SHORTHAND_MAP: Record<string, { provider: string; modelId: string }> = {
  // Anthropic
  opus: { provider: "anthropic", modelId: "claude-opus-4-7" },
  sonnet: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
  haiku: { provider: "anthropic", modelId: "claude-haiku-4-5" },
  // OpenAI
  "gpt-4.1": { provider: "openai", modelId: "gpt-4.1" },
  "gpt-4.1-mini": { provider: "openai", modelId: "gpt-4.1-mini" },
  o3: { provider: "openai", modelId: "o3" },
  "o4-mini": { provider: "openai", modelId: "o4-mini" },
  // Google
  "gemini-pro": { provider: "google", modelId: "gemini-2.5-pro" },
  "gemini-flash": { provider: "google", modelId: "gemini-2.5-flash" },
};

/**
 * Resolve a model string and optional explicit provider into a ResolvedModel.
 *
 * Resolution rules (in order):
 * 1. If `explicitProvider` is set, return it with `model` as-is (no shorthand expansion).
 * 2. If `model` starts with "ollama/", strip the prefix and resolve to openai-compat
 *    pointing at localhost:11434/v1.
 * 3. If `model` is a known shorthand, expand to the mapped provider/modelId.
 * 4. Otherwise, default provider to "anthropic" and pass model through as-is.
 *
 * @param model - Model string from config (shorthand or full ID).
 * @param explicitProvider - Optional provider override from config.
 * @returns Resolved provider, modelId, and optional endpoint.
 */
export function resolveProviderModel(
  model: string,
  explicitProvider?: string,
): ResolvedModel {
  // 1. Explicit provider — trust caller, pass model through unchanged
  if (explicitProvider) {
    return { provider: explicitProvider, modelId: model };
  }

  // 2. ollama/ prefix — local OpenAI-compatible server
  if (model.startsWith("ollama/")) {
    const modelId = model.slice("ollama/".length);
    return {
      provider: "openai-compat",
      modelId,
      endpoint: "http://localhost:11434/v1",
    };
  }

  // 3. Known shorthand
  const mapped = SHORTHAND_MAP[model];
  if (mapped) {
    return { provider: mapped.provider, modelId: mapped.modelId };
  }

  // 4. Unknown string — default to anthropic, pass through as-is
  return { provider: "anthropic", modelId: model };
}

/**
 * Resolve a model shorthand or exact model ID to the Anthropic model string.
 *
 * Kept for backward compatibility. Internally delegates to resolveProviderModel.
 * Returns only the modelId portion (suitable for direct Anthropic SDK calls).
 *
 * @deprecated Prefer resolveProviderModel for multi-provider workflows.
 */
export function resolveModel(choice: string): string {
  const { modelId } = resolveProviderModel(choice);
  return modelId;
}
