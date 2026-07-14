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
 *
 * Sprint 1 (prompt caching) additions (C4):
 * - createClient reads promptCaching from providerConfig and forwards it to
 *   the AnthropicAdapter constructor; defaults to true for the anthropic provider.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createClient, validateApiKey, preflightClaudeBinary, isXaiEndpoint } from "./factory.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { GoogleAdapter } from "./google.js";
import { OpenAICompatAdapter } from "./openai-compat.js";
import { OpenAIAdapter } from "./openai.js";

// ── AnthropicAdapter mock ────────────────────────────────────────────────────
//
// We mock ./anthropic.js so that the AnthropicAdapter constructor does NOT
// call into the real Anthropic SDK (which would require a live API key), and
// so we can capture the exact arguments passed to the constructor.
//
// IMPORTANT: vi.mock is hoisted by vitest to the top of the module, so the
// factory function must be fully self-contained (no references to outer
// variables).  We store constructor call records on the class itself so they
// are accessible from inside the hoisted closure AND from the test body.

vi.mock("./anthropic.js", () => {
  // Shared recorder attached to the class so it survives hoisting.
  const calls: Array<[string | undefined, { promptCaching?: boolean } | undefined]> = [];

  class AnthropicAdapter {
    static readonly _ctorCalls = calls;

    constructor(apiKey?: string, opts?: { promptCaching?: boolean }) {
      calls.push([apiKey, opts]);
    }

    // Minimal duck-type to prevent runtime errors in factory tests.
    chat = () => Promise.resolve({ content: "", usage: { inputTokens: 0, outputTokens: 0 } });
    countTokens = () => Promise.resolve(0);
  }

  return { AnthropicAdapter };
});

