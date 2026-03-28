/**
 * Unit tests for createClient factory.
 *
 * Tests cover the new provider cases added in Sprint 5:
 * - 'google' provider creates GoogleAdapter
 * - 'openai-compat' provider creates OpenAICompatAdapter
 * - ollama/ model prefix auto-resolves to openai-compat with correct endpoint
 * - gemini-pro shorthand resolves to google provider
 * - Unsupported provider throws with updated error message
 * - Missing endpoint for openai-compat throws descriptive error
 */

import { describe, it, expect } from "vitest";
import { createClient } from "./factory.js";
import { GoogleAdapter } from "./google.js";
import { OpenAICompatAdapter } from "./openai-compat.js";
import { OpenAIAdapter } from "./openai.js";
import { AnthropicAdapter } from "./anthropic.js";

describe("createClient factory", () => {
  describe("google provider", () => {
    it("creates a GoogleAdapter for explicit provider 'google'", () => {
      const client = createClient("google", null, undefined, "gemini-2.5-pro");
      expect(client).toBeInstanceOf(GoogleAdapter);
    });

    it("creates a GoogleAdapter for gemini-pro shorthand", () => {
      const client = createClient(null, null, undefined, "gemini-pro");
      expect(client).toBeInstanceOf(GoogleAdapter);
    });

    it("creates a GoogleAdapter for gemini-flash shorthand", () => {
      const client = createClient(null, null, undefined, "gemini-flash");
      expect(client).toBeInstanceOf(GoogleAdapter);
    });
  });

  describe("openai-compat provider", () => {
    it("creates an OpenAICompatAdapter for explicit provider 'openai-compat' with endpoint", () => {
      const client = createClient(
        "openai-compat",
        "http://localhost:11434/v1",
        undefined,
        "llama3",
      );
      expect(client).toBeInstanceOf(OpenAICompatAdapter);
    });

    it("auto-resolves ollama/llama3 to openai-compat with Ollama endpoint", () => {
      const client = createClient(null, null, undefined, "ollama/llama3");
      expect(client).toBeInstanceOf(OpenAICompatAdapter);
    });

    it("auto-resolves ollama/mistral:7b to openai-compat", () => {
      const client = createClient(null, null, undefined, "ollama/mistral:7b");
      expect(client).toBeInstanceOf(OpenAICompatAdapter);
    });

    it("accepts endpoint from providerConfig when explicit endpoint is absent", () => {
      const client = createClient(
        "openai-compat",
        null,
        { endpoint: "http://my-server/v1" },
        "llama3",
      );
      expect(client).toBeInstanceOf(OpenAICompatAdapter);
    });

    it("throws when openai-compat has no endpoint source", () => {
      expect(() =>
        createClient("openai-compat", null, undefined, "llama3"),
      ).toThrow(/requires an endpoint/);
    });
  });

  describe("existing providers still work", () => {
    it("creates AnthropicAdapter for 'anthropic'", () => {
      const client = createClient("anthropic");
      expect(client).toBeInstanceOf(AnthropicAdapter);
    });

    it("creates OpenAIAdapter for 'openai'", () => {
      const client = createClient("openai", null, undefined, "gpt-4.1");
      expect(client).toBeInstanceOf(OpenAIAdapter);
    });
  });

  describe("unsupported provider", () => {
    it("throws with updated error message listing all four providers", () => {
      expect(() => createClient("unknown-provider")).toThrow(
        /anthropic, openai, google, openai-compat/,
      );
    });
  });
});
