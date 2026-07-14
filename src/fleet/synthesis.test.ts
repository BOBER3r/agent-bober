import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { collect } from "./synthesis.js";
import { SharedBlackboard } from "./shared-blackboard.js";
import type { PortfolioReport } from "./reporter.js";

// ── Fake helpers ──────────────────────────────────────────────────────

function fakeReport(): PortfolioReport {
  return {
    total: 1,
    completed: 1,
    failed: 0,
    other: 0,
    generatedAt: "2026-06-18T00:00:00.000Z",
    children: [{ folder: "child-a", status: "completed", source: "exit-code" }],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("collect — seeded SharedBlackboard (sc-4-3)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-synthesis-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns a SynthesisBundle with findings matching readAll() on a seeded blackboard", async () => {
    const NOW = "2026-06-18T00:00:00.000Z";
    const dbPath = join(tmpDir, "bb.db");
    const bb = await SharedBlackboard.open({ dbPath, namespace: "test-ns", maxRounds: 3 });

    bb.publish({ childFolder: "child-a", round: 1, payload: "analysis complete" }, NOW);
    bb.publish({ childFolder: "child-b", round: 1, payload: "found anomaly" }, NOW);

    const report = fakeReport();
    const allFindings = bb.readAll();

    const bundle = collect(bb, report, 2);
    bb.close();

    expect(bundle.rounds).toBe(2);
    expect(bundle.childResults).toBe(report);
    expect(bundle.findings).toEqual(allFindings);
    expect(bundle.findings.length).toBe(2);
  });

  it("returns findings:[] when blackboard is null (sc-4-3)", () => {
    const report = fakeReport();
    const bundle = collect(null, report, 1);

    expect(bundle.rounds).toBe(1);
    expect(bundle.childResults).toBe(report);
    expect(bundle.findings).toEqual([]);
  });
});

// ── sc-4-5: no provider/network imports in synthesis.ts ─────────────

describe("synthesis.ts — no LLM/network imports (sc-4-5)", () => {
  it("synthesis.ts source contains no provider/network imports", async () => {
    const synthPath = resolve(join(new URL(".", import.meta.url).pathname, "synthesis.ts"));
    const source = await readFile(synthPath, "utf-8");

    const banned = ["@anthropic-ai/sdk", "openai", "node:http", "node:net"];
    // 'fetch' as an import keyword — check it's not imported as a module
    const fetchImport = /import\s+.*fetch.*from/;

    for (const pattern of banned) {
      expect(source).not.toContain(pattern);
    }
    expect(fetchImport.test(source)).toBe(false);
  });
});
