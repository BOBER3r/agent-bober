/**
 * Unit tests for bober_postmortem_get tool (Sprint 6).
 */

import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { registerPostmortemTool } from "./postmortem.js";
import { getTool } from "./registry.js";

let tmpDir: string;

const SAMPLE_POSTMORTEM = `# Postmortem: inc-20260525-errors-spiking

## TL;DR

Service errors spiked due to a database connection pool exhaustion (src/db/pool.ts#L42).

## Impact

- Duration: 15 minutes
- Users affected: ~500

## Timeline

- 10:00 UTC: Error rate exceeded 5% threshold.
- 10:05 UTC: On-call alerted.
- 10:15 UTC: Connection pool limit increased.

## Root Cause

Database connection pool exhausted (config.ts#connPool).

## Action Items

- [ ] Increase connection pool size
- [ ] Add monitoring for pool utilization (monitoring.ts#alerts)
`;

beforeEach(async () => {
  vi.resetModules();
  tmpDir = await mkdtemp(join(tmpdir(), "bober-postmortem-tool-test-"));
  registerPostmortemTool();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("bober_postmortem_get", () => {
  it("is registered with the correct name", () => {
    expect(getTool("bober_postmortem_get")).toBeDefined();
  });

  it("reads postmortem.md and returns { content, sections, citations }", async () => {
    const incidentId = "inc-20260525-test-incident";
    const incidentDir = join(tmpDir, ".bober", "incidents", incidentId);
    await mkdir(incidentDir, { recursive: true });
    await writeFile(join(incidentDir, "postmortem.md"), SAMPLE_POSTMORTEM, "utf-8");

    const tool = getTool("bober_postmortem_get")!;
    const result = JSON.parse(
      await tool.handler({ incidentId, projectPath: tmpDir }),
    ) as {
      content: string;
      sections: Array<{ name: string; content: string }>;
      citations: string[];
    };

    expect(result.content).toBeTruthy();
    expect(result.sections.length).toBeGreaterThan(0);
    // Verify section names are parsed
    const sectionNames = result.sections.map((s) => s.name);
    expect(sectionNames).toContain("TL;DR");
    expect(sectionNames).toContain("Impact");
    expect(sectionNames).toContain("Root Cause");
    // Citations extracted from parenthetical references
    expect(Array.isArray(result.citations)).toBe(true);
  });

  it("extracts citations matching the regex pattern", async () => {
    const incidentId = "inc-cite-test";
    const incidentDir = join(tmpDir, ".bober", "incidents", incidentId);
    await mkdir(incidentDir, { recursive: true });
    await writeFile(join(incidentDir, "postmortem.md"), SAMPLE_POSTMORTEM, "utf-8");

    const tool = getTool("bober_postmortem_get")!;
    const result = JSON.parse(
      await tool.handler({ incidentId, projectPath: tmpDir }),
    ) as { citations: string[] };

    // The sample has (src/db/pool.ts#L42), (config.ts#connPool), (monitoring.ts#alerts)
    expect(result.citations.length).toBeGreaterThan(0);
  });

  it("returns soft error for missing postmortem", async () => {
    const tool = getTool("bober_postmortem_get")!;
    const result = JSON.parse(
      await tool.handler({ incidentId: "inc-no-postmortem", projectPath: tmpDir }),
    ) as { error: string };
    expect(result.error).toContain("No postmortem found");
  });

  it("returns soft error for empty incidentId", async () => {
    const tool = getTool("bober_postmortem_get")!;
    const result = JSON.parse(
      await tool.handler({ incidentId: "", projectPath: tmpDir }),
    ) as { error: string };
    expect(result.error).toContain("incidentId is required");
  });

  it("returns soft error for relative projectPath", async () => {
    const tool = getTool("bober_postmortem_get")!;
    const result = JSON.parse(
      await tool.handler({ incidentId: "any", projectPath: "./relative" }),
    ) as { error: string };
    expect(result.error).toBe("projectPath must be absolute");
  });
});
