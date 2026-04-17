import { describe, it, expect } from "vitest";
import { resolveProviderModel, resolveModel } from "./model-resolver.js";

describe("resolveProviderModel", () => {
  describe("Anthropic shorthands", () => {
    it("resolves opus to anthropic/claude-opus-4-7", () => {
      expect(resolveProviderModel("opus")).toEqual({
        provider: "anthropic",
        modelId: "claude-opus-4-7",
      });
    });

    it("resolves sonnet to anthropic/claude-sonnet-4-6", () => {
      expect(resolveProviderModel("sonnet")).toEqual({
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
      });
    });

    it("resolves haiku to anthropic/claude-haiku-4-5", () => {
      expect(resolveProviderModel("haiku")).toEqual({
        provider: "anthropic",
        modelId: "claude-haiku-4-5",
      });
    });
  });

  describe("OpenAI shorthands", () => {
    it("resolves gpt-4.1 to openai/gpt-4.1", () => {
      expect(resolveProviderModel("gpt-4.1")).toEqual({
        provider: "openai",
        modelId: "gpt-4.1",
      });
    });

    it("resolves gpt-4.1-mini to openai/gpt-4.1-mini", () => {
      expect(resolveProviderModel("gpt-4.1-mini")).toEqual({
        provider: "openai",
        modelId: "gpt-4.1-mini",
      });
    });

    it("resolves o3 to openai/o3", () => {
      expect(resolveProviderModel("o3")).toEqual({
        provider: "openai",
        modelId: "o3",
      });
    });

    it("resolves o4-mini to openai/o4-mini", () => {
      expect(resolveProviderModel("o4-mini")).toEqual({
        provider: "openai",
        modelId: "o4-mini",
      });
    });
  });

  describe("Google shorthands", () => {
    it("resolves gemini-pro to google/gemini-2.5-pro", () => {
      expect(resolveProviderModel("gemini-pro")).toEqual({
        provider: "google",
        modelId: "gemini-2.5-pro",
      });
    });

    it("resolves gemini-flash to google/gemini-2.5-flash", () => {
      expect(resolveProviderModel("gemini-flash")).toEqual({
        provider: "google",
        modelId: "gemini-2.5-flash",
      });
    });
  });

  describe("ollama/ prefix", () => {
    it("resolves ollama/llama3 to openai-compat with localhost endpoint", () => {
      expect(resolveProviderModel("ollama/llama3")).toEqual({
        provider: "openai-compat",
        modelId: "llama3",
        endpoint: "http://localhost:11434/v1",
      });
    });

    it("resolves ollama/mistral:7b to openai-compat with localhost endpoint", () => {
      expect(resolveProviderModel("ollama/mistral:7b")).toEqual({
        provider: "openai-compat",
        modelId: "mistral:7b",
        endpoint: "http://localhost:11434/v1",
      });
    });
  });

  describe("explicit provider override", () => {
    it("uses explicit provider with model as-is (no shorthand expansion)", () => {
      expect(resolveProviderModel("sonnet", "openai")).toEqual({
        provider: "openai",
        modelId: "sonnet",
      });
    });

    it("uses explicit provider with arbitrary model ID", () => {
      expect(resolveProviderModel("my-fine-tuned-model", "openai")).toEqual({
        provider: "openai",
        modelId: "my-fine-tuned-model",
      });
    });
  });

  describe("unknown model (no explicit provider)", () => {
    it("defaults unknown model strings to anthropic provider", () => {
      expect(resolveProviderModel("claude-custom-v1")).toEqual({
        provider: "anthropic",
        modelId: "claude-custom-v1",
      });
    });

    it("defaults exact Anthropic model IDs to anthropic provider", () => {
      expect(resolveProviderModel("claude-opus-4-7")).toEqual({
        provider: "anthropic",
        modelId: "claude-opus-4-7",
      });
    });
  });
});

describe("resolveModel (backward compat)", () => {
  it("returns modelId for opus", () => {
    expect(resolveModel("opus")).toBe("claude-opus-4-7");
  });

  it("returns modelId for sonnet", () => {
    expect(resolveModel("sonnet")).toBe("claude-sonnet-4-6");
  });

  it("returns modelId for haiku", () => {
    expect(resolveModel("haiku")).toBe("claude-haiku-4-5");
  });

  it("passes through unknown model ID unchanged", () => {
    expect(resolveModel("claude-opus-4-7")).toBe("claude-opus-4-7");
  });
});
