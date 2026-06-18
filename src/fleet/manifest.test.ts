import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FleetChildSchema, FleetManifestSchema, load } from "./manifest.js";
import { resolveBlackboardPath } from "./index.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-fleet-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("load() — valid manifest", () => {
  it("applies defaults and returns typed FleetManifest", async () => {
    const manifest = {
      children: [{ folder: "proj-a", task: "build a todo app" }],
    };
    const manifestPath = join(tmpDir, "fleet.json");
    await writeFile(manifestPath, JSON.stringify(manifest), "utf-8");

    const result = await load(manifestPath);

    expect(result.rootDir).toBe(".");
    expect(result.concurrency).toBe(3);
    expect(result.children).toHaveLength(1);
    expect(result.children[0]).toMatchObject({
      folder: "proj-a",
      task: "build a todo app",
    });
  });

  it("respects explicit rootDir and concurrency", async () => {
    const manifest = {
      rootDir: "/projects",
      concurrency: 5,
      children: [{ folder: "proj-b", task: "build a blog" }],
    };
    const manifestPath = join(tmpDir, "fleet2.json");
    await writeFile(manifestPath, JSON.stringify(manifest), "utf-8");

    const result = await load(manifestPath);

    expect(result.rootDir).toBe("/projects");
    expect(result.concurrency).toBe(5);
  });
});

describe("load() — invalid paths", () => {
  it("throws when file is missing (ENOENT)", async () => {
    const missingPath = join(tmpDir, "nope.json");
    await expect(load(missingPath)).rejects.toThrow(/"[^"]*nope\.json"/);
  });

  it("throws when file is not valid JSON", async () => {
    const badPath = join(tmpDir, "bad.json");
    await writeFile(badPath, "{not json", "utf-8");
    await expect(load(badPath)).rejects.toThrow(/not valid JSON/i);
  });

  it("throws when children array is empty", async () => {
    const manifest = { children: [] };
    const manifestPath = join(tmpDir, "empty-children.json");
    await writeFile(manifestPath, JSON.stringify(manifest), "utf-8");
    await expect(load(manifestPath)).rejects.toThrow();
  });

  it("throws when concurrency is 0", async () => {
    const manifest = {
      concurrency: 0,
      children: [{ folder: "x", task: "t" }],
    };
    const manifestPath = join(tmpDir, "bad-concurrency.json");
    await writeFile(manifestPath, JSON.stringify(manifest), "utf-8");
    await expect(load(manifestPath)).rejects.toThrow();
  });

  it("throws when concurrency is negative", async () => {
    const manifest = {
      concurrency: -1,
      children: [{ folder: "x", task: "t" }],
    };
    const manifestPath = join(tmpDir, "neg-concurrency.json");
    await writeFile(manifestPath, JSON.stringify(manifest), "utf-8");
    await expect(load(manifestPath)).rejects.toThrow();
  });
});

describe("FleetManifestSchema — blackboard block (sc-2-4)", () => {
  it("parses a manifest without blackboard (blackboard is undefined)", () => {
    const r = FleetManifestSchema.parse({ children: [{ folder: "x", task: "t" }] });
    expect(r.blackboard).toBeUndefined();
  });

  it("parses a manifest with blackboard and defaults maxRounds=3 when omitted", () => {
    const r = FleetManifestSchema.parse({
      children: [{ folder: "x", task: "t" }],
      blackboard: { namespace: "run-1" },
    });
    expect(r.blackboard?.namespace).toBe("run-1");
    expect(r.blackboard?.maxRounds).toBe(3);
  });

  it("parses a manifest with explicit maxRounds=2", () => {
    const r = FleetManifestSchema.parse({
      children: [{ folder: "x", task: "t" }],
      blackboard: { namespace: "run-2", maxRounds: 2 },
    });
    expect(r.blackboard?.maxRounds).toBe(2);
  });

  it("throws ZodError when maxRounds > 3", () => {
    expect(() =>
      FleetManifestSchema.parse({
        children: [{ folder: "x", task: "t" }],
        blackboard: { namespace: "r", maxRounds: 4 },
      }),
    ).toThrow();
  });

  it("throws ZodError when namespace is an empty string", () => {
    expect(() =>
      FleetManifestSchema.parse({
        children: [{ folder: "x", task: "t" }],
        blackboard: { namespace: "" },
      }),
    ).toThrow();
  });
});

describe("resolveBlackboardPath (sc-2-5)", () => {
  it("returns an absolute path containing .bober/memory/<namespace>/facts.db when blackboard is set", () => {
    const manifest = FleetManifestSchema.parse({
      rootDir: "/tmp/root",
      children: [{ folder: "a", task: "t" }],
      blackboard: { namespace: "ns", maxRounds: 3 },
    });
    const p = resolveBlackboardPath(manifest);
    expect(p).toBe(join(resolve("/tmp/root"), ".bober", "memory", "ns", "facts.db"));
    expect(p).not.toBeUndefined();
    // Absolute path check
    expect(p?.startsWith("/")).toBe(true);
  });

  it("returns undefined when no blackboard is set", () => {
    const manifest = FleetManifestSchema.parse({
      children: [{ folder: "a", task: "t" }],
    });
    expect(resolveBlackboardPath(manifest)).toBeUndefined();
  });

  it("produces an absolute path even when rootDir is relative '.'", () => {
    const manifest = FleetManifestSchema.parse({
      rootDir: ".",
      children: [{ folder: "a", task: "t" }],
      blackboard: { namespace: "my-ns" },
    });
    const p = resolveBlackboardPath(manifest);
    expect(p).toBeDefined();
    // Must be absolute (resolve('.') = cwd)
    expect(p?.startsWith("/")).toBe(true);
    expect(p).toContain(join(".bober", "memory", "my-ns", "facts.db"));
  });
});

describe("FleetChildSchema — tier field", () => {
  it("parses a child without tier (tier is undefined)", () => {
    const result = FleetChildSchema.parse({ folder: "x", task: "t" });
    expect(result.tier).toBeUndefined();
  });

  it("parses a child with tier='default'", () => {
    const result = FleetChildSchema.parse({ folder: "x", task: "t", tier: "default" });
    expect(result.tier).toBe("default");
  });

  it("parses a child with tier='cheap'", () => {
    const result = FleetChildSchema.parse({ folder: "x", task: "t", tier: "cheap" });
    expect(result.tier).toBe("cheap");
  });

  it("parses a child with tier='standard'", () => {
    const result = FleetChildSchema.parse({ folder: "x", task: "t", tier: "standard" });
    expect(result.tier).toBe("standard");
  });

  it("parses a child with tier='hard'", () => {
    const result = FleetChildSchema.parse({ folder: "x", task: "t", tier: "hard" });
    expect(result.tier).toBe("hard");
  });

  it("parses a child with tier='frontier'", () => {
    const result = FleetChildSchema.parse({ folder: "x", task: "t", tier: "frontier" });
    expect(result.tier).toBe("frontier");
  });

  it("throws ZodError when tier is an invalid value", () => {
    expect(() =>
      FleetChildSchema.parse({ folder: "x", task: "t", tier: "bogus" }),
    ).toThrow();
  });

  it("preserves all other fields when tier is present", () => {
    const result = FleetChildSchema.parse({
      folder: "proj",
      task: "build it",
      tier: "standard",
      config: { commands: { build: "make" } },
    });
    expect(result.folder).toBe("proj");
    expect(result.task).toBe("build it");
    expect(result.tier).toBe("standard");
    expect(result.config).toEqual({ commands: { build: "make" } });
  });
});
