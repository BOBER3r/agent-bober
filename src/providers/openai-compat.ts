/**
 * OpenAI-compatible provider adapter.
 *
 * Creates an OpenAI client pointed at a custom base URL, enabling use with
 * any OpenAI-compatible API server (e.g. Ollama, LM Studio, vLLM, Together AI).
 *
 * Reuses all tool conversion, message conversion, and response normalisation
 * logic from OpenAIAdapter by extending it with a custom base URL and a
 * default API key of "not-needed" (required by the openai SDK but ignored
 * by servers like Ollama that don't require authentication).
 */

import { OpenAIAdapter } from "./openai.js";
import type { LLMClient } from "./types.js";

/**
 * LLMClient implementation for OpenAI-compatible endpoints.
 *
 * Extends OpenAIAdapter with a required `endpoint` (baseURL) parameter.
 * All tool conversion and response normalisation is inherited from
 * OpenAIAdapter — only the client configuration differs.
 *
 * Usage example (Ollama):
 * ```ts
 * const client = new OpenAICompatAdapter(
 *   "http://localhost:11434/v1",
 *   "llama3",
 * );
 * ```
 */
export class OpenAICompatAdapter extends OpenAIAdapter implements LLMClient {
  /**
   * @param endpoint - Required base URL of the OpenAI-compatible server
   *   (e.g. "http://localhost:11434/v1" for Ollama).
   * @param model - Model identifier to use with this server.
   * @param apiKey - Optional API key. Defaults to "not-needed" for servers
   *   that do not require authentication (e.g. Ollama).
   */
  constructor(endpoint: string, model: string, apiKey?: string) {
    // Pass "not-needed" as apiKey default — the openai SDK requires a non-empty
    // value but OpenAI-compat servers (like Ollama) typically ignore it.
    super(model, apiKey ?? "not-needed", endpoint);
  }
}
