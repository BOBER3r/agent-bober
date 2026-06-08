import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { load } from "./manifest.js";

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
