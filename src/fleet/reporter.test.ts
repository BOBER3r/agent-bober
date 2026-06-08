import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PortfolioReporter } from "./reporter.js";
import type { ChildOutcome } from "./types.js";

// ── Helpers ───────────────────────────────────────────────────────────

function makeOutcome(folder: string, status: ChildOutcome["status"]): ChildOutcome {
  return { folder, status, source: "exit-code" };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("PortfolioReporter.build (sc-4-4)", () => {
  const reporter = new PortfolioReporter();

  it("returns zero counts for empty outcomes", () => {
    const report = reporter.build([]);
    expect(report.total).toBe(0);
    expect(report.completed).toBe(0);
    expect(report.failed).toBe(0);
    expect(report.other).toBe(0);
    expect(report.children).toHaveLength(0);
  });

  it("tallies completed/failed/other correctly for mixed list", () => {
    const outcomes: ChildOutcome[] = [
      makeOutcome("a", "completed"),
      makeOutcome("b", "failed"),
      makeOutcome("c", "completed"),
      makeOutcome("d", "other"),
      makeOutcome("e", "failed"),
      makeOutcome("f", "other"),
    ];
    const report = reporter.build(outcomes);
    expect(report.total).toBe(6);
    expect(report.completed).toBe(2);
    expect(report.failed).toBe(2);
    expect(report.other).toBe(2);
    expect(report.children).toEqual(outcomes);
  });

  it("generatedAt is a valid ISO-8601 string", () => {
    const report = reporter.build([]);
    expect(() => new Date(report.generatedAt)).not.toThrow();
    expect(new Date(report.generatedAt).toISOString()).toBe(report.generatedAt);
  });
});

describe("PortfolioReporter.write (sc-4-5)", () => {
  const reporter = new PortfolioReporter();
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-fleet-report-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes fleet-report.json under <rootDir>/.bober", async () => {
    const report = reporter.build([makeOutcome("a", "completed")]);
    const outPath = await reporter.write(tmpDir, report);

    const expected = join(tmpDir, ".bober", "fleet-report.json");
    expect(outPath).toBe(expected);

    const raw = await readFile(expected, "utf-8");
    const parsed = JSON.parse(raw) as { total: number };
    expect(parsed.total).toBe(1);
  });

  it("is atomic — no .tmp files remain after a successful write", async () => {
    const report = reporter.build([makeOutcome("b", "failed")]);
    await reporter.write(tmpDir, report);

    const entries = await readdir(join(tmpDir, ".bober"));
    expect(entries.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });

  it("throws when writing to a path whose parent is a read-only directory", async () => {
    // Create a directory under tmpDir that we make read-only
    const roDir = join(tmpDir, "ro");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(roDir, { recursive: true });
    await chmod(roDir, 0o400);

    const report = reporter.build([]);
    await expect(reporter.write(roDir, report)).rejects.toThrow();

    // Restore permissions for cleanup
    await chmod(roDir, 0o700);
  });

  it("creates .bober directory if it does not exist", async () => {
    const nested = join(tmpDir, "deep", "nested");
    const report = reporter.build([]);
    // nested does not exist; mkdir recursive should create it
    const outPath = await reporter.write(nested, report);
    expect(outPath).toContain(".bober");

    const raw = await readFile(outPath, "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
