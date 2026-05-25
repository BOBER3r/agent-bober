/**
 * Unit tests for bober_playbook_list and bober_playbook_search tools (Sprint 6).
 */

import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { registerPlaybookTools } from "./playbook.js";
import { getTool } from "./registry.js";

let tmpDir: string;

const SAMPLE_PLAYBOOK = `---
name: database-connection-issues
classification: standard
applicableSymptoms:
  - database connection pool exhausted
  - too many connections error
prerequisites:
  - database admin access
---

## Step 1: Check connection count

Run \`SELECT count(*) FROM pg_stat_activity;\`

## Step 2: Increase connection limit

Update max_connections in postgresql.conf.
`;

const EMERGENCY_PLAYBOOK = `---
name: complete-service-outage
classification: emergency
applicableSymptoms:
  - service down
  - complete outage
  - 503 all endpoints
prerequisites:
  - on-call access
---

## Step 1: Check health endpoint

Run \`curl https://service/health\`
`;

beforeEach(async () => {
  vi.resetModules();
  tmpDir = await mkdtemp(join(tmpdir(), "bober-playbook-tool-test-"));
  registerPlaybookTools();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── bober_playbook_list ──────────────────────────────────────────────────────────

describe("bober_playbook_list", () => {
  it("is registered with the correct name", () => {
    expect(getTool("bober_playbook_list")).toBeDefined();
  });

  it("returns empty array when no playbooks exist", async () => {
    const tool = getTool("bober_playbook_list")!;
    const result = JSON.parse(
      await tool.handler({ projectPath: tmpDir }),
    ) as unknown[];
    expect(result).toEqual([]);
  });

  it("returns playbooks with { name, classification, applicableSymptoms }", async () => {
    const playbooksDir = join(tmpDir, ".bober", "playbooks");
    await mkdir(playbooksDir, { recursive: true });
    await writeFile(join(playbooksDir, "database.md"), SAMPLE_PLAYBOOK, "utf-8");
    await writeFile(join(playbooksDir, "outage.md"), EMERGENCY_PLAYBOOK, "utf-8");

    const tool = getTool("bober_playbook_list")!;
    const result = JSON.parse(
      await tool.handler({ projectPath: tmpDir }),
    ) as Array<{ name: string; classification: string; applicableSymptoms: string[] }>;

    expect(result.length).toBe(2);
    const names = result.map((p) => p.name);
    expect(names).toContain("database-connection-issues");
    expect(names).toContain("complete-service-outage");

    const dbPlaybook = result.find((p) => p.name === "database-connection-issues")!;
    expect(dbPlaybook).toMatchObject({
      name: "database-connection-issues",
      classification: "standard",
    });
    expect(Array.isArray(dbPlaybook.applicableSymptoms)).toBe(true);
    expect(dbPlaybook.applicableSymptoms.length).toBeGreaterThan(0);
  });

  it("returns soft error for relative projectPath", async () => {
    const tool = getTool("bober_playbook_list")!;
    const result = JSON.parse(
      await tool.handler({ projectPath: "./relative" }),
    ) as { error: string };
    expect(result.error).toBe("projectPath must be absolute");
  });
});

// ── bober_playbook_search ────────────────────────────────────────────────────────

describe("bober_playbook_search", () => {
  it("is registered with the correct name", () => {
    expect(getTool("bober_playbook_search")).toBeDefined();
  });

  it("returns empty array when no playbooks match", async () => {
    await mkdir(join(tmpDir, ".bober", "playbooks"), { recursive: true });
    await writeFile(
      join(tmpDir, ".bober", "playbooks", "database.md"),
      SAMPLE_PLAYBOOK,
      "utf-8",
    );

    const tool = getTool("bober_playbook_search")!;
    const result = JSON.parse(
      await tool.handler({ symptom: "completely unrelated topic", projectPath: tmpDir }),
    ) as unknown[];
    expect(Array.isArray(result)).toBe(true);
  });

  it("returns matching playbooks with { name, confidence, tier, matchedTokens }", async () => {
    const playbooksDir = join(tmpDir, ".bober", "playbooks");
    await mkdir(playbooksDir, { recursive: true });
    await writeFile(join(playbooksDir, "database.md"), SAMPLE_PLAYBOOK, "utf-8");
    await writeFile(join(playbooksDir, "outage.md"), EMERGENCY_PLAYBOOK, "utf-8");

    const tool = getTool("bober_playbook_search")!;
    const result = JSON.parse(
      await tool.handler({
        symptom: "database connection pool exhausted",
        projectPath: tmpDir,
      }),
    ) as Array<{
      name: string;
      confidence: number;
      tier: string;
      matchedTokens: string[];
    }>;

    expect(result.length).toBeGreaterThan(0);
    const topMatch = result[0]!;
    expect(topMatch).toMatchObject({ name: "database-connection-issues" });
    expect(topMatch.confidence).toBeGreaterThan(0);
    expect(["high", "suggestion", "low"]).toContain(topMatch.tier);
    expect(Array.isArray(topMatch.matchedTokens)).toBe(true);
  });

  it("returns results sorted descending by confidence", async () => {
    const playbooksDir = join(tmpDir, ".bober", "playbooks");
    await mkdir(playbooksDir, { recursive: true });
    await writeFile(join(playbooksDir, "database.md"), SAMPLE_PLAYBOOK, "utf-8");
    await writeFile(join(playbooksDir, "outage.md"), EMERGENCY_PLAYBOOK, "utf-8");

    const tool = getTool("bober_playbook_search")!;
    const result = JSON.parse(
      await tool.handler({
        symptom: "database connection",
        projectPath: tmpDir,
      }),
    ) as Array<{ confidence: number }>;

    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1]!.confidence).toBeGreaterThanOrEqual(result[i]!.confidence);
    }
  });

  it("returns soft error for empty symptom", async () => {
    const tool = getTool("bober_playbook_search")!;
    const result = JSON.parse(
      await tool.handler({ symptom: "", projectPath: tmpDir }),
    ) as { error: string };
    expect(result.error).toContain("symptom is required");
  });

  it("returns soft error for relative projectPath", async () => {
    const tool = getTool("bober_playbook_search")!;
    const result = JSON.parse(
      await tool.handler({ symptom: "test", projectPath: "./relative" }),
    ) as { error: string };
    expect(result.error).toBe("projectPath must be absolute");
  });
});
