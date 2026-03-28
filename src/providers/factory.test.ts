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
 *
 * Sprint 6 additions:
 * - API key validation throws clear errors for missing env vars
 * - Explicit apiKey in providerConfig bypasses env var check
 * - openai-compat skips API key validation (key is optional)
 * - validateApiKey is exported and can be called independently
 */

import { describe, it, expect } from "vitest";
import { createClient, validateApiKey } from "./factory.js";
import { GoogleAdapter } from "./google.js";
import { OpenAICompatAdapter } from "./openai-compat.js";
import { OpenAIAdapter } from "./openai.js";
import { AnthropicAdapter } from "./anthropic.js";

// ── API key fixtures ─────────────────────────────────────────────────────────

const FAKE_ANTHROPIC_KEY = "sk-ant-fake-test-key";
const FAKE_OPENAI_KEY = "sk-fake-openai-test-key";
const FAKE_GOOGLE_KEY = "fake-google-api-key";

// ── createClient factory ─────────────────────────────────────────────────────

describe("createClient factory", () => {
  describe("google provider", () => {
    it("creates a GoogleAdapter for explicit provider 'google' with inline key", () => {
      const client = createClient(
        "google",
        null,
        { apiKey: FAKE_GOOGLE_KEY },
        "gemini-2.5-pro",
      );
      expect(client).toBeInstanceOf(GoogleAdapter);
    });

    it("creates a GoogleAdapter for gemini-pro shorthand with inline key", () => {
      const client = createClient(null, null, { apiKey: FAKE_GOOGLE_KEY }, "gemini-pro");
      expect(client).toBeInstanceOf(GoogleAdapter);
    });

    it("creates a GoogleAdapter for gemini-flash shorthand with inline key", () => {
      const client = createClient(null, null, { apiKey: FAKE_GOOGLE_KEY }, "gemini-flash");
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
    it("creates AnthropicAdapter for 'anthropic' with inline key", () => {
      const client = createClient(
        "anthropic",
        null,
        { apiKey: FAKE_ANTHROPIC_KEY },
      );
      expect(client).toBeInstanceOf(AnthropicAdapter);
    });

    it("creates OpenAIAdapter for 'openai' with inline key", () => {
      const client = createClient(
        "openai",
        null,
        { apiKey: FAKE_OPENAI_KEY },
        "gpt-4.1",
      );
      expect(client).toBeInstanceOf(OpenAIAdapter);
    });
  });

  describe("unsupported provider", () => {
    it("throws with updated error message listing all four providers", () => {
      expect(() =>
        // Pass a fake key so we get past the validation step to the unsupported-provider error
        createClient("unknown-provider", null, { apiKey: "x" }),
      ).toThrow(/anthropic, openai, google, openai-compat/);
    });
  });

  // ── API key validation ──────────────────────────────────────────────────────

  describe("API key validation", () => {
    describe("anthropic", () => {
      it("throws when ANTHROPIC_API_KEY is not set and no inline key provided", () => {
        const saved = process.env["ANTHROPIC_API_KEY"];
        delete process.env["ANTHROPIC_API_KEY"];

        try {
          expect(() => createClient("anthropic")).toThrow(/ANTHROPIC_API_KEY/);
        } finally {
          if (saved !== undefined) process.env["ANTHROPIC_API_KEY"] = saved;
        }
      });

      it("includes role label in error message when role is provided", () => {
        const saved = process.env["ANTHROPIC_API_KEY"];
        delete process.env["ANTHROPIC_API_KEY"];

        try {
          expect(() => createClient("anthropic", null, undefined, undefined, "Planner")).toThrow(
            /Planner/,
          );
        } finally {
          if (saved !== undefined) process.env["ANTHROPIC_API_KEY"] = saved;
        }
      });

      it("succeeds when ANTHROPIC_API_KEY env var is set", () => {
        const saved = process.env["ANTHROPIC_API_KEY"];
        process.env["ANTHROPIC_API_KEY"] = FAKE_ANTHROPIC_KEY;

        try {
          const client = createClient("anthropic");
          expect(client).toBeInstanceOf(AnthropicAdapter);
        } finally {
          if (saved !== undefined) {
            process.env["ANTHROPIC_API_KEY"] = saved;
          } else {
            delete process.env["ANTHROPIC_API_KEY"];
          }
        }
      });

      it("succeeds when inline apiKey is provided even without env var", () => {
        const saved = process.env["ANTHROPIC_API_KEY"];
        delete process.env["ANTHROPIC_API_KEY"];

        try {
          const client = createClient("anthropic", null, { apiKey: FAKE_ANTHROPIC_KEY });
          expect(client).toBeInstanceOf(AnthropicAdapter);
        } finally {
          if (saved !== undefined) process.env["ANTHROPIC_API_KEY"] = saved;
        }
      });
    });

    describe("openai", () => {
      it("throws when OPENAI_API_KEY is not set and no inline key provided", () => {
        const saved = process.env["OPENAI_API_KEY"];
        delete process.env["OPENAI_API_KEY"];

        try {
          expect(() => createClient("openai", null, undefined, "gpt-4.1")).toThrow(
            /OPENAI_API_KEY/,
          );
        } finally {
          if (saved !== undefined) process.env["OPENAI_API_KEY"] = saved;
        }
      });

      it("succeeds when inline apiKey is provided", () => {
        const saved = process.env["OPENAI_API_KEY"];
        delete process.env["OPENAI_API_KEY"];

        try {
          const client = createClient("openai", null, { apiKey: FAKE_OPENAI_KEY }, "gpt-4.1");
          expect(client).toBeInstanceOf(OpenAIAdapter);
        } finally {
          if (saved !== undefined) process.env["OPENAI_API_KEY"] = saved;
        }
      });
    });

    describe("google", () => {
      it("throws when neither GOOGLE_API_KEY nor GEMINI_API_KEY is set", () => {
        const savedGoogle = process.env["GOOGLE_API_KEY"];
        const savedGemini = process.env["GEMINI_API_KEY"];
        delete process.env["GOOGLE_API_KEY"];
        delete process.env["GEMINI_API_KEY"];

        try {
          expect(() =>
            createClient("google", null, undefined, "gemini-2.5-pro"),
          ).toThrow(/GOOGLE_API_KEY.*GEMINI_API_KEY/);
        } finally {
          if (savedGoogle !== undefined) process.env["GOOGLE_API_KEY"] = savedGoogle;
          if (savedGemini !== undefined) process.env["GEMINI_API_KEY"] = savedGemini;
        }
      });

      it("succeeds when GEMINI_API_KEY is set", () => {
        const savedGoogle = process.env["GOOGLE_API_KEY"];
        const savedGemini = process.env["GEMINI_API_KEY"];
        delete process.env["GOOGLE_API_KEY"];
        process.env["GEMINI_API_KEY"] = FAKE_GOOGLE_KEY;

        try {
          const client = createClient("google", null, undefined, "gemini-2.5-pro");
          expect(client).toBeInstanceOf(GoogleAdapter);
        } finally {
          if (savedGoogle !== undefined) {
            process.env["GOOGLE_API_KEY"] = savedGoogle;
          } else {
            delete process.env["GOOGLE_API_KEY"];
          }
          if (savedGemini !== undefined) {
            process.env["GEMINI_API_KEY"] = savedGemini;
          } else {
            delete process.env["GEMINI_API_KEY"];
          }
        }
      });
    });

    describe("openai-compat", () => {
      it("does not require an API key (Ollama-compatible)", () => {
        // Should not throw due to missing API key
        const client = createClient(
          "openai-compat",
          "http://localhost:11434/v1",
          undefined,
          "llama3",
        );
        expect(client).toBeInstanceOf(OpenAICompatAdapter);
      });
    });
  });
});

// ── validateApiKey standalone ────────────────────────────────────────────────

describe("validateApiKey", () => {
  it("throws for anthropic when env var absent", () => {
    const saved = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];

    try {
      expect(() => validateApiKey("anthropic")).toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      if (saved !== undefined) process.env["ANTHROPIC_API_KEY"] = saved;
    }
  });

  it("does not throw when explicit apiKey is passed", () => {
    const saved = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];

    try {
      expect(() => validateApiKey("anthropic", "Planner", FAKE_ANTHROPIC_KEY)).not.toThrow();
    } finally {
      if (saved !== undefined) process.env["ANTHROPIC_API_KEY"] = saved;
    }
  });

  it("does not throw for openai-compat regardless of key presence", () => {
    expect(() => validateApiKey("openai-compat")).not.toThrow();
  });

  it("does not throw for unknown providers", () => {
    expect(() => validateApiKey("some-future-provider")).not.toThrow();
  });
});
