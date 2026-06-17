import { describe, it, expect } from "vitest";

import type { LLMClient, ChatParams, ChatResponse } from "../providers/types.js";
import { FleetManifestSchema } from "./manifest.js";
import {
  decomposeGoal,
  validateManifest,
  DECOMPOSE_MAX_RETRIES,
} from "./decomposer.js";

// ── Scripted fake client ─────────────────────────────────────────────

/**
 * Returns scripted responses in order; repeats the last one once exhausted.
 * Records every ChatParams it was called with.
 */
class ScriptedClient implements LLMClient {
  readonly calls: ChatParams[] = [];
  private idx = 0;

  constructor(private readonly responses: string[]) {}

  async chat(params: ChatParams): Promise<ChatResponse> {
    this.calls.push(params);
    const text =
      this.responses[Math.min(this.idx, this.responses.length - 1)] ?? "";
    this.idx += 1;
    return {
      text,
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 3, outputTokens: 5 },
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

const VALID_MANIFEST_JSON = JSON.stringify({
  children: [{ folder: "api", task: "Build the REST API server with Express" }],
});

const VALID_MULTI_CHILD_JSON = JSON.stringify({
  children: [
    { folder: "api-server", task: "Build the REST API with Express and PostgreSQL" },
    { folder: "web-frontend", task: "Build the React web frontend" },
  ],
});

// ── Tests ─────────────────────────────────────────────────────────────

describe("DECOMPOSE_MAX_RETRIES", () => {
  it("is exactly 1", () => {
    expect(DECOMPOSE_MAX_RETRIES).toBe(1);
  });
});

describe("validateManifest", () => {
  it("accepts a valid children-only JSON string", () => {
    const result = validateManifest(VALID_MANIFEST_JSON);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.children).toHaveLength(1);
      expect(result.manifest.children[0]?.folder).toBe("api");
    }
  });

  it("extracts from a fenced ```json block", () => {
    const fenced = "Here is the output:\n```json\n" + VALID_MANIFEST_JSON + "\n```\n";
    const result = validateManifest(fenced);
    expect(result.ok).toBe(true);
  });

  it("extracts from a first-brace-to-last-brace substring", () => {
    const wrapped = "some leading text " + VALID_MANIFEST_JSON + " some trailing text";
    const result = validateManifest(wrapped);
    expect(result.ok).toBe(true);
  });

  it("returns ok:false for invalid JSON", () => {
    const result = validateManifest("not json at all!!!");
    expect(result.ok).toBe(false);
  });

  it("returns ok:false when children array is missing", () => {
    const result = validateManifest(JSON.stringify({ rootDir: "." }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("children");
    }
  });

  it("returns ok:false when a child carries a config key", () => {
    const withConfig = JSON.stringify({
      children: [{ folder: "api", task: "build it", config: { foo: 1 } }],
    });
    const result = validateManifest(withConfig);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("config");
    }
  });

  it("applies FleetManifestSchema defaults (rootDir, concurrency)", () => {
    const result = validateManifest(VALID_MANIFEST_JSON);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.rootDir).toBe(".");
      expect(result.manifest.concurrency).toBe(3);
    }
  });
});