// Import AnthropicAdapter AFTER vi.mock so the test file holds the mocked
// class (needed for instanceof assertions and to access _ctorCalls).
const { AnthropicAdapter } = await import("./anthropic.js");

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

  // ── claude-code provider (sc-4-1, sc-4-2) ───────────────────────────────────

  describe("claude-code provider", () => {
    it("sc-4-1: createClient returns a ClaudeCodeAdapter instance", () => {
      const client = createClient("claude-code", null, undefined, "opus");
      expect(client).toBeInstanceOf(ClaudeCodeAdapter);
    });

    it("sc-4-1: createClient returns ClaudeCodeAdapter with default binary when no providerConfig", () => {
      const client = createClient("claude-code");
      expect(client).toBeInstanceOf(ClaudeCodeAdapter);
    });

    it("sc-4-2: validateApiKey('claude-code') does not throw when no API key and no ANTHROPIC_API_KEY are set", () => {
      const saved = process.env["ANTHROPIC_API_KEY"];
      delete process.env["ANTHROPIC_API_KEY"];
      try {
        expect(() => validateApiKey("claude-code")).not.toThrow();
      } finally {
        if (saved !== undefined) process.env["ANTHROPIC_API_KEY"] = saved;
      }
    });

    it("sc-4-2: preflightClaudeBinary throws naming the binary when probe reports absent", async () => {
      await expect(
        preflightClaudeBinary("claude", async () => false),
      ).rejects.toThrow(/claude/);
    });

    it("sc-4-2: preflightClaudeBinary throws naming a custom binary when probe reports absent", async () => {
      await expect(
        preflightClaudeBinary("my-claude", async () => false),
      ).rejects.toThrow(/my-claude/);
    });

    it("sc-4-2: preflightClaudeBinary does not throw when probe reports present", async () => {
      await expect(
        preflightClaudeBinary("claude", async () => true),
      ).resolves.toBeUndefined();
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

      // ── DeepSeek key validation (sc-2-4) ──────────────────────────────────
      it("throws with DEEPSEEK_API_KEY in message when key is absent for deepseek endpoint", () => {
        const saved = process.env["DEEPSEEK_API_KEY"];
        delete process.env["DEEPSEEK_API_KEY"];

        try {
          expect(() =>
            createClient(null, null, undefined, "deepseek-v4-pro"),
          ).toThrow(/DEEPSEEK_API_KEY/);
        } finally {
          if (saved !== undefined) process.env["DEEPSEEK_API_KEY"] = saved;
        }
      });

      it("does not throw for non-deepseek openai-compat endpoint when no key is set", () => {
        // Ollama must keep its no-key behavior even after the deepseek gate is added.
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

// ── promptCaching flag resolution (C4) ──────────────────────────────────────

describe("createClient promptCaching flag resolution", () => {
  beforeEach(() => {
    // Clear recorded constructor calls before each test so tests are isolated.
    (AnthropicAdapter as unknown as { _ctorCalls: unknown[] })._ctorCalls.length = 0;
  });

  it("forwards promptCaching: false to AnthropicAdapter constructor when explicitly set", () => {
    createClient("anthropic", null, { apiKey: FAKE_ANTHROPIC_KEY, promptCaching: false });

    const calls = (AnthropicAdapter as unknown as { _ctorCalls: Array<[string | undefined, { promptCaching?: boolean } | undefined]> })._ctorCalls;
    expect(calls).toHaveLength(1);
    const [, opts] = calls[0]!;
    expect(opts).toEqual({ promptCaching: false });
  });

  it("defaults promptCaching to true for anthropic when promptCaching is omitted from providerConfig", () => {
    createClient("anthropic", null, { apiKey: FAKE_ANTHROPIC_KEY });

    const calls = (AnthropicAdapter as unknown as { _ctorCalls: Array<[string | undefined, { promptCaching?: boolean } | undefined]> })._ctorCalls;
    expect(calls).toHaveLength(1);
    const [, opts] = calls[0]!;
    expect(opts).toEqual({ promptCaching: true });
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

  it("does not throw for openai-compat with no endpoint (Ollama path)", () => {
    expect(() => validateApiKey("openai-compat")).not.toThrow();
  });

  it("throws with DEEPSEEK_API_KEY in message for openai-compat at api.deepseek.com when key absent", () => {
    const saved = process.env["DEEPSEEK_API_KEY"];
    delete process.env["DEEPSEEK_API_KEY"];

    try {
      expect(() =>
        validateApiKey("openai-compat", undefined, undefined, "https://api.deepseek.com"),
      ).toThrow(/DEEPSEEK_API_KEY/);
    } finally {
      if (saved !== undefined) process.env["DEEPSEEK_API_KEY"] = saved;
    }
  });

  it("does not throw for openai-compat at api.deepseek.com when DEEPSEEK_API_KEY is set", () => {
    const saved = process.env["DEEPSEEK_API_KEY"];
    process.env["DEEPSEEK_API_KEY"] = "sk-fake-deepseek-key";

    try {
      expect(() =>
        validateApiKey("openai-compat", undefined, undefined, "https://api.deepseek.com"),
      ).not.toThrow();
    } finally {
      if (saved !== undefined) {
        process.env["DEEPSEEK_API_KEY"] = saved;
      } else {
        delete process.env["DEEPSEEK_API_KEY"];
      }
    }
  });

  it("does not throw for unknown providers", () => {
    expect(() => validateApiKey("some-future-provider")).not.toThrow();
  });

  // ── Grok/xAI key validation (sc-1-4) ─────────────────────────────────────

  it("throws with XAI_API_KEY in message for openai-compat at api.x.ai when key absent (sc-1-4)", () => {
    const saved = process.env["XAI_API_KEY"];
    delete process.env["XAI_API_KEY"];

    try {
      expect(() =>
        validateApiKey("openai-compat", "generator", undefined, "https://api.x.ai/v1"),
      ).toThrow(/XAI_API_KEY/);
    } finally {
      if (saved !== undefined) process.env["XAI_API_KEY"] = saved;
    }
  });

  it("error message names Grok/xAI when XAI_API_KEY is absent (sc-1-4)", () => {
    const saved = process.env["XAI_API_KEY"];
    delete process.env["XAI_API_KEY"];

    try {
      expect(() =>
        validateApiKey("openai-compat", "generator", undefined, "https://api.x.ai/v1"),
      ).toThrow(/Grok\/xAI/);
    } finally {
      if (saved !== undefined) process.env["XAI_API_KEY"] = saved;
    }
  });

  it("does not throw for openai-compat at api.x.ai when XAI_API_KEY is set (sc-1-4)", () => {
    const saved = process.env["XAI_API_KEY"];
    process.env["XAI_API_KEY"] = "xai-fake-test-key";

    try {
      expect(() =>
        validateApiKey("openai-compat", "generator", undefined, "https://api.x.ai/v1"),
      ).not.toThrow();
    } finally {
      if (saved !== undefined) {
        process.env["XAI_API_KEY"] = saved;
      } else {
        delete process.env["XAI_API_KEY"];
      }
    }
  });

  it("deepseek still throws DEEPSEEK_API_KEY when key absent (no-regression, sc-1-4)", () => {
    const saved = process.env["DEEPSEEK_API_KEY"];
    delete process.env["DEEPSEEK_API_KEY"];

    try {
      expect(() =>
        validateApiKey("openai-compat", undefined, undefined, "https://api.deepseek.com"),
      ).toThrow(/DEEPSEEK_API_KEY/);
    } finally {
      if (saved !== undefined) process.env["DEEPSEEK_API_KEY"] = saved;
    }
  });

  it("Ollama endpoint still requires no key after xAI arm added (no-regression, sc-1-4)", () => {
    expect(() => validateApiKey("openai-compat")).not.toThrow();
  });
});

// ── isXaiEndpoint predicate (sc-1-6) ─────────────────────────────────────────

describe("isXaiEndpoint", () => {
  it("returns true for https://api.x.ai/v1 (sc-1-6)", () => {
    expect(isXaiEndpoint("https://api.x.ai/v1")).toBe(true);
  });

  it("returns false for api.deepseek.com (sc-1-6)", () => {
    expect(isXaiEndpoint("https://api.deepseek.com")).toBe(false);
  });

  it("returns false for undefined (sc-1-6)", () => {
    expect(isXaiEndpoint(undefined)).toBe(false);
  });

  it("returns false for ollama endpoint (sc-1-6)", () => {
    expect(isXaiEndpoint("http://localhost:11434/v1")).toBe(false);
  });

  it("returns false for empty string (sc-1-6)", () => {
    expect(isXaiEndpoint("")).toBe(false);
  });
});

// ── createClient xAI key injection (sc-1-5) ──────────────────────────────────

describe("createClient xAI key injection", () => {
  it("throws with XAI_API_KEY in message for grok endpoint when key absent (sc-1-5)", () => {
    const saved = process.env["XAI_API_KEY"];
    delete process.env["XAI_API_KEY"];

    try {
      expect(() => createClient(null, null, undefined, "grok")).toThrow(/XAI_API_KEY/);
    } finally {
      if (saved !== undefined) process.env["XAI_API_KEY"] = saved;
    }
  });

  it("constructs OpenAICompatAdapter when XAI_API_KEY is set (sc-1-5)", () => {
    const saved = process.env["XAI_API_KEY"];
    process.env["XAI_API_KEY"] = "xai-fake-test-key";

    try {
      const client = createClient(null, null, undefined, "grok");
      expect(client).toBeInstanceOf(OpenAICompatAdapter);
    } finally {
      if (saved !== undefined) {
        process.env["XAI_API_KEY"] = saved;
      } else {
        delete process.env["XAI_API_KEY"];
      }
    }
  });

  it("Ollama endpoint keeps no-key behavior after xAI arm added (no-regression, sc-1-5)", () => {
    const client = createClient(
      "openai-compat",
      "http://localhost:11434/v1",
      undefined,
      "llama3",
    );
    expect(client).toBeInstanceOf(OpenAICompatAdapter);
  });
});
