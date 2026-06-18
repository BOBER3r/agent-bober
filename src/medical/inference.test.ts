/**
 * Tests for buildMedicalInferenceClient — cloud-inference egress gating (Sprint 3).
 *
 * Covers sc-3-3 (cloud config + egress OFF => local fallback),
 *         sc-3-4 (cloud config + egress ON => cloud client built),
 *         sc-3-5 (no inference config => exact local default, back-compat).
 *
 * Uses an injected factory spy so tests NEVER touch real network/keys.
 */
import { describe, it, expect, vi } from "vitest";
import { buildMedicalInferenceClient } from "./inference.js";
import { EgressGuard } from "./egress.js";
import { createDefaultConfig } from "../config/schema.js";
import type { LLMClient } from "../providers/types.js";

// ── Factory spy ───────────────────────────────────────────────────────

function makeFactorySpy() {
  return vi.fn((_provider?: string | null, _endpoint?: string | null, _pc?: unknown, _model?: string): LLMClient => ({
    chat: vi.fn(),
  }));
}

// ── Fixtures ──────────────────────────────────────────────────────────

/** Config with a cloud inference override (provider=anthropic, model=claude-x). */
function cfgWithCloudInference() {
  const cfg = createDefaultConfig("test", "greenfield");
  cfg.medical = {
    egress: { cloudInference: false, literatureRetrieval: false, deviceConnection: false },
    inference: { provider: "anthropic", model: "claude-x" },
  };
  return cfg;
}

/** Config with no inference block at all (absent => back-compat local default). */
function cfgNoInference() {
  const cfg = createDefaultConfig("test", "greenfield");
  cfg.medical = undefined;
  return cfg;
}

// ── sc-3-3: cloud config + cloudInference=false => local fallback ─────

describe("buildMedicalInferenceClient — sc-3-3: cloud OFF => local fallback", () => {
  it("returns local default (openai-compat + localhost + llama3) when cloud config present but cloud-inference=false", () => {
    const spy = makeFactorySpy();
    const egressOff = new EgressGuard(false, false);

    const { client: _client, model } = buildMedicalInferenceClient(cfgWithCloudInference(), egressOff, spy);

    // Resolved model must be the local default.
    expect(model).toBe("llama3");
    // Factory MUST have been called with the LOCAL provider/endpoint, never 'anthropic'.
    expect(spy).toHaveBeenCalledWith("openai-compat", "http://localhost:11434/v1", undefined, "llama3");
    expect(spy).not.toHaveBeenCalledWith("anthropic", expect.anything(), expect.anything(), expect.anything());
  });

  it("spy is called exactly once (no retries or double-construction)", () => {
    const spy = makeFactorySpy();
    const egressOff = new EgressGuard(false, false);

    buildMedicalInferenceClient(cfgWithCloudInference(), egressOff, spy);

    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ── sc-3-4: cloud config + cloudInference=true => cloud client built ──

describe("buildMedicalInferenceClient — sc-3-4: cloud ON => cloud client built", () => {
  it("calls factory with cloud provider+model when cloudInference=true", () => {
    const spy = makeFactorySpy();
    const egressOn = new EgressGuard(true, false);
    const cfg = cfgWithCloudInference();
    // ensure cloud config is set
    cfg.medical!.inference = { provider: "anthropic", model: "claude-x" };

    const { model } = buildMedicalInferenceClient(cfg, egressOn, spy);

    expect(model).toBe("claude-x");
    expect(spy).toHaveBeenCalledWith("anthropic", expect.anything(), undefined, "claude-x");
  });

  it("does NOT call factory with the local provider when cloud is used", () => {
    const spy = makeFactorySpy();
    const egressOn = new EgressGuard(true, false);
    const cfg = cfgWithCloudInference();
    cfg.medical!.inference = { provider: "anthropic", endpoint: "https://api.anthropic.com", model: "claude-x" };

    buildMedicalInferenceClient(cfg, egressOn, spy);

    expect(spy).not.toHaveBeenCalledWith("openai-compat", expect.anything(), expect.anything(), expect.anything());
  });
});

// ── sc-3-5: no inference config => exact local default ───────────────

describe("buildMedicalInferenceClient — sc-3-5: no inference config => exact local default", () => {
  it("returns openai-compat + localhost + llama3 when no medical.inference is set", () => {
    const spy = makeFactorySpy();
    const egress = new EgressGuard(false, false);

    const { model } = buildMedicalInferenceClient(cfgNoInference(), egress, spy);

    expect(model).toBe("llama3");
    expect(spy).toHaveBeenCalledWith("openai-compat", "http://localhost:11434/v1", undefined, "llama3");
  });

  it("returns exact local default even when cloudInference=true but no inference config is present", () => {
    // No inference config => local default regardless of egress.
    const spy = makeFactorySpy();
    const egressOn = new EgressGuard(true, false);
    const cfg = createDefaultConfig("test", "greenfield");
    cfg.medical = { egress: { cloudInference: true, literatureRetrieval: false, deviceConnection: false } };

    const { model } = buildMedicalInferenceClient(cfg, egressOn, spy);

    expect(model).toBe("llama3");
    expect(spy).toHaveBeenCalledWith("openai-compat", "http://localhost:11434/v1", undefined, "llama3");
  });

  it("back-compat: medical undefined => local default, no cloud call", () => {
    const spy = makeFactorySpy();
    const egress = new EgressGuard(false, false);

    const { model } = buildMedicalInferenceClient(cfgNoInference(), egress, spy);

    expect(model).toBe("llama3");
    expect(spy).not.toHaveBeenCalledWith("anthropic", expect.anything(), expect.anything(), expect.anything());
  });
});

// ── localhost openai-compat is treated as non-egressing ──────────────

describe("buildMedicalInferenceClient — localhost openai-compat is non-egressing", () => {
  it("openai-compat with a localhost endpoint is NOT cloud-gated even if inference is set", () => {
    const spy = makeFactorySpy();
    const egressOff = new EgressGuard(false, false);
    const cfg = createDefaultConfig("test", "greenfield");
    cfg.medical = {
      egress: { cloudInference: false, literatureRetrieval: false, deviceConnection: false },
      inference: { provider: "openai-compat", endpoint: "http://localhost:11434/v1", model: "mistral" },
    };

    const { model } = buildMedicalInferenceClient(cfg, egressOff, spy);

    // Local => used as-is, no fallback override.
    expect(model).toBe("mistral");
    expect(spy).toHaveBeenCalledWith("openai-compat", "http://localhost:11434/v1", undefined, "mistral");
  });
});