describe("decomposeGoal", () => {
  // sc-1-4: valid first try
  it("resolves with a schema-valid manifest when the first response is valid (1 call)", async () => {
    const client = new ScriptedClient([VALID_MANIFEST_JSON]);
    const result = await decomposeGoal({
      goal: "Build a REST API and web frontend",
      client,
      model: "deepseek-v4-pro",
    });

    expect(FleetManifestSchema.safeParse(result).success).toBe(true);
    expect(result.children).toHaveLength(1);
    expect(result.children[0]?.folder).toBe("api");
    expect(result.children[0]?.task).toBeTruthy();
    // Children carry only folder/task (no config key)
    expect(Object.prototype.hasOwnProperty.call(result.children[0], "config")).toBe(false);
    // Exactly 1 call
    expect(client.calls).toHaveLength(1);
  });

  // sc-1-4: multi-child manifest
  it("resolves with multiple children when LLM returns multiple children", async () => {
    const client = new ScriptedClient([VALID_MULTI_CHILD_JSON]);
    const result = await decomposeGoal({
      goal: "Build a full-stack app",
      client,
      model: "deepseek-v4-pro",
    });

    expect(result.children).toHaveLength(2);
    expect(result.children[0]?.folder).toBe("api-server");
    expect(result.children[1]?.folder).toBe("web-frontend");
    expect(client.calls).toHaveLength(1);
  });

  // sc-1-5: invalid JSON then valid (coercion retry)
  it("issues exactly ONE coercion re-prompt on bad-then-good (2 total calls)", async () => {
    const client = new ScriptedClient(["not json", VALID_MANIFEST_JSON]);
    const result = await decomposeGoal({
      goal: "Build a microservice",
      client,
      model: "deepseek-v4-pro",
    });

    expect(result.children).toHaveLength(1);
    // Exactly 2 calls
    expect(client.calls).toHaveLength(2);

    // Second call's messages must be a 3-message array
    const secondCall = client.calls[1];
    expect(secondCall?.messages).toHaveLength(3);
    // First message is the original user goal
    expect(secondCall?.messages[0]).toEqual({ role: "user", content: "Build a microservice" });
    // Second message is the prior (bad) assistant text
    expect(secondCall?.messages[1]).toEqual({ role: "assistant", content: "not json" });
    // Third message contains the prior text reference and a Zod/extraction error
    const thirdMsg = secondCall?.messages[2];
    expect(thirdMsg?.role).toBe("user");
    if (thirdMsg && "content" in thirdMsg) {
      expect(thirdMsg.content).toContain("not a valid fleet manifest");
      // Should contain the formatted error
      expect(thirdMsg.content.length).toBeGreaterThan(10);
    }
  });

  // sc-1-5: schema invalid then valid (coercion retry with Zod error)
  it("includes Zod error in the coercion re-prompt when schema validation fails", async () => {
    const badSchema = JSON.stringify({ rootDir: "." }); // missing children
    const client = new ScriptedClient([badSchema, VALID_MANIFEST_JSON]);
    await decomposeGoal({
      goal: "Build something",
      client,
      model: "deepseek-v4-pro",
    });

    expect(client.calls).toHaveLength(2);
    const secondCall = client.calls[1];
    const thirdMsg = secondCall?.messages[2];
    if (thirdMsg && "content" in thirdMsg) {
      // The error should mention children (the Zod path)
      expect(thirdMsg.content).toContain("children");
    }
  });

  // sc-1-6: invalid twice — throws with Zod issues in message
  it("throws with formatted Zod issues when both attempts fail (no manifest escapes)", async () => {
    const client = new ScriptedClient(["garbage", "still garbage"]);
    await expect(
      decomposeGoal({
        goal: "Build something",
        client,
        model: "deepseek-v4-pro",
      }),
    ).rejects.toThrow(/Fleet decomposition failed/);
    // Exactly 2 calls made before throwing
    expect(client.calls).toHaveLength(2);
  });

  // sc-1-6: schema-invalid twice — error message contains Zod path
  it("throws containing a Zod path fragment when schema is invalid twice", async () => {
    const noChildren = JSON.stringify({ rootDir: "." });
    const client = new ScriptedClient([noChildren, noChildren]);
    await expect(
      decomposeGoal({
        goal: "Build something",
        client,
        model: "deepseek-v4-pro",
      }),
    ).rejects.toThrow(/children/);
  });

  // sc-1-7a: child with config key → rejected by guard → routes to coercion
  it("rejects a child carrying a config key (config-key guard fires after safeParse)", async () => {
    const withConfig = JSON.stringify({
      children: [{ folder: "api", task: "build it", config: { foo: 1 } }],
    });
    const client = new ScriptedClient([withConfig, VALID_MANIFEST_JSON]);
    const result = await decomposeGoal({
      goal: "Build an API",
      client,
      model: "deepseek-v4-pro",
    });

    // Should succeed on second attempt
    expect(result.children).toHaveLength(1);
    // Guard caused a retry — 2 calls
    expect(client.calls).toHaveLength(2);
    // Second call's third message should mention config
    const secondCall = client.calls[1];
    const thirdMsg = secondCall?.messages[2];
    if (thirdMsg && "content" in thirdMsg) {
      expect(thirdMsg.content).toContain("config");
    }
  });

  // sc-1-7a: child with config key — throws if both fail
  it("throws when both attempts have child with config key", async () => {
    const withConfig = JSON.stringify({
      children: [{ folder: "api", task: "build it", config: { x: 1 } }],
    });
    const client = new ScriptedClient([withConfig, withConfig]);
    await expect(
      decomposeGoal({
        goal: "Build something",
        client,
        model: "deepseek-v4-pro",
      }),
    ).rejects.toThrow(/config/);
    expect(client.calls).toHaveLength(2);
  });

  // sc-1-7b: fenced ```json block extraction
  it("extracts valid manifest from a fenced ```json block on first try", async () => {
    const fenced = "```json\n" + VALID_MANIFEST_JSON + "\n```";
    const client = new ScriptedClient([fenced]);
    const result = await decomposeGoal({
      goal: "Build a service",
      client,
      model: "deepseek-v4-pro",
    });

    expect(FleetManifestSchema.safeParse(result).success).toBe(true);
    expect(client.calls).toHaveLength(1);
  });

  // sc-1-7b: first-brace-to-last-brace extraction
  it("extracts valid manifest from first-brace-to-last-brace substring", async () => {
    const wrapped = "Here is the manifest: " + VALID_MANIFEST_JSON + " That's it.";
    const client = new ScriptedClient([wrapped]);
    const result = await decomposeGoal({
      goal: "Build a service",
      client,
      model: "deepseek-v4-pro",
    });

    expect(FleetManifestSchema.safeParse(result).success).toBe(true);
    expect(client.calls).toHaveLength(1);
  });

  // sc-1-7c: chat params shape — jsonObjectMode:true, no responseSchema
  it("passes jsonObjectMode:true and no responseSchema to client.chat", async () => {
    const client = new ScriptedClient([VALID_MANIFEST_JSON]);
    await decomposeGoal({
      goal: "Build something",
      client,
      model: "deepseek-v4-pro",
    });

    expect(client.calls[0]?.jsonObjectMode).toBe(true);
    expect(client.calls[0]?.responseSchema).toBeUndefined();
  });

  // sc-1-7c: also verify on coercion retry call
  it("passes jsonObjectMode:true and no responseSchema on coercion retry call", async () => {
    const client = new ScriptedClient(["bad json", VALID_MANIFEST_JSON]);
    await decomposeGoal({
      goal: "Build something",
      client,
      model: "deepseek-v4-pro",
    });

    // Both calls should have jsonObjectMode:true and no responseSchema
    expect(client.calls[0]?.jsonObjectMode).toBe(true);
    expect(client.calls[0]?.responseSchema).toBeUndefined();
    expect(client.calls[1]?.jsonObjectMode).toBe(true);
    expect(client.calls[1]?.responseSchema).toBeUndefined();
  });

  // Call count constraint
  it("never makes more than 2 calls with default maxRetries", async () => {
    const client = new ScriptedClient(["bad", "also bad"]);
    await expect(
      decomposeGoal({
        goal: "Build something",
        client,
        model: "deepseek-v4-pro",
      }),
    ).rejects.toThrow();
    expect(client.calls.length).toBeLessThanOrEqual(2);
  });

  // maxRetries=0 should only make 1 call
  it("makes exactly 1 call when maxRetries=0 and first attempt fails", async () => {
    const client = new ScriptedClient(["bad json"]);
    await expect(
      decomposeGoal({
        goal: "Build something",
        client,
        model: "deepseek-v4-pro",
        maxRetries: 0,
      }),
    ).rejects.toThrow(/Fleet decomposition failed/);
    expect(client.calls).toHaveLength(1);
  });
});
