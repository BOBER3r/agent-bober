import { describe, it, expect } from "vitest";
import { check, assertManifest } from "./tool-role-guard.js";
import { buildChildConfig } from "./child-config.js";
import type { FleetChild, FleetManifest } from "./manifest.js";

// ── sc-3-4: check() returns violation / null ──────────────────────────

describe("sc-3-4: check() identifies tool-role violations and clean configs", () => {
  it("returns a ToolRoleViolation when child.config.generator.provider is claude-code", () => {
    const child: FleetChild = {
      folder: "bad-child",
      task: "build something",
      config: { generator: { model: "sonnet", provider: "claude-code" } },
    };
    const resolved = buildChildConfig(child);
    const result = check(child, resolved);

    expect(result).toEqual({
      childFolder: "bad-child",
      role: "generator",
      provider: "claude-code",
    });
  });

  it("returns a ToolRoleViolation for curator with claude-code", () => {
    const child: FleetChild = {
      folder: "curator-child",
      task: "curate",
      config: { curator: { model: "sonnet", provider: "claude-code" } },
    };
    const resolved = buildChildConfig(child);
    const result = check(child, resolved);

    expect(result).toEqual({
      childFolder: "curator-child",
      role: "curator",
      provider: "claude-code",
    });
  });

  it("returns null for a clean child (default DeepSeek config, no claude-code on tool roles)", () => {
    const child: FleetChild = {
      folder: "clean-child",
      task: "build something",
    };
    const resolved = buildChildConfig(child);

    expect(() => check(child, resolved)).not.toThrow();
    expect(check(child, resolved)).toBeNull();
  });

  it("returns null for a tiered child (tier: cheap — no claude-code anywhere)", () => {
    const child: FleetChild = {
      folder: "tiered-child",
      task: "build something",
      tier: "cheap",
    };
    const resolved = buildChildConfig(child);

    expect(() => check(child, resolved)).not.toThrow();
    expect(check(child, resolved)).toBeNull();
  });

  it("returns null for a tiered 'frontier' child (anthropic, not claude-code)", () => {
    const child: FleetChild = {
      folder: "frontier-child",
      task: "build something",
      tier: "frontier",
    };
    const resolved = buildChildConfig(child);

    expect(() => check(child, resolved)).not.toThrow();
    expect(check(child, resolved)).toBeNull();
  });
});

// ── sc-3-5: assertManifest() throws on violation, no-throw on clean ───

describe("sc-3-5: assertManifest() throws naming folder+role, or passes cleanly", () => {
  it("throws when a child places claude-code on the generator tool role", () => {
    const manifest: FleetManifest = {
      rootDir: ".",
      concurrency: 1,
      children: [
        {
          folder: "bad-generator",
          task: "build something",
          config: { generator: { model: "sonnet", provider: "claude-code" } },
        },
      ],
    };

    expect(() => assertManifest(manifest)).toThrow(/bad-generator/);
    expect(() => assertManifest(manifest)).toThrow(/generator/);
  });

  it("throw message mentions both the folder name and the role", () => {
    const manifest: FleetManifest = {
      rootDir: ".",
      concurrency: 1,
      children: [
        {
          folder: "my-special-child",
          task: "do stuff",
          config: { evaluator: { model: "sonnet", provider: "claude-code", strategies: [] } },
        },
      ],
    };

    let caughtMessage = "";
    try {
      assertManifest(manifest);
    } catch (err) {
      caughtMessage = err instanceof Error ? err.message : String(err);
    }

    expect(caughtMessage).toContain("my-special-child");
    expect(caughtMessage).toContain("evaluator");
  });

  it("does NOT throw for a clean manifest with no config overrides", () => {
    const manifest: FleetManifest = {
      rootDir: ".",
      concurrency: 2,
      children: [
        { folder: "child-a", task: "task a" },
        { folder: "child-b", task: "task b" },
      ],
    };

    expect(() => assertManifest(manifest)).not.toThrow();
  });

  it("does NOT throw for a manifest with tiered children (cheap/standard/hard/frontier)", () => {
    const manifest: FleetManifest = {
      rootDir: ".",
      concurrency: 4,
      children: [
        { folder: "cheap-child", task: "cheap task", tier: "cheap" },
        { folder: "standard-child", task: "standard task", tier: "standard" },
        { folder: "hard-child", task: "hard task", tier: "hard" },
        { folder: "frontier-child", task: "frontier task", tier: "frontier" },
      ],
    };

    expect(() => assertManifest(manifest)).not.toThrow();
  });

  it("throws on the first violating child (short-circuits at the first bad child)", () => {
    const manifest: FleetManifest = {
      rootDir: ".",
      concurrency: 1,
      children: [
        { folder: "clean-first", task: "clean task" },
        {
          folder: "bad-second",
          task: "bad task",
          config: { generator: { model: "sonnet", provider: "claude-code" } },
        },
      ],
    };

    expect(() => assertManifest(manifest)).toThrow(/bad-second/);
  });
});
