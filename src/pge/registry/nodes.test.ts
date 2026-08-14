import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { OVERALL_STATE_KEYS } from "../state/overall.js";
import { DuplicateNodeImplError, createModelBinder, createNodeRegistry } from "./nodes.js";
import type { ModelProfile, NodeImpl } from "./nodes.js";

/**
 * The node registry, the model binder, and the containment of PRIVATE state.
 */

function impl(id: string, overrides: Partial<NodeImpl> = {}): NodeImpl {
  return {
    id,
    kind: "tool",
    inputPort: null,
    outputPort: null,
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    handler: async () => {
      throw new Error(`node ${id} must not run in a registry test`);
    },
    ...overrides,
  };
}

// ── Registry ────────────────────────────────────────────────────────

describe("createNodeRegistry", () => {
  it("registers and resolves an implementation by node id", () => {
    const registry = createNodeRegistry();
    const draft = impl("draft", { kind: "llm" });
    registry.register(draft);
    expect(registry.get("draft")).toBe(draft);
    expect(registry.get("draft")?.kind).toBe("llm");
  });

  it("lists registered ids in sorted order", () => {
    const registry = createNodeRegistry();
    registry.register(impl("zulu"));
    registry.register(impl("alpha"));
    registry.register(impl("mike"));
    expect(registry.ids()).toEqual(["alpha", "mike", "zulu"]);
  });

  it("refuses a second implementation for the same node id", () => {
    const registry = createNodeRegistry();
    registry.register(impl("draft"));
    expect(() => registry.register(impl("draft"))).toThrow(DuplicateNodeImplError);
    try {
      registry.register(impl("draft"));
      throw new Error("unreachable");
    } catch (error) {
      expect(error).toBeInstanceOf(DuplicateNodeImplError);
      expect((error as DuplicateNodeImplError).nodeId).toBe("draft");
    }
  });

  it("returns undefined for an unregistered id", () => {
    expect(createNodeRegistry().get("nope")).toBeUndefined();
  });

  it("misses on inherited Object.prototype members", () => {
    const registry = createNodeRegistry();
    registry.register(impl("draft"));
    for (const inherited of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"]) {
      expect(registry.get(inherited), inherited).toBeUndefined();
    }
    expect(registry.ids()).toEqual(["draft"]);
  });

  it("hands each caller an independent registry", () => {
    const first = createNodeRegistry();
    const second = createNodeRegistry();
    first.register(impl("draft"));
    expect(second.get("draft")).toBeUndefined();
    expect(second.ids()).toEqual([]);
  });
});

// ── ModelBinder ─────────────────────────────────────────────────────

describe("createModelBinder", () => {
  const profile: ModelProfile = {
    light: { provider: "anthropic", modelId: "claude-haiku-4-5" },
    frontier: { provider: "anthropic", modelId: "claude-opus-5" },
  };

  it("binds a declared tier to a concrete provider and model id", () => {
    const binder = createModelBinder(profile);
    expect(binder.bind("light")).toEqual({
      tier: "light",
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
    });
    expect(binder.bind("frontier")).toEqual({
      tier: "frontier",
      provider: "anthropic",
      modelId: "claude-opus-5",
    });
  });

  it("carries an endpoint through for an openai-compatible profile", () => {
    const binder = createModelBinder({
      light: { provider: "openai-compat", modelId: "deepseek-v4-flash", endpoint: "https://api.deepseek.com" },
      frontier: { provider: "openai-compat", modelId: "deepseek-v4-pro", endpoint: "https://api.deepseek.com" },
    });
    expect(binder.bind("frontier").endpoint).toBe("https://api.deepseek.com");
  });

  it("copies the profile, so a later mutation of the caller's object cannot swap a model", () => {
    const mutable: ModelProfile = {
      light: { provider: "anthropic", modelId: "claude-haiku-4-5" },
      frontier: { provider: "anthropic", modelId: "claude-opus-5" },
    };
    const binder = createModelBinder(mutable);
    (mutable.frontier as { modelId: string }).modelId = "something-else";
    expect(binder.bind("frontier").modelId).toBe("claude-opus-5");
    expect(binder.profile().frontier.modelId).toBe("claude-opus-5");
  });

  it("is the reason a model swap is not a topology change", () => {
    // A topology names a TIER. Two binders over the same graph resolve the same
    // declaration to different models without the artifact — or its checksum — moving.
    const cheap = createModelBinder(profile);
    const local = createModelBinder({
      light: { provider: "openai-compat", modelId: "qwen3", endpoint: "http://localhost:11434/v1" },
      frontier: { provider: "openai-compat", modelId: "qwen3-large", endpoint: "http://localhost:11434/v1" },
    });
    expect(cheap.bind("frontier").modelId).not.toBe(local.bind("frontier").modelId);
    expect(cheap.bind("frontier").tier).toBe(local.bind("frontier").tier);
  });
});

// ── Private state containment ───────────────────────────────────────

const PGE_ROOT = fileURLToPath(new URL("../", import.meta.url));

/**
 * Modules allowed to touch `priv` in CODE.
 *
 * Private state belongs to the node that created it and to the interpreter that hands
 * it over. Anything else reading it — a commit boundary, a checkpointer, a state
 * serializer — would be a route by which node-local scratch reaches a durable artifact,
 * which is the exact leak the three-scope split exists to prevent.
 */
const PRIV_ALLOWED_PREFIXES = ["registry/", "runtime/"];

async function collectSourceFiles(dir: string, prefix = ""): Promise<Array<{ rel: string; abs: string }>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: Array<{ rel: string; abs: string }> = [];
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(abs, rel)));
      continue;
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
    files.push({ rel, abs });
  }
  return files;
}

/** Comments are prose about `priv` and are not a use of it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("NodeContext.priv containment", () => {
  it("is not a channel: no OverallState key exposes private state", () => {
    expect([...OVERALL_STATE_KEYS]).not.toContain("priv");
  });

  it("is referenced in code only by the registry and the interpreter layers", async () => {
    const files = await collectSourceFiles(PGE_ROOT);
    expect(files.length).toBeGreaterThan(5);

    const withPriv: string[] = [];
    for (const file of files) {
      const source = stripComments(await readFile(file.abs, "utf8"));
      if (/\bpriv\b/.test(source)) withPriv.push(file.rel);
    }

    // Not vacuous: the declaration itself must be found, or the scan is matching nothing
    // and would keep passing after a real leak was introduced.
    expect(withPriv).toContain("registry/nodes.ts");

    const offenders = withPriv.filter(
      (rel) => !PRIV_ALLOWED_PREFIXES.some((prefix) => rel.startsWith(prefix)),
    );
    expect(offenders).toEqual([]);
  });

  it("ignores prose: a doc comment naming NodeContext.priv is not a use of it", () => {
    const prose = "/** See NodeContext.priv for the private scope. */\nconst x = 1;\n";
    expect(/\bpriv\b/.test(stripComments(prose))).toBe(false);
    expect(/\bpriv\b/.test(stripComments("ctx.priv.set('k', 1);\n"))).toBe(true);
    // `private` must not be mistaken for `priv`.
    expect(/\bpriv\b/.test(stripComments("const scope = 'private';\n"))).toBe(false);
  });
});
