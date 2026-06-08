import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoberConfigSchema } from "../config/schema.js";
import { ChildScaffolder } from "./scaffolder.js";

// ── Helpers ──────────────────────────────────────────────────────────

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-scaffolder-"));
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const child = { folder: "child-a", task: "build the feature" };

// ── Fresh scaffold ───────────────────────────────────────────────────

describe("ChildScaffolder.scaffold() — fresh target", () => {
  it("creates the folder, writes a Zod-valid bober.config.json, runs git init, and returns correct ScaffoldResult (sc-2-4)", async () => {
    const scaffolder = new ChildScaffolder();
    const result = await scaffolder.scaffold(tmpDir, child);

    expect(result.folder).toBe("child-a");
    expect(result.absPath).toContain("child-a");
    expect(result.configWritten).toBe(true);
    expect(result.gitInitialized).toBe(true);
    expect(result.error).toBeUndefined();

    // .git directory must exist
    const gitStat = await stat(join(result.absPath, ".git"));
    expect(gitStat.isDirectory()).toBe(true);

    // bober.config.json must be Zod-valid
    const raw = await readFile(join(result.absPath, "bober.config.json"), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    expect(() => BoberConfigSchema.parse(parsed)).not.toThrow();
  });
});

// ── Non-empty folder safety ──────────────────────────────────────────

describe("ChildScaffolder.scaffold() — non-empty pre-existing folder", () => {
  it("returns error, leaves contents untouched, writes no config (sc-2-5)", async () => {
    const scaffolder = new ChildScaffolder();

    // Pre-create the target folder with a sentinel file
    const targetDir = join(tmpDir, child.folder);
    await rm(targetDir, { recursive: true, force: true });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(targetDir, { recursive: true });
    const sentinelContent = "sentinel-content-must-not-change\n";
    const sentinelPath = join(targetDir, "sentinel.txt");
    await writeFile(sentinelPath, sentinelContent, "utf-8");

    const result = await scaffolder.scaffold(tmpDir, child);

    // Must set error
    expect(result.error).toBe("folder exists and is non-empty");
    expect(result.configWritten).toBe(false);
    expect(result.gitInitialized).toBe(false);

    // Sentinel must be byte-for-byte untouched
    const afterContent = await readFile(sentinelPath, "utf-8");
    expect(afterContent).toBe(sentinelContent);

    // bober.config.json must NOT have been written
    let configStat: Awaited<ReturnType<typeof stat>> | undefined;
    try {
      configStat = await stat(join(targetDir, "bober.config.json"));
    } catch {
      configStat = undefined;
    }
    expect(configStat).toBeUndefined();
  });
});

// ── Error capture — scaffold never throws ───────────────────────────

describe("ChildScaffolder.scaffold() — error capture (sc-2-6)", () => {
  it("captures mkdir failure into error, never throws", async () => {
    const scaffolder = new ChildScaffolder();

    // Point at a path that cannot be created: use a file as the parent
    const blockingFilePath = join(tmpDir, "blocking-file");
    await writeFile(blockingFilePath, "i am a file", "utf-8");

    // Try to scaffold into blockingFilePath/child — mkdir will fail because
    // blockingFilePath is a file, not a directory
    const childWithBadPath = { folder: "blocking-file/nested-child", task: "t" };

    let result: Awaited<ReturnType<ChildScaffolder["scaffold"]>> | undefined;
    let threw = false;
    try {
      result = await scaffolder.scaffold(tmpDir, childWithBadPath);
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result).toBeDefined();
    expect(result!.error).toBeDefined();
    expect(result!.configWritten).toBe(false);
    expect(result!.gitInitialized).toBe(false);
  });
});
